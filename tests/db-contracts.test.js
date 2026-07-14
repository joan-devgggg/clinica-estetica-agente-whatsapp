// Contratos de la capa de datos (db.js) sin Supabase real: se inyecta un cliente FALSO
// encadenable por require-cache ANTES de requerir db.js, y se asertan los payloads exactos
// enviados a supabase (mapeo de campos → columnas). Cubre items 5/6/8 (updateAppointment) y
// 9 (no_show + setBlacklist). Hermético: cero red.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');

// ─── Cliente Supabase falso: builder encadenable + thenable ───────────────────────────
// Reproduce la API fluida usada por db.js: from().update()/insert()/delete().eq().neq()
// .order().select().single()/.maybeSingle(). Es thenable para que `await ...eq()` resuelva.
// Registra cada llamada resuelta en `calls` con {table, op, payload, filters}.
function makeSupabaseMock() {
    const calls = [];
    let responder = () => ({ data: null, error: null });
    function makeBuilder() {
        const state = { table: null, op: null, payload: null, filters: [] };
        const resolve = () => { calls.push(state); return Promise.resolve(responder(state)); };
        const b = {
            from(t) { state.table = t; return b; },
            update(p) { state.op = 'update'; state.payload = p; return b; },
            insert(p) { state.op = 'insert'; state.payload = p; return b; },
            delete() { state.op = 'delete'; return b; },
            select() { return b; },
            eq(k, v) { state.filters.push(['eq', k, v]); return b; },
            neq(k, v) { state.filters.push(['neq', k, v]); return b; },
            order() { return b; },
            single() { return resolve(); },
            maybeSingle() { return resolve(); },
            then(onF, onR) { return resolve().then(onF, onR); },
        };
        return b;
    }
    return {
        client: { from(t) { return makeBuilder().from(t); } },
        calls,
        setResponder(fn) { responder = fn; },
    };
}

const mock = makeSupabaseMock();
// Inyectar ANTES de requerir db.js (db.js hace `const supabase = require('./supabase')`).
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: mock.client };

const db = require('../services/db');

async function test(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}
const lastCall = () => mock.calls[mock.calls.length - 1];

(async () => {
    // Se ejecutan EN SERIE: comparten mock.calls/responder, así que el orden garantiza que
    // lastCall() sea el de este test.

    // ── Item 9: no_show marca no_show + status ──
    await test('9 · updateAppointment({estado:no_show}) → {status:no_show, no_show:true}', async () => {
        mock.setResponder(() => ({ data: { id: 'apt-1' }, error: null }));
        await db.updateAppointment('org', 'apt-1', { estado: 'no_show' });
        const c = lastCall();
        assert.strictEqual(c.table, 'appointments');
        assert.strictEqual(c.op, 'update');
        assert.strictEqual(c.payload.status, 'no_show');
        assert.strictEqual(c.payload.no_show, true);
        assert.ok(c.filters.some(f => f[1] === 'id' && f[2] === 'apt-1'), 'filtra por id');
        assert.ok(c.filters.some(f => f[1] === 'organization_id'), 'filtra por organization_id');
    });

    // ── Item 9: setBlacklist / removeBlacklist ──
    await test('9 · setBlacklist → contacts {is_blacklisted:true, blacklist_reason}', async () => {
        mock.setResponder(() => ({ data: null, error: null }));
        const r = await db.setBlacklist('org', 'c1', 'No-show');
        const c = lastCall();
        assert.strictEqual(r, true);
        assert.strictEqual(c.table, 'contacts');
        assert.strictEqual(c.payload.is_blacklisted, true);
        assert.strictEqual(c.payload.blacklist_reason, 'No-show');
        assert.ok(c.filters.some(f => f[1] === 'id' && f[2] === 'c1'));
    });

    await test('9 · removeBlacklist → {is_blacklisted:false, blacklist_reason:null}', async () => {
        await db.removeBlacklist('org', 'c1');
        const c = lastCall();
        assert.strictEqual(c.payload.is_blacklisted, false);
        assert.strictEqual(c.payload.blacklist_reason, null);
    });

    // ── Item 5: cancelar mapea a status cancelled ──
    await test('5 · updateAppointment({estado:cancelled}) → {status:cancelled}', async () => {
        mock.setResponder(() => ({ data: { id: 'apt-1' }, error: null }));
        await db.updateAppointment('org', 'apt-1', { estado: 'cancelled' });
        const c = lastCall();
        assert.strictEqual(c.payload.status, 'cancelled');
        assert.ok(!('no_show' in c.payload), 'cancelar NO toca no_show');
    });

    // ── Item 6: reagendar in-place recalcula starts_at/ends_at ──
    await test('6 · updateAppointment({fecha,hora,duracionMin}) recalcula starts_at/ends_at', async () => {
        mock.setResponder(() => ({ data: { id: 'apt-1' }, error: null }));
        await db.updateAppointment('org', 'apt-1', { fecha: '2026-07-14', hora: '10:00', duracionMin: 60 });
        const c = lastCall();
        assert.ok(c.payload.starts_at, 'fija starts_at');
        assert.ok(c.payload.ends_at, 'fija ends_at');
        const dur = new Date(c.payload.ends_at) - new Date(c.payload.starts_at);
        assert.strictEqual(dur, 60 * 60 * 1000, 'ends_at - starts_at = duracionMin (TZ-independiente)');
    });

    await test('6 · updateAppointment con fecha/hora inválida → null, sin update', async () => {
        const before = mock.calls.length;
        const r = await db.updateAppointment('org', 'apt-1', { fecha: 'nope', hora: '99:99' });
        assert.strictEqual(r, null, 'no actualiza si la fecha/hora es inválida');
        assert.strictEqual(mock.calls.length, before, 'no llega a llamar a supabase');
    });

    // ── Item 8: fusión de upsell = UPDATE (servicio + ends_at), NO insert ──
    await test('8 · updateAppointment({servicio, endsAt}) → UPDATE service/ends_at (no INSERT)', async () => {
        mock.setResponder(() => ({ data: { id: 'apt-1' }, error: null }));
        await db.updateAppointment('org', 'apt-1', { servicio: 'Corte mujer + K18', endsAt: '2026-07-14T12:00:00.000Z' });
        const c = lastCall();
        assert.strictEqual(c.op, 'update', 'es UPDATE, no INSERT → no duplica cita');
        assert.strictEqual(c.payload.service, 'Corte mujer + K18');
        assert.strictEqual(c.payload.ends_at, '2026-07-14T12:00:00.000Z');
    });

    if (!process.exitCode) console.log('\nTodos los tests de contratos db OK');
    process.exit(process.exitCode || 0);
})();
