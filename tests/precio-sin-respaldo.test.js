// El precio que dice la clienta se lee, se compara y se corrige (12/08/2026).
//
// Mariola Mira Lopez escribió «El masaje capilar el de 60 euros» y recibió «Perfecto, el Spa
// Hair Detox de 60 minutos» — su propia cifra devuelta con OTRA UNIDAD, que es la forma más
// cara de la regla 3: un dato que no resolvió, reciclado con otro significado y con pinta de
// acuerdo. Un turno después, «cuesta 115€». Nunca se le dijo que a 60 € no había ningún
// masaje. Y probablemente ella tenía razón: a 60 € el catálogo tiene la Reconstrucción Pro
// Miracle, que es justo lo que nombró ella sola en el turno siguiente.
//
// Hasta hoy ese número no lo leía nadie: la única regla del código que lo miraba era
// NO_ES_HORA_DETRAS, y solo para tirarlo. Las diez redes anti-mentira cubrían huecos,
// fechas, horarios, cierres y afirmaciones de reserva; el precio era el único dato duro del
// salón sin red.
//
// Probado con DOS mutaciones:
//   · quitar la exención ('atendido' → 'ninguna' cuando la respuesta nombra la cifra) tumba
//     el bloque 4 — la red se volvería contra la respuesta BUENA;
//   · hacer que la red dispare sin resolver servicio (quitar el `if (!servicio)`) tumba el
//     bloque 5 — una pregunta pasaría a ser una mentira.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { extractPrecioMencionado, catalogEntriesAtPrice, extractMentionedHours } = require('../services/helpers');
const { _internals } = require('../bot');
const { respondsWithUnbackedPrice, salonPrecioNoCasaMsg } = _internals;

// El FIXTURE, no el catálogo de Supabase (que la dueña edita): aquí se prueba la red, y el
// catálogo solo aporta una forma realista. Lo que se afirma abajo sobre «lo que hay a 60 €»
// es una propiedad DE ESTE FIXTURE, elegida porque reproduce el caso de Mariola — no una
// afirmación sobre lo que Yulia tenga hoy en el catálogo. Eso vive en verify:sante.
const CATALOGO = require('./fixtures/sante-catalog.json').services;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── 1 · Leer la cifra ───────────────────────────────────────────────────────

test('REGRESIÓN · el mensaje literal de Mariola da 60', () => {
    assert.deepStrictEqual(extractPrecioMencionado('El masaje capilar el de 60 euros'), [60]);
});

test('las formas en que se escribe un precio', () => {
    assert.deepStrictEqual(extractPrecioMencionado('cuesta 115€'), [115]);
    assert.deepStrictEqual(extractPrecioMencionado('76,50 €'), [76.5]);
    assert.deepStrictEqual(extractPrecioMencionado('por 45 eur'), [45]);
    assert.deepStrictEqual(extractPrecioMencionado('€30'), [30]);
});

test('CRÍTICO · un número SIN sufijo de dinero no es un precio', () => {
    // «el de 60» puede ser el largo, los minutos o el número de la mecha. Y la unidad es
    // justo lo que el bot confundió: la clienta dijo euros y él contestó minutos.
    assert.deepStrictEqual(extractPrecioMencionado('el de 60'), []);
    assert.deepStrictEqual(extractPrecioMencionado('dura 60 minutos'), []);
    assert.deepStrictEqual(extractPrecioMencionado('a las 5'), []);
    assert.deepStrictEqual(extractPrecioMencionado('30% de descuento'), []);
});

test('CONTENCIÓN · el dinero y las horas comparten vocabulario y NO se pisan', () => {
    // MONEDA_SUFIJOS alimenta a los dos: a extractPrecioMencionado para capturar y a
    // NO_ES_HORA_DETRAS para descartar. Con dos listas, añadir un sufijo a una dejaría a la
    // otra ciega sin que nada lo delatara.
    assert.deepStrictEqual(extractMentionedHours('el de 60 euros'), []);
    assert.deepStrictEqual(extractPrecioMencionado('a las 5'), []);
    assert.deepStrictEqual(extractMentionedHours('a las 5'), ['17:00']);
});

test('en el fixture, a 60 € hay cosas y una es la que ella nombró después', () => {
    const nombres = catalogEntriesAtPrice(CATALOGO, 60).map(s => s.nombre);
    assert.ok(nombres.includes('Reconstrucción Pro Miracle'), `no está: ${nombres.join(', ')}`);
    assert.ok(nombres.length >= 2);
    // Y no hay ningún masaje a 60 €, que es lo que ella pidió.
    const masajes = catalogEntriesAtPrice(CATALOGO, 60).filter(s => s.categoria === 'Masajes y SPA');
    assert.strictEqual(masajes.length, 0);
});

// ─── 2 · La red, sobre el turno real ─────────────────────────────────────────

test('REGRESIÓN · «el Spa Hair Detox de 60 minutos» con 60 € pedidos → rectificar', () => {
    const v = respondsWithUnbackedPrice('Perfecto, el Spa Hair Detox de 60 minutos 💆', 60, CATALOGO);
    assert.strictEqual(v.accion, 'rectificar');
    assert.strictEqual(v.servicio.nombre, 'Spa Hair Detox');
    assert.strictEqual(v.precioServicio, 115);
    assert.ok(v.opciones.some(o => o.nombre === 'Reconstrucción Pro Miracle'));
});

