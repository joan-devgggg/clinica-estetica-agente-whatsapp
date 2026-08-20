/**
 * tests/sustituto-cita-viva.test.js — cuando la escalera se queda sin mensaje, lo primero
 * que mira es si la clienta YA tiene cita.
 *
 * De los 12 disparos del embudo del 14 al 20/08/2026 («Para mirarte los huecos primero
 * necesito saber qué servicio quieres»), la mitad fueron a personas que en ese instante
 * tenían una cita viva. Comprobado contra `appointments`, cita a cita:
 *
 *   08-14 11:40  «Voy ahora a las 12:00 para que podáis darme vuestra opinión»   cita el 15
 *   08-17 17:59  «¿tienes cita libre mañana a las 10?»                           cita el 27
 *   08-19 15:03  «Hola! No tengo ninguna cita reservada ese día»                 cita el 20
 *   08-20 13:25  «Sí» (moviendo la cita que acababa de reservar)                 cita el 22
 *
 * Y EL DATO ESTABA. `resolveCitasVivas` corre en TODOS los turnos del salón desde el
 * 04/08/2026 y llega al prompt como `__citasVivas`. Lo que no lo miraba era el sustituto:
 * él y las exenciones de la red consultan `citaEnCurso`, que solo pone `hidratarCitaEnSesion`
 * cuando ha casado uno de los cuatro detectores de TEXTO. Ninguna de esas cuatro frases casa
 * ninguno de los cuatro.
 *
 * Las tres conductas que fija este fichero:
 *
 *   1. Con cita viva se RECITA la cita en vez de pedir el servicio — y una sola vez por
 *      conversación, que repetirla cada turno sería el mismo bucle con otro texto.
 *   2. `null` (la lectura FALLÓ) no es `[]` (no tiene ninguna). Con null no se afirma nada
 *      y no sale ningún error: se cae al mensaje de siempre. Es el mismo criterio que ya
 *      aplica el prompt a este campo, y no puede ser distinto según quién lo lea.
 *   3. Con una VARIANTE pendiente la red ni siquiera dispara: la premisa «sin servicio,
 *      hablar de cuándo es humo» es falsa cuando el servicio está dicho y lo único que
 *      falta es elegir entre 40 € y 50 €.
 *
 * Sabotajes MEDIDOS (cp previo, 20/08/2026):
 *   · quitar la salida A entera ......... 9 rojos aquí + 3 en escalera-agenda.test.js
 *   · tratar `null` como `[]` (quitar el Array.isArray) ..................... 2 rojos
 *       los dos bloques del null: es el sabotaje que enseña que esa comprobación NO es
 *       defensiva, es la diferencia entre «no tiene cita» y «no he podido mirar»
 *   · quitar la exención de variante pendiente .............................. 2 rojos
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');
const { _internals } = require('../bot');

const { salonNoSlotsMsg, proposesTimingWithoutService } = _internals;

const HORARIO = ['10:00', '19:00'];
const CITA = {
    id: 'apt-1', servicio: 'Mechas 3 + Matiz plus',
    fecha: '2026-08-22', hora: '10:00', horaFin: '14:00', estilista: 'Irina',
};

const sesion = (extra = {}) => ({
    language: 'es', partialData: {}, sinServicioStreak: 0, availableSlots: [], ...extra,
});

// El embudo, para poder afirmar que NO sale.
const esElEmbudo = m => /necesito saber qué servicio quieres/i.test(m);

// ─── 1 · La salida A ─────────────────────────────────────────────────────────

test('con cita viva, el sustituto RECITA la cita en vez de pedir el servicio', () => {
    const s = sesion({ _citasVivasTurno: [CITA] });
    const msg = salonNoSlotsMsg(s);
    assert.ok(!esElEmbudo(msg), `salió el embudo a alguien que ya tiene cita:\n${msg}`);
    assert.ok(/Mechas 3 \+ Matiz plus/.test(msg), `la cita no se recita entera:\n${msg}`);
    assert.ok(/Irina/.test(msg), 'con su estilista');
    assert.ok(/22 de agosto/.test(msg), 'y con su día');
    assert.strictEqual(s._salidaSustituto, 'cita_viva');
});

test('recitar la cita NO gasta intento: no es un turno perdido buscando el servicio', () => {
    // Si lo gastara, dos turnos así la empujarían al menú de rescate y al cuarto a una
    // escalada — por algo que sí hemos sabido contestar. Mismo criterio que el gate de
    // horario, que tampoco toca el contador.
    const s = sesion({ _citasVivasTurno: [CITA] });
    salonNoSlotsMsg(s);
    assert.strictEqual(s.sinServicioStreak, 0);
});

test('se recita UNA vez por conversación: a la segunda, la cadena de siempre', () => {
    const s = sesion({ _citasVivasTurno: [CITA] });
    const primera = salonNoSlotsMsg(s);
    const segunda = salonNoSlotsMsg(s);
    assert.ok(/Mechas 3/.test(primera));
    assert.ok(!/Mechas 3/.test(segunda), 'repetirle su cita cada turno es el bucle con otro texto');
    assert.strictEqual(s._salidaSustituto, 'pedir_servicio');
});

test('con VARIAS citas se recitan todas: elegir una por ella sería adivinar', () => {
    const otra = { ...CITA, id: 'apt-2', servicio: 'Manicura + gel', fecha: '2026-08-29', hora: '17:00', estilista: 'Olga' };
    const msg = salonNoSlotsMsg(sesion({ _citasVivasTurno: [CITA, otra] }));
    assert.ok(/Mechas 3/.test(msg) && /Manicura \+ gel/.test(msg), `faltan citas:\n${msg}`);
});

// ─── 2 · null NO es cero ─────────────────────────────────────────────────────

test('lectura FALLIDA (null): no se afirma nada, no sale ningún error, se sigue como siempre', () => {
    // Es la condición que puso el dueño: en un camino que corre siempre, que la lectura
    // falle significa «sigo sin ese contexto», nunca un mensaje de error a la clienta.
    const s = sesion({ _citasVivasTurno: null });
    const msg = salonNoSlotsMsg(s);
    assert.ok(esElEmbudo(msg), 'sin poder mirar, el mensaje es el de siempre');
    assert.ok(!/no tienes|no me consta|no encuentro/i.test(msg),
        `no se puede afirmar que no tiene citas por no haber podido mirar:\n${msg}`);
    assert.ok(!/error|problema|no he podido/i.test(msg),
        `un fallo de lectura no puede convertirse en un mensaje de avería:\n${msg}`);
    assert.strictEqual(s.sinServicioStreak, 1, 'y sí gasta intento: aquí no se ha contestado nada');
});

test('sin citas de verdad ([]) el mensaje es el mismo que con null — y es correcto', () => {
    const s = sesion({ _citasVivasTurno: [] });
    assert.ok(esElEmbudo(salonNoSlotsMsg(s)));
    assert.strictEqual(s._salidaSustituto, 'pedir_servicio');
});

test('con SERVICIO ya elegido la salida A no pinta nada: esa rama no es suya', () => {
    const s = sesion({ selectedService: { nombre: 'Manicura', categoria: 'Uñas' }, _citasVivasTurno: [CITA] });
    const msg = salonNoSlotsMsg(s);
    assert.ok(!/Mechas 3/.test(msg), 'con servicio elegido el sustituto habla de huecos, no de su otra cita');
});

// ─── 3 · La exención de variante pendiente ───────────────────────────────────

test('con una VARIANTE pendiente la red no dispara: el servicio SÍ está dicho', () => {
    // «un corte de mujer» deja pendingCorteMujerTipo (arreglo del 20/08). selectedService
    // sigue a null porque el catálogo tiene «Mujer y secado» (40 €) y «Mujer y peinado
    // Dyson» (50 €) y elegir por ella serían 10 € inventados — no porque no se sepa a qué
    // viene. Es el escenario 11 del arnés.
    for (const clave of ['pendingCorteGenero', 'pendingCorteMujerTipo',
        'pendingCorteNinoTipo', 'pendingLargoCategory']) {
        const s = sesion({ [clave]: clave === 'pendingLargoCategory' ? 'Mechas Balayage' : true });
        assert.strictEqual(proposesTimingWithoutService('¿Qué día te viene mejor?', s, HORARIO), false,
            `falla con ${clave}`);
    }
});

test('CONTROL sin variante pendiente la red sigue disparando', () => {
    // Sin este bloque, ensanchar la exención a cualquier cosa pasaría desapercibido.
    assert.strictEqual(proposesTimingWithoutService('¿Qué día te viene mejor?', sesion(), HORARIO), true);
});

test('CONTROL la exención suelta el CUÁNDO, no la mentira: una hora sin respaldo sigue cazada', () => {
    // Con una variante pendiente `loadAvailableSlots` no ha cargado nada (exige
    // selectedService), así que cualquier hora concreta la ven las otras dos redes. Aquí se
    // afirma que la exención no las toca.
    const s = sesion({ pendingCorteMujerTipo: true });
    assert.strictEqual(_internals.respondsWithInventedSlots('Te puedo dar las 11:30', [], HORARIO), true);
    assert.strictEqual(_internals.respondsWithInventedDates('Te va bien el 27 de agosto', [], {}), true);
    // Y la red exenta, efectivamente, no dispara — que es lo que la hace inofensiva aquí.
    assert.strictEqual(proposesTimingWithoutService('Te puedo dar las 11:30', s, HORARIO), false);
});
