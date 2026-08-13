// La red anti-cierre-falso mide contra `business_hours`, no contra "los domingos".
//
// Contexto: la red nació el 30/07/2026 por un bug real —pedicura con Olgha un sábado, y el
// bot contestó "el salón está cerrado" cuando lo que pasaba es que Olgha no trabaja los
// sábados— y se escribió con el hecho metido dentro: eximía la palabra «domingo» y disparaba
// con las otras seis. Era cierto, y sigue siéndolo hoy, pero lo medía contra una constante en
// git en vez de contra el dato que edita la dueña (regla 5).
//
// Los dos fallos que eso escondía son los dos primeros bloques de aquí, y ninguno de los dos
// se podía escribir con la versión vieja:
//   · si el salón abriera los domingos, la red BLOQUEARÍA la frase verdadera;
//   · si cerrara los lunes, DEJARÍA PASAR la mentira justo el día que existe.
//
// Puro: cero red, cero Supabase, cero LLM.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { respondsWithFalseClosureClaim } = require('../bot')._internals;
const { resolveDiasDeApertura } = require('../services/helpers');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

const dia = { apertura: '10:00', cierre: '19:00' };
// El horario real de Sante: seis días, sin 'domingo'. Un día ausente es un día cerrado.
const SANTE = {
    lunes: dia, martes: dia, miercoles: dia, jueves: dia, viernes: dia, sabado: dia,
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Lo que la versión vieja hacía bien, sigue igual
// ─────────────────────────────────────────────────────────────────────────────

test('con el horario de Sante, un cierre en día de apertura sigue siendo falso', () => {
    for (const frase of [
        'El sábado el salón está cerrado',
        'Ese lunes no abrimos',
        'On Saturday we are closed',
        'В понедельник у нас выходной',
        'У вівторок ми не працюємо',
    ]) {
        assert.ok(respondsWithFalseClosureClaim(frase, SANTE), frase);
    }
});

test('y el domingo, que sí cierra, sigue siendo legítimo', () => {
    for (const frase of [
        'Los domingos el salón está cerrado',
        "On Sundays we're closed",
        'В воскресенье у нас выходной',
        'У неділю зачинено',
    ]) {
        assert.ok(!respondsWithFalseClosureClaim(frase, SANTE), frase);
    }
});

test('sin afirmación de cierre no se toca nada, aunque nombre un día', () => {
    assert.ok(!respondsWithFalseClosureClaim('Te apunto el lunes a las 10:00', SANTE));
    assert.ok(!respondsWithFalseClosureClaim('Записал тебя на понедельник', SANTE));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Los dos casos que la constante no podía ver
// ─────────────────────────────────────────────────────────────────────────────

test('si la dueña abre los domingos, "los domingos cerramos" pasa a ser un cierre FALSO', () => {
    const conDomingo = { ...SANTE, domingo: dia };
    assert.ok(respondsWithFalseClosureClaim('Los domingos el salón está cerrado', conDomingo));
    assert.ok(respondsWithFalseClosureClaim('В воскресенье у нас выходной', conDomingo));
});

test('si cierra los lunes, "el lunes cerramos" pasa a ser VERDAD y no se bloquea', () => {
    const sinLunes = { ...SANTE };
    delete sinLunes.lunes;
    assert.ok(!respondsWithFalseClosureClaim('Los lunes el salón está cerrado', sinLunes));
    assert.ok(!respondsWithFalseClosureClaim('В понедельник у нас выходной', sinLunes));
    // Y el resto de la semana sigue vigilado con el mismo horario.
    assert.ok(respondsWithFalseClosureClaim('El sábado está cerrado', sinLunes));
});

// La exención mira PRIMERO el día que de verdad cierra: en una frase con los dos, la mitad
// cierta es la que manda. Sin este orden, «los domingos cerramos, y el lunes está completo»
// se bloquearía por nombrar el lunes, y es una respuesta correcta entera.
test('una frase que nombra un día cerrado y otro abierto no se bloquea', () => {
    assert.ok(!respondsWithFalseClosureClaim(
        'Los domingos cerramos, y el lunes lo tengo completo', SANTE));
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Sin horario utilizable, la red se calla
// ─────────────────────────────────────────────────────────────────────────────

// Regla 3 y la lección de respondsWithInventedSlots: sin saber qué días abre el salón no se
// puede distinguir la mentira de la verdad, y una red que no las distingue se come el mensaje
// bueno. Callar deja pasar el caso raro; disparar rompe el común.
test('sin business_hours utilizable no se bloquea nada', () => {
    for (const bh of [undefined, null, {}, 'lunes a sábado', { lunes: { apertura: 'diez', cierre: 'siete' } }]) {
        assert.ok(!respondsWithFalseClosureClaim('El sábado el salón está cerrado', bh),
            `no debía bloquear con business_hours = ${JSON.stringify(bh)}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. resolveDiasDeApertura, que es de donde sale todo lo anterior
// ─────────────────────────────────────────────────────────────────────────────

test('resolveDiasDeApertura: día ausente = cerrado', () => {
    assert.deepStrictEqual(resolveDiasDeApertura(SANTE), { abiertos: [0, 1, 2, 3, 4, 5], cerrados: [6] });
});

// Un día PRESENTE pero ilegible no cae en ninguna lista: no sabemos su franja, así que no se
// puede afirmar que abra — y declararlo cerrado sería inventarle un cierre al salón.
test('resolveDiasDeApertura: un día con horas ilegibles no es ni abierto ni cerrado', () => {
    const raro = { ...SANTE, sabado: { apertura: '25:00', cierre: '19:00' } };
    const r = resolveDiasDeApertura(raro);
    assert.ok(!r.abiertos.includes(5), 'no se afirma que abra');
    assert.ok(!r.cerrados.includes(5), 'ni que cierre');
    assert.deepStrictEqual(r.cerrados, [6], 'el domingo, que sigue ausente, sí es cierre');
});

test('resolveDiasDeApertura: apertura >= cierre no es un día abierto', () => {
    const r = resolveDiasDeApertura({ ...SANTE, martes: { apertura: '19:00', cierre: '10:00' } });
    assert.ok(!r.abiertos.includes(1));
});

test('resolveDiasDeApertura: sin ningún día utilizable devuelve null', () => {
    for (const bh of [null, undefined, {}, [], 'L-S', { domingo: { apertura: 'x', cierre: 'y' } }]) {
        assert.strictEqual(resolveDiasDeApertura(bh), null, JSON.stringify(bh));
    }
});