test('REGRESIÓN · el segundo turno, donde ella ya no repite la cifra', () => {
    // «El Detox … Dura 60 minutos y cuesta 115€.» Vigilar la cifra solo en el turno en que
    // se dice habría dejado pasar justo el mensaje que dio el precio equivocado.
    const v = respondsWithUnbackedPrice(
        'El Detox limpia y desintoxica el cuero cabelludo a fondo. Dura 60 minutos y cuesta 115€.', 60, CATALOGO);
    assert.strictEqual(v.accion, 'rectificar');
    assert.strictEqual(v.precioServicio, 115);
});

// ─── 3 · El texto dice las tres cosas ────────────────────────────────────────

test('el mensaje nombra el desajuste, lo que hay a esa cifra y el precio real', () => {
    const v = respondsWithUnbackedPrice('Perfecto, el Spa Hair Detox de 60 minutos', 60, CATALOGO);
    const msg = salonPrecioNoCasaMsg({ language: 'es' }, v);
    assert.ok(msg.includes('60 €'), 'no dice la cifra que pidió');
    assert.ok(msg.includes('115 €'), 'no dice el precio real');
    assert.ok(msg.includes('Reconstrucción Pro Miracle'), 'no ofrece lo que sí cuesta eso');
});

test('sin nada a ese precio, se dice que no hay — no se calla', () => {
    const v = respondsWithUnbackedPrice('El Spa Hair Detox cuesta lo que cuesta', 999, CATALOGO);
    assert.strictEqual(v.accion, 'rectificar');
    assert.strictEqual(v.opciones.length, 0);
    const msg = salonPrecioNoCasaMsg({ language: 'es' }, v);
    assert.ok(/no tengo nada a 999/i.test(msg), msg);
});

test('los cuatro idiomas dan textos distintos', () => {
    const v = respondsWithUnbackedPrice('Perfecto, el Spa Hair Detox', 60, CATALOGO);
    const vistos = new Set(['es', 'en', 'ru', 'uk'].map(l => salonPrecioNoCasaMsg({ language: l }, v)));
    assert.strictEqual(vistos.size, 4);
});

// ─── 4 · La EXENCIÓN, que es donde se pierde el mensaje bueno ────────────────

test('CRÍTICO · si la respuesta NOMBRA esa cifra, no se toca y se deja de vigilar', () => {
    // Sin esta salida, la red volvería a disparar en el turno siguiente contra la respuesta
    // BUENA —cuando la clienta ya ha elegido conscientemente el servicio de 115 €—. Es la
    // lección de respondsWithInventedSlots matando «cerramos a las 19:00»: una red demasiado
    // ancha no sobra un mensaje, pierde el bueno.
    const v = respondsWithUnbackedPrice(
        'A 60 € tengo la Reconstrucción Pro Miracle. El Spa Hair Detox son 115 €. ¿Cuál buscabas?',
        60, CATALOGO);
    assert.strictEqual(v.accion, 'atendido');
});

test('un servicio que SÍ cuesta lo que pidió tampoco se toca', () => {
    const v = respondsWithUnbackedPrice('Perfecto, la Reconstrucción Pro Miracle 💆', 60, CATALOGO);
    assert.strictEqual(v.accion, 'atendido');
});

// ─── 5 · Lo que NO dispara es la mitad del diseño ────────────────────────────

test('CRÍTICO · una respuesta que no resuelve ningún servicio NO es una mentira', () => {
    // Preguntar no es mentir. Si la red disparara aquí, sustituiría una pregunta legítima
    // por una corrección de precio que no viene a cuento.
    for (const r of ['¿Qué día te viene mejor?', '¡Hola! ¿Cómo te llamas?',
        'Claro, dime qué necesitas 😊']) {
        assert.strictEqual(respondsWithUnbackedPrice(r, 60, CATALOGO).accion, 'ninguna', r);
    }
});

test('un servicio con precio null («se confirma en el salón») no se contradice', () => {
    // La Consulta de valoración no tiene cifra: no hay nada que comparar, y el prompt tiene
    // prohibido darle un número.
    const conNull = [{ nombre: 'Consulta', categoria: 'Consulta', precio: null, duracion: 60 }];
    assert.strictEqual(respondsWithUnbackedPrice('Te reservo la Consulta', 60, conNull).accion, 'ninguna');
});

test('la cifra viaja en buildSessionExtra, y un 0 no se convierte en null', () => {
    // Sin viajar, una conversación que cruce un timeout pierde la cifra y la red deja de
    // tener contra qué comparar. Es la lección de session.tratamiento y de session.leadId.
    assert.strictEqual(_internals.buildSessionExtra({ orgType: 'salon', precioPedido: 60 }).precioPedido, 60);
    assert.strictEqual(_internals.buildSessionExtra({ orgType: 'salon' }).precioPedido, null);
    // San Remo no lleva nada de esto.
    assert.strictEqual(_internals.buildSessionExtra({ orgType: 'restaurant', precioPedido: 60 }).precioPedido, undefined);
});

test('sin cifra pedida, la red no existe', () => {
    assert.strictEqual(respondsWithUnbackedPrice('El Spa Hair Detox son 115 €', null, CATALOGO).accion, 'ninguna');
    assert.strictEqual(respondsWithUnbackedPrice('El Spa Hair Detox son 115 €', 60, []).accion, 'ninguna');
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
