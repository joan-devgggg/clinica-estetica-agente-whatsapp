/**
 * tests/cancelar-enclitico.test.js — «Cancélala» es pedir cancelar.
 *
 * Hallazgo lateral del caso Celeste González (06/08/2026). `detectCancelRequest` llevaba una
 * lista literal de formas —cancelar|cancela|cancelame|anular|anula|anulame|cancelo— que tenía
 * el enclítico -me pero no el -la/-lo. En español ese es el modo normal de pedirlo, y
 * «Cancélala» devolvía **null**: el turno no lo cogía la capa determinista (que recita la cita
 * y espera un sí) sino el `accion` del modelo, que entonces cancelaba directo. Perdió su cita
 * 60 segundos después de reservarla.
 *
 * Los dos lados importan igual. Un detector demasiado ancho es peor que el agujero: haría
 * pasar por petición de cancelar nuestro propio acuse ("Tu cita ha sido cancelada ✅").
 */
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { test } = require('node:test');
const { detectCancelRequest } = require('../services/helpers');

const explicita = txt => {
    const r = detectCancelRequest(txt);
    return r && r.fuerza === 'explicita';
};

test('EL CASO: "Cancélala" es una petición explícita de cancelar', () => {
    assert.ok(explicita('Cancélala'), 'lo que escribió Celeste, y devolvía null');
    assert.ok(explicita('No entiendo\nCancélala'), 'tal cual llegó, con los dos mensajes juntos');
});

test('el verbo con sus enclíticos, que es como se pide de verdad', () => {
    for (const txt of [
        'cancélala', 'cancélalo', 'cancélalas', 'cancélalos',
        'cancélame la cita', 'cancélamela', 'cancélamelo',
        'quiero cancelarla', 'puedes cancelármela', 'cancelarlo por favor',
        'anúlala', 'anúlamela', 'anular la cita', 'anúlame la cita',
        'cancele mi cita', 'cancelen la cita',
    ]) {
        assert.ok(explicita(txt), `debería detectarse: ${txt}`);
    }
});

test('lo que ya funcionaba sigue funcionando', () => {
    for (const txt of ['cancelar mi cita', 'cancela la cita', 'cancélame la cita', 'cancelo la cita',
        'cancel my appointment', 'отменить запись', 'скасувати запис']) {
        assert.ok(explicita(txt), `regresión: ${txt}`);
    }
});

test('NUESTRO acuse no es una petición de cancelar', () => {
    // Si esto casara, un eco o una cita del propio mensaje reabriría el flujo de cancelación.
    assert.ok(!detectCancelRequest('Tu cita ha sido cancelada ✅ Si quieres reservar otra, dímelo'));
    assert.ok(!detectCancelRequest('el pedido fue cancelado'));
    assert.ok(!detectCancelRequest('la cita quedó cancelada'));
});

test('hablar DE una cancelación no es pedirla', () => {
    assert.ok(!detectCancelRequest('¿cuál es la política de cancelación?'));
    assert.ok(!detectCancelRequest('¿hay gastos de cancelacion?'));
});

test('palabras que solo empiezan igual no cuentan', () => {
    assert.ok(!detectCancelRequest('tengo cáncer, ¿puedo hacerme el tratamiento?'),
        'un falso positivo aquí abriría el flujo de cancelar en la peor conversación posible');
    assert.ok(!detectCancelRequest('me gusta el color canela'));
});

test('la señal implícita sigue siendo implícita, no explícita', () => {
    // Importa porque bot.js las trata distinto: la implícita se ignora si hay huecos sobre la
    // mesa, donde "no puedo ir el miércoles" es rechazar un hueco y no cancelar nada.
    assert.strictEqual(detectCancelRequest('no puedo ir el miércoles')?.fuerza, 'implicita');
    assert.strictEqual(detectCancelRequest('no podré ir')?.fuerza, 'implicita');
});
