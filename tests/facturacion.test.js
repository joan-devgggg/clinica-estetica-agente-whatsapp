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
    filterAppointmentsByStylist,
    buildBillingStylistOptions,
    NO_STYLIST_KEY,
} = require('../services/helpers');

const _r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

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
    { nombre: 'Consulta', precio: null, duracion: 60, categoria: 'Consulta' },
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

// ─── Filtro por estilista ───────────────────────────────────────────────────────
// El selector del panel manda ?stylist= y el informe se construye SOLO con las citas de
// esa estilista. El filtro no puede inventar ni perder dinero: la suma de los informes
// individuales tiene que dar exactamente el informe de "todas".

// Las 8 estilistas reales de Sante, tal como las devuelve GET /api/stylists (active=true).
const SANTE_STYLISTS = [
    { id: 'c3d4e5f6-a7b8-9012-cdef-234567890101', name: 'Veronika' },
    { id: 'c3d4e5f6-a7b8-9012-cdef-234567890102', name: 'Irina' },
    { id: 'c3d4e5f6-a7b8-9012-cdef-234567890103', name: 'Yulia' },
    { id: 'c3d4e5f6-a7b8-9012-cdef-234567890104', name: 'Olgha' },
    { id: 'c3d4e5f6-a7b8-9012-cdef-234567890105', name: 'Larisa' },
    { id: 'c3d4e5f6-a7b8-9012-cdef-234567890106', name: 'Tetiana' },
    { id: 'c3d4e5f6-a7b8-9012-cdef-234567890107', name: 'Natalia' },
    { id: 'c3d4e5f6-a7b8-9012-cdef-234567890108', name: 'Yulia-Tricóloga' },
];
const ID = Object.fromEntries(SANTE_STYLISTS.map(s => [s.name, s.id]));

// Citas del periodo: varias estilistas, un combo con " + " dentro del nombre, una cita
// sin calcular por precio null, otra por servicio inexistente y una sin estilista asignada.
const APPTS_FILTRO = [
    { appointment_id: 'f1', service: 'Mechas Airtouch Largo 2 + K18', stylist_id: ID.Veronika, stylist_name: 'Veronika', starts_at: '2026-07-20T09:00:00Z', cliente: 'Ana' },
    { appointment_id: 'f2', service: 'Corte mujer y secado', stylist_id: ID.Veronika, stylist_name: 'Veronika', starts_at: '2026-07-20T12:00:00Z', cliente: 'Lucía' },
    { appointment_id: 'f3', service: 'Consulta', stylist_id: ID.Veronika, stylist_name: 'Veronika', starts_at: '2026-07-21T09:00:00Z', cliente: 'Sara' },
    { appointment_id: 'f4', service: 'Manicura + gel', stylist_id: ID.Olgha, stylist_name: 'Olgha', starts_at: '2026-07-21T10:00:00Z', cliente: 'Marta' },
    { appointment_id: 'f5', service: 'Pedicura + esmaltado + K18', stylist_id: ID.Olgha, stylist_name: 'Olgha', starts_at: '2026-07-22T10:00:00Z', cliente: 'Elena' },
    { appointment_id: 'f6', service: 'Mechas Airtouch Largo 1', stylist_id: ID.Irina, stylist_name: 'Irina', starts_at: '2026-07-22T16:00:00Z', cliente: 'Rocío' },
    { appointment_id: 'f7', service: 'Servicio inventado', stylist_id: ID.Larisa, stylist_name: 'Larisa', starts_at: '2026-07-23T11:00:00Z', cliente: 'Paula' },
    { appointment_id: 'f8', service: 'Manicura', stylist_id: null, stylist_name: null, starts_at: '2026-07-23T18:00:00Z', cliente: 'Nuria' },
];

const informeDe = stylistId =>
    buildStylistBillingReport(filterAppointmentsByStylist(APPTS_FILTRO, stylistId), CATALOG);

test('selector: las 8 estilistas de Sante + "Sin estilista asignada"', () => {
    const rep = buildStylistBillingReport(APPTS_FILTRO, CATALOG);
    const opciones = buildBillingStylistOptions(SANTE_STYLISTS, rep.estilistas);
    assert.strictEqual(opciones.length, 9);
    for (const s of SANTE_STYLISTS) {
        const o = opciones.find(x => x.stylist_id === s.id);
        assert.ok(o, `falta ${s.name} en el selector`);
        assert.strictEqual(o.stylist_name, s.name);
    }
    // El grupo sin estilista va siempre, aunque no haya citas sueltas en el periodo.
    assert.strictEqual(opciones[opciones.length - 1].stylist_id, NO_STYLIST_KEY);
    assert.strictEqual(opciones[opciones.length - 1].stylist_name, 'Sin estilista asignada');
    // Sin duplicados: una estilista con citas está en ambas fuentes y aparece UNA vez.
    assert.strictEqual(new Set(opciones.map(o => o.stylist_id)).size, 9);
});

