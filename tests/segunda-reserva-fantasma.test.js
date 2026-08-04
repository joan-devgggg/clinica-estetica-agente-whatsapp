// Regresión del bug del 30/07/2026: "cita fantasma".
//
// Conversación real (Sante): pedicura Japonesa con Olgha el jueves 6/08 a las 16:00 —
// guardada OK. En el MISMO hilo: "Quiero un masaje antes de la pedicura" → "completo" →
// el bot anunció "✅ Perfecto, Joan. Citas reservadas: 15:00 masaje… 16:00 pedicura".
// En Supabase solo existía la de las 16:00, y el masaje lo asignó a Olgha, que solo hace
// Manicura/Pedicura (los masajes son de Larisa).
//
// Tres defectos encadenados, uno por bloque de este fichero:
//   A · llmClaimsBooked no cazaba el plural → el mensaje pasaba todas las redes.
//   B · el detector de 2ª reserva no disparaba con una categoría ambigua ("un masaje").
//   C · con reservaConfirmada=true se apagaban TODAS las redes anti-mentira.
//
// Hermético: sin red, sin LLM, sin Supabase. Solo helpers puros y _internals de bot.js.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
    extractServiceFromText, extractServiceCategoriesFromText, extractAnchorConstraint,
    wantsAnotherBooking, detectIntent, buildCitaFantasmaMsg, normalizeText,
} = require('../services/helpers');
const {
    llmClaimsBooked, asksForBookingApproval, unbackedBookingClaim, applyAnchorFilter, resetForSecondBooking,
    matchesServiceName, isUpsellingAcceptance, SERVICE_STATE_DEFAULTS,
} = require('../bot')._internals;

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// Recorte del catálogo REAL de Sante: las dos categorías implicadas más una tercera que
// comparte la palabra "completo" (la que hacía fracasar la resolución de "completo").
const CATALOGO = [
    { nombre: 'Japonesa', categoria: 'Manicura/Pedicura', precio: 25, duracion: 50 },
    { nombre: 'Pedicura higiénica', categoria: 'Manicura/Pedicura', precio: 35, duracion: 50 },
    { nombre: 'Pedicura + esmaltado', categoria: 'Manicura/Pedicura', precio: 45, duracion: 60 },
    { nombre: 'Manicura + gel', categoria: 'Manicura/Pedicura', precio: 35, duracion: 60 },
    { nombre: 'Relajante completo', categoria: 'Masajes y SPA', precio: 70, duracion: 60 },
    { nombre: 'Espalda y hombros', categoria: 'Masajes y SPA', precio: 45, duracion: 45 },
    { nombre: 'Deportivo', categoria: 'Masajes y SPA', precio: 65, duracion: 60 },
    { nombre: 'Holistic relajante Premium', categoria: 'Masajes y SPA', precio: 95, duracion: 90 },
    { nombre: 'Color completo largo 1', categoria: 'Color Premium', precio: 90, duracion: 120 },
    { nombre: 'Color completo largo 2', categoria: 'Color Premium', precio: 110, duracion: 150 },
    { nombre: 'K18', categoria: 'Reconstrucción', precio: 35, duracion: 60 },
];

// Sesión tal y como quedó tras confirmar la pedicura de las 16:00.
function sesionPedicuraConfirmada() {
    return {
        orgId: 'org', orgType: 'salon', leadId: 'L1', language: 'es',
        reservaConfirmada: true, appointmentId: 'apt-16',
        selectedService: { nombre: 'Japonesa', categoria: 'Manicura/Pedicura', precio: 25, duracion: 50 },
        selectedStylist: { id: 'olgha', nombre: 'Olgha' },
        upsellingAccepted: [], upsellingSuggested: false, _lastUpsellSuggestion: null,
        availableSlots: [], proposedSlots: [], currentSlotIndex: 0,
        partialData: { nombre: 'Joan Gascon', telefono: '34600', servicio: 'Japonesa', fecha_cita: '2026-08-06', hora_cita: '16:00' },
    };
}

