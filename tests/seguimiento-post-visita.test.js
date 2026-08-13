// Seguimiento post-visita: la propuesta que sale días o semanas después de una cita.
//
// Lo que se prueba aquí es lo PURO: cómo se ata una regla al catálogo real, qué pasa cuando
// no se puede atar, y qué cifra acaba en el WhatsApp. Nada de BD ni de red — el worker y sus
// exclusiones van aparte.
//
// La lección que ordena el fichero es la de `business_info.upselling`: 9 etiquetas escritas
// como frases de marketing, de las que 7 no casan con ninguna entrada del catálogo. Un
// seguimiento nace con el mismo riesgo y con una consecuencia peor —el upsell se ofrece
// dentro de una conversación viva, esto sale solo a un teléfono— así que la atadura se
// verifica contra el fixture COMPLETO de 81 entradas, no contra un ejemplo cómodo.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    serviceCatalogKey,
    findCatalogEntryByKey,
    categoriasDeServicio,
    precioConDescuento,
    formatPrecioEur,
    resolveSeguimientoRegla,
    buildSeguimientoMensaje,
    validateConfigValue,
} = require('../services/helpers');

const CATALOGO = require('./fixtures/sante-catalog.json').services;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Las reglas que pidió la dueña, tal cual, ya con destino elegido. Sirven de base y cada
// bloque las estropea a su manera.
const REGLA_HIDRATACION = {
    key: 'hidratacion_post_color',
    origen: 'Mechas Balayage',
    destino: 'Tratamiento Orgánico|Orising hidratación intensa',
    dias: 18,
    descuentoPct: 10,
    activa: true,
};

// ─── 1. La identidad de un servicio es (categoría, nombre) ───────────────────

test('la clave de catálogo es "categoria|nombre" y es única en las 81 entradas', () => {
    const claves = CATALOGO.map(serviceCatalogKey);
    assert.strictEqual(claves.length, 81);
    assert.strictEqual(new Set(claves).size, 81, 'dos entradas comparten clave');
});

test('el NOMBRE a secas no identifica nada — "Corto" existe 4 veces con 4 precios', () => {
    const cortos = CATALOGO.filter(s => s.nombre === 'Corto');
    assert.ok(cortos.length >= 4, `esperaba >=4 "Corto", hay ${cortos.length}`);
    const precios = new Set(cortos.map(s => s.precio));
    assert.ok(precios.size >= 4, 'los "Corto" deberían tener precios distintos');
});

test('una clave resuelve a UNA entrada, y una clave inventada a ninguna', () => {
    const e = findCatalogEntryByKey('Tratamiento Orgánico|Orising hidratación intensa', CATALOGO);
    assert.strictEqual(e.precio, 85);
    assert.strictEqual(findCatalogEntryByKey('Tratamiento Orgánico|Hidratación', CATALOGO), null);
    assert.strictEqual(findCatalogEntryByKey('hidratación', CATALOGO), null);
    assert.strictEqual(findCatalogEntryByKey(null, CATALOGO), null);
});

// ─── 2. De una cita GUARDADA a su categoría ──────────────────────────────────
//
// Este es el bloque que mata la tentación de la frase suelta. `appointments.service` guarda
// lo que devuelve buildFullServiceName, y para media docena de categorías ESE NOMBRE NO
// CONTIENE LA CATEGORÍA.

test('REGRESIÓN · una cita de Balayage se guarda como "Cabello corto" — sin la palabra balayage', () => {
    // Si esto deja de ser cierto, el bloque siguiente deja de probar lo que cree probar.
    assert.strictEqual(/balayage/i.test('Cabello corto'), false);
    assert.deepStrictEqual(categoriasDeServicio('Cabello corto', CATALOGO), ['Mechas Balayage']);
});

test('las cuatro familias que la dueña llama "mechas" resuelven a su categoría', () => {
    const casos = [
        ['Cabello corto',           'Mechas Balayage'],     // ← sin la palabra "balayage"
        ['XL / cambio importante',  'Mechas Balayage'],     // ← ni ésta
        ['Mechas 1',                'Mechas clásicas'],     // ← sin la palabra "clásicas"
        ['Mechas 3',                'Mechas clásicas'],
        ['Mechas Contouring',       'Mechas Contouring'],
        ['Mechas Airtouch Corto',   'Mechas Airtouch'],
        ['Deco Total Blond Medio',  'Deco Total Blond'],
    ];
    for (const [guardado, categoria] of casos) {
        assert.deepStrictEqual(
            categoriasDeServicio(guardado, CATALOGO), [categoria],
            `"${guardado}" debería resolver a ${categoria}`,
        );
    }
});