test('selector: estilista desactivada con citas en el periodo sigue apareciendo', () => {
    // No está en /api/stylists (active=false) pero sí facturó: su dinero debe ser inspeccionable.
    const rep = buildStylistBillingReport([
        ...APPTS_FILTRO,
        { appointment_id: 'f9', service: 'Manicura', stylist_id: 'c3d4e5f6-a7b8-9012-cdef-234567890999', stylist_name: 'Antigua', starts_at: '2026-07-24T10:00:00Z', cliente: 'Eva' },
    ], CATALOG);
    const opciones = buildBillingStylistOptions(SANTE_STYLISTS, rep.estilistas);
    assert.strictEqual(opciones.length, 10);
    assert.ok(opciones.find(o => o.stylist_name === 'Antigua'));
});

test('filterAppointmentsByStylist: uuid, centinela, sin filtro e id inexistente', () => {
    assert.strictEqual(filterAppointmentsByStylist(APPTS_FILTRO, ID.Veronika).length, 3);
    assert.deepStrictEqual(
        filterAppointmentsByStylist(APPTS_FILTRO, NO_STYLIST_KEY).map(a => a.appointment_id),
        ['f8']
    );
    assert.strictEqual(filterAppointmentsByStylist(APPTS_FILTRO, null).length, APPTS_FILTRO.length);
    assert.strictEqual(filterAppointmentsByStylist(APPTS_FILTRO, ID.Tetiana).length, 0);
});

test('filtrar por una estilista da EXACTAMENTE su fila del informe de todas', () => {
    const todas = buildStylistBillingReport(APPTS_FILTRO, CATALOG);
    for (const s of SANTE_STYLISTS) {
        const filaEnTodas = todas.estilistas.find(e => e.stylist_id === s.id);
        const solo = informeDe(s.id);
        if (!filaEnTodas) { assert.strictEqual(solo.estilistas.length, 0); continue; }
        assert.strictEqual(solo.estilistas.length, 1);
        assert.deepStrictEqual(solo.estilistas[0], filaEnTodas);
        // Y los totales del informe filtrado son los de esa única fila.
        assert.strictEqual(solo.totales.totalConIva, filaEnTodas.totalConIva);
        assert.strictEqual(solo.totales.totalSinIva, filaEnTodas.totalSinIva);
        assert.strictEqual(solo.totales.iva, filaEnTodas.iva);
        assert.strictEqual(solo.totales.numCitas, filaEnTodas.numCitas);
        assert.strictEqual(solo.sinCalcularTotal, filaEnTodas.sinCalcular);
    }
});

test('filtrar solo trae las citas de esa estilista', () => {
    const olgha = informeDe(ID.Olgha);
    assert.deepStrictEqual(
        olgha.estilistas[0].citas.map(c => c.appointment_id).sort(),
        ['f4', 'f5']
    );
    assert.strictEqual(olgha.estilistas[0].totalConIva, 125); // 35 (Manicura + gel) + 90
});

// LA prueba de que el filtro no pierde ni duplica dinero.
test('invariante: "todas" == suma exacta de los informes individuales', () => {
    const todas = buildStylistBillingReport(APPTS_FILTRO, CATALOG);
    const claves = [...SANTE_STYLISTS.map(s => s.id), NO_STYLIST_KEY];
    const suma = claves.reduce((acc, key) => {
        const r = informeDe(key);
        return {
            totalConIva: acc.totalConIva + r.totales.totalConIva,
            totalSinIva: acc.totalSinIva + r.totales.totalSinIva,
            iva: acc.iva + r.totales.iva,
            numCitas: acc.numCitas + r.totales.numCitas,
            sinCalcular: acc.sinCalcular + r.sinCalcularTotal,
        };
    }, { totalConIva: 0, totalSinIva: 0, iva: 0, numCitas: 0, sinCalcular: 0 });

    assert.strictEqual(suma.totalConIva, todas.totales.totalConIva);
    assert.strictEqual(suma.totalSinIva, todas.totales.totalSinIva);
    assert.strictEqual(suma.iva, todas.totales.iva);
    assert.strictEqual(suma.numCitas, todas.totales.numCitas);
    assert.strictEqual(suma.sinCalcular, todas.sinCalcularTotal);
    // Y ninguna cita del periodo se queda fuera de las opciones del selector.
    assert.strictEqual(todas.totales.numCitas, APPTS_FILTRO.length);
    assert.strictEqual(todas.totales.totalConIva, 435); // 200 + 125 + 90 + 0 (Larisa) + 20
});

