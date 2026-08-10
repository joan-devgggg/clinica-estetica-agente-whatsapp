/**
 * tests/fechas-inventadas.test.js — El caso Ludmila Zarahovich (03/08/2026).
 *
 * Pidió el 28 de agosto con Veronika. El bot: «no hay huecos el 28, los más cercanos son el
 * 27, 29 o 30». Eligió el 27 → «no hay el 27, los más cercanos el 29 o el 30». Eligió el
 * 29 → «tampoco el 29, el más cercano es el 4 de agosto o el 11». **Le ofreció tres días y
 * negó los tres.** Una hora más tarde una persona le creó a mano la cita del 28 —el día que
 * había pedido desde el principio— con el servicio de más ticket del periodo.
 *
 * Las tres redes de horas no vieron nada: en toda la conversación no hubo ni una HH:MM, y
 * `respondsWithInventedSlots` sale en su primera línea cuando no hay horas mencionadas. Esto
 * es su gemelo por fechas.
 *
 * Los dos lados importan igual, y el de los falsos positivos más: la lección de Olga Yarmak
 * (07/08) es que una red anti-invención demasiado ancha se come el ÚNICO mensaje correcto.
 */
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { test } = require('node:test');

const { respondsWithInventedDates } = require('../bot')._internals;
const { extractMentionedDates, declaraSinDisponibilidad } = require('../services/helpers');

// Los huecos reales, tal como los deja loadAvailableSlots.
const hueco = (fecha, hora = '10:00') => ({ fecha, hora, estilista: 'Veronika' });

// Las fechas se resuelven a la PRÓXIMA con ese día y mes, así que se calculan igual aquí en
// vez de escribirlas a mano: si no, este test caducaría al cambiar de año.
const F = txt => extractMentionedDates(txt)[0];

// ─── El extractor ────────────────────────────────────────────────────────────

test('lee TODAS las fechas del mensaje, no solo la primera', () => {
    assert.deepStrictEqual(
        extractMentionedDates('los más cercanos son el 27, 29 o 30 de agosto'),
        [F('27 de agosto'), F('29 de agosto'), F('30 de agosto')],
        'la enumeración lleva coma Y conjunción: quedarse en la coma pierde el último');
});

test('los cuatro idiomas, que es donde vivía el agujero', () => {
    assert.strictEqual(extractMentionedDates('Ближайшие доступные дни — 27, 29 или 30 августа').length, 3);
    assert.strictEqual(extractMentionedDates('найближчі дні — 27 та 29 серпня').length, 2);
    assert.deepStrictEqual(extractMentionedDates('Monday August 10 works!'), [F('10 de agosto')],
        'en inglés el día va DETRÁS del mes');
});

test('lo que NO es una fecha', () => {
    assert.deepStrictEqual(extractMentionedDates('el corte son 35 euros y dura 45 minutos'), []);
    assert.deepStrictEqual(extractMentionedDates('tengo mayoría de huecos libres'), [],
        '"mayo" dentro de "mayoría" no es un mes');
    assert.deepStrictEqual(extractMentionedDates('te va bien el 28?'), [],
        'un día suelto sin mes choca con la selección de hueco por número');
});

// ─── La red ──────────────────────────────────────────────────────────────────

test('EL CASO: ofrece tres días con la agenda vacía → bloqueado', () => {
    const respuesta = 'К сожалению, у меня нет свободных окон на 28 августа. '
        + 'Ближайшие доступные дни с Вероникой — 27, 29 или 30 августа. Какой из этих дней вам подойдёт?';
    assert.strictEqual(respondsWithInventedDates(respuesta, []), true,
        'negar una y ofrecer tres es exactamente la mezcla que hay que bloquear');
});

test('EL CASO, segundo turno: niega el día que acaba de ofrecer y propone otros', () => {
    assert.strictEqual(
        respondsWithInventedDates('на 27 августа нет свободных окон. Ближайшие — 29 или 30 августа', []),
        true);
});

test('con huecos reales en esa fecha, el mensaje pasa', () => {
    const slots = [hueco(F('28 de agosto'), '10:00'), hueco(F('28 de agosto'), '11:00')];
    assert.strictEqual(
        respondsWithInventedDates('tengo hueco el 28 de agosto a las 10:00 o a las 11:00', slots),
        false);
});

test('basta con que UNA fecha tenga respaldo: "el 28 no, el 29 sí"', () => {
    // Misma forma que la red de horas. Es lo que permite contestar con honestidad a un día
    // que no hay ofreciendo otro que sí.
    const slots = [hueco(F('29 de agosto'))];
    assert.strictEqual(
        respondsWithInventedDates('el 28 de agosto no me queda nada, pero el 29 de agosto sí', slots),
        false);
});

// ─── Las dos exenciones, que son las que evitan repetir el fallo de Olga ─────

test('EXENCIÓN 1: la fecha de una cita que YA tiene no es una oferta inventada', () => {
    const fecha = F('12 de septiembre');
    assert.strictEqual(
        respondsWithInventedDates('tu cita es el 12 de septiembre a las 13:00', [], { citasVivas: [{ fecha }] }),
        false, 'confirmar, cancelar o reagendar habla del día de su cita con toda la razón');

    assert.strictEqual(
        respondsWithInventedDates('tu cita es el 12 de septiembre a las 13:00', []),
        true, 'y sin esa cita, la misma frase sí es humo');
});

test('EXENCIÓN 2: declarar que NO hay hueco en UNA fecha es correcto', () => {
    assert.strictEqual(respondsWithInventedDates('el 28 de agosto no tengo huecos', []), false);
    assert.strictEqual(respondsWithInventedDates('нет свободных окон на 28 августа', []), false);
    assert.strictEqual(respondsWithInventedDates("we're fully booked on August 28", []), false);
});

test('…pero negar UNA y ofrecer OTRAS no se acoge a esa exención', () => {
    assert.strictEqual(
        respondsWithInventedDates('el 28 de agosto no tengo huecos, pero sí el 29 o el 30 de agosto', []),
        true, 'es el mensaje de Ludmila en castellano: la exención es para UNA sola fecha');
});

test('la exención de "sin disponibilidad" no tapa una oferta a secas', () => {
    assert.strictEqual(declaraSinDisponibilidad('te propongo el 27 o el 29'), false);
    assert.strictEqual(respondsWithInventedDates('te propongo el 27 de agosto', []), true,
        'una fecha sola, ofrecida y sin respaldo, sigue siendo invención');
});

// ─── Falsos positivos: un mensaje sin fechas no puede bloquearse ─────────────

test('un mensaje sin fechas nunca dispara la red', () => {
    for (const txt of [
        'El corte de mujer con secado cuesta 40€ y dura 45 minutos',
        '¿Qué día te viene mejor?',
        'Abrimos de lunes a sábado de 10:00 a 19:00',
        'Привет! Как тебя зовут?',
    ]) {
        assert.strictEqual(respondsWithInventedDates(txt, []), false, `no debía bloquear: ${txt}`);
    }
});
