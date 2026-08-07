// POST /api/cobros — cómo se decide la atribución en la ruta real.
//
// Lo que se afirma: el cobro se registra SIEMPRE (sin token, con token caducado, con token de
// otra estilista), pero solo se marca 'confirmada' cuando el token es de esa misma estilista.
//
// Y el caso del token de OTRA estilista no se traga en silencio: significa que alguien cambió
// el nombre en pantalla sin meter el PIN, que es exactamente lo que la columna existe para
// poder distinguir, así que tiene que quedar en el log.
process.env.TZ = 'Europe/Madrid';
process.env.DASHBOARD_API_SECRET = 'secreto-de-test';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const assert = require('assert');
const http = require('http');

// Telegram fuera antes de requerir webhook (ni bot ni red).
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: { notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {} },
};

// Logger capturado para poder afirmar que el desajuste QUEDA REGISTRADO.
const loggerPath = require.resolve('../lib/logger');
const logs = [];
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: {
        info: (evento, campos = {}) => logs.push({ nivel: 'info', evento, ...campos }),
        warn: (evento, campos = {}) => logs.push({ nivel: 'warn', evento, ...campos }),
        error: (evento, campos = {}) => logs.push({ nivel: 'error', evento, ...campos }),
        debug: () => {},
    },
};

const { app } = require('../webhook');
const db = require('../services/db');
const { issueAttributionToken } = require('../services/pin');

const SANTE = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const IRINA = 'c3d4e5f6-a7b8-9012-cdef-234567890102';
const OLGA  = 'c3d4e5f6-a7b8-9012-cdef-234567890104';

db.authenticateToken = async (t) => (t === 'sante' ? { userId: 'user-yulia', orgId: SANTE } : null);
db.getAppointmentById = async () => null;
db.getAgentConfig = async () => ({ services: [] });

let ultimoCobro = null;
db.createCobro = async (orgId, opts) => {
    ultimoCobro = { orgId, ...opts };
    return {
        id: 'cobro-x', metodo: opts.metodo, importe_total: opts.importeTotal,
        importe_efectivo: opts.importeEfectivo ?? opts.importeTotal,
        fecha_caja: '2026-08-07', atribucion: opts.atribucion,
    };
};

function post(server, { path, body, cajaToken }) {
    const { port } = server.address();
    const payload = JSON.stringify(body ?? {});
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, method: 'POST', path,
            headers: {
                Authorization: 'Bearer sante',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                ...(cajaToken ? { 'X-Caja-Token': cajaToken } : {}),
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

const COBRO = { cobradoPor: IRINA, metodo: 'efectivo', importeTotal: 50, concepto: 'producto' };
const tieneLog = (evento) => logs.some(l => l.evento === evento);

let fallos = 0;
async function test(name, fn) {
    logs.length = 0; ultimoCobro = null;
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e.message); fallos++; process.exitCode = 1; }
}

