/**
 * tests/retorno-auto-silencio.test.js — Opción C: volver a 'auto' tras días de silencio.
 *
 * Dos capas:
 *   1. La política (decidirRetorno), que es pura: qué vuelve al bot y qué no vuelve NUNCA.
 *   2. El motor (checkAndReturnToAuto) contra el db.js REAL con Supabase interceptado a
 *      nivel de cliente, para afirmar sobre la sentencia de verdad — incluidos los filtros
 *      del compare-and-set, que son la única defensa contra la carrera de que alguien tome
 *      el control mientras el barrido decide.
 *
 * Lo que este test protege de verdad: que una conversación con escalada sin resolver, con
 * una acción pendiente en la cola o en lista negra NO se le devuelva al bot por llevar
 * tiempo callada. Las tres significan "hay algo abierto que no ha resuelto nadie".
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const AHORA = new Date('2026-08-05T12:00:00.000Z');

function haceDias(n) {
    return new Date(AHORA.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Mock de Supabase: corre el db.js REAL encima ────────────────────────────
// `escenario` lo reescribe cada prueba del motor; `sqlCalls` guarda cada sentencia.
const escenario = { contactos: [], pendientes: [], config: null, updateDevuelve: undefined };
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
        is(k, v) { state.filters.push(['is', k, v]); return b; },
        not(k, op, v) { state.filters.push(['not', k, op, v]); return b; },
        or() { return b; },
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

    if (table === 'config') {
        return { data: escenario.config === null ? null : { valor: String(escenario.config) }, error: null };
    }

    if (table === 'contacts' && op === 'update') {
        // El compare-and-set: solo cuentan como fila afectada las que aún cumplen todo.
        if (escenario.updateDevuelve !== undefined) {
            return { data: escenario.updateDevuelve, error: null };
        }
        const id = filters.find(f => f[0] === 'eq' && f[1] === 'id')?.[2];
        return { data: [{ id }], error: null };
    }

    if (table === 'contacts') {
        // devolverContactoAAuto lee primero la metadata de UNA fila (maybeSingle).
        if (single) {
            const id = filters.find(f => f[0] === 'eq' && f[1] === 'id')?.[2];
            const row = escenario.contactos.find(c => c.id === id);
            return { data: row ? { metadata: row.metadata || {} } : null, error: null };
        }
        return { data: escenario.contactos, error: null };
    }

    if (table === 'pending_actions') {
        return { data: escenario.pendientes, error: null };
    }

    return { data: single ? null : [], error: null };
}

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from(t) { return makeBuilder().from(t); } },
};

const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

const autoReturn = require('../services/auto-return');
const { decidirRetorno, DIAS_SILENCIO_POR_DEFECTO } = autoReturn;

// ─── 1. La política ──────────────────────────────────────────────────────────

const BASE = {
    id: 'c-1',
    telefono: '34600111222',
    bot_mode: 'manual',
    escalation_reason: null,
    is_blacklisted: false,
    ultima_actividad_at: haceDias(9),
};

const CTX = { ahora: AHORA, diasSilencio: 7, tieneAccionPendiente: false };

test('9 días de silencio total en manual → vuelve al bot', () => {
    const d = decidirRetorno(BASE, CTX);
    assert.strictEqual(d.retorna, true);
    assert.strictEqual(Math.floor(d.dias), 9);
});

test('el umbral son 7 días, y 7 justos ya cuentan', () => {
    assert.strictEqual(DIAS_SILENCIO_POR_DEFECTO, 7);
    assert.strictEqual(decidirRetorno({ ...BASE, ultima_actividad_at: haceDias(7) }, CTX).retorna, true);
    const casi = decidirRetorno({ ...BASE, ultima_actividad_at: haceDias(6.9) }, CTX);
    assert.strictEqual(casi.retorna, false);
    assert.strictEqual(casi.motivo, 'silencio_insuficiente');
});

test('escalada sin resolver: NO vuelve, por muchos días que pasen', () => {
    const d = decidirRetorno(
        { ...BASE, escalation_reason: 'pedir_persona', ultima_actividad_at: haceDias(120) },
        CTX
    );
    assert.strictEqual(d.retorna, false);
    assert.strictEqual(d.motivo, 'escalada_sin_resolver');
});

test('acción pendiente en la cola: NO vuelve', () => {
    const d = decidirRetorno(BASE, { ...CTX, tieneAccionPendiente: true });
    assert.strictEqual(d.retorna, false);
    assert.strictEqual(d.motivo, 'accion_pendiente');
});

test('lista negra: NO vuelve (al bot se le apagó a propósito)', () => {
    const d = decidirRetorno({ ...BASE, is_blacklisted: true }, CTX);
    assert.strictEqual(d.retorna, false);
    assert.strictEqual(d.motivo, 'lista_negra');
});

test('el silencio es TOTAL: un saliente nuestro de ayer también cuenta como actividad', () => {
    // La dueña contestó ayer desde el panel: la conversación no está muerta aunque la
    // clienta lleve un mes sin escribir. Por eso se mide last_message_at (cualquier
    // dirección) y no la ventana de 24 h, que solo mira entrantes.
    const d = decidirRetorno({ ...BASE, ultima_actividad_at: haceDias(1) }, CTX);
    assert.strictEqual(d.retorna, false);
    assert.strictEqual(d.motivo, 'silencio_insuficiente');
});

test('sin fecha de última actividad no se adivina: no vuelve', () => {
    const d = decidirRetorno({ ...BASE, ultima_actividad_at: null }, CTX);
    assert.strictEqual(d.retorna, false);
    assert.strictEqual(d.motivo, 'sin_actividad_registrada');
    assert.strictEqual(decidirRetorno({ ...BASE, ultima_actividad_at: 'no-es-fecha' }, CTX).motivo,
        'sin_actividad_registrada');
});

test('una conversación que ya está en auto no se toca', () => {
    const d = decidirRetorno({ ...BASE, bot_mode: 'auto' }, CTX);
    assert.strictEqual(d.retorna, false);
    assert.strictEqual(d.motivo, 'no_esta_en_manual');
});

// ─── 2. El motor, contra el db.js real ───────────────────────────────────────

function prepararEscenario({ contactos, pendientes = [], config = null, updateDevuelve }) {
    escenario.contactos = contactos;
    escenario.pendientes = pendientes;
    escenario.config = config;
    escenario.updateDevuelve = updateDevuelve;
    sqlCalls.length = 0;
    logs.length = 0;
    autoReturn.setClients(new Map([[ORG, { orgId: ORG }]]));
}

// El motor mide contra el reloj real (new Date()), así que sus fixtures cuelgan de ahora
// mismo y no del AHORA fijo de las pruebas de política. Los 9 días llevan unos segundos de
// más para que el Math.floor caiga en 9 y no en 8 por el tiempo que tarda el propio test.
const haceDiasReales = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000 - 5000).toISOString();

const contactoRow = (over = {}) => ({
    id: 'c-1',
    wa_phone: '34600111222',
    full_name: 'Ana',
    bot_mode: 'manual',
    escalation_reason: null,
    is_blacklisted: false,
    updated_at: haceDiasReales(9),
    metadata: { wa_jid: '34600111222@c.us' },
    conversations: [{ last_message_at: haceDiasReales(9) }],
    ...over,
});

test('motor: el UPDATE lleva los filtros del compare-and-set y deja traza', async () => {
    prepararEscenario({ contactos: [contactoRow()] });
    await autoReturn.checkAndReturnToAuto();

    const update = sqlCalls.find(c => c.table === 'contacts' && c.op === 'update');
    assert.ok(update, 'debía escribirse el retorno a auto');
    assert.strictEqual(update.payload.bot_mode, 'auto');

    // La traza que pinta el Monitor. Sin ella, en el panel un retorno automático y uno a
    // mano son la misma fila.
    assert.ok(update.payload.metadata.auto_return, 'falta metadata.auto_return');
    assert.strictEqual(update.payload.metadata.auto_return.dias_silencio, 9);
    assert.ok(update.payload.metadata.auto_return.at);
    // Y la metadata que ya había NO se pisa: wa_jid es lo que hace que un envío manual
    // llegue al chat correcto.
    assert.strictEqual(update.payload.metadata.wa_jid, '34600111222@c.us');

    // Compare-and-set: sigue en manual y sigue sin escalada, o no se escribe.
    const tiene = (op, col, val) =>
        update.filters.some(f => f[0] === op && f[1] === col && f[2] === val);
    assert.ok(tiene('eq', 'bot_mode', 'manual'), 'falta el CAS de bot_mode');
    assert.ok(tiene('is', 'escalation_reason', null), 'falta el CAS de escalada');

    // NO se toca escalation_reason: si la carrera la hubiera puesto entre la lectura y el
    // UPDATE, borrarla dejaría la escalada invisible en el panel.
    assert.ok(!('escalation_reason' in update.payload));
    assert.ok(logs.some(l => l.evento === 'retorno_auto_aplicado'));
});

test('motor: con una acción pendiente en la cola no escribe nada', async () => {
    prepararEscenario({ contactos: [contactoRow()], pendientes: [{ contact_id: 'c-1' }] });
    await autoReturn.checkAndReturnToAuto();
    assert.strictEqual(sqlCalls.filter(c => c.table === 'contacts' && c.op === 'update').length, 0);
});

test('motor: 0 filas afectadas es carrera perdida, no error — no revienta el barrido', async () => {
    prepararEscenario({ contactos: [contactoRow()], updateDevuelve: [] });
    await autoReturn.checkAndReturnToAuto();
    assert.ok(logs.some(l => l.evento === 'retorno_auto_descartado_en_carrera'));
    assert.ok(!logs.some(l => l.evento === 'retorno_auto_aplicado'));
    assert.ok(!logs.some(l => l.level === 'error'));
});

test('motor: dias_retorno_auto = 0 desactiva la org entera', async () => {
    prepararEscenario({ contactos: [contactoRow()], config: 0 });
    await autoReturn.checkAndReturnToAuto();
    assert.strictEqual(sqlCalls.filter(c => c.table === 'contacts' && c.op === 'update').length, 0);
    assert.ok(logs.some(l => l.evento === 'retorno_auto_desactivado'));
});

test('motor: dias_retorno_auto sube el umbral', async () => {
    prepararEscenario({ contactos: [contactoRow()], config: 30 });
    await autoReturn.checkAndReturnToAuto();
    assert.strictEqual(sqlCalls.filter(c => c.table === 'contacts' && c.op === 'update').length, 0);
});
