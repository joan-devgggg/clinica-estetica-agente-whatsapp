/**
 * tests/cancelacion-llm-confirma.test.js — El caso Celeste González (06/08/2026).
 *
 * Reservó una consulta a las 11:03:59. A las 11:04:51 escribió «No entiendo» y «Cancélala»,
 * confundida por el bloque de promoción que lleva el mensaje de confirmación. El bot se la
 * canceló a los **60 segundos de crearla, sin preguntar** (`last_change.by = 'bot'` en la fila
 * de appointments). Siete minutos después seguía queriendo el servicio: «Me gustaría sacarme
 * el color negro del cabello». No hay ninguna cita.
 *
 * La guarda existía y no era la que falló: el camino determinista recita la cita y espera un
 * sí desde el 04/08 (`a3e5bdd`). Lo que pasó es que había DOS caminos para la misma acción y
 * solo uno llevaba la guarda — el `accion:'cancelar'` del modelo se descartaba únicamente
 * cuando NO había `session.appointmentId`, o sea justo cuando no había nada que cancelar.
 * Ella acababa de reservar, así que lo tenía, y se ejecutó.
 *
 * Lo que se afirma aquí es el ESTADO, no la redacción: que la escritura NO ocurre y que queda
 * armado `pendingCitaAccion`. Un test sobre las palabras del mensaje no habría distinguido
 * «¿te la cancelo?» de «cancelada ✅».
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');

// ─── Doble de Supabase (mismo molde que citas-existentes-flujo) ──────────────
let filasPorTabla = {};
let errorPorTabla = {};

function makeQuery(tabla) {
    let singular = false;
    const api = {
        select() { return api; }, eq() { return api; }, in() { return api; },
        neq() { return api; }, gte() { return api; }, lte() { return api; },
        order() { return api; }, limit() { return api; }, update() { return api; },
        insert() { return api; }, delete() { return api; },
        maybeSingle() { singular = true; return api; },
        single() { singular = true; return api; },
        then(res, rej) {
            const error = errorPorTabla[tabla] || null;
            const filas = filasPorTabla[tabla] || [];
            const data = error ? null : (singular ? (filas[0] || null) : filas);
            return Promise.resolve({ data, error }).then(res, rej);
        },
    };
    return api;
}
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true, exports: { from: makeQuery },
};

const calendarSante = require('../services/calendar-sante');
const { cancelarConConfirmacion, handleAppointmentAction } = require('../bot')._internals;

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const TEL = '34603734833';   // el de Celeste

function filaCita({ id = 'apt-celeste', service = 'Consulta', starts = '2026-08-12T13:00:00+02:00',
    ends = '2026-08-12T13:20:00+02:00', stylist = 'Natalia' } = {}) {
    return {
        id, service, starts_at: starts, ends_at: ends, status: 'confirmed',
        stylist_id: 's-natalia', stylists: stylist ? { name: stylist } : null,
    };
}

function sesion(extra = {}) {
    return {
        orgId: ORG, orgType: 'salon', leadId: 'c-celeste', language: 'es',
        reservaConfirmada: true, appointmentId: 'apt-celeste',
        selectedService: null, selectedStylist: null,
        slotsProposed: false, citaEnCurso: null, pendingCitaAccion: null,
        pendingEscalation: false, upsellingAccepted: [],
        partialData: { nombre: 'Celeste González', telefono: TEL },
        history: [],
        ...extra,
    };
}

async function turno(session, texto) {
    const enviados = [];
    const client = {
        sendMessage: async (_to, t) => { enviados.push(t); },
        getChatById: async () => ({ sendStateTyping: async () => {} }),
    };
    const _send = async (t) => { enviados.push(t); };
    const manejado = await cancelarConConfirmacion(client, ORG, session, texto, _send, TEL);
    return { manejado, enviados, session, texto: enviados.join('\n') };
}

// Cuántas veces se ha intentado tocar la agenda de verdad.
let cancelaciones = [];
function reset() {
    filasPorTabla = { contacts: [{ id: 'c-celeste', wa_phone: TEL, created_at: '2025-01-01T00:00:00Z' }] };
    errorPorTabla = {};
    cancelaciones = [];
}

const results = [];
async function test(name, fn) {
    reset();
    const original = calendarSante.cancelAppointment;
    calendarSante.cancelAppointment = async (orgId, id) => { cancelaciones.push(id); return { success: true }; };
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
    finally { calendarSante.cancelAppointment = original; }
    results.push(name);
}

async function main() {

await test('EL CASO: "Cancélala" del LLM pregunta, y NO cancela', async () => {
    filasPorTabla.appointments = [filaCita()];
    const r = await turno(sesion(), 'No entiendo\nCancélala');

    assert.strictEqual(r.manejado, true, 'el turno se resuelve aquí, sin llegar a handleAppointmentAction');
    assert.strictEqual(cancelaciones.length, 0,
        'esto es lo que pasó de verdad: la cita se canceló 60 s después de crearla, sin preguntar');
    assert.ok(r.session.pendingCitaAccion, 'tiene que quedar armada la confirmación');
    assert.strictEqual(r.session.pendingCitaAccion.estado, 'confirmar');
    assert.strictEqual(r.session.pendingCitaAccion.accion, 'cancelar');
    assert.strictEqual(r.session.pendingCitaAccion.cita.id, 'apt-celeste');
});

await test('la pregunta RECITA la cita: sin fecha ni hora, un "sí" no significa nada', async () => {
    filasPorTabla.appointments = [filaCita()];
    const r = await turno(sesion(), 'cancela');
    assert.ok(/13:00/.test(r.texto), `falta la hora: ${r.texto}`);
    assert.ok(/Consulta/.test(r.texto), `falta el servicio: ${r.texto}`);
    assert.ok(!/cancelada/i.test(r.texto), 'no puede anunciar una cancelación que no ha ocurrido');
});

await test('con DOS citas vivas no se adivina cuál: se pregunta cuál', async () => {
    filasPorTabla.appointments = [
        filaCita({ id: 'apt-1', service: 'Consulta', starts: '2026-08-12T13:00:00+02:00', ends: '2026-08-12T13:20:00+02:00' }),
        filaCita({ id: 'apt-2', service: 'Manicura + gel', starts: '2026-08-14T11:00:00+02:00', ends: '2026-08-14T13:00:00+02:00' }),
    ];
    const r = await turno(sesion(), 'cancélamela');

    assert.strictEqual(cancelaciones.length, 0);
    assert.strictEqual(r.session.pendingCitaAccion.estado, 'elegir');
    assert.strictEqual(r.session.pendingCitaAccion.opciones.length, 2);
});

await test('sin ninguna cita viva NO se dice "cancelada": se dice que no consta ninguna', async () => {
    filasPorTabla.appointments = [];
    const r = await turno(sesion({ appointmentId: 'apt-fantasma' }), 'cancela mi cita');

    assert.strictEqual(cancelaciones.length, 0);
    assert.ok(/no me consta/i.test(r.texto), `debía decir que no hay cita: ${r.texto}`);
    assert.strictEqual(r.session.pendingCitaAccion, null);
});

await test('si la agenda NO se puede leer, tampoco se afirma nada', async () => {
    // Es la cita fantasma en versión escritura: cancelar sin haber podido mirar.
    errorPorTabla.appointments = { message: 'timeout', code: '57014' };
    filasPorTabla.appointments = [filaCita()];
    const r = await turno(sesion(), 'cancela mi cita');

    assert.strictEqual(cancelaciones.length, 0);
    assert.ok(!/cancelada/i.test(r.texto));
    assert.ok(!/no me consta/i.test(r.texto), '"no tienes cita" sin haber leído es la misma mentira');
});

await test('la pista que NO casa con ninguna cita no cancela la que había', async () => {
    filasPorTabla.appointments = [filaCita()];   // la suya es a las 13:00
    const r = await turno(sesion(), 'cancela la cita de las 17:00');

    assert.strictEqual(cancelaciones.length, 0);
    assert.strictEqual(r.session.pendingCitaAccion, null, 'no se arma sobre una cita que ella no ha nombrado');
});

await test('el sí posterior SÍ cancela: la confirmación no es un callejón sin salida', async () => {
    // Cierra el circuito con el camino determinista, que es quien consume pendingCitaAccion.
    const { handleCitasExistentes } = require('../bot')._internals;
    filasPorTabla.appointments = [filaCita()];

    const s = sesion();
    await turno(s, 'cancela mi cita');
    assert.strictEqual(s.pendingCitaAccion.estado, 'confirmar');

    const enviados = [];
    const client = { sendMessage: async (_t, x) => { enviados.push(x); }, getChatById: async () => ({ sendStateTyping: async () => {} }) };
    await handleCitasExistentes(client, ORG, s, 'sí', async t => { enviados.push(t); }, TEL);

    assert.deepStrictEqual(cancelaciones, ['apt-celeste'], 'con el sí de la clienta sí se cancela');
    assert.ok(/cancelada/i.test(enviados.join('\n')));
});

await test('y el NO la deja viva', async () => {
    const { handleCitasExistentes } = require('../bot')._internals;
    filasPorTabla.appointments = [filaCita()];

    const s = sesion();
    await turno(s, 'cancela mi cita');

    const enviados = [];
    const client = { sendMessage: async (_t, x) => { enviados.push(x); }, getChatById: async () => ({ sendStateTyping: async () => {} }) };
    await handleCitasExistentes(client, ORG, s, 'no, mejor no', async t => { enviados.push(t); }, TEL);

    assert.strictEqual(cancelaciones.length, 0);
    assert.strictEqual(s.pendingCitaAccion, null);
});

// ─── La guarda estructural ──────────────────────────────────────────────────
// Los tests de arriba prueban la función nueva; estos prueban que la VIEJA ya no puede
// cancelar aunque alguien la llame. La guarda vive dentro de handleAppointmentAction y no
// en el call site justamente para esto: un camino nuevo no puede reabrir el agujero.

await test('GUARDA: handleAppointmentAction ya no cancela para el salón, ni con appointmentId', async () => {
    filasPorTabla.appointments = [filaCita()];
    const enviados = [];
    const client = { sendMessage: async (_t, x) => { enviados.push(x); }, getChatById: async () => ({ sendStateTyping: async () => {} }) };

    const s = sesion();   // reservaConfirmada + appointmentId: el estado exacto de Celeste
    const handled = await handleAppointmentAction(client, s, TEL, 'cancelar', 'Tu cita ha sido cancelada ✅');

    assert.strictEqual(handled, false, 'tiene que rechazar el turno, no ejecutarlo');
    assert.strictEqual(cancelaciones.length, 0, 'era el estado con el que se canceló la de Celeste');
    assert.strictEqual(s.appointmentId, 'apt-celeste', 'y no puede borrar la cita de la sesión');
    assert.ok(!/cancelada/i.test(enviados.join('\n')), 'ni anunciar nada');
});

await test('REGLA DE ORO: San Remo sigue cancelando por su camino de siempre', async () => {
    const enviados = [];
    const client = { sendMessage: async (_t, x) => { enviados.push(x); }, getChatById: async () => ({ sendStateTyping: async () => {} }) };
    const s = sesion({ orgType: 'restaurant', appointmentId: 'apt-sanremo' });

    const handled = await handleAppointmentAction(client, s, TEL, 'cancelar', 'ok');
    assert.strictEqual(handled, true, 'el restaurante no se toca');
    assert.ok(/cancelada/i.test(enviados.join('\n')));
});

console.log(`\nTodos los tests de cancelación por accion del LLM OK (${results.length})`);
}

main();
