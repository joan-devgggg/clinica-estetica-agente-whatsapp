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

test('el IVA sigue cuadrando con importes congelados (base + iva = total)', () => {
    const citas = [{
        appointment_id: 'a1', service: 'K18', stylist_id: 's1', stylist_name: 'Yulia',
        precio_facturado: 45, iva_rate: 0.21, facturado_at: '2026-07-20T10:00:00.000Z',
    }];
    const { totales } = buildStylistBillingReport(citas, CATALOG_BARATO);
    assert.strictEqual(totales.totalSinIva + totales.iva, totales.totalConIva);
    assert.strictEqual(totales.totalSinIva, Math.round((45 / 1.21) * 100) / 100);
});

if (!process.exitCode) console.log('\nTodos los tests de facturación (ambigüedad + snapshot) OK');
process.exit(process.exitCode || 0);
