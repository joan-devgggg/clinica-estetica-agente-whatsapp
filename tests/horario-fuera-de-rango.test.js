// Una hora pedida fuera del horario del salón se dice, y se dice ENTERA (07/08/2026).
//
// Olga Yarmak (34674987146) dijo TRES veces que solo podía «после 23:00» y nunca se le dijo
// que el salón cierra a las 19:00. Dos agujeros encadenados:
//
//   1. Nadie comparaba una hora pedida con el horario. `extractDateSignalSante` saca día,
//      fecha, semana y franja; la hora de reloj se cae entera.
//   2. La vía que quedaba —que lo dijera el LLM, que SÍ tiene el horario en el prompt— la
//      cortaba `respondsWithInventedSlots`: con `availableSlots` vacío, cualquier HH:MM del
//      texto es un hueco inventado, y «cerramos a las 19:00» son dos HH:MM. La respuesta
//      correcta era exactamente la que la red mataba, sustituida por el menú genérico.
//
// El horario NUNCA sale de una constante: `business_hours` lo edita la dueña desde el panel
// (regla 5). Por eso el fixture de aquí NO es el horario real de Sante — es otro a propósito,
// para que un test que pasara leyendo un 19:00 escrito en el código no pueda pasar.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { detectHoraFueraDeHorario, extractClockHours, hhmmToMin } = require('../services/helpers');
const { respondsWithInventedSlots, salonFueraDeHorarioMsg } = require('../bot.js')._internals;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Horario DISTINTO del de producción (11:00–20:00, y el sábado cierra antes): si algún día
// alguien vuelve a escribir el 19:00 en el código, estos tests se caen.
const HORARIO = {
    lunes:     { apertura: '11:00', cierre: '20:00' },
    martes:    { apertura: '11:00', cierre: '20:00' },
    miercoles: { apertura: '11:00', cierre: '20:00' },
    jueves:    { apertura: '11:00', cierre: '20:00' },
    viernes:   { apertura: '11:00', cierre: '20:00' },
    sabado:    { apertura: '11:00', cierre: '15:00' },
};

// ─── extractClockHours / hhmmToMin ───────────────────────────────────────────

test('extractClockHours normaliza a dos dígitos y encuentra varias', () => {
    assert.deepStrictEqual(extractClockHours('после 23:00'), ['23:00']);
    assert.deepStrictEqual(extractClockHours('de 9:30 a 20:00'), ['09:30', '20:00']);
    assert.deepStrictEqual(extractClockHours('sin ninguna hora'), []);
    assert.deepStrictEqual(extractClockHours(null), []);
});

test('hhmmToMin no confunde vacío con medianoche', () => {
    assert.strictEqual(hhmmToMin('23:00'), 1380);
    assert.strictEqual(hhmmToMin(''), null);
    assert.strictEqual(hhmmToMin(null), null);
    assert.strictEqual(hhmmToMin('25:00'), null);
});

// ─── detectHoraFueraDeHorario ────────────────────────────────────────────────

test('el caso de Olga: "после 23:00" cae fuera y devuelve el horario COMPLETO', () => {
    const r = detectHoraFueraDeHorario('Мне удобно вечером, после 23:00', HORARIO);
    assert.ok(r, '23:00 tiene que detectarse fuera de horario');
    assert.strictEqual(r.hora, '23:00');
    // Las DOS puntas, no solo el cierre: sin la apertura hay que volver a preguntar.
    assert.strictEqual(r.apertura, '11:00');
    // Sin día concreto se usa el SOBRE de todos los días (el sábado cierra a las 15:00, pero
    // el resto a las 20:00): solo es imposible lo que lo es todos los días.
    assert.strictEqual(r.cierre, '20:00');
});

test('sin día concreto NO se rechaza una hora que vale algún día', () => {
    // Con la franja común (cierre 15:00, el del sábado) esto habría dicho "no abrimos" sobre
    // las 18:00, que de lunes a viernes son perfectamente válidas.
    assert.strictEqual(detectHoraFueraDeHorario('a las 18:00', HORARIO), null);
});

test('con día concreto se compara contra ESE día', () => {
    const lunes = detectHoraFueraDeHorario('el lunes a las 19:00', HORARIO, { diaSemana: 0 });
    assert.strictEqual(lunes, null, 'las 19:00 de un lunes están dentro (cierra a las 20:00)');
    const sabado = detectHoraFueraDeHorario('el sábado a las 19:00', HORARIO, { diaSemana: 5 });
    assert.ok(sabado, 'las 19:00 de un sábado están fuera (cierra a las 15:00)');
    assert.strictEqual(sabado.cierre, '15:00');
});

