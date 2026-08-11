/**
 * tests/largo-del-pelo.test.js — El largo del pelo, tramo por tramo y idioma por idioma.
 *
 * El largo FIJA EL PRECIO (Anti-encrespamiento: 120 / 160 / 180 €) y se le comunica a la
 * clienta como cifra buena, así que el tramo equivocado no es una molestia: es un precio
 * inventado que luego no se cumple. Por eso aquí no se prueba «que devuelva algo», se prueba
 * QUÉ tramo devuelve cada forma de decirlo.
 *
 * Tres bloques, y el primero es el que importa:
 *
 *  1. **Los modificadores.** «por debajo de los hombros» decía CORTO (120 €) hasta el
 *     11/08/2026: casaba «hombros» e ignoraba el «por debajo». Cobraba de menos, con
 *     seguridad y sin que nadie lo viera. Del mismo tipo eran «media espalda» y «hasta la
 *     mitad de la espalda», que decían MEDIO cuando media espalda es LARGO. Estas tres son
 *     las únicas que RESPONDÍAN MAL; las demás simplemente no se entendían, que es un fallo
 *     mucho más barato porque el bot vuelve a preguntar.
 *
 *  2. **El mapeo completo**, en los cuatro idiomas. Lo fijó la dueña el 11/08/2026 — dónde
 *     cae cada punto del cuerpo es criterio de salón, no de programación.
 *
 *  3. **Las regresiones** de lo que ya funcionaba, incluido el guard de «Largo 2» (nombre de
 *     variante del catálogo, no medida) y el cirílico, que casa por buildCyrillicRe porque
 *     normalizeText descompone (й, ї) y \b es ASCII.
 *
 * Al añadir una frase con modificador hay que verla FALLAR sin el arreglo: un test que pasa
 * con y sin él no protege nada. La tabla del bloque 1 se verificó así una por una.
 */
const assert = require('assert');
const { extractLargoPelo } = require('../services/helpers');

let fallos = 0;
function test(nombre, fn) {
    try { fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`fail - ${nombre}\n   ${e.message}`); }
}

// Comprueba una lista de frases contra el tramo que les toca, y dice CUÁLES fallan (no solo
// que algo falló): con 98 frases, un mensaje de "esperaba 2, recibí 1" no sirve de nada.
function tramo(esperado, frases) {
    const mal = frases
        .map(t => [t, extractLargoPelo(t)])
        .filter(([, got]) => got !== esperado)
        .map(([t, got]) => `      «${t}» → ${got === null ? 'no lo entiende' : got}`);
    assert.ok(mal.length === 0,
        `${mal.length} de ${frases.length} no dan ${esperado}:\n${mal.join('\n')}`);
}

// ═══ 1. Los modificadores: lo que respondía MAL ═══════════════════════════════════════
//
// Cada una de estas tres devolvía un tramo ACTIVO y equivocado. Son las que hay que ver
// caer al quitar el arreglo.

test('«por debajo de los hombros» es MEDIO, no corto (eran 40 € de menos)', () => {
    assert.strictEqual(extractLargoPelo('por debajo de los hombros'), 2);
    assert.strictEqual(extractLargoPelo('lo tengo por debajo de los hombros'), 2);
    assert.strictEqual(extractLargoPelo('bajo los hombros'), 2);
});

test('«media espalda» es LARGO, no medio', () => {
    assert.strictEqual(extractLargoPelo('media espalda'), 3);
    assert.strictEqual(extractLargoPelo('por media espalda'), 3);
    assert.strictEqual(extractLargoPelo('hasta la mitad de la espalda'), 3);
});

test('el modificador NO cambia lo que ya era correcto', () => {
    // La otra mitad del invariante: «por encima de» y «hasta» dejan el punto donde está, y
    // el punto suelto sigue cubriendo sus formas neutras sin entrada propia.
    assert.strictEqual(extractLargoPelo('por encima de los hombros'), 1);
    assert.strictEqual(extractLargoPelo('a la altura de los hombros'), 1);
    assert.strictEqual(extractLargoPelo('hasta los hombros'), 1);
    assert.strictEqual(extractLargoPelo('por encima del pecho'), 2);
    assert.strictEqual(extractLargoPelo('a la altura del pecho'), 2);
    assert.strictEqual(extractLargoPelo('por debajo del pecho'), 3);
    assert.strictEqual(extractLargoPelo('hasta la cintura'), 3);
    assert.strictEqual(extractLargoPelo('por debajo de la cintura'), 4);
});

test('«por debajo de» en cirílico tampoco se lo come', () => {
    assert.strictEqual(extractLargoPelo('ниже плеч'), 2);      // ru · por debajo de los hombros
    assert.strictEqual(extractLargoPelo('нижче плечей'), 2);   // uk · íd.
    assert.strictEqual(extractLargoPelo('ниже груди'), 3);     // ru · por debajo del pecho
    assert.strictEqual(extractLargoPelo('ниже талии'), 4);     // ru · por debajo de la cintura
    assert.strictEqual(extractLargoPelo('нижче талії'), 4);    // uk · íd.
    // Y el contrario, para que el «ниже» no se aplique de más:
    assert.strictEqual(extractLargoPelo('выше плеч'), 1);      // ru · por encima de los hombros
    assert.strictEqual(extractLargoPelo('выше груди'), 2);     // ru · por encima del pecho
});

