// Auth + aislamiento entre orgs de la API REST (webhook.js).
//
// La API deriva la organización del token verificado de Supabase (req.authOrgId),
// NUNCA del header X-Organization-Id. Se ejercita la ruta real con `node:http`,
// mockeando db.authenticateToken (verificador de token) y db.getAllLeads, sin
// tocar Supabase ni Telegram reales. Patrón de noshow-blacklist-webhook.test.js.
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

const { app, setWAClient } = require('../webhook');
const db = require('../services/db');

const SANTE_ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const SANREMO_ORG = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// Verificador de token falso: solo 'sante-token' es válido → usuario de Sante.
db.authenticateToken = async (token) => {
    if (token === 'sante-token') return { userId: 'user-sante', orgId: SANTE_ORG };
    return null;
};

// Captura el orgId con el que el handler consulta la base de datos.
let lastLeadsOrgId = null;
db.getAllLeads = async (orgId) => { lastLeadsOrgId = orgId; return []; };

// Los dos clientes de WhatsApp, como los monta server.js: uno por org, cada uno con su
// canal. Hacen falta para que /api/wa-status tenga algo que contar.
setWAClient(new Map([
    [SANTE_ORG,   { slug: 'sante-healthy-hair-salon', channel: '360dialog', client: {} }],
    [SANREMO_ORG, { slug: 'restaurante-san-remo', channel: 'wwebjs',
                    client: { getState: async () => 'CONNECTED' } }],
]), () => {}, () => {});

function request(server, { method = 'GET', path = '/', headers = {} }) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
            let data = '';
            res.on('data', (d) => (data += d));
            res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function test(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

(async () => {
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
        await test('sin token → 401 (ruta protegida sin sesión)', async () => {
            const res = await request(server, { path: '/api/leads' });
            assert.strictEqual(res.status, 401);
        });

        await test('token inválido → 401', async () => {
            const res = await request(server, {
                path: '/api/leads',
                headers: { Authorization: 'Bearer token-que-no-existe' },
            });
            assert.strictEqual(res.status, 401);
        });

        await test('AISLAMIENTO: token de Sante + header X-Organization-Id de San Remo → usa SANTE', async () => {
            lastLeadsOrgId = null;
            const res = await request(server, {
                path: '/api/leads',
                headers: {
                    Authorization: 'Bearer sante-token',
                    'X-Organization-Id': SANREMO_ORG, // intento de forzar otra org
                },
            });
            assert.strictEqual(res.status, 200, 'la ruta responde 200 con token válido');
            assert.strictEqual(lastLeadsOrgId, SANTE_ORG, 'la org proviene del token, no del header');
            assert.notStrictEqual(lastLeadsOrgId, SANREMO_ORG, 'jamás la org del header manipulado');
        });

        await test('happy path: token de Sante sin header → usa SANTE y responde 200', async () => {
            lastLeadsOrgId = null;
            const res = await request(server, {
                path: '/api/leads',
                headers: { Authorization: 'Bearer sante-token' },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(lastLeadsOrgId, SANTE_ORG);
        });

        // ─── /api/wa-status: era el único endpoint que contestaba sin sesión ────────────
        //
        // Estuvo registrado POR ENCIMA de `app.use('/api', requireApiAuth)` desde el
        // 24/06/2026 —nació como algo que mirar con un curl cuando el cliente de Sante se
        // caía en silencio— y por eso le daba a cualquiera con la URL el slug de TODAS las
        // organizaciones y su estado de conexión. Se cerró el 20/08/2026, antes de publicar
        // el enlace público de reserva.
        //
        // Estos tres bloques son el candado: el primero impide que vuelva a registrarse
        // antes del middleware (es un error de UNA línea y no se ve en ninguna pantalla), y
        // los otros dos, que responder por todas las orgs no cuente como haberlo cerrado.

        await test('wa-status SIN token → 401, ya no contesta a un desconocido', async () => {
            const res = await request(server, { path: '/api/wa-status' });
            assert.strictEqual(res.status, 401, 'sigue siendo público: se puede leer sin sesión');
        });

        await test('wa-status sin token NO filtra ni un slug de organización', async () => {
            // La fuga concreta que tenía: los nombres de las orgs dadas de alta. Se afirma
            // sobre el cuerpo CRUDO, no sobre las claves, para que dé igual cómo se
            // reestructure la respuesta el día de mañana.
            const res = await request(server, { path: '/api/wa-status' });
            const crudo = JSON.stringify(res.body);
            for (const aguja of ['sante', 'san-remo', 'CONNECTED', '360dialog', SANTE_ORG, SANREMO_ORG]) {
                assert.ok(!crudo.toLowerCase().includes(aguja.toLowerCase()),
                    `sin token todavía se filtra «${aguja}»: ${crudo}`);
            }
        });

        await test('wa-status CON token responde solo por SU org, no por las dos', async () => {
            const res = await request(server, {
                path: '/api/wa-status',
                headers: { Authorization: 'Bearer sante-token' },
            });
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(Object.keys(res.body), ['sante-healthy-hair-salon']);
            // Devolver el mapa entero a una sesión autenticada sería la misma fuga con un
            // paso más: un usuario de Sante leyendo el estado de San Remo es justo lo que
            // `extractOrgId` existe para impedir.
            assert.ok(!('restaurante-san-remo' in res.body), 'una org lee el estado de la otra');
            assert.strictEqual(res.body['sante-healthy-hair-salon'], '360DIALOG');
        });
    } finally {
        server.close();
    }

    if (!process.exitCode) console.log('\nTests de auth + aislamiento de API OK');
    process.exit(process.exitCode || 0);
})();
