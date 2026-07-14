// Cobertura offline de flujos de reserva del salón (partes DETERMINISTAS, sin WhatsApp/LLM).
// Items 5 (cancelar+reset), 6 (detectar reagendar), 7 (2ª reserva), 8 (aceptar upsell),
// 10 (recurrente vs nueva). Hermético: fake creds Supabase + mock de db.*, nunca red real.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
    detectIntent, wantsAnotherBooking, detectGuestBooking, extractGuestName, wantsRestart,
    extractServiceFromText,
} = require('../services/helpers');
const calendarSante = require('../services/calendar-sante');
const db = require('../services/db');
const {
    clearServiceState, resetForSecondBooking, isUpsellingAcceptance, matchesServiceName,
    stylistCanDoService, assignStylistIfAppropriate,
} = require('../bot')._internals;

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}
async function testAsync(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}
async function withMockedNow(iso, fn) {
    const R = Date;
    class M extends R { constructor(...a) { if (a.length === 0) { super(iso); return; } super(...a); } static now() { return new R(iso).getTime(); } }
    global.Date = M;
    try { return await fn(); } finally { global.Date = R; }
}

// Sesión de salón "confirmada" con identidad + estado de servicio, para probar los resets.
function sesionConfirmada() {
    return {
        orgId: 'org', orgType: 'salon',
        reservaConfirmada: true, appointmentId: 'apt-1', leadId: 'L1', language: 'es',
        selectedService: { nombre: 'Corte mujer', categoria: 'Cortes', duracion: 60 },
        selectedStylist: { id: 's1', name: 'Ana' },
        upsellingAccepted: [], upsellingSuggested: true, _lastUpsellSuggestion: 'K18',
        partialData: { nombre: 'María', telefono: '34600', servicio: 'Corte mujer', hora_cita: '10:00', fecha_cita: '2026-07-14' },
    };
}

// ─── Item 5: CANCELAR + volver a reservar ─────────────────────────────────────────────
test('5 · detectIntent reconoce cancelar/anular', () => {
    assert.strictEqual(detectIntent('quiero cancelar mi cita'), 'cancelar');
    assert.strictEqual(detectIntent('anular la reserva'), 'cancelar');
});

testAsync('5 · cancelAppointment llama db.updateAppointment con estado cancelled', async () => {
    const calls = [];
    const orig = db.updateAppointment;
    db.updateAppointment = async (orgId, id, campos) => { calls.push({ orgId, id, campos }); return { id, status: 'cancelled' }; };
    try {
        const r = await calendarSante.cancelAppointment('org', 'apt-1');
        assert.deepStrictEqual(r, { success: true });
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0], { orgId: 'org', id: 'apt-1', campos: { estado: 'cancelled' } });
    } finally { db.updateAppointment = orig; }
});

test('5 · tras cancelar, clearServiceState limpia el servicio pero conserva identidad', () => {
    const s = sesionConfirmada();
    clearServiceState(s);
    assert.strictEqual(s.selectedService, null, 'servicio limpio');
    assert.strictEqual(s.selectedStylist, null, 'estilista limpia');
    assert.strictEqual(s.partialData.servicio, undefined, 'partialData.servicio borrado');
    assert.strictEqual(s.partialData.hora_cita, undefined, 'hora borrada');
    // Identidad/idioma/contacto intactos → la nueva reserva arranca sin re-preguntar todo.
    assert.strictEqual(s.partialData.nombre, 'María');
    assert.strictEqual(s.leadId, 'L1');
    assert.strictEqual(s.language, 'es');
});

// ─── Item 6: REAGENDAR (parte determinista: detección) ────────────────────────────────
test('6 · detectIntent reconoce cambiar/mover/reagendar', () => {
    assert.strictEqual(detectIntent('quiero cambiar la hora'), 'cambiar');
    assert.strictEqual(detectIntent('podemos mover mi cita'), 'cambiar');
    assert.strictEqual(detectIntent('reagendar para otro dia'), 'cambiar');
});

// ─── Item 7: SEGUNDA reserva en la misma conversación ─────────────────────────────────
test('7 · wantsAnotherBooking / detectGuestBooking / wantsRestart (positivos y negativos)', () => {
    assert.ok(wantsAnotherBooking('quiero otra cita para mi amiga'));
    assert.ok(wantsAnotherBooking('reservar otra para otra persona'));
    assert.ok(!wantsAnotherBooking('tengo una duda sobre mi cita'));
    assert.ok(detectGuestBooking('es para mi madre'));
    assert.ok(!detectGuestBooking('para mí a las 5'));
    assert.ok(wantsRestart('mejor empezar de nuevo'));
    assert.ok(!wantsRestart('quiero una cita'));
});

