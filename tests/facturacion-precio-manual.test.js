// PATCH /api/citas/:id/precio — importe manual de una cita.
//
// Ejercita la ruta real con `node:http` mockeando la capa de datos (patrón de
// facturacion-endpoint.test.js). Es dinero, así que lo que se verifica es sobre todo lo que
// NO debe pasar: que un 0 se guarde (y no se lea como "sin corrección"), que la atribución
// salga del token y no del body, que San Remo no pueda usarla, y que el payload que llega a
// Supabase no contenga NINGUNA columna del snapshot ni el `service` — el invariante que
// impide que corregir un importe reescriba lo que se hizo, o al revés.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const http = require('http');

// Stub de telegram ANTES de requerir webhook (no cargar el bot ni tocar red).
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: { notifyReservaWeb: async () => {}, notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {} },
};

const { app } = require('../webhook');
const db = require('../services/db');

const SANTE_ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const SANREMO_ORG = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const CITA = '7d32c9b0-4d32-4572-8427-40c7c3a1f582';

db.authenticateToken = async (token) => {
    if (token === 'sante-token') return { userId: 'user-yulia', orgId: SANTE_ORG };
    if (token === 'sanremo-token') return { userId: 'user-alberto', orgId: SANREMO_ORG };
    return null;
};

let lastCall = null;
db.setManualPrice = async (orgId, appointmentId, opts) => {
    lastCall = { orgId, appointmentId, opts };
    if (appointmentId === 'no-existe') return null;
    return { id: appointmentId, precio_manual: opts.precio, precio_manual_motivo: opts.motivo };
};

