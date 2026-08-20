/**
 * tests/regla-12h-unica.test.js — la regla de las 12 horas se escribe UNA vez.
 *
 * Estaba en TRES sitios y solo dos coincidían:
 *
 *   · `normalizeHora` (bot.js) — la completa: lee tarde/noche/pm y mañana/morning/am, y a
 *     falta de las dos aplica «1-8 → +12» («las 4» en un salón son las 16:00).
 *   · `extractLooseClockHours` (helpers) — solo el «1-8 → +12». Su propio comentario ya
 *     avisaba: «si una de las dos cambia, la otra tiene que cambiar con ella».
 *   · `extractClockHours` (helpers) — NINGUNA. `9:30` → `09:30` y punto.
 *
 * Y no era teoría: el MISMO texto valía dos cosas distintas dentro del mismo turno.
 * `detectHoraFueraDeHorario` (helpers) leía el `01:00` en crudo y decía «cerrado»; las redes
 * de bot.js hacían `extractMentionedHours(...).map(normalizeHora)`, o sea le pasaban ese
 * mismo `01:00` por la regla otra vez y obtenían `13:00`. Doce horas de diferencia según
 * quién preguntara.
 *
 * LO QUE COSTÓ, y son las tres frases que este fichero prueba. 20/08/2026, una clienta que
 * venía ANDANDO al salón con cita a la una del mediodía:
 *
 *   11:51  «Ya tengo cita a la 1:00 pm hoy»   →  «A las 01:00 no estamos abiertos 😊»
 *   13:01  «I have an app at 1:00»            →  «We're not open at 01:00 😊»
 *   13:02  «1:15 at least»                    →  «We're not open at 01:15 😊»
 *
 * La tercera no es ni una hora: es «me falta al menos una hora y cuarto».
 *
 * Las DOS decisiones que hay dentro de la regla única, y que son lo que hay que releer antes
 * de tocarla:
 *
 *   1. EL CERO DELANTE ES UNA DECLARACIÓN. «08:00» son las ocho de la mañana; nadie escribe
 *      el cero para decir las ocho de la tarde. La heurística «1-8 → +12» existe para lo
 *      AMBIGUO («a las 4», «at 1:00»), no para lo que ya viene dicho. Sin esa línea,
 *      «¿puedo a las 08:00?» pasaba a leerse como las 20:00.
 *   2. UNA REGLA, UNA APLICACIÓN. `extractMentionedHours` ya devuelve 24 h, así que los cinco
 *      call sites de bot.js dejaron de encadenarle `normalizeHora`: aplicarla dos veces
 *      convertía un «at 5 am» correcto (05:00) en 17:00.
 *
 * Sabotajes MEDIDOS (cp previo, 20/08/2026):
 *   · extractClockHours sin la regla (el estado exacto de antes) ............. 6 rojos
 *   · quitar el «cero delante es una declaración» ............................ 2 rojos
 *   · quitar la guarda de duración («1:15 at least») ......................... 2 rojos
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');
const {
    extractMentionedHours, extractClockHours, extractLooseClockHours,
    detectHoraFueraDeHorario, resolverHora12h,
} = require('../services/helpers');
const { normalizeHora } = require('../bot')._internals;

// El horario REAL de Sante en agent_configs el 20/08/2026.
const HORARIO = {
    lunes: { apertura: '10:00', cierre: '19:00' }, martes: { apertura: '10:00', cierre: '19:00' },
    miercoles: { apertura: '10:00', cierre: '19:00' }, jueves: { apertura: '10:00', cierre: '19:00' },
    viernes: { apertura: '10:00', cierre: '19:00' }, sabado: { apertura: '10:00', cierre: '19:00' },
};

// ─── 1 · Las tres frases REALES ──────────────────────────────────────────────

test('REGRESIÓN · «Ya tengo cita a la 1:00 pm hoy» son las 13:00, y el salón está abierto', () => {
    const texto = 'Ya tengo cita a la 1:00 pm hoy';
    assert.deepStrictEqual(extractMentionedHours(texto), ['13:00'], 'el pm estaba escrito y se ignoraba');
    assert.strictEqual(detectHoraFueraDeHorario(texto, HORARIO), null,
        'decirle «no estamos abiertos» a quien viene de camino a su cita es el fallo entero');
});

test('REGRESIÓN · «I have an app at 1:00» también son las 13:00', () => {
    const texto = 'I have an app at 1:00';
    assert.deepStrictEqual(extractMentionedHours(texto), ['13:00'],
        'sin franja dicha, «1:00» en un salón que abre de 10 a 19 es la una del mediodía');
    assert.strictEqual(detectHoraFueraDeHorario(texto, HORARIO), null);
});

test('REGRESIÓN · «1:15 at least» NO es una hora: es una duración', () => {
    const texto = '1:15 at least';
    assert.deepStrictEqual(extractMentionedHours(texto), [],
        '«me falta al menos una hora y cuarto» no es la una y cuarto');
    assert.strictEqual(detectHoraFueraDeHorario(texto, HORARIO), null);
});

test('la duración se reconoce por los dos lados y pegada, nunca por un difuso', () => {
    assert.deepStrictEqual(extractMentionedHours('at least 1:15'), []);
    assert.deepStrictEqual(extractMentionedHours('al menos 2:30'), []);
    // Y lo que NO puede llevarse por delante: «around/about» son marcadores de HORA, no de
    // duración. Si un detector difuso de «aproximadamente» entrara aquí, se las comería.
    assert.deepStrictEqual(extractMentionedHours('around 3:00'), ['15:00']);
    assert.deepStrictEqual(extractMentionedHours('about 11:00'), ['11:00']);
});

// ─── 2 · Una regla: los tres caminos dicen lo MISMO ──────────────────────────

test('los tres caminos coinciden en la misma hora escrita de tres formas', () => {
    // «las 3 de la tarde», dicho con HH:MM, dicho suelto y dicho a normalizeHora. Antes,
    // el primero devolvía 03:00 y los otros dos 15:00.
    assert.deepStrictEqual(extractClockHours('at 3:00 pm'), ['15:00']);
    assert.deepStrictEqual(extractLooseClockHours('at 3 pm'), ['15:00']);
    assert.strictEqual(normalizeHora('3 pm'), '15:00');
    assert.strictEqual(normalizeHora('las 3 de la tarde'), '15:00');
});

test('IDEMPOTENTE: pasar por la regla lo que ya salió de ella no lo mueve', () => {
    // Es la propiedad que hace segura la cadena `extractMentionedHours(...)` → comparar con
    // `normalizeHora(slot.hora)`: los dos lados están en la misma escala.
    for (const t of ['1:00 pm', 'at 1:00', 'a las 4', 'abrimos de 10:00 a 19:00', 'a las 23:00', '12:30 pm']) {
        for (const h of extractMentionedHours(t)) {
            assert.strictEqual(normalizeHora(h), h, `«${t}» → ${h} se mueve al volver a normalizar`);
        }
    }
});

// ─── 3 · El cero delante ─────────────────────────────────────────────────────

test('«08:00» son las ocho de la MAÑANA: el cero delante es una declaración', () => {
    assert.deepStrictEqual(extractMentionedHours('¿puedo a las 08:00?'), ['08:00']);
    assert.strictEqual(normalizeHora('08:00'), '08:00');
    // Y la heurística sigue viva para lo ambiguo, que es para lo que existe.
    assert.deepStrictEqual(extractMentionedHours('a las 8:00'), ['20:00']);
    assert.deepStrictEqual(extractMentionedHours('a las 4'), ['16:00']);
});

test('pero lo que la clienta DICE manda sobre el cero: «08:00 pm» son las 20:00', () => {
    assert.deepStrictEqual(extractMentionedHours('08:00 pm'), ['20:00']);
});

// ─── 4 · Lo que no se puede perder ───────────────────────────────────────────

test('EXENCIÓN · el horario del salón se sigue leyendo entero (el mensaje de Olga)', () => {
    assert.deepStrictEqual(extractMentionedHours('Abrimos de 10:00 a 19:00'), ['10:00', '19:00']);
    assert.strictEqual(detectHoraFueraDeHorario('Abrimos de 10:00 a 19:00', HORARIO), null);
});

test('la hora imposible de Olga sigue detectándose: «solo puedo después de las 23»', () => {
    assert.strictEqual(detectHoraFueraDeHorario('solo puedo después de las 23:00', HORARIO)?.hora, '23:00');
    assert.strictEqual(detectHoraFueraDeHorario('solo puedo después de las 23', HORARIO)?.hora, '23:00');
});

test('la enumeración de Michal sigue entera: «around 10, 11, or 12»', () => {
    assert.deepStrictEqual(extractMentionedHours('What time would work — around 10, 11, or 12?'),
        ['10:00', '11:00', '12:00']);
});

test('y lo que NO es una hora sigue sin serlo: «35 €», «Largo 2», «45 min»', () => {
    for (const t of ['son 35 €', 'Largo 2', 'dura 45 min', 'August 10']) {
        assert.deepStrictEqual(extractMentionedHours(t), [], `«${t}» no es una hora`);
    }
});

// ─── 5 · La función única, a pelo ────────────────────────────────────────────

test('resolverHora12h: el orden de sus tres reglas', () => {
    assert.strictEqual(resolverHora12h('1', 'pm'), 13, '1 · lo dicho manda');
    assert.strictEqual(resolverHora12h('5', 'am'), 5, '1 · también cuando dice mañana');
    assert.strictEqual(resolverHora12h('08', ''), 8, '2 · el cero delante');
    assert.strictEqual(resolverHora12h('8', ''), 20, '3 · y lo ambiguo cae en la heurística');
    assert.strictEqual(resolverHora12h('11', ''), 11, 'fuera del tramo 1-8 no se toca');
    assert.strictEqual(resolverHora12h('99', ''), null, 'lo que no es una hora devuelve null, no un número raro');
});
