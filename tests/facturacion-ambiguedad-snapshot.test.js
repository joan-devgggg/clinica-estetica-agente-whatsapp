// Facturación: ambigüedad de nombre en el catálogo y snapshot del importe.
// Auditoría de integridad de datos, 30/07/2026. El catálogo real de Sante repite nombres
// crudos con precios DISTINTOS ("Largo 2" existe 4 veces: 145/160/220/260 €), así que casar
// por nombre crudo cobraba el primero que encontraba y lo presentaba como cifra buena.
// Deterministas y puros: sin WhatsApp/LLM/Supabase.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    computeServiceBilling,
    findCatalogEntriesExact,
    buildStylistBillingReport,
} = require('../services/helpers');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// Catálogo con la ambigüedad REAL de Sante: "Largo 2" existe en 4 categorías con 4 precios
// distintos (145/160/220/260 en producción). El de facturacion.test.js lo tiene una sola vez,
// que es justo por lo que este caso se colaba.
const CATALOG_AMBIGUO = [
    { nombre: 'Largo 2', precio: 260, duracion: 300, categoria: 'Alisado vegano' },
    { nombre: 'Largo 2', precio: 160, duracion: 240, categoria: 'Anti-encrespamiento' },
    { nombre: 'Largo 2', precio: 145, duracion: 120, categoria: 'Deco Total Blond' },
    { nombre: 'Largo 2', precio: 220, duracion: 360, categoria: 'Mechas Airtouch' },
    { nombre: 'K18', precio: 45, duracion: 60, categoria: 'Reconstrucción' },
    // Mismo nombre en dos categorías pero MISMO precio: no es ambigüedad de dinero.
    { nombre: 'Hombre', precio: 25, duracion: 30, categoria: 'Cortes' },
    { nombre: 'Hombre', precio: 25, duracion: 60, categoria: 'Manicura/Pedicura' },
];

// ─── Ambigüedad de nombre: nunca cobrar "el primero que casa" ────────────────────
test('findCatalogEntriesExact devuelve TODAS las entradas que casan por nombre crudo', () => {
    const e = findCatalogEntriesExact('Largo 2', CATALOG_AMBIGUO);
    assert.strictEqual(e.length, 4, 'las 4 categorías con ese nombre');
});

test('nombre completo desambigua: "Mechas Airtouch Largo 2" cobra 220, no 260', () => {
    const { totalConIva, segments } = computeServiceBilling('Mechas Airtouch Largo 2', CATALOG_AMBIGUO);
    assert.strictEqual(segments[0].status, 'ok');
    assert.strictEqual(totalConIva, 220);
});

test('"Largo 2" a secas es AMBIGUO: no suma y no se inventa un precio', () => {
    const { totalConIva, segments } = computeServiceBilling('Largo 2', CATALOG_AMBIGUO);
    assert.strictEqual(segments[0].status, 'ambiguous');
    assert.strictEqual(segments[0].precio, null);
    assert.strictEqual(totalConIva, 0, 'no aporta importe');
    assert.deepStrictEqual(segments[0].precios, [145, 160, 220, 260], 'informa de los candidatos');
});

test('el segmento ambiguo contamina la cita entera → "sin poder calcular"', () => {
    // Es el string que escribía el UPDATE de upsell antes del fix: "Largo 2 + K18".
    // Facturaba 305 € (260 del primer "Largo 2" + 45) presentándolo como cifra buena.
    const report = buildStylistBillingReport(
        [{ appointment_id: 'a1', service: 'Largo 2 + K18', stylist_id: 's1', stylist_name: 'Yulia' }],
        CATALOG_AMBIGUO,
    );
    assert.strictEqual(report.totales.totalConIva, 0, 'no cobra 305 €');
    assert.strictEqual(report.sinCalcularTotal, 1, 'se avisa');
    assert.strictEqual(report.estilistas[0].citas[0].calculable, false);
});

test('ambigüedad con el MISMO precio no molesta: "Hombre" sigue cobrando 25', () => {
    const { totalConIva, segments } = computeServiceBilling('Hombre', CATALOG_AMBIGUO);
    assert.strictEqual(segments[0].status, 'ok');
    assert.strictEqual(totalConIva, 25);
});

