// La XL no es el final de la escala de largo, y la máquina lo ignoraba (21/08/2026).
//
// LO QUE PASABA. `classifyLargoVariant` ordena las variantes de una categoría y `bot.js`
// elegía POR POSICIÓN: nivel 4 → cuarta variante. En las tres categorías que tienen cuarta
// —Deco Total Blond, Mechas Airtouch y Mechas Balayage— la cuarta es la XL, y Yulia confirmó
// que la XL es para CAMBIOS DE COLOR IMPORTANTES (de moreno a rubio), no por la longitud. En
// Balayage la entrada lo dice en su propio nombre: «XL / cambio importante».
//
// Así que decir «tengo el pelo por debajo de la cintura» compraba una variante que es para
// otra cosa: +10 € en Deco (165→175), +25 € en Airtouch (235→260) y +30 € en Balayage
// (200→230), dichos como precio bueno y deshechos a mano en el salón. Es el mismo daño que
// «difuminado de raíz» cayendo en «Color raíz».
//
// Y LO PEOR: el criterio EXISTÍA, pero solo lo conocía el prompt (`nivel4EsCambioColor`). O
// sea que el bot le explicaba a la clienta que la XL no era por longitud y dos pasos después
// le metía el «por debajo de la cintura» justo en esa variante. El arreglo no es una regla
// nueva: es que la regla la lean los dos, desde `helpers`.
//
// MEDIDO EN PRODUCCIÓN antes de tocar nada (21/08/2026, ventana disponible): 98 citas y
// CERO con una XL; 524 entrantes y 28 largos declarados —10 de nivel 1, 12 de nivel 2, 6 de
// nivel 3 y NINGUNO de nivel 4—. O sea: podía costar dinero y todavía no lo había costado.
//
// Puro: cero red, cero Supabase, cero LLM. Fixture fijo del repo (lo DETERMINISTA va aquí;
// lo que afirma algo del catálogo REAL va a verify:sante).
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    classifyLargoVariant, esVarianteFueraDeEscalaDeLargo, ultimoIndiceDeLargo,
    variantesDeLargoOrdenadas, elegirVariantePorLargo, extractLargoPelo, normalizeText,
} = require('../services/helpers');

const CATALOGO = require('./fixtures/sante-catalog.json').services;

let fallos = 0;
function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e.message); fallos++; process.exitCode = 1; }
}

// Las categorías del fixture que tienen cuarta variante, y las que no. Se calculan, no se
// escriben: la dueña edita el catálogo y una lista aquí caducaría (regla 5).
const CON_CUARTA = [];
const SIN_CUARTA = [];
for (const cat of [...new Set(CATALOGO.map(s => s.categoria))]) {
    const v = variantesDeLargoOrdenadas(cat, CATALOGO);
    if (v.length < 2) continue;
    (v.some(s => classifyLargoVariant(s.nombre) === 4) ? CON_CUARTA : SIN_CUARTA).push(cat);
}

// ── Bloque 0 · el fixture reproduce la condición del fallo ───────────────────────────────
//
// Sin esto, todo lo de abajo pasaría con y sin el arreglo el día que el fixture pierda sus
// XL, y nadie se enteraría. Es la lección de `complemento-no-cae-en-el-vecino`.

test('0 · el fixture TIENE categorías con una cuarta variante, y esa cuarta es una XL', () => {
    assert.ok(CON_CUARTA.length >= 3, `el fixture solo tiene ${CON_CUARTA.length} categorías con cuarta variante`);
    for (const cat of CON_CUARTA) {
        const cuarta = variantesDeLargoOrdenadas(cat, CATALOGO).find(s => classifyLargoVariant(s.nombre) === 4);
        assert.ok(esVarianteFueraDeEscalaDeLargo(cuarta.nombre),
            `${cat}: la cuarta es "${cuarta.nombre}" y NO está fuera de la escala — el fixture ya no reproduce el caso`);
    }
    assert.ok(SIN_CUARTA.length >= 3, 'y también categorías de tres, que son el control');
});

