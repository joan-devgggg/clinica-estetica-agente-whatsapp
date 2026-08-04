/**
 * tests/auditoria-cita.test.js — Auditoría mínima de appointments (migración 033).
 *
 * Una cita solo tenía `created_at`. Reagendar hace UPDATE in-place, cancelar cambia
 * `status`, el panel edita servicio y estilista: todo se pisa en el sitio. Cuando una
 * clienta decía "yo no pedí esa hora" no había NADA que mirar.
 *
 * Lo que se comprueba aquí es lo que la base de datos no puede saber sola (el trigger pone
 * `updated_at`, pero no quién ni desde dónde):
 *   · `updated_by` sale del actor que declara el llamante, y si no lo declara queda NULL —
 *     "no consta" — en vez de atribuírselo al bot por defecto.
 *   · `last_change` guarda el de → a de los campos que le importan a alguien, y NO se
 *     ensucia con los interruptores mecánicos de los workers.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const CITA = 'apt-1';

// Estado "previo" que devolverá la lectura de auditoría.
let filaPrevia = {
    starts_at: '2026-08-20T10:00:00.000Z',
    ends_at: '2026-08-20T11:00:00.000Z',
    service: 'Corte',
    status: 'confirmed',
    stylist_id: 'sty-1',
    notes: null,
};
let lecturaFalla = false;
const sqlCalls = [];

function makeBuilder() {
    const state = { table: null, op: 'select', payload: null, filters: [], single: false };
    const resolve = () => { sqlCalls.push(state); return Promise.resolve(respond(state)); };
    const b = {
        from(t) { state.table = t; return b; },
        select(cols) { state.cols = cols; return b; },
        insert(p) { state.op = 'insert'; state.payload = p; return b; },
        update(p) { state.op = 'update'; state.payload = p; return b; },
        eq(k, v) { state.filters.push(['eq', k, v]); return b; },
        neq() { return b; }, in() { return b; }, is() { return b; }, not() { return b; },
        lte() { return b; }, gte() { return b; }, or() { return b; }, order() { return b; }, limit() { return b; },
        single() { state.single = true; return resolve(); },
        maybeSingle() { state.single = true; return resolve(); },
        then(onF, onR) { return resolve().then(onF, onR); },
    };
    return b;
}

function respond(state) {
    const { table, op, single } = state;
    if (table === 'appointments' && op === 'update') {
        return { data: single ? { id: CITA, contact_id: 'c-1' } : [{ id: CITA }], error: null };
    }
    if (table === 'appointments') {
        if (lecturaFalla) return { data: null, error: { message: 'timeout', code: '57014' } };
        return { data: single ? { ...filaPrevia } : [{ ...filaPrevia }], error: null };
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

const updateDeCita = () => [...sqlCalls].reverse().find(c => c.table === 'appointments' && c.op === 'update');

test('mover una cita desde el panel deja quién y de dónde a dónde', async () => {
    sqlCalls.length = 0;
    await db.updateAppointment(ORG, CITA, {
        fecha: '2026-08-21', hora: '17:30', duracionMin: 60,
        actor: 'panel:11111111-2222-3333-4444-555555555555',
    });

    const upd = updateDeCita().payload;
    assert.strictEqual(upd.updated_by, 'panel:11111111-2222-3333-4444-555555555555');
    assert.ok(upd.last_change, 'falta last_change');
    assert.strictEqual(upd.last_change.by, 'panel:11111111-2222-3333-4444-555555555555');
    assert.strictEqual(upd.last_change.de.starts_at, '2026-08-20T10:00:00.000Z');
    assert.strictEqual(upd.last_change.a.starts_at, upd.starts_at);
    // No se cuela lo que no ha cambiado.
    assert.ok(!('service' in upd.last_change.de));
});

test('sin actor declarado, updated_by NO se toca: "no consta" ≠ "fue el bot"', async () => {
    sqlCalls.length = 0;
    await db.updateAppointment(ORG, CITA, { servicio: 'Balayage' });
    const upd = updateDeCita().payload;
    assert.ok(!('updated_by' in upd), 'no se debe inventar un autor');
    assert.strictEqual(upd.last_change.by, null);
    assert.strictEqual(upd.last_change.de.service, 'Corte');
    assert.strictEqual(upd.last_change.a.service, 'Balayage');
});

test('los interruptores de los workers no ensucian last_change', async () => {
    sqlCalls.length = 0;
    await db.updateAppointment(ORG, CITA, { resenaEnviada: true, actor: 'worker:review' });
    const upd = updateDeCita().payload;
    assert.strictEqual(upd.resena_enviada, true);
    assert.strictEqual(upd.updated_by, 'worker:review');
    // El último cambio de VERDAD (la hora, el servicio) tiene que sobrevivir a que un
    // worker marque una casilla mecánica.
    assert.ok(!('last_change' in upd), 'marcar reseña enviada no es un cambio auditable');
});

test('escribir el mismo valor no cuenta como cambio', async () => {
    sqlCalls.length = 0;
    await db.updateAppointment(ORG, CITA, { servicio: 'Corte', actor: 'bot' });
    const upd = updateDeCita().payload;
    assert.strictEqual(upd.service, 'Corte');
    assert.ok(!('last_change' in upd));
});

test('si no se puede leer el estado previo, el cambio se guarda igual', async () => {
    sqlCalls.length = 0;
    logs.length = 0;
    lecturaFalla = true;
    try {
        const r = await db.updateAppointment(ORG, CITA, { estado: 'cancelled', actor: 'bot' });
        assert.ok(r, 'la cancelación debe guardarse aunque no se pueda auditar');
    } finally {
        lecturaFalla = false;
    }
    const upd = updateDeCita().payload;
    assert.strictEqual(upd.status, 'cancelled');
    assert.ok(!('last_change' in upd));
    assert.ok(logs.some(l => l.evento === 'auditoria_cita_sin_estado_previo'));
});

test('el barrido que auto-completa citas firma su escritura', async () => {
    sqlCalls.length = 0;
    await db.autoCompleteAppointments(ORG);
    const upd = sqlCalls.find(c => c.table === 'appointments' && c.op === 'update');
    assert.strictEqual(upd.payload.status, 'completed');
    assert.strictEqual(upd.payload.updated_by, 'worker:auto-complete');
});
