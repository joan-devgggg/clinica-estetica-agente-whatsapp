// El detector de servicio hablaba SOLO castellano (09/08/2026).
//
// Michal Gradziel (447432204269, 07/08/2026) pidió una decoloración completa en inglés
// —«near platinum», «full platinum blonde», «colouring my hair from dark to cool platinum»—
// y `detectLargoCategory` no reconoció nada: sus keywords para Deco Total Blond eran
// ['total blond','decoloracion','decolorar','deco'], todas en castellano. `selectedService`
// se quedó a null toda la conversación, el bot pasó a preguntar día y franja sin saber el
// servicio, inventó tres horas («around 10, 11, or 12») y acabó repreguntando el servicio a
// una clienta que ya lo había dicho tres veces. La conversación murió a las 11:10 y la cita
// (Deco Total Blond Corto + Retocar mujer) la cerró una persona a mano nueve minutos después.
//
// La cobertura inglesa que había era accidental: solo 'straighten'/'keratin' en alisado,
// 'highlights' en el mapa de categorías y 'haircut'/'cut' en cortes. Para una clienta
// anglófona, que el servicio aterrizase dependía al 100 % de que el LLM rellenase
// `datos.servicio` con un nombre del catálogo EN CASTELLANO — la misma moneda al aire del
// escenario 3, cargada en contra.
//
// Mismo molde que tests/balayage-resuelve.test.js: catálogo fijo del repo, cero red.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { detectLargoCategory } = require('../services/helpers');

const CATALOGO = require('./fixtures/sante-catalog.json');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── El caso que lo pagó ─────────────────────────────────────────────────────

test('REGRESIÓN · las frases EXACTAS de Michal resuelven a Deco Total Blond', () => {
    const frases = [
        'I was thinking of that shade. Kind of icy, near platinum, not too warm or gold / honey',
        'colouring my hair from dark to cool platinum',
        'full platinum blonde',
    ];
    for (const f of frases) {
        assert.strictEqual(detectLargoCategory(f, CATALOGO), 'Deco Total Blond', `falla: "${f}"`);
    }
});

test('las otras formas de pedir una decoloración en inglés', () => {
    for (const f of ['I want to bleach my hair', 'bleaching', 'full decolorisation please',
        'I want to go blonde', 'can you do lightening?']) {
        assert.strictEqual(detectLargoCategory(f, CATALOGO), 'Deco Total Blond', `falla: "${f}"`);
    }
});

test('ruso y ucraniano, que son los otros dos idiomas del salón', () => {
    assert.strictEqual(detectLargoCategory('хочу обесцвечивание', CATALOGO), 'Deco Total Blond');
    assert.strictEqual(detectLargoCategory('хочу освітлення волосся', CATALOGO), 'Deco Total Blond');
    assert.strictEqual(detectLargoCategory('хочу кератин', CATALOGO), 'Alisado vegano');
    assert.strictEqual(detectLargoCategory('хочу кератинове випрямлення', CATALOGO), 'Alisado vegano');
});

test('las demás categorías de largo, también en inglés', () => {
    assert.strictEqual(detectLargoCategory('keratin straightening', CATALOGO), 'Alisado vegano');
    assert.strictEqual(detectLargoCategory('I want airtouch', CATALOGO), 'Mechas Airtouch');
    assert.strictEqual(detectLargoCategory('classic highlights please', CATALOGO), 'Mechas clásicas');
    assert.strictEqual(detectLargoCategory('a full colour', CATALOGO), 'Color Premium');
    assert.strictEqual(detectLargoCategory('anti frizz treatment', CATALOGO), 'Anti-encrespamiento');
});

// NOTA · el match por tokens del nombre de categoría se dejó FUERA a propósito.
// Estaba en el plan («en vez de subcadena del nombre completo»), pero al escribir su test
// resultó pasar con y sin el cambio: las cinco categorías con variantes de largo tienen ya
// keyword propia, así que «mechas tipo balayage» o «mechas de airtouch» entran igual por
// ahí. Un test que no distingue no protege nada (regla 2), y aflojar el match de categoría
// es la mitad arriesgada del arreglo. Se hará el día que una categoría sin keyword lo pida.

// ─── Lo que no se puede haber roto ───────────────────────────────────────────

test('el castellano sigue exactamente igual', () => {
    assert.strictEqual(detectLargoCategory('quiero un balayage', CATALOGO), 'Mechas Balayage');
    assert.strictEqual(detectLargoCategory('kiero un valayage', CATALOGO), 'Mechas Balayage');
    assert.strictEqual(detectLargoCategory('quiero mechas airtouch', CATALOGO), 'Mechas Airtouch');
    assert.strictEqual(detectLargoCategory('quiero mechas clasicas', CATALOGO), 'Mechas clásicas');
    assert.strictEqual(detectLargoCategory('quiero un alisado', CATALOGO), 'Alisado vegano');
    assert.strictEqual(detectLargoCategory('decoloracion', CATALOGO), 'Deco Total Blond');
});

test('FALSO POSITIVO · describirse el pelo no es pedir una decoloración', () => {
    // "blonde" a secas se dejó FUERA a propósito: "I'm blonde and I want a haircut" es una
    // descripción, no un servicio, y meterla en el flujo de largo le preguntaría a la clienta
    // el largo de una decoloración que nunca pidió. 'platinum', 'bleach' y 'decolorisation'
    // no tienen ese problema: nadie los dice de pasada.
    assert.strictEqual(detectLargoCategory("I'm blonde, I want a haircut", CATALOGO), null);
    assert.strictEqual(detectLargoCategory('my hair is blonde', CATALOGO), null);
});

test('lo que NO es una categoría de largo sigue devolviendo null', () => {
    for (const f of ['hello', 'I want a haircut', 'a manicure please', 'hola',
        'quiero un corte de mujer', 'una manicura', '¿cuánto cuesta un piso?']) {
        assert.strictEqual(detectLargoCategory(f, CATALOGO), null, `no debería disparar: "${f}"`);
    }
});

test('sin catálogo no revienta', () => {
    assert.strictEqual(detectLargoCategory('platinum', []), null);
    assert.strictEqual(detectLargoCategory('platinum', null), null);
    assert.strictEqual(detectLargoCategory('', CATALOGO), null);
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
