// El sellado del importe ya no puede fallar entero sin que nadie se entere (06/08/2026).
//
// Hallazgo 🟠 4 de docs/auditoria-afirmar-sin-verificar.md. Dos cosas de la misma familia:
//
//   · `stampBillingSnapshot` devolvía `n` y los dos llamadores lo tiraban, así que "sellé 10
//     de 10" y "sellé 1 de 10" eran el mismo resultado visible.
//   · El `catch` de `autoCompleteAppointments` solo escribía un log. Las citas quedaban
//     `completed` sin importe congelado y el informe se degradaba a recalcular desde el
//     catálogo — que es la degradación correcta, pero es EXACTAMENTE el escenario contra el
//     que existe el snapshot: si alguien sube un precio antes de que nadie mire, ese periodo
//     cerrado se factura al precio nuevo y nadie sabrá que pasó.
//
// Lo que se congela aquí: el desglose sale de la función, el fallo llega a una persona, y
// nada de esto propaga (las citas SÍ están completadas y el panel merece su 200).
//
// Hermético: cliente Supabase falso por require-cache, Telegram stubeado. Cero red.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// Telegram va primero: admin-alerts DESESTRUCTURA notifyOrgAdmin al cargarse, así que se queda
// con la referencia de este momento. Por eso el stub delega en una variable mutable: cambiar
// `exports.notifyOrgAdmin` más tarde no tendría ningún efecto.
let avisos = [];
let notificar = async (orgId, mensaje) => { avisos.push({ orgId, mensaje }); return true; };
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: { notifyOrgAdmin: (orgId, mensaje) => notificar(orgId, mensaje) },
};

// ─── Cliente Supabase falso (mismo patrón que tests/cita-multiservicio.test.js) ───
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
            select() { return b; },
            eq(k, v) { state.filters.push(['eq', k, v]); return b; },
            is(k, v) { state.filters.push(['is', k, v]); return b; },
            in(k, v) { state.filters.push(['in', k, v]); return b; },
            gte() { return b; }, lte() { return b; },
            order() { return b; }, limit() { return b; },
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
        reset() { calls.length = 0; },
    };
}

const mock = makeSupabaseMock();
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: mock.client };

const db = require('../services/db');
const { _resetThrottle } = require('../services/admin-alerts');

const CATALOGO = [{ nombre: 'Corte mujer', precio: 30, duracion: 45 }];

