// Facturación por estilista: el informe RECALCULA el importe cruzando
// appointments.service contra el catálogo (agent_configs.services), porque
// appointments NO guarda precio. Verifica el parseo del " + ", el matching por
// nombre completo / nombre crudo, el flag de "sin poder calcular" (precio null o
// servicio no encontrado) y la matemática de IVA/agregación por estilista.
// Partes DETERMINISTAS y puras — sin WhatsApp/LLM/Supabase.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    resolveServiceCatalogEntry,
    computeServiceBilling,
    buildStylistBillingReport,
} = require('../services/helpers');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// Catálogo real (subconjunto) de Sante. "Largo N" es un nombre genérico que se
// guarda en appointments.service prefijado con la categoría ("Mechas Airtouch Largo 2").
const CATALOG = [
    { nombre: 'Largo 1', precio: 90, duracion: 90, categoria: 'Mechas Airtouch' },
    { nombre: 'Largo 2', precio: 120, duracion: 180, categoria: 'Mechas Airtouch' },
    { nombre: 'Mujer y secado', precio: 35, duracion: 60, categoria: 'Cortes' },
    { nombre: 'K18', precio: 45, duracion: 60, categoria: 'Reconstrucción' },
    { nombre: 'Manicura', precio: 20, duracion: 45, categoria: 'Manicura/Pedicura' },
    // Nombres REALES del catálogo de Sante que contienen el separador " + " dentro del
    // propio nombre. Un split ciego los troceaba y la cita entera quedaba "sin calcular".
    { nombre: 'Manicura + gel', precio: 35, duracion: 90, categoria: 'Manicura/Pedicura' },
    { nombre: 'Pedicura + esmaltado', precio: 45, duracion: 120, categoria: 'Manicura/Pedicura' },
    { nombre: 'Consulta', precio: null, duracion: 300, categoria: 'Consulta' },
];

// ─── resolveServiceCatalogEntry: cascada de matching ─────────────────────────────
test('match por nombre completo generado (categoría + "Largo N")', () => {
    const svc = resolveServiceCatalogEntry('Mechas Airtouch Largo 2', CATALOG);
    assert.strictEqual(svc?.precio, 120);
});

test('match por nombre crudo de catálogo (upsell "K18")', () => {
    const svc = resolveServiceCatalogEntry('K18', CATALOG);
    assert.strictEqual(svc?.precio, 45);
});

test('match del prefijo "Corte" generado para categoría Cortes', () => {
    // buildFullServiceName convierte "Mujer y secado" → "Corte mujer y secado".
    const svc = resolveServiceCatalogEntry('Corte mujer y secado', CATALOG);
    assert.strictEqual(svc?.precio, 35);
});

test('nombre inexistente → null', () => {
    assert.strictEqual(resolveServiceCatalogEntry('Peinado unicornio', CATALOG), null);
});

// ─── computeServiceBilling: split " + " y clasificación ──────────────────────────
test('split de service con upsell múltiple y suma de precios', () => {
    const { totalConIva, segments } = computeServiceBilling('Mechas Airtouch Largo 2 + K18', CATALOG);
    assert.strictEqual(segments.length, 2);
    assert.strictEqual(totalConIva, 165); // 120 + 45
    assert.ok(segments.every(s => s.status === 'ok'));
});

// Regresión: servicios de catálogo cuyo NOMBRE lleva " + " dentro. Detectado barriendo el
// catálogo real de Sante (81 servicios) — un split ciego los partía, dejaba el trozo suelto
// unmatched y el importe de la cita desaparecía del informe (80€ de 155€ en el caso real).
test('nombre de catálogo con " + " dentro NO se trocea ("Pedicura + esmaltado")', () => {
    const { totalConIva, segments } = computeServiceBilling('Pedicura + esmaltado', CATALOG);
    assert.strictEqual(segments.length, 1);
    assert.strictEqual(segments[0].name, 'Pedicura + esmaltado');
    assert.strictEqual(segments[0].status, 'ok');
    assert.strictEqual(totalConIva, 45);
});

test('nombre de catálogo con " + " dentro NO se trocea ("Manicura + gel")', () => {
    // Ojo: "Manicura" TAMBIÉN existe suelto en el catálogo (20€), así que el longest match
    // debe preferir el nombre largo y no facturar 20€.
    const { totalConIva, segments } = computeServiceBilling('Manicura + gel', CATALOG);
    assert.strictEqual(segments.length, 1);
    assert.strictEqual(segments[0].name, 'Manicura + gel');
    assert.strictEqual(totalConIva, 35);
});

test('longest match: "Pedicura + esmaltado + K18" = 2 servicios, no 3', () => {
    const { totalConIva, segments } = computeServiceBilling('Pedicura + esmaltado + K18', CATALOG);
    assert.strictEqual(segments.length, 2);
    assert.deepStrictEqual(segments.map(s => s.name), ['Pedicura + esmaltado', 'K18']);
    assert.strictEqual(totalConIva, 90); // 45 + 45
});

