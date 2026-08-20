// Una foto que llega a una conversación que lleva una PERSONA no se contesta sola.
//
// `handleIncomingMessage` responde a los media y hace `return` ANTES de processMessageCore,
// así que se salta las dos guardas que viven allí dentro: la de lista negra (bot.js:4903) y
// la de `botActivo` (bot.js:4996), que es la que honra el `bot_mode='manual'` que escribe el
// panel al tomar el control. La primera se tapó el 13/08/2026; la segunda seguía abierta.
//
// Medido en producción del 14 al 20/08/2026: las TRES fotos que llegaron esa semana a una
// conversación en manual recibieron respuesta automática — 3 de 3. La peor, el 20/08 a las
// 13:28: tres minutos antes el bot había dicho «Le paso tu mensaje a nuestro equipo». Y lo
// que sale encima es el mensaje que pide un servicio («¿Me describes con palabras qué te
// quieres hacer? Así te busco hueco»), en mitad de algo que está atendiendo una persona.
//
// Lo que se afirma aquí es la CONDUCTA de las dos ramas que contestan antes de la guarda
// (la foto y el audio intranscribible), sus dos controles, y las dos cosas que NO cambian
// cuando se calla: la fila del panel se escribe igual, y San Remo se queda como estaba.
//
// Visto fallar sin el arreglo (cp previo, 20/08/2026): devolver `motivoParaNoContestarMedia`
// a la versión que solo miraba `is_blacklisted` deja en rojo 2 bloques — la foto y el audio.
// Los otros seis son CONTROLES y pasan con y sin el arreglo a propósito: están para que el
// arreglo no se pase de largo (callar en auto, callar a una desconocida, callar cuando la
// lectura falla, o llevarse por delante la lista negra y a San Remo).
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');
const { SANTE_ORG_ID, SANREMO_ORG_ID } = require('../services/org-registry');

// ─── Stubs ANTES de requerir bot (mismo patrón que media-dedupe) ─────────────
const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/supabase', {});

const guardados = [];
let ficha = null;               // lo que devuelve findByPhone
let lecturaFichaLanza = null;   // para probar el fallo de lectura
const dbImpls = {
    saveMessage: async (orgId, msg) => { guardados.push({ orgId, ...msg }); return 1; },
    findByPhone: async () => {
        if (lecturaFichaLanza) throw new Error(lecturaFichaLanza);
        return ficha;
    },
};
stub('../services/db', new Proxy(dbImpls, {
    get: (target, prop) => target[prop] ?? (async () => null),
}));
stub('../services/telegram', {
    notifyBizumPending: async () => {}, notifyEscalation: async () => {},
    notifyBlacklistAlert: async () => {}, startTelegramBot: () => {},
});
stub('../services/transcription', { transcribeAudio: async () => { throw new Error('audio ilegible'); } });

const bot = require('../bot');

function makeClient(sink) {
    return {
        sendMessage: async (_phone, text) => { sink.push(text); return { id: { _serialized: `wamid.OUT${sink.length}` } }; },
        getChatById: async () => ({ sendStateTyping: async () => {} }),
    };
}

// Cada bloque usa su propio teléfono: el dedupe de media es por wamid, pero las sesiones y
// los buffers viven en Maps de módulo y un teléfono repetido arrastraría estado del anterior.
let n = 0;
const nuevoTelefono = () => `3469900${String(++n).padStart(4, '0')}@c.us`;

function mensajeMedia(phone, wamid, tipo = 'image') {
    return {
        from: phone,
        body: '',
        id: { _serialized: wamid },
        fromMe: false,
        timestamp: Date.now(),
        isStatus: false,
        isBroadcast: false,
        hasMedia: tipo !== 'image',
        type: tipo,
        downloadMedia: async () => ({ data: 'xxx', mimetype: 'audio/ogg' }),
        getChat: async () => ({ sendStateTyping: async () => {} }),
        getContact: async () => ({ number: phone.replace('@c.us', '') }),
    };
}

function reset() {
    guardados.length = 0;
    ficha = null;
    lecturaFichaLanza = null;
}

// ─── 1 · La foto, que es el caso medido ──────────────────────────────────────

test('con bot_mode=manual la foto NO se contesta — y la fila del panel se escribe igual', async () => {
    reset();
    ficha = { id: 'c-1', bot_mode: 'manual', is_blacklisted: false };
    const sink = [];
    const phone = nuevoTelefono();
    await bot.handleIncomingMessage(makeClient(sink), mensajeMedia(phone, 'wamid.MAN_1'), SANTE_ORG_ID);

    assert.strictEqual(sink.length, 0,
        `el bot contestó a una foto en una conversación que lleva una persona: ${JSON.stringify(sink)}`);
    // La fila SÍ: es lo que le dice a quien está atendiendo que la clienta ha mandado algo.
    assert.ok(guardados.some(g => g.contenido === '[image]'),
        'callarse no puede significar esconder la foto del panel');
});

