// Adapter de canal 360dialog (WhatsApp Cloud API): verifica que un payload Cloud
// API se adapta a la superficie { message, client } que consume
// handleIncomingMessage, sin red real (fetch stubeado). Parte DETERMINISTA —
// sin WhatsApp/LLM/Supabase.
process.env.TZ = 'Europe/Madrid';
process.env.SANTE_360_API_KEY = 'test-key-360';
process.env.SANTE_360_PHONE_NUMBER_ID = '111222333';
process.env.WHATSAPP_360_BASE_URL = 'https://waba-v2.360dialog.io';

const assert = require('assert');
const { SANTE_ORG_ID, SANREMO_ORG_ID, resolveOrgByPhone } = require('../services/org-registry');
const {
    get360Config,
    build360Client,
    buildInboundAdapters,
    process360Webhook,
} = require('../services/providers/threesixty-dialog');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Payload Cloud API de ejemplo (mensaje de texto entrante al número de Sante).
function textPayload(from = '34600111222', text = 'Hola, quiero una cita') {
    return {
        object: 'whatsapp_business_account',
        entry: [{
            id: 'WABA_ID',
            changes: [{
                field: 'messages',
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: '34641029104', phone_number_id: '111222333' },
                    contacts: [{ profile: { name: 'Ana' }, wa_id: from }],
                    messages: [{ from, id: 'wamid.TEST123', timestamp: '1700000000', type: 'text', text: { body: text } }],
                },
            }],
        }],
    };
}

// ─── get360Config: registry por orgId ────────────────────────────────────────
test('get360Config devuelve config para Sante', () => {
    const cfg = get360Config(SANTE_ORG_ID);
    assert.ok(cfg, 'debería haber config para Sante');
    assert.strictEqual(cfg.apiKey, 'test-key-360');
    assert.strictEqual(cfg.baseUrl, 'https://waba-v2.360dialog.io');
});

test('get360Config devuelve null para org sin canal 360 (San Remo)', () => {
    assert.strictEqual(get360Config(SANREMO_ORG_ID), null);
});

// ─── buildInboundAdapters: adaptación de mensaje entrante ─────────────────────
test('adapta un mensaje de texto a la superficie message de wwebjs', () => {
    const value = textPayload().entry[0].changes[0].value;
    const { message } = buildInboundAdapters(value.messages[0], value.metadata, SANTE_ORG_ID);
    assert.strictEqual(message.from, '34600111222@c.us');
    assert.strictEqual(message.body, 'Hola, quiero una cita');
    assert.strictEqual(message.id._serialized, 'wamid.TEST123');
    assert.strictEqual(message.type, 'chat');
    assert.strictEqual(message.hasMedia, false);
    assert.strictEqual(message.fromMe, false);
    assert.strictEqual(message.isStatus, false);
    assert.strictEqual(message.isBroadcast, false);
});

test('adapta un mensaje de audio a type ptt + hasMedia', () => {
    const audioMsg = { from: '34600111222', id: 'wamid.AUDIO', type: 'audio', audio: { id: 'MEDIA1', mime_type: 'audio/ogg' } };
    const { message } = buildInboundAdapters(audioMsg, { display_phone_number: '34641029104' }, SANTE_ORG_ID);
    assert.strictEqual(message.type, 'ptt');
    assert.strictEqual(message.hasMedia, true);
    assert.strictEqual(message.body, '');
});

// ─── build360Client.sendMessage: formación de la petición saliente ────────────
test('client.sendMessage forma correctamente la petición a 360dialog', async () => {
    const original = global.fetch;
    let captured = null;
    global.fetch = async (url, opts) => {
        captured = { url, opts };
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) };
    };
    try {
        const client = build360Client(SANTE_ORG_ID);
        await client.sendMessage('34600111222@c.us', 'Te confirmo la cita ✅');
    } finally {
        global.fetch = original;
    }
    assert.ok(captured, 'fetch debería haberse llamado');
    assert.strictEqual(captured.url, 'https://waba-v2.360dialog.io/messages');
    assert.strictEqual(captured.opts.method, 'POST');
    assert.strictEqual(captured.opts.headers['D360-API-KEY'], 'test-key-360');
    assert.strictEqual(captured.opts.headers['Content-Type'], 'application/json');
    const body = JSON.parse(captured.opts.body);
    assert.strictEqual(body.messaging_product, 'whatsapp');
    assert.strictEqual(body.to, '34600111222');
    assert.strictEqual(body.type, 'text');
    assert.strictEqual(body.text.body, 'Te confirmo la cita ✅');
});

test('client.sendMessage lanza si la respuesta no es ok (para reintento)', async () => {
    const original = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    try {
        const client = build360Client(SANTE_ORG_ID);
        await assert.rejects(() => client.sendMessage('34600111222@c.us', 'x'), /360dialog send 500/);
    } finally {
        global.fetch = original;
    }
});

// ─── getChatById: no-op sendStateTyping ───────────────────────────────────────
test('getChatById().sendStateTyping es un no-op sin lanzar', async () => {
    const client = build360Client(SANTE_ORG_ID);
    await client.getChatById('34600111222@c.us').sendStateTyping();
});

// ─── process360Webhook: routing + gates ───────────────────────────────────────
test('process360Webhook enruta a Sante y llama a handleIncomingMessage', async () => {
    const calls = [];
    await process360Webhook(textPayload(), {
        resolveOrgByPhone,
        isBotActivo: () => true,
        handleIncomingMessage: async (client, message, orgId) => { calls.push({ message, orgId }); },
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].orgId, SANTE_ORG_ID);
    assert.strictEqual(calls[0].message.body, 'Hola, quiero una cita');
});

test('process360Webhook respeta el gate isBotActivo (pausado → no procesa)', async () => {
    const calls = [];
    await process360Webhook(textPayload(), {
        resolveOrgByPhone,
        isBotActivo: () => false,
        handleIncomingMessage: async () => { calls.push(1); },
    });
    assert.strictEqual(calls.length, 0);
});

test('process360Webhook ignora payloads de statuses (entrega), no los trata como mensaje', async () => {
    const calls = [];
    const statusPayload = {
        entry: [{ changes: [{ value: {
            metadata: { display_phone_number: '34641029104' },
            statuses: [{ id: 'wamid.X', status: 'delivered' }],
        } }] }],
    };
    await process360Webhook(statusPayload, {
        resolveOrgByPhone,
        isBotActivo: () => true,
        handleIncomingMessage: async () => { calls.push(1); },
    });
    assert.strictEqual(calls.length, 0);
});

test('process360Webhook ignora un número receptor sin org 360 configurada', async () => {
    const calls = [];
    const payload = textPayload();
    payload.entry[0].changes[0].value.metadata.display_phone_number = '34667474233'; // San Remo (sin 360)
    await process360Webhook(payload, {
        resolveOrgByPhone,
        isBotActivo: () => true,
        handleIncomingMessage: async () => { calls.push(1); },
    });
    assert.strictEqual(calls.length, 0);
});

// ─── Runner secuencial (soporta tests sync y async) ───────────────────────────
(async () => {
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
    }
})();