test('una cita con VARIOS servicios devuelve las categorías de todos', () => {
    const cats = categoriasDeServicio('Mechas Airtouch Corto + Matiz', CATALOGO);
    assert.deepStrictEqual(cats.sort(), ['Matiz mujer', 'Mechas Airtouch'].sort());
});

test('"XL / cambio importante" NO se parte por la barra', () => {
    // splitServiceNames parte por " + ", nunca por "/". Si alguien lo cambiara, esta entrada
    // se trocearía en dos nombres que no existen y la cita dejaría de disparar nada.
    assert.deepStrictEqual(categoriasDeServicio('XL / cambio importante', CATALOGO), ['Mechas Balayage']);
});

test('un nombre AMBIGUO no elige categoría — es la trampa de "Largo 2"', () => {
    // Un "Corto" a secas casa con 4 entradas de 4 categorías distintas. Quedarse con la
    // primera es el bug que cobraba hasta 115 € de más; aquí no cobraría de más, dispararía
    // la regla de otra familia — y la clienta recibiría un WhatsApp que no le toca.
    const cats = categoriasDeServicio('Corto', CATALOGO);
    assert.deepStrictEqual(cats, [], `no debería resolver ninguna categoría, resolvió ${cats}`);
});

test('en una cita mixta, el segmento ambiguo se cae y el bueno se queda', () => {
    // Lo que NO puede pasar es que un segmento que no se sabe leer se lleve por delante a los
    // que sí: la cita seguiría disparando lo que le toca por su otro servicio.
    assert.deepStrictEqual(categoriasDeServicio('Corto + Matiz', CATALOGO), ['Matiz mujer']);
});

test('un servicio que no está en el catálogo no inventa categoría', () => {
    assert.deepStrictEqual(categoriasDeServicio('Cita manual', CATALOGO), []);
    assert.deepStrictEqual(categoriasDeServicio('', CATALOGO), []);
    assert.deepStrictEqual(categoriasDeServicio(null, CATALOGO), []);
});

// ─── 3. Una regla sin destino BLOQUEA, y explica qué falta ───────────────────

test('sin destino elegido la regla no puede enviar, y lo dice sin jerga', () => {
    const r = resolveSeguimientoRegla(
        { ...REGLA_HIDRATACION, destino: null, sugerencia: 'hidratación' },
        CATALOGO,
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.motivo, 'sin_destino');
    // El mensaje lo va a leer la dueña, no un programador.
    assert.ok(/falta elegir/i.test(r.mensaje), `mensaje poco claro: ${r.mensaje}`);
    assert.ok(!/null|undefined|key|catalog/i.test(r.mensaje), `mensaje con jerga: ${r.mensaje}`);
});

test('y ofrece las opciones REALES con su precio, para que pueda elegir', () => {
    const r = resolveSeguimientoRegla(
        { ...REGLA_HIDRATACION, destino: null, sugerencia: 'hidratación' },
        CATALOGO,
    );
    const nombres = r.opciones.map(o => o.nombre).sort();
    assert.deepStrictEqual(nombres, [
        'Fresh Hidratación',
        'Orising hidratación intensa',
        'Spa Hair Hidratación',
    ]);
    // Con su precio, que es justo lo que las distingue (45 / 85 / 110).
    for (const o of r.opciones) {
        assert.ok(Number.isFinite(o.precio), `${o.nombre} sin precio`);
        assert.ok(o.key.includes('|'), `${o.nombre} sin clave`);
    }
    assert.deepStrictEqual([...new Set(r.opciones.map(o => o.precio))].sort((a, b) => a - b), [45, 85, 110]);
});

test('el matiz tiene DOS opciones y tampoco se elige sola', () => {
    const r = resolveSeguimientoRegla(
        { key: 'matiz_mes', origen: 'Mechas Airtouch', destino: null, sugerencia: 'matiz', dias: 28, descuentoPct: 10, activa: true },
        CATALOGO,
    );
    assert.strictEqual(r.ok, false);
    const precios = r.opciones.map(o => o.precio).sort((a, b) => a - b);
    assert.deepStrictEqual(precios, [10, 40, 65]);   // Mascarilla violeta, Matiz, Matiz plus
});

test('con el destino elegido, la regla resuelve y trae el precio del catálogo', () => {
    const r = resolveSeguimientoRegla(REGLA_HIDRATACION, CATALOGO);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.destino.nombre, 'Orising hidratación intensa');
    assert.strictEqual(r.destino.precio, 85);
    assert.strictEqual(r.precioFinal, 76.5);
});

// ─── 4. Todo lo demás que puede estar mal, dicho en voz alta ─────────────────

