// POST /api/appointments — una cita creada a mano DICE qué servicio es, o dice que no se cobra.
//
// El literal 'Cita manual' que rellenaba el panel cuando se dejaba el servicio en blanco dejaba
// citas sin importe de referencia rondando por «pendientes de cobrar» para siempre. Hoy hay
// tres así en la agenda de Sante, y ni siquiera son citas: son bloqueos con clienta inventada.
//
// Exigir servicio A SECAS obligaría a inventárselo el día que haya algo fuera de catálogo, así
// que la casilla es el escape EXPLÍCITO. Lo que no se cobra se dice, no se disfraza.
process.env.TZ = 'Europe/Madrid';
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

const SANTE = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const SANREMO = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

db.authenticateToken = async (t) => {
    if (t === 'sante') return { userId: 'u', orgId: SANTE };
    if (t === 'sanremo') return { userId: 'u2', orgId: SANREMO };
    return null;
};

db.updateLeadById = async () => ({});
db.findById = async () => ({ id: 'c1', nombre: 'Ana' });

let guardada = null;
db.saveAppointment = async (orgId, contactId, opts) => {
    guardada = { orgId, contactId, ...opts };
    return { id: 'apt-nueva', ...opts };
};

function post(server, body, token = 'sante') {
    const { port } = server.address();
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, method: 'POST', path: '/api/appointments',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
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

const BASE = { contactId: 'c1', fecha: '2026-08-20', hora: '10:00', duracionMin: 60 };

let fallos = 0;
async function test(name, fn) {
    guardada = null;
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e.message); fallos++; process.exitCode = 1; }
}

(async () => {
const server = http.createServer(app).listen(0);
await new Promise(r => server.once('listening', r));

await test('1 · sin servicio y sin casilla se RECHAZA, y no se escribe nada', async () => {
    const r = await post(server, { ...BASE });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /qué servicio/i);
    assert.ok(!/Cita manual/.test(JSON.stringify(r.body)), 'y no se inventa un servicio');
    assert.strictEqual(guardada, null, 'ni una cita escrita');
});

await test('2 · un servicio en blanco cuenta como sin servicio', async () => {
    for (const s of ['', '   ', null, undefined]) {
        const r = await post(server, { ...BASE, servicio: s });
        assert.strictEqual(r.status, 400, `servicio ${JSON.stringify(s)} debe rechazarse`);
    }
    assert.strictEqual(guardada, null);
});

await test('3 · con servicio entra, y NO se marca como no cobrable', async () => {
    const r = await post(server, { ...BASE, servicio: 'Corte mujer' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(guardada.servicio, 'Corte mujer');
    assert.strictEqual(guardada.noFacturable, false, 'el defecto va hacia el lado cobrable');
});

await test('4 · con la casilla puesta entra SIN servicio de catálogo', async () => {
    const r = await post(server, { ...BASE, servicio: 'Hueco reservado', noFacturable: true });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(guardada.noFacturable, true);
});

await test('5 · la casilla es el ÚNICO escape: no se cuela por otro sitio', async () => {
    // Sin servicio y sin casilla, ninguna otra combinación abre la puerta.
    for (const extra of [{ notas: 'lo que sea' }, { personas: 2 }, { stylistId: 'est-1' }]) {
        const r = await post(server, { ...BASE, ...extra });
        assert.strictEqual(r.status, 400, `${JSON.stringify(extra)} no debería colar`);
    }
});

await test('6 · San Remo NO cambia: su alta manual sigue sin exigir servicio', async () => {
    // Regla de oro. El restaurante no tiene catálogo de servicios ni caja.
    const r = await post(server, { ...BASE }, 'sanremo');
    assert.strictEqual(r.status, 201, 'San Remo no se toca');
});

server.close();
console.log(fallos === 0 ? '\n✅ Cita manual exige servicio OK' : `\n❌ ${fallos} fallo(s)`);
})();
