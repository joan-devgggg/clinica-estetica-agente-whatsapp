// Los endpoints del acuse de revisión (039). Fase 2·C.
//
// Lo que se afirma aquí es lo que no se ve en la pantalla:
//   · lo ESPERADO no se acepta del cliente — se lee en el servidor y se congela. Si viniera del
//     body, el acuse afirmaría lo que la pantalla creía en vez de lo que hay;
//   · un día del FUTURO no se puede haber revisado;
//   · volver a revisar sin decir por qué se rechaza;
//   · el índice único es un 409 (alguien lo revisó mientras la pantalla estaba abierta), no un
//     500 — es una carrera normal, no una avería.
process.env.TZ = 'Europe/Madrid';
process.env.DASHBOARD_API_SECRET = 'secreto-de-test';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const assert = require('assert');
const http = require('http');
const { toLocalDateStr } = require('../services/date-utils');

const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: { notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {} },
};

const { app } = require('../webhook');
const db = require('../services/db');

const SANTE = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
db.authenticateToken = async (t) => (t === 'sante' ? { userId: 'u-compartido', orgId: SANTE } : null);

// Los cobros del día, que son de donde sale lo esperado.
let cobrosDelDia = [
    { id: 'c1', importe_total: '100.00', importe_efectivo: '100.00', cobrado_por: null, atribucion: 'declarada' },
    { id: 'c2', importe_total: '50.00', importe_efectivo: '0.00', cobrado_por: null, atribucion: 'declarada' },
];
db.getCobrosVigentes = async () => cobrosDelDia;
db.getCierreDelDia = async () => null;
db.getDiasSinRevisar = async () => ([{ fecha: '2026-08-06', numCobros: 2, total: 150 }]);

let insertado = null;
let reventar = null;
// El doble llama al MISMO cálculo que el real y lee los cobros como el real. Uno que aceptara
// los importes del body haría pasar el test 2 con la guarda rota.
const { createCierre: createCierreReal } = require('../services/db');
db.createCierre = async (orgId, opciones) => {
    if (reventar) throw new Error(reventar);
    const { buildCajaResumen, calcularDiferenciasCierre } = require('../services/helpers');
    const { totales } = buildCajaResumen(await db.getCobrosVigentes());
    const dif = calcularDiferenciasCierre({
        esperadoEfectivo: totales.efectivo, esperadoTarjeta: totales.tarjeta,
        contadoEfectivo: opciones.contadoEfectivo, tpvDeclarado: opciones.tpvDeclarado,
    });
    insertado = {
        id: 'cierre-1', fecha_caja: opciones.fecha,
        esperado_efectivo: totales.efectivo, esperado_tarjeta: totales.tarjeta,
        esperado_total: totales.total, num_cobros: totales.numCobros,
        contado_efectivo: opciones.contadoEfectivo, tpv_declarado: opciones.tpvDeclarado,
        ...dif, corrige_a: opciones.corrigeA || null, cerrado_por: opciones.userId || null,
    };
    return insertado;
};
void createCierreReal;