test('la hora de cierre EXACTA ya está fuera', () => {
    // Una cita que empieza al cierre termina con el salón cerrado. Mismo criterio que
    // calendar-sante, que descarta el hueco que arranca exactamente al cierre.
    const r = detectHoraFueraDeHorario('a las 20:00', HORARIO, { diaSemana: 0 });
    assert.ok(r);
    assert.strictEqual(r.hora, '20:00');
});

test('antes de abrir también está fuera', () => {
    const r = detectHoraFueraDeHorario('¿puedo a las 08:00?', HORARIO, { diaSemana: 0 });
    assert.ok(r);
    assert.strictEqual(r.hora, '08:00');
});

test('una hora DENTRO no dispara nada', () => {
    assert.strictEqual(detectHoraFueraDeHorario('a las 12:00', HORARIO, { diaSemana: 0 }), null);
    assert.strictEqual(detectHoraFueraDeHorario('sin horas', HORARIO), null);
});

test('si nombra también una hora válida, no es una petición fuera de horario', () => {
    // «¿a las 12:00 o mejor a las 23:00?» es una duda, no un imposible: contestarle el
    // horario sería ignorar que ya ha propuesto algo que sí vale.
    assert.strictEqual(detectHoraFueraDeHorario('¿a las 12:00 o a las 23:00?', HORARIO, { diaSemana: 0 }), null);
});

test('sin business_hours utilizable se calla: no se inventa un horario', () => {
    // Regla 3: si el dato no se resuelve, no se rellena con un default silencioso.
    assert.strictEqual(detectHoraFueraDeHorario('a las 23:00', null), null);
    assert.strictEqual(detectHoraFueraDeHorario('a las 23:00', {}), null);
    assert.strictEqual(detectHoraFueraDeHorario('a las 23:00', { lunes: {} }), null);
    // Un día sin entrada (domingo en Sante) no es asunto de este gate: tiene su propia red.
    assert.strictEqual(detectHoraFueraDeHorario('el domingo a las 12:00', HORARIO, { diaSemana: 6 }), null);
});

// ─── El mensaje dice el horario ENTERO ───────────────────────────────────────

test('el mensaje lleva apertura Y cierre, en los cuatro idiomas', () => {
    // Condición explícita del dueño: "a las 23:00 ya hemos cerrado" sin decir hasta cuándo
    // abren obliga a la clienta a preguntar otra vez.
    const datos = { hora: '23:00', apertura: '11:00', cierre: '15:00' };
    for (const language of ['es', 'en', 'ru', 'uk']) {
        const msg = salonFueraDeHorarioMsg({ language }, datos);
        assert.ok(msg.includes('11:00'), `${language}: falta la apertura`);
        assert.ok(msg.includes('15:00'), `${language}: falta el cierre`);
        assert.ok(msg.includes('23:00'), `${language}: falta la hora que pidió`);
    }
});

test('el mensaje usa las horas del CONFIG, no unas fijas', () => {
    const msg = salonFueraDeHorarioMsg({ language: 'es' }, { hora: '07:00', apertura: '09:30', cierre: '18:45' });
    assert.ok(msg.includes('09:30') && msg.includes('18:45'));
    assert.ok(!msg.includes('19:00'), 'no puede colarse el horario real de Sante');
});

// ─── La exención de respondsWithInventedSlots ────────────────────────────────
// Cuatro condiciones: todas las horas son puntas del horario, se dicen DOS puntas distintas,
// el texto se declara horario, y no da la reserva por hecha. Las dos del medio ocupan el
// sitio de asksForBookingApproval y son más estrictas que ella — bloquean también la
// propuesta que no pregunta nada. Lo que ninguna combinación puede dejar pasar es
// "te apunto a las 19:00" sin un solo hueco cargado.

const LIMITES = ['11:00', '15:00', '20:00'];

test('SIN la exención: decir el horario del salón se marcaba como hueco inventado', () => {
    // Este es el bug tal cual: con availableSlots vacío, la respuesta CORRECTA se bloqueaba.
    assert.strictEqual(
        respondsWithInventedSlots('Cerramos a las 15:00, a las 23:00 ya no podemos', [], null),
        true,
        'sin pasarle los límites, el comportamiento antiguo se conserva',
    );
});

test('CON la exención: el horario pasa, en los cuatro idiomas', () => {
    const casos = [
        'Nuestro horario es de 11:00 a 15:00. ¿Qué hora te viene bien?',
        'We are open 11:00 to 15:00. Which time suits you?',
        'Мы работаем с 11:00 до 15:00. Какое время тебе подойдёт?',
        'Ми працюємо з 11:00 до 15:00. Який час тобі підійде?',
    ];
    for (const texto of casos) {
        assert.strictEqual(respondsWithInventedSlots(texto, [], LIMITES), false, texto);
    }
});

