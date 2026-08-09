// Una hora sin minutos también es una hora (09/08/2026).
//
// «I don't have the available slots loaded for that day yet. What time in the morning would
// work best for you — around 10, 11, or 12?» — Michal Gradziel, 07/08/2026, 11:08:03, con
// session.availableSlots vacío. Tres horas ofrecidas sobre nada, y las tres redes ciegas:
// HORA_HHMM_SRC exige los dos puntos y los dos dígitos de minutos, así que
// respondsWithInventedSlots salía en su primera línea con mentioned.length === 0.
//
// La exención de horario del 07/08 NO tuvo nada que ver: se evalúa DESPUÉS de esa salida.
// El agujero era anterior y estaba en los tres sitios a la vez, incluido el gate
// detectHoraFueraDeHorario — o sea que «solo puedo después de las 23», el caso de Olga
// escrito sin «:00», tampoco se detectaba.
//
// Un número a secas NO es una hora: se exige marcador temporal delante. "Largo 2" no son
// las dos.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { extractLooseClockHours, extractMentionedHours, detectHoraFueraDeHorario } = require('../services/helpers');
const { _internals } = require('../bot');

const { respondsWithInventedSlots, unbackedBookingClaim } = _internals;
const HORARIO_PUNTAS = ['10:00', '19:00'];
const BUSINESS_HOURS = {
    lunes: { apertura: '10:00', cierre: '19:00' }, martes: { apertura: '10:00', cierre: '19:00' },
    miercoles: { apertura: '10:00', cierre: '19:00' }, jueves: { apertura: '10:00', cierre: '19:00' },
    viernes: { apertura: '10:00', cierre: '19:00' }, sabado: { apertura: '10:00', cierre: '19:00' },
};

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── El detector ─────────────────────────────────────────────────────────────

test('REGRESIÓN · "around 10, 11, or 12" son TRES horas, no una', () => {
    // La coma y la conjunción van juntas entre las dos últimas; con un solo separador la
    // lista se cortaba en el 11 y la tercera hora se escapaba.
    assert.deepStrictEqual(
        extractLooseClockHours('What time in the morning — around 10, 11, or 12?'),
        ['10:00', '11:00', '12:00'],
    );
});

test('las cuatro lenguas y las formas habituales', () => {
    assert.deepStrictEqual(extractLooseClockHours('solo puedo después de las 23'), ['23:00']);
    assert.deepStrictEqual(extractLooseClockHours('я могу только после 23'), ['23:00']);
    assert.deepStrictEqual(extractLooseClockHours('в 10 удобно?'), ['10:00']);
    assert.deepStrictEqual(extractLooseClockHours('can you do it at 11?'), ['11:00']);
    assert.deepStrictEqual(extractLooseClockHours('a las 10 y a las 11'), ['10:00', '11:00']);
});

test('la regla de 12h es la MISMA que la del resto del código', () => {
    // "a las 5" en un salón que cierra a las 19:00 son las 17:00, igual que hace normalizeHora.
    assert.deepStrictEqual(extractLooseClockHours('te va bien a las 5?'), ['17:00']);
    assert.deepStrictEqual(extractLooseClockHours('a las 9'), ['09:00']);
});

test('FALSOS POSITIVOS · un número suelto no es una hora', () => {
    for (const t of ['Largo 2', 'Mechas 3', 'son 35 €', 'cuesta 20 euros', 'dura 45 min',
        'un 30 % de descuento', 'K18', 'Monday August 10 works', 'el 10 de agosto',
        'tienes 3 opciones', 'tengo a las 10:30']) {
        assert.deepStrictEqual(extractLooseClockHours(t), [], `no debería leer hora en: "${t}"`);
    }
});

test('extractMentionedHours junta las dos familias sin duplicar', () => {
    assert.deepStrictEqual(extractMentionedHours('a las 10:00 o a las 11'), ['10:00', '11:00']);
});

// ─── Los tres sitios que estaban ciegos ──────────────────────────────────────

test('SITIO 1 · respondsWithInventedSlots caza el mensaje de Michal', () => {
    const michal = "I don't have the available slots loaded for that day yet. "
        + 'What time in the morning would work best for you — around 10, 11, or 12?';
    assert.strictEqual(respondsWithInventedSlots(michal, [], HORARIO_PUNTAS), true);
});

test('SITIO 2 · unbackedBookingClaim ve la hora suelta sin cita detrás', () => {
    assert.deepStrictEqual(unbackedBookingClaim('te he apuntado a las 11', ['16:00']), ['11:00']);
    assert.deepStrictEqual(unbackedBookingClaim('te he apuntado a las 11', ['11:00']), []);
});

test('SITIO 3 · el gate de horario ve "después de las 23" sin los :00', () => {
    const r = detectHoraFueraDeHorario('solo puedo después de las 23', BUSINESS_HOURS);
    assert.ok(r, 'tenía que detectar que las 23 caen fuera');
    assert.strictEqual(r.hora, '23:00');
    assert.strictEqual(r.apertura, '10:00');
    assert.strictEqual(r.cierre, '19:00');
});

// ─── Lo que no se puede haber roto ───────────────────────────────────────────

test('la exención de horario sigue en pie', () => {
    const olga = 'A las 23:00 ya hemos cerrado 😅 Abrimos de 10:00 a 19:00.';
    assert.strictEqual(respondsWithInventedSlots(olga, [], HORARIO_PUNTAS), false);
});

test('"5:30" sigue casando con un hueco real de las 17:30', () => {
    // normalizeHora convierte 5:30 → 17:30, y por eso el hueco real lo respalda. Perder esa
    // conversión marcaría como inventado un hueco que existe.
    assert.strictEqual(respondsWithInventedSlots('¿Te va bien a las 5:30?', [{ hora: '17:30' }], HORARIO_PUNTAS), false);
});

test('una hora suelta CON hueco real detrás no es invención', () => {
    assert.strictEqual(respondsWithInventedSlots('te espero a las 11', [{ hora: '11:00' }], HORARIO_PUNTAS), false);
});

test('un mensaje sin horas sigue sin disparar nada', () => {
    assert.strictEqual(respondsWithInventedSlots('¿Qué servicio quieres?', [], HORARIO_PUNTAS), false);
    assert.deepStrictEqual(unbackedBookingClaim('te confirmo la cita', ['16:00']), []);
    assert.strictEqual(detectHoraFueraDeHorario('quiero un corte', BUSINESS_HOURS), null);
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
