// Pedido por Yulia (dueña), 02/08/2026: "K18" eran en realidad dos servicios (migración 024):
//   • "K18" — SUELTO, sin color asociado: 60€ / 60 min (lava, aplica, seca, peina).
//   • "Aplicación K18" — complemento DENTRO de un servicio de color: 35€ / 15 min (el
//     lavado y el peinado ya van incluidos en el color, solo queda aplicar el producto).
//
// El matcher de texto libre (extractServiceFromText) no tiene contexto de sesión: resuelve
// por substring y un "K18" a secas SIEMPRE gana sobre el nombre largo del complemento (nunca
// al revés). Por eso "K18" se quedó con el nombre corto = SUELTO por defecto, y el caso
// "ya hay un color seleccionado" se corrige aparte con resolveK18ComplementIfNeeded, enganchado
// en bot.js justo antes de persistir upselling_aceptado.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    extractServiceFromText,
    resolveServiceDurationMin,
    resolveK18ComplementIfNeeded,
    computeServiceBilling,
} = require('../services/helpers');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// Catálogo real tras la migración 024 (subconjunto).
const CATALOG = [
    { nombre: 'Mechas Contouring', categoria: 'Mechas Contouring', precio: 160, duracion: 200 },
    { nombre: 'Matiz plus',        categoria: 'Matiz mujer',       precio: 15,  duracion: 20 },
    { nombre: 'Pro Miracle Repair TEMPTING', categoria: 'Reconstrucción', precio: 65, duracion: 60 },
    { nombre: 'K18',               categoria: 'Reconstrucción', precio: 60, duracion: 60 },
    { nombre: 'Aplicación K18',    categoria: 'Reconstrucción', precio: 35, duracion: 15 },
];

// ─── extractServiceFromText: el nombre corto gana por defecto ────────────────

test('"k18" a secas resuelve al SUELTO (60€/60min), no al complemento', () => {
    const svc = extractServiceFromText('k18', CATALOG);
    assert.ok(svc, 'debería resolver');
    assert.strictEqual(svc.nombre, 'K18');
    assert.strictEqual(svc.precio, 60);
    assert.strictEqual(svc.duracion, 60);
});

test('"quiero hacerme un k18" resuelve igual al SUELTO', () => {
    const svc = extractServiceFromText('quiero hacerme un k18', CATALOG);
    assert.ok(svc);
    assert.strictEqual(svc.nombre, 'K18');
});

test('nombrar el complemento con el nombre completo de catálogo sí resuelve a "Aplicación K18"', () => {
    // extractServiceFromText matchea por SUBSTRING contiguo del nombre de catálogo: el
    // nombre completo "aplicación k18" tiene que aparecer tal cual, sin palabras
    // intercaladas (ver el caso anterior, donde "de" en medio rompe el match y por eso
    // gana el nombre corto "K18" — es justo el comportamiento que documenta este archivo).
    const svc = extractServiceFromText('quiero la aplicación k18', CATALOG);
    assert.ok(svc);
    assert.strictEqual(svc.nombre, 'Aplicación K18');
    assert.strictEqual(svc.precio, 35);
    assert.strictEqual(svc.duracion, 15);
});

test('con una palabra intercalada ("de"), incluso pidiendo el complemento por su nombre, gana el SUELTO', () => {
    // Documenta el límite real del matcher: solo una frase que EXACTAMENTE encierre el
    // nombre de catálogo "aplicación k18" resuelve al complemento por texto libre. Esta
    // es la razón de fondo por la que la vía fiable para ofrecer el complemento es
    // resolveK18ComplementIfNeeded (contexto de sesión), no el texto de la clienta.
    const svc = extractServiceFromText('quiero la aplicación de k18', CATALOG);
    assert.ok(svc);
    assert.strictEqual(svc.nombre, 'K18');
});

// ─── resolveServiceDurationMin: exacto por nombre, sin caer al fallback conservador ──

test('resolveServiceDurationMin: "K18" → 60, "Aplicación K18" → 15', () => {
    assert.strictEqual(resolveServiceDurationMin('K18', CATALOG), 60);
    assert.strictEqual(resolveServiceDurationMin('Aplicación K18', CATALOG), 15);
});

// ─── resolveK18ComplementIfNeeded: la corrección de contexto de sesión ────────

test('con color ya seleccionado, "K18" se corrige a "Aplicación K18"', () => {
    assert.strictEqual(
        resolveK18ComplementIfNeeded('K18', 'Mechas Contouring', CATALOG),
        'Aplicación K18',
    );
});

test('funciona para las 5 categorías de decoloración, con y sin tildes', () => {
    const categorias = ['Mechas Balayage', 'Mechas Airtouch', 'Mechas Contouring', 'Mechas clásicas', 'Deco Total Blond'];
    for (const cat of categorias) {
        assert.strictEqual(resolveK18ComplementIfNeeded('K18', cat, CATALOG), 'Aplicación K18', `falló para ${cat}`);
    }
});

test('sin color asociado, "K18" se queda como está (suelto)', () => {
    assert.strictEqual(resolveK18ComplementIfNeeded('K18', null, CATALOG), 'K18');
    assert.strictEqual(resolveK18ComplementIfNeeded('K18', undefined, CATALOG), 'K18');
    assert.strictEqual(resolveK18ComplementIfNeeded('K18', 'Cortes', CATALOG), 'K18');
});

test('un servicio que no es K18 nunca se toca', () => {
    assert.strictEqual(resolveK18ComplementIfNeeded('Manicura', 'Mechas Contouring', CATALOG), 'Manicura');
    assert.strictEqual(resolveK18ComplementIfNeeded('Aplicación K18', 'Mechas Contouring', CATALOG), 'Aplicación K18');
});

test('si el catálogo no tiene "Aplicación K18" (org distinta o catálogo viejo), no revienta', () => {
    const catalogoSinComplemento = [{ nombre: 'K18', categoria: 'Reconstrucción', precio: 60, duracion: 60 }];
    assert.strictEqual(
        resolveK18ComplementIfNeeded('K18', 'Mechas Contouring', catalogoSinComplemento),
        'K18',
    );
});

// ─── Facturación: el complemento no es ambiguo y cobra su propio precio ──────

test('computeServiceBilling: "Mechas Contouring + Aplicación K18" cobra 195, no confunde con el suelto', () => {
    const { totalConIva, segments } = computeServiceBilling('Mechas Contouring + Aplicación K18', CATALOG);
    assert.strictEqual(segments.length, 2);
    assert.ok(segments.every(s => s.status === 'ok'));
    assert.strictEqual(totalConIva, 160 + 35);
});

test('computeServiceBilling: "K18" suelto sigue cobrando su propio precio (60), no el del complemento', () => {
    assert.strictEqual(computeServiceBilling('K18', CATALOG).totalConIva, 60);
});