// ── El arreglo ───────────────────────────────────────────────────────────────────────────

test('un largo 4 NO compra la XL: para en «Largo», que es el techo de la escala', () => {
    for (const cat of CON_CUARTA) {
        const elegida = elegirVariantePorLargo(variantesDeLargoOrdenadas(cat, CATALOGO), 4);
        assert.strictEqual(classifyLargoVariant(elegida.nombre), 3,
            `${cat}: el nivel 4 se llevó "${elegida.nombre}" en vez de la variante de largo 3`);
        assert.ok(!esVarianteFueraDeEscalaDeLargo(elegida.nombre),
            `${cat}: "${elegida.nombre}" no es una variante de largo`);
    }
});

test('y por eso no se le cobra de más — la XL vale entre 10 y 30 € más que «Largo»', () => {
    for (const cat of CON_CUARTA) {
        const v = variantesDeLargoOrdenadas(cat, CATALOGO);
        const xl = v.find(s => classifyLargoVariant(s.nombre) === 4);
        const elegida = elegirVariantePorLargo(v, 4);
        assert.ok(elegida.precio < xl.precio,
            `${cat}: «${elegida.nombre}» (${elegida.precio} €) debería costar menos que «${xl.nombre}» (${xl.precio} €)`);
    }
});

test('en las categorías de TRES variantes nada cambia: el 4 sigue parando en «Largo»', () => {
    for (const cat of SIN_CUARTA) {
        const v = variantesDeLargoOrdenadas(cat, CATALOGO);
        const elegida = elegirVariantePorLargo(v, 4);
        assert.strictEqual(elegida.nombre, v[v.length - 1].nombre,
            `${cat}: ahí «Largo» ES la última, y el 4 tiene que caer en ella`);
    }
});

test('CONTROL · los niveles 1, 2 y 3 no se han movido en ninguna categoría', () => {
    for (const cat of [...CON_CUARTA, ...SIN_CUARTA]) {
        const v = variantesDeLargoOrdenadas(cat, CATALOGO);
        for (const nivel of [1, 2, 3]) {
            const elegida = elegirVariantePorLargo(v, nivel);
            assert.strictEqual(classifyLargoVariant(elegida.nombre), nivel,
                `${cat}: el nivel ${nivel} se llevó "${elegida.nombre}"`);
        }
    }
});

// ── Lo que NO se ha roto al arreglarlo ───────────────────────────────────────────────────

test('la XL NO queda huérfana: sigue siendo la variante de nivel 4 del catálogo', () => {
    // Lo que cambia es cómo se LLEGA a ella (por su nombre, o porque el modelo la proponga
    // cuando la clienta describe un cambio de color grande), no que exista o resuelva. Su
    // clasificación tiene que seguir siendo 4 o se rompen el prompt y la facturación.
    for (const cat of CON_CUARTA) {
        const xl = variantesDeLargoOrdenadas(cat, CATALOGO).find(s => classifyLargoVariant(s.nombre) === 4);
        assert.ok(xl, `${cat}: la XL ha desaparecido del catálogo`);
        assert.strictEqual(classifyLargoVariant(xl.nombre), 4);
    }
});

test('si la dueña la renombra a «Muy largo», el nivel 4 vuelve a caer en ella', () => {
    // No es un capricho del test: es la consecuencia buscada de mirar el NOMBRE y no una
    // lista de categorías en git (regla 5). Un nombre que dice longitud ES longitud.
    const renombrado = CATALOGO.map(s => (
        s.categoria === 'Mechas Airtouch' && s.nombre === 'XL' ? { ...s, nombre: 'Muy largo' } : s));
    const v = variantesDeLargoOrdenadas('Mechas Airtouch', renombrado);
    const elegida = elegirVariantePorLargo(v, 4);
    assert.strictEqual(elegida.nombre, 'Muy largo');
    assert.strictEqual(esVarianteFueraDeEscalaDeLargo('Muy largo'), false);
});