// ─── Snapshot: el histórico no se reescribe ──────────────────────────────────────
const CATALOG_BARATO = [{ nombre: 'K18', precio: 45, duracion: 60, categoria: 'Reconstrucción' }];
const CATALOG_SUBIDA = [{ nombre: 'K18', precio: 60, duracion: 60, categoria: 'Reconstrucción' }];

test('sin snapshot, el informe recalcula desde el catálogo (comportamiento de siempre)', () => {
    const citas = [{ appointment_id: 'a1', service: 'K18', stylist_id: 's1', stylist_name: 'Yulia' }];
    assert.strictEqual(buildStylistBillingReport(citas, CATALOG_BARATO).totales.totalConIva, 45);
    assert.strictEqual(buildStylistBillingReport(citas, CATALOG_SUBIDA).totales.totalConIva, 60);
});

test('con snapshot, subir el precio del catálogo NO mueve el histórico', () => {
    const citas = [{
        appointment_id: 'a1', service: 'K18', stylist_id: 's1', stylist_name: 'Yulia',
        precio_facturado: 45, iva_rate: 0.21, facturado_at: '2026-07-20T10:00:00.000Z',
    }];
    const report = buildStylistBillingReport(citas, CATALOG_SUBIDA);
    assert.strictEqual(report.totales.totalConIva, 45, 'sigue valiendo lo que se cobró');
    assert.strictEqual(report.estilistas[0].citas[0].congelado, true);
});

test('el snapshot también salva una cita cuyo servicio ya no matchea el catálogo', () => {
    // Alguien edita el `service` a mano en el panel (campo de texto libre) meses después.
    const citas = [{
        appointment_id: 'a1', service: 'lo que sea que escribieron', stylist_id: 's1', stylist_name: 'Yulia',
        precio_facturado: 45, iva_rate: 0.21, facturado_at: '2026-07-20T10:00:00.000Z',
    }];
    const report = buildStylistBillingReport(citas, CATALOG_BARATO);
    assert.strictEqual(report.totales.totalConIva, 45);
    assert.strictEqual(report.sinCalcularTotal, 0);
});

test('un precio_facturado sin facturado_at NO cuenta como snapshot', () => {
    const citas = [{
        appointment_id: 'a1', service: 'K18', stylist_id: 's1', stylist_name: 'Yulia',
        precio_facturado: 45, facturado_at: null,
    }];
    assert.strictEqual(buildStylistBillingReport(citas, CATALOG_SUBIDA).totales.totalConIva, 60);
});

test('un facturado_at sin precio_facturado NO cuenta como snapshot (no factura 0 €)', () => {
    // Caso real (Paloma, 01/08/2026): la cita se completó cuando su `service` no era
    // resoluble, así que stampBillingSnapshot selló facturado_at con precio_facturado null.
    // Number(null) → 0 pasaba el isFinite y la cita salía como CALCULADA a 0,00 €.
    const citas = [{
        appointment_id: 'a1', service: 'K18', stylist_id: 's1', stylist_name: 'Yulia',
        precio_facturado: null, iva_rate: 0.21, facturado_at: '2026-08-01T12:12:56.000Z',
    }];
    const report = buildStylistBillingReport(citas, CATALOG_BARATO);
    assert.strictEqual(report.estilistas[0].citas[0].congelado, false, 'no hay snapshot que congelar');
    assert.strictEqual(report.totales.totalConIva, 45, 'recalcula desde el catálogo');
});

test('facturado_at sin precio y con servicio irresoluble cae a "sin poder calcular"', () => {
    const citas = [{
        appointment_id: 'a1', service: 'Counturing largo1 160, Matiz plus 65', stylist_id: 's1', stylist_name: 'Yulia',
        precio_facturado: null, iva_rate: 0.21, facturado_at: '2026-08-01T12:12:56.000Z',
    }];
    const report = buildStylistBillingReport(citas, CATALOG_BARATO);
    assert.strictEqual(report.sinCalcularTotal, 1, 'se avisa, no se factura a 0 en silencio');
    assert.strictEqual(report.estilistas[0].citas[0].precio, null);
});

test('el IVA sigue cuadrando con importes congelados (base + iva = total)', () => {
    const citas = [{
        appointment_id: 'a1', service: 'K18', stylist_id: 's1', stylist_name: 'Yulia',
        precio_facturado: 45, iva_rate: 0.21, facturado_at: '2026-07-20T10:00:00.000Z',
    }];
    const { totales } = buildStylistBillingReport(citas, CATALOG_BARATO);
    assert.strictEqual(totales.totalSinIva + totales.iva, totales.totalConIva);
    assert.strictEqual(totales.totalSinIva, Math.round((45 / 1.21) * 100) / 100);
});

