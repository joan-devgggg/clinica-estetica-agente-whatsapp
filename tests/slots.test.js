const assert = require('assert');
const { _internals } = require('../bot');
const { parseSlotSelection, normalizeHora, resolveSalonConfirmation, llmClaimsBooked } = _internals;

function test(name, fn) {
    try {
        fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

// Silencia los console.log [DIAG ...] de resolveSalonConfirmation durante los tests.
function quiet(fn) {
    const orig = console.log;
    console.log = () => {};
    try { return fn(); } finally { console.log = orig; }
}

const slotsTarde = [
    { fecha: '2026-06-23', hora: '14:00', stylistId: 'a', stylistName: 'Veronika' },
    { fecha: '2026-06-23', hora: '15:00', stylistId: 'a', stylistName: 'Veronika' },
    { fecha: '2026-06-23', hora: '16:00', stylistId: 'a', stylistName: 'Veronika' },
];

// ─── Fix 2: "a las 2" = 14:00, no "opción 2" ───────────────────────────────────

test('"a las 2" se interpreta como las 14:00 (no como opción 2)', () => {
    const slot = parseSlotSelection('a las 2', slotsTarde);
    assert.strictEqual(slot.hora, '14:00');
});

test('"a las 4" se interpreta como las 16:00', () => {
    const slot = parseSlotSelection('a las 4', slotsTarde);
    assert.strictEqual(slot.hora, '16:00');
});

test('"a las 15" coincide con el hueco de 15:00', () => {
    const slot = parseSlotSelection('a las 15', slotsTarde);
    assert.strictEqual(slot.hora, '15:00');
});

test('"el 2" sigue siendo opción 2 cuando ninguna hora encaja', () => {
    const slotsManana = [
        { fecha: '2026-06-23', hora: '10:00', stylistId: 'a' },
        { fecha: '2026-06-23', hora: '11:00', stylistId: 'a' },
        { fecha: '2026-06-23', hora: '12:00', stylistId: 'a' },
    ];
    const slot = parseSlotSelection('el 2', slotsManana);
    assert.strictEqual(slot.hora, '11:00'); // segunda opción
});

test('"el primero" devuelve el primer hueco', () => {
    const slot = parseSlotSelection('el primero', slotsTarde);
    assert.strictEqual(slot.hora, '14:00');
});

test('normalizeHora interpreta "2" como las 14:00 (salón trabaja de tarde)', () => {
    assert.strictEqual(normalizeHora('2'), '14:00');
    assert.strictEqual(normalizeHora('14:30'), '14:30');
});

// ─── Bug 1: una FECHA sin hora ("1 de julio") no es selección de hueco ─────────

test('parseSlotSelection: "el 1 de julio" (fecha sin hora) → null, no opción/hora', () => {
    const slots = [
        { fecha: '2026-07-01', hora: '13:00', stylistId: 'a', stylistName: 'Veronika' },
        { fecha: '2026-07-01', hora: '14:00', stylistId: 'a', stylistName: 'Veronika' },
    ];
    assert.strictEqual(parseSlotSelection('el 1 de julio', slots), null);
});

test('resolveSalonConfirmation: "1 de julio" no autoconfirma (día, no hora elegida)', () => {
    const slots = [
        { fecha: '2026-07-01', hora: '13:00', stylistId: 'a', stylistName: 'Veronika' },
        { fecha: '2026-07-01', hora: '14:00', stylistId: 'a', stylistName: 'Veronika' },
    ];
    const session = {
        reservaConfirmada: false, selectedService: { nombre: 'Corte' },
        availableSlots: slots, slotsProposed: true, proposedSlots: slots, currentSlotIndex: 0,
    };
    // El LLM extrae hora_cita "1" desde "1 de julio"; sin la guarda, normalizeHora lo
    // volvería 13:00 y reservaría ese hueco sin que la clienta eligiera hora.
    const ai = { respuesta: 'te he reservado', reserva_confirmada: false, datos: { hora_cita: '1' } };
    const res = quiet(() => resolveSalonConfirmation(session, ai, '1 de julio', slots));
    assert.strictEqual(res, null);
});

// ─── Fix 1: red de seguridad anti-fallo-silencioso ─────────────────────────────

test('llmClaimsBooked detecta frases de confirmación (con y sin tilde)', () => {
    assert.strictEqual(llmClaimsBooked('¡Listo! Te he reservado tu cita 😊'), true);
    assert.strictEqual(llmClaimsBooked('Tu cita queda confirmada para mañana'), true);
    assert.strictEqual(llmClaimsBooked('Está reservado para el lunes'), true);
    assert.strictEqual(llmClaimsBooked('Perfecto, cita confirmada'), true);
    assert.strictEqual(llmClaimsBooked('¿A qué hora te viene mejor?'), false);
});

test('resolveSalonConfirmation guarda cuando el texto confirma pero falta el flag', () => {
    const session = {
        reservaConfirmada: false,
        selectedService: { nombre: 'Corte' },
        availableSlots: slotsTarde,
        slotsProposed: true,
        currentSlotIndex: 0,
    };
    const aiResponse = { respuesta: '¡Te he reservado tu cita! 😊', reserva_confirmada: false, datos: {} };
    // sanitized neutral (no afirmativo, no posicional) para forzar la rama (4) de texto.
    // frozenProposed con UN solo hueco → pickChosenSlot lo resuelve sin ambigüedad.
    const res = quiet(() => resolveSalonConfirmation(session, aiResponse, 'muchas gracias', [slotsTarde[0]]));
    assert.ok(res, 'debería devolver un slot');
    assert.strictEqual(res.motivo, 'texto_llm_confirma');
    assert.strictEqual(res.slot.hora, '14:00');
});

test('resolveSalonConfirmation NO confirma si el texto no afirma reserva y no hay aceptación', () => {
    const session = {
        reservaConfirmada: false,
        selectedService: { nombre: 'Corte' },
        availableSlots: slotsTarde,
        slotsProposed: true,
        currentSlotIndex: 0,
    };
    const aiResponse = { respuesta: '¿Cuál de estos horarios te viene mejor?', reserva_confirmada: false, datos: {} };
    const res = quiet(() => resolveSalonConfirmation(session, aiResponse, 'no se'));
    assert.strictEqual(res, null);
});

test('resolveSalonConfirmation respeta los guardias (sin huecos → null)', () => {
    const session = {
        reservaConfirmada: false,
        selectedService: { nombre: 'Corte' },
        availableSlots: [],
        slotsProposed: true,
        currentSlotIndex: 0,
    };
    const aiResponse = { respuesta: 'Te he reservado tu cita', reserva_confirmada: true, datos: {} };
    const res = quiet(() => resolveSalonConfirmation(session, aiResponse, 'si'));
    assert.strictEqual(res, null);
});

// bot.js deja un setInterval (GC) que mantiene vivo el event loop: forzamos la salida.
process.exit(process.exitCode || 0);