test('CONTROL en auto: la misma foto sí recibe su aviso', async () => {
    reset();
    ficha = { id: 'c-2', bot_mode: 'auto', is_blacklisted: false };
    const sink = [];
    const phone = nuevoTelefono();
    await bot.handleIncomingMessage(makeClient(sink), mensajeMedia(phone, 'wamid.AUTO_1'), SANTE_ORG_ID);

    assert.strictEqual(sink.length, 1, 'en auto la clienta tiene que recibir respuesta');
    assert.ok(/no puedo ver fotos/i.test(sink[0]), `esperado el aviso de media, salió: ${sink[0]}`);
});

test('sin ficha (primera foto de una desconocida) se contesta: no se calla por sospecha', async () => {
    reset();
    ficha = null;
    const sink = [];
    const phone = nuevoTelefono();
    await bot.handleIncomingMessage(makeClient(sink), mensajeMedia(phone, 'wamid.NUEVA_1'), SANTE_ORG_ID);
    assert.strictEqual(sink.length, 1, 'una desconocida no está en manual: silenciarla sería el bug contrario');
});

test('si la lectura de la ficha falla, se contesta — igual que hacía con la lista negra', async () => {
    reset();
    lecturaFichaLanza = 'supabase caída';
    const sink = [];
    const phone = nuevoTelefono();
    await bot.handleIncomingMessage(makeClient(sink), mensajeMedia(phone, 'wamid.FALLO_1'), SANTE_ORG_ID);
    assert.strictEqual(sink.length, 1,
        'sin lectura no se silencia a nadie por sospecha: es el comportamiento que ya tenía este camino');
});

// ─── 2 · La lista negra, que ya estaba, no se ha perdido por el camino ───────

test('la lista negra sigue callando la foto (la mitad que ya estaba tapada)', async () => {
    reset();
    ficha = { id: 'c-3', bot_mode: 'auto', is_blacklisted: true };
    const sink = [];
    const phone = nuevoTelefono();
    await bot.handleIncomingMessage(makeClient(sink), mensajeMedia(phone, 'wamid.BL_1'), SANTE_ORG_ID);
    assert.strictEqual(sink.length, 0, 'un contacto bloqueado no vuelve a hablar con el bot por la puerta del media');
    assert.ok(guardados.some(g => g.contenido === '[image]'), 'y su rastro también se guarda');
});

// ─── 3 · El audio intranscribible: la MISMA rama, el MISMO agujero ───────────

test('el aviso de audio ilegible también respeta el manual', async () => {
    // Es la otra rama que contesta antes de la guarda. Se arregla en el mismo sitio porque
    // es el mismo fallo: si una se saltó la guarda, la de al lado también.
    reset();
    ficha = { id: 'c-4', bot_mode: 'manual', is_blacklisted: false };
    const sink = [];
    const phone = nuevoTelefono();
    await bot.handleIncomingMessage(makeClient(sink), mensajeMedia(phone, 'wamid.AUD_1', 'ptt'), SANTE_ORG_ID);
    assert.strictEqual(sink.length, 0, `contestó a un audio con la conversación en manual: ${JSON.stringify(sink)}`);
});

test('CONTROL en auto: el audio ilegible sí recibe su aviso', async () => {
    reset();
    ficha = { id: 'c-5', bot_mode: 'auto', is_blacklisted: false };
    const sink = [];
    const phone = nuevoTelefono();
    await bot.handleIncomingMessage(makeClient(sink), mensajeMedia(phone, 'wamid.AUD_2', 'ptt'), SANTE_ORG_ID);
    assert.strictEqual(sink.length, 1, 'en auto hay que decirle que no se pudo oír el audio');
    assert.ok(/audio/i.test(sink[0]), `esperado el aviso de audio, salió: ${sink[0]}`);
});

// ─── 4 · Regla de oro ────────────────────────────────────────────────────────

test('SAN REMO no cambia: su respuesta a un media sale igual con bot_mode=manual', async () => {
    // La guarda va gateada por tipo de org, exactamente como se hizo con la lista negra el
    // 13/08. San Remo conserva su agujero A SABIENDAS: cambiarlo es cambiar su conducta
    // observable, y eso es una decisión del dueño, no un efecto lateral de este arreglo.
    reset();
    ficha = { id: 'c-6', bot_mode: 'manual', is_blacklisted: false };
    const sink = [];
    const phone = nuevoTelefono();
    // 'document' y no 'image' porque la rama de San Remo cuelga de `hasMedia`, que es como
    // llega el media por whatsapp-web.js (su canal); en Cloud API no viaja así.
    await bot.handleIncomingMessage(makeClient(sink), mensajeMedia(phone, 'false_34600@c.us_SR1', 'document'), SANREMO_ORG_ID);
    assert.strictEqual(sink.length, 1, 'San Remo sigue contestando byte por byte como siempre');
    assert.ok(/solo proceso texto y audios/i.test(sink[0]), `su literal de siempre, salió: ${sink[0]}`);
});