test('«ниже плеч» no se confunde con «до плеч» (son tramos distintos)', () => {
    assert.strictEqual(extractLargoPelo('до плеч'), 1);
    assert.strictEqual(extractLargoPelo('ниже плеч'), 2);
});

// ═══ 2. El mapeo completo, tramo × idioma ════════════════════════════════════════════

test('CORTO · español', () => tramo(1, [
    'por encima de las orejas', 'muy corto', 'hasta la barbilla', 'por el mentón',
    'por la mandíbula', 'tipo bob', 'un bob', 'melena corta', 'lo tengo corta', 'corto',
    'por encima de los hombros', 'a la altura de los hombros',
]));

test('CORTO · inglés', () => tramo(1, [
    'above the ears', 'chin length', 'jaw length', 'shoulder-length', 'shoulder length',
    'a bob', 'short', 'my hair is short',
]));

test('CORTO · ruso', () => tramo(1, [
    'до плеч', 'выше плеч', 'до подбородка', 'коротко', 'короткие', 'каре',
]));

test('CORTO · ucraniano', () => tramo(1, [
    'до плечей', 'вище плечей', 'до підборіддя', 'коротке',
]));

test('MEDIO · español', () => tramo(2, [
    'por debajo de los hombros', 'hasta las clavículas', 'por la clavícula',
    'por encima del pecho', 'a la altura del pecho', 'hasta el pecho',
    'por los omóplatos', 'por las paletillas', 'hasta las axilas',
    'media melena', 'normal', 'media', 'hasta la espalda',
]));

test('MEDIO · inglés', () => tramo(2, [
    'below the shoulders', 'under the shoulders', 'collarbone length', 'collar bone',
    'chest length', 'shoulder blades', 'armpit length', 'medium', 'medium length',
]));

test('MEDIO · ruso', () => tramo(2, [
    'ниже плеч', 'до ключиц', 'до груди', 'выше груди', 'до лопаток', 'средней длины',
]));

test('MEDIO · ucraniano', () => tramo(2, [
    'нижче плечей', 'до ключиці', 'до ключиць', 'до грудей', 'до лопаток', 'середня довжина',
]));

test('LARGO · español', () => tramo(3, [
    'por debajo del pecho', 'media espalda', 'hasta la mitad de la espalda',
    'por debajo de los omóplatos', 'por la cintura', 'hasta la cintura',
    'por encima de la cintura', 'por los codos', 'lo tengo larga', 'largo',
]));

test('LARGO · inglés', () => tramo(3, [
    'below the chest', 'mid-back', 'mid back', 'middle of my back',
    'down to my waist', 'waist length', 'elbow length', 'long',
]));

test('LARGO · ruso', () => tramo(3, [
    'до талии', 'до пояса', 'ниже груди', 'ниже лопаток', 'до середины спины',
    'до локтей', 'длинные',
]));

test('LARGO · ucraniano', () => tramo(3, [
    'до талії', 'нижче грудей', 'нижче лопаток', 'до середини спини', 'до ліктів', 'довге',
]));

test('MUY LARGO · español', () => tramo(4, [
    'por debajo de la cintura', 'bajo la cintura', 'hasta la cadera', 'por las caderas',
    'muy largo', 'muy larga', 'más de cintura',
]));

test('MUY LARGO · inglés', () => tramo(4, [
    'below the waist', 'past the waist', 'hip length', 'very long',
]));

test('MUY LARGO · ruso', () => tramo(4, [
    'ниже талии', 'ниже пояса', 'до бедер', 'очень длинные',
]));

test('MUY LARGO · ucraniano', () => tramo(4, [
    'нижче талії', 'нижче пояса', 'до стегон', 'дуже довге',
]));

// ═══ 3. Regresiones y falsos positivos ═══════════════════════════════════════════════

test('REGRESIÓN · «Largo 2» es el nombre de una variante, no una medida', () => {
    assert.strictEqual(extractLargoPelo('largo 2'), null);
    assert.strictEqual(extractLargoPelo('Largo 3'), null);
});

test('REGRESIÓN · lo que no es una medida sigue sin serlo', () => {
    // null NO es un fallo: el caller vuelve a preguntar o acepta el "no sé". Lo caro es
    // devolver un tramo, y por eso estas tienen que seguir en null.
    for (const t of ['no lo sé', 'ni idea', 'no estoy segura', '', 'hola', 'mañana por la tarde']) {
        assert.strictEqual(extractLargoPelo(t), null, `«${t}» devolvió un tramo`);
    }
});

test('REGRESIÓN · «corte» no es «corto»', () => {
    // cort[oa]s? no puede casar dentro de «corte»: quien pide un corte no está diciendo su
    // largo, y esto es lo que se rompería al ampliar corto→corta.
    assert.strictEqual(extractLargoPelo('quiero un corte'), null);
    assert.strictEqual(extractLargoPelo('un corte de pelo'), null);
});

test('REGRESIÓN · las que ya se entendían antes del 11/08/2026', () => {
    const previas = {
        corto: 1, largo: 3, 'muy largo': 4, media: 2, normal: 2,
        'средней длины': 2, 'до лопаток': 2, 'до пояса': 3,
        'до плечей': 1, 'до плеч': 1, коротко: 1, 'очень длинные': 4,
    };
    for (const [t, esperado] of Object.entries(previas)) {
        assert.strictEqual(extractLargoPelo(t), esperado, `«${t}» cambió de tramo`);
    }
});

console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
