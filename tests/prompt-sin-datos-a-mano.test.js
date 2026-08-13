// El prompt de Sante no puede llevar precios ni duraciones escritos a mano.
//
// Contexto (13/08/2026): al preparar el fichero para que la dueña rehiciera el catálogo
// aparecieron ONCE cifras tecleadas dentro de la prosa del prompt — las tres mechas clásicas
// (en DOS sitios distintos), el «Precio fijo 160€» de Contouring, los cinco cortes y la
// consulta tricológica. Las once eran CORRECTAS: casaban con el catálogo vivo. Y las once
// iban a dejar de serlo el día que la dueña repreciara, con el agravante de que el bloque
// CATÁLOGO del mismo prompt diría el precio nuevo y la prosa de al lado el viejo. El bot se
// contradiría dentro de un solo mensaje, y nada lo habría avisado.
//
// CÓMO FUNCIONA ESTA RED, que es lo único que hay que entender para mantenerla:
// se construye el prompt con un catálogo FICTICIO de precios y duraciones IMPOSIBLES
// (primos: 7, 13, 23…), y luego se exige que cada cifra que aparece en el prompt salga de
// ese catálogo o de una fuente DECLARADA. Un número tecleado a mano no puede estar en el
// catálogo ficticio —ese es el truco entero—, así que sale en rojo con su línea.
//
// No prohíbe los precios: prohíbe los precios que no vienen del dato. Por eso sigue en verde
// cuando la dueña reprecia, que es justo lo que va a pasar.
//
// Puro: cero red, cero Supabase, cero LLM.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { buildSystemPrompt } = require('../services/providers/openai');
const { SANTE_ORG_ID, SANREMO_ORG_ID } = require('../services/org-registry');
const { TRATAMIENTOS_PRECIO_MIN, TRATAMIENTOS_PRECIO_MAX } = require('../services/helpers');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// Catálogo con la FORMA del real (categorías que el prompt trata aparte, homónimos entre
// categorías, una entrada sin precio) pero con cifras que no existen en ningún salón: si una
// de ellas aparece en el prompt es porque se leyó de aquí. Los precios son primos y las
// duraciones también, para que ni una suma ni un redondeo puedan fabricarlas por accidente.
const CATALOGO = [
    { nombre: 'Mechas 1', precio: 7, duracion: 11, categoria: 'Mechas clásicas' },
    { nombre: 'Mechas 2', precio: 13, duracion: 17, categoria: 'Mechas clásicas' },
    { nombre: 'Mechas 3', precio: 19, duracion: 23, categoria: 'Mechas clásicas' },
    { nombre: 'Mechas Contouring', precio: 29, duracion: 31, categoria: 'Mechas Contouring' },
    { nombre: 'Hombre', precio: 37, duracion: 41, categoria: 'Cortes' },
    { nombre: 'Niño', precio: 43, duracion: 47, categoria: 'Cortes' },
    { nombre: 'Infantil hasta 8 años', precio: 53, duracion: 59, categoria: 'Cortes' },
    { nombre: 'Mujer y secado', precio: 61, duracion: 67, categoria: 'Cortes' },
    { nombre: 'Mujer y peinado Dyson', precio: 71, duracion: 73, categoria: 'Cortes' },
    { nombre: 'Consulta tricológica con Yulia', precio: 79, duracion: 83, categoria: 'Diagnóstico Capilar' },
    { nombre: 'Largo 1', precio: 89, duracion: 97, categoria: 'Mechas Airtouch' },
    { nombre: 'Largo 2', precio: 101, duracion: 103, categoria: 'Mechas Airtouch' },
    { nombre: 'Consulta', precio: null, duracion: 107, categoria: 'Consulta' },
];

const BUSINESS_HOURS = {
    lunes: { apertura: '10:00', cierre: '19:00' },
    martes: { apertura: '10:00', cierre: '19:00' },
    miercoles: { apertura: '10:00', cierre: '19:00' },
    jueves: { apertura: '10:00', cierre: '19:00' },
    viernes: { apertura: '10:00', cierre: '19:00' },
    sabado: { apertura: '10:00', cierre: '19:00' },
};

const cfg = (extra = {}) => ({
    services: CATALOGO,
    business_hours: BUSINESS_HOURS,
    business_info: { companyName: 'Sante', direccion: 'Calle X', horario: 'L-S 10:00-19:00' },
    ...extra,
});

const prompt = (partialData = {}, extra = {}) =>
    buildSystemPrompt(SANTE_ORG_ID, partialData, 'reservar', false, null, cfg(extra));

