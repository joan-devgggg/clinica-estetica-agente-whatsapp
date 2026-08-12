/**
 * tests/message-cap-escalation.test.js — El cap de mensajes escala DE VERDAD (Sante).
 *
 * Bug arreglado: al llegar al límite de mensajes de la conversación el bot anunciaba
 * "nuestro equipo te atenderá enseguida" y solo ponía session.botActivo = false EN MEMORIA:
 * cero fila en pending_actions, cero aviso de Telegram, contacts.bot_mode seguía en 'auto'
 * (así que la reconciliación revivía el bot en el mensaje siguiente). Mismo patrón que el
 * bug de "el más cercano": escalada anunciada y no ejecutada.
 *
 * Este test conduce una conversación de 61 turnos contra el MOTOR REAL
 * (bot.handleIncomingMessage + flushBuffer: sesión real, buffer real, cap real) y comprueba
 * el efecto real, no el texto: el INSERT en pending_actions, el UPDATE de bot_mode y la
 * llamada a notifyEscalation.
 *
 * Hermético: solo se interceptan los bordes — Supabase (a nivel de cliente, para que corra
 * el db.js real encima y se afirme sobre la sentencia real), Telegram y el LLM.
 * NO toca red ni credenciales.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SANTE_ORG   = process.env.SANTE_ORG_ID   || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const SANREMO_ORG = process.env.SANREMO_ORG_ID || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── 1. Mock de Supabase ─────────────────────────────────────────────────────────────
// Se inyecta en require.cache ANTES de requerir db.js/bot.js. Corre el db.js REAL encima,
// así las aserciones son sobre la sentencia de verdad (tabla y columnas reales), no sobre
// un db.* falso. Graba cada llamada como {table, op, payload, filters}.
const sqlCalls = [];

function contactRow(orgId) {
    return {
        id: `contact-${orgId.slice(0, 8)}`,
        organization_id: orgId,
        wa_phone: null,          // lo rellena el responder con el teléfono del filtro
        full_name: 'Cliente Test',
        bot_mode: 'auto',
        is_blacklisted: false,
        is_vip: false,
        estado: 'pendiente',
        language: 'es',
        visit_count: 0,
        created_at: '2026-07-01T10:00:00.000Z',
    };
}

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

// Nunca devuelve `error`: assertRead lanzaría y el escenario a probar no es un fallo de BD.
function respond(state) {
    const { table, op, single, filters } = state;
    if (op === 'insert' || op === 'upsert') {
        return { data: { id: `${table}-row-1` }, error: null };
    }
    if (op === 'update' || op === 'delete') {
        return { data: single ? { id: `${table}-row-1` } : [], error: null };
    }
    if (table === 'contacts') {
        const orgFilter = filters.find(f => f[1] === 'organization_id');
        const phoneFilter = filters.find(f => f[1] === 'wa_phone');
        const row = { ...contactRow(orgFilter?.[2] || SANTE_ORG), wa_phone: phoneFilter?.[2] || null };
        return { data: single ? row : [row], error: null };
    }
    return { data: single ? null : [], error: null };
}

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from(t) { return makeBuilder().from(t); } },
};

// ─── 2. Telegram que GRABA en vez de no-opear ────────────────────────────────────────
const tg = { escalations: [], blacklist: [], bizum: [] };
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        startTelegramBot: () => {},
        notifyEscalation:     async (...args) => { tg.escalations.push(args); },
        notifyBlacklistAlert: async (...args) => { tg.blacklist.push(args); return true; },
        notifyBizumPending:   async (...args) => { tg.bizum.push(args); },
        notifyVipSuggestion:  async () => {},
        notifyOrgAdmin:       () => {},
    },
};

// ─── 3. Logger que GRABA en vez de escribir ──────────────────────────────────────────
// 61 turnos × ~6 líneas JSON harían ilegible la salida de `npm test`. De paso permite
// afirmar sobre los eventos de la escalada.
const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

// ─── 4. LLM stubeado ─────────────────────────────────────────────────────────────────
// services/ai → services/llm llama a openai.getChatbotResponse por referencia dinámica, y
// bot.js desestructura summarizeHistory al cargar: por eso ambos se parchean ANTES de
// requerir bot.js (sin el segundo, el resumen automático sale a la red de verdad).
// Respuesta corta a propósito: sendWithDelay solo espera si el retardo supera los 100 ms,
// y así los 61 turnos corren en segundos.
const openai = require('../services/providers/openai');
openai.getChatbotResponse = async () => ({
    respuesta: 'Ok 😊',
    reserva_confirmada: false,
    slot_rechazado: false,
    accion: null,
    datos: {},
});
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const { makeClient, makeMessage } = require('./lib/convo');

// ─── Runner ──────────────────────────────────────────────────────────────────────────
async function test(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// Un turno completo: flushBuffer AWAITEA processMessageCore, así que al resolver el turno
// está terminado (no hace falta el `quiet` de 3 s del arnés Convo × 61 turnos).
// Después se resetea lastMessageTime: si no, la ventana anti-duplicado de 1500 ms de
// bot.js descartaría 60 de los 61 turnos y el cap no se alcanzaría nunca.
function makeDriver(orgId, phoneDigits) {
    const sink = [];
    const client = makeClient(sink);
    const phone = `${phoneDigits}@c.us`;
    return {
        sink, phone,
        async turn(text) {
            const before = sink.length;
            await bot.handleIncomingMessage(client, makeMessage(phone, text), orgId);
            await bot._internals.flushBuffer(orgId, phone);
            const session = bot._internals.getSession(orgId, phone);
            if (session) session.lastMessageTime = 0;
            return sink.slice(before).map(m => m.text);
        },
        session() { return bot._internals.getSession(orgId, phone); },
    };
}

const inserts = (table) => sqlCalls.filter(c => c.table === table && c.op === 'insert');
const updates = (table) => sqlCalls.filter(c => c.table === table && c.op === 'update');

(async () => {
    // ═══ Sante: 61 turnos, el cap está en 60 ═══════════════════════════════════════════
    // Teléfono único por ejecución: memory.js persiste en data/clients.db de verdad y una
    // sesión guardada de una corrida anterior restauraría messageCount.
    const santePhone = `34600${String(Date.now()).slice(-6)}`;
    const sante = makeDriver(SANTE_ORG, santePhone);

    let turno60 = [];
    for (let i = 1; i <= 60; i++) turno60 = await sante.turn('ok');

    await test('1 · turnos 1-60: el bot responde y NO hay escalada', async () => {
        assert.ok(turno60.length > 0, 'el turno 60 debe recibir respuesta');
        assert.strictEqual(inserts('pending_actions').length, 0, 'ninguna fila en pending_actions antes del cap');
        assert.strictEqual(tg.escalations.length, 0, 'ningún aviso de Telegram antes del cap');
        assert.strictEqual(sante.session().messageCount, 60, 'el contador llega a 60');
    });

    const turno61 = await sante.turn('¿y algo más?');

    await test('2 · turno 61: sale el mensaje de límite de Sante', async () => {
        const txt = turno61.join(' ');
        assert.ok(/nuestro equipo te atender/i.test(txt), `mensaje de límite esperado, llegó: "${txt}"`);
        assert.ok(!/Alberto/.test(txt), 'el mensaje de San Remo no debe filtrarse a Sante');
    });

    await test('3 · turno 61: fila REAL en pending_actions (type=escalation, motivo=limite_mensajes)', async () => {
        const rows = inserts('pending_actions');
        assert.strictEqual(rows.length, 1, `esperada 1 fila, hubo ${rows.length}`);
        const p = rows[0].payload;
        // 'escalation' es uno de los 3 valores del CHECK de la tabla (002_restaurante.sql:53).
        assert.strictEqual(p.type, 'escalation', 'type válido para el CHECK de pending_actions');
        assert.strictEqual(p.organization_id, SANTE_ORG, 'la fila es de la org de Sante');
        assert.ok(p.contact_id, 'contact_id no nulo: sin él el panel no sabe a quién atender');
        assert.strictEqual(p.payload.motivo, 'limite_mensajes');
        assert.ok(p.payload.mensaje.includes('algo más'), 'guarda el mensaje que disparó el cap');
    });

    await test('4 · turno 61: contacts pasa a bot_mode=manual + escalation_reason', async () => {
        const ups = updates('contacts');
        assert.ok(ups.some(c => c.payload.bot_mode === 'manual'),
            'sin bot_mode=manual la reconciliación revive el bot en el mensaje siguiente');
        assert.ok(ups.some(c => c.payload.escalation_reason === 'limite_mensajes'),
            'el panel necesita el motivo para mostrarlo');
    });

    await test('5 · turno 61: notifyEscalation se llama de verdad (1 vez, con el motivo)', async () => {
        assert.strictEqual(tg.escalations.length, 1, `esperado 1 aviso, hubo ${tg.escalations.length}`);
        const [orgId, contacto, mensaje, reason] = tg.escalations[0];
        assert.strictEqual(orgId, SANTE_ORG);
        assert.strictEqual(reason, 'limite_mensajes');
        assert.ok(contacto?.telefono, 'el aviso lleva teléfono para que el salón sepa a quién escribir');
        assert.ok(mensaje.includes('algo más'), 'el aviso lleva el último mensaje de la clienta');
    });

    await test('5b · la escalada queda registrada en logs y no marcada como fallida', async () => {
        const ejecutada = logs.filter(l => l.evento === 'escalada_ejecutada' && l.reason === 'limite_mensajes');
        assert.strictEqual(ejecutada.length, 1, 'debe loguearse escalada_ejecutada una vez');
        assert.strictEqual(logs.filter(l => l.evento === 'limite_escalada_fallida').length, 0,
            'no debe haber quedado ninguna escalada incompleta');
    });

    await test('6 · limite_mensajes tiene etiqueta en ESCALATION_LABELS', async () => {
        // ESCALATION_LABELS no se exporta y el módulo está stubeado: se comprueba en la
        // fuente. Sin la etiqueta, el Telegram mostraría el slug crudo "limite_mensajes".
        const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'telegram.js'), 'utf8');
        assert.ok(/limite_mensajes\s*:/.test(src), 'falta la entrada limite_mensajes en ESCALATION_LABELS');
    });

    await test('7 · turno 62: silencio y sin escalada repetida (idempotencia)', async () => {
        const turno62 = await sante.turn('hola?');
        assert.strictEqual(turno62.length, 0, `el bot debe callar tras la escalada, envió: ${JSON.stringify(turno62)}`);
        assert.strictEqual(inserts('pending_actions').length, 1, 'sigue habiendo exactamente 1 fila');
        assert.strictEqual(tg.escalations.length, 1, 'sigue habiendo exactamente 1 aviso');
    });

    // ═══ CONTROL San Remo: intacto ═════════════════════════════════════════════════════
    // Fija el comportamiento actual para que nadie lo cambie por accidente: su cap está en
    // 30 y NO escala (decisión explícita — la regla de oro es que San Remo no se toca).
    const sqlAntes = sqlCalls.length;
    const escAntes = tg.escalations.length;
    const sanremoPhone = `34611${String(Date.now()).slice(-6)}`;
    const sanremo = makeDriver(SANREMO_ORG, sanremoPhone);

    for (let i = 1; i <= 30; i++) await sanremo.turn('ok');
    const turnoSR31 = await sanremo.turn('¿hola?');

    await test('8 · CONTROL San Remo: mensaje de límite a los 30, y CERO escalada', async () => {
        const txt = turnoSR31.join(' ');
        assert.ok(/Alberto te contactar/i.test(txt), `mensaje de límite de San Remo esperado, llegó: "${txt}"`);
        const nuevas = sqlCalls.slice(sqlAntes);
        assert.strictEqual(
            nuevas.filter(c => c.table === 'pending_actions' && c.op === 'insert').length, 0,
            'San Remo NO debe crear filas de escalación');
        assert.strictEqual(
            nuevas.filter(c => c.table === 'contacts' && c.op === 'update' && c.payload?.bot_mode).length, 0,
            'San Remo NO debe tocar bot_mode');
        assert.strictEqual(tg.escalations.length, escAntes, 'San Remo NO debe disparar Telegram');
    });

    // memory.js persiste en data/clients.db de verdad: no dejamos sesiones de test detrás.
    try {
        const { deleteClient } = require('../services/memory');
        deleteClient(SANTE_ORG, sante.phone);
        deleteClient(SANREMO_ORG, sanremo.phone);
    } catch { /* limpieza best-effort */ }

    // El buffer deja un timer de limpieza de 60 s vivo: salimos sin esperarlo.
    process.exit(process.exitCode || 0);
})().catch(e => { console.error('\n💥 Error inesperado:', e); process.exit(1); });
