/**
 * tests/mensaje-wamid-raw.test.js — saveMessage rellena wa_message_id y raw.
 *
 * Las dos columnas existían en el esquema desde 001 y nadie las escribía:
 *
 *   · `wa_message_id` es UNIQUE. Es la ÚNICA red contra la reentrega del webhook de Cloud
 *     API que sobrevive a un reinicio — TTLMessageDedupe es un Map en RAM de 60 s por
 *     proceso. Sin ella, un reintento de Meta guardaba el mensaje dos veces.
 *   · `raw` es el payload del proveedor. Sin él, cuando algo llega raro no queda nada que
 *     mirar: el log tiene lo que decidimos loguear, que ya es una interpretación.
 *
 * Se afirma sobre la sentencia REAL (db.js de verdad, Supabase interceptado a nivel de
 * cliente), no sobre un doble de db.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const sqlCalls = [];
// Error que devolverá el próximo INSERT en messages (para el caso del duplicado).
let insertError = null;

function makeBuilder() {
    const state = { table: null, op: 'select', payload: null, filters: [], single: false };
    const resolve = () => { sqlCalls.push(state); return Promise.resolve(respond(state)); };
    const b = {
        from(t) { state.table = t; return b; },
        select() { return b; },
        insert(p) { state.op = 'insert'; state.payload = p; return b; },
        upsert(p) { state.op = 'upsert'; state.payload = p; return b; },
        update(p) { state.op = 'update'; state.payload = p; return b; },
        eq(k, v) { state.filters.push(['eq', k, v]); return b; },
        neq() { return b; }, in() { return b; }, is() { return b; }, not() { return b; },
        or() { return b; }, order() { return b; }, limit() { return b; },
        single() { state.single = true; return resolve(); },
        maybeSingle() { state.single = true; return resolve(); },
        then(onF, onR) { return resolve().then(onF, onR); },
    };
    return b;
}

function respond(state) {
    const { table, op, single } = state;
    if (table === 'messages' && op === 'insert') {
        if (insertError) { const e = insertError; insertError = null; return { data: null, error: e }; }
        return { data: { id: 'msg-1' }, error: null };
    }
    if (op === 'insert' || op === 'upsert') return { data: { id: `${table}-1` }, error: null };
    if (op === 'update') return { data: single ? { id: `${table}-1` } : [], error: null };
    if (table === 'contacts') {
        const row = { id: 'c-1', organization_id: ORG, wa_phone: '34600111222', full_name: 'Ana' };
        return { data: single ? row : [row], error: null };
    }
    if (table === 'conversations') {
        const row = { id: 'conv-1', organization_id: ORG, contact_id: 'c-1' };
        return { data: single ? row : [row], error: null };
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

const db = require('../services/db');

const insertDeMensaje = () => sqlCalls.find(c => c.table === 'messages' && c.op === 'insert');

test('el entrante guarda el wamid y el payload crudo', async () => {
    sqlCalls.length = 0;
    const raw = { id: 'wamid.HBgL', from: '34600111222', type: 'text', text: { body: 'hola' } };
    const id = await db.saveMessage(ORG, {
        telefono: '34600111222', contenido: 'hola', direccion: 'entrante',
        waMessageId: 'wamid.HBgL', raw,
    });
    assert.strictEqual(id, 'msg-1');

    const ins = insertDeMensaje();
    assert.strictEqual(ins.payload.wa_message_id, 'wamid.HBgL');
    assert.deepStrictEqual(ins.payload.raw, raw);
    assert.strictEqual(ins.payload.direction, 'inbound');
    assert.strictEqual(ins.payload.sender, 'contact');
});

test('sin id ni raw se guarda igual: son datos para correlacionar, no requisitos', async () => {
    sqlCalls.length = 0;
    const id = await db.saveMessage(ORG, {
        telefono: '34600111222', contenido: 'respuesta', direccion: 'saliente',
    });
    assert.strictEqual(id, 'msg-1');
    const ins = insertDeMensaje();
    assert.strictEqual(ins.payload.wa_message_id, null);
    assert.strictEqual(ins.payload.raw, null);
    assert.strictEqual(ins.payload.sender, 'bot');
});

test('reentrega del webhook: el UNIQUE la rechaza y NO es un error', async () => {
    sqlCalls.length = 0;
    logs.length = 0;
    insertError = { code: '23505', message: 'duplicate key value violates unique constraint' };

    const id = await db.saveMessage(ORG, {
        telefono: '34600111222', contenido: 'hola', direccion: 'entrante',
        waMessageId: 'wamid.REPETIDO',
    });

    assert.strictEqual(id, null, 'un duplicado no crea fila nueva');
    assert.ok(logs.some(l => l.evento === 'mensaje_duplicado_ignorado'));
    assert.ok(!logs.some(l => l.level === 'error'), 'un duplicado no es un fallo de escritura');
    // Y no se toca last_message_at: no ha llegado nada nuevo.
    assert.ok(!sqlCalls.some(c => c.table === 'conversations' && c.op === 'update'));
});

test('un INSERT que falla de verdad se registra en vez de perderse', async () => {
    sqlCalls.length = 0;
    logs.length = 0;
    insertError = { code: '42501', message: 'permission denied for table messages' };

    const id = await db.saveMessage(ORG, {
        telefono: '34600111222', contenido: 'hola', direccion: 'entrante',
    });

    assert.strictEqual(id, null);
    const err = logs.find(l => l.level === 'error' && l.evento === 'db_write_error');
    assert.ok(err, 'un fallo de escritura tiene que quedar registrado');
    assert.strictEqual(err.tabla, 'messages');
});

// ─── Los ids del proveedor, que no tienen la misma forma ─────────────────────

const { extractSentMessageId } = require('../bot');

test('extractSentMessageId entiende las dos formas de saliente', () => {
    // whatsapp-web.js devuelve el objeto Message.
    assert.strictEqual(extractSentMessageId({ id: { _serialized: 'false_34600@c.us_ABC' } }), 'false_34600@c.us_ABC');
    // Cloud API devuelve el JSON de la respuesta.
    assert.strictEqual(extractSentMessageId({ messages: [{ id: 'wamid.OUT' }] }), 'wamid.OUT');
    // Y cuando no hay nada que sacar, null — nunca undefined ni una cadena rara.
    assert.strictEqual(extractSentMessageId(null), null);
    assert.strictEqual(extractSentMessageId({}), null);
    assert.strictEqual(extractSentMessageId({ messages: [] }), null);
});
