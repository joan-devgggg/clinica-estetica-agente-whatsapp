/**
 * tests/canal-caido-aviso.test.js — "No sale NADA por WhatsApp y nadie se entera".
 *
 * El 1 y el 2 de agosto de 2026, 360dialog bloqueó los envíos de Sante: entraban mensajes,
 * no salía ni uno, y no se supo hasta horas después. Cada pieza hizo lo suyo bien — el
 * worker reintentaba, la campaña marcaba 'failed', el panel devolvía 503 — y nadie sumaba.
 *
 * Aquí se prueban las dos mitades:
 *   1. La política (channel-health): qué cuenta como canal caído y qué no.
 *   2. El incidente real de punta a punta, conducido por el `waSendMessage` de bot.js con un
 *      cliente falso que devuelve 403 — la vía por la que salen las respuestas del bot, que
 *      es exactamente donde se manifestó y la que más tarde en notarse si se deja fuera.
 *
 * Sin red y sin Supabase.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const assert = require('assert');
const { test } = require('node:test');

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const OTRA_ORG = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── Telegram interceptado en su frontera real (notifyOrgAdmin) ──────────────
const avisos = [];
let entrega = true; // ¿acepta Telegram?
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        notifyOrgAdmin: async (orgId, mensaje) => { avisos.push({ orgId, mensaje }); return entrega; },
        startTelegramBot: () => {}, notifyEscalation: async () => {},
        notifyBlacklistAlert: async () => {}, notifyBizumPending: async () => {},
        notifyVipSuggestion: async () => {},
    },
};

const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

const { noteSendResult, classifyChannelError, FALLOS_PARA_AVISAR, _reset } = require('../services/channel-health');
const { _resetThrottle } = require('../services/admin-alerts');

function limpiar() {
    avisos.length = 0;
    logs.length = 0;
    entrega = true;
    _reset();
    _resetThrottle();
}

const err = m => new Error(m);
const BLOQUEO_360 = () => err('360dialog send 403: {"error":{"message":"account blocked"}}');
const FUERA_DE_VENTANA = () => err('360dialog send 400: {"error":{"code":131047,"message":"Re-engagement message"}}');

const fallar = async (e, veces) => { for (let i = 0; i < veces; i++) await noteSendResult(ORG, { ok: false, error: e() }); };

// ─── 1. Clasificación: de quién es la culpa ──────────────────────────────────

test('clasificación: plataforma vs destinatario', () => {
    // Plataforma: la clave revocada, el límite, Meta caída, puppeteer muerto.
    assert.strictEqual(classifyChannelError(BLOQUEO_360()).tipo, 'plataforma');
    assert.strictEqual(classifyChannelError(err('360dialog send 401: unauthorized')).tipo, 'plataforma');
    assert.strictEqual(classifyChannelError(err('360dialog send 503: upstream')).tipo, 'plataforma');
    assert.strictEqual(classifyChannelError(err('Protocol error: detached Frame')).tipo, 'plataforma');
    assert.strictEqual(classifyChannelError(err('WhatsApp is not connected')).tipo, 'plataforma');

    // Destinatario: no dicen nada del canal.
    assert.strictEqual(classifyChannelError(FUERA_DE_VENTANA()).tipo, 'destinatario');
    assert.strictEqual(classifyChannelError(err('360dialog send 400: {"code":132000}')).tipo, 'destinatario');

    // El código de Meta manda sobre el HTTP: un 400 con 131047 no es canal caído.
    assert.strictEqual(classifyChannelError(err('360dialog send 400: nada conocido')).tipo, 'destinatario');
    assert.strictEqual(classifyChannelError(null), null);
});

// ─── 2. El umbral ────────────────────────────────────────────────────────────

test('dos fallos no avisan; el tercero sí; el cuarto no repite', async () => {
    limpiar();
    assert.strictEqual(FALLOS_PARA_AVISAR, 3);

    await fallar(BLOQUEO_360, 2);
    assert.strictEqual(avisos.length, 0, 'dos fallos pueden ser un pico');

    await fallar(BLOQUEO_360, 1);
    assert.strictEqual(avisos.length, 1, 'al tercero se avisa');
    assert.ok(/no está enviando/i.test(avisos[0].mensaje));
    assert.ok(avisos[0].mensaje.includes('http_403'));

    await fallar(BLOQUEO_360, 5);
    assert.strictEqual(avisos.length, 1, 'no se repite mientras dure');
});

test('un éxito por medio reinicia la cuenta', async () => {
    limpiar();
    await fallar(BLOQUEO_360, 2);
    await noteSendResult(ORG, { ok: true });
    await fallar(BLOQUEO_360, 2);
    assert.strictEqual(avisos.length, 0, '2 + 2 con un éxito en medio no son 3 seguidos');
});

test('tres fallos por motivos DISTINTOS no son un canal caído', async () => {
    limpiar();
    await noteSendResult(ORG, { ok: false, error: err('360dialog send 403: x') });
    await noteSendResult(ORG, { ok: false, error: err('360dialog send 500: y') });
    await noteSendResult(ORG, { ok: false, error: err('Protocol error: target closed') });
    assert.strictEqual(avisos.length, 0);
});

// ─── 3. Falsos positivos de campaña ──────────────────────────────────────────

test('una campaña entera fuera de ventana NO avisa nunca', async () => {
    limpiar();
    await fallar(FUERA_DE_VENTANA, 10);
    assert.strictEqual(avisos.length, 0,
        'con esto en la cuenta, el aviso saltaría en cada envío masivo hasta que nadie lo leyera');
});

test('los fallos de destinatario tampoco rompen una racha de plataforma', async () => {
    limpiar();
    await fallar(BLOQUEO_360, 2);
    await fallar(FUERA_DE_VENTANA, 3);   // ni suma ni resta
    await fallar(BLOQUEO_360, 1);
    assert.strictEqual(avisos.length, 1, 'el canal seguía caído entre medias');
});

// ─── 4. Recuperación ─────────────────────────────────────────────────────────

test('al volver el canal se avisa, y un corte posterior vuelve a avisar', async () => {
    limpiar();
    await fallar(BLOQUEO_360, 3);
    assert.strictEqual(avisos.length, 1);

    await noteSendResult(ORG, { ok: true });
    assert.strictEqual(avisos.length, 2);
    assert.ok(/vuelve a enviar/i.test(avisos[1].mensaje));

    // Y la clave quedó libre: el siguiente corte igual no se queda callado por el throttle.
    await fallar(BLOQUEO_360, 3);
    assert.strictEqual(avisos.length, 3);
});

test('sin aviso previo, un éxito no manda "recuperado"', async () => {
    limpiar();
    await noteSendResult(ORG, { ok: true });
    await fallar(BLOQUEO_360, 2);
    await noteSendResult(ORG, { ok: true });
    assert.strictEqual(avisos.length, 0);
});

// ─── 5. Aislamiento entre organizaciones ─────────────────────────────────────

test('la cuenta es por organización', async () => {
    limpiar();
    await fallar(BLOQUEO_360, 2);
    await noteSendResult(OTRA_ORG, { ok: false, error: BLOQUEO_360() });
    assert.strictEqual(avisos.length, 0, 'el fallo de otra org no completa la racha de esta');
});

// ─── 6. El aviso que no se entrega no se da por dado (hereda del paso 1) ─────

test('si Telegram no acepta el aviso, se reintenta al siguiente fallo', async () => {
    limpiar();
    entrega = false;
    await fallar(BLOQUEO_360, 3);
    assert.strictEqual(avisos.length, 1, 'se intentó');

    entrega = true;
    await fallar(BLOQUEO_360, 1);
    assert.strictEqual(avisos.length, 2, 'y se reintenta, porque el primero no llegó');
});

// ─── 7. Observar no puede romper el envío ────────────────────────────────────

test('un fallo interno del observador no propaga', async () => {
    limpiar();
    await noteSendResult(ORG, { ok: false, error: { get message() { throw new Error('boom'); } } });
    await noteSendResult(null, { ok: true });
    // Si algo hubiera propagado, no llegaríamos aquí.
    assert.ok(true);
});

// ─── 8. El incidente del 1-2/08 de punta a punta, por waSendMessage ──────────

test('tres respuestas del bot contra un 360 bloqueado → aviso', async () => {
    limpiar();

    // bot.js carga db/supabase al requerirse: se stubea el cliente de Supabase, no db.js.
    const supabasePath = require.resolve('../services/supabase');
    require.cache[supabasePath] = {
        id: supabasePath, filename: supabasePath, loaded: true,
        exports: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
    };
    const { waSendMessage } = require('../bot');

    // Cliente 360 falso: la cuenta bloqueada, igual que aquellos días.
    const client360 = {
        async getChatById() { return { sendStateTyping: async () => {} }; },
        async sendMessage() { throw BLOQUEO_360(); },
    };

    for (let i = 0; i < 3; i++) {
        await assert.rejects(
            () => waSendMessage(client360, '34600111222@c.us', 'Hola 😊', { orgId: ORG, retries: 0 }),
            /403/,
        );
    }

    assert.strictEqual(avisos.length, 1, 'el aviso tiene que salir por la vía conversacional');
    assert.ok(avisos[0].mensaje.includes('http_403'));
    assert.strictEqual(avisos[0].orgId, ORG);
});

test('waSendMessage cuenta UN envío lógico, no un reintento por vuelta', async () => {
    limpiar();
    const { waSendMessage } = require('../bot');

    // Error transitorio de puppeteer: waSendMessage reintenta 3 veces dentro del mismo envío.
    const clientRoto = {
        async getChatById() { return { sendStateTyping: async () => {} }; },
        async sendMessage() { throw err('Protocol error: detached Frame'); },
    };

    await assert.rejects(
        () => waSendMessage(clientRoto, '34600111222@c.us', 'Hola', { orgId: ORG, retries: 3, baseDelayMs: 1 }),
    );

    const conteos = logs.filter(l => l.evento === 'envio_fallido_plataforma');
    assert.strictEqual(conteos.length, 1, 'cuatro intentos son UN envío fallido, no cuatro');
    assert.strictEqual(avisos.length, 0, 'y por tanto no dispara el aviso él solo');
});
