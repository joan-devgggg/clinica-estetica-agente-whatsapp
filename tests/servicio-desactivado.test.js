// Servicios dados de baja (`activo: false`) — la separación OFERTA / RESOLUCIÓN.
//
// Contexto: el 05/08/2026 Yulia pidió quitar la manicura japonesa. Se borró la fila del
// catálogo, que aquel día era inocuo porque no había ni una cita con ese servicio. Con
// citas, borrar habría movido el histórico: `appointments.service` guarda un NOMBRE, y sin
// entrada de catálogo ese nombre deja de resolver → la cita cae a "sin poder calcular" y
// desaparece de la caja del mes.
//
// De ahí el flag. Y de ahí que el test que más importa de este fichero sea el primero: una
// cita completada de un servicio desactivado tiene que facturar EXACTAMENTE igual que antes
// de desactivarlo. Todo lo demás de aquí protege esa frase.
//
// Puro: cero red, cero Supabase, cero LLM.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    isServiceActive,
    offerableCatalog,
    computeServiceBilling,
    buildStylistBillingReport,
    findCatalogEntriesExact,
    resolveServiceCatalogEntry,
    resolveServiceDurationMin,
    resolveAppointmentDurationMin,
    buildFullServiceName,
    splitServiceNames,
    extractServiceFromText,
    detectLargoCategory,
    namesConcreteService,
} = require('../services/helpers');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// Catálogo mínimo con la forma real: variantes "Largo N" que comparten nombre entre
// categorías (el caso que obliga a prefijar), y un servicio suelto con nombre propio.
const CATALOGO_BASE = [
    { nombre: 'Largo 1', precio: 90, duracion: 90, categoria: 'Mechas Airtouch' },
    { nombre: 'Largo 2', precio: 120, duracion: 180, categoria: 'Mechas Airtouch' },
    { nombre: 'Largo 1', precio: 145, duracion: 120, categoria: 'Mechas Balayage' },
    { nombre: 'Japonesa', precio: 25, duracion: 50, categoria: 'Manicura/Pedicura' },
    { nombre: 'Pedicura + esmaltado', precio: 45, duracion: 120, categoria: 'Manicura/Pedicura' },
    { nombre: 'Mujer y secado', precio: 35, duracion: 60, categoria: 'Cortes' },
];

// El MISMO catálogo con la japonesa dada de baja. Es la única diferencia: mismo orden,
// mismos precios, misma duración. Así, cualquier divergencia que salga en los asserts de
// abajo la ha causado el flag y nada más.
const desactivar = (catalogo, nombre) => catalogo.map(s =>
    s.nombre === nombre ? { ...s, activo: false } : s);

const CATALOGO_CON_BAJA = desactivar(CATALOGO_BASE, 'Japonesa');

// ─────────────────────────────────────────────────────────────────────────────
// 1. REGRESIÓN: el histórico no se mueve
// ─────────────────────────────────────────────────────────────────────────────

test('REGRESIÓN · una cita completada del servicio de baja factura exactamente igual', () => {
    const antes = computeServiceBilling('Japonesa', CATALOGO_BASE);
    const despues = computeServiceBilling('Japonesa', CATALOGO_CON_BAJA);

    assert.deepStrictEqual(despues, antes,
        'dar de baja el servicio ha cambiado el cálculo de una cita pasada');
    assert.strictEqual(despues.totalConIva, 25);
    assert.strictEqual(despues.segments[0].status, 'ok',
        'el segmento tiene que seguir siendo "ok": "unmatched" es exactamente lo que pasa al BORRAR');
});

test('REGRESIÓN · cita multi-servicio con un segmento de baja: mismo total y mismos estados', () => {
    const servicio = 'Japonesa + Pedicura + esmaltado';
    const antes = computeServiceBilling(servicio, CATALOGO_BASE);
    const despues = computeServiceBilling(servicio, CATALOGO_CON_BAJA);

    assert.deepStrictEqual(despues, antes);
    assert.strictEqual(despues.totalConIva, 70, '25 + 45');
    assert.ok(despues.segments.every(s => s.status === 'ok'));
    // El split depende del catálogo (para no trocear "Pedicura + esmaltado", que lleva el
    // separador DENTRO del nombre). Si el filtro se colara ahí, la cita se partiría mal.
    assert.deepStrictEqual(
        splitServiceNames(servicio, CATALOGO_CON_BAJA),
        splitServiceNames(servicio, CATALOGO_BASE));
});