// Todas las líneas del prompt que contienen una cifra en euros, con su número de línea, para
// que el fallo diga DÓNDE y no solo que lo hay.
function lineasConPrecio(texto) {
    const encontradas = [];
    texto.split('\n').forEach((linea, i) => {
        for (const m of linea.matchAll(/(\d+(?:[.,]\d+)?)\s*€|€\s*(\d+(?:[.,]\d+)?)/g)) {
            encontradas.push({ linea: i + 1, texto: linea.trim(), valor: Number((m[1] || m[2]).replace(',', '.')) });
        }
    });
    return encontradas;
}

function lineasConMinutos(texto) {
    const encontradas = [];
    texto.split('\n').forEach((linea, i) => {
        for (const m of linea.matchAll(/(\d+)\s*(?:min\b|minutos\b)/gi)) {
            encontradas.push({ linea: i + 1, texto: linea.trim(), valor: Number(m[1]) });
        }
    });
    return encontradas;
}

const PRECIOS_CATALOGO = new Set(CATALOGO.map(s => s.precio).filter(p => p != null));
const DURACIONES_CATALOGO = new Set(CATALOGO.map(s => s.duracion).filter(d => d != null));

// Las ÚNICAS cifras de euros que pueden no venir del catálogo, cada una con su fuente. No es
// una lista de excepciones: es la lista de fuentes declaradas, y por eso se importan de donde
// viven en vez de copiarse. Si alguien añade aquí un número literal, está reabriendo el bug.
const PRECIOS_DE_OTRA_FUENTE = new Set([TRATAMIENTOS_PRECIO_MIN, TRATAMIENTOS_PRECIO_MAX]);

// Minutos que NO son duraciones de servicio, uno por uno y con su porqué. Cada entrada es una
// decisión deliberada documentada en otro sitio; ninguna sale de un dato editable.
const MINUTOS_QUE_NO_SON_DURACIONES = new Map([
    [30, 'granularidad de la parrilla de huecos ("los huecos se ofrecen cada 30 min")'],
    [20, 'duración VISIBLE de la Consulta de valoración: es 20 a propósito, distinta del bloque real que reserva la agenda'],
]);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Ninguna cifra en euros que no venga del catálogo o de una fuente declarada
// ─────────────────────────────────────────────────────────────────────────────

test('todo precio del prompt de Sante sale del catálogo (o de una fuente declarada)', () => {
    const p = prompt();
    const intrusos = lineasConPrecio(p)
        .filter(x => !PRECIOS_CATALOGO.has(x.valor) && !PRECIOS_DE_OTRA_FUENTE.has(x.valor));
    assert.deepStrictEqual(
        intrusos, [],
        'Hay precios escritos a mano en el prompt de Sante. Cada uno de estos números no existe\n'
        + 'en el catálogo con el que se construyó el prompt, así que está tecleado en la prosa y\n'
        + 'mentirá en cuanto la dueña reprecie. Sácalo del catálogo o quítalo:\n'
        + intrusos.map(x => `  línea ${x.linea}: ${x.valor} € → ${x.texto}`).join('\n'),
    );
});

