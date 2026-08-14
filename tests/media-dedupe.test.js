// Una foto reentregada por el webhook NO se contesta dos veces (H5, nocturno 14/08).
//
// El 13/08/2026 (34673441352) llegaron 2 fotos y salieron 3 «No puedo ver fotos ni
// vídeos» en 400 ms: la rama de media hace `return` antes del buffer, así que ni
// `buffer.seenKeys` ni el dedupe de sesión (inexistente en el primer mensaje de una
// conversación) veían una redelivery de Cloud API con el mismo wamid — mientras el INSERT
// duplicado moría en silencio en el UNIQUE de wa_message_id (por eso 3 avisos y solo 2
// filas). El guard nuevo: `mediaMessageDedupe` por wamid, ANTES de contestar.
//
// Se conduce el handleIncomingMessage REAL con db/telegram stubeados (la media no llama
// al LLM: la rama devuelve antes del buffer). Visto fallar sin el arreglo (sabotaje con
// cp previo): sin el guard, el mismo wamid produce dos avisos y el bloque 1 sale en rojo.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');
const { SANTE_ORG_ID } = require('../services/org-registry');

// ─── Stubs ANTES de requerir bot ─────────────────────────────────────────────
const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/supabase', {});

// db entero como Proxy: cualquier función que el flujo toque existe y devuelve null,
// y las que interesan al test capturan. Así un rename en bot.js no rompe el stub por
// omisión — solo hay que mantener las DOS capturas.
const guardados = [];
const dbImpls = {
    saveMessage: async (orgId, msg) => { guardados.push({ orgId, ...msg }); return 1; },
    findByPhone: async () => null,
};
stub('../services/db', new Proxy(dbImpls, {
    get: (target, prop) => target[prop] ?? (async () => null),
}));
stub('../services/telegram', {
    notifyBizumPending: async () => {}, notifyEscalation: async () => {},
    notifyBlacklistAlert: async () => {}, startTelegramBot: () => {},
});

const bot = require('../bot');

function makeClient(sink) {
    return {
        sendMessage: async (_phone, text) => { sink.push(text); return { id: { _serialized: `wamid.OUT${sink.length}` } }; },
        getChatById: async () => ({ sendStateTyping: async () => {} }),
    };
}

const PHONE = '34699000777@c.us';

function imageMessage(wamid) {
    return {
        from: PHONE,
        body: '',
        id: { _serialized: wamid },
        fromMe: false,
        timestamp: Date.now(),
        isStatus: false,
        isBroadcast: false,
        hasMedia: false,        // Cloud API: el media no viaja como hasMedia de wwebjs
        type: 'image',
        getChat: async () => ({ sendStateTyping: async () => {} }),
        getContact: async () => ({ number: PHONE.replace('@c.us', '') }),
    };
}

test('el mismo wamid dos veces → UN solo aviso (la redelivery se ignora y se loguea)', async () => {
    const sink = [];
    const client = makeClient(sink);
    const msg = imageMessage('wamid.MEDIA_DUP_1');

    await bot.handleIncomingMessage(client, msg, SANTE_ORG_ID);
    assert.strictEqual(sink.length, 1, 'la primera entrega se contesta');
    assert.ok(/no puedo ver fotos/i.test(sink[0]), 'y es el aviso de media');

    await bot.handleIncomingMessage(client, imageMessage('wamid.MEDIA_DUP_1'), SANTE_ORG_ID);
    assert.strictEqual(sink.length, 1,
        'la redelivery del MISMO wamid no puede volver a contestar: es el 3er aviso del 13/08');
});

test('dos fotos DISTINTAS siguen recibiendo su aviso cada una (el guard no agrupa, dedupe)', async () => {
    const sink = [];
    const client = makeClient(sink);
    await bot.handleIncomingMessage(client, imageMessage('wamid.MEDIA_A'), SANTE_ORG_ID);
    await bot.handleIncomingMessage(client, imageMessage('wamid.MEDIA_B'), SANTE_ORG_ID);
    assert.strictEqual(sink.length, 2,
        'wamids distintos son mensajes distintos: el guard solo para la reentrega, no cambia la conducta por foto');
});

test('la fila [image] del panel se guarda UNA vez por wamid', async () => {
    guardados.length = 0;
    const sink = [];
    const client = makeClient(sink);
    await bot.handleIncomingMessage(client, imageMessage('wamid.MEDIA_ROW'), SANTE_ORG_ID);
    await bot.handleIncomingMessage(client, imageMessage('wamid.MEDIA_ROW'), SANTE_ORG_ID);
    const filasImagen = guardados.filter(g => g.contenido === '[image]');
    assert.strictEqual(filasImagen.length, 1,
        'antes esto lo salvaba el UNIQUE de la tabla, en silencio; ahora ni se intenta');
});