test('«Mechas clásicas» no entra aquí: sus variantes son COBERTURA y tienen su propio camino', () => {
    // Se comprueba que ninguna de sus tres está fuera de escala, o sea que este techo no
    // les cambia nada. Quien las resuelve es extractMechasClasicasTipo, no el largo.
    for (const s of variantesDeLargoOrdenadas('Mechas clásicas', CATALOGO)) {
        assert.strictEqual(esVarianteFueraDeEscalaDeLargo(s.nombre), false, s.nombre);
    }
});

// ── La frase real de una clienta, de punta a punta ───────────────────────────────────────

test('las frases de nivel 4 de los cuatro idiomas acaban todas en «Largo»', () => {
    const frases = [
        'lo tengo por debajo de la cintura',
        'my hair is below the waist',
        'у меня волосы ниже талии',
        'у мене волосся нижче талії',
    ];
    for (const frase of frases) {
        assert.strictEqual(extractLargoPelo(frase), 4, `"${frase}" ya no da nivel 4`);
        for (const cat of CON_CUARTA) {
            const elegida = elegirVariantePorLargo(variantesDeLargoOrdenadas(cat, CATALOGO), extractLargoPelo(frase));
            assert.ok(!esVarianteFueraDeEscalaDeLargo(elegida.nombre),
                `${cat} · "${frase}" → "${elegida.nombre}"`);
        }
    }
});

test('corregirse a un largo 4 tampoco lleva a la XL', () => {
    // El segundo camino de bot.js: ya hay servicio elegido y la clienta rectifica el largo.
    // Llevaba la misma fórmula copiada, así que llevaba el mismo fallo.
    for (const cat of CON_CUARTA) {
        const v = variantesDeLargoOrdenadas(cat, CATALOGO);
        const elegida = elegirVariantePorLargo(v, extractLargoPelo('perdona, lo tengo por debajo de la cintura'));
        assert.ok(!esVarianteFueraDeEscalaDeLargo(elegida.nombre), `${cat}: "${elegida.nombre}"`);
    }
});

// ── La paridad que es TODO el arreglo: prompt y máquina leen lo mismo ────────────────────

test('PARIDAD · lo que el prompt le dice a la clienta y lo que la máquina hace coinciden', () => {
    // El prompt anuncia la XL como «variante especial para cambios de color importantes, no
    // por la longitud» exactamente cuando `esVarianteFueraDeEscalaDeLargo` es true. Si la
    // máquina pudiera llevar un largo a esa entrada, el bot se contradiría dentro de la misma
    // conversación — que es lo que hacía. Se afirma sobre la MISMA función que usa el prompt.
    for (const cat of CON_CUARTA) {
        const v = variantesDeLargoOrdenadas(cat, CATALOGO);
        const cuarta = v.find(s => classifyLargoVariant(s.nombre) === 4);
        const promptLaDeclaraFueraDeLargo = esVarianteFueraDeEscalaDeLargo(cuarta.nombre);
        const maquinaPuedeLlegarPorLargo = [1, 2, 3, 4]
            .some(n => elegirVariantePorLargo(v, n).nombre === cuarta.nombre);
        assert.strictEqual(maquinaPuedeLlegarPorLargo, !promptLaDeclaraFueraDeLargo,
            `${cat}: el prompt dice "no es por longitud"=${promptLaDeclaraFueraDeLargo} `
            + `y la máquina puede llegar por largo=${maquinaPuedeLlegarPorLargo}`);
    }
});

// ── Bordes ───────────────────────────────────────────────────────────────────────────────