// El SIGUIENTE PASO es otro prompt distinto según el estado de la conversación, y la tabla de
// mechas clásicas vivía DOS veces: en la sección fija y aquí. Este bloque es el que cazaría
// que alguien arregle una copia y se deje la otra.
test('tampoco en el SIGUIENTE PASO de mechas clásicas', () => {
    const p = prompt({ __askLargoFirst: true, __pendingLargoCategory: 'Mechas clásicas', nombre: 'Ana Ruiz' });
    assert.ok(p.includes('Mechas 1 (7€, 11 min)'), 'el SIGUIENTE PASO debe recitar el precio del catálogo');
    const intrusos = lineasConPrecio(p)
        .filter(x => !PRECIOS_CATALOGO.has(x.valor) && !PRECIOS_DE_OTRA_FUENTE.has(x.valor));
    assert.deepStrictEqual(intrusos, [], intrusos.map(x => `línea ${x.linea}: ${x.valor} € → ${x.texto}`).join('\n'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Lo mismo con las duraciones
// ─────────────────────────────────────────────────────────────────────────────

test('toda duración en minutos sale del catálogo, salvo las declaradas', () => {
    const p = prompt();
    const intrusos = lineasConMinutos(p)
        .filter(x => !DURACIONES_CATALOGO.has(x.valor) && !MINUTOS_QUE_NO_SON_DURACIONES.has(x.valor));
    assert.deepStrictEqual(
        intrusos, [],
        'Hay duraciones escritas a mano en el prompt de Sante:\n'
        + intrusos.map(x => `  línea ${x.linea}: ${x.valor} min → ${x.texto}`).join('\n'),
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Los bloques derivados dicen lo que dice el catálogo, no lo que decía la prosa
// ─────────────────────────────────────────────────────────────────────────────

test('las mechas clásicas se recitan con el precio y la duración del catálogo', () => {
    const p = prompt();
    assert.ok(p.includes('Mechas 1 (7€, 11 min) = solo delante, puntas y rostro'));
    assert.ok(p.includes('Mechas 2 (13€, 17 min) = media cabeza'));
    assert.ok(p.includes('Mechas 3 (19€, 23 min) = cabeza completa'));
});

// La cobertura no está en ninguna columna del catálogo: es lo único que ese bloque añade.
// Renombrar una entrada tiene que costarle la DESCRIPCIÓN, nunca el precio — una explicación
// pegada al servicio equivocado es peor que ninguna (regla 3).
test('una mechas renombrada pierde su descripción pero conserva su precio', () => {
    const renombrado = CATALOGO.map(s => (s.nombre === 'Mechas 2' ? { ...s, nombre: 'Mechas medias' } : s));
    const p = buildSystemPrompt(SANTE_ORG_ID, {}, 'reservar', false, null, cfg({ services: renombrado }));
    assert.ok(p.includes('Mechas medias (13€, 17 min)'), 'debe seguir diciendo su precio');
    assert.ok(!p.includes('Mechas medias (13€, 17 min) = media cabeza'), 'no debe heredar la cobertura de otra');
    assert.ok(p.includes('Mechas 1 (7€, 11 min) = solo delante, puntas y rostro'), 'las demás siguen con la suya');
});

// El bloque afirma "el precio no depende del largo". Eso es una afirmación sobre la FORMA del
// catálogo, no un número, y deja de ser cierta si la categoría gana variantes.
test('el bloque de Contouring desaparece si la categoría deja de tener una sola entrada', () => {
    assert.ok(prompt().includes('MECHAS CONTOURING:'), 'con una sola entrada, el bloque está');
    const conVariantes = [...CATALOGO, { nombre: 'Largo 2', precio: 109, duracion: 113, categoria: 'Mechas Contouring' }];
    const p = buildSystemPrompt(SANTE_ORG_ID, {}, 'reservar', false, null, cfg({ services: conVariantes }));
    assert.ok(!p.includes('NO preguntes el largo del pelo'), 'con variantes, esa instrucción sería falsa');
});

test('el árbol de cortes nombra los servicios sin recitar precios', () => {
    const p = prompt();
    assert.ok(p.includes('"hombre" → servicio "Corte hombre", sin más preguntas de tipo.'));
    assert.ok(p.includes('El precio de cada uno está en el CATÁLOGO de arriba'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Los días de apertura salen de business_hours, no de una constante
// ─────────────────────────────────────────────────────────────────────────────

test('los días de apertura y cierre salen de business_hours', () => {
    const p = prompt();
    assert.ok(p.includes('El salón abre estos días: lunes, martes, miércoles, jueves, viernes y sábado.'));
    assert.ok(p.includes('Cierra los domingos'));
});

// El caso que la constante «el salón solo cierra los domingos» no habría podido decir nunca.
test('si la dueña abre en domingo y cierra el lunes, el prompt lo dice', () => {
    const otro = { ...BUSINESS_HOURS, domingo: { apertura: '11:00', cierre: '15:00' } };
    delete otro.lunes;
    const p = buildSystemPrompt(SANTE_ORG_ID, {}, 'reservar', false, null, cfg({ business_hours: otro }));
    assert.ok(p.includes('Cierra los lunes'), `debía decir que cierra los lunes:\n${p.slice(p.indexOf('El salón abre'), p.indexOf('El salón abre') + 200)}`);
    assert.ok(p.includes('domingo'), 'el domingo debe estar entre los días de apertura');
    assert.ok(!p.includes('Cierra los domingos'));
});

// Regla 3: sin horario utilizable no se le inventa un calendario al salón.
test('sin business_hours utilizable el prompt no afirma ningún día', () => {
    for (const bh of [null, {}, { lunes: { apertura: 'a las diez', cierre: '19:00' } }]) {
        const p = buildSystemPrompt(SANTE_ORG_ID, {}, 'reservar', false, null, cfg({ business_hours: bh }));
        assert.ok(!p.includes('El salón abre estos días'), `no debía afirmar días con ${JSON.stringify(bh)}`);
        assert.ok(!p.includes('NO CONFUNDAS "CERRADO"'), 'ni construir la regla crítica encima');
        assert.ok(p.includes('HUECOS DISPONIBLES'), 'el resto del prompt sigue entero');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. San Remo intacto: nada de esto es suyo
// ─────────────────────────────────────────────────────────────────────────────

test('el prompt de San Remo no pasa por ninguno de estos bloques', () => {
    const p = buildSystemPrompt(SANREMO_ORG_ID, {}, 'reservar', false, null, {
        business_info: { companyName: 'San Remo' }, services: [],
    });
    assert.ok(!p.includes('MECHAS CLÁSICAS'));
    assert.ok(!p.includes('El salón abre estos días'));
});
