/**
 * tests/exencion-horario-cierre.test.js — decir la hora de CIERRE no es ofrecer un hueco.
 *
 * Anna Zhyravel, 13/08/2026: se dejó el cargador del móvil en el salón y preguntó si podía
 * pasar a recogerlo en un par de horas. La respuesta del modelo era perfecta —
 *
 *     «Привет! 😊 Конечно, приходи когда удобно. Мы работаем до 19:00. Что-нибудь еще помочь?»
 *     («Claro, ven cuando te venga bien. Trabajamos hasta las 19:00.»)
 *
 * — y se la comió `proposesTimingWithoutService`, que la sustituyó por «para ver los huecos
 * necesito saber qué servicio te interesa». A alguien que iba a buscar un cargador. Queda en
 * la telemetría de la escalera (`escalera_intervenciones`, 20/08 20:18, salida
 * `pedir_servicio`).
 *
 * LA CAUSA es la condición 2 de la exención del horario: exigía DOS puntas distintas, y
 * «работаем до 19:00» nombra UNA. Esa condición no es un capricho —una hora suelta suele ser
 * una oferta de hueco— pero mide lo que no quiere medir. Lo que de verdad separa un horario
 * de una oferta es si esa hora PUEDE SER UN HUECO:
 *
 *     el salón cierra a las 19:00  ⇒  ninguna cita empieza a las 19:00
 *                                  ⇒  decir «19:00» no puede ser ofrecer un hueco
 *
 * Así que la condición pasa a ser «dos puntas O ninguna hora reservable», y la segunda mitad
 * se calcula con el `noReservable` que la función YA tenía para la condición 1. No es
 * aflojar el umbral: es escribir el motivo por el que el umbral existía.
 *
 * Y con ella entra el segundo caso, que es Olga otra vez: «a las 23:00 no abrimos» —una sola
 * hora, fuera del horario, imposible de reservar— también se condenaba.
 *
 * RESIDUO DECLARADO: la hora de APERTURA sola («abrimos a las 10:00») sigue sin exención, y
 * está bien: las 10:00 SÍ son reservables, así que ese mensaje y una oferta a las 10:00 no
 * se distinguen sin leer intención. En la práctica el horario se dice entero («de 10:00 a
 * 19:00»), que son dos puntas.
 *
 * Sabotajes MEDIDOS (cp previo, 21/08/2026):
 *   · volver a `puntasDistintas >= 2` a secas (el estado exacto de antes) ....... 4 rojos
 *   · quitar `statesOpeningHours` de la exención ................................ 2 rojos
 *   · quitar `!llmClaimsBooked` ................................................. 1 rojo
 *   · quitar `!asksForBookingApproval` de la rama nueva ......................... 1 rojo
 *   · quitar `soloHorario` (la condición 1) ..................................... 1 rojo
 *
 * El último costó afinarlo y merece la nota: con UNA sola punta dicha, la disyunción nueva
 * condena el mensaje ella sola, así que el bloque de la condición 1 no la veía caerse. Hace
 * falta el horario ENTERO más la hora de más.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');

const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/supabase', {});
stub('../services/db', new Proxy({}, { get: () => (async () => null) }));
stub('../services/telegram', { startTelegramBot: () => {} });
stub('../services/memory', { loadClient: () => null, saveClient: () => {}, saveSummary: () => {}, deleteClient: () => {} });
stub('../services/metrics', { incrementMetric: () => {} });

const {
    soloDeclaraHorarioDelSalon, proposesTimingWithoutService, respondsWithInventedSlots,
    horasLimiteHorario,
} = require('../bot')._internals;
const { extractMentionedHours } = require('../services/helpers');

// El horario REAL de Sante el 21/08/2026, aquí como ENTRADA de una función pura: lo edita la
// dueña y nada de este fichero lo verifica contra él (regla 5).
const BUSINESS_HOURS = {
    lunes: { apertura: '10:00', cierre: '19:00' }, martes: { apertura: '10:00', cierre: '19:00' },
    miercoles: { apertura: '10:00', cierre: '19:00' }, jueves: { apertura: '10:00', cierre: '19:00' },
    viernes: { apertura: '10:00', cierre: '19:00' }, sabado: { apertura: '10:00', cierre: '19:00' },
};
const HORARIO = horasLimiteHorario(BUSINESS_HOURS);

const exento = texto => soloDeclaraHorarioDelSalon(texto, extractMentionedHours(texto).filter(Boolean), HORARIO);
// Una sesión de alguien que no viene a reservar: sin servicio, sin cita, sin nada.
const SESION_SIN_SERVICIO = { selectedService: null, reservaConfirmada: false, availableSlots: [] };

// ─── 1 · Las tres frases medidas ─────────────────────────────────────────────

const FRASE_CARGADOR = 'Привет! 😊 Конечно, приходи когда удобно. Мы работаем до 19:00. Что-нибудь еще помочь?';

test('REGRESIÓN · la respuesta del cargador, byte por byte, deja de comerse', () => {
    assert.deepStrictEqual(extractMentionedHours(FRASE_CARGADOR).filter(Boolean), ['19:00'],
        'la frase nombra UNA punta: es todo el caso');
    assert.ok(exento(FRASE_CARGADOR), 'trabajar hasta las 19:00 es el horario, no un hueco');
    assert.strictEqual(proposesTimingWithoutService(FRASE_CARGADOR, SESION_SIN_SERVICIO, HORARIO), false,
        'ésta es la red que se la comió y la sustituyó por «¿qué servicio quieres?»');
    assert.strictEqual(respondsWithInventedSlots(FRASE_CARGADOR, [], HORARIO), false,
        'y la de al lado, que la habría condenado igual con la agenda sin cargar');
});

test('REGRESIÓN · «cerramos a las 19:00», la frase que ya mataba la red en el caso de Olga', () => {
    assert.ok(exento('Cerramos a las 19:00 😊'));
    assert.strictEqual(proposesTimingWithoutService('Cerramos a las 19:00 😊', SESION_SIN_SERVICIO, HORARIO), false);
});

test('REGRESIÓN · «a las 23:00 no abrimos»: una sola hora, y fuera del horario', () => {
    // El segundo caso que entra con la disyunción. Aquí no hay ni UNA punta —23:00 no es ni
    // apertura ni cierre— así que el umbral de dos puntas lo condenaba sin remedio.
    assert.ok(exento('A las 23:00 no abrimos, lo siento'));
    assert.strictEqual(respondsWithInventedSlots('A las 23:00 no abrimos, lo siento', [], HORARIO), false);
});

test('la misma declaración en los otros idiomas', () => {
    for (const t of ['We are open until 19:00', 'Ми працюємо до 19:00', 'Estamos abiertos hasta las 19:00']) {
        assert.ok(exento(t), `«${t}» dice el horario, no ofrece nada`);
    }
});

// ─── 2 · Lo que NO puede colarse ─────────────────────────────────────────────

test('CONTROL · una oferta a una hora RESERVABLE sigue condenada', () => {
    for (const t of ['Te apunto a las 11:00', '¿Te va bien a las 11:00?', 'Tengo hueco a las 15:30']) {
        assert.ok(!exento(t), `«${t}» es una oferta`);
        assert.strictEqual(respondsWithInventedSlots(t, [], HORARIO), true, `«${t}» sin huecos cargados es humo`);
    }
});

test('CONTROL · nombrar la hora de cierre SIN decir que es el horario no exime', () => {
    // Es la condición 3, y sin ella «te apunto a las 19:00» pasaría por horario solo porque
    // las 19:00 no son reservables.
    assert.ok(!exento('Te apunto a las 19:00'));
    assert.ok(!exento('Tengo hueco a las 19:00, ¿te va bien?'));
});

test('CONTROL · dar la reserva por hecha no exime, aunque diga el horario', () => {
    assert.ok(!exento('Ya te he reservado. Cerramos a las 19:00'));
});

test('CONTROL · ofrecer la hora de CIERRE como hueco tampoco exime', () => {
    // Es lo único que la hora no reservable no separa por sí sola: el modelo PUEDE ofrecer
    // una hora imposible, y ahí el mensaje no declara el horario, lo propone. Lo para
    // `asksForBookingApproval`, puesta SOLO en esta mitad de la disyunción — en la de las
    // dos puntas mataría «Мы работаем с 11:00 до 15:00. Какое время тебе подойдёт?».
    assert.ok(!exento('Nuestro horario cierra a las 19:00. ¿Te va bien a las 19:00?'));
    assert.ok(!exento('Cerramos a las 19:00, ¿te apunto a esa hora? ¿Te viene bien las 19:00?'));
});

test('CONTROL · una hora RESERVABLE mezclada con la declaración no exime', () => {
    // Es la condición 1 (`soloHorario`), y hace falta el horario ENTERO para medirla: con una
    // sola punta la disyunción ya condena el mensaje por su cuenta, así que el bloque no
    // vería caerse la condición 1. Con las dos puntas dichas, lo único que separa este
    // mensaje de un horario legítimo es ese 15:00 que sí puede ser un hueco.
    assert.ok(!exento('Abrimos de 10:00 a 19:00, y tengo libre a las 15:00'));
    assert.ok(!exento('Abrimos hasta las 19:00, y tengo libre a las 15:00'));
});

test('CONTROL · dos horas libres inventadas no son un horario aunque suenen a él', () => {
    assert.ok(!exento('Estamos abiertos: tengo libre a las 11:00 y a las 15:00'));
});

test('RESIDUO · la hora de apertura SOLA sigue sin exención, y es a propósito', () => {
    // Las 10:00 sí son reservables: ese mensaje y una oferta a las 10:00 no se distinguen.
    assert.ok(!exento('Abrimos a las 10:00'));
});

// ─── 3 · Lo de siempre, que no se mueve ──────────────────────────────────────

test('las DOS puntas siguen eximiendo, con y sin la hora imposible de la clienta', () => {
    assert.ok(exento('Abrimos de 10:00 a 19:00'));
    assert.ok(exento('A las 23:00 no abrimos: nuestro horario es de 10:00 a 19:00'));
    assert.ok(exento('Мы работаем с 10:00 до 19:00. Какое время тебе подойдёт?'));
});

test('sin business_hours utilizable no se exime NADA (regla 3)', () => {
    for (const h of [null, [], undefined]) {
        assert.strictEqual(soloDeclaraHorarioDelSalon('Cerramos a las 19:00', ['19:00'], h), false,
            'sin horario que consultar, la exención no se inventa un límite');
    }
});
