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
    sanitizeTemplateParam,
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

// ─── build360Client.sendTemplate: plantillas aprobadas (fuera de ventana 24h) ──
async function captureSend(fn) {
    const original = global.fetch;
    let captured = null;
    global.fetch = async (url, opts) => {
        captured = { url, opts };
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) };
    };
    try { await fn(build360Client(SANTE_ORG_ID)); }
    finally { global.fetch = original; }
    return captured;
}

test('sendTemplate: payload type=template con nombre, idioma y params en orden', async () => {
    const captured = await captureSend(client => client.sendTemplate('34600111222@c.us', {
        name: 'sante_recordatorio_cita',
        language: 'es',
        params: ['María López', '17:30'],
    }));

    assert.strictEqual(captured.url, 'https://waba-v2.360dialog.io/messages');
    assert.strictEqual(captured.opts.method, 'POST');
    assert.strictEqual(captured.opts.headers['D360-API-KEY'], 'test-key-360');
    const body = JSON.parse(captured.opts.body);
    assert.strictEqual(body.messaging_product, 'whatsapp');
    assert.strictEqual(body.recipient_type, 'individual');
    assert.strictEqual(body.to, '34600111222');
    assert.strictEqual(body.type, 'template');
    assert.strictEqual(body.text, undefined, 'una plantilla no lleva bloque text');
    assert.strictEqual(body.template.name, 'sante_recordatorio_cita');
    assert.deepStrictEqual(body.template.language, { code: 'es' });
    assert.strictEqual(body.template.components.length, 1);
    assert.strictEqual(body.template.components[0].type, 'body');
    // El ORDEN es el contrato con Meta: {{1}} nombre, {{2}} hora.
    assert.deepStrictEqual(body.template.components[0].parameters, [
        { type: 'text', text: 'María López' },
        { type: 'text', text: '17:30' },
    ]);
});

test('sendTemplate: la plantilla de reseña lleva el enlace como {{2}}', async () => {
    const captured = await captureSend(client => client.sendTemplate('34600111222@c.us', {
        name: 'sante_solicitud_resena',
        language: 'es',
        params: ['María López', 'https://maps.app.goo.gl/PGdw5KeetLKbbdk18'],
    }));
    const body = JSON.parse(captured.opts.body);
    assert.strictEqual(body.template.name, 'sante_solicitud_resena');
    assert.deepStrictEqual(body.template.components[0].parameters, [
        { type: 'text', text: 'María López' },
        { type: 'text', text: 'https://maps.app.goo.gl/PGdw5KeetLKbbdk18' },
    ]);
});

// Meta rechaza el mensaje ENTERO (132000/131008) si un parámetro trae salto de línea,
// tabulador o 4+ espacios seguidos — y {{1}} es el nombre que escribió la clienta.
test('sendTemplate: sanea saltos de línea, tabuladores y espacios múltiples', async () => {
    assert.strictEqual(sanitizeTemplateParam('María\nLópez'), 'María López');
    assert.strictEqual(sanitizeTemplateParam('María\t\tLópez'), 'María López');
    assert.strictEqual(sanitizeTemplateParam('María     López'), 'María López');
    assert.strictEqual(sanitizeTemplateParam('  María  '), 'María');
    assert.strictEqual(sanitizeTemplateParam(null), '');

    const captured = await captureSend(client => client.sendTemplate('34600111222@c.us', {
        name: 'sante_recordatorio_cita', language: 'es', params: ['Ana\nMaría', '17:30'],
    }));
    const body = JSON.parse(captured.opts.body);
    assert.strictEqual(body.template.components[0].parameters[0].text, 'Ana María');
    assert.ok(!captured.opts.body.includes('\\n'), 'no debe viajar ningún \\n en los params');
});

test('sendTemplate: sin nombre de plantilla lanza (nunca un POST a medias)', async () => {
    const original = global.fetch;
    let llamado = false;
    global.fetch = async () => { llamado = true; return { ok: true, json: async () => ({}) }; };
    try {
        const client = build360Client(SANTE_ORG_ID);
        await assert.rejects(() => client.sendTemplate('34600111222@c.us', { params: ['x'] }),
            /sin nombre de plantilla/);
    } finally {
        global.fetch = original;
    }
    assert.strictEqual(llamado, false, 'no debe salir ninguna petición');
});

test('sendTemplate: propaga el error HTTP igual que sendMessage (para reintento)', async () => {
    const original = global.fetch;
    global.fetch = async () => ({ ok: false, status: 400, text: async () => '{"error":{"code":132001}}' });
    try {
        const client = build360Client(SANTE_ORG_ID);
        await assert.rejects(
            () => client.sendTemplate('34600111222@c.us', { name: 'sante_recordatorio_cita', params: [] }),
            /360dialog send 400/
        );
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
        onPausedDrop: () => {},
    });
    assert.strictEqual(calls.length, 0);
});

// El 01/08/2026 se pausó el bot de toda la org creyendo que se pausaba una conversación y
// se tiraron ~4 h de mensajes sin que nadie se enterara. Descartar en silencio es el bug:
// cada mensaje tirado tiene que avisar, con el teléfono de quien se quedó sin respuesta.
test('process360Webhook avisa (con teléfono) de cada mensaje descartado por bot pausado', async () => {
    const avisos = [];
    await process360Webhook(textPayload(), {
        resolveOrgByPhone,
        isBotActivo: () => false,
        handleIncomingMessage: async () => {},
        onPausedDrop: (orgId, telefono, origen) => avisos.push({ orgId, telefono, origen }),
    });
    assert.strictEqual(avisos.length, 1);
    assert.strictEqual(avisos[0].orgId, SANTE_ORG_ID);
    assert.strictEqual(avisos[0].origen, '360dialog_webhook');
    assert.ok(avisos[0].telefono, 'el aviso debe llevar el teléfono de la clienta');
});

// El throttle no puede tragarse el PRIMER aviso tras reactivar: si se pausa otra vez, el
// siguiente mensaje descartado debe avisar ya.
test('resetPauseAlert deja avisar de inmediato tras reactivar el bot', () => {
    const { notePausedDrop, resetPauseAlert } = require('../services/bot-pause-alert');
    const orgId = 'org-test-pausa';
    let enviados = 0;
    const telegram = require('../services/telegram');
    const original = telegram.notifyOrgAdmin;
    telegram.notifyOrgAdmin = () => { enviados++; };
    try {
        notePausedDrop(orgId, '34600000000', 'test');
        notePausedDrop(orgId, '34600000000', 'test'); // dentro de la ventana → no avisa
        assert.strictEqual(enviados, 1, 'el throttle debe silenciar el segundo');
        resetPauseAlert(orgId);
        notePausedDrop(orgId, '34600000000', 'test');
        assert.strictEqual(enviados, 2, 'tras reactivar debe volver a avisar');
    } finally {
        telegram.notifyOrgAdmin = original;
    }
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
