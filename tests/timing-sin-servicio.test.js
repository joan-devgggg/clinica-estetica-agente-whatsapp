// Sin servicio no se propone día ni hora (09/08/2026).
//
// Michal Gradziel (447432204269, 07/08/2026), con selectedService a null de principio a fin:
//
//   11:07:42  «Monday August 10 works! What time suits you best — morning or afternoon?»
//   11:08:03  «…I don't have the available slots loaded for that day yet. What time in the
//              morning would work best for you — around 10, 11, or 12?»
//   11:09:32  «To check availability I first need to know which service you'd like 😊»
//
// Dos turnos gastados sobre humo y, solo entonces, la admisión. Las guardas de CÓDIGO
// estaban bien y ninguna falló —loadAvailableSlots y askDatePreferenceFirst exigen las dos
// selectedService, así que no se cargó ni un hueco—. Lo que no existía era una guarda sobre
// lo que el modelo DICE, y el prompt empujaba en la dirección contraria: la rama
// __servicioMencionado le ordenaba «mapéalo al catálogo … y continúa el flujo».
//
// Es la recomendación 2 de docs/escenario-3-servicio-sin-resolver.md, abierta desde el 05/08.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { _internals } = require('../bot');

const { proposesTimingWithoutService, salonNoSlotsMsg } = _internals;

// Puntas de business_hours tal como las devuelve horasLimiteHorario.
const HORARIO = ['10:00', '19:00'];

function sesion(extra = {}) {
    return { language: 'en', partialData: {}, sinServicioStreak: 0, ...extra };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── Lo que tenía que haber parado ───────────────────────────────────────────

test('REGRESIÓN · los dos mensajes EXACTOS de Michal se paran', () => {
    const m1 = 'Monday August 10 works! What time suits you best — morning or afternoon?';
    const m2 = "Great! Unfortunately I don't have the available slots loaded for that day yet. "
        + 'What time in the morning would work best for you — around 10, 11, or 12?';
    assert.strictEqual(proposesTimingWithoutService(m1, sesion(), HORARIO), true, 'turno 11:07:42');
    assert.strictEqual(proposesTimingWithoutService(m2, sesion(), HORARIO), true, 'turno 11:08:03');
});

test('y el mensaje que sale en su lugar es el que pide el servicio, en su idioma', () => {
    const s = sesion();
    const msg = salonNoSlotsMsg(s);
    assert.ok(/which service/i.test(msg), `esperaba la petición de servicio en inglés, salió: ${msg}`);
});

test('una hora concreta sin servicio tampoco pasa', () => {
    assert.strictEqual(proposesTimingWithoutService('I can do 11:30 for you', sesion(), HORARIO), true);
});

test('los cuatro idiomas del salón', () => {
    const casos = [
        '¿Qué día te viene mejor?',
        '¿Prefieres por la mañana o por la tarde?',
        'What day works for you?',
        'Какой день тебе удобнее?',
        'Який день тобі зручніше?',
    ];
    for (const c of casos) {
        assert.strictEqual(proposesTimingWithoutService(c, sesion(), HORARIO), true, `falla: "${c}"`);
    }
});

// ─── Lo que NO se puede comer ────────────────────────────────────────────────

test('EXENCIÓN · decir el horario del salón sigue saliendo (el mensaje de Olga)', () => {
    // Es la respuesta correcta a "solo puedo después de las 23:00", y no exige saber el
    // servicio. Sin esta exención sería el bug del 07/08 otra vez, con otra red comiéndoselo.
    const olga = 'A las 23:00 ya hemos cerrado 😅 Abrimos de 10:00 a 19:00.';
    assert.strictEqual(proposesTimingWithoutService(olga, sesion({ language: 'es' }), HORARIO), false);
    assert.strictEqual(proposesTimingWithoutService('We are open from 10:00 to 19:00', sesion(), HORARIO), false);
});

test('con servicio ya resuelto la red no pinta nada', () => {
    const s = sesion({ selectedService: { nombre: 'Cabello medio', categoria: 'Mechas Balayage' } });
    assert.strictEqual(proposesTimingWithoutService('What day works for you?', s, HORARIO), false);
});

test('con la reserva ya confirmada tampoco', () => {
    const s = sesion({ reservaConfirmada: true });
    assert.strictEqual(proposesTimingWithoutService('See you Monday at 10:00', s, HORARIO), false);
});

test('una cita YA EXISTENTE habla de días y horas con toda la razón', () => {
    // Consultar, cancelar, reagendar o ampliar una cita viva no tiene selectedService, y sí
    // menciona fechas. Si la red saltara aquí, «tu cita es el lunes a las 09:00» se
    // convertiría en «¿qué servicio quieres?».
    const texto = 'Your appointment is on Monday at 09:00. What day would you prefer instead?';
    for (const clave of ['citaEnCurso', 'pendingCitaAccion', 'modoReagendamiento', 'anchorAppointment']) {
        const s = sesion({ [clave]: { id: 'a1' } });
        assert.strictEqual(proposesTimingWithoutService(texto, s, HORARIO), false, `falla con ${clave}`);
    }
});

test('un mensaje que no habla de cuándo no dispara', () => {
    for (const c of ['What are you after?', 'Hola, ¿en qué puedo ayudarte?',
        'That sounds gorgeous! Are you thinking all over, or just highlights?',
        'Es una decoloración completa, ¿tu pelo es corto, medio o largo?']) {
        assert.strictEqual(proposesTimingWithoutService(c, sesion(), HORARIO), false, `no debería: "${c}"`);
    }
});

test('sin datos no revienta', () => {
    assert.strictEqual(proposesTimingWithoutService('', sesion(), HORARIO), false);
    assert.strictEqual(proposesTimingWithoutService('What day?', null, HORARIO), false);
    // Sin business_hours utilizable la red sigue funcionando; lo que se pierde es la
    // exención de horario, que falla hacia el lado seguro (se pide el servicio).
    assert.strictEqual(proposesTimingWithoutService('What day works?', sesion(), []), true);
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
