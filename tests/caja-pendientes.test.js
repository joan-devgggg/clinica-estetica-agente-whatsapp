// GET /api/caja/pendientes — lo que puede cobrarse hoy.
//
// Es la lista de la que sale el cobro de un toque, así que lo que se afirma es que el importe
// que la pantalla va a poner NO lo decide la pantalla:
//   · sale de resolveImporteReferencia, la misma precedencia que pinta Facturación;
//   · una cita sin servicio resoluble llega con null, NO con 0 — un 0 la metería en el
//     descuadre como si se hubiera cobrado de menos, y además permitiría cobrarla de un toque
//     por un importe inventado;
//   · quién ATENDIÓ viaja aparte, porque no es quién cobra y la fila tiene que decir las dos.
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
db.getAgentConfig = async () => ({ services: [{ nombre: 'Corte hombre', precio: 25 }] });

db.getCitasDelDiaParaCaja = async () => ([
    {
        id: 'apt-1', service: 'Corte hombre', starts_at: '2026-08-07T10:00:00Z', status: 'completed',
        stylist_id: 'est-olga', contacts: { full_name: 'Ana G.' }, stylists: { id: 'est-olga', name: 'Olga' },
    },
    {
        // El caso de las "Cita manual" reales de Sante: no resuelve contra el catálogo.
        id: 'apt-2', service: 'Cita manual', starts_at: '2026-08-07T12:00:00Z', status: 'confirmed',
        stylist_id: 'est-olga', contacts: { full_name: 'Close TIME' }, stylists: { id: 'est-olga', name: 'Olga' },
    },
    {
        // Ya cobrada: el snapshot manda sobre el recálculo del catálogo.
        id: 'apt-3', service: 'Corte hombre', starts_at: '2026-08-07T14:00:00Z', status: 'completed',
        stylist_id: null, precio_facturado: 22, facturado_at: 'x', servicio_facturado: 'Corte hombre',
        contacts: { full_name: 'Marta L.' }, stylists: null,
    },
]);
db.getCobrosVigentes = async () => ([
    { id: 'cobro-1', appointment_id: 'apt-3', importe_total: '22.00', metodo: 'tarjeta', atribucion: 'declarada' },
]);

function get(server, path, token = 'sante') {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        http.get({
            host: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${token}` },
        }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
        }).on('error', reject);
    });
}

let fallos = 0;
async function test(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e.message); fallos++; process.exitCode = 1; }
}

(async () => {
const server = http.createServer(app).listen(0);
await new Promise(r => server.once('listening', r));

await test('1 · el importe de referencia sale del servidor, no del panel', async () => {
    const r = await get(server, '/api/caja/pendientes?fecha=2026-08-07');
    assert.strictEqual(r.status, 200);
    const a1 = r.body.citas.find(c => c.appointment_id === 'apt-1');
    assert.strictEqual(a1.importe_referencia, 25, 'recalculado del catálogo');
    const a3 = r.body.citas.find(c => c.appointment_id === 'apt-3');
    assert.strictEqual(a3.importe_referencia, 22, 'el congelado manda sobre el catálogo');
});

await test('2 · una cita sin servicio resoluble llega con null, NUNCA con 0', async () => {
    const r = await get(server, '/api/caja/pendientes?fecha=2026-08-07');
    const a2 = r.body.citas.find(c => c.appointment_id === 'apt-2');
    assert.strictEqual(a2.importe_referencia, null,
        'un 0 permitiría cobrarla de un toque por un importe inventado');
});

await test('3 · quién ATENDIÓ viaja aparte de quién cobra', async () => {
    const r = await get(server, '/api/caja/pendientes?fecha=2026-08-07');
    const a1 = r.body.citas.find(c => c.appointment_id === 'apt-1');
    assert.strictEqual(a1.atendio, 'Olga');
    assert.strictEqual(a1.atendio_id, 'est-olga');
    // El endpoint NO dice quién cobra: eso lo pone la sesión de caja del dispositivo.
    assert.ok(!('cobrado_por' in a1));
});

await test('4 · una cita ya cobrada llega con su cobro, para no cobrarla dos veces', async () => {
    const r = await get(server, '/api/caja/pendientes?fecha=2026-08-07');
    const a3 = r.body.citas.find(c => c.appointment_id === 'apt-3');
    assert.ok(a3.cobro, 'trae el cobro vigente');
    assert.strictEqual(a3.cobro.metodo, 'tarjeta');
    assert.strictEqual(a3.cobro.atribucion, 'declarada');
    const a1 = r.body.citas.find(c => c.appointment_id === 'apt-1');
    assert.strictEqual(a1.cobro, null, 'las no cobradas llegan con cobro null');
});

await test('5 · fecha inválida se rechaza en voz alta', async () => {
    const r = await get(server, '/api/caja/pendientes?fecha=ayer');
    assert.strictEqual(r.status, 400);
});

await test('6 · San Remo no tiene caja', async () => {
    const r = await get(server, '/api/caja/pendientes?fecha=2026-08-07', 'sanremo');
    assert.strictEqual(r.status, 403, 'regla de oro: San Remo no se toca');
});

server.close();
console.log(fallos === 0 ? '\n✅ Pendientes de caja OK' : `\n❌ ${fallos} fallo(s)`);
})();
