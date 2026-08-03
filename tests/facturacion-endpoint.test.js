// GET /api/facturacion — filtro por estilista a nivel de ruta.
//
// Ejercita la ruta real con `node:http` mockeando la capa de datos (patrón de
// api-auth-isolation.test.js). Lo que se verifica es que el ?stylist= llega TAL CUAL a la
// query y que un valor inválido se rechaza con 400: si se ignorase en silencio, el panel
// enseñaría el total de TODAS las estilistas creyendo que es el de una sola.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const http = require('http');

// Stub de telegram ANTES de requerir webhook (no cargar el bot ni tocar red).
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: { notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {} },
};

const { app } = require('../webhook');
const db = require('../services/db');
const { NO_STYLIST_KEY, filterAppointmentsByStylist } = require('../services/helpers');

const SANTE_ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const VERONIKA = 'c3d4e5f6-a7b8-9012-cdef-234567890101';
const OLGHA = 'c3d4e5f6-a7b8-9012-cdef-234567890104';

const STYLISTS = [
    { id: VERONIKA, name: 'Veronika' },
    { id: 'c3d4e5f6-a7b8-9012-cdef-234567890102', name: 'Irina' },
    { id: 'c3d4e5f6-a7b8-9012-cdef-234567890103', name: 'Yulia' },
    { id: OLGHA, name: 'Olgha' },
    { id: 'c3d4e5f6-a7b8-9012-cdef-234567890105', name: 'Larisa' },
    { id: 'c3d4e5f6-a7b8-9012-cdef-234567890106', name: 'Tetiana' },
    { id: 'c3d4e5f6-a7b8-9012-cdef-234567890107', name: 'Natalia' },
    { id: 'c3d4e5f6-a7b8-9012-cdef-234567890108', name: 'Yulia-Tricóloga' },
];

const CATALOG = [
    { nombre: 'Mujer y secado', precio: 35, duracion: 60, categoria: 'Cortes' },
    { nombre: 'Manicura + gel', precio: 35, duracion: 90, categoria: 'Manicura/Pedicura' },
    { nombre: 'Consulta', precio: null, duracion: 60, categoria: 'Consulta' },
];

const CITAS = [
    { appointment_id: 'e1', service: 'Corte mujer y secado', stylist_id: VERONIKA, stylist_name: 'Veronika', starts_at: '2026-07-20T09:00:00Z', cliente: 'Ana' },
    { appointment_id: 'e2', service: 'Consulta', stylist_id: VERONIKA, stylist_name: 'Veronika', starts_at: '2026-07-20T11:00:00Z', cliente: 'Sara' },
    { appointment_id: 'e3', service: 'Manicura + gel', stylist_id: OLGHA, stylist_name: 'Olgha', starts_at: '2026-07-21T10:00:00Z', cliente: 'Marta' },
];

db.authenticateToken = async (token) =>
    token === 'sante-token' ? { userId: 'user-sante', orgId: SANTE_ORG } : null;
db.getAgentConfig = async () => ({ services: CATALOG });
db.getStylistsByOrg = async () => STYLISTS;

// La query real filtra en Supabase; aquí replicamos esa semántica y anotamos qué recibió.
let lastArgs = null;
db.getCompletedAppointmentsForBilling = async (orgId, desde, hasta, stylistId = null) => {
    lastArgs = { orgId, desde, hasta, stylistId };
    return filterAppointmentsByStylist(CITAS, stylistId);
};

function request(server, path) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, method: 'GET', path, headers: { Authorization: 'Bearer sante-token' } },
            (res) => {
                let data = '';
                res.on('data', d => (data += d));
                res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
            }
        );
        req.on('error', reject);
        req.end();
    });
}

