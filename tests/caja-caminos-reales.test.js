// Los caminos que va a pisar la dueña esta semana en /caja.
//
// En todos importa lo mismo: que el dinero quede bien guardado, y que si algo falla ella LO
// VEA. Nunca un fallo silencioso, nunca un cobro perdido, nunca un cobro duplicado sin aviso.
process.env.TZ = 'Europe/Madrid';
process.env.DASHBOARD_API_SECRET = 'secreto-de-test';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const assert = require('assert');
const http = require('http');

const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: { notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {} },
};

const { app } = require('../webhook');
const db = require('../services/db');
const { hashPin, issueAttributionToken } = require('../services/pin');
const { normalizeCobroImportes } = require('../services/helpers');

const SANTE = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const IRINA = 'est-irina';
const OLGA = 'est-olga';

db.authenticateToken = async (t) => (t === 'sante' ? { userId: 'u', orgId: SANTE } : null);
db.getAppointmentById = async () => null;
db.getAgentConfig = async () => ({ services: [] });
db.getConfigValue = async () => 30;

// PIN real de Irina: 4821. Olga NO tiene PIN dado de alta.
const PIN_IRINA = hashPin('4821');
db.verifyStylistPin = async (orgId, stylistId, pin) => {
    if (stylistId !== IRINA) return false;   // Olga: sin fila en stylist_pins
    const { verifyPin } = require('../services/pin');
    return verifyPin(pin, PIN_IRINA.hash, PIN_IRINA.salt);
};

let cobros = [];
// El doble VALIDA como el real. `db.createCobro` llama a normalizeCobroImportes antes de
// escribir, y un doble que se lo saltara haría pasar tests que en producción dan 400 —
// exactamente la trampa de los dobles que no respetan el contrato del original (auditoría
// del 30/07: un doble que no devolvía filas afectadas escondía escrituras que no ocurrían).
db.createCobro = async (orgId, o) => {
    const importes = normalizeCobroImportes({
        metodo: o.metodo, importeTotal: o.importeTotal, importeEfectivo: o.importeEfectivo,
    });
    const c = {
        id: `c${cobros.length + 1}`, ...o,
        importe_total: importes.importe_total,
        importe_efectivo: importes.importe_efectivo,
        atribucion: o.atribucion, estado: 'vigente',
    };
    cobros.push(c);
    return c;
};
db.getCobroById = async (orgId, id) => cobros.find(c => c.id === id) || null;
db.anularCobro = async (orgId, id) => {
    const c = cobros.find(x => x.id === id && x.estado === 'vigente');
    // Igual que el UPDATE real, que lleva `.eq('estado','vigente')`: anular dos veces no
    // reescribe nada y devuelve null → 404. Que es la verdad: no hay nada que anular.
    if (!c) return null;
    c.estado = 'anulado';
    return c;
};

function pedir(server, { metodo = 'POST', path, body, cajaToken }) {
    const { port } = server.address();
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, method: metodo, path,
            headers: {
                Authorization: 'Bearer sante',
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...(cajaToken ? { 'X-Caja-Token': cajaToken } : {}),
            },
        }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

let fallos = 0;
async function test(name, fn) {
    cobros = [];
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e.message); fallos++; process.exitCode = 1; }
}

const COBRO = { cobradoPor: IRINA, metodo: 'efectivo', importeTotal: 50, concepto: 'x' };