function pedir(server, { metodo = 'GET', path, body }) {
    const { port } = server.address();
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, method: metodo, path,
            headers: {
                Authorization: 'Bearer sante', 'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
        }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

let fallos = 0;
async function test(nombre, fn) {
    insertado = null; reventar = null;
    try { await fn(); console.log(`ok - ${nombre}`); }
    catch (e) { console.error(`fail - ${nombre}`); console.error(e.message); fallos++; process.exitCode = 1; }
}

(async () => {
const server = http.createServer(app).listen(0);
await new Promise((r) => server.once('listening', r));

await test('1 · GET devuelve lo que suma el día y que está SIN revisar', async () => {
    const r = await pedir(server, { path: '/api/caja/cierre?fecha=2026-08-06' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.revisado, false);
    assert.strictEqual(r.body.esperado.efectivo, 100);
    assert.strictEqual(r.body.esperado.tarjeta, 50);
    assert.strictEqual(r.body.esperado.total, 150);
});

await test('2 · lo ESPERADO no se acepta del body: manda lo que hay en los cobros', async () => {
    // Se mandan importes falsos a propósito. Si el endpoint los aceptara, el acuse afirmaría
    // 9.999 € y quedaría congelado para siempre.
    const r = await pedir(server, {
        metodo: 'POST', path: '/api/caja/cierre',
        body: {
            fecha: '2026-08-06', contadoEfectivo: 100, tpvDeclarado: 50,
            esperadoEfectivo: 9999, esperadoTarjeta: 9999, esperadoTotal: 9999, numCobros: 99,
        },
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(insertado.esperado_efectivo, 100, 'lo esperado sale de los cobros, no del body');
    assert.strictEqual(insertado.esperado_total, 150);
    assert.strictEqual(insertado.num_cobros, 2);
});

await test('3 · cuadrar deja diferencia 0 y es un acuse válido', async () => {
    const r = await pedir(server, {
        metodo: 'POST', path: '/api/caja/cierre',
        body: { fecha: '2026-08-06', contadoEfectivo: 100, tpvDeclarado: 50 },
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(insertado.diferencia_efectivo, 0);
    assert.strictEqual(insertado.diferencia_tarjeta, 0);
});

await test('4 · una diferencia se guarda CON SIGNO y sin pedir motivo', async () => {
    const r = await pedir(server, {
        metodo: 'POST', path: '/api/caja/cierre',
        body: { fecha: '2026-08-06', contadoEfectivo: 95, tpvDeclarado: 50 },
    });
    assert.strictEqual(r.status, 201, 'no se bloquea por descuadrar');
    assert.strictEqual(insertado.diferencia_efectivo, -5);
});

await test('5 · un día del FUTURO no se puede haber revisado', async () => {
    // El "mañana" hay que sacarlo en la TZ del NEGOCIO, no en UTC. Con .toISOString() este
    // test se caía todas las noches entre las 00:00 y las 02:00 de Madrid: en esa franja el
    // día UTC va uno por detrás, así que el "mañana" calculado en UTC es HOY en el salón —
    // una fecha que el endpoint acepta con razón. Fallaba el test, no la guarda.
    const manana = toLocalDateStr(new Date(Date.now() + 86400000));
    const r = await pedir(server, {
        metodo: 'POST', path: '/api/caja/cierre',
        body: { fecha: manana, contadoEfectivo: 0, tpvDeclarado: 0 },
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /todavía no ha pasado/);
});

await test('6 · sin efectivo contado no se guarda (0 SÍ vale, vacío no)', async () => {
    const vacio = await pedir(server, {
        metodo: 'POST', path: '/api/caja/cierre',
        body: { fecha: '2026-08-06', tpvDeclarado: 50 },
    });
    assert.strictEqual(vacio.status, 400);
    const cero = await pedir(server, {
        metodo: 'POST', path: '/api/caja/cierre',
        body: { fecha: '2026-08-06', contadoEfectivo: 0, tpvDeclarado: 0 },
    });
    assert.strictEqual(cero.status, 201, 'un día a cero se revisa igual');
});

await test('7 · volver a revisar exige decir por qué', async () => {
    const r = await pedir(server, {
        metodo: 'POST', path: '/api/caja/cierre',
        body: { fecha: '2026-08-06', contadoEfectivo: 100, tpvDeclarado: 50, corrigeA: 'cierre-0' },
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /por qué/);
});

await test('8 · si ya lo revisó otra persona: 409, no 500', async () => {
    reventar = 'duplicate key value violates unique constraint "cierres_un_acuse_por_dia"';
    const r = await pedir(server, {
        metodo: 'POST', path: '/api/caja/cierre',
        body: { fecha: '2026-08-06', contadoEfectivo: 100, tpvDeclarado: 50 },
    });
    assert.strictEqual(r.status, 409, 'es una carrera normal, no una avería');
    assert.match(r.body.error, /ya está revisado/i);
});

await test('9 · la cola de días sin revisar se sirve tal cual', async () => {
    const r = await pedir(server, { path: '/api/caja/cierre/pendientes' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.dias, [{ fecha: '2026-08-06', numCobros: 2, total: 150 }]);
});

await test('10 · una fecha inválida no llega a la base', async () => {
    const r = await pedir(server, { path: '/api/caja/cierre?fecha=ayer' });
    assert.strictEqual(r.status, 400);
});

server.close();
if (!fallos) console.log('\nTodos los tests del endpoint de revisión OK');
process.exit(process.exitCode || 0);
})();