// Réplica exacta de la lógica de detección de bot.js (bloque "Salon: segunda reserva").
// Sin esto habría que arrancar el motor entero; aquí interesa la DECISIÓN, no el I/O.
function detectaSegundaReserva(session, sanitized, catalogo) {
    const intent = detectIntent(sanitized);
    let nuevaReserva = wantsAnotherBooking(sanitized);
    let categoriaNueva = null;
    if (!nuevaReserva) {
        const svcNuevo = extractServiceFromText(sanitized, catalogo);
        const esUpsellDetectado = svcNuevo && (
            (session.upsellingSuggested && session._lastUpsellSuggestion &&
                matchesServiceName(svcNuevo.nombre, session._lastUpsellSuggestion)) ||
            (session.upsellingAccepted || []).some(u => matchesServiceName(svcNuevo.nombre, u))
        );
        if (!esUpsellDetectado && svcNuevo && svcNuevo.nombre !== session.selectedService?.nombre) {
            nuevaReserva = true;
        }
        if (!nuevaReserva && !svcNuevo) {
            const catActual = normalizeText(session.selectedService?.categoria || '');
            const upsellPend = session._lastUpsellSuggestion || '';
            const cats = extractServiceCategoriesFromText(sanitized, catalogo)
                .filter(c => normalizeText(c) !== catActual)
                .filter(c => !(upsellPend && matchesServiceName(c, upsellPend)))
                .filter(c => !(session.upsellingAccepted || []).some(u => matchesServiceName(c, u)));
            if (cats.length) { nuevaReserva = true; categoriaNueva = cats[0]; }
        }
    }
    if (session.upsellingSuggested && session._lastUpsellSuggestion && isUpsellingAcceptance(sanitized)) {
        nuevaReserva = false;
    }
    if (intent === 'cancelar' || intent === 'cambiar') nuevaReserva = false;
    return { nuevaReserva, categoriaNueva };
}

// ─── A · llmClaimsBooked: el plural que dejó pasar la mentira ──────────────────
const MSG_FANTASMA = '✅ Perfecto, Joan. Citas reservadas para el jueves 6 de agosto:\n\n'
    + '💆 15:00 – Masaje relajante completo con Olgha\n💰 70€ · 60 minutos\n\n'
    + '💅 16:00 – Pedicura Japonesa con Olgha\n💰 25€ · 50 minutos\n\n'
    + '🙏 Recuerda avisar con 48h si necesitas cancelar o cambiar.';

test('A · llmClaimsBooked caza el mensaje REAL que anunció la cita fantasma (plural)', () => {
    assert.strictEqual(llmClaimsBooked(MSG_FANTASMA), true);
});

test('A · sigue cazando el singular y las variantes que ya cubría', () => {
    for (const m of [
        '✅ Perfecto, Joan Gascon. Cita reservada:',
        'Entonces te apunto masaje a las 15:00 y pedicura a las 16:00. ¿Te va bien así?',
        'Tu cita queda confirmada',
        'Ya está reservado',
        'Ambas citas están confirmadas',
        "You're booked for Thursday",
        'Я записала вас на четверг',
        'Бронювання підтверджено',
    ]) assert.strictEqual(llmClaimsBooked(m), true, `no cazó: ${m}`);
});

test('A · NO caza mensajes que solo proponen o preguntan', () => {
    for (const m of [
        '¿Qué día te viene mejor?',
        'Tengo el jueves a las 10:00, 11:00 y 12:00. ¿Te viene bien alguno?',
        'Genial 😊 ¿Qué tipo de masaje te apetece?',
        'Las pedicuras las hace Olgha. Trabaja martes, jueves y viernes.',
    ]) assert.strictEqual(llmClaimsBooked(m), false, `falso positivo: ${m}`);
});

// ─── A · Una PROPUESTA no es una promesa ───────────────────────────────────────
// Regresión de un fallo introducido al añadir la red: disparaba con "te apunto… ¿Te va
// bien?" —que es una propuesta— y rectificaba a mitad de conversación, descarrilando el
// flujo (el bot respondía "todavía no tengo ninguna cita apuntada" a su propia propuesta).
test('A · una propuesta pendiente de aprobación NO se rectifica', () => {
    for (const m of [
        'Perfecto, te apunto manicura + gel el jueves, 6 de agosto a las 10:00 con Olgha. Son 35€. ¿Te va bien? 😊',
        'Te reservo el martes a las 11:00 con Irina, ¿te viene bien?',
        'Te lo apunto para el jueves. ¿Lo confirmo?',
        'I have booked you Thursday at 10:00. Is that ok?',
    ]) {
        assert.strictEqual(llmClaimsBooked(m), true, `sigue siendo una afirmación de reserva: ${m}`);
        assert.strictEqual(asksForBookingApproval(m), true, `pero pide aprobación: ${m}`);
    }
});

