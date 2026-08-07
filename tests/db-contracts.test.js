// Contratos de la capa de datos (db.js) sin Supabase real: se inyecta un cliente FALSO
// encadenable por require-cache ANTES de requerir db.js, y se asertan los payloads exactos
// enviados a supabase (mapeo de campos → columnas). Cubre items 5/6/8 (updateAppointment) y
// 9 (no_show + setBlacklist). Hermético: cero red.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');

// ─── Cliente Supabase falso: builder encadenable + thenable ───────────────────────────
// Reproduce la API fluida usada por db.js: from().update()/insert()/delete().eq().neq()
// .in().not().gte().lte().order().select().single()/.maybeSingle(). Es thenable para que
// `await ...eq()` resuelva.
// Registra cada llamada resuelta en `calls` con {table, op, payload, filters}.
//
// Los filtros se registran TAL CUAL los pide db.js, sin interpretarlos. Esa es la diferencia
// que importa: un doble que reimplementa el filtro en JavaScript afirma lo que el doble hace,
// no lo que la consulta pide, y por eso no puede ver que a la consulta le falte un filtro.
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
            in(k, v) { state.filters.push(['in', k, v]); return b; },
            // `.not(col, op, val)` lleva un operador extra; se guarda plano ("is true") para
            // que la aserción se lea igual que la llamada.
            not(k, op, v) { state.filters.push(['not', k, `${op} ${v}`]); return b; },
            gte(k, v) { state.filters.push(['gte', k, v]); return b; },
            lte(k, v) { state.filters.push(['lte', k, v]); return b; },
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
        // Devuelve una fila porque estas escrituras llevan .select('id'): tienen que comprobar
        // que el UPDATE tocó algo, no solo que Supabase no dio error.
        mock.setResponder(() => ({ data: [{ id: 'c1' }], error: null }));
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

    // Mover una cita sin duración se resolvía con un 120 por defecto. No era una cita
    // nueva mal medida: REDIMENSIONABA una existente, y la diferencia se publicaba como
    // agenda libre encima de la clienta. Ahora no se escribe nada.
    await test('6 · updateAppointment que mueve la cita SIN duración → null, sin update', async () => {
        for (const mala of [undefined, null, 0, '', 'sesenta', -30]) {
            const before = mock.calls.length;
            const r = await db.updateAppointment('org', 'apt-1', { fecha: '2026-07-14', hora: '10:00', duracionMin: mala });
            assert.strictEqual(r, null, `duracionMin=${JSON.stringify(mala)} no puede pasar por buena`);
            assert.strictEqual(mock.calls.length, before, 'no llega a llamar a supabase');
        }
    });

    await test('6 · un update que NO mueve la cita sigue sin necesitar duración', async () => {
        mock.setResponder(() => ({ data: { id: 'apt-1' }, error: null }));
        const r = await db.updateAppointment('org', 'apt-1', { estado: 'completed' });
        assert.ok(r, 'cambiar estado no recalcula ends_at, así que no exige duración');
    });

    await test('6 · updateAppointment con fecha/hora inválida → null, sin update', async () => {
        const before = mock.calls.length;
        const r = await db.updateAppointment('org', 'apt-1', { fecha: 'nope', hora: '99:99' });
        assert.strictEqual(r, null, 'no actualiza si la fecha/hora es inválida');
        assert.strictEqual(mock.calls.length, before, 'no llega a llamar a supabase');
    });

    await test('saveAppointment SIN duración → null, y ningún INSERT en appointments', async () => {
        mock.setResponder(() => ({ data: { id: 'c1' }, error: null }));   // findById encuentra el contacto
        for (const mala of [undefined, null, 0, '', 'sesenta', -30]) {
            const r = await db.saveAppointment('org', 'c1', { servicio: 'Corte', fecha: '2026-07-14', hora: '10:00', duracionMin: mala });
            assert.strictEqual(r, null, `duracionMin=${JSON.stringify(mala)}`);
        }
        assert.ok(!mock.calls.some(c => c.op === 'insert' && c.table === 'appointments'),
            'ninguna cita escrita con una duración inventada');
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

    // ── recordatorio_enviado: debe resetearse en cada (re)confirmación, no solo en el alta ──
    // Antes de este fix se ponía a true la primera vez (marcarRecordatorioSent) y nunca volvía
    // a false, así que una clienta recurrente dejaba de recibir recordatorio en su 2ª visita.
    await test('updateLead(estado_cita: confirmado) resetea recordatorio_enviado a false', async () => {
        mock.setResponder((state) => {
            if (state.op === 'update') return { data: [{ id: 'contact-1' }], error: null };
            return { data: { id: 'contact-1', full_name: 'Ana' }, error: null }; // findById (select/maybeSingle)
        });
        await db.updateLead('org', { leadId: 'contact-1', estado_cita: 'confirmado' });
        const c = lastCall();
        assert.strictEqual(c.op, 'update');
        assert.strictEqual(c.payload.estado, 'confirmado');
        assert.strictEqual(c.payload.recordatorio_enviado, false);
    });

    await test('updateLead sin cambio de estado_cita NO toca recordatorio_enviado', async () => {
        mock.setResponder((state) => {
            if (state.op === 'update') return { data: [{ id: 'contact-1' }], error: null };
            return { data: { id: 'contact-1' }, error: null };
        });
        await db.updateLead('org', { leadId: 'contact-1', notas: 'x' });
        const c = lastCall();
        assert.ok(!('recordatorio_enviado' in c.payload), 'no debe fijar el campo si no cambia estado_cita');
    });

    await test('updateLeadById(estado_cita: confirmado) también resetea recordatorio_enviado (confirm manual del panel)', async () => {
        mock.setResponder((state) => {
            if (state.op === 'update') return { error: null };
            return { data: { id: 'contact-1' }, error: null };
        });
        await db.updateLeadById('org', 'contact-1', { estado_cita: 'confirmado' });
        const c = mock.calls.find((x) => x.op === 'update' && x.payload && 'estado' in x.payload);
        assert.ok(c, 'debe haber un UPDATE con estado');
        assert.strictEqual(c.payload.recordatorio_enviado, false);
    });

    // ── Caja: los filtros de «pendientes de cobrar» los pide la CONSULTA ──────────────
    //
    // Este bloque existe porque el 07/08/2026 los tres filtros —lista blanca de estado,
    // no-show y `no_facturable`— se añadieron a `getAppointmentsByDateRange` (la lista de
    // Reservas) creyendo que era la consulta de Caja. Caja llama a `getCitasDelDiaParaCaja`,
    // que se quedó con `neq('cancelled')` a secas. Efecto en producción: un no-show y una
    // cita marcada «esta cita no se cobra» seguían saliendo en «pendientes de cobrar», que
    // es exactamente lo que la casilla del panel promete evitar.
    //
    // `tests/caja-pendientes.test.js` no podía cazarlo y no es culpa suya: sustituye la
    // función por un doble para poder probar el ENDPOINT, así que afirma que el endpoint
    // respeta lo que le dan, nunca que la consulta lo pida. Aquí se afirma lo otro: los
    // filtros exactos que db.js le manda a Supabase. Quita uno de db.js y esto se pone rojo.
    await test('caja · getCitasDelDiaParaCaja filtra estado, no_show y no_facturable EN LA CONSULTA', async () => {
        mock.setResponder(() => ({ data: [], error: null }));
        await db.getCitasDelDiaParaCaja('org', '2026-08-07');
        const c = lastCall();
        assert.strictEqual(c.table, 'appointments');

        const estado = c.filters.find(f => f[0] === 'in' && f[1] === 'status');
        assert.ok(estado, 'lista BLANCA de estados: un `neq(cancelled)` deja entrar solo a '
            + 'cualquier estado nuevo, y `no_show` ya se colaba así');
        assert.deepStrictEqual(estado[2], ['confirmed', 'completed']);

        // `not(is true)` y NO `eq(false)`: no_show es NULLABLE y un NULL es "no consta que
        // faltara" — con eq(false) esas citas desaparecerían de Caja sin motivo visible.
        assert.ok(c.filters.some(f => f[0] === 'not' && f[1] === 'no_show' && f[2] === 'is true'),
            'el no-show por BOOLEANO, que es la otra forma en que updateAppointment lo escribe');

        assert.ok(c.filters.some(f => f[0] === 'eq' && f[1] === 'no_facturable' && f[2] === false),
            'sin esto, la casilla «esta cita no se cobra» no hace nada en Caja');

        // Y que el arreglo no se haya llevado por delante el día ni la org.
        assert.ok(c.filters.some(f => f[0] === 'eq' && f[1] === 'organization_id'), 'multi-tenant');
        assert.ok(c.filters.some(f => f[0] === 'gte' && f[1] === 'starts_at'), 'desde');
        assert.ok(c.filters.some(f => f[0] === 'lte' && f[1] === 'starts_at'), 'hasta');
    });

    // La hermana de la que salieron los filtros. Se afirma también, para que quede dicho que
    // las dos consultas responden a la misma pregunta y tienen que moverse juntas.
    await test('reservas · getAppointmentsByDateRange mantiene los mismos tres filtros', async () => {
        mock.setResponder(() => ({ data: [], error: null }));
        await db.getAppointmentsByDateRange('org', '2026-08-07', '2026-08-07');
        const c = lastCall();
        assert.strictEqual(c.table, 'appointments');
        assert.deepStrictEqual(
            c.filters.find(f => f[0] === 'in' && f[1] === 'status')?.[2],
            ['confirmed', 'completed'],
        );
        assert.ok(c.filters.some(f => f[0] === 'not' && f[1] === 'no_show' && f[2] === 'is true'));
        assert.ok(c.filters.some(f => f[0] === 'eq' && f[1] === 'no_facturable' && f[2] === false));
    });

    if (!process.exitCode) console.log('\nTodos los tests de contratos db OK');
    process.exit(process.exitCode || 0);
})();