function request(server, { path, body, token = 'sante-token' }) {
    const { port } = server.address();
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1', port, method: 'PATCH', path,
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                },
            },
            (res) => {
                let data = '';
                res.on('data', d => (data += d));
                res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function test(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

const RUTA = `/api/citas/${CITA}/precio`;

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    try {
        await test('fija un importe con motivo', async () => {
            const res = await request(server, { path: RUTA, body: { precio: 260, motivo: 'faltaba el difuminado' } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(lastCall.orgId, SANTE_ORG);
            assert.strictEqual(lastCall.appointmentId, CITA);
            assert.strictEqual(lastCall.opts.precio, 260);
            assert.strictEqual(lastCall.opts.motivo, 'faltaba el difuminado');
        });

        await test('precio 0 se ACEPTA: una cortesía es un importe, no una ausencia', async () => {
            const res = await request(server, { path: RUTA, body: { precio: 0, motivo: 'cortesía' } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(lastCall.opts.precio, 0, 'no puede colarse como null');
        });

        await test('precio null limpia el importe manual', async () => {
            const res = await request(server, { path: RUTA, body: { precio: null } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(lastCall.opts.precio, null);
            assert.strictEqual(lastCall.opts.motivo, null);
        });

        await test('rechaza un precio negativo', async () => {
            const res = await request(server, { path: RUTA, body: { precio: -10 } });
            assert.strictEqual(res.status, 400);
        });

        await test('rechaza un precio que no es número (string, NaN)', async () => {
            assert.strictEqual((await request(server, { path: RUTA, body: { precio: '150' } })).status, 400);
            assert.strictEqual((await request(server, { path: RUTA, body: { precio: 'abc' } })).status, 400);
        });

        await test('rechaza un motivo desmesurado', async () => {
            const res = await request(server, { path: RUTA, body: { precio: 10, motivo: 'x'.repeat(301) } });
            assert.strictEqual(res.status, 400);
        });

        await test('404 si la cita no existe en esa org', async () => {
            const res = await request(server, { path: '/api/citas/no-existe/precio', body: { precio: 10 } });
            assert.strictEqual(res.status, 404);
        });

        await test('403 para San Remo: el importe manual es solo de salón', async () => {
            lastCall = null;
            const res = await request(server, { path: RUTA, body: { precio: 10 }, token: 'sanremo-token' });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(lastCall, null, 'ni siquiera llega a la capa de datos');
        });

        await test('401 sin token', async () => {
            const res = await request(server, { path: RUTA, body: { precio: 10 }, token: '' });
            assert.strictEqual(res.status, 401);
        });

        await test('la atribución sale del TOKEN, nunca del body', async () => {
            await request(server, { path: RUTA, body: { precio: 50, userId: 'otro-usuario', precio_manual_por: 'otro-usuario' } });
            assert.strictEqual(lastCall.opts.userId, 'user-yulia');
        });

        // ── El invariante: dos escrituras, y ninguna pisa a la otra ──────────────
        await test('el payload a Supabase NO toca el snapshot ni el `service`', async () => {
            const enviados = [];
            const filtros = [];
            // Doble mínimo de la cadena de supabase-js para capturar el update real.
            // services/supabase.js exporta el CLIENTE directamente, no { supabase }.
            const fake = {
                from: () => fake,
                update: (u) => { enviados.push(u); return fake; },
                eq: (col, val) => { filtros.push([col, val]); return fake; },
                select: async () => ({ data: [{ id: CITA }], error: null }),
            };
            const supabasePath = require.resolve('../services/supabase');
            const original = require.cache[supabasePath];
            require.cache[supabasePath] = {
                id: supabasePath, filename: supabasePath, loaded: true, exports: fake,
            };
            delete require.cache[require.resolve('../services/db')];
            const dbFresco = require('../services/db');

            await dbFresco.setManualPrice(SANTE_ORG, CITA, { precio: 260, motivo: 'x', userId: 'user-yulia' });
            // Nunca sin acotar por org: si no, un id de otra org sería editable desde el panel.
            assert.ok(filtros.some(([c, v]) => c === 'organization_id' && v === SANTE_ORG), 'filtra por org');
            assert.strictEqual(enviados.length, 1);
            const prohibidas = ['precio_facturado', 'facturado_at', 'iva_rate', 'stylist_name_facturado', 'servicio_facturado', 'service', 'status'];
            for (const k of prohibidas) {
                assert.ok(!(k in enviados[0]), `setManualPrice no puede escribir ${k}`);
            }
            assert.strictEqual(enviados[0].precio_manual, 260);
            assert.strictEqual(enviados[0].precio_manual_por, 'user-yulia');

            // Y al limpiar, las cuatro columnas a null y nada más.
            await dbFresco.setManualPrice(SANTE_ORG, CITA, { precio: null });
            assert.deepStrictEqual(Object.keys(enviados[1]).sort(),
                ['precio_manual', 'precio_manual_at', 'precio_manual_motivo', 'precio_manual_por']);
            for (const v of Object.values(enviados[1])) assert.strictEqual(v, null);

            if (original) require.cache[supabasePath] = original; else delete require.cache[supabasePath];
            delete require.cache[require.resolve('../services/db')];
        });

        await test('un fallo de escritura LANZA: nunca se lee como "esa cita no existe"', async () => {
            // Sin esto, un error de Supabase devolvería null, el panel diría 404 y nadie se
            // enteraría de que la corrección del importe no llegó a guardarse.
            const fake = {
                from: () => fake, update: () => fake, eq: () => fake,
                select: async () => ({ data: null, error: { message: 'boom', code: '42501' } }),
            };
            const supabasePath = require.resolve('../services/supabase');
            const original = require.cache[supabasePath];
            require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fake };
            delete require.cache[require.resolve('../services/db')];
            const dbFresco = require('../services/db');

            await assert.rejects(
                () => dbFresco.setManualPrice(SANTE_ORG, CITA, { precio: 10 }),
                /setManualPrice|appointments/,
            );

            if (original) require.cache[supabasePath] = original; else delete require.cache[supabasePath];
            delete require.cache[require.resolve('../services/db')];
        });
    } finally {
        server.close();
    }

    if (!process.exitCode) console.log('\nTodos los tests de importe manual OK');
    process.exit(process.exitCode || 0);
})();