test('el combo con " + " dentro SÍ cuenta como facturable en el informe', () => {
    const rep = buildStylistBillingReport([
        { appointment_id: 'a1', service: 'Manicura + gel', stylist_id: 's1', stylist_name: 'Olgha', starts_at: '2026-07-28T10:00:00Z', cliente: 'A' },
        { appointment_id: 'a2', service: 'Pedicura + esmaltado', stylist_id: 's1', stylist_name: 'Olgha', starts_at: '2026-07-28T12:00:00Z', cliente: 'B' },
    ], CATALOG);
    const olgha = rep.estilistas[0];
    assert.strictEqual(olgha.sinCalcular, 0);
    assert.strictEqual(olgha.totalConIva, 80); // 35 + 45
    assert.strictEqual(rep.sinCalcularTotal, 0);
});

test('precio null (Consulta) → unpriced, NO suma', () => {
    const { totalConIva, segments } = computeServiceBilling('Consulta', CATALOG);
    assert.strictEqual(totalConIva, 0);
    assert.strictEqual(segments[0].status, 'unpriced');
});

test('servicio no encontrado → unmatched, NO suma', () => {
    const { totalConIva, segments } = computeServiceBilling('Corte mujer y secado + Servicio raro', CATALOG);
    assert.strictEqual(totalConIva, 35); // solo el corte
    assert.strictEqual(segments[0].status, 'ok');
    assert.strictEqual(segments[1].status, 'unmatched');
});

// ─── buildStylistBillingReport: agregación + IVA ─────────────────────────────────
const APPTS = [
    { appointment_id: 'a1', service: 'Mechas Airtouch Largo 2 + K18', stylist_id: 's1', stylist_name: 'Veronika', starts_at: '2026-07-14T10:00:00Z', cliente: 'Ana' },
    { appointment_id: 'a2', service: 'Corte mujer y secado', stylist_id: 's1', stylist_name: 'Veronika', starts_at: '2026-07-15T11:00:00Z', cliente: 'Lucía' },
    { appointment_id: 'a3', service: 'Manicura', stylist_id: 's2', stylist_name: 'Olgha', starts_at: '2026-07-16T12:00:00Z', cliente: 'Marta' },
    { appointment_id: 'a4', service: 'Consulta', stylist_id: 's1', stylist_name: 'Veronika', starts_at: '2026-07-17T09:00:00Z', cliente: 'Sara' },
    { appointment_id: 'a5', service: 'Servicio inventado', stylist_id: null, stylist_name: null, starts_at: '2026-07-17T13:00:00Z', cliente: 'Nuria' },
];

test('agregación por estilista: Veronika suma solo las citas calculables', () => {
    const report = buildStylistBillingReport(APPTS, CATALOG);
    const vero = report.estilistas.find(e => e.stylist_id === 's1');
    assert.strictEqual(vero.numCitas, 3);      // a1, a2, a4
    assert.strictEqual(vero.sinCalcular, 1);   // a4 (Consulta, precio null)
    assert.strictEqual(vero.totalConIva, 200); // 165 (a1) + 35 (a2); a4 no suma
});

test('IVA: base sin IVA = total / 1.21 redondeado a 2 decimales', () => {
    const report = buildStylistBillingReport(APPTS, CATALOG);
    const vero = report.estilistas.find(e => e.stylist_id === 's1');
    assert.strictEqual(vero.totalSinIva, 165.29); // 200 / 1.21 = 165.289...
    assert.strictEqual(vero.iva, 34.71);          // 200 - 165.29
});

test('bucket "Sin estilista asignada" para stylist_id null', () => {
    const report = buildStylistBillingReport(APPTS, CATALOG);
    const sin = report.estilistas.find(e => e.stylist_id === null);
    assert.strictEqual(sin.stylist_name, 'Sin estilista asignada');
    assert.strictEqual(sin.sinCalcular, 1); // a5 unmatched
    assert.strictEqual(sin.totalConIva, 0);
});

test('totales globales y sinCalcularTotal', () => {
    const report = buildStylistBillingReport(APPTS, CATALOG);
    assert.strictEqual(report.totales.numCitas, 5);
    assert.strictEqual(report.totales.totalConIva, 220); // 200 (s1) + 20 (s2)
    assert.strictEqual(report.sinCalcularTotal, 2);      // a4 + a5
});

test('cada cita lleva su flag calculable y precio', () => {
    const report = buildStylistBillingReport(APPTS, CATALOG);
    const vero = report.estilistas.find(e => e.stylist_id === 's1');
    const a1 = vero.citas.find(c => c.appointment_id === 'a1');
    const a4 = vero.citas.find(c => c.appointment_id === 'a4');
    assert.strictEqual(a1.calculable, true);
    assert.strictEqual(a1.precio, 165);
    assert.strictEqual(a4.calculable, false);
    assert.strictEqual(a4.precio, null);
});

test('lista de citas vacía → informe con totales a cero', () => {
    const report = buildStylistBillingReport([], CATALOG);
    assert.strictEqual(report.estilistas.length, 0);
    assert.strictEqual(report.totales.totalConIva, 0);
    assert.strictEqual(report.sinCalcularTotal, 0);
});

if (!process.exitCode) console.log('\nTodos los tests de facturación por estilista OK');
process.exit(process.exitCode || 0);