test('un destino que ya no existe en el catálogo NO cae al parecido más cercano', () => {
    // El caso real: la migración 023 renombró variantes y dejó nombres huérfanos; el difuso
    // se llevó la entrada de al lado y facturó 310 € donde eran 210 €.
    const r = resolveSeguimientoRegla(
        { ...REGLA_HIDRATACION, destino: 'Tratamiento Orgánico|Orising hidratacion intensiva' },
        CATALOGO,
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.motivo, 'destino_no_existe');
    assert.ok(!r.destino, 'no debería haber resuelto ningún destino');
});

test('un destino dado de baja no se ofrece', () => {
    const conBaja = CATALOGO.map(s =>
        serviceCatalogKey(s) === 'Tratamiento Orgánico|Orising hidratación intensa'
            ? { ...s, activo: false } : s);
    const r = resolveSeguimientoRegla(REGLA_HIDRATACION, conBaja);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.motivo, 'destino_inactivo');
    assert.ok(/baja/i.test(r.mensaje), r.mensaje);
});

test('un destino sin precio no puede prometer un descuento', () => {
    // "Consulta" tiene precio null a propósito ("se confirma en salón"). Un -10 % sobre null
    // sería un 0 presentado como cifra buena, que es el bug del `precio_facturado`.
    const sinPrecio = CATALOGO.map(s =>
        serviceCatalogKey(s) === 'Tratamiento Orgánico|Orising hidratación intensa'
            ? { ...s, precio: null } : s);
    const r = resolveSeguimientoRegla(REGLA_HIDRATACION, sinPrecio);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.motivo, 'destino_sin_precio');
});

test('un origen que no es una categoría del catálogo no dispara nada', () => {
    const r = resolveSeguimientoRegla({ ...REGLA_HIDRATACION, origen: 'Mechas' }, CATALOGO);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.motivo, 'origen_no_existe');
    // "Mechas" es prefijo de cuatro categorías: si esto pasara, dispararía las cuatro.
    assert.ok(/no existe|no es/i.test(r.mensaje), r.mensaje);
});

test('días y descuento fuera de rango se rechazan, no se recortan', () => {
    const malos = [
        [{ dias: 0 },      'dias_invalidos'],
        [{ dias: -3 },     'dias_invalidos'],
        [{ dias: 400 },    'dias_invalidos'],
        [{ dias: '18 días' }, 'dias_invalidos'],
        [{ descuentoPct: 0 },   'descuento_invalido'],
        [{ descuentoPct: 100 }, 'descuento_invalido'],
        [{ descuentoPct: -5 },  'descuento_invalido'],
    ];
    for (const [parche, motivo] of malos) {
        const r = resolveSeguimientoRegla({ ...REGLA_HIDRATACION, ...parche }, CATALOGO);
        assert.strictEqual(r.ok, false, `${JSON.stringify(parche)} debería fallar`);
        assert.strictEqual(r.motivo, motivo, JSON.stringify(parche));
    }
});

test('una regla apagada se dice apagada, que no es lo mismo que estar mal', () => {
    const r = resolveSeguimientoRegla({ ...REGLA_HIDRATACION, activa: false }, CATALOGO);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.motivo, 'apagada');
});

// ─── 5. El dinero: euros, nunca porcentaje ───────────────────────────────────

test('el precio con descuento se redondea al céntimo', () => {
    assert.strictEqual(precioConDescuento(85, 10), 76.5);
    assert.strictEqual(precioConDescuento(45, 10), 40.5);
    assert.strictEqual(precioConDescuento(110, 10), 99);
    assert.strictEqual(precioConDescuento(235, 10), 211.5);
    // El que descubre un redondeo flotante mal hecho: 0.1*3 no es 0.3.
    assert.strictEqual(precioConDescuento(0.3, 10), 0.27);
});

test('un precio que no es un número no produce un 0', () => {
    // Regla 3: un dato que no resuelve no se inventa. Un 0 aquí sale por WhatsApp como
    // "gratis" y luego hay que discutirlo en el mostrador.
    for (const malo of [null, undefined, NaN, 'ochenta y cinco', '']) {
        assert.strictEqual(precioConDescuento(malo, 10), null, `precio ${JSON.stringify(malo)}`);
    }
    assert.strictEqual(precioConDescuento(85, null), null);
});

test('los euros se escriben como en la lista de precios del salón', () => {
    assert.strictEqual(formatPrecioEur(85), '85 €');       // entero: sin ,00
    assert.strictEqual(formatPrecioEur(76.5), '76,50 €');  // con céntimos: coma
    assert.strictEqual(formatPrecioEur(99), '99 €');
});