test('REGRESIÓN · el informe por estilista da el mismo importe con y sin la baja', () => {
    const citas = [
        // Sin snapshot → se RECALCULA desde el catálogo. Es la más frágil de las tres:
        // es la única cuyo importe depende de que el servicio siga resolviendo hoy.
        {
            appointment_id: 'a1', service: 'Japonesa', stylist_id: 's1', stylist_name: 'Olga',
            starts_at: '2026-07-01T10:00:00Z', precio_facturado: null, facturado_at: null,
            precio_manual: null, servicio_facturado: null,
        },
        // Con snapshot congelado → manda el congelado.
        {
            appointment_id: 'a2', service: 'Japonesa', stylist_id: 's1', stylist_name: 'Olga',
            starts_at: '2026-07-02T10:00:00Z', precio_facturado: 25, facturado_at: '2026-07-02T12:00:00Z',
            precio_manual: null, servicio_facturado: 'Japonesa',
        },
        // Con precio manual → manda el manual.
        {
            appointment_id: 'a3', service: 'Japonesa', stylist_id: 's1', stylist_name: 'Olga',
            starts_at: '2026-07-03T10:00:00Z', precio_facturado: 25, facturado_at: '2026-07-03T12:00:00Z',
            precio_manual: 0, precio_manual_motivo: 'cortesía', servicio_facturado: 'Japonesa',
        },
    ];

    const antes = buildStylistBillingReport(citas, CATALOGO_BASE);
    const despues = buildStylistBillingReport(citas, CATALOGO_CON_BAJA);

    assert.deepStrictEqual(despues, antes,
        'el informe de facturación cambia al dar de baja el servicio');

    const fila = despues.estilistas.find(e => e.stylist_id === 's1');
    assert.strictEqual(fila.sinCalcular, 0,
        'ninguna cita puede caer a "sin poder calcular" por una baja de catálogo');
    assert.strictEqual(fila.numCitas, 3);
    assert.strictEqual(fila.totalConIva, 50, '25 recalculado + 25 congelado + 0 de cortesía');
});