test('A · un cierre en falso NO se confunde con una propuesta', () => {
    for (const m of [
        MSG_FANTASMA, // termina en "🙏 Recuerda avisar con 48h…"
        '✅ Perfecto, Joan. Citas reservadas para el jueves.\n\n¿Necesitas algo más?',
        'Ya te la he reservado. ¿Algo más en lo que pueda ayudarte?',
    ]) {
        assert.strictEqual(llmClaimsBooked(m), true, `debe leerse como afirmación: ${m}`);
        assert.strictEqual(asksForBookingApproval(m), false,
            `una pregunta de cortesía final no puede colar un cierre falso: ${m}`);
    }
});

// ─── A · unbackedBookingClaim: contraste contra las citas REALES ───────────────
test('A · unbackedBookingClaim detecta las 15:00 anunciadas sin cita escrita', () => {
    assert.deepStrictEqual(unbackedBookingClaim(MSG_FANTASMA, ['16:00']), ['15:00']);
});

test('A · con las dos citas realmente guardadas, no marca nada', () => {
    assert.deepStrictEqual(unbackedBookingClaim(MSG_FANTASMA, ['15:00', '16:00']), []);
});

test('A · el mensaje determinista de UNA cita pasa limpio (no se autobloquea)', () => {
    const ok = '✅ Perfecto, Joan Gascon. Cita reservada:\n\n📅 Jueves 6 de agosto a las 16:00\n'
        + '💅 Japonesa con Olgha\n💰 25€ · 50 minutos\n\n🙏 Avísanos con 48h de antelación.';
    assert.deepStrictEqual(unbackedBookingClaim(ok, ['16:00']), []);
});

test('A · sin ninguna cita guardada, TODA hora anunciada queda sin respaldo', () => {
    assert.deepStrictEqual(unbackedBookingClaim(MSG_FANTASMA, []), ['15:00', '16:00']);
});

test('A · el mensaje de rectificación solo enumera citas reales', () => {
    const msg = buildCitaFantasmaMsg({
        citasReales: [{ servicio: 'Japonesa', fecha: '2026-08-06', hora: '16:00' }],
        language: 'es',
    });
    assert.ok(msg.includes('16:00'), 'debe nombrar la cita que SÍ existe');
    assert.ok(!msg.includes('15:00'), 'nunca debe nombrar la cita fantasma');
    assert.ok(/NO ha quedado reservado/.test(msg), 'debe decir que lo demás no está reservado');
    assert.strictEqual(llmClaimsBooked(msg), false, 'el mensaje de rectificación no puede afirmar una reserva');
});

// ─── B · Detector de segunda reserva ──────────────────────────────────────────
test('B · el mensaje real "Quiero un masaje antes de la pedicura" dispara la 2ª reserva', () => {
    const s = sesionPedicuraConfirmada();
    // Precondición del bug: ni el servicio ni las frases explícitas resolvían nada.
    assert.strictEqual(extractServiceFromText('Quiero un masaje antes de la pedicura', CATALOGO), null);
    assert.strictEqual(wantsAnotherBooking('Quiero un masaje antes de la pedicura'), false);
    // Y aun así, ahora se detecta por CATEGORÍA.
    const r = detectaSegundaReserva(s, 'Quiero un masaje antes de la pedicura', CATALOGO);
    assert.strictEqual(r.nuevaReserva, true);
    assert.strictEqual(r.categoriaNueva, 'Masajes y SPA');
});

test('B · la categoría de la cita YA confirmada no cuenta como segunda reserva', () => {
    const s = sesionPedicuraConfirmada();
    assert.strictEqual(detectaSegundaReserva(s, '¿la pedicura incluye masaje de pies?', CATALOGO).categoriaNueva, 'Masajes y SPA');
    assert.strictEqual(detectaSegundaReserva(s, '¿a qué hora era mi pedicura?', CATALOGO).nuevaReserva, false);
});

test('B · aceptar un upsell por su nombre NO es una segunda reserva', () => {
    const s = sesionPedicuraConfirmada();
    s.upsellingSuggested = true;
    s._lastUpsellSuggestion = 'K18';
    assert.strictEqual(detectaSegundaReserva(s, 'sí, ponme el K18', CATALOGO).nuevaReserva, false);
    assert.strictEqual(detectaSegundaReserva(s, 'vale', CATALOGO).nuevaReserva, false);
});

