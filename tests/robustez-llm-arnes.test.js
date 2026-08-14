// La parte PURA del arnés verify:robustez:llm (tests/lib/robustez-llm-helpers.js),
// añadida el 14/08/2026 para que escale de 25 a ~100 escenarios: selección (rangos,
// familias, idiomas, shard), reintento del degradado suelto, corte por proveedor caído y
// resumen agrupado. El arnés entero solo se puede probar pagando una corrida de LLM; sus
// políticas, aquí, gratis y en verde/rojo.
//
// Visto fallar sin lo que protege (sabotajes con cp previo, misma noche):
//   · quitar un idioma del FALLBACK_LLM_RE → rojo el bloque de los cuatro literales;
//   · hacer que el corte no se resetee con un escenario limpio → rojo su bloque;
//   · reintentar también la fila dura → rojo el bloque de la política.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { test } = require('node:test');
const {
    FALLBACK_LLM_RE, esFallbackLLM, CorteProveedor, debeReintentar,
    parseSeleccion, matchesSeleccion, resumenAgrupado,
} = require('./lib/robustez-llm-helpers');

// ─── El detector del fallback: los CUATRO literales de getFallbackResponse ───

test('los cuatro fallbacks del modelo, uno por idioma, casan; una respuesta normal no', () => {
    const fallbacks = [
        'Perdona, no he podido procesar tu mensaje. ¿Me lo repites? 😊',
        "Sorry, I couldn't process that. Could you repeat? 😊",
        'Извини, не удалось обработать. Можешь повторить? 😊',
        'Вибач, не вдалося обробити. Можеш повторити? 😊',
    ];
    for (const f of fallbacks) assert.ok(FALLBACK_LLM_RE.test(f), `debería casar: "${f}"`);
    for (const normal of [
        '¡Hola! Bienvenida a Santé 😊 ¿Qué necesitas hoy?',
        'El jueves a las 10:00 con Irina, ¿te va bien?',
        'No procesamos pagos por adelantado', // «procesar» de pasada no es el fallback
    ]) assert.ok(!FALLBACK_LLM_RE.test(normal), `NO debería casar: "${normal}"`);
    assert.ok(esFallbackLLM(['hola', fallbacks[2]]), 'basta un turno con fallback en la conversación');
    assert.ok(!esFallbackLLM(['hola', 'adiós']) && !esFallbackLLM([]) && !esFallbackLLM(null));
});

// ─── El corte por proveedor caído ────────────────────────────────────────────

test('tres escenarios seguidos con fallback abortan; uno limpio en medio resetea', () => {
    const c = new CorteProveedor();
    assert.strictEqual(c.registra(true), false);
    assert.strictEqual(c.registra(true), false);
    assert.strictEqual(c.registra(true), true, 'al tercero seguido, se corta');

    const c2 = new CorteProveedor();
    c2.registra(true); c2.registra(true);
    assert.strictEqual(c2.registra(false), false, 'un escenario limpio demuestra que el proveedor responde');
    assert.strictEqual(c2.registra(true), false, 'y la cuenta empieza de cero');
    assert.strictEqual(c2.registra(true), false);
    assert.strictEqual(c2.registra(true), true);
});

// ─── La política de reintento ────────────────────────────────────────────────

test('solo DEGRADADO se reintenta: la fila dura es hallazgo, no ruido', () => {
    assert.strictEqual(debeReintentar('DEGRADADO'), true);
    for (const duro of ['BUG', 'SILENCIO', 'BUCLE', 'ERROR', 'OK']) {
        assert.strictEqual(debeReintentar(duro), false,
            `${duro} no se reintenta: un fallo duro intermitente sigue siendo un fallo duro`);
    }
});

// ─── La selección ────────────────────────────────────────────────────────────

test('número, rango, familia, idioma y shard, combinados', () => {
    const sel = parseSeleccion(['5-7', '12', 'familia:C', 'idioma:es']);
    assert.deepStrictEqual([...sel.numeros].sort((a, b) => a - b), [5, 6, 7, 12]);
    assert.ok(sel.familias.has('C') && sel.idiomas.has('es'));

    const meta = { n: 6, familia: 'C', idioma: 'es' };
    assert.ok(matchesSeleccion(sel, meta));
    assert.ok(!matchesSeleccion(sel, { ...meta, n: 8 }), 'fuera del rango');
    assert.ok(!matchesSeleccion(sel, { ...meta, familia: 'A' }), 'otra familia');
    assert.ok(!matchesSeleccion(sel, { ...meta, idioma: 'ru' }), 'otro idioma');
});

test('shard:i/n reparte por número de escenario, sin huecos ni solapes', () => {
    const n = 6;
    const shards = Array.from({ length: n }, (_, k) => parseSeleccion([`shard:${k + 1}/${n}`]));
    for (let esc = 1; esc <= 100; esc++) {
        const en = shards.filter(s => matchesSeleccion(s, { n: esc })).length;
        assert.strictEqual(en, 1, `el escenario ${esc} debe caer en EXACTAMENTE un shard`);
    }
});

test('un token no reconocido devuelve null: un typo no puede correr «todo» en silencio', () => {
    assert.strictEqual(parseSeleccion(['famiglia:C']), null);
    assert.strictEqual(parseSeleccion(['shard:0/6']), null, 'los shards son 1-indexados');
    assert.strictEqual(parseSeleccion(['shard:7/6']), null);
    assert.strictEqual(parseSeleccion(['9-3']), null, 'rango invertido');
    const todo = parseSeleccion([]);
    assert.ok(todo && matchesSeleccion(todo, { n: 42, familia: null, idioma: null }), 'sin args, corre todo');
});

// ─── El resumen agrupado ─────────────────────────────────────────────────────

test('agrupa por familia e idioma y ordena el rojo primero', () => {
    const results = [
        { estado: 'OK', familia: 'A', idioma: 'es' },
        { estado: 'DEGRADADO', familia: 'D', idioma: 'ru' },
        { estado: 'OK', familia: 'D', idioma: 'ru' },
        { estado: 'BUG', familia: 'D', idioma: 'uk' },
        { estado: 'OK', familia: null, idioma: 'es' },
    ];
    const { porFamilia, porIdioma } = resumenAgrupado(results);
    assert.ok(porFamilia[0].includes('D'), 'la familia con más hallazgos va primero');
    assert.ok(porFamilia[0].includes('2 con hallazgo'));
    assert.ok(porFamilia.some(l => l.includes('A') && l.includes('todo OK')));
    assert.ok(porIdioma.some(l => l.trim().startsWith('ru')));
    assert.ok(porFamilia.some(l => l.trim().startsWith('—')), 'lo sin etiqueta se ve, no se pierde');
});