test('bordes: sin variantes, nivel raro, y una categoría entera fuera de escala', () => {
    assert.strictEqual(elegirVariantePorLargo([], 2), null);
    assert.strictEqual(elegirVariantePorLargo(null, 2), null);
    assert.strictEqual(ultimoIndiceDeLargo([]), -1);
    const v = variantesDeLargoOrdenadas('Mechas Airtouch', CATALOGO);
    assert.strictEqual(elegirVariantePorLargo(v, 0).nombre, v[0].nombre, 'un 0 se topa por abajo, no da null');
    assert.strictEqual(elegirVariantePorLargo(v, 99).nombre, v[ultimoIndiceDeLargo(v)].nombre);
    assert.strictEqual(elegirVariantePorLargo(v, null), null, 'sin nivel no se elige nada (regla 3)');
    // Si TODAS estuvieran fuera de escala se cae en la primera, que es la recuperable: la
    // más barata, y el bot puede corregirla preguntando.
    const todasFuera = [{ nombre: 'XL', precio: 1 }, { nombre: 'XL / cambio importante', precio: 2 }];
    assert.strictEqual(elegirVariantePorLargo(todasFuera, 4).nombre, 'XL');
});

test('la categoría se resuelve con su grafía normalizada, no solo exacta', () => {
    assert.ok(variantesDeLargoOrdenadas('mechas balayage', CATALOGO).length >= 3);
    assert.strictEqual(variantesDeLargoOrdenadas('', CATALOGO).length, 0);
    assert.strictEqual(variantesDeLargoOrdenadas('Mechas Airtouch', null).length, 0);
});

// ── Que bot.js siga ENCHUFADO a esa fórmula ─────────────────────────────────────────────
//
// Todo lo de arriba prueba `helpers`, que es donde vive la decisión. Lo que NO prueba es que
// `bot.js` la llame — y ese es justo el hueco por el que entró este fallo: la fórmula estaba
// copiada en tres sitios y el criterio del techo solo en un cuarto. Un arreglo en `helpers`
// con un `Math.min(nivel - 1, lista.length - 1)` superviviente en `bot.js` dejaría los trece
// bloques de arriba en verde y la clienta pagando 30 € de más.
//
// Es una red ESTRUCTURAL y se declara como tal: mide que no haya una segunda fórmula, no la
// conducta. La conducta de punta a punta la cubre el arnés LLM. No se puede hacer mejor sin
// extraer el turno entero de `bot.js`, que es otro trabajo.
const FUENTE_BOT = require('fs').readFileSync(require('path').join(__dirname, '..', 'bot.js'), 'utf8');

test('bot.js elige la variante de largo con la fórmula compartida, y no con una suya', () => {
    assert.ok(/require\('\.\/services\/helpers'\)/.test(FUENTE_BOT), 'bot.js ya no importa de helpers');
    assert.ok(/\belegirVariantePorLargo\b/.test(FUENTE_BOT), 'bot.js no importa elegirVariantePorLargo');
    // Los DOS caminos que eligen variante por largo: el turno del «¿cuánto largo tienes?» y
    // la corrección posterior. Los dos llevaban la fórmula copiada, y los dos el mismo fallo.
    const llamadas = (FUENTE_BOT.match(/elegirVariantePorLargo\(/g) || []).length;
    assert.strictEqual(llamadas, 2, `bot.js llama a elegirVariantePorLargo ${llamadas} veces, esperaba 2`);
});

test('y no queda ninguna elección por posición sobre variantes de largo', () => {
    // El patrón exacto que hacía el daño: topar contra el LARGO DE LA LISTA en vez de contra
    // la última variante que todavía es un largo.
    const sospechosas = FUENTE_BOT.split('\n')
        .map((l, i) => ({ n: i + 1, l }))
        .filter(({ l }) => /Math\.min\([^)]*-\s*1,\s*\w+\.length\s*-\s*1\)/.test(l))
        // `Mechas clásicas` elige por COBERTURA (extractMechasClasicasTipo), que es otra
        // escala y no tiene variante fuera de ella. Se exime por nombre y no por número de
        // línea: una exención posicional caduca en el primer retoque del fichero.
        .filter(({ n }) => !/tipo - 1/.test(FUENTE_BOT.split('\n')[n - 1]));
    assert.deepStrictEqual(sospechosas.map(x => `línea ${x.n}: ${x.l.trim()}`), [],
        'hay una elección por posición que puede alcanzar una variante fuera de la escala de largo');
});

if (!fallos) console.log(`\n✅ ${15} en verde`);