async function test(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

const RANGO = 'desde=2026-07-20&hasta=2026-07-26';

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    try {
        await test('sin ?stylist → informe completo + las 8 estilistas en el selector', async () => {
            lastArgs = null;
            const res = await request(server, `/api/facturacion?${RANGO}`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(lastArgs.stylistId, null);
            assert.strictEqual(res.body.stylistFiltro, null);
            assert.strictEqual(res.body.totales.totalConIva, 70);   // 35 + 35 (la Consulta no suma)
            assert.strictEqual(res.body.sinCalcularTotal, 1);
            // 8 estilistas + "Sin estilista asignada".
            assert.strictEqual(res.body.estilistasDisponibles.length, 9);
            for (const s of STYLISTS) {
                assert.ok(res.body.estilistasDisponibles.find(o => o.stylist_id === s.id), `falta ${s.name}`);
            }
        });

        await test('?stylist=<uuid> → la query recibe el filtro y el informe es solo suyo', async () => {
            const res = await request(server, `/api/facturacion?${RANGO}&stylist=${VERONIKA}`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(lastArgs.stylistId, VERONIKA);
            assert.strictEqual(res.body.stylistFiltro, VERONIKA);
            assert.strictEqual(res.body.estilistas.length, 1);
            assert.strictEqual(res.body.estilistas[0].stylist_id, VERONIKA);
            assert.strictEqual(res.body.totales.totalConIva, 35);
            // El aviso de "sin poder calcular" sigue vivo al filtrar.
            assert.strictEqual(res.body.sinCalcularTotal, 1);
            // El selector NO se colapsa a la estilista filtrada.
            assert.strictEqual(res.body.estilistasDisponibles.length, 9);
        });

        await test('filtrar por otra estilista no arrastra el aviso ajeno', async () => {
            const res = await request(server, `/api/facturacion?${RANGO}&stylist=${OLGHA}`);
            assert.strictEqual(res.body.totales.totalConIva, 35); // "Manicura + gel" entero
            assert.strictEqual(res.body.sinCalcularTotal, 0);
        });

        await test('la suma de los filtros individuales == el informe sin filtro', async () => {
            const todas = await request(server, `/api/facturacion?${RANGO}`);
            let suma = 0, citas = 0, sinCalcular = 0;
            for (const o of todas.body.estilistasDisponibles) {
                const r = await request(server, `/api/facturacion?${RANGO}&stylist=${encodeURIComponent(o.stylist_id)}`);
                assert.strictEqual(r.status, 200);
                suma += r.body.totales.totalConIva;
                citas += r.body.totales.numCitas;
                sinCalcular += r.body.sinCalcularTotal;
            }
            assert.strictEqual(suma, todas.body.totales.totalConIva);
            assert.strictEqual(citas, todas.body.totales.numCitas);
            assert.strictEqual(sinCalcular, todas.body.sinCalcularTotal);
        });

        await test('?stylist=__sin_estilista__ llega como centinela a la query', async () => {
            const res = await request(server, `/api/facturacion?${RANGO}&stylist=${NO_STYLIST_KEY}`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(lastArgs.stylistId, NO_STYLIST_KEY);
        });

        await test('?stylist inválido → 400 y NO se consulta la BD (nada de total ajeno)', async () => {
            lastArgs = null;
            const res = await request(server, `/api/facturacion?${RANGO}&stylist=veronika`);
            assert.strictEqual(res.status, 400);
            assert.strictEqual(lastArgs, null);
        });

        await test('?stylist=all se trata como "sin filtro"', async () => {
            const res = await request(server, `/api/facturacion?${RANGO}&stylist=all`);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(lastArgs.stylistId, null);
        });

        await test('sin token → 401 (la facturación no es pública)', async () => {
            const { port } = server.address();
            const status = await new Promise((resolve, reject) => {
                const req = http.request(
                    { host: '127.0.0.1', port, method: 'GET', path: `/api/facturacion?${RANGO}` },
                    res => resolve(res.statusCode)
                );
                req.on('error', reject);
                req.end();
            });
            assert.strictEqual(status, 401);
        });
    } finally {
        server.close();
    }

    if (!process.exitCode) console.log('\nTests del endpoint de facturación OK');
    process.exit(process.exitCode || 0);
})();
