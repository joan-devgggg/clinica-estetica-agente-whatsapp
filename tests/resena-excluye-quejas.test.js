// La cola de reseñas no puede incluir a quien se ha quejado (06/08/2026).
//
// `getCompletedAppointmentsForReview` solo filtraba por `is_blacklisted`. Una clienta con
// `escalation_reason = 'queja_cita'` y su escalada sin resolver entraba en la cola como
// cualquier otra y recibía su petición de reseña de Google 2 h después de la cita. El caso
// real (Tania Daza, 03/08/2026) no llegó a dispararse solo porque su `resena_enviada` estaba
// en true — puesto ahí por OTRO fallo, el del botón del panel que marcaba sin enviar.
//
// Y la mitad que también importa: `bot_mode = 'manual'` NO puede excluir. Con Coexistence
// casi toda conversación atendida desde el móvil acaba en manual, así que excluirlo mataría
// las reseñas de casi todas las clientas. "La atiende una persona" no es "se ha quejado".
//
// Hermético: Supabase falso en require.cache, cero red.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');

const control = { failTables: new Set(), rows: {} };

function makeBuilder(tabla) {
    const run = () => (control.failTables.has(tabla)
        ? { data: null, error: { code: 'PGRST301', message: `simulated failure on ${tabla}` } }
        : { data: control.rows[tabla] ?? [], error: null });
    const b = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'then') return (onF, onR) => Promise.resolve(run()).then(onF, onR);
            if (prop === 'maybeSingle' || prop === 'single') {
                return () => ({ then: (onF, onR) => Promise.resolve(run()).then(onF, onR) });
            }
            return () => b;
        },
    });
    return b;
}

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from: (t) => makeBuilder(t) },
};

const db = require('../services/db');
const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Una cita completada lista para reseña. `over` toca solo lo del contacto.
function cita(id, nombre, contacto = {}) {
    return {
        id, full_name: nombre, phone: '34600000000', status: 'completed',
        resena_enviada: false, ends_at: '2026-08-03T12:00:00Z',
        contact_id: `c-${id}`,
        contacts: {
            id: `c-${id}`, full_name: nombre, wa_phone: '34600000000', language: 'es',
            metadata: {}, is_blacklisted: false, escalation_reason: null,
            ...contacto,
        },
    };
}

const nombres = filas => filas.map(f => f.full_name).sort();

// ─── Lo que se pedía ─────────────────────────────────────────────────────────

test('una clienta con queja abierta (escalation_reason) NO entra en la cola', async () => {
    control.failTables.clear();
    control.rows = {
        appointments: [
            cita('a1', 'Ana Normal'),
            cita('a2', 'Tania Quejada', { escalation_reason: 'queja_cita' }),
        ],
        pending_actions: [],
    };
    const cola = await db.getCompletedAppointmentsForReview(ORG, 2);
    assert.deepStrictEqual(nombres(cola), ['Ana Normal'],
        'pedirle una reseña pública a quien se acaba de quejar es rematar la queja');
});

test('una clienta con pending_action de escalada sin resolver tampoco entra', async () => {
    control.failTables.clear();
    control.rows = {
        appointments: [
            cita('a1', 'Ana Normal'),
            // Sin escalation_reason en el contacto, pero con la escalada viva en la cola.
            cita('a2', 'Berta Escalada'),
        ],
        pending_actions: [{ contact_id: 'c-a2' }],
    };
    const cola = await db.getCompletedAppointmentsForReview(ORG, 2);
    assert.deepStrictEqual(nombres(cola), ['Ana Normal']);
});

test('bot_mode = "manual" SÍ entra: no es lo mismo que quejarse', async () => {
    control.failTables.clear();
    control.rows = {
        appointments: [
            cita('a1', 'Ana Normal'),
            cita('a2', 'Carmen Atendida', { bot_mode: 'manual' }),
        ],
        pending_actions: [],
    };
    const cola = await db.getCompletedAppointmentsForReview(ORG, 2);
    assert.deepStrictEqual(nombres(cola), ['Ana Normal', 'Carmen Atendida'],
        'con Coexistence casi todo acaba en manual: excluirlo mataría casi todas las reseñas');
});

test('manual Y con queja: manda la queja', async () => {
    control.failTables.clear();
    control.rows = {
        appointments: [cita('a1', 'Dolores', { bot_mode: 'manual', escalation_reason: 'queja_cita' })],
        pending_actions: [],
    };
    assert.deepStrictEqual(await db.getCompletedAppointmentsForReview(ORG, 2), []);
});

// ─── Lo que ya funcionaba y no se puede romper ───────────────────────────────

test('la lista negra sigue excluyendo', async () => {
    control.failTables.clear();
    control.rows = {
        appointments: [cita('a1', 'Ana Normal'), cita('a2', 'Eva Bloqueada', { is_blacklisted: true })],
        pending_actions: [],
    };
    assert.deepStrictEqual(nombres(await db.getCompletedAppointmentsForReview(ORG, 2)), ['Ana Normal']);
});

test('sin nadie excluido devuelve todas', async () => {
    control.failTables.clear();
    control.rows = {
        appointments: [cita('a1', 'Ana'), cita('a2', 'Bea'), cita('a3', 'Cris')],
        pending_actions: [],
    };
    assert.deepStrictEqual(nombres(await db.getCompletedAppointmentsForReview(ORG, 2)), ['Ana', 'Bea', 'Cris']);
});

test('cola vacía no consulta escaladas ni revienta', async () => {
    control.failTables.clear();
    control.rows = { appointments: [], pending_actions: [] };
    assert.deepStrictEqual(await db.getCompletedAppointmentsForReview(ORG, 2), []);
});

// ─── El default de la guarda va al lado recuperable ──────────────────────────

test('si no se puede leer quién tiene queja, no se manda NINGUNA reseña', async () => {
    control.failTables = new Set(['pending_actions']);
    control.rows = {
        appointments: [cita('a1', 'Ana Normal'), cita('a2', 'Tania Quejada')],
        pending_actions: [],
    };
    // Lanza en vez de devolver la lista sin filtrar. Una reseña de menos se recupera al tic
    // siguiente; una reseña a quien se acaba de quejar, no.
    await assert.rejects(
        () => db.getCompletedAppointmentsForReview(ORG, 2),
        /pending_actions/,
        'una lectura fallida no puede leerse como "no hay quejas"');
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
