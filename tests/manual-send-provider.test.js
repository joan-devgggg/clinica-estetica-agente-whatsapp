// Enrutado de proveedor del envío SALIENTE del panel (webhook.js → getOutboundClient).
//
// La migración a 360dialog (Sante) cubrió los ENTRANTES; el envío manual del panel
// (`POST /api/send`) seguía usando el cliente whatsapp-web.js. Con la sesión wwebjs
// de Sante caída eso daba "Cannot read properties of null (reading 'evaluate')".
// Ahora getOutboundClient enruta por proveedor: Sante (con SANTE_360_API_KEY) sale
// por 360dialog; San Remo sigue EXACTO por whatsapp-web.js.
//
// Ejercita la ruta real con `node:http`, mockeando db + stubbeando telegram y ./bot
// (no se carga el bot real ni se toca red/Supabase). Patrón de api-auth-isolation.test.js.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.SANTE_360_API_KEY = 'test-key-360';
process.env.WHATSAPP_360_BASE_URL = 'https://waba-v2.360dialog.io';

const assert = require('assert');
const http = require('http');

// Stub de telegram ANTES de requerir webhook (no cargar el bot ni tocar red).
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: { notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {} },
};

// Stub de ./bot: /api/send hace `require('./bot')` en runtime. Reproducimos la
// superficie mínima que usa la ruta; waSendMessage delega en client.sendMessage
// igual que el real, así el test verifica QUÉ cliente resuelve getOutboundClient.
const botPath = require.resolve('../bot');
require.cache[botPath] = {
    id: botPath, filename: botPath, loaded: true,
    exports: {
        findOriginalJid: () => null,
        isTransientWAError: () => false,
        waSendMessage: async (client, jid, text) => client.sendMessage(jid, text),
    },
};

const { app, setWAClient } = require('../webhook');
const db = require('../services/db');

const SANTE_ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const SANREMO_ORG = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// Verificador de token falso: cada token mapea a su org.
db.authenticateToken = async (token) => {
    if (token === 'sante-token') return { userId: 'user-sante', orgId: SANTE_ORG };
    if (token === 'sanremo-token') return { userId: 'user-sanremo', orgId: SANREMO_ORG };
    return null;
};
db.getContactWaJid = async () => null; // sin JID persistido → heurística @c.us
let savedMessages = [];
db.saveMessage = async (orgId, msg) => { savedMessages.push({ orgId, ...msg }); };
// Escribir a mano pausa el bot en ESA conversación (bot_mode='manual').
let botModeCalls = [];
db.setLeadBotMode = async (orgId, telefono, mode) => { botModeCalls.push({ orgId, telefono, mode }); };
// Registro de la otra mitad del par: la sesión en memoria/SQLite.
let convModeCalls = [];

// Cliente wwebjs FALSO para San Remo (registra los envíos; ningún Puppeteer real).
let wwebSends = [];
const fakeWwebClient = {
    getChatById: async () => ({ sendStateTyping: async () => {} }),
    sendMessage: async (jid, text) => { wwebSends.push({ jid, text }); return { id: 'wweb-out' }; },
};
setWAClient(
    new Map([[SANREMO_ORG, { client: fakeWwebClient, slug: 'sanremo' }]]),
    (telefono, activo) => { convModeCalls.push({ telefono, activo }); },
    () => {}
);

