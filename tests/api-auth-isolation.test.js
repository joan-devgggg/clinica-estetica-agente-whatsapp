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

const { app } = require('../webhook');
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
    } finally {
        server.close();
    }

    if (!process.exitCode) console.log('\nTests de auth + aislamiento de API OK');
    process.exit(process.exitCode || 0);
})();