test('la exención NO deja pasar una reserva dada por hecha sobre una hora límite', () => {
    // Sin llmClaimsBooked en la condición, esto se colaría: 20:00 es un límite del horario.
    assert.strictEqual(
        respondsWithInventedSlots('Te apunto a las 20:00, ¡nos vemos!', [], LIMITES),
        true,
        'una cita dada por hecha sin huecos reales sigue siendo invención',
    );
    assert.strictEqual(
        respondsWithInventedSlots('Записала тебя на 20:00', [], LIMITES),
        true,
        'lo mismo en ruso: llmClaimsBooked reconoce el cirílico',
    );
});

test('la exención NO deja pasar una propuesta que pide aprobación', () => {
    // Una sola hora no es un horario: es una propuesta de hueco sin respaldo, que es
    // exactamente lo que la red existe para parar.
    assert.strictEqual(
        respondsWithInventedSlots('¿Te va bien a las 11:00?', [], LIMITES),
        true,
    );
    assert.strictEqual(
        respondsWithInventedSlots('Записал тебя на 11:00. Тебе подойдёт?', [], LIMITES),
        true,
    );
});

test('dos puntas del horario SIN decir que son el horario tampoco pasan', () => {
    // "Tengo libre a las 11:00 y a las 15:00" son dos puntas y no promete nada, pero está
    // ofreciendo huecos que no existen. Sin el marcador de horario se colaría.
    assert.strictEqual(
        respondsWithInventedSlots('Tengo libre a las 11:00 y a las 15:00', [], LIMITES),
        true,
    );
    assert.strictEqual(
        respondsWithInventedSlots('Свободно в 11:00 и в 15:00', [], LIMITES),
        true,
    );
});

// Los dos de abajo AÍSLAN una condición cada uno. Sin ellos, quitar `llmClaimsBooked` o el
// requisito de dos puntas dejaba los 21 tests en verde: el marcador de horario tapaba a las
// otras dos y ninguna estaba realmente protegida (comprobado mutando bot.js, 07/08/2026).

test('marcador de horario + reserva dada por hecha → sigue bloqueado', () => {
    // Aquí TODO lo demás se cumple —dos puntas distintas y un "nuestro horario" delante—,
    // así que lo único que puede pararlo es llmClaimsBooked. Es el caso que el dueño señaló:
    // sin esa condición, una cita dada por hecha sin un solo hueco se colaría por la exención.
    assert.strictEqual(
        respondsWithInventedSlots('Nuestro horario es de 11:00 a 15:00. Te apunto a las 15:00', [], LIMITES),
        true,
    );
    assert.strictEqual(
        respondsWithInventedSlots('Мы работаем с 11:00 до 15:00. Записала тебя на 15:00', [], LIMITES),
        true,
    );
});

test('marcador de horario + UNA sola punta ofrecida → sigue bloqueado', () => {
    // Dice "horario" y no promete nada, pero ofrece UNA hora concreta sin ningún hueco
    // detrás. Lo único que lo para es exigir dos puntas: un horario tiene principio y fin.
    assert.strictEqual(
        respondsWithInventedSlots('Nuestro horario cierra a las 20:00. ¿Te va bien a las 20:00?', [], LIMITES),
        true,
    );
});

test('el falso positivo que obligó a cambiar la condición', () => {
    // «подойдёт» está en BOOKING_APPROVAL_QUESTIONS (lo necesita la red anti-cita-fantasma
    // para no confundir una propuesta con una reserva hecha). Usar asksForBookingApproval en
    // la exención habría bloqueado la respuesta CORRECTA en ruso más natural que existe.
    assert.strictEqual(
        respondsWithInventedSlots('Мы работаем с 11:00 до 15:00. Какое время тебе подойдёт?', [], LIMITES),
        false,
    );
});

test('la respuesta que de verdad manda el bot pasa la red', () => {
    // Cierre del círculo: el mensaje determinista de salonFueraDeHorarioMsg no puede ser
    // bloqueado por la red que este arreglo existe para esquivar.
    for (const language of ['es', 'en', 'ru', 'uk']) {
        const msg = salonFueraDeHorarioMsg({ language }, { hora: '23:00', apertura: '11:00', cierre: '15:00' });
        assert.strictEqual(respondsWithInventedSlots(msg, [], LIMITES), false, `${language}: ${msg}`);
    }
});

test('una hora que NO es límite del horario sigue siendo invención', () => {
    // La exención solo cubre las puntas del horario. Un 12:30 sin huecos es un hueco inventado.
    assert.strictEqual(respondsWithInventedSlots('Tengo libre a las 12:30', [], LIMITES), true);
});

test('con huecos reales la exención no cambia nada', () => {
    const slots = [{ hora: '12:00' }, { hora: '12:30' }];
    assert.strictEqual(respondsWithInventedSlots('Tengo a las 12:00', slots, LIMITES), false);
    assert.strictEqual(respondsWithInventedSlots('Tengo a las 17:00', slots, LIMITES), true);
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