test('7 · extractGuestName saca el nombre del acompañante', () => {
    assert.strictEqual(extractGuestName('es para mi amiga María'), 'María');
    assert.strictEqual(extractGuestName('se llama Ana'), 'Ana');
});

test('7 · resetForSecondBooking limpia la reserva y conserva identidad; fija guest', () => {
    const s = sesionConfirmada();
    resetForSecondBooking(s, 'quiero otra cita para mi amiga Lucía');
    assert.strictEqual(s.reservaConfirmada, false);
    assert.strictEqual(s.appointmentId, null);
    assert.strictEqual(s.selectedService, null, 'servicio limpio para la 2ª reserva');
    assert.strictEqual(s.partialData.nombre, 'María', 'el nombre del titular se conserva');
    assert.strictEqual(s.guestBooking, true);
    assert.strictEqual(s.guestName, 'Lucía');
});

// ─── Item 8: ACEPTAR upselling (reconocimiento + no confundir con 2ª reserva) ─────────
test('8 · isUpsellingAcceptance: afirmaciones cortas SÍ, negaciones/otras NO', () => {
    for (const t of ['sí', 'si', 'dale', 'vale', 'ok', 'genial', 'añádelo', 'sí, por favor', 'yes', 'да']) {
        assert.ok(isUpsellingAcceptance(t), `debería aceptar: "${t}"`);
    }
    for (const t of ['no', 'no vale', 'cuánto cuesta', 'quiero un corte']) {
        assert.ok(!isUpsellingAcceptance(t), `NO debería aceptar: "${t}"`);
    }
});

test('8 · matchesServiceName: caso/subcadena/tokens (nombres multi-carácter)', () => {
    assert.ok(matchesServiceName('k18', 'Tratamiento K18'), 'subcadena');
    assert.ok(matchesServiceName('Reconstrucción molecular K18', 'k18'), 'subcadena inversa');
    assert.ok(matchesServiceName('Pro Miracle', 'pro-miracle repair'), 'guion→espacio en token largo (miracle)');
    assert.ok(!matchesServiceName('corte', 'k18'), 'servicios distintos no casan');
});

test('8 · "quiero el k18" / "sí k18" resuelven al servicio y casan con el upsell pendiente (no es 2ª reserva)', () => {
    const catalog = [
        { nombre: 'Corte mujer', categoria: 'Cortes', duracion: 60, precio: 25 },
        { nombre: 'K18', categoria: 'Reconstrucción', duracion: 30, precio: 20 },
    ];
    const _lastUpsellSuggestion = 'K18';
    // Mismo camino que el guard esUpsellDetectado de bot.js: extraer servicio y comparar.
    for (const msg of ['quiero el k18', 'sí k18', 'me pones el k18']) {
        const svc = extractServiceFromText(msg, catalog);
        assert.ok(svc, `resuelve el servicio en "${msg}"`);
        assert.ok(matchesServiceName(svc.nombre, _lastUpsellSuggestion), `"${msg}" casa con el upsell pendiente`);
    }
});

// FIX 2: separador (guion/espacio) dentro del código corto. matchesServiceName ignora
// separadores internos, así que "k-18"/"k 18" ≡ "k18". La aceptación de upsell casa el TEXTO
// CRUDO contra el upsell pendiente, cubriendo el caso aunque extractServiceFromText no resuelva.
test('8 · FIX separador: "k-18"/"k 18" se reconocen como el upsell K18', () => {
    assert.ok(matchesServiceName('k18', 'k-18'), 'k18 ≡ k-18');
    assert.ok(matchesServiceName('k18', 'k 18'), 'k18 ≡ k 18');
    // Texto crudo del mensaje contra el nombre del upsell pendiente (el brazo nuevo del bot).
    assert.ok(matchesServiceName('quiero el k-18', 'K18'), 'mensaje con guion casa el upsell');
    assert.ok(matchesServiceName('sí, ponme el k 18', 'K18'), 'mensaje con espacio casa el upsell');
    // No debe casar con algo no relacionado (guarda de ≥3 chars sin separadores).
    assert.ok(!matchesServiceName('quiero un corte', 'K18'), 'servicio distinto no casa');
});

