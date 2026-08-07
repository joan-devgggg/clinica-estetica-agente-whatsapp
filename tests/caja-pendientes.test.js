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

// El doble reproduce el filtro de la consulta real para que un doble que devolviera TODO no
// hiciera pasar este test con el filtro roto.
//
// Pero ojo con lo que este fichero puede y no puede afirmar, que costó un fallo en producción:
// como el doble REIMPLEMENTA el filtro en JavaScript en vez de ejercitarlo, aquí se afirma que
// el ENDPOINT respeta lo que le da la capa de datos — nunca que la consulta pida el filtro. El
// 07/08/2026 los tres filtros se añadieron a `getAppointmentsByDateRange` (Reservas) creyendo
// que eran los de Caja; `getCitasDelDiaParaCaja` se quedó sin ellos y este fichero siguió
// verde, con los no-show y las citas «no se cobra» saliendo en pendientes.
//
// Quien afirma la CONSULTA es `tests/db-contracts.test.js` ("caja · getCitasDelDiaParaCaja
// filtra estado, no_show y no_facturable EN LA CONSULTA"), con un cliente Supabase falso que
// registra los filtros tal cual. Los dos hacen falta; ninguno sustituye al otro.
const TODAS = ([
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
        // NO-SHOW por estado. Nadie pagó: no puede quedarse en «pendientes de cobrar».
        id: 'apt-noshow', service: 'Corte hombre', starts_at: '2026-08-07T16:00:00Z', status: 'no_show',
        stylist_id: 'est-olga', contacts: { full_name: 'Faltó' }, stylists: { id: 'est-olga', name: 'Olga' },
    },
    {
        // NO-SHOW por el BOOLEANO, con el estado aún en confirmed. updateAppointment escribe
        // las dos formas, y mirar solo una dejaba a esta clienta en la lista para siempre.
        id: 'apt-noshow-bool', service: 'Corte hombre', starts_at: '2026-08-07T17:00:00Z',
        status: 'confirmed', no_show: true,
        stylist_id: 'est-olga', contacts: { full_name: 'Faltó también' }, stylists: { id: 'est-olga', name: 'Olga' },
    },
    {
        // Cancelada: tampoco.
        id: 'apt-cancelada', service: 'Corte hombre', starts_at: '2026-08-07T18:00:00Z', status: 'cancelled',
        stylist_id: 'est-olga', contacts: { full_name: 'Anuló' }, stylists: { id: 'est-olga', name: 'Olga' },
    },
    {
        // `pending` (flujo Bizum de San Remo). La lista blanca lo deja fuera solo.
        id: 'apt-pending', service: 'Corte hombre', starts_at: '2026-08-07T19:00:00Z', status: 'pending',
        stylist_id: 'est-olga', contacts: { full_name: 'A medias' }, stylists: { id: 'est-olga', name: 'Olga' },
    },
    {
        // Marcada a mano como que NO se cobra: un bloqueo, una cortesía. Fuera de Caja.
        id: 'apt-nofact', service: 'Hueco reservado', starts_at: '2026-08-07T21:00:00Z',
        status: 'confirmed', no_facturable: true,
        stylist_id: 'est-olga', contacts: { full_name: 'Bloqueo' }, stylists: { id: 'est-olga', name: 'Olga' },
    },
    {
        // no_show NULL = "no consta que faltara". Tiene que SEGUIR saliendo.
        id: 'apt-null', service: 'Corte hombre', starts_at: '2026-08-07T20:00:00Z', status: 'confirmed',
        no_show: null,
        stylist_id: 'est-olga', contacts: { full_name: 'Normal' }, stylists: { id: 'est-olga', name: 'Olga' },
    },
    {
        // Ya cobrada: el snapshot manda sobre el recálculo del catálogo.
        id: 'apt-3', service: 'Corte hombre', starts_at: '2026-08-07T14:00:00Z', status: 'completed',
        stylist_id: null, precio_facturado: 22, facturado_at: 'x', servicio_facturado: 'Corte hombre',
        contacts: { full_name: 'Marta L.' }, stylists: null,
    },
]);
db.getCitasDelDiaParaCaja = async () => TODAS.filter(
    (a) => ['confirmed', 'completed'].includes(a.status) && a.no_show !== true
        && a.no_facturable !== true,
);
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

await test('7 · una clienta que NO VINO no se queda en pendientes de cobrar', async () => {
    const r = await get(server, '/api/caja/pendientes?fecha=2026-08-07');
    const ids = r.body.citas.map(c => c.appointment_id);
    assert.ok(!ids.includes('apt-noshow'), 'no-show por estado: nadie pagó, no hay nada que cobrar');
    assert.ok(!ids.includes('apt-noshow-bool'),
        'no-show por el BOOLEANO con el estado en confirmed: mirar solo el estado la dejaba ahí para siempre');
});

await test('8 · canceladas y `pending` tampoco: la lista es BLANCA, no negra', async () => {
    const r = await get(server, '/api/caja/pendientes?fecha=2026-08-07');
    const ids = r.body.citas.map(c => c.appointment_id);
    assert.ok(!ids.includes('apt-cancelada'));
    assert.ok(!ids.includes('apt-pending'), 'un estado no previsto no entra solo');
});

await test('9 · CONTROL · no_show NULL sigue saliendo: "no consta" no es "faltó"', async () => {
    const r = await get(server, '/api/caja/pendientes?fecha=2026-08-07');
    const ids = r.body.citas.map(c => c.appointment_id);
    assert.ok(ids.includes('apt-null'), 'con eq(false) esta desaparecería sin que nadie lo entienda');
    assert.ok(ids.includes('apt-1'), 'y las normales siguen ahí');
});

await test('10 · una cita marcada "no se cobra" no sale en pendientes', async () => {
    const r = await get(server, '/api/caja/pendientes?fecha=2026-08-07');
    const ids = r.body.citas.map(c => c.appointment_id);
    assert.ok(!ids.includes('apt-nofact'),
        'es lo ÚNICO que distingue "esto no se cobra": no se puede deducir de ninguna otra señal');
});

server.close();
console.log(fallos === 0 ? '\n✅ Pendientes de caja OK' : `\n❌ ${fallos} fallo(s)`);
})();
