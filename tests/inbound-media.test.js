// Mensajes entrantes que NO son texto (foto, sticker, vídeo, documento, ubicación, contacto).
// Antes el adaptador de Cloud API los marcaba como texto vacío sin media, así que bot.js salía
// en silencio: la clienta mandaba una foto y no recibía nada. Aquí se fija el contrato de las
// dos piezas puras del arreglo:
//   1. buildInboundAdapters expone el tipo REAL y recupera el caption.
//   2. classifyIncomingMedia + unsupportedMediaMsg dan una respuesta en el idioma de la clienta.
// Parte DETERMINISTA — sin WhatsApp/LLM/Supabase.
process.env.TZ = 'Europe/Madrid';
process.env.SANTE_360_API_KEY = 'test-key-360';
process.env.SANTE_360_PHONE_NUMBER_ID = '111222333';

const assert = require('assert');
const { SANTE_ORG_ID } = require('../services/org-registry');
const { buildInboundAdapters } = require('../services/providers/threesixty-dialog');
const { classifyIncomingMedia, unsupportedMediaMsg } = require('../services/helpers');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const META = { display_phone_number: '34641029104' };
function adapt(valueMessage) {
    return buildInboundAdapters(valueMessage, META, SANTE_ORG_ID).message;
}

// ─── 1. El adaptador de Cloud API no miente sobre el tipo ─────────────────────
const TIPOS = [
    ['image', { image: { id: 'mid.1', mime_type: 'image/jpeg' } }, true],
    ['video', { video: { id: 'mid.2', mime_type: 'video/mp4' } }, true],
    ['sticker', { sticker: { id: 'mid.3', mime_type: 'image/webp' } }, true],
    ['document', { document: { id: 'mid.4', mime_type: 'application/pdf' } }, true],
    ['location', { location: { latitude: 38.34, longitude: -0.48 } }, false],
    ['contacts', { contacts: [{ name: { formatted_name: 'Ana' } }] }, false],
];

for (const [tipo, extra, esperaMedia] of TIPOS) {
    test(`buildInboundAdapters conserva el tipo real de ${tipo}`, () => {
        const message = adapt({ from: '34600111222', id: `wamid.${tipo}`, type: tipo, ...extra });
        assert.strictEqual(message.type, tipo, `${tipo} no debe disfrazarse de 'chat'`);
        assert.strictEqual(message.hasMedia, esperaMedia);
        assert.strictEqual(message.body, '');
    });

    test(`${tipo} entrante siempre produce una respuesta no vacía`, () => {
        const message = adapt({ from: '34600111222', id: `wamid.${tipo}`, type: tipo, ...extra });
        // Reproduce la decisión de bot.js: sin texto → clasificar y responder.
        const kind = classifyIncomingMedia(message);
        const reply = unsupportedMediaMsg(kind, null);
        assert.ok(reply && reply.trim().length > 0, `${tipo} debe tener respuesta`);
    });
}

test('el audio se sigue marcando como ptt + hasMedia (se transcribe, no se rechaza)', () => {
    const message = adapt({ from: '34600111222', id: 'wamid.a', type: 'audio', audio: { id: 'mid.9', mime_type: 'audio/ogg' } });
    assert.strictEqual(message.type, 'ptt');
    assert.strictEqual(message.hasMedia, true);
});

// ─── 2. El caption ES el mensaje de la clienta ────────────────────────────────
test('el caption de una foto llega como body (caso "quiero esto")', () => {
    const message = adapt({
        from: '34600111222', id: 'wamid.cap', type: 'image',
        image: { id: 'mid.1', mime_type: 'image/jpeg', caption: 'quiero esto' },
    });
    assert.strictEqual(message.body, 'quiero esto');
    // Con texto utilizable el mensaje NO cae en la rama de media no soportada: sigue al pipeline.
    assert.ok(message.body.trim().length > 0);
});

test('también se recuperan los captions de vídeo y documento', () => {
    const video = adapt({ from: '34600111222', id: 'wamid.v', type: 'video', video: { id: 'm', caption: 'mira este corte' } });
    assert.strictEqual(video.body, 'mira este corte');
    const doc = adapt({ from: '34600111222', id: 'wamid.d', type: 'document', document: { id: 'm', caption: 'mi presupuesto' } });
    assert.strictEqual(doc.body, 'mi presupuesto');
});