test('el mensaje lleva las DOS cifras en euros y NUNCA el porcentaje', () => {
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        const msg = buildSeguimientoMensaje({
            nombre: 'Nora',
            servicio: 'Orising hidratación intensa',
            precio: 85,
            precioFinal: 76.5,
            language: lang,
        });
        assert.ok(msg.includes('76,50 €'), `[${lang}] falta el precio con descuento: ${msg}`);
        assert.ok(msg.includes('85 €'),    `[${lang}] falta el precio de tachar: ${msg}`);
        assert.ok(!/10\s*%|%/.test(msg),   `[${lang}] el mensaje enseña el porcentaje: ${msg}`);
        assert.ok(msg.includes('Nora'),    `[${lang}] falta el nombre`);
        // Sin el servicio nombrado, un "sí" tres semanas después no resuelve contra nada.
        assert.ok(msg.includes('Orising hidratación intensa'), `[${lang}] falta el servicio: ${msg}`);
    }
});

test('los cuatro idiomas son textos DISTINTOS, no el castellano repetido', () => {
    const args = { nombre: 'Nora', servicio: 'Orising hidratación intensa', precio: 85, precioFinal: 76.5 };
    const textos = ['es', 'en', 'ru', 'uk'].map(language => buildSeguimientoMensaje({ ...args, language }));
    assert.strictEqual(new Set(textos).size, 4, 'hay idiomas que devuelven el mismo texto');
    assert.ok(/[а-яїієґ]/i.test(textos[2]), 'el ruso no lleva cirílico');
    assert.ok(/[іїєґ]/i.test(textos[3]), 'el ucraniano no lleva sus letras propias');
});

test('un idioma desconocido o nulo cae a castellano, no al vacío', () => {
    const args = { nombre: 'Nora', servicio: 'X', precio: 85, precioFinal: 76.5 };
    const es = buildSeguimientoMensaje({ ...args, language: 'es' });
    assert.strictEqual(buildSeguimientoMensaje({ ...args, language: null }), es);
    assert.strictEqual(buildSeguimientoMensaje({ ...args, language: 'fr' }), es);
});

test('sin precio resuelto NO se fabrica mensaje', () => {
    assert.strictEqual(buildSeguimientoMensaje({
        nombre: 'Nora', servicio: 'X', precio: 85, precioFinal: null, language: 'es',
    }), null);
});

// ─── 6. La config se valida al ESCRIBIRLA, no al enviarla ────────────────────

test('config `seguimientos` rechaza lo que no es una lista de reglas', () => {
    for (const malo of ['hidratación a las 3 semanas', 42, { origen: 'x' }, true]) {
        const r = validateConfigValue('seguimientos', malo);
        assert.strictEqual(r.ok, false, `${JSON.stringify(malo)} debería rechazarse`);
    }
    assert.strictEqual(validateConfigValue('seguimientos', []).ok, true);
});

test('config `seguimientos` rechaza un destino que no es una clave de catálogo', () => {
    // Esta es la línea que impide que nazca otro business_info.upselling: una frase de
    // marketing no entra ni siquiera al fichero de config.
    const r = validateConfigValue('seguimientos', [
        { key: 'x', origen: 'Mechas Balayage', destino: 'hidratación intensa', dias: 18, descuentoPct: 10 },
    ]);
    assert.strictEqual(r.ok, false);
    assert.ok(/destino/i.test(r.mensaje), r.mensaje);
});

test('config `seguimientos` acepta una regla bien formada y otra aún sin destino', () => {
    const r = validateConfigValue('seguimientos', [
        { key: 'hidratacion', origen: 'Mechas Balayage', destino: 'Tratamiento Orgánico|Orising hidratación intensa', dias: 18, descuentoPct: 10, activa: true },
        { key: 'matiz', origen: 'Mechas Airtouch', destino: null, sugerencia: 'matiz', dias: 28, descuentoPct: 10, activa: true },
    ]);
    assert.strictEqual(r.ok, true, r.mensaje);
    // `destino: null` es un estado LEGÍTIMO: es como nace una regla antes de que la dueña
    // elija. Lo que no puede es enviar (eso lo dice resolveSeguimientoRegla).
});

test('config `seguimientos` rechaza dos reglas con la misma key', () => {
    const r = validateConfigValue('seguimientos', [
        { key: 'x', origen: 'Mechas Balayage', destino: null, dias: 18, descuentoPct: 10 },
        { key: 'x', origen: 'Mechas Airtouch', destino: null, dias: 28, descuentoPct: 10 },
    ]);
    assert.strictEqual(r.ok, false);
    assert.ok(/repetid|misma|duplicad/i.test(r.mensaje), r.mensaje);
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