(async () => {
const server = http.createServer(app).listen(0);
await new Promise(r => server.once('listening', r));

await test('1 · sin token: el cobro se registra igual, como declarada', async () => {
    const r = await post(server, { path: '/api/cobros', body: COBRO });
    assert.strictEqual(r.status, 201, 'el cobro NUNCA se bloquea por no tener PIN');
    assert.strictEqual(ultimoCobro.atribucion, 'declarada');
    assert.ok(!r.body.cajaToken, 'sin sesión no se devuelve token');
});

await test('2 · token de esa misma estilista: confirmada, y devuelve token renovado', async () => {
    const token = issueAttributionToken({ orgId: SANTE, stylistId: IRINA, minutos: 30 });
    const r = await post(server, { path: '/api/cobros', body: COBRO, cajaToken: token });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(ultimoCobro.atribucion, 'confirmada');
    assert.ok(r.body.cajaToken, 'se renueva en cada cobro: la caducidad cuenta desde el último');
});

await test('3 · token de OTRA estilista: declarada, y QUEDA EN EL LOG', async () => {
    // Alguien cambió el nombre en pantalla sin meter el PIN de la nueva.
    const token = issueAttributionToken({ orgId: SANTE, stylistId: OLGA, minutos: 30 });
    const r = await post(server, { path: '/api/cobros', body: COBRO, cajaToken: token });
    assert.strictEqual(r.status, 201, 'el cobro se registra igual');
    assert.strictEqual(ultimoCobro.atribucion, 'declarada');
    assert.ok(tieneLog('caja_atribucion_desajustada'), 'este caso NO puede pasar en silencio');
    const l = logs.find(x => x.evento === 'caja_atribucion_desajustada');
    assert.strictEqual(l.tokenStylistId, OLGA);
    assert.strictEqual(l.cobradoPor, IRINA);
    assert.ok(!r.body.cajaToken, 'no se renueva un token que no corresponde');
});

await test('4 · token caducado: declarada, y sin ruido de desajuste', async () => {
    const token = issueAttributionToken({
        orgId: SANTE, stylistId: IRINA, minutos: 30, ahora: Date.now() - 60 * 60_000,
    });
    const r = await post(server, { path: '/api/cobros', body: COBRO, cajaToken: token });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(ultimoCobro.atribucion, 'declarada');
    assert.ok(!tieneLog('caja_atribucion_desajustada'),
        'caducar es normal, no es que alguien cambiara de nombre: mezclarlos haría inútil el aviso');
});

await test('5 · token de otra organización: declarada', async () => {
    const token = issueAttributionToken({ orgId: 'otra-org', stylistId: IRINA, minutos: 30 });
    const r = await post(server, { path: '/api/cobros', body: COBRO, cajaToken: token });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(ultimoCobro.atribucion, 'declarada');
});

await test('6 · la atribución llega SIEMPRE al log del cobro', async () => {
    await post(server, { path: '/api/cobros', body: COBRO });
    const l = logs.find(x => x.evento === 'cobro_registrado');
    assert.ok(l, 'se registra el cobro en el log');
    assert.strictEqual(l.atribucion, 'declarada');
});

// ── Quién cobra se ELIGE por cobro (07/08/2026) ─────────────────────────────
//
// El defecto sale de la CITA (appointments.stylist_id), no de la sesión de PIN: que una
// atienda y cobre otra es lo normal en un mostrador compartido. El servidor no cambia — ya
// comparaba el token contra `cobradoPor`— pero eso ahora es el camino corriente, no el raro.

await test('7 · elegir a la MISMA del PIN puesto → confirmada', async () => {
    const token = issueAttributionToken({ orgId: SANTE, stylistId: IRINA, minutos: 30 });
    const r = await post(server, { path: '/api/cobros', body: { ...COBRO, cobradoPor: IRINA }, cajaToken: token });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(ultimoCobro.atribucion, 'confirmada');
    assert.strictEqual(ultimoCobro.cobradoPor, IRINA);
});

await test('8 · elegir a OTRA (atendió ella, cobra la del PIN) → entra igual, sin PIN', async () => {
    // Irina tiene el PIN puesto y cobra una cita de Olga: se atribuye a OLGA, que es de quien
    // es el servicio, y el cobro queda sin PIN porque nadie confirmó que sea ella.
    const token = issueAttributionToken({ orgId: SANTE, stylistId: IRINA, minutos: 30 });
    const r = await post(server, { path: '/api/cobros', body: { ...COBRO, cobradoPor: OLGA }, cajaToken: token });
    assert.strictEqual(r.status, 201, 'elegir a otra NO bloquea el cobro');
    assert.strictEqual(ultimoCobro.atribucion, 'declarada');
    assert.strictEqual(ultimoCobro.cobradoPor, OLGA, 'se guarda a quien se eligió, no la del PIN');
    assert.ok(tieneLog('caja_atribucion_desajustada'), 'queda registrado por qué salió sin PIN');
});

await test('9 · sin ninguna sesión de PIN se cobra igual, con la estilista elegida', async () => {
    const r = await post(server, { path: '/api/cobros', body: { ...COBRO, cobradoPor: OLGA } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(ultimoCobro.cobradoPor, OLGA);
    assert.strictEqual(ultimoCobro.atribucion, 'declarada');
});

server.close();
console.log(fallos === 0 ? '\n✅ Atribución en el endpoint OK' : `\n❌ ${fallos} fallo(s)`);
})();