// ─── Divergencia: el `service` cambió DESPUÉS de congelarse el importe ───────────
// El agujero de la 021: stampBillingSnapshot solo sella en → completed y se salta las filas
// ya selladas; updateAppointment nunca toca las columnas de facturación. Editar el servicio
// de una cita sellada movía el servicio y no el dinero, y el informe seguía dando el importe
// viejo por bueno con "sin calcular: 0". Caso real: 220 € congelados y un "Difuminado de
// raíz" (40 €) añadido después desde el panel.
const SELLADA = {
    appointment_id: 'a1', stylist_id: 's1', stylist_name: 'Yulia',
    precio_facturado: 45, iva_rate: 0.21, facturado_at: '2026-07-20T10:00:00.000Z',
};

test('el servicio cambió tras sellar → NO suma, avisa y no se confunde con "sin calcular"', () => {
    const citas = [{ ...SELLADA, service: 'K18 + Corte', servicio_facturado: 'K18' }];
    const report = buildStylistBillingReport(citas, CATALOG_BARATO);
    const cita = report.estilistas[0].citas[0];
    assert.strictEqual(cita.origen, 'divergente');
    assert.strictEqual(cita.calculable, false);
    assert.strictEqual(cita.precio, null, 'no se presenta un importe que ya no describe lo que se hizo');
    assert.strictEqual(report.totales.totalConIva, 0, 'los 45 € NO entran en el total');
    assert.strictEqual(report.divergentesTotal, 1);
    assert.strictEqual(report.sinCalcularTotal, 0, 'contador SEPARADO: son hechos distintos');
});

test('servicio_facturado null (cita pre-031) NO dispara divergencia: nada de marcar el histórico en bloque', () => {
    const citas = [{ ...SELLADA, service: 'lo que sea que escribieron', servicio_facturado: null }];
    const report = buildStylistBillingReport(citas, CATALOG_BARATO);
    assert.strictEqual(report.estilistas[0].citas[0].origen, 'congelado');
    assert.strictEqual(report.divergentesTotal, 0);
    assert.strictEqual(report.totales.totalConIva, 45);
});

test('una SUBIDA de precio del catálogo NO es divergencia (por eso se compara el string, no el precio)', () => {
    // Es el caso real de "Mechas Contouring + Matiz plus + K18": se selló a 270 € y luego
    // las migraciones 024/026 renombraron "K18". El congelado es CORRECTO. Si comparásemos
    // precios en vez de nombres, esta cita saldría en rojo todos los meses para siempre.
    const citas = [{ ...SELLADA, service: 'K18', servicio_facturado: 'K18' }];
    const report = buildStylistBillingReport(citas, CATALOG_SUBIDA);
    assert.strictEqual(report.estilistas[0].citas[0].origen, 'congelado');
    assert.strictEqual(report.divergentesTotal, 0);
    assert.strictEqual(report.totales.totalConIva, 45, 'sigue valiendo lo que se cobró');
});

test('diferencias de mayúsculas/acentos/espacios no son divergencia', () => {
    const citas = [{ ...SELLADA, service: '  k18 ', servicio_facturado: 'K18' }];
    const report = buildStylistBillingReport(citas, CATALOG_BARATO);
    assert.strictEqual(report.divergentesTotal, 0, 'normalizeText evita la falsa alarma');
    assert.strictEqual(report.estilistas[0].citas[0].origen, 'congelado');
});

// ─── Importe manual: lo que decidió una persona manda ────────────────────────────
test('el importe manual gana al snapshot y se marca como manual', () => {
    const citas = [{ ...SELLADA, service: 'K18', servicio_facturado: 'K18', precio_manual: 30 }];
    const report = buildStylistBillingReport(citas, CATALOG_BARATO);
    const cita = report.estilistas[0].citas[0];
    assert.strictEqual(cita.origen, 'manual');
    assert.strictEqual(cita.precio, 30);
    assert.strictEqual(report.totales.totalConIva, 30, 'no los 45 congelados');
    assert.strictEqual(report.manualesTotal, 1);
});

