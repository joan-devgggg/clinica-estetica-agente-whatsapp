// Un upsell aceptado se PERSISTE por su nombre de catálogo, no por su frase de marketing.
//
// Contexto (12-13/08/2026): `business_info.upselling` guarda frases de marketing —y debe
// seguir guardándolas, es lo que se le dice a la clienta— pero esa misma frase se escribía tal
// cual en `appointments.service`. De las 9 etiquetas vivas de Sante solo DOS casan exacto
// contra el catálogo; las otras siete dependían de que la facturación fuese DIFUSA para poder
// valorarse, y dos no se valoran de ninguna manera.
//
// Esta es la Mitad 1 de la separación: el difuso corre AHORA, en la conversación, y lo que se
// guarda es un nombre que casa exacto. Sin esto, hacer estricta la facturación (Mitad 2) haría
// desaparecer el dinero de cinco de las nueve. El orden importa y es este, nunca al revés.
//
// Lo que este fichero NO afirma: que la traducción por parecido sea la correcta. «Manicura» →
// «Manicura + gel» (35 €) es una decisión de precio de la dueña, y aquí solo se exige que se
// declare. La causa de fondo —una regla de upselling es una FRASE y no una referencia a una
// entrada de catálogo— es la deuda anotada el 05/08/2026 y sigue abierta.
//
// Puro: cero red, cero Supabase, cero LLM.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    resolveAcceptedUpsellName,
    resolveAcceptedUpsellNames,
    findCatalogEntriesExact,
    computeServiceBilling,
    buildFullServiceName,
} = require('../services/helpers');

