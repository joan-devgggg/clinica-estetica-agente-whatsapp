// Tests for the hair-length PRESENTATION layer (humanizeLargoLabel).
// Yulia quiere que la clienta vea "cabello corto/medio/largo/muy largo" en vez de
// "Largo 1/2/3/4". Estos tests blindan que:
//   1. La traducción de presentación es correcta (3 y 4 variantes, upsell, minúscula).
//   2. Los servicios sin variante de largo NO se tocan (Contouring, clásicas, cortes).
//   3. El valor INTERNO/guardado (buildFullServiceName) NO cambia.
//   4. La clienta puede seguir escribiendo "Largo 2" directamente y se resuelve igual.
//   5. La desambiguación por categoría de nombres compartidos sigue intacta.

const assert = require('assert');
const {
    humanizeLargoLabel,
    buildFullServiceName,
    extractLargoPelo,
    extractServiceFromText,
    classifyLargoVariant,
    detectLargoCategory,
} = require('../services/helpers');

function test(name, fn) {
    try {
        fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

// ── Catálogo mínimo con las formas reales (003_sante.sql) ──────────────────────
const catalog = [
    // 4 variantes
    { nombre: 'Largo 1', categoria: 'Mechas Airtouch', precio: 195, duracion: 360 },
    { nombre: 'Largo 2', categoria: 'Mechas Airtouch', precio: 220, duracion: 360 },
    { nombre: 'Largo 3', categoria: 'Mechas Airtouch', precio: 235, duracion: 360 },
    { nombre: 'Largo 4', categoria: 'Mechas Airtouch', precio: 260, duracion: 360 },
    // 3 variantes (mismo nombre "Largo N" compartido → obliga a desambiguar por categoría)
    { nombre: 'Largo 1', categoria: 'Alisado vegano', precio: 210, duracion: 300 },
    { nombre: 'Largo 2', categoria: 'Alisado vegano', precio: 260, duracion: 300 },
    { nombre: 'Largo 3', categoria: 'Alisado vegano', precio: 310, duracion: 300 },
    // Color completo: la variante embebe "largo N" en minúscula en el propio nombre
    { nombre: 'Color completo largo 1', categoria: 'Color Premium', precio: 90,  duracion: 120 },
    { nombre: 'Color completo largo 2', categoria: 'Color Premium', precio: 100, duracion: 120 },
    { nombre: 'Color completo largo 3', categoria: 'Color Premium', precio: 110, duracion: 120 },
    // Mechas Balayage: catálogo real (bug reproducido en producción, 2026-07-12) —
    // NO sigue la convención "Largo N", usa nombres descriptivos directamente.
    { nombre: 'Cabello corto',        categoria: 'Mechas Balayage', precio: 170, duracion: 240 },
    { nombre: 'Cabello medio',        categoria: 'Mechas Balayage', precio: 170, duracion: 240 },
    { nombre: 'Cabello largo',        categoria: 'Mechas Balayage', precio: 190, duracion: 240 },
    { nombre: 'XL / cambio importante', categoria: 'Mechas Balayage', precio: 230, duracion: 300 },
    // Mechas clásicas: variantes numeradas pero NO son longitud de pelo (son tipo de
    // cobertura: delante/media cabeza/completa) — deben quedar excluidas del pipeline
    // de corrección de largo aunque classifyLargoVariant las clasifique por dígito.
    { nombre: 'Mechas 1',           categoria: 'Mechas clásicas',   precio: 70,  duracion: 150 },
    { nombre: 'Mechas 2',            categoria: 'Mechas clásicas',   precio: 80,  duracion: 180 },
    { nombre: 'Mechas 3',           categoria: 'Mechas clásicas',   precio: 95,  duracion: 210 },
    // Sin variante de largo → deben quedar intactos
    { nombre: 'Mechas Contouring', categoria: 'Mechas Contouring', precio: 160, duracion: 200 },
    { nombre: 'Hombre',            categoria: 'Cortes',            precio: 25,  duracion: 30 },
    { nombre: 'K18',               categoria: 'Reconstrucción',    precio: 35,  duracion: 30 },
];

// ─── humanizeLargoLabel: mapeo de las 4 variantes ────────────────────────────

test('humanizeLargoLabel: Largo 1 → cabello corto', () => {
    assert.strictEqual(humanizeLargoLabel('Mechas Airtouch Largo 1'), 'Mechas Airtouch (cabello corto)');
});

test('humanizeLargoLabel: Largo 2 → cabello medio', () => {
    assert.strictEqual(humanizeLargoLabel('Mechas Airtouch Largo 2'), 'Mechas Airtouch (cabello medio)');
});

test('humanizeLargoLabel: 3 variantes — Largo 3 → cabello largo', () => {
    assert.strictEqual(humanizeLargoLabel('Alisado vegano Largo 3'), 'Alisado vegano (cabello largo)');
});

test('humanizeLargoLabel: 4 variantes — Largo 4 → cabello muy largo', () => {
    assert.strictEqual(humanizeLargoLabel('Mechas Airtouch Largo 4'), 'Mechas Airtouch (cabello muy largo)');
});

test('humanizeLargoLabel: minúscula embebida (Color completo largo 2)', () => {
    assert.strictEqual(humanizeLargoLabel('Color completo largo 2'), 'Color completo (cabello medio)');
});

test('humanizeLargoLabel: combinado con upsell conserva el " + K18"', () => {
    assert.strictEqual(
        humanizeLargoLabel('Mechas Airtouch Largo 2 + K18'),
        'Mechas Airtouch (cabello medio) + K18'
    );
});

// ─── Servicios SIN variante de largo → intactos ──────────────────────────────

test('humanizeLargoLabel: Mechas Contouring intacto', () => {
    assert.strictEqual(humanizeLargoLabel('Mechas Contouring'), 'Mechas Contouring');
});

test('humanizeLargoLabel: Mechas clásicas "Mechas 2" intacto (no es "Largo N")', () => {
    assert.strictEqual(humanizeLargoLabel('Mechas 2'), 'Mechas 2');
});

test('humanizeLargoLabel: corte "Hombre" intacto', () => {
    assert.strictEqual(humanizeLargoLabel('Hombre'), 'Hombre');
});

test('humanizeLargoLabel: nulo/vacío devuelto tal cual', () => {
    assert.strictEqual(humanizeLargoLabel(''), '');
    assert.strictEqual(humanizeLargoLabel(null), null);
});

// ─── INVARIANTE: el valor guardado (buildFullServiceName) NO cambia ──────────

test('INVARIANTE: buildFullServiceName sigue produciendo "Mechas Airtouch Largo 2"', () => {
    const saved = buildFullServiceName({ nombre: 'Largo 2', categoria: 'Mechas Airtouch' }, catalog);
    assert.strictEqual(saved, 'Mechas Airtouch Largo 2');
});

test('INVARIANTE: buildFullServiceName 4ª variante → "Mechas Airtouch Largo 4"', () => {
    const saved = buildFullServiceName({ nombre: 'Largo 4', categoria: 'Mechas Airtouch' }, catalog);
    assert.strictEqual(saved, 'Mechas Airtouch Largo 4');
});

// ─── La clienta escribe "Largo 2" directamente → resuelve igual que antes ─────

test('extractLargoPelo("largo 2") === null (variante literal, no longitud física)', () => {
    assert.strictEqual(extractLargoPelo('largo 2'), null);
});

test('extractServiceFromText: "mechas airtouch largo 2" → Largo 2 / Mechas Airtouch', () => {
    const svc = extractServiceFromText('quiero mechas airtouch largo 2', catalog);
    assert.ok(svc, 'esperaba un match');
    assert.strictEqual(svc.nombre, 'Largo 2');
    assert.strictEqual(svc.categoria, 'Mechas Airtouch');
});

// ─── Desambiguación por categoría de nombres compartidos intacta ─────────────

test('extractServiceFromText: "alisado largo 3" → Alisado vegano (no Mechas Airtouch)', () => {
    const svc = extractServiceFromText('quiero alisado largo 3', catalog);
    assert.ok(svc, 'esperaba un match');
    assert.strictEqual(svc.nombre, 'Largo 3');
    assert.strictEqual(svc.categoria, 'Alisado vegano');
});

// ─── classifyLargoVariant: vía numérica intacta, vía keywords solo sin dígito ─

test('classifyLargoVariant: "Largo 3" (sufijo numérico) → 3, vía dígito', () => {
    assert.strictEqual(classifyLargoVariant('Largo 3'), 3);
});

test('classifyLargoVariant: "Color completo largo 1" (dígito embebido) → 1', () => {
    assert.strictEqual(classifyLargoVariant('Color completo largo 1'), 1);
});

test('classifyLargoVariant: "Mechas 2" (dígito, Mechas clásicas) → 2 — clasifica por dígito igual que cualquier otra; la exclusión semántica (tipo de cobertura, no longitud) vive en bot.js, no aquí', () => {
    assert.strictEqual(classifyLargoVariant('Mechas 2'), 2);
});

test('classifyLargoVariant: "Cabello corto" (sin dígito, Balayage) → 1 vía keyword', () => {
    assert.strictEqual(classifyLargoVariant('Cabello corto'), 1);
});

test('classifyLargoVariant: "Cabello medio" → 2 vía keyword', () => {
    assert.strictEqual(classifyLargoVariant('Cabello medio'), 2);
});

test('classifyLargoVariant: "Cabello largo" → 3 vía keyword', () => {
    assert.strictEqual(classifyLargoVariant('Cabello largo'), 3);
});

test('classifyLargoVariant: "XL / cambio importante" → 4 vía keyword', () => {
    assert.strictEqual(classifyLargoVariant('XL / cambio importante'), 4);
});

test('classifyLargoVariant: servicio sin variante de largo (K18) → null', () => {
    assert.strictEqual(classifyLargoVariant('K18'), null);
});

test('classifyLargoVariant: vacío/nulo → null', () => {
    assert.strictEqual(classifyLargoVariant(''), null);
    assert.strictEqual(classifyLargoVariant(null), null);
});

// ─── detectLargoCategory: ahora reconoce Balayage (nombres descriptivos) ──────
// Bug reproducido en producción (2026-07-12): "Mechas Balayage" quedaba fuera del
// pipeline determinista de largo porque sus 4 variantes no llevan sufijo numérico.

test('detectLargoCategory: "Quiero mechas balayage" → reconoce "Mechas Balayage"', () => {
    assert.strictEqual(detectLargoCategory('Quiero mechas balayage', catalog), 'Mechas Balayage');
});

test('detectLargoCategory: sigue reconociendo categorías por sufijo numérico (Mechas Airtouch)', () => {
    assert.strictEqual(detectLargoCategory('quiero mechas airtouch', catalog), 'Mechas Airtouch');
});

test('detectLargoCategory: "Mechas clásicas" NO es tratada como largo-categoría genérica (tiene su propio flujo de tipo de cobertura)', () => {
    // No debe reconocerse vía las mismas keywords genéricas de largo (alisado/airtouch/
    // balayage/etc.); su propia rama en bot.js la intercepta por nombre de categoría.
    assert.strictEqual(detectLargoCategory('quiero mechas clasicas', catalog), 'Mechas clásicas');
});

// ─── Regresión: el primer match de Balayage ya no depende de coincidencia literal ─
// (antes de este fix, "cabello largo" solo resolvía si el texto contenía LITERALMENTE
// el nombre completo del catálogo — "muy largo" nunca podía mapear a "XL / cambio
// importante" porque no comparten ninguna palabra).

test('extractServiceFromText: "cabello corto" → Cabello corto / Mechas Balayage (match literal, ya funcionaba)', () => {
    const svc = extractServiceFromText('me equivoqué, cabello corto', catalog);
    assert.ok(svc, 'esperaba un match');
    assert.strictEqual(svc.nombre, 'Cabello corto');
    assert.strictEqual(svc.categoria, 'Mechas Balayage');
});

process.exit(process.exitCode || 0);
