/**
 * tests/lib/convo.js — Arnés de conversación compartido para los tests de Sante.
 *
 * Extraído de tests/sante-llm-flows.js para poder reutilizarlo desde
 * tests/verify-sante-robustez.js sin duplicarlo. Conduce conversaciones reales contra
 * `bot.handleIncomingMessage` con un cliente WhatsApp simulado: no toca Puppeteer ni la
 * red de WhatsApp, pero sí la sesión, la BD y (si el escenario lo pide) el LLM.
 *
 * Añadidos respecto del original, para la prueba en seco adversarial:
 *   - `makeMessage(from, text, overrides)`: permite inyectar formas de mensaje arbitrarias
 *     (imagen, sticker, ubicación, audio) sin reescribir el constructor.
 *   - `Convo.sendRaw(message)`: envía un mensaje ya construido (media, cuerpo vacío…).
 *   - `Convo.sendBurst(texts, gapMs)`: ráfaga de mensajes separados N ms, para reproducir
 *     el caso real de dos mensajes fuera de la ventana de buffer de 5 s.
 */
const assert = require('assert');
const bot = require('../../bot');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Un "Un momento…" no es una respuesta final: el bot sigue trabajando detrás.
function isWaitMsg(t) {
    return /^(un momento|one moment|минутку|хвилинку)/i.test((t || '').trim());
}

function makeClient(sink) {
    return {
        sendMessage: async (_phone, text) => { sink.push({ text, t: Date.now() }); },
        getChatById: async () => ({ sendStateTyping: async () => {} }),
    };
}

let msgCounter = 0;
// El id por defecto tiene forma de wamid porque Sante —la org que conducen estos tests—
// recibe por Cloud API (360dialog), y el guard de canal de handleIncomingMessage descarta
// lo que llegue con id de whatsapp-web.js para una org migrada. Un test que necesite
// simular el otro canal puede pasar `id` en `overrides`.
function makeMessage(from, text, overrides = {}) {
    return {
        from,
        body: text,
        id: { _serialized: `wamid.T${Date.now()}_${msgCounter++}` },
        fromMe: false,
        timestamp: Date.now(),
        isStatus: false,
        isBroadcast: false,
        hasMedia: false,
        type: 'chat',
        getChat: async () => ({ sendStateTyping: async () => {} }),
        ...overrides,
    };
}

class Convo {
    constructor(phone, orgId) {
        if (!orgId) throw new Error('Convo requiere orgId');
        this.orgId = orgId;
        this.phone = phone.includes('@c.us') ? phone : `${phone}@c.us`;
        this.sink = [];
        this.client = makeClient(this.sink);
        this.allBotMsgs = [];
    }

    // Espera a que el bot deje de escribir: al menos una respuesta, `quiet` ms de silencio,
    // y que la última no sea un mensaje de espera. Devuelve solo lo nuevo desde `before`.
    async _waitForReply(before, { timeout, quiet }) {
        const deadline = Date.now() + timeout;
        let lastLen = this.sink.length;
        let lastChange = Date.now();
        while (Date.now() < deadline) {
            await sleep(300);
            if (this.sink.length !== lastLen) { lastLen = this.sink.length; lastChange = Date.now(); }
            const got = this.sink.slice(before).map(m => m.text);
            const lastIsWait = got.length && isWaitMsg(got[got.length - 1]);
            if (got.length > 0 && (Date.now() - lastChange) > quiet && !lastIsWait) break;
        }
        const newMsgs = this.sink.slice(before).map(m => m.text);
        this.allBotMsgs.push(...newMsgs);
        return newMsgs;
    }

    // Envía texto y espera la respuesta. Fuerza el flush del buffer para no pagar los 5 s
    // de debounce en cada turno.
    async send(text, { timeout = 90000, quiet = 3000 } = {}) {
        const before = this.sink.length;
        await bot.handleIncomingMessage(this.client, makeMessage(this.phone, text), this.orgId);
        await bot._internals.flushBuffer(this.orgId, this.phone);
        return this._waitForReply(before, { timeout, quiet });
    }

    // Inyecta un mensaje ya construido (imagen, sticker, ubicación, cuerpo vacío…).
    // `graceMs` es el margen que damos para detectar SILENCIO: si el bot no contesta,
    // no hay nada por lo que esperar el timeout completo.
    async sendRaw(overrides, { graceMs = 4000 } = {}) {
        const before = this.sink.length;
        const msg = makeMessage(this.phone, overrides.body ?? '', overrides);
        await bot.handleIncomingMessage(this.client, msg, this.orgId);
        await bot._internals.flushBuffer(this.orgId, this.phone).catch(() => {});
        await sleep(graceMs);
        const newMsgs = this.sink.slice(before).map(m => m.text);
        this.allBotMsgs.push(...newMsgs);
        return newMsgs;
    }

    // Ráfaga: varios mensajes separados `gapMs`, SIN forzar flush — así se ejercita el
    // buffer real de 5 s y su cola `pendingTexts`. Devuelve las respuestas por tanda.
    async sendBurst(texts, { gapMs = 7000, quiet = 3000, timeout = 90000 } = {}) {
        const before = this.sink.length;
        for (let i = 0; i < texts.length; i++) {
            await bot.handleIncomingMessage(this.client, makeMessage(this.phone, texts[i]), this.orgId);
            if (i < texts.length - 1) await sleep(gapMs);
        }
        return this._waitForReply(before, { timeout, quiet });
    }

    lastText() { return this.allBotMsgs[this.allBotMsgs.length - 1] || ''; }
    fullText() { return this.allBotMsgs.join('\n'); }
}

// Calidad de mensaje de cara a la clienta: sin markdown (WhatsApp no lo renderiza) y
// dentro del límite de longitud.
function assertQuality(msgs, label) {
    for (const m of msgs) {
        assert(!/[*_]{1,2}\S/.test(m) && !/\*\*/.test(m), `${label}: mensaje con markdown → "${m.slice(0, 60)}"`);
        assert(m.length <= 1000, `${label}: mensaje > 1000 chars (${m.length})`);
    }
}

module.exports = { Convo, makeClient, makeMessage, sleep, isWaitMsg, assertQuality };