const CATALOGO = require('./fixtures/sante-catalog.json').services;

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// Las 9 etiquetas VIVAS de business_info.upselling (migraciones 018 y 026), tal cual están en
// producción a 13/08/2026. Se listan a mano a propósito: son datos que edita la dueña, y el
// valor de este test es precisamente fijar qué pasa con LAS QUE HAY. Si añade una, el test no
// se enterará — de eso se encarga la Fase 5 de verify:sante, que recorre las reglas reales.
const ETIQUETAS_VIVAS = [
    'Manicura',
    'Ampolla de cuidado',
    'Retocar',
    'Reconstrucción molecular',
    'Reconstrucción K18',
    'Exfoliación del cuero cabelludo',
    'Matiz',
    'Tratamiento capilar personalizado',
    'Tratamiento hidratación',
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. LO QUE IMPORTA: lo persistido casa EXACTO, o se declara no resuelto
// ─────────────────────────────────────────────────────────────────────────────

test('INVARIANTE · lo que se persiste casa exacto contra el catálogo, o `resuelto` es false', () => {
    const malos = [];
    for (const etiqueta of ETIQUETAS_VIVAS) {
        const r = resolveAcceptedUpsellName(etiqueta, null, CATALOGO);
        const casaExacto = findCatalogEntriesExact(r.nombre, CATALOGO).length > 0;
        // Un nombre resuelto TIENE que casar exacto: es toda la razón de ser de la función.
        if (r.resuelto && !casaExacto) {
            malos.push(`"${etiqueta}" → "${r.nombre}" (via ${r.via}) NO casa exacto`);
        }
        // Y uno no resuelto NO puede venir disfrazado de resuelto.
        if (!r.resuelto && casaExacto) {
            malos.push(`"${etiqueta}" se declara sin resolver pero "${r.nombre}" sí casa`);
        }
    }
    assert.deepStrictEqual(malos, [], 'hay upsells que se persistirían sin poder facturarse');
});

test('INVARIANTE · el nombre persistido factura como un segmento "ok" (o se declara)', () => {
    const malos = [];
    for (const etiqueta of ETIQUETAS_VIVAS) {
        const r = resolveAcceptedUpsellName(etiqueta, null, CATALOGO);
        if (!r.resuelto) continue;
        const seg = computeServiceBilling(r.nombre, CATALOGO).segments;
        if (seg.length !== 1 || (seg[0].status !== 'ok' && seg[0].status !== 'unpriced')) {
            malos.push(`"${etiqueta}" → "${r.nombre}": ${JSON.stringify(seg)}`);
        }
    }
    assert.deepStrictEqual(malos, [], 'un upsell resuelto no debería caer en unmatched/ambiguous');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Etiqueta por etiqueta, con su vía y su destino
// ─────────────────────────────────────────────────────────────────────────────
// Fijado a mano para que un cambio de mapeo salga en ROJO y se lea. Los dos 'parecido' con
// precio son las decisiones que están esperando respuesta de la dueña; si alguien las cambia
// sin preguntar, este bloque lo dice.

test('etiqueta por etiqueta: vía y nombre persistido', () => {
    // La CATEGORÍA del servicio principal importa en un solo caso, y es a propósito:
    // "Reconstrucción K18" es una mención genérica de K18, así que su destino lo decide el
    // contexto (complemento 35 € con un color en curso, suelto 60 € sin él — migración 026).
    // Se le pasa la categoría con la que se ofrece de verdad: las 5 reglas que la sugieren son
    // todas `cuidado_decoloracion`. Con null saldría el suelto, que es el default seguro pero
    // no el caso real.
    const esperado = {
        'Reconstrucción K18':               { cat: 'Mechas Balayage', via: 'k18',      nombre: 'Reconstrucción K18' },
        'Matiz':                            { cat: 'Cortes',          via: 'exacto',   nombre: 'Matiz' },
        'Manicura':                         { cat: 'Color Premium',   via: 'parecido', nombre: 'Manicura + gel' },
        'Ampolla de cuidado':               { cat: 'Color Premium',   via: 'parecido', nombre: 'Ampolla cuidado' },
        'Retocar':                          { cat: 'Color Premium',   via: 'parecido', nombre: 'Retocar mujer' },
        'Exfoliación del cuero cabelludo':  { cat: 'Cortes',          via: 'parecido', nombre: 'Exfoliación/pilling' },
        'Tratamiento capilar personalizado':{ cat: 'Cortes',          via: 'parecido', nombre: 'Consulta tricológica con Yulia' },
        'Reconstrucción molecular':         { cat: 'Color Premium',   via: null,       nombre: 'Reconstrucción molecular' },
        'Tratamiento hidratación':          { cat: 'Lavar y peinar',  via: null,       nombre: 'Tratamiento hidratación' },
    };
    for (const etiqueta of ETIQUETAS_VIVAS) {
        const exp = esperado[etiqueta];
        const r = resolveAcceptedUpsellName(etiqueta, exp.cat, CATALOGO);
        assert.deepStrictEqual({ via: r.via, nombre: r.nombre },
            { via: exp.via, nombre: exp.nombre }, `"${etiqueta}" (principal: ${exp.cat})`);
    }
});

test('las dos decisiones de precio que esperan a la dueña llevan su destino completo', () => {
    // El aviso tiene que poder decir a QUÉ está cayendo y por CUÁNTO: sin esto, contestarlo
    // exigiría reproducir el caso.
    const manicura = resolveAcceptedUpsellName('Manicura', null, CATALOGO);
    assert.strictEqual(manicura.via, 'parecido');
    assert.deepStrictEqual(manicura.destino,
        { nombre: 'Manicura + gel', categoria: 'Manicura/Pedicura', precio: 35 });

    const tratamiento = resolveAcceptedUpsellName('Tratamiento capilar personalizado', null, CATALOGO);
    assert.deepStrictEqual(tratamiento.destino,
        { nombre: 'Consulta tricológica con Yulia', categoria: 'Diagnóstico Capilar', precio: 85 });

    // Y la comparación que motiva la pregunta: existe una manicura más barata en el catálogo.
    const higienica = CATALOGO.find(s => s.nombre === 'Higiénica mujer');
    assert.ok(higienica && higienica.precio === 25 && higienica.categoria === 'Manicura/Pedicura',
        'si "Higiénica mujer" ya no son 25 €, la pregunta a la dueña cambia');
});

test('lo no resuelto NO se descarta: se conserva la etiqueta cruda', () => {
    // Quitarla del `service` borraría de la cita algo que la clienta aceptó y que el salón le
    // va a hacer. Que no se pueda facturar es un problema de datos, no motivo para perder
    // el dato.
    for (const etiqueta of ['Reconstrucción molecular', 'Tratamiento hidratación']) {
        const r = resolveAcceptedUpsellName(etiqueta, null, CATALOGO);
        assert.strictEqual(r.resuelto, false);
        assert.strictEqual(r.nombre, etiqueta, 'la etiqueta cruda tiene que sobrevivir');
        assert.strictEqual(r.destino, null);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. El K18 sigue decidiendo por contexto (no se pisa lo de la 026)
// ─────────────────────────────────────────────────────────────────────────────

test('K18 · con color en curso es el complemento; sin color, el suelto', () => {
    const conColor = resolveAcceptedUpsellName('k18', 'Mechas Balayage', CATALOGO);
    assert.strictEqual(conColor.nombre, 'Reconstrucción K18');
    assert.strictEqual(conColor.via, 'k18');
    assert.strictEqual(computeServiceBilling(conColor.nombre, CATALOGO).totalConIva, 35);

    const sinColor = resolveAcceptedUpsellName('k18', 'Cortes', CATALOGO);
    assert.strictEqual(sinColor.nombre, 'Reconstrucción K18 + lavar y peinar');
    assert.strictEqual(sinColor.via, 'k18');
    assert.strictEqual(computeServiceBilling(sinColor.nombre, CATALOGO).totalConIva, 60);
});

test('K18 · el nombre COMPLETO del suelto no se reinterpreta', () => {
    const r = resolveAcceptedUpsellName('Reconstrucción K18 + lavar y peinar', 'Mechas Balayage', CATALOGO);
    assert.strictEqual(r.nombre, 'Reconstrucción K18 + lavar y peinar');
    assert.strictEqual(r.via, 'exacto', 'es una elección explícita, no una mención genérica');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. El string completo de appointments.service
// ─────────────────────────────────────────────────────────────────────────────

test('el service que se escribiría factura entero, principal + upsells', () => {
    const principal = CATALOGO.find(s => s.nombre === 'Niño' && s.categoria === 'Cortes')
        || CATALOGO.find(s => s.categoria === 'Cortes');
    const mainName = buildFullServiceName(principal, CATALOGO);

    const { nombres } = resolveAcceptedUpsellNames(
        ['Exfoliación del cuero cabelludo', 'Matiz'], principal.categoria, CATALOGO);
    const service = [mainName, ...nombres].filter(Boolean).join(' + ');

    const { totalConIva, segments } = computeServiceBilling(service, CATALOGO);
    assert.strictEqual(segments.length, 3, `"${service}" debería ser 3 segmentos`);
    assert.deepStrictEqual(segments.map(s => s.status), ['ok', 'ok', 'ok']);
    assert.strictEqual(totalConIva, principal.precio + 10 + 40);

    // Y la afirmación que de verdad protege esto: cada segmento casa EXACTO. Sin ella el
    // bloque se apoyaría en que `computeServiceBilling` es difuso —que es justo lo que la
    // Mitad 2 le quita— y con las etiquetas crudas seguiría en verde.
    for (const seg of segments) {
        assert.ok(findCatalogEntriesExact(seg.name, CATALOGO).length > 0,
            `el segmento "${seg.name}" no casa exacto: se está apoyando en el difuso`);
    }
});

test('resolveAcceptedUpsellNames · lista vacía, nulos y catálogo vacío no explotan', () => {
    assert.deepStrictEqual(resolveAcceptedUpsellNames([], null, CATALOGO).nombres, []);
    assert.deepStrictEqual(resolveAcceptedUpsellNames(null, null, CATALOGO).nombres, []);
    assert.deepStrictEqual(resolveAcceptedUpsellNames(['Matiz', null, ''], null, CATALOGO).nombres, ['Matiz']);
    // Sin catálogo no se inventa nada: la etiqueta sale cruda y sin resolver.
    const r = resolveAcceptedUpsellName('Matiz', null, []);
    assert.strictEqual(r.resuelto, false);
    assert.strictEqual(r.nombre, 'Matiz');
});