function citasPendientes(n) {
    return Array.from({ length: n }, (_, i) => ({
        id: `apt-${i + 1}`, service: 'Corte mujer', facturado_at: null, stylists: { name: 'Irina' },
    }));
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function arrancar() {
    mock.reset();
    avisos = [];
    _resetThrottle();
    db._clearConfigCache?.();
}

// ─── El desglose ─────────────────────────────────────────────────────────────

test('devuelve {intentadas, selladas, fallidas} — no un número que no distingue nada', async () => {
    arrancar();
    mock.setResponder((s) => {
        if (s.table === 'agent_configs') return { data: { services: CATALOGO }, error: null };
        if (s.table === 'appointments' && s.op === null) return { data: citasPendientes(3), error: null };
        return { data: null, error: null };
    });

    const r = await db.stampBillingSnapshot(ORG, ['apt-1', 'apt-2', 'apt-3']);
    assert.deepStrictEqual(r, { intentadas: 3, selladas: 3, fallidas: 0 });
    assert.strictEqual(avisos.length, 0, 'sin fallo no se molesta a nadie');
});

test('sellar 1 de 3 se ve en el retorno Y llega a una persona', async () => {
    arrancar();
    let updates = 0;
    mock.setResponder((s) => {
        if (s.table === 'agent_configs') return { data: { services: CATALOGO }, error: null };
        if (s.table === 'appointments' && s.op === null) return { data: citasPendientes(3), error: null };
        if (s.table === 'appointments' && s.op === 'update') {
            updates++;
            return updates === 1
                ? { data: null, error: null }
                : { data: null, error: { message: 'permission denied for table appointments', code: '42501' } };
        }
        return { data: null, error: null };
    });

    const r = await db.stampBillingSnapshot(ORG, ['apt-1', 'apt-2', 'apt-3']);
    assert.deepStrictEqual(r, { intentadas: 3, selladas: 1, fallidas: 2 },
        'antes esto devolvía 1, indistinguible de "una cita y todo bien"');
    assert.strictEqual(avisos.length, 1, 'un aviso, no dos: es "el sellado falla", no una cita');
    assert.ok(/importes/i.test(avisos[0].mensaje));
    assert.ok(/precios de HOY/i.test(avisos[0].mensaje),
        'el aviso tiene que explicar POR QUÉ importa: el informe pasa a recalcular');
});

test('sin ids o sin citas que sellar no hay aviso ni ruido', async () => {
    arrancar();
    mock.setResponder(() => ({ data: [], error: null }));
    assert.deepStrictEqual(await db.stampBillingSnapshot(ORG, []), { intentadas: 0, selladas: 0, fallidas: 0 });
    assert.deepStrictEqual(await db.stampBillingSnapshot(ORG, ['apt-1']), { intentadas: 0, selladas: 0, fallidas: 0 });
    assert.strictEqual(avisos.length, 0);
});

// ─── El catch de autoCompleteAppointments ────────────────────────────────────

test('REGRESIÓN · si el sellado revienta entero, las citas se completan igual Y se avisa', async () => {
    arrancar();
    mock.setResponder((s) => {
        // El UPDATE que completa las citas: bien.
        if (s.table === 'appointments' && s.op === 'update' && s.payload?.status === 'completed') {
            return { data: [{ id: 'apt-1', contact_id: null }], error: null };
        }
        // La LECTURA de stampBillingSnapshot: caída. assertRead lanza.
        if (s.table === 'appointments' && s.op === null) {
            return { data: null, error: { message: 'TypeError: fetch failed', code: '' } };
        }
        return { data: null, error: null };
    });

    const citas = await db.autoCompleteAppointments(ORG);
    assert.strictEqual(citas.length, 1, 'completar la cita es lo que importaba y sigue pasando');
    assert.strictEqual(avisos.length, 1, 'antes esto solo dejaba un logger.error que nadie lee');
    assert.ok(/importes/i.test(avisos[0].mensaje));
});

test('el aviso se throttlea por día: un barrido que falla cada 5 min no son 288 Telegrams', async () => {
    arrancar();
    mock.setResponder((s) => {
        if (s.table === 'appointments' && s.op === 'update' && s.payload?.status === 'completed') {
            return { data: [{ id: 'apt-1', contact_id: null }], error: null };
        }
        if (s.table === 'appointments' && s.op === null) {
            return { data: null, error: { message: 'TypeError: fetch failed', code: '' } };
        }
        return { data: null, error: null };
    });

    await db.autoCompleteAppointments(ORG);
    await db.autoCompleteAppointments(ORG);
    await db.autoCompleteAppointments(ORG);
    assert.strictEqual(avisos.length, 1);
});

test('que el aviso falle no puede tumbar el barrido', async () => {
    arrancar();
    const original = notificar;
    notificar = async () => { throw new Error('telegram 500'); };
    try {
        mock.setResponder((s) => {
            if (s.table === 'appointments' && s.op === 'update' && s.payload?.status === 'completed') {
                return { data: [{ id: 'apt-1', contact_id: null }], error: null };
            }
            if (s.table === 'appointments' && s.op === null) {
                return { data: null, error: { message: 'TypeError: fetch failed', code: '' } };
            }
            return { data: null, error: null };
        });
        const citas = await db.autoCompleteAppointments(ORG);
        assert.strictEqual(citas.length, 1, 'la cita se completa aunque el aviso reviente');
        assert.strictEqual(avisos.length, 0, 'y no se registró ningún aviso: de verdad falló');
    } finally {
        notificar = original;
    }
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { fallos++; console.error(`FALLO - ${name}\n   ${e.message}`); }
    }
    console.log(fallos ? `\n❌ ${fallos} fallo(s)` : `\n✅ ${tests.length} en verde`);
    process.exit(fallos ? 1 : 0);
})();