function request(server, { method = 'POST', path = '/', headers = {}, body = null }) {
    const { port } = server.address();
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, method, path,
            headers: { 'Content-Type': 'application/json', ...headers },
        }, (res) => {
            let data = '';
            res.on('data', (d) => (data += d));
            res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
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
        await test('Sante: envío manual sale por 360dialog (no por wwebjs)', async () => {
            wwebSends = []; savedMessages = [];
            let fetched = null;
            const originalFetch = global.fetch;
            global.fetch = async (url, opts) => {
                fetched = { url, opts };
                return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) };
            };
            try {
                const res = await request(server, {
                    path: '/api/send',
                    headers: { Authorization: 'Bearer sante-token' },
                    body: { telefono: '34600111222', mensaje: 'Hola desde el panel' },
                });
                assert.strictEqual(res.status, 200, 'responde 200');
            } finally {
                global.fetch = originalFetch;
            }
            assert.ok(fetched, 'debería haber llamado a 360dialog vía fetch');
            assert.strictEqual(fetched.url, 'https://waba-v2.360dialog.io/messages');
            assert.strictEqual(fetched.opts.headers['D360-API-KEY'], 'test-key-360');
            const sent = JSON.parse(fetched.opts.body);
            assert.strictEqual(sent.to, '34600111222');
            assert.strictEqual(sent.text.body, 'Hola desde el panel');
            assert.strictEqual(wwebSends.length, 0, 'NO debe usar el cliente wwebjs para Sante');
            assert.strictEqual(savedMessages.length, 1, 'guarda el mensaje saliente');
            assert.strictEqual(savedMessages[0].esManual, true);
        });

        await test('San Remo: envío manual sigue por whatsapp-web.js (no toca 360dialog)', async () => {
            wwebSends = []; savedMessages = [];
            let fetched = null;
            const originalFetch = global.fetch;
            global.fetch = async (url, opts) => { fetched = { url, opts }; return { ok: true, json: async () => ({}) }; };
            try {
                const res = await request(server, {
                    path: '/api/send',
                    headers: { Authorization: 'Bearer sanremo-token' },
                    body: { telefono: '34600999888', mensaje: 'Reserva confirmada' },
                });
                assert.strictEqual(res.status, 200, 'responde 200');
            } finally {
                global.fetch = originalFetch;
            }
            assert.strictEqual(fetched, null, 'San Remo NO debe llamar a 360dialog');
            assert.strictEqual(wwebSends.length, 1, 'usa el cliente wwebjs');
            assert.strictEqual(wwebSends[0].jid, '34600999888@c.us');
            assert.strictEqual(wwebSends[0].text, 'Reserva confirmada');
        });

        // ─── Pausa por envío manual ──────────────────────────────────────────────────
        // 01/08/2026: Yulia escribió a Valeria desde el panel y el bot, que seguía en
        // 'auto', volvió a hablar encima ("Nos vemos pronto" a una clienta sin cita).
        // Escribir a mano tiene que apartar al bot de ESA conversación, y de ninguna más.

        await test('escribir a mano pausa el bot SOLO en esa conversación', async () => {
            botModeCalls = []; convModeCalls = []; savedMessages = [];
            const originalFetch = global.fetch;
            global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) });
            try {
                const res = await request(server, {
                    path: '/api/send',
                    headers: { Authorization: 'Bearer sante-token' },
                    body: { telefono: '34600111222', mensaje: 'Te atiendo yo' },
                });
                assert.strictEqual(res.status, 200);
                assert.strictEqual(res.body.botPausado, true, 'la respuesta informa de la pausa');
            } finally {
                global.fetch = originalFetch;
            }
            assert.deepStrictEqual(botModeCalls, [
                { orgId: SANTE_ORG, telefono: '34600111222', mode: 'manual' },
            ], 'un solo contacto, modo manual — nunca la org entera');
            assert.deepStrictEqual(convModeCalls, [{ telefono: '34600111222', activo: false }],
                'también se apaga la sesión en memoria: si no, el bot sigue hasta el reinicio');
        });

        await test('pausarBot:false (reactivar tras lista negra) NO pausa', async () => {
            botModeCalls = []; convModeCalls = [];
            const originalFetch = global.fetch;
            global.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) });
            try {
                const res = await request(server, {
                    path: '/api/send',
                    headers: { Authorization: 'Bearer sante-token' },
                    body: { telefono: '34600111222', mensaje: 'Hemos revisado tu caso', pausarBot: false },
                });
                assert.strictEqual(res.status, 200);
                assert.strictEqual(res.body.botPausado, false);
            } finally {
                global.fetch = originalFetch;
            }
            assert.strictEqual(botModeCalls.length, 0, 'no debe deshacer el auto recién puesto');
            assert.strictEqual(convModeCalls.length, 0);
        });

        await test('si el envío FALLA no se pausa el bot (nadie ha atendido)', async () => {
            botModeCalls = []; convModeCalls = []; savedMessages = [];
            const originalFetch = global.fetch;
            global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });
            try {
                const res = await request(server, {
                    path: '/api/send',
                    headers: { Authorization: 'Bearer sante-token' },
                    body: { telefono: '34600111222', mensaje: 'no sale' },
                });
                assert.notStrictEqual(res.status, 200, 'el envío fallido no responde 200');
            } finally {
                global.fetch = originalFetch;
            }
            assert.strictEqual(botModeCalls.length, 0, 'sin envío no hay pausa');
            assert.strictEqual(savedMessages.length, 0, 'ni mensaje guardado');
        });
    } finally {
        server.close();
    }

    if (!process.exitCode) console.log('\nTests de enrutado de proveedor del envío del panel OK');
    process.exit(process.exitCode || 0);
})();
