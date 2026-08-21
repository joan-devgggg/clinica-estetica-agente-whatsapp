/**
 * tests/nombre-no-es-otra-respuesta.test.js — un nombre no es la respuesta a otra pregunta.
 *
 * En producción hay una clienta que se llama «Короткие Вероника». No es un nombre: son sus
 * dos respuestas seguidas —«¿qué largo tienes?» → «Короткие» (cortos), «¿con quién?» →
 * «Вероника»— guardadas como nombre y apellido. Su cita del 07/09 lleva ese nombre dentro,
 * así que el recordatorio de 24 h iba a saludarla así.
 *
 * Y no era una sola. Contadas sobre las 763 fichas CON NOMBRE de Sante (21/08/2026), NUEVE
 * llevan de apellido la respuesta a otra pregunta:
 *
 *     Ihab Lavar · Gabriela Completo · Karolina Secado · Karina Tratamiento
 *     Mamen Peinado · Aurora Blond · Alicia Medio · Pelin Long · Короткие Вероника
 *
 * LA CAUSA, y es la que hay que releer antes de tocar nada: las guardas YA ESTABAN ESCRITAS.
 * La rama del apellido de `extractQuickDataSante` comprueba desde hace meses que la palabra
 * no sea un servicio ni una estilista… contra `servicesCatalog` y `teamList`, que son
 * PARÁMETROS, y el único call site de producción los pasaba **vacíos**. Con `[]`,
 * `isServiceName` sale por su primera línea y `resolveStylistMention` devuelve NONE. Dos
 * guardas con su comentario, su historia y su intención, que no se ejecutaron nunca.
 *
 * Las TRES decisiones que hay dentro del arreglo, todas medidas sobre esas 763 fichas:
 *
 *   1. EL LARGO SE MIRA TOKEN A TOKEN. El daño llega por el apellido («Pelin Long» es un
 *      nombre bueno con la respuesta pegada detrás). Casan tres fichas y las tres son las
 *      averiadas; «Cortés», «Cortez», «Longoria», «Medina» y «Mediano» dan null.
 *   2. EL EQUIPO SOLO SE MIRA EN EL APELLIDO. 51 de las 763 tienen de NOMBRE DE PILA el de
 *      una estilista (Yulia, Natalia, Olga, Irina, Veronika, Larisa, Tetiana): una guarda en
 *      el nombre de pila le negaría su propio nombre a una de cada quince clientas.
 *   3. EN EL APELLIDO SE EXIGE ACIERTO, NO PARECIDO. Con la resolución completa se
 *      rechazaban NUEVE apellidos y solo uno era el averiado: «Natalla», «Olya», «Luisa»,
 *      «Ilina» y «María Martín» caen a distancia 1-2 de Natalia / Olga / Larisa / Irina.
 *      Exigiendo acierto se rechaza UNO. La excepción es el cirílico, donde sí vale la
 *      resolución entera porque la distancia la mete la propia tabla de transliteración.
 *
 * El cirílico es la cuarta pieza: `stylists.name` está en latín y media clientela escribe en
 * cirílico, así que `resolveStylistMention('Вероника', equipo)` devolvía null para las OCHO
 * del equipo. Ni la guarda del apellido habría cazado el caso real sin transliterar.
 *
 * NO se toca ni se adivina el nombre REAL de nadie: esto solo decide lo que se guarda de
 * aquí en adelante. Las ocho fichas averiadas las arregla una persona.
 *
 * Sabotajes MEDIDOS (cp previo, 21/08/2026):
 *   · devolver `[], []` al call site de bot.js (el estado exacto de antes) ...... 1 rojo
 *   · quitar `esRespuestaDeLargo` de las dos ramas .............................. 2 rojos
 *   · aflojar el apellido a la resolución completa (fuzzy latino) ............... 2 rojos
 *   · quitar la transliteración ................................................. 2 rojos
 *
 * Que el primero tumbe UN bloque, y encima el que lee el fichero, no es que proteja poco:
 * es la forma del fallo. Ningún test de conducta puede notar unas listas vacías, porque
 * todos ellos se las pasan. Por eso ese bloque está escrito así y por eso existe.
 */
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { test } = require('node:test');
const {
    extractQuickDataSante, esRespuestaDeLargo, mencionaEstilistaDelEquipo,
    translitCirilico, resolveStylistMention,
} = require('../services/helpers');

