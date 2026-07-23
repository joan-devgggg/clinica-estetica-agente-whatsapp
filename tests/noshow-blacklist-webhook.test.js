// Integración de la ruta PUT /api/citas/:id (item 9): marcar no_show debe encadenar
// db.setBlacklist sobre el contacto. El encadenamiento vive en webhook.js (no en un trigger
// SQL), así que se ejercita la ruta real con db mockeada y sin Supabase/Telegram reales.
process.env.TZ = 'Europe/Madrid';
process.env.DASHBOARD_API_SECRET = 'test-secret';                 // activa requireApiAuth
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const http = require('http');

// Stub del módulo telegram ANTES de requerir webhook: evita cargar node-telegram-bot-api /
// arrancar el bot, y neutraliza notifyBlacklistAlert (best-effort, no debe tocar red en tests).
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: { notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {} },
};

const { app } = require('../webhook');
const db = require('../services/db');

// Auth: la API deriva la org del token verificado. Mockeamos el verificador para
// que 'test-secret' equivalga a un usuario de org-sante (sin tocar Supabase real).
db.authenticateToken = async (token) => (token === 'test-secret' ? { userId: 'u1', orgId: 'org-sante' } : null);

// Mock de la capa db que usa la ruta (mismo objeto de módulo que webhook.js).
let blacklistCalls = [];
db.updateAppointment = async (orgId, id, body) => ({ id, contact_id: 'c1', status: body.estado });
db.findById = async () => ({ id: 'c1', nombre: 'María', telefono: '34600000000' });
db.setBlacklist = async (orgId, contactId, reason) => { blacklistCalls.push({ orgId, contactId, reason }); return true; };

function put(server, id, body) {
    const { port } = server.address();
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, method: 'PUT', path: `/api/citas/${id}`,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Authorization': 'Bearer test-secret',
                'X-Organization-Id': 'org-sante',
            },
        }, res => {
            let data = '';
            res.on('data', d => (data += d));
            res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

async function test(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    try {
        await test('9 · PUT no_show → dispara setBlacklist("No-show") en el contacto', async () => {
            blacklistCalls = [];
            const res = await put(server, 'apt-1', { estado: 'no_show' });
            assert.strictEqual(res.status, 200, 'la ruta responde 200');
            assert.strictEqual(blacklistCalls.length, 1, 'setBlacklist se llama exactamente una vez');
            assert.deepStrictEqual(blacklistCalls[0], { orgId: 'org-sante', contactId: 'c1', reason: 'No-show' });
        });

        await test('9 · CONTROL: PUT estado confirmed NO dispara setBlacklist', async () => {
            blacklistCalls = [];
            const res = await put(server, 'apt-1', { estado: 'confirmed' });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(blacklistCalls.length, 0, 'sin no_show no hay blacklist');
        });

        await test('9 · AUTH: sin token la ruta responde 401', async () => {
            const { port } = server.address();
            const res = await new Promise((resolve, reject) => {
                const r = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/api/citas/apt-1',
                    headers: { 'Content-Type': 'application/json' } }, resp => {
                    resp.on('data', () => {}); resp.on('end', () => resolve({ status: resp.statusCode }));
                });
                r.on('error', reject); r.end('{}');
            });
            assert.strictEqual(res.status, 401);
        });
    } finally {
        server.close();
    }

    if (!process.exitCode) console.log('\nTodos los tests de ruta no-show → blacklist OK');
    process.exit(process.exitCode || 0);
})();