(async () => {
const server = http.createServer(app).listen(0);
await new Promise(r => server.once('listening', r));

// ── 1. Sin PIN puesto ───────────────────────────────────────────────────────
await test('1 · una estilista SIN PIN dado de alta no puede abrir sesión…', async () => {
    const r = await pedir(server, { path: '/api/caja/sesion', body: { stylistId: OLGA, pin: '1234' } });
    assert.strictEqual(r.status, 401);
});

await test('2 · …pero cobra igual, y queda declarada — el cobro NUNCA se bloquea', async () => {
    const r = await pedir(server, { path: '/api/cobros', body: { ...COBRO, cobradoPor: OLGA } });
    assert.strictEqual(r.status, 201, 'sin PIN se cobra: si no, ese dinero no se apunta');
    assert.strictEqual(cobros[0].atribucion, 'declarada');
});

// ── 2. PIN equivocado y PIN de otra ─────────────────────────────────────────
await test('3 · PIN equivocado: 401 y ni un cobro escrito', async () => {
    const r = await pedir(server, { path: '/api/caja/sesion', body: { stylistId: IRINA, pin: '0000' } });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(cobros.length, 0);
});

await test('4 · el PIN de Irina NO abre la sesión de Olga', async () => {
    const r = await pedir(server, { path: '/api/caja/sesion', body: { stylistId: OLGA, pin: '4821' } });
    assert.strictEqual(r.status, 401, 'el PIN se verifica contra la estilista ELEGIDA');
});

await test('5 · con el PIN bueno sí abre, y el token no lleva el PIN dentro', async () => {
    const r = await pedir(server, { path: '/api/caja/sesion', body: { stylistId: IRINA, pin: '4821' } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.token);
    assert.ok(!Buffer.from(r.body.token.split('.')[0], 'base64url').toString().includes('4821'));
});

// ── 3. Token caducado a mitad de jornada ────────────────────────────────────
await test('6 · token caducado: sigue cobrando, baja a declarada', async () => {
    const viejo = issueAttributionToken({ orgId: SANTE, stylistId: IRINA, minutos: 30, ahora: Date.now() - 3600_000 });
    const r = await pedir(server, { path: '/api/cobros', body: COBRO, cajaToken: viejo });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(cobros[0].atribucion, 'declarada');
    assert.ok(!r.body.cajaToken, 'no se renueva un token muerto');
});

// ── 4. Deshacer: dos veces, o pasados los 8 s ───────────────────────────────
await test('7 · deshacer funciona, y deshacer DOS veces da 404 en vez de fingir', async () => {
    const c = await pedir(server, { path: '/api/cobros', body: COBRO });
    const id = c.body.id;
    const a1 = await pedir(server, { path: `/api/cobros/${id}/anular`, body: { motivo: 'deshecho al registrarlo' } });
    assert.strictEqual(a1.status, 200);
    const a2 = await pedir(server, { path: `/api/cobros/${id}/anular`, body: { motivo: 'otra vez' } });
    assert.strictEqual(a2.status, 404, 'nunca un 200 sobre una escritura que no ocurrió');
});

await test('8 · pasados los 8 s el aviso desaparece, pero anular sigue disponible por su ruta', async () => {
    // No hay ventana en el servidor: el "deshacer" es solo el atajo del aviso. Si se pierde,
    // el mismo cobro se anula desde la lista del día con motivo.
    const c = await pedir(server, { path: '/api/cobros', body: COBRO });
    const r = await pedir(server, { path: `/api/cobros/${c.body.id}/anular`, body: { motivo: 'me equivoqué' } });
    assert.strictEqual(r.status, 200, 'anular no caduca: no hay ventana de tiempo');
});

// ── 5. Mixto imposible ──────────────────────────────────────────────────────
await test('9 · un mixto con efectivo = total se rechaza con un mensaje que se entiende', async () => {
    const r = await pedir(server, { path: '/api/cobros', body: { ...COBRO, metodo: 'mixto', importeTotal: 50, importeEfectivo: 50 } });
    assert.strictEqual(r.status, 400, '400 y no 500: es un dato mal puesto, no una avería');
    assert.match(r.body.error, /entre 0 y el total/);
    assert.ok(!/CHECK|constraint|violates/i.test(r.body.error), 'sin jerga de base de datos');
    assert.strictEqual(cobros.length, 0);
});

await test('10 · y con efectivo 0, igual', async () => {
    const r = await pedir(server, { path: '/api/cobros', body: { ...COBRO, metodo: 'mixto', importeTotal: 50, importeEfectivo: 0 } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(cobros.length, 0);
});

// ── 6. Importes raros pero legítimos ────────────────────────────────────────
await test('11 · un cobro de 0 € (cortesía) ENTRA: 0 no es "sin importe"', async () => {
    const r = await pedir(server, { path: '/api/cobros', body: { ...COBRO, importeTotal: 0 } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(cobros[0].importe_total, 0);
});

await test('12 · decimales: 12,50 se guarda como 12.50 y no se pierde el céntimo', () => {
    assert.deepStrictEqual(normalizeCobroImportes({ metodo: 'efectivo', importeTotal: 12.5 }),
        { importe_total: 12.5, importe_efectivo: 12.5 });
    assert.deepStrictEqual(normalizeCobroImportes({ metodo: 'mixto', importeTotal: 45.75, importeEfectivo: 20.25 }),
        { importe_total: 45.75, importe_efectivo: 20.25 });
    // Redondeo a 2 decimales: un 33.333 no puede entrar como está en una columna de dinero.
    assert.strictEqual(normalizeCobroImportes({ metodo: 'efectivo', importeTotal: 33.333 }).importe_total, 33.33);
});

await test('13 · un importe negativo o no numérico se rechaza en voz alta', async () => {
    for (const malo of [-5, 'abc', null]) {
        const r = await pedir(server, { path: '/api/cobros', body: { ...COBRO, importeTotal: malo } });
        assert.strictEqual(r.status, 400, `${JSON.stringify(malo)} debe dar 400`);
    }
    assert.strictEqual(cobros.length, 0);
});

// ── 7. Dos dispositivos a la vez ────────────────────────────────────────────
await test('14 · dos dispositivos cobrando la misma cita: entran los DOS, y se ven', async () => {
    // Decisión consciente: una cita PUEDE cobrarse en dos veces (parte hoy, parte al recoger),
    // así que un UNIQUE obligaría a mentir. El sistema no lo impide — lo hace visible: los dos
    // cobros salen en la lista del día y en el resumen, y la hoja avisa si ya había uno.
    const a = await pedir(server, { path: '/api/cobros', body: { ...COBRO, appointmentId: 'apt-1' } });
    const b = await pedir(server, { path: '/api/cobros', body: { ...COBRO, appointmentId: 'apt-1' } });
    assert.strictEqual(a.status, 201);
    assert.strictEqual(b.status, 201);
    assert.strictEqual(cobros.length, 2, 'no se pierde ninguno: perder dinero es peor que duplicarlo a la vista');
});

// ── 8. Rectificar sobre algo que ya no está ─────────────────────────────────
await test('15 · rectificar un cobro inexistente da 404, no un cobro huérfano', async () => {
    const r = await pedir(server, { path: '/api/cobros/no-existe/rectificar', body: { importeTotal: 10, motivoCorreccion: 'x' } });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(cobros.length, 0);
});

await test('16 · rectificar sin motivo se rechaza y no escribe nada', async () => {
    const c = await pedir(server, { path: '/api/cobros', body: COBRO });
    const antes = cobros.length;
    const r = await pedir(server, { path: `/api/cobros/${c.body.id}/rectificar`, body: { importeTotal: 60 } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(cobros.length, antes, 'sin motivo no se escribe');
});

server.close();
console.log(fallos === 0 ? '\n✅ Caminos reales de caja OK' : `\n❌ ${fallos} fallo(s)`);
})();