// El equipo REAL de Sante, que es un dato de la dueña: aquí es ENTRADA de una función pura,
// no una lista contra la que se verifique nada (regla 5). Lo que afirma este fichero se
// sostiene con cualquier plantilla.
const EQUIPO = ['Veronika', 'Irina', 'Yulia', 'Olga', 'Larisa', 'Tetiana', 'Natalia', 'Yulia-Tricóloga']
    .map((name, i) => ({ id: `sty-${i}`, name }));

// Catálogo mínimo con las categorías y nombres de los que salieron los ocho apellidos.
const CATALOGO = [
    { nombre: 'Corto', categoria: 'Alisado vegano' },
    { nombre: 'Medio', categoria: 'Alisado vegano' },
    { nombre: 'Largo', categoria: 'Alisado vegano' },
    { nombre: 'Mujer y secado', categoria: 'Cortes' },
    { nombre: 'Color completo largo 1', categoria: 'Color Premium' },
    { nombre: 'Peinado ondas', categoria: 'Lavar y peinar' },
    { nombre: 'Orising express', categoria: 'Tratamiento Orgánico' },
    { nombre: 'Corto', categoria: 'Deco Total Blond' },
];

const capturarNombre = (texto, partial = {}) =>
    extractQuickDataSante(texto, partial, CATALOGO, EQUIPO).nombre;

// ─── 1 · El caso real, turno a turno ─────────────────────────────────────────

test('REGRESIÓN · «Короткие» contestando al largo NO se guarda como nombre de pila', () => {
    assert.strictEqual(capturarNombre('Короткие'), undefined,
        'era el primer token de «Короткие Вероника»');
});

test('REGRESIÓN · «Вероника» contestando a la estilista NO se pega como apellido', () => {
    const nombre = capturarNombre('Вероника', { nombre: 'Короткие' });
    assert.strictEqual(nombre, 'Короткие',
        'el apellido no puede ser el nombre de una del equipo, tampoco escrito en cirílico');
});

test('REGRESIÓN · los otros siete apellidos averiados de producción', () => {
    const casos = [
        ['Ihab', 'Lavar'], ['Gabriela', 'Completo'], ['Karolina', 'Secado'],
        ['Karina', 'Tratamiento'], ['Mamen', 'Peinado'], ['Aurora', 'Blond'],
        ['Alicia', 'Medio'],
    ];
    for (const [pila, respuesta] of casos) {
        assert.strictEqual(capturarNombre(respuesta, { nombre: pila }), pila,
            `«${pila} ${respuesta}» — «${respuesta}» es la respuesta a otra pregunta, no su apellido`);
    }
});

test('y el largo dicho en las cuatro formas tampoco entra por el nombre de pila', () => {
    for (const t of ['Короткие', 'Средние', 'Длинные', 'Long', 'Short', 'Medium', 'Medio']) {
        assert.strictEqual(capturarNombre(t), undefined, `«${t}» es un largo, no un nombre`);
    }
});

// ─── 2 · Lo que NO se puede perder ───────────────────────────────────────────

test('CONTROL · un nombre de pila que coincide con una del equipo SIGUE entrando', () => {
    // 51 de las 763 fichas de Sante son así. Una guarda de equipo en el nombre de pila le
    // negaría su nombre a una de cada quince clientas.
    for (const t of ['Yulia', 'Natalia', 'Olga', 'Irina', 'Veronika', 'Larisa', 'Наталья']) {
        assert.strictEqual(capturarNombre(t), t, `«${t}» es el nombre de una clienta real de Sante`);
    }
});

test('CONTROL · apellidos reales que se PARECEN a una del equipo o a un largo', () => {
    const casos = [
        ['Tammy', 'Natalla'], ['Alena', 'Olya'], ['Ana', 'Luisa'], ['Daria', 'Ilina'],
        ['Olga', 'Chernenko'], ['Ana', 'Medina'], ['Eva', 'Longoria'], ['Nina', 'Mediano'],
    ];
    // «Cortés» queda fuera de esta lista y no por esto: lo descarta `filterServiceKeyword`,
    // que es anterior y mira los KEYWORDS de servicio («cortes»). Conducta de antes, sin
    // relación con las guardas de este fichero.
    for (const [pila, apellido] of casos) {
        assert.strictEqual(capturarNombre(apellido, { nombre: pila }), `${pila} ${apellido}`,
            `«${pila} ${apellido}» es una ficha real: el apellido tiene que completarse`);
    }
});

