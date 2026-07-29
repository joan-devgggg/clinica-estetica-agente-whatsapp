/**
 * tests/inbound-media-engine.test.js — El bot NO se calla ante un mensaje que no es texto.
 *
 * Bug arreglado (GAP A5 de la auditoría de robustez): el adaptador de Cloud API marcaba
 * `hasMedia: false` y `type: 'chat'` para todo lo que no fuera audio, así que una foto llegaba
 * a `if (!userText) { if (message.hasMedia) {...} return; }` con AMBOS falsos → return sin
 * respuesta, sin log y sin fila en `messages`. La clienta mandaba una foto de un corte y el bot
 * no contestaba nada.
 *
 * Este test conduce el MOTOR REAL (bot.handleIncomingMessage: sesión real, guard real, envío
 * real) con mensajes construidos por el adaptador REAL de 360dialog, y afirma sobre el efecto:
 * hubo respuesta, en el idioma de la clienta, y quedó rastro en el panel.
 *
 * Cubre también la regla de oro: San Remo conserva su literal EXACTO de siempre.
 *
 * Hermético: solo se interceptan los bordes — Supabase, Telegram, logger y LLM. Sin red.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';
process.env.SANTE_360_API_KEY = process.env.SANTE_360_API_KEY || 'test-key-360';
process.env.SANTE_360_PHONE_NUMBER_ID = process.env.SANTE_360_PHONE_NUMBER_ID || '111222333';

const assert = require('assert');

const SANTE_ORG   = process.env.SANTE_ORG_ID   || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const SANREMO_ORG = process.env.SANREMO_ORG_ID || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// El literal histórico de San Remo. Si alguien lo cambia, este test lo caza.
const LITERAL_SANREMO = 'Gracias por tu mensaje 😊 Solo proceso texto y audios. Si tienes alguna duda, escríbeme.';

// ─── 1. Mock de Supabase (mismo patrón que message-cap-escalation.test.js) ───────────
// Se inyecta en require.cache ANTES de requerir db.js/bot.js, así corre el db.js REAL encima
// y las aserciones son sobre la sentencia de verdad.
const sqlCalls = [];

function makeBuilder() {
    const state = { table: null, op: 'select', payload: null, filters: [], single: false };
    const resolve = () => { sqlCalls.push(state); return Promise.resolve(respond(state)); };
    const b = {
        from(t) { state.table = t; return b; },
        select() { return b; },
        insert(p) { state.op = 'insert'; state.payload = p; return b; },
        upsert(p) { state.op = 'upsert'; state.payload = p; return b; },
        update(p) { state.op = 'update'; state.payload = p; return b; },
        delete() { state.op = 'delete'; return b; },
        eq(k, v) { state.filters.push(['eq', k, v]); return b; },
        neq(k, v) { state.filters.push(['neq', k, v]); return b; },
        in(k, v) { state.filters.push(['in', k, v]); return b; },
        gte(k, v) { state.filters.push(['gte', k, v]); return b; },
        lte(k, v) { state.filters.push(['lte', k, v]); return b; },
        lt(k, v) { state.filters.push(['lt', k, v]); return b; },
        gt(k, v) { state.filters.push(['gt', k, v]); return b; },
        is(k, v) { state.filters.push(['is', k, v]); return b; },
        or() { return b; },
        not() { return b; },
        order() { return b; },
        limit() { return b; },
        single() { state.single = true; return resolve(); },
        maybeSingle() { state.single = true; return resolve(); },
        then(onF, onR) { return resolve().then(onF, onR); },
    };
    return b;
}

function respond(state) {
    const { table, op, single, filters } = state;
    if (op === 'insert' || op === 'upsert') return { data: { id: `${table}-row-1` }, error: null };
    if (op === 'update' || op === 'delete') return { data: single ? { id: `${table}-row-1` } : [], error: null };
    if (table === 'contacts') {
        const orgFilter = filters.find(f => f[1] === 'organization_id');
        const phoneFilter = filters.find(f => f[1] === 'wa_phone');
        const row = {
            id: `contact-${(orgFilter?.[2] || SANTE_ORG).slice(0, 8)}`,
            organization_id: orgFilter?.[2] || SANTE_ORG,
            wa_phone: phoneFilter?.[2] || null,
            full_name: 'Cliente Test',
            bot_mode: 'auto', is_blacklisted: false, is_vip: false,
            estado: 'pendiente', language: null, visit_count: 0,
            created_at: '2026-07-01T10:00:00.000Z',
        };
        return { data: single ? row : [row], error: null };
    }
    return { data: single ? null : [], error: null };
}

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from(t) { return makeBuilder().from(t); } },
};

// ─── 2. Telegram y logger silenciados (el logger GRABA para afirmar sobre el evento) ──
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        startTelegramBot: () => {},
        notifyEscalation: async () => {}, notifyBlacklistAlert: async () => {},
        notifyBizumPending: async () => {}, notifyVipSuggestion: async () => {},
        notifyOrgAdmin: () => {},
    },
};

const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

// ─── 3. LLM stubeado ─────────────────────────────────────────────────────────────────
// Respuesta reconocible: si aparece en el sink, el mensaje ATRAVESÓ el guard y llegó al
// pipeline normal (es lo que debe pasar con un caption y con el texto de siempre).
const RESPUESTA_LLM = 'Ok, te miro huecos 😊';
const openai = require('../services/providers/openai');
openai.getChatbotResponse = async () => ({
    respuesta: RESPUESTA_LLM,
    reserva_confirmada: false, slot_rechazado: false, accion: null, datos: {},
});
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const { makeClient, makeMessage } = require('./lib/convo');
const { buildInboundAdapters } = require('../services/providers/threesixty-dialog');

// ─── Runner ──────────────────────────────────────────────────────────────────────────
async function test(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// Teléfonos únicos por ejecución: memory.js persiste en data/clients.db de verdad y una
// sesión guardada de una corrida anterior contaminaría el estado.
const suffix = String(Date.now()).slice(-6);

const sesionesCreadas = [];

function makeDriver(orgId, phoneDigits) {
    const sink = [];
    const client = makeClient(sink);
    const phone = `${phoneDigits}@c.us`;
    sesionesCreadas.push([orgId, phone]);
    return {
        sink, phone, client, digits: phoneDigits,
        // Turno de TEXTO: pasa por el buffer, así que hay que forzar el flush.
        async turn(text) {
            const before = sink.length;
            await bot.handleIncomingMessage(client, makeMessage(phone, text), orgId);
            await bot._internals.flushBuffer(orgId, phone);
            const session = bot._internals.getSession(orgId, phone);
            if (session) session.lastMessageTime = 0;
            return sink.slice(before).map(m => m.text);
        },
        // Turno de MEDIA: el guard responde y retorna sin pasar por el buffer. Con `flush` se
        // usa para el caso contrario (foto con caption), que SÍ debe llegar al pipeline.
        async raw(message, { flush = false } = {}) {
            const before = sink.length;
            await bot.handleIncomingMessage(client, message, orgId);
            if (flush) await bot._internals.flushBuffer(orgId, phone);
            const session = bot._internals.getSession(orgId, phone);
            if (session) session.lastMessageTime = 0;
            return sink.slice(before).map(m => m.text);
        },
        session() { return bot._internals.getSession(orgId, phone); },
    };
}

// Mensaje entrante tal y como lo entrega el adaptador REAL de Cloud API.
function cloudMessage(digits, tipo, extra = {}) {
    const { message } = buildInboundAdapters(
        { from: digits, id: `wamid.${tipo}.${Date.now()}.${Math.random()}`, type: tipo, ...extra },
        { display_phone_number: '34641029104' },
        SANTE_ORG,
    );
    return message;
}

const TIPOS = [
    ['image', { image: { id: 'mid.1', mime_type: 'image/jpeg' } }],
    ['video', { video: { id: 'mid.2', mime_type: 'video/mp4' } }],
    ['sticker', { sticker: { id: 'mid.3', mime_type: 'image/webp' } }],
    ['document', { document: { id: 'mid.4', mime_type: 'application/pdf' } }],
    ['location', { location: { latitude: 38.34, longitude: -0.48 } }],
    ['contacts', { contacts: [{ name: { formatted_name: 'Ana' } }] }],
];

const insertsOn = (table) => sqlCalls.filter(c => c.table === table && c.op === 'insert');

(async () => {
    // ═══ Sante · Cloud API: ningún tipo se queda en silencio ═══════════════════════════
    for (const [tipo, extra] of TIPOS) {
        const d = makeDriver(SANTE_ORG, `34600${suffix}`);
        const out = await d.raw(cloudMessage(d.digits, tipo, extra));
        await test(`Sante · ${tipo} entrante recibe respuesta (no silencio)`, async () => {
            assert.ok(out.length > 0, `${tipo}: el bot no respondió NADA`);
            assert.ok(out[0].trim().length > 0, `${tipo}: respuesta vacía`);
        });
    }

    // ═══ Sante · la respuesta es útil, no un genérico para todo ════════════════════════
    {
        const d = makeDriver(SANTE_ORG, `34600${suffix}`);
        const foto = await d.raw(cloudMessage(d.digits, 'image', { image: { id: 'm' } }));
        const sticker = await d.raw(cloudMessage(d.digits, 'sticker', { sticker: { id: 'm' } }));
        await test('Sante · a una foto le pide que describa lo que quiere', async () => {
            assert.match(foto[0], /No puedo ver fotos/i);
            assert.notStrictEqual(foto[0], sticker[0], 'foto y sticker no deben compartir texto');
        });
    }

    // ═══ Sante · idioma de la clienta ══════════════════════════════════════════════════
    {
        const d = makeDriver(SANTE_ORG, `34601${suffix}`);
        await d.turn('привет, хочу записаться на стрижку');
        const out = await d.raw(cloudMessage(d.digits, 'image', { image: { id: 'm' } }));
        await test('Sante · responde en el idioma de la sesión (ru), no en español', async () => {
            assert.strictEqual(d.session()?.language, 'ru', 'la sesión debía quedar en ruso');
            assert.ok(/[а-яё]/i.test(out[0]), `esperaba cirílico, llegó: ${out[0]}`);
        });
    }

    // ═══ Sante · el caption ES el mensaje: debe atravesar el guard ═════════════════════
    {
        const d = makeDriver(SANTE_ORG, `34602${suffix}`);
        const msg = cloudMessage(d.digits, 'image', { image: { id: 'm', caption: 'quiero esto' } });
        const out = await d.raw(msg, { flush: true });
        await test('Sante · una foto CON caption entra al flujo normal', async () => {
            assert.strictEqual(msg.body, 'quiero esto', 'el caption debe llegar como body');
            assert.ok(!out.some(t => /No puedo ver fotos/i.test(t)),
                'con caption no debe salir el mensaje de media no soportada');
            assert.ok(out.some(t => t.includes(RESPUESTA_LLM)),
                `el caption debía llegar al LLM, llegó: ${JSON.stringify(out)}`);
        });
    }

    // ═══ Sante · el texto de siempre no se ve afectado ═════════════════════════════════
    {
        const d = makeDriver(SANTE_ORG, `34603${suffix}`);
        const out = await d.turn('hola, quiero cita para un corte');
        await test('Sante · un mensaje de texto sigue llegando al pipeline normal', async () => {
            assert.ok(out.some(t => t.includes(RESPUESTA_LLM)),
                `el turno de texto debía responder desde el LLM, llegó: ${JSON.stringify(out)}`);
        });
    }

    // ═══ Sante · los eventos de sistema SIGUEN en silencio (no spamear) ════════════════
    {
        const d = makeDriver(SANTE_ORG, `34604${suffix}`);
        for (const type of ['e2e_notification', 'ciphertext', 'call_log', 'revoked']) {
            const out = await d.raw(makeMessage(d.phone, '', { type, hasMedia: false }));
            await test(`Sante · ${type} no genera respuesta (es un evento, no un mensaje)`, async () => {
                assert.strictEqual(out.length, 0, `${type} no debe contestarse: ${JSON.stringify(out)}`);
            });
        }
    }

    // ═══ Sante · queda rastro en el panel ══════════════════════════════════════════════
    await test('Sante · el media entrante se registra en messages', async () => {
        const inbound = insertsOn('messages').filter(c => c.payload?.direction === 'inbound');
        assert.ok(inbound.some(c => c.payload.content === '[image]'),
            'debía haber una fila inbound con contenido "[image]"');
        assert.ok(logs.some(l => l.evento === 'media_no_soportada' && l.kind === 'image'),
            'debía loguearse media_no_soportada');
    });

    // ═══ San Remo · REGLA DE ORO: comportamiento idéntico ══════════════════════════════
    {
        const d = makeDriver(SANREMO_ORG, `34610${suffix}`);
        const foto = makeMessage(d.phone, '', { type: 'image', hasMedia: true });
        const out = await d.raw(foto);
        await test('San Remo · una foto recibe el literal EXACTO de siempre', async () => {
            assert.strictEqual(out.length, 1, 'esperaba exactamente un mensaje');
            assert.strictEqual(out[0], LITERAL_SANREMO);
        });
    }

    {
        const d = makeDriver(SANREMO_ORG, `34611${suffix}`);
        const ubicacion = makeMessage(d.phone, '', { type: 'location', hasMedia: false });
        const out = await d.raw(ubicacion);
        await test('San Remo · sin media sigue sin responder (comportamiento intacto)', async () => {
            assert.strictEqual(out.length, 0, 'San Remo no debe cambiar de comportamiento aquí');
        });
    }

    await test('San Remo · no se registran mensajes de media en el panel', async () => {
        const sanremoInbound = insertsOn('messages').filter(
            c => c.payload?.direction === 'inbound' && c.payload?.organization_id === SANREMO_ORG,
        );
        assert.strictEqual(sanremoInbound.length, 0, 'el historial de San Remo no debe cambiar');
    });

    // memory.js persiste en data/clients.db de verdad: no dejamos sesiones de test detrás.
    try {
        const { deleteClient } = require('../services/memory');
        for (const [orgId, phone] of sesionesCreadas) deleteClient(orgId, phone);
    } catch { /* limpieza best-effort */ }

    // El buffer deja un timer de limpieza de 60 s vivo: salimos sin esperarlo.
    process.exit(process.exitCode || 0);
})().catch(e => { console.error('\n💥 Error inesperado:', e); process.exit(1); });