test('REGRESIÓN · y el contraste: BORRAR la fila sí rompe la cita pasada', () => {
    // Este es el test que justifica el flag entero. Si algún día deja de fallar el borrado,
    // es que la resolución dejó de depender del catálogo y hay que revisar por qué.
    const borrado = CATALOGO_BASE.filter(s => s.nombre !== 'Japonesa');
    const conBorrado = computeServiceBilling('Japonesa', borrado);

    assert.strictEqual(conBorrado.segments[0].status, 'unmatched');
    assert.strictEqual(conBorrado.totalConIva, 0);

    const citas = [{
        appointment_id: 'a1', service: 'Japonesa', stylist_id: 's1', stylist_name: 'Olga',
        starts_at: '2026-07-01T10:00:00Z', precio_facturado: null, facturado_at: null,
        precio_manual: null, servicio_facturado: null,
    }];
    const informe = buildStylistBillingReport(citas, borrado);
    assert.strictEqual(informe.estilistas[0].sinCalcular, 1,
        'borrar deja la cita sin poder calcular — desactivar no');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. El flag en sí
// ─────────────────────────────────────────────────────────────────────────────

test('isServiceActive · solo el false explícito da de baja', () => {
    assert.strictEqual(isServiceActive({ nombre: 'X' }), true, 'ausente = activo (sin backfill)');
    assert.strictEqual(isServiceActive({ nombre: 'X', activo: true }), true);
    assert.strictEqual(isServiceActive({ nombre: 'X', activo: false }), false);
    // Un editor a medio escribir no puede tirar un servicio sin querer.
    assert.strictEqual(isServiceActive({ nombre: 'X', activo: null }), true);
    assert.strictEqual(isServiceActive({ nombre: 'X', activo: undefined }), true);
    assert.strictEqual(isServiceActive({ nombre: 'X', activo: 0 }), true, '0 no es false explícito');
    assert.strictEqual(isServiceActive(null), true, 'null es "no sé" — no da de baja nada');
});

test('offerableCatalog · quita solo los de baja y respeta el orden', () => {
    const out = offerableCatalog(CATALOGO_CON_BAJA);
    assert.strictEqual(out.length, CATALOGO_BASE.length - 1);
    assert.ok(!out.some(s => s.nombre === 'Japonesa'));
    // El orden importa: los desplegables del panel y la indexación por variante lo respetan.
    assert.deepStrictEqual(
        out.map(s => `${s.categoria}|${s.nombre}`),
        CATALOGO_BASE.filter(s => s.nombre !== 'Japonesa').map(s => `${s.categoria}|${s.nombre}`));
});

test('offerableCatalog · entradas no-array no revientan', () => {
    assert.deepStrictEqual(offerableCatalog(null), []);
    assert.deepStrictEqual(offerableCatalog(undefined), []);
    assert.deepStrictEqual(offerableCatalog('nope'), []);
    assert.deepStrictEqual(offerableCatalog([]), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. RESOLUCIÓN: todo lo que mira hacia atrás sigue encontrándolo
// ─────────────────────────────────────────────────────────────────────────────

test('resolución · un servicio de baja se sigue encontrando por nombre', () => {
    assert.strictEqual(findCatalogEntriesExact('Japonesa', CATALOGO_CON_BAJA).length, 1);
    assert.ok(resolveServiceCatalogEntry('Japonesa', CATALOGO_CON_BAJA));
    // Y no se encuentra sobre el ofertable — las dos mitades del flag, en una línea.
    assert.strictEqual(findCatalogEntriesExact('Japonesa', offerableCatalog(CATALOGO_CON_BAJA)).length, 0);
});

test('resolución · la duración de una cita viva no cambia al dar de baja el servicio', () => {
    // Reagendar una cita ya reservada tiene que seguir midiendo lo mismo: si la duración
    // cayera al fallback de 60, el motor buscaría un hueco que no es el que ocupa.
    assert.strictEqual(
        resolveServiceDurationMin('Japonesa', CATALOGO_CON_BAJA),
        resolveServiceDurationMin('Japonesa', CATALOGO_BASE));
    assert.strictEqual(resolveServiceDurationMin('Japonesa', CATALOGO_CON_BAJA), 50);

    const svc = CATALOGO_CON_BAJA.find(s => s.nombre === 'Japonesa');
    const dur = resolveAppointmentDurationMin(svc, CATALOGO_CON_BAJA);
    assert.strictEqual(dur.minutos, 50);
    assert.strictEqual(dur.resuelto, true);
});

test('resolución · buildFullServiceName cuenta homónimos sobre el catálogo COMPLETO', () => {
    // "Hombre" existe de verdad dos veces en el catálogo de Sante (Manicura/Pedicura y
    // Cortes), y es el caso que obliga a prefijar por conteo de homónimos — a diferencia de
    // "Largo N", que se prefija por su propia forma y no depende de cuántos haya.
    //
    // Si el nombre se calculara sobre la lista filtrada, dar de baja a uno de los dos haría
    // que el otro dejara de prefijarse: el nombre con el que se guarda una cita cambiaría
    // por algo que no tiene nada que ver con ella. Por eso los call sites de resolución
    // —incluido /api/service-catalog— pasan el catálogo completo.
    const DOS_HOMONIMOS = [
        { nombre: 'Hombre', precio: 25, duracion: 60, categoria: 'Manicura/Pedicura' },
        { nombre: 'Hombre', precio: 20, duracion: 30, categoria: 'Cortes' },
    ];
    const conBaja = DOS_HOMONIMOS.map((s, i) => i === 1 ? { ...s, activo: false } : s);
    const manicura = conBaja[0];

    assert.strictEqual(buildFullServiceName(manicura, DOS_HOMONIMOS), 'Manicura/Pedicura Hombre');
    assert.strictEqual(buildFullServiceName(manicura, conBaja), 'Manicura/Pedicura Hombre',
        'el catálogo completo mantiene el nombre estable aunque su homónimo esté de baja');
    assert.strictEqual(buildFullServiceName(manicura, offerableCatalog(conBaja)), 'Hombre',
        'documenta la trampa: sobre la lista filtrada el nombre pierde la categoría');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. OFERTA: los detectores dejan de proponerlo
// ─────────────────────────────────────────────────────────────────────────────

test('oferta · extractServiceFromText no lo selecciona sobre el catálogo ofertable', () => {
    assert.strictEqual(extractServiceFromText('quiero la japonesa', CATALOGO_CON_BAJA)?.nombre, 'Japonesa',
        'sobre el catálogo completo SÍ resuelve — es lo que permite facturar el histórico');
    assert.strictEqual(extractServiceFromText('quiero la japonesa', offerableCatalog(CATALOGO_CON_BAJA)), null,
        'sobre el ofertable no: el bot no puede abrir una reserva de algo que no se hace');
});

test('oferta · la clienta no se queda sin nada: el hermano de categoría sigue casando', () => {
    // "manicura japonesa" no cae a null sobre el ofertable, cae a otro servicio de la MISMA
    // categoría. Es lo que se quiere: quien pide una manicura sigue llegando a una manicura
    // en vez de a un "no te he entendido". Se afirma aquí para que se note si cambia.
    const svc = extractServiceFromText('quiero una manicura japonesa', offerableCatalog(CATALOGO_CON_BAJA));
    assert.ok(svc, 'debería resolver a algo de Manicura/Pedicura');
    assert.strictEqual(svc.categoria, 'Manicura/Pedicura');
    assert.notStrictEqual(svc.nombre, 'Japonesa');
});

test('oferta · un servicio de baja no cuenta como "servicio concreto nombrado"', () => {
    assert.ok(namesConcreteService('quiero la japonesa', CATALOGO_CON_BAJA));
    assert.ok(!namesConcreteService('quiero la japonesa', offerableCatalog(CATALOGO_CON_BAJA)));
});

test('oferta · detectLargoCategory ignora una categoría que se ha quedado sin ofertables', () => {
    const sinAirtouch = CATALOGO_BASE.map(s =>
        s.categoria === 'Mechas Airtouch' ? { ...s, activo: false } : s);
    assert.strictEqual(detectLargoCategory('quiero mechas airtouch', sinAirtouch), 'Mechas Airtouch',
        'contra el catálogo completo la categoría existe');
    assert.strictEqual(detectLargoCategory('quiero mechas airtouch', offerableCatalog(sinAirtouch)), null,
        'contra el ofertable ya no hay ninguna variante que proponer — y sin esto el bot ' +
        'preguntaría el largo de pelo para un servicio que no puede reservar');
});

test('oferta · el catálogo del prompt no enseña el servicio de baja al modelo', () => {
    const { buildSystemPrompt } = require('../services/providers/openai');
    const cfg = {
        business_info: { companyName: 'Sante', direccion: 'X', horario: 'Y' },
        services: CATALOGO_CON_BAJA,
    };
    const SANTE_ORG_ID = process.env.SANTE_ORG_ID || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
    const prompt = buildSystemPrompt(SANTE_ORG_ID, {}, 'reservar', false, null, cfg);

    assert.ok(!/Japonesa/i.test(prompt), 'si el modelo lo ve en el menú, lo ofrece');
    assert.ok(/Pedicura \+ esmaltado/.test(prompt),
        'el resto de la categoría sigue ahí: dar de baja uno no apaga la categoría');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Chokepoint: que no se añada un sitio de oferta que lea el catálogo a pelo
// ─────────────────────────────────────────────────────────────────────────────

test('chokepoint · los ficheros de oferta pasan por el catálogo FILTRADO', () => {
    // Grep, con lo que eso vale: no atrapa un call site nuevo escrito de otra forma, sí
    // atrapa el copy-paste de uno existente, que es como se añaden en la práctica.
    //
    // 19/08/2026: los sitios de OFERTA DEL BOT pasaron de `offerableCatalog` a
    // `botOfferableCatalog`, que quita además los servicios que solo se venden como
    // complemento. Sigue siendo el mismo invariante —el bot no propone lo que no puede
    // proponer— con un filtro más ancho; `offerableCatalog` sigue vivo para el panel.
    const raiz = path.join(__dirname, '..');
    const openai = fs.readFileSync(path.join(raiz, 'services/providers/openai.js'), 'utf8');
    const bot = fs.readFileSync(path.join(raiz, 'bot.js'), 'utf8');

    assert.ok(/const services = botOfferableCatalog\(agentCfg\?\.services\)/.test(openai),
        'el catálogo del prompt de Sante tiene que salir de botOfferableCatalog');
    assert.ok(/const catalogoOfertable = botOfferableCatalog\(agentCfgPre\?\.services\)/.test(bot),
        'el bloque determinista de selección de servicio tiene que tener su catálogo filtrado');
    // Ni un solo `offerableCatalog(` suelto en bot.js: todos sus call sites son de oferta
    // del bot, así que uno sin el prefijo `bot` es un filtro que se ha quedado corto.
    assert.ok(!/[^t]offerableCatalog\(/.test(bot),
        'queda un offerableCatalog( en bot.js: ahí el filtro tiene que ser botOfferableCatalog');

    // Los detectores que ELIGEN servicio no pueden recibir el catálogo crudo.
    for (const detector of ['findCorteService', 'detectLargoCategory', 'resolveK18ServiceFromText']) {
        const crudo = new RegExp(`${detector}\\([^)]*agentCfgPre\\?\\.services`);
        assert.ok(!crudo.test(bot),
            `${detector} recibe el catálogo sin filtrar: un servicio de baja se podría seleccionar`);
    }

    // Y el contrapeso, para que nadie "arregle" esto filtrando de más: la facturación y el
    // sellado del snapshot leen el catálogo COMPLETO.
    const helpers = fs.readFileSync(path.join(raiz, 'services/helpers.js'), 'utf8');
    const cuerpoBilling = helpers.slice(helpers.indexOf('function computeServiceBilling'));
    assert.ok(!/offerableCatalog|isServiceActive/.test(cuerpoBilling.slice(0, 900)),
        'computeServiceBilling no puede filtrar por activo: es la resolución del histórico');

    const dbjs = fs.readFileSync(path.join(raiz, 'services/db.js'), 'utf8');
    const cuerpoStamp = dbjs.slice(dbjs.indexOf('async function stampBillingSnapshot'));
    assert.ok(!/offerableCatalog/.test(cuerpoStamp.slice(0, 1500)),
        'stampBillingSnapshot congela el importe: catálogo completo, siempre');
});