test('CONTROL · el nombre dicho entero en un mensaje sigue capturándose', () => {
    assert.strictEqual(capturarNombre('Меня зовут Наталья'), 'Наталья');
    assert.strictEqual(capturarNombre('me llamo Veronika'), 'Veronika');
});

// ─── 3 · Las piezas, a pelo ──────────────────────────────────────────────────

test('esRespuestaDeLargo mira TOKEN A TOKEN', () => {
    assert.ok(esRespuestaDeLargo('Pelin Long'), 'el daño llega pegado detrás de un nombre bueno');
    assert.ok(esRespuestaDeLargo('Alicia Medio'));
    assert.ok(!esRespuestaDeLargo('Ihab Lavar'), 'ése es un servicio, no un largo: lo para la otra guarda');
    for (const t of ['Cortés', 'Cortez', 'Longoria', 'Medina', 'Mediano', 'Castaño', 'Delgado']) {
        assert.ok(!esRespuestaDeLargo(t), `«${t}» es un apellido real`);
    }
});

test('translitCirilico: las OCHO del equipo escritas en cirílico se reconocen', () => {
    for (const t of ['Вероника', 'Ирина', 'Юлия', 'Ольга', 'Лариса', 'Тетяна', 'Наталья', 'Наталія']) {
        assert.ok(mencionaEstilistaDelEquipo(t, EQUIPO), `«${t}» es del equipo y no se veía`);
        // Y la prueba de que hacía falta transliterar: sin ello, ninguna resuelve.
        assert.strictEqual(resolveStylistMention(t, EQUIPO, { assumePersonName: true }).stylist, null,
            `«${t}» resuelve sin transliterar: este bloque ya no mide lo que dice medir`);
    }
});

test('translitCirilico devuelve null cuando NO hay cirílico', () => {
    // Así quien llama sabe que no hay una segunda forma que probar, en vez de probar dos
    // veces la misma cadena.
    assert.strictEqual(translitCirilico('Veronika'), null);
    assert.strictEqual(translitCirilico(''), null);
    assert.strictEqual(translitCirilico(null), null);
    assert.strictEqual(translitCirilico('Ольга'), 'olga');
});

test('en el apellido se exige ACIERTO, no parecido (latino)', () => {
    for (const t of ['Natalla', 'Olya', 'Luisa', 'Ilina', 'Vero', 'Nataly']) {
        assert.ok(!mencionaEstilistaDelEquipo(t, EQUIPO),
            `«${t}» es un apellido real a distancia de edición de una del equipo`);
    }
    for (const t of ['Veronika', 'Natalia', 'Olga', 'irina']) {
        assert.ok(mencionaEstilistaDelEquipo(t, EQUIPO), `«${t}» es un acierto`);
    }
});

test('sin equipo o sin texto, la guarda no inventa nada', () => {
    assert.ok(!mencionaEstilistaDelEquipo('Вероника', []));
    assert.ok(!mencionaEstilistaDelEquipo('', EQUIPO));
});

// ─── 4 · El call site: las guardas no pueden volver a morir ──────────────────

test('bot.js pasa el catálogo y el equipo DE VERDAD a extractQuickDataSante', () => {
    // Este bloque lee el fichero a propósito. El fallo no fue una regla mal escrita: fue un
    // `[], []` en la llamada que dejó dos guardas sin ejecutarse durante meses sin que
    // ningún test de conducta pudiera notarlo — porque todos los tests de la función le
    // pasan las listas ellos mismos.
    const src = require('fs').readFileSync(require.resolve('../bot.js'), 'utf8');
    const llamada = src.slice(src.indexOf('extractQuickDataSante(sanitized'));
    const args = llamada.slice(0, llamada.indexOf('{'));
    assert.ok(!/\[\]\s*,\s*\[\]/.test(args),
        'el call site de producción volvió a pasar listas vacías: las dos guardas del apellido están muertas otra vez');
    assert.ok(/cfgQuick|services/.test(args) && /roster|Stylists/.test(args),
        'el catálogo y el equipo tienen que llegar a la llamada');
});