// Regresión de redondeo: con la base global derivada del total (total/1.21) esta suma se
// desviaba un céntimo. La base global es la SUMA de las bases por estilista.
test('invariante con redondeos adversos (8 estilistas × 25 €)', () => {
    const cat = [{ nombre: 'Servicio 25', precio: 25, duracion: 60, categoria: 'Varios' }];
    const citas = SANTE_STYLISTS.map((s, i) => ({
        appointment_id: `r${i}`, service: 'Servicio 25', stylist_id: s.id,
        stylist_name: s.name, starts_at: '2026-07-20T09:00:00Z', cliente: 'X',
    }));
    const todas = buildStylistBillingReport(citas, cat);
    const suma = SANTE_STYLISTS.reduce((acc, s) => {
        const r = buildStylistBillingReport(filterAppointmentsByStylist(citas, s.id), cat);
        return {
            totalConIva: acc.totalConIva + r.totales.totalConIva,
            totalSinIva: acc.totalSinIva + r.totales.totalSinIva,
            iva: acc.iva + r.totales.iva,
        };
    }, { totalConIva: 0, totalSinIva: 0, iva: 0 });
    assert.strictEqual(suma.totalConIva, todas.totales.totalConIva); // 200
    assert.strictEqual(todas.totales.totalSinIva, 165.28);           // 8 × 20.66, no 165.29
    assert.strictEqual(suma.totalSinIva, todas.totales.totalSinIva);
    assert.strictEqual(suma.iva, todas.totales.iva);
    // Base + IVA reconstruye el total con IVA (sin céntimos huérfanos).
    assert.strictEqual(_r2(todas.totales.totalSinIva + todas.totales.iva), todas.totales.totalConIva);
});

test('el aviso "sin poder calcular" sobrevive al filtro por estilista', () => {
    const vero = informeDe(ID.Veronika);
    assert.strictEqual(vero.sinCalcularTotal, 1);           // f3 (Consulta, precio null)
    assert.strictEqual(vero.estilistas[0].sinCalcular, 1);
    assert.strictEqual(vero.totales.totalConIva, 200);      // 165 + 35; la Consulta NO suma
    assert.strictEqual(vero.estilistas[0].citas.find(c => c.appointment_id === 'f3').precio, null);

    // Larisa: su única cita es unmatched → 0 € facturados y el aviso levantado.
    const larisa = informeDe(ID.Larisa);
    assert.strictEqual(larisa.sinCalcularTotal, 1);
    assert.strictEqual(larisa.totales.totalConIva, 0);

    // Olgha: el combo con " + " dentro del nombre NO dispara falsos avisos.
    const olgha = informeDe(ID.Olgha);
    assert.strictEqual(olgha.sinCalcularTotal, 0);
});

test('estilista sin citas en el periodo → informe vacío a cero, sin NaN', () => {
    const rep = informeDe(ID.Tetiana);
    assert.strictEqual(rep.estilistas.length, 0);
    assert.strictEqual(rep.totales.totalConIva, 0);
    assert.strictEqual(rep.totales.totalSinIva, 0);
    assert.strictEqual(rep.totales.iva, 0);
    assert.strictEqual(rep.totales.numCitas, 0);
    assert.strictEqual(rep.sinCalcularTotal, 0);
});

test('filtro por el grupo sin estilista asignada', () => {
    const rep = informeDe(NO_STYLIST_KEY);
    assert.strictEqual(rep.estilistas.length, 1);
    assert.strictEqual(rep.estilistas[0].stylist_id, null);
    assert.strictEqual(rep.estilistas[0].stylist_name, 'Sin estilista asignada');
    assert.strictEqual(rep.totales.totalConIva, 20);
});

if (!process.exitCode) console.log('\nTodos los tests de facturación por estilista OK');
process.exit(process.exitCode || 0);