test('B · cancelar y reagendar NUNCA reinician el flujo (perderían la cita a mover)', () => {
    const s = sesionPedicuraConfirmada();
    for (const m of [
        'quiero cambiar la cita para antes de las 5',
        'quiero mover mi cita y hacerme también un masaje',
        'quiero cancelar y pedir otra cita',
    ]) assert.strictEqual(detectaSegundaReserva(s, m, CATALOGO).nuevaReserva, false, `reinició con: ${m}`);
});

test('B · frases aditivas explícitas siguen disparando', () => {
    const s = sesionPedicuraConfirmada();
    for (const m of ['además quiero una manicura', 'quiero otra cita', 'y de paso un masaje']) {
        assert.strictEqual(detectaSegundaReserva(s, m, CATALOGO).nuevaReserva, true, `no disparó: ${m}`);
    }
});

test('B · resetForSecondBooking + categoría deja la sesión lista para la nueva cita', () => {
    const s = sesionPedicuraConfirmada();
    const { categoriaNueva } = detectaSegundaReserva(s, 'Quiero un masaje antes de la pedicura', CATALOGO);
    resetForSecondBooking(s, 'Quiero un masaje antes de la pedicura');
    s.pendingServiceCategory = categoriaNueva;
    assert.strictEqual(s.reservaConfirmada, false, 'las redes anti-mentira vuelven a estar vivas');
    assert.strictEqual(s.appointmentId, null);
    assert.strictEqual(s.selectedService, null);
    assert.strictEqual(s.pendingServiceCategory, 'Masajes y SPA');
    assert.strictEqual(s.partialData.nombre, 'Joan Gascon', 'la identidad se conserva');
});

// ─── B · Resolver el servicio dentro de la categoría ("completo") ─────────────
test('B · "completo" contra el catálogo ENTERO es ambiguo → null (causa del bloqueo)', () => {
    assert.strictEqual(extractServiceFromText('completo', CATALOGO), null);
});

test('B · "completo" restringido a Masajes y SPA resuelve a "Relajante completo"', () => {
    const enCat = CATALOGO.filter(s => s.categoria === 'Masajes y SPA');
    assert.strictEqual(extractServiceFromText('completo', enCat)?.nombre, 'Relajante completo');
    assert.strictEqual(extractServiceFromText('el completo', enCat)?.nombre, 'Relajante completo');
    assert.strictEqual(extractServiceFromText('espalda y hombros', enCat)?.nombre, 'Espalda y hombros');
});

// ─── B · Ancla temporal ───────────────────────────────────────────────────────
test('B · extractAnchorConstraint lee "antes de" / "después de"', () => {
    assert.strictEqual(extractAnchorConstraint('Quiero un masaje antes de la pedicura'), 'before');
    assert.strictEqual(extractAnchorConstraint('algo después de mi corte'), 'after');
    assert.strictEqual(extractAnchorConstraint('quiero un masaje'), null);
});

test('B · el filtro "before" descarta los huecos que se solaparían con la cita de las 16:00', () => {
    const s = sesionPedicuraConfirmada();
    s.selectedService = { nombre: 'Relajante completo', categoria: 'Masajes y SPA', duracion: 60 };
    s.anchorAppointment = { fecha: '2026-08-06', horaInicio: '16:00', horaFin: '16:50', rel: 'before' };
    s.availableSlots = [
        { fecha: '2026-08-06', hora: '14:00' },
        { fecha: '2026-08-06', hora: '15:00' },
        { fecha: '2026-08-06', hora: '15:30' }, // 15:30+60 = 16:30 → pisa la pedicura
        { fecha: '2026-08-07', hora: '11:00' }, // otro día → fuera
    ];
    applyAnchorFilter(s, 60);
    assert.deepStrictEqual(s.availableSlots.map(x => x.hora), ['14:00', '15:00']);
    assert.strictEqual(s.anchorFilterVacio, false);
});

test('B · el filtro "after" arranca en el FIN de la cita ancla', () => {
    const s = sesionPedicuraConfirmada();
    s.selectedService = { nombre: 'Espalda y hombros', categoria: 'Masajes y SPA', duracion: 45 };
    s.anchorAppointment = { fecha: '2026-08-06', horaInicio: '16:00', horaFin: '16:50', rel: 'after' };
    s.availableSlots = [
        { fecha: '2026-08-06', hora: '16:30' }, // dentro de la pedicura
        { fecha: '2026-08-06', hora: '17:00' },
    ];
    applyAnchorFilter(s, 45);
    assert.deepStrictEqual(s.availableSlots.map(x => x.hora), ['17:00']);
});