// ─── 3. El texto normal no se toca (regresión del flujo principal) ────────────
test('un mensaje de texto sigue siendo chat/sin media/con su body', () => {
    const message = adapt({ from: '34600111222', id: 'wamid.t', type: 'text', text: { body: 'Hola, quiero cita' } });
    assert.strictEqual(message.type, 'chat');
    assert.strictEqual(message.hasMedia, false);
    assert.strictEqual(message.body, 'Hola, quiero cita');
});

test('un payload sin type explícito se trata como texto', () => {
    const message = adapt({ from: '34600111222', id: 'wamid.n', text: { body: 'hola' } });
    assert.strictEqual(message.type, 'chat');
    assert.strictEqual(message.hasMedia, false);
});

// ─── 4. classifyIncomingMedia normaliza las dos superficies ───────────────────
test('clasifica los tipos de whatsapp-web.js igual que los de Cloud API', () => {
    assert.strictEqual(classifyIncomingMedia({ type: 'ptt', hasMedia: true }), 'audio');
    assert.strictEqual(classifyIncomingMedia({ type: 'audio', hasMedia: true }), 'audio');
    assert.strictEqual(classifyIncomingMedia({ type: 'image', hasMedia: true }), 'image');
    assert.strictEqual(classifyIncomingMedia({ type: 'sticker', hasMedia: true }), 'sticker');
    assert.strictEqual(classifyIncomingMedia({ type: 'vcard', hasMedia: false }), 'contacts');
    assert.strictEqual(classifyIncomingMedia({ type: 'location', hasMedia: false }), 'location');
});

test('un tipo desconocido CON adjunto cae en unknown y aun así tiene respuesta', () => {
    const kind = classifyIncomingMedia({ type: 'poll_creation', hasMedia: true });
    assert.strictEqual(kind, 'unknown');
    assert.ok(unsupportedMediaMsg(kind, null).trim().length > 0);
});

// Los eventos de sistema no los escribe la clienta: contestarlos sería spam.
test('los eventos de sistema se clasifican como system y no llevan respuesta', () => {
    const sistemas = ['e2e_notification', 'ciphertext', 'call_log', 'revoked', 'gp2', 'notification_template'];
    for (const type of sistemas) {
        assert.strictEqual(classifyIncomingMedia({ type, hasMedia: false }), 'system', `${type} debería ser system`);
    }
    // Un tipo desconocido SIN adjunto también: casi siempre es un evento, no un mensaje.
    assert.strictEqual(classifyIncomingMedia({ type: 'algo_nuevo', hasMedia: false }), 'system');
    for (const lang of ['es', 'en', 'ru', 'uk', null]) {
        assert.strictEqual(unsupportedMediaMsg('system', lang), '', 'system no debe generar texto');
    }
});

// ─── 5. unsupportedMediaMsg: multiidioma con fallback a español ───────────────
test('hay texto para los 4 idiomas en todos los kinds', () => {
    const kinds = ['image', 'video', 'sticker', 'document', 'location', 'contacts', 'unknown'];
    for (const kind of kinds) {
        for (const lang of ['es', 'en', 'ru', 'uk']) {
            const msg = unsupportedMediaMsg(kind, lang);
            assert.ok(msg && msg.trim().length > 0, `${kind}/${lang} sin texto`);
            assert.ok(msg.length <= 1000, `${kind}/${lang} demasiado largo`);
            assert.ok(!/\*\*/.test(msg), `${kind}/${lang} con markdown (WhatsApp no lo renderiza)`);
        }
    }
});

test('un idioma desconocido o nulo cae a español', () => {
    const es = unsupportedMediaMsg('image', 'es');
    assert.strictEqual(unsupportedMediaMsg('image', null), es);
    assert.strictEqual(unsupportedMediaMsg('image', 'fr'), es);
});

test('la foto pide descripción en texto; el ruso no devuelve el literal español', () => {
    assert.match(unsupportedMediaMsg('image', 'es'), /No puedo ver fotos/);
    assert.notStrictEqual(unsupportedMediaMsg('image', 'ru'), unsupportedMediaMsg('image', 'es'));
    // El vídeo comparte el mensaje del "no puedo ver".
    assert.strictEqual(unsupportedMediaMsg('video', 'en'), unsupportedMediaMsg('image', 'en'));
});

// ─── Runner secuencial (soporta tests sync y async) ───────────────────────────
(async () => {
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
    }
})();