// ─── Item 10: CLIENTA RECURRENTE (preferredStylistId) vs NUEVA ─────────────────────────
function mockTwoStylistsDistinctDays() {
    // Ana trabaja lunes; Bea trabaja martes. Ambas hacen Cortes. Sin citas ni bloqueos.
    const ANA = { id: 'ana', name: 'Ana', active: true, skills: ['Cortes'] };
    const BEA = { id: 'bea', name: 'Bea', active: true, skills: ['Cortes'] };
    db.getStylistsByOrg = async () => [ANA, BEA];
    db.getStylistSchedule = async (orgId, id) => (id === 'ana'
        ? [{ day_of_week: 0, start_time: '10:00:00', end_time: '19:00:00' }]   // lunes
        : [{ day_of_week: 1, start_time: '10:00:00', end_time: '19:00:00' }]); // martes
    db.getBlockedDays = async () => [];
    db.getScheduleBlocks = async () => [];
    db.getAppointmentsByStylistAndRange = async () => [];
    return { ANA, BEA };
}

(async () => {
    // ── Item 6 (FIX 1): reagendar MUEVE la cita, no crea una segunda ──
    await testAsync('6 · reagendar hace UPDATE in-place y NO crea una segunda cita (sin saveAppointment)', async () => {
        const updateCalls = [], saveCalls = [];
        const origU = db.updateAppointment, origS = db.saveAppointment;
        db.updateAppointment = async (orgId, id, campos) => { updateCalls.push({ orgId, id, campos }); return { id }; };
        db.saveAppointment = async (...a) => { saveCalls.push(a); return { id: 'NUEVA' }; };
        try {
            const slotNuevo = { fecha: '2026-07-16', hora: '12:00', stylistId: 'ana' };
            const r = await calendarSante.rescheduleAppointment('org', 'apt-existente', slotNuevo,
                { servicio: 'Corte mujer', duracionMin: 60, stylistId: 'ana' });
            assert.strictEqual(r.success, true);
            assert.strictEqual(r.appointmentId, 'apt-existente', 'conserva el id de la cita existente');
            assert.strictEqual(saveCalls.length, 0, 'NO se crea una segunda cita (saveAppointment no se llama)');
            assert.strictEqual(updateCalls.length, 1, 'se actualiza la cita existente una vez');
            assert.strictEqual(updateCalls[0].id, 'apt-existente');
            assert.strictEqual(updateCalls[0].campos.fecha, '2026-07-16');
            assert.strictEqual(updateCalls[0].campos.hora, '12:00');
        } finally { db.updateAppointment = origU; db.saveAppointment = origS; }
    });

    const { ANA } = mockTwoStylistsDistinctDays();

    await testAsync('10 · recurrente: con preferredStylistId todos los huecos son de esa estilista', async () => {
        await withMockedNow('2026-07-13T06:00:00Z', async () => { // lunes
            const slots = await calendarSante.getAvailableSlots('org', {
                serviceDuration: 60, serviceCategory: 'Cortes', preferredStylistId: ANA.id, preferencia: {},
            });
            assert.ok(slots.length > 0, 'la estilista preferida tiene huecos');
            assert.ok(slots.every(s => s.stylistId === ANA.id), 'solo huecos de la preferida');
        });
    });

    await testAsync('10 · nueva: sin preferida aparecen las dos estilistas', async () => {
        await withMockedNow('2026-07-13T06:00:00Z', async () => {
            const slots = await calendarSante.getAvailableSlots('org', {
                serviceDuration: 60, serviceCategory: 'Cortes', preferredStylistId: null, preferencia: {},
            });
            const distintas = new Set(slots.map(s => s.stylistId));
            assert.ok(distintas.size >= 2, 'sin preferencia se ofrecen huecos de varias estilistas');
        });
    });

    test('10 · assignStylistIfAppropriate fija la única elegible; stylistCanDoService filtra por skill', () => {
        const s = { selectedService: { categoria: 'Cortes' }, selectedStylist: null, anyStylists: false, prefiereMasCercano: false };
        assignStylistIfAppropriate(s, [ANA]);
        assert.ok(s.selectedStylist && s.selectedStylist.id === ANA.id, 'una sola elegible → asignada');
        assert.ok(stylistCanDoService(ANA, { categoria: 'Cortes' }));
        assert.ok(!stylistCanDoService(ANA, { categoria: 'Masajes y SPA' }));
    });

    if (!process.exitCode) console.log('\nTodos los tests de flujos de reserva OK');
    process.exit(process.exitCode || 0);
})();