test('B · si el filtro se queda sin huecos, CONSERVA la lista y lo marca (no miente)', () => {
    const s = sesionPedicuraConfirmada();
    s.selectedService = { nombre: 'Relajante completo', categoria: 'Masajes y SPA', duracion: 60 };
    s.anchorAppointment = { fecha: '2026-08-06', horaInicio: '10:00', horaFin: '10:50', rel: 'before' };
    s.availableSlots = [{ fecha: '2026-08-06', hora: '11:00' }, { fecha: '2026-08-06', hora: '12:00' }];
    applyAnchorFilter(s, 60);
    assert.strictEqual(s.availableSlots.length, 2, 'no puede vaciar la lista: los huecos existen');
    assert.strictEqual(s.anchorFilterVacio, true, 'y hay que decir que no encajan en la ventana pedida');
});

test('B · el filtro mide con la duración QUE RECIBE, no con la del objeto de sesión', () => {
    // Es la razón de que sea un parámetro: quien carga los huecos ya suma el upselling
    // (y resuelve las variantes sin `duracion`). Si el filtro volviera a leer
    // selectedService.duracion, un masaje + upsell de 90 min se colaría en la hora
    // anterior a la pedicura y se comería la cita que la clienta ya tiene.
    const s = sesionPedicuraConfirmada();
    s.selectedService = { nombre: 'Relajante completo', categoria: 'Masajes y SPA', duracion: 60 };
    s.anchorAppointment = { fecha: '2026-08-06', horaInicio: '16:00', horaFin: '16:50', rel: 'before' };
    s.availableSlots = [
        { fecha: '2026-08-06', hora: '14:00' },
        { fecha: '2026-08-06', hora: '15:00' }, // 15:00+90 = 16:30 → pisa la pedicura
    ];
    applyAnchorFilter(s, 90);
    assert.deepStrictEqual(s.availableSlots.map(x => x.hora), ['14:00']);
});

test('B · sin `horaFin` en el ancla el filtro sigue funcionando (con final supuesto)', () => {
    // Una cita sin ends_at no debería existir; si aparece, el filtro no se cae — mide
    // contra el fallback declarado y lo deja dicho en el log.
    const s = sesionPedicuraConfirmada();
    s.selectedService = { nombre: 'Espalda y hombros', categoria: 'Masajes y SPA', duracion: 45 };
    s.anchorAppointment = { fecha: '2026-08-06', horaInicio: '16:00', horaFin: null, rel: 'after' };
    s.availableSlots = [{ fecha: '2026-08-06', hora: '16:30' }, { fecha: '2026-08-06', hora: '17:00' }];
    applyAnchorFilter(s, 45);
    assert.deepStrictEqual(s.availableSlots.map(x => x.hora), ['17:00'], '16:00 + 60 supuestos');
});

// ─── C · Contrato de estado ───────────────────────────────────────────────────
test('C · los campos nuevos están en la fuente de verdad del estado de servicio', () => {
    for (const k of ['pendingServiceCategory', 'anchorAppointment', 'anchorFilterVacio']) {
        assert.ok(k in SERVICE_STATE_DEFAULTS, `${k} debe registrarse en SERVICE_STATE_DEFAULTS`);
    }
});

// ─── CONTROL San Remo ─────────────────────────────────────────────────────────
// El flujo entero es salon-only. Este control fija que nada de lo anterior depende de
// código compartido con el restaurante: sin catálogo de salón no hay categorías, y el
// detector de segunda reserva ni siquiera se consulta para orgType 'restaurant'.
test('CONTROL · San Remo: sin catálogo de salón no se detecta ninguna categoría', () => {
    assert.deepStrictEqual(extractServiceCategoriesFromText('Quiero un masaje antes de la pedicura', []), []);
    assert.deepStrictEqual(extractServiceCategoriesFromText('mesa para cuatro esta noche', CATALOGO), []);
});

// Salida explícita: requerir bot.js abre la sesión SQLite y deja timers vivos, así que el
// proceso no termina solo (misma convención que el resto de tests del repo).
if (!process.exitCode) console.log('\nTodos los tests de cita fantasma / segunda reserva OK');
process.exit(process.exitCode || 0);
