/**
 * tests/pending-action-write-errors.test.js — Las ESCRITURAS de la escalada no se tragan el error.
 *
 * Bug arreglado: `createPendingAction` (db.js) desestructuraba solo `data` y descartaba `error`,
 * así que un INSERT fallido devolvía `null` sin lanzar. Lo mismo, y peor, en `setLeadBotMode`
 * (que ni desestructuraba `error` y hacía `return true` incondicional) y `setEscalationReason`.
 * Consecuencia: `escalateToHuman` seguía adelante, logueaba `escalada_ejecutada` y devolvía
 * `true` — la garantía del commit f509389 ("devuelve true solo si quedó registrada") era falsa.
 * Cero fila en el panel, y con `bot_mode` intacto la reconciliación revivía el bot encima de
 * una clienta que ya estaba esperando a un humano.
 *
 * Es el gemelo de tests/db-read-errors.test.js, que cubre la misma clase de bug en las lecturas.
 *
 * No se mockea un éxito: se fuerza el error con la forma REAL que devuelve PostgREST, capturada
 * el 29/07/2026 contra la BD del proyecto con dos INSERT inválidos a propósito (ver constantes).
 *
 * Hermético: solo se interceptan los bordes — Supabase (a nivel de cliente, para que corra el
 * db.js real encima), Telegram y el LLM. NO toca red ni credenciales.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const assert = require('assert');

const SANTE_ORG   = process.env.SANTE_ORG_ID   || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const SANREMO_ORG = process.env.SANREMO_ORG_ID || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── Errores REALES de PostgREST ─────────────────────────────────────────────────────
// Capturados el 29/07/2026 ejecutando los INSERT inválidos contra la BD real. Ambos son el
// modo de fallo realista de este INSERT: el CHECK de `type` (002_restaurante.sql:53) y la FK
// de `contact_id` — que salta de verdad cuando el `contact?.id || session.leadId` de los call
// sites arrastra un leadId obsoleto.
const FK_VIOLATION = {
    code: '23503',
    message: 'insert or update on table "pending_actions" violates foreign key constraint "pending_actions_contact_id_fkey"',
    details: 'Key (contact_id)=(00000000-0000-4000-8000-00000000dead) is not present in table "contacts".',
    hint: null,
};
const CHECK_VIOLATION = {
    code: '23514',
    message: 'new row for relation "pending_actions" violates check constraint "pending_actions_type_check"',
    details: 'Failing row contains (…, tipo_invalido_a_proposito, null, null, {}, pending, null, …).',
    hint: null,
};

// ─── 1. Supabase falso: falla la escritura que se le pida ────────────────────────────
// Se inyecta en require.cache ANTES de requerir db.js/bot.js, para que corra el db.js REAL
// encima y las aserciones sean sobre la sentencia de verdad. `failWrites` lleva claves
// `tabla:op` (p.ej. 'pending_actions:insert').
const control = { failWrites: new Set(), error: FK_VIOLATION };
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

const AGENT_CONFIG = {
    id: 'cfg-1',
    services: [],
    business_info: { bizum: { importe: 20, numero: '600000000' } },
};

function respond(state) {
    const { table, op, single, filters } = state;

    if (control.failWrites.has(`${table}:${op}`)) return { data: null, error: control.error };

    if (op === 'insert' || op === 'upsert') return { data: { id: `${table}-row-1` }, error: null };
    // Un UPDATE con `.select('id')` devuelve las filas afectadas; devolver [] equivaldría a
    // "no casó ninguna fila", que ahora es un error de escritura (assertRowsAffected).
    if (op === 'update' || op === 'delete') return { data: single ? { id: `${table}-row-1` } : [{ id: `${table}-row-1` }], error: null };

    if (table === 'contacts') {
        const orgFilter = filters.find(f => f[1] === 'organization_id');
        const phoneFilter = filters.find(f => f[1] === 'wa_phone');
        const row = { ...contactRow(orgFilter?.[2] || SANTE_ORG), wa_phone: phoneFilter?.[2] || null };
        return { data: single ? row : [row], error: null };
    }
    if (table === 'agent_configs') return { data: single ? AGENT_CONFIG : [AGENT_CONFIG], error: null };

    // appointments con maybeSingle() → null, para que saveAppointment no crea que la cita ya existe.
    return { data: single ? null : [], error: null };
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

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from(t) { return makeBuilder().from(t); } },
};

// ─── 2. Telegram que GRABA ───────────────────────────────────────────────────────────
const tg = { escalations: [], blacklist: [], bizum: [] };
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        startTelegramBot: () => {},
        notifyEscalation:     async (...args) => { tg.escalations.push(args); },
        notifyBlacklistAlert: async (...args) => { tg.blacklist.push(args); },
        notifyBizumPending:   async (...args) => { tg.bizum.push(args); },
        notifyVipSuggestion:  async () => {},
        notifyOrgAdmin:       () => {},
    },
};

// ─── 3. Logger que GRABA ─────────────────────────────────────────────────────────────
const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

// ─── 4. LLM stubeado (mutable por escenario) ─────────────────────────────────────────
let llmNext = () => ({ respuesta: 'Ok 😊', reserva_confirmada: false, slot_rechazado: false, accion: null, datos: {} });
const openai = require('../services/providers/openai');
openai.getChatbotResponse = async (...args) => llmNext(...args);
openai.summarizeHistory = async () => null;

const db = require('../services/db');
const bot = require('../bot');
const { makeClient, makeMessage } = require('./lib/convo');

// ─── Runner ──────────────────────────────────────────────────────────────────────────
let pass = 0;
async function test(nombre, fn) {
    try { await fn(); pass++; console.log(`ok - ${nombre}`); }
    catch (e) { console.error(`fail - ${nombre}`); console.error(`    ${e.message}`); process.exitCode = 1; }
}

async function lanza(fn, etiqueta) {
    try { await fn(); }
    catch (e) { return e; }
    throw new Error(`${etiqueta}: debería haber lanzado y no lanzó`);
}

const inserts = (table) => sqlCalls.filter(c => c.table === table && c.op === 'insert');
const updates = (table) => sqlCalls.filter(c => c.table === table && c.op === 'update');

// Driver de turnos: idéntico al de message-cap-escalation (flushBuffer awaitea el core, y se
// resetea lastMessageTime para que la ventana anti-duplicado de 1500 ms no descarte turnos).
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

(async () => {
    // ═══ CAPA 1 · Unitaria: las tres escrituras LANZAN ═════════════════════════════════
    // Antes del fix las tres resolvían tranquilamente (null / undefined / true): estas
    // aserciones fallaban, que es justo lo que las hace útiles.

    await test('createPendingAction: una violación de FK LANZA, no devuelve null', async () => {
        control.failWrites = new Set(['pending_actions:insert']);
        control.error = FK_VIOLATION;
        const e = await lanza(
            () => db.createPendingAction(SANTE_ORG, { type: 'escalation', contactId: 'x', payload: {} }),
            'createPendingAction');
        assert.ok(/pending_actions/.test(e.message), `el error debe nombrar la tabla, fue: ${e.message}`);
    });

    await test('createPendingAction: una violación de CHECK sobre `type` también LANZA', async () => {
        control.error = CHECK_VIOLATION;
        await lanza(
            () => db.createPendingAction(SANTE_ORG, { type: 'tipo_invalido', contactId: 'x', payload: {} }),
            'createPendingAction/CHECK');
        control.error = FK_VIOLATION;
    });

    await test('createPendingAction: el fallo queda logueado como db_write_error con el code real', async () => {
        const ev = logs.filter(l => l.evento === 'db_write_error' && l.tabla === 'pending_actions');
        assert.ok(ev.length >= 2, `esperados ≥2 db_write_error, hubo ${ev.length}`);
        assert.ok(ev.some(l => l.code === '23503'), 'debe registrarse el code 23503 (FK)');
        assert.ok(ev.some(l => l.code === '23514'), 'debe registrarse el code 23514 (CHECK)');
    });

    await test('setLeadBotMode: un error de Supabase LANZA en vez de un `return true` de adorno', async () => {
        control.failWrites = new Set(['contacts:update']);
        await lanza(() => db.setLeadBotMode(SANTE_ORG, '34600111222', 'manual'), 'setLeadBotMode');
    });

    await test('setEscalationReason: un error de Supabase LANZA', async () => {
        await lanza(() => db.setEscalationReason(SANTE_ORG, '34600111222', 'limite_mensajes'), 'setEscalationReason');
    });

    await test('sin error, las tres siguen devolviendo lo de siempre', async () => {
        control.failWrites = new Set();
        const row = await db.createPendingAction(SANTE_ORG, { type: 'escalation', contactId: 'x', payload: {} });
        assert.ok(row && row.id, 'createPendingAction debe devolver la fila insertada');
        assert.strictEqual(await db.setLeadBotMode(SANTE_ORG, '34600111222', 'manual'), true);
        assert.strictEqual(await db.setEscalationReason(SANTE_ORG, '34600111222', 'x'), undefined);
    });

    // ═══ CAPA 2 · escalateToHuman deja de mentir ═══════════════════════════════════════
    // El contrato de f509389: devuelve true SOLO si la escalada quedó registrada.

    await test('escalateToHuman devuelve FALSE si el INSERT falla (y no loguea escalada_ejecutada)', async () => {
        control.failWrites = new Set(['pending_actions:insert']);
        const antesTg = tg.escalations.length;
        const marca = logs.length;

        const session = {
            orgId: SANTE_ORG,
            leadId: 'contact-b2c3d4e5',
            partialData: { telefono: '34600111333', nombre: 'Ana' },
            history: [],
        };
        const ok = await bot._internals.escalateToHuman(session, '34600111333@c.us', 'limite_mensajes', 'necesito ayuda');

        assert.strictEqual(ok, false, 'con la fila sin escribir, la escalada NO puede reportarse como exitosa');
        const nuevos = logs.slice(marca);
        assert.strictEqual(nuevos.filter(l => l.evento === 'escalada_ejecutada').length, 0,
            'no puede loguearse escalada_ejecutada cuando no se registró nada');
        assert.ok(nuevos.some(l => l.evento === 'error_escalar'), 'el fallo tiene que verse en los logs');
        // Y el humano NO se queda a ciegas: el aviso sale igual (por eso el notify va antes).
        assert.strictEqual(tg.escalations.length, antesTg + 1,
            'aunque la fila no se escriba, el salón debe recibir el aviso de Telegram');
    });

    await test('escalateToHuman devuelve FALSE también si lo que falla es bot_mode', async () => {
        // Sin bot_mode='manual' la reconciliación revive el bot: la escalada no vale nada.
        control.failWrites = new Set(['contacts:update']);
        const session = {
            orgId: SANTE_ORG,
            leadId: 'contact-b2c3d4e5',
            partialData: { telefono: '34600111444', nombre: 'Ana' },
            history: [],
        };
        const ok = await bot._internals.escalateToHuman(session, '34600111444@c.us', 'limite_mensajes', 'hola');
        assert.strictEqual(ok, false, 'si contacts no se puede actualizar, la escalada está incompleta');
    });

    await test('con la BD sana, escalateToHuman sigue devolviendo TRUE (no rompimos el camino feliz)', async () => {
        control.failWrites = new Set();
        const session = {
            orgId: SANTE_ORG,
            leadId: 'contact-b2c3d4e5',
            partialData: { telefono: '34600111555', nombre: 'Ana' },
            history: [],
        };
        const ok = await bot._internals.escalateToHuman(session, '34600111555@c.us', 'limite_mensajes', 'hola');
        assert.strictEqual(ok, true);
        assert.ok(logs.some(l => l.evento === 'escalada_ejecutada'), 'el camino feliz sí loguea escalada_ejecutada');
    });

    // ═══ CAPA 3 · Motor real: el cap de mensajes avisa del fallo ═══════════════════════
    // 61 turnos contra bot.handleIncomingMessage con pending_actions caída. Lo que se mide es
    // que el aviso `limite_escalada_fallida` de bot.js:1995 pase de inalcanzable a real.

    await test('cap de mensajes con pending_actions caída → limite_escalada_fallida en logs', async () => {
        control.failWrites = new Set(['pending_actions:insert']);
        const marca = logs.length;
        const antesTg = tg.escalations.length;

        // Teléfono único: memory.js persiste en data/clients.db de verdad y una sesión vieja
        // restauraría messageCount.
        const phone = `34602${String(Date.now()).slice(-6)}`;
        const sante = makeDriver(SANTE_ORG, phone);
        for (let i = 1; i <= 61; i++) await sante.turn('ok');

        const nuevos = logs.slice(marca);
        assert.ok(nuevos.some(l => l.evento === 'limite_escalada_fallida'),
            'el llamante tiene que enterarse de que la escalada no se registró');
        assert.strictEqual(nuevos.filter(l => l.evento === 'escalada_ejecutada').length, 0,
            'y NO puede haberse logueado como ejecutada');
        assert.strictEqual(tg.escalations.length, antesTg + 1,
            'el aviso de Telegram sale igual: el salón no se queda sin saberlo');
        assert.ok(updates('contacts').some(c => c.payload.bot_mode === 'manual'),
            'el intento de silenciar el bot se hace igualmente');

        try { require('../services/memory').deleteClient(SANTE_ORG, sante.phone); } catch { /* best-effort */ }
    });

    // ═══ CONTROL San Remo ══════════════════════════════════════════════════════════════
    // El único sitio San Remo-only es bizum_review. Con el INSERT caído, Alberto TIENE que
    // seguir recibiendo su Telegram (antes lo recibía por accidente, porque el null no
    // lanzaba; ahora es por diseño, con el notify delante) y la clienta su mensaje.

    await test('CONTROL San Remo: con pending_actions caída, Alberto sigue recibiendo el Bizum', async () => {
        control.failWrites = new Set(['pending_actions:insert']);
        const bizumAntes = tg.bizum.length;
        const phone = `34612${String(Date.now()).slice(-6)}`;
        const sanremo = makeDriver(SANREMO_ORG, phone);

        llmNext = () => ({
            respuesta: 'Perfecto',
            reserva_confirmada: true,
            slot_rechazado: false,
            accion: null,
            datos: { nombre: 'Carlos', personas: 2, fecha_cita: '2026-08-14', hora_cita: '21:00' },
        });
        const t1 = await sanremo.turn('quiero reservar mesa para 2 el viernes a las 21:00');
        assert.ok(/bizum/i.test(t1.join(' ')), `esperada la petición de Bizum, llegó: "${t1.join(' ')}"`);

        llmNext = () => ({ respuesta: 'Ok', reserva_confirmada: false, slot_rechazado: false, accion: null, datos: {} });
        const t2 = await sanremo.turn('hecho');

        assert.strictEqual(tg.bizum.length, bizumAntes + 1,
            'Alberto debe recibir el aviso de Bizum pendiente aunque la fila no se pueda escribir');
        assert.ok(/verifiquemos el Bizum/i.test(t2.join(' ')),
            `el cliente debe recibir su confirmación igual, llegó: "${t2.join(' ')}"`);
        assert.ok(inserts('pending_actions').some(c => c.payload.type === 'bizum_review'),
            'el INSERT de bizum_review se intentó (y falló, que es el escenario)');

        try { require('../services/memory').deleteClient(SANREMO_ORG, sanremo.phone); } catch { /* best-effort */ }
    });

    await test('CONTROL San Remo: el camino feliz del Bizum queda igual que siempre', async () => {
        control.failWrites = new Set();
        const bizumAntes = tg.bizum.length;
        const paInserts = inserts('pending_actions').length;
        const phone = `34613${String(Date.now()).slice(-6)}`;
        const sanremo = makeDriver(SANREMO_ORG, phone);

        llmNext = () => ({
            respuesta: 'Perfecto',
            reserva_confirmada: true,
            slot_rechazado: false,
            accion: null,
            datos: { nombre: 'Carlos', personas: 2, fecha_cita: '2026-08-14', hora_cita: '21:00' },
        });
        await sanremo.turn('mesa para 2 el viernes a las 21:00');
        llmNext = () => ({ respuesta: 'Ok', reserva_confirmada: false, slot_rechazado: false, accion: null, datos: {} });
        const t2 = await sanremo.turn('hecho');

        assert.strictEqual(tg.bizum.length, bizumAntes + 1, 'un solo aviso de Bizum');
        assert.strictEqual(inserts('pending_actions').length, paInserts + 1, 'y una sola fila de verificación');
        assert.ok(/verifiquemos el Bizum/i.test(t2.join(' ')));
        const fila = inserts('pending_actions').slice(-1)[0].payload;
        assert.strictEqual(fila.type, 'bizum_review');
        assert.strictEqual(fila.organization_id, SANREMO_ORG, 'la fila es de la org de San Remo');

        try { require('../services/memory').deleteClient(SANREMO_ORG, sanremo.phone); } catch { /* best-effort */ }
    });

    console.log(`\n${pass} comprobaciones OK`);
    // El buffer deja un timer de limpieza de 60 s vivo: salimos sin esperarlo.
    process.exit(process.exitCode || 0);
})().catch(e => { console.error('\n💥 Error inesperado:', e); process.exit(1); });