test('el importe manual gana también al recálculo (descuento sobre precio de catálogo)', () => {
    const citas = [{ appointment_id: 'a1', service: 'K18', stylist_id: 's1', stylist_name: 'Yulia', precio_manual: 20 }];
    const report = buildStylistBillingReport(citas, CATALOG_BARATO);
    assert.strictEqual(report.totales.totalConIva, 20, 'no los 45 del catálogo');
    assert.strictEqual(report.estilistas[0].citas[0].origen, 'manual');
});

test('precio_manual = 0 es un importe VÁLIDO (cortesía), no "sin corrección"', () => {
    // La trampa de truthiness, gemela del bug de precio_facturado null → 0,00 €. Con
    // `if (precio_manual)` la cita volvería a facturarse a 45 €, cobrando lo que alguien
    // decidió expresamente no cobrar.
    const citas = [{ appointment_id: 'a1', service: 'K18', stylist_id: 's1', stylist_name: 'Yulia', precio_manual: 0 }];
    const report = buildStylistBillingReport(citas, CATALOG_BARATO);
    const cita = report.estilistas[0].citas[0];
    assert.strictEqual(cita.origen, 'manual');
    assert.strictEqual(cita.calculable, true);
    assert.strictEqual(cita.precio, 0);
    assert.strictEqual(report.totales.totalConIva, 0);
    assert.strictEqual(report.manualesTotal, 1);
});

test('el importe manual RESCATA una cita ambigua que hoy no suma nada', () => {
    // Su uso más valioso: "Largo 2 + K18" es irresoluble y hoy desaparece del total.
    const citas = [{ appointment_id: 'a1', service: 'Largo 2 + K18', stylist_id: 's1', stylist_name: 'Yulia', precio_manual: 265 }];
    const report = buildStylistBillingReport(citas, CATALOG_AMBIGUO);
    assert.strictEqual(report.totales.totalConIva, 265);
    assert.strictEqual(report.sinCalcularTotal, 0, 'deja de estar "sin calcular"');
    assert.strictEqual(report.manualesTotal, 1);
});

test('el importe manual apaga la divergencia: es la resolución humana del aviso', () => {
    const citas = [{ ...SELLADA, service: 'K18 + Corte', servicio_facturado: 'K18', precio_manual: 70 }];
    const report = buildStylistBillingReport(citas, CATALOG_BARATO);
    assert.strictEqual(report.estilistas[0].citas[0].origen, 'manual');
    assert.strictEqual(report.divergentesTotal, 0);
    assert.strictEqual(report.totales.totalConIva, 70);
});

test('el IVA cuadra con un importe manual (misma convención que el catálogo)', () => {
    const citas = [{ appointment_id: 'a1', service: 'K18', stylist_id: 's1', stylist_name: 'Yulia', precio_manual: 30 }];
    const { totales } = buildStylistBillingReport(citas, CATALOG_BARATO);
    assert.strictEqual(totales.totalSinIva + totales.iva, totales.totalConIva);
    assert.strictEqual(totales.totalSinIva, Math.round((30 / 1.21) * 100) / 100);
});

test('precio_calculado viaja SIEMPRE, para que el panel no calcule dinero en cliente', () => {
    const citas = [
        { appointment_id: 'a1', service: 'K18', stylist_id: 's1', stylist_name: 'Yulia', precio_manual: 30 },
        { ...SELLADA, appointment_id: 'a2', service: 'K18 + Ritual inventado', servicio_facturado: 'K18' },
        { appointment_id: 'a3', service: 'Largo 2', stylist_id: 's1', stylist_name: 'Yulia' },
    ];
    const porId = {};
    for (const c of buildStylistBillingReport(citas, CATALOG_AMBIGUO).estilistas[0].citas) porId[c.appointment_id] = c;
    assert.strictEqual(porId.a1.precio_calculado, 45, 'referencia "calculado" bajo un importe manual');
    assert.strictEqual(porId.a2.precio_calculado, null, 'no recalculable: ese servicio no está en el catálogo');
    assert.strictEqual(porId.a3.precio_calculado, null, 'ambiguo → sin cifra que ofrecer');
});

if (!process.exitCode) console.log('\nTodos los tests de facturación (ambigüedad + snapshot) OK');
process.exit(process.exitCode || 0);
