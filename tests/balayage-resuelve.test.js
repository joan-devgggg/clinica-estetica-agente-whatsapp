// Balayage entra al flujo de largo sin depender del LLM (06/08/2026).
//
// El escenario 3 del arnés LLM («valayage») degradaba 2 de cada 3 corridas. La causa NO era
// el typo: `detectLargoCategory` casaba la categoría exigiendo su nombre COMPLETO como
// subcadena ("mechas balayage"), y `largoKeywords` no tenía entrada para balayage — la única
// categoría con variantes de largo que faltaba. Así que "quiero un balayage", bien escrito,
// tampoco entraba: `pendingLargoCategory` se quedaba a null, el turno del largo no resolvía
// nada, y el servicio solo aterrizaba si el modelo rellenaba `datos.servicio` por su cuenta.
// Diagnóstico completo en docs/escenario-3-servicio-sin-resolver.md.
//
// Determinista y sin red: se prueban las DOS piezas que bot.js encadena para resolver un
// servicio por largo, contra el catálogo fijo del repo (no contra Supabase, que la dueña
// edita). El cableado de esas piezas dentro de bot.js lo cubre el escenario 3 del arnés LLM.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    detectLargoCategory, extractLargoPelo, classifyLargoVariant, normalizeText,
} = require('../services/helpers');

const CATALOGO = require('./fixtures/sante-catalog.json').services;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Segundo paso, tal como lo hace bot.js: dentro de la categoría pendiente, las variantes
// ordenadas por largo y elegida por posición.
function resolverVariante(categoria, texto) {
    const largo = extractLargoPelo(texto);
    if (largo == null) return null;
    const catNorm = normalizeText(categoria);
    const candidatas = CATALOGO
        .filter(s => normalizeText(s.categoria) === catNorm && classifyLargoVariant(s.nombre) != null)
        .sort((a, b) => classifyLargoVariant(a.nombre) - classifyLargoVariant(b.nombre));
    return candidatas[Math.min(largo - 1, candidatas.length - 1)] || null;
}

// ─── El arreglo ──────────────────────────────────────────────────────────────

test('REGRESIÓN · "balayage" a secas entra al flujo de largo', () => {
    // Este es el caso que fallaba, y NO lleva typo.
    assert.strictEqual(detectLargoCategory('quiero un balayage', CATALOGO), 'Mechas Balayage');
});

test('las formas reales con las que lo piden las clientas', () => {
    const frases = [
        'quiero un balayage',
        'balayage',
        'Hola, querría información de reflejos o balayage',   // Lorena Pérez, 03/08/2026
        'me gustaría hacerme balayage',
        'kiero un valayage',                                   // el typo del escenario 3
        'quiero mechas balayage',                              // la única que funcionaba antes
    ];
    for (const f of frases) {
        assert.strictEqual(detectLargoCategory(f, CATALOGO), 'Mechas Balayage', `falla: "${f}"`);
    }
});

test('REGRESIÓN · los typos son ENUMERADOS, y «bayalage» es el de Nora (10/08/2026)', () => {
    // Nora Benedikte lo escribió tres veces —«im thinking bayalage», «I want a bayalage»,
    // «blonde bayalage»— y el servicio no aterrizó ninguna: el bloque determinista no
    // resolvía y el turno quedaba entero en manos del modelo. Nada de corrector difuso
    // genérico: cada grafía se añade a mano, con su falso positivo pensado.
    const frases = [
        'do you have an appoinment before thursday? im thinking bayalage',  // su 1er mensaje
        'I want a bayalage',
        'blonde bayalage',
        'quiero un baleage',
        'me apetece un balyage',
    ];
    for (const f of frases) {
        assert.strictEqual(detectLargoCategory(f, CATALOGO), 'Mechas Balayage', `falla: "${f}"`);
    }
});

test('los dos turnos completos: "valayage" → "medio" → servicio resuelto', () => {
    const categoria = detectLargoCategory('kiero un valayage', CATALOGO);
    assert.strictEqual(categoria, 'Mechas Balayage', 'turno 1: entra al flujo de largo');

    const svc = resolverVariante(categoria, 'medio');
    assert.ok(svc, 'turno 2: el largo tiene que resolver a un servicio concreto');
    assert.strictEqual(svc.categoria, 'Mechas Balayage');
    assert.strictEqual(svc.nombre, 'Cabello medio');
    // El dato que la clienta acaba viendo en la confirmación.
    assert.ok(Number.isFinite(svc.precio) && svc.precio > 0);
});

test('cada largo cae en su variante, no en la de al lado', () => {
    const cat = 'Mechas Balayage';
    assert.strictEqual(resolverVariante(cat, 'corto').nombre, 'Cabello corto');
    assert.strictEqual(resolverVariante(cat, 'medio').nombre, 'Cabello medio');
    assert.strictEqual(resolverVariante(cat, 'largo').nombre, 'Cabello largo');
});

// ─── Lo que no se puede haber roto ───────────────────────────────────────────

test('las demás categorías de largo siguen igual', () => {
    assert.strictEqual(detectLargoCategory('quiero mechas airtouch', CATALOGO), 'Mechas Airtouch');
    assert.strictEqual(detectLargoCategory('quiero mechas clasicas', CATALOGO), 'Mechas clásicas');
    assert.strictEqual(detectLargoCategory('quiero un alisado', CATALOGO), 'Alisado vegano');
    assert.strictEqual(detectLargoCategory('decoloracion', CATALOGO), 'Deco Total Blond');
});

test('lo que NO es una categoría de largo sigue devolviendo null', () => {
    for (const f of ['hola', 'quiero un corte de mujer', 'una manicura', 'quiero información',
        'me tienen que evaluar', '¿cuánto cuesta un piso?']) {
        assert.strictEqual(detectLargoCategory(f, CATALOGO), null, `no debería disparar: "${f}"`);
    }
});

test('sin catálogo no revienta', () => {
    assert.strictEqual(detectLargoCategory('balayage', []), null);
    assert.strictEqual(detectLargoCategory('balayage', null), null);
    assert.strictEqual(detectLargoCategory('', CATALOGO), null);
});

test('"balayage" no arrastra a una categoría que no tenga variantes de largo', () => {
    // La palabra clave solo resuelve si la categoría existe Y tiene >= 2 variantes de largo.
    // Con un catálogo donde Balayage es una entrada suelta, no debe inventarse el flujo.
    const suelto = [
        { nombre: 'Balayage', categoria: 'Mechas Balayage', precio: 200, duracion: 240 },
        { nombre: 'Mujer y secado', categoria: 'Cortes', precio: 40, duracion: 60 },
    ];
    assert.strictEqual(detectLargoCategory('quiero un balayage', suelto), null);
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
