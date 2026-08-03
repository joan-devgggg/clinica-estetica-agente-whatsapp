const assert = require('assert');
const { _internals } = require('../bot');
const { clearServiceState, SERVICE_STATE_DEFAULTS, SERVICE_PARTIAL_FIELDS, createEmptySession } = _internals;

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

// Valor "sucio" distinto del default, para cada campo de la fuente de verdad.
function dirtyValueFor(def) {
    if (typeof def === 'function') return ['DIRTY'];   // arrays (availableSlots, upsellingAccepted…)
    if (def === null) return 'DIRTY';
    if (def === false) return true;
    if (typeof def === 'number') return 99;
    return 'DIRTY';
}

function defaultValueOf(def) {
    return typeof def === 'function' ? def() : def;
}

// Construye una sesión contaminada: TODOS los campos de servicio con basura + campos
// de identidad/ciclo de vida que NO deben tocarse.
function makeDirtySession() {
    const session = { partialData: {} };
    for (const [k, def] of Object.entries(SERVICE_STATE_DEFAULTS)) {
        session[k] = dirtyValueFor(def);
    }
    for (const f of SERVICE_PARTIAL_FIELDS) {
        session.partialData[f] = 'DIRTY';
    }
    // Campos a PRESERVAR
    session.language = 'ru';
    session.preferredStylistId = 'stylist-123';
    session.lastStylist = 'Irina';
    session.ultimoServicio = 'Balayage';
    session.ultimaEstilista = 'Veronika';
    session.reservaConfirmada = true;
    session.appointmentId = 'appt-abc';
    session.leadId = 'lead-xyz';
    session.history = [{ role: 'user', content: 'hola' }];
    session.conversationStartedAt = 111;
    session.partialData.telefono = '34600000000';
    session.partialData.nombre = 'María';
    return session;
}

// ─── 1. Limpieza exhaustiva (data-driven desde la fuente de verdad) ────────────
test('clearServiceState limpia TODOS los campos de la fuente de verdad', () => {
    const session = makeDirtySession();
    clearServiceState(session);
    for (const [k, def] of Object.entries(SERVICE_STATE_DEFAULTS)) {
        assert.deepStrictEqual(session[k], defaultValueOf(def),
            `Campo de servicio "${k}" no quedó limpio tras clearServiceState`);
    }
    for (const f of SERVICE_PARTIAL_FIELDS) {
        assert.strictEqual(session.partialData[f], undefined,
            `partialData.${f} no quedó borrado tras clearServiceState`);
    }
});

// ─── 2. No sobre-limpia: identidad, contacto, idioma, historial y ciclo de vida ─
test('clearServiceState NO toca identidad ni ciclo de vida de reserva', () => {
    const session = makeDirtySession();
    clearServiceState(session);
    assert.strictEqual(session.language, 'ru');
    assert.strictEqual(session.preferredStylistId, 'stylist-123');
    assert.strictEqual(session.lastStylist, 'Irina');
    assert.strictEqual(session.ultimoServicio, 'Balayage');
    assert.strictEqual(session.ultimaEstilista, 'Veronika');
    assert.strictEqual(session.reservaConfirmada, true);
    assert.strictEqual(session.appointmentId, 'appt-abc');
    assert.strictEqual(session.leadId, 'lead-xyz');
    assert.strictEqual(session.conversationStartedAt, 111);
    assert.deepStrictEqual(session.history, [{ role: 'user', content: 'hola' }]);
    assert.strictEqual(session.partialData.telefono, '34600000000');
    assert.strictEqual(session.partialData.nombre, 'María');
});

// ─── 3. Candado: detecta campos de servicio nuevos no revisados ────────────────
// Si alguien añade un campo a SERVICE_STATE_DEFAULTS / SERVICE_PARTIAL_FIELDS sin
// actualizar esta lista esperada, el test falla → revisión consciente del alcance.
test('la fuente de verdad coincide con la lista esperada (candado anti-drift)', () => {
    const EXPECTED_TOP_LEVEL = [
        'selectedService', 'selectedStylist', 'selectedCategory',
        'anyStylists', 'prefiereMasCercano',
        'availableSlots', 'proposedSlots', 'currentSlotIndex', 'slotsProposed',
        'datePreferenceAsked', 'stylistQuestionAsked', 'stylistQuestionPending',
        'upsellingSuggested', 'upsellingAccepted',
        '_lastUpsellSuggestion', 'pendingLargoCategory', 'largoPelo',
        'pendingCorteGenero', 'pendingCorteMujerTipo', 'pendingCorteNinoTipo',
        'modoReagendamiento', 'reagendarAppointmentId', 'guestBooking', 'guestName',
        // Avisos de mención de estilista. Se limpian con el servicio a propósito:
        // "Larisa no hace este servicio" deja de ser cierto en cuanto cambia el
        // servicio, y una mención desconocida ya avisada no debe sobrevivir a un
        // reinicio del flujo (si la vuelve a pedir, se le vuelve a contestar).
        'stylistMentionUnknown', 'stylistMentionCorrected', 'stylistMentionNoSkill',
        'stylistMentionRejected',
        // Segunda reserva encadenada. Se limpian con el servicio a propósito: la categoría
        // pendiente y el ancla ("antes de la pedicura") describen LA petición en curso, y
        // arrastrarlas a la siguiente filtraría huecos por una cita que ya no viene a cuento.
        'pendingServiceCategory', 'anchorAppointment', 'anchorFilterVacio',
        // Consulta de valoración (categoría reactiva) y rescate del bucle "no sé qué
        // servicio quieres". Se limpian con el servicio a propósito: los tres describen
        // LA petición en curso. Arrastrar consultaValoracionDetectada dejaría abierta para
        // siempre la puerta por la que el LLM puede fijar el servicio reactivo, y una racha
        // heredada mandaría al menú de rescate en la primera pregunta de la 2ª reserva.
        'consultaValoracionDetectada', 'sinServicioStreak', 'consultaOfrecida',
    ];
    const EXPECTED_PARTIAL = [
        'servicio', 'categoria_servicio', 'estilista_preferida',
        'preferencia_horaria', 'fecha_cita', 'hora_cita', 'estado_cita', 'notas',
    ];
    assert.deepStrictEqual(
        Object.keys(SERVICE_STATE_DEFAULTS).sort(), [...EXPECTED_TOP_LEVEL].sort(),
        'SERVICE_STATE_DEFAULTS cambió: añade/quita el campo también en el test tras revisar su limpieza');
    assert.deepStrictEqual(
        [...SERVICE_PARTIAL_FIELDS].sort(), [...EXPECTED_PARTIAL].sort(),
        'SERVICE_PARTIAL_FIELDS cambió: revisa el nuevo campo de servicio en partialData');
});

// ─── 4. Coherencia con createEmptySession (evita typos / drift de defaults) ────
test('cada campo de servicio existe en una sesión nueva con su valor default', () => {
    const fresh = createEmptySession('34600000000@c.us', 'test-org', '34600000000');
    for (const [k, def] of Object.entries(SERVICE_STATE_DEFAULTS)) {
        assert.ok(k in fresh, `Campo "${k}" de la fuente de verdad falta en createEmptySession`);
        assert.deepStrictEqual(fresh[k], defaultValueOf(def),
            `createEmptySession inicializa "${k}" con un valor distinto al default de la fuente de verdad`);
    }
});

// bot.js deja un setInterval (GC) que mantiene vivo el event loop: forzamos la salida.
process.exit(process.exitCode || 0);
