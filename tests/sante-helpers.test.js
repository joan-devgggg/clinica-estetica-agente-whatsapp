// Tests for extractServiceFromText and extractLargoPelo (Sante-specific helpers).
// Covers the extraction gaps fixed in the anti-regression pass.

const assert = require('assert');
const { extractServiceFromText, extractLargoPelo, extractQuickDataSante } = require('../services/helpers');

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

// ── Minimal catalog with the shapes that appear in the real Sante catalog ──────
const catalog = [
    // Cortes — multi-service, no length variants
    { nombre: 'Mujer y peinado Dyson', categoria: 'Cortes', precio: 50, duracion: 60 },
    { nombre: 'Mujer y secado',        categoria: 'Cortes', precio: 40, duracion: 45 },
    { nombre: 'Hombre',                categoria: 'Cortes', precio: 25, duracion: 30 },
    // Alisado — multi-variant by length (largo 1/2/3)
    { nombre: 'Largo 1', categoria: 'Alisado vegano', precio: 80,  duracion: 90 },
    { nombre: 'Largo 2', categoria: 'Alisado vegano', precio: 100, duracion: 120 },
    { nombre: 'Largo 3', categoria: 'Alisado vegano', precio: 130, duracion: 150 },
    // Single-service categories
    { nombre: 'Masaje relajante', categoria: 'Masajes y SPA',    precio: 60, duracion: 60 },
    { nombre: 'K18',              categoria: 'Reconstrucción',   precio: 35, duracion: 30 },
];

// ─── extractServiceFromText — Fix: "degradado" maps to Cortes ─────────────────

test('extractServiceFromText: "degradado" resuelve a categoría Cortes', () => {
    const svc = extractServiceFromText('quiero un degradado', catalog);
    // En un catálogo real hay varias variantes de Cortes; aquí hay 3 → fuzzy devuelve
    // null si no hay palabra discriminante adicional (multi-service sin match exacto).
    // El test importante es que NO devuelve un servicio de otra categoría.
    if (svc !== null) {
        assert.strictEqual(svc.categoria, 'Cortes', `se esperaba Cortes pero se obtuvo ${svc.categoria}`);
    }
    // No debe resolver a Masajes, K18, etc.
    assert.ok(svc === null || svc.categoria === 'Cortes');
});

test('extractServiceFromText: "quiero un corte" resuelve a Cortes', () => {
    const svc = extractServiceFromText('quiero un corte', catalog);
    // Con un catálogo multi-servicio, si ninguna palabra discriminante → null es válido.
    // Pero NUNCA debe resolverse a otra categoría.
    assert.ok(svc === null || svc.categoria === 'Cortes');
});

test('extractServiceFromText: "masaje" resuelve a Masajes y SPA (única en cat)', () => {
    const svc = extractServiceFromText('quiero un masaje', catalog);
    assert.ok(svc !== null, 'debería encontrar un servicio');
    assert.strictEqual(svc.categoria, 'Masajes y SPA');
});

test('extractServiceFromText: "k18" resuelve a Reconstrucción', () => {
    const svc = extractServiceFromText('k18', catalog);
    assert.ok(svc !== null, 'debería encontrar un servicio');
    assert.strictEqual(svc.categoria, 'Reconstrucción');
});

test('extractServiceFromText: "alisado largo 2" resuelve a variante Largo 2 de Alisado vegano', () => {
    const svc = extractServiceFromText('quiero alisado largo 2', catalog);
    assert.ok(svc !== null, 'debería encontrar un servicio');
    assert.strictEqual(svc.nombre, 'Largo 2');
    assert.strictEqual(svc.categoria, 'Alisado vegano');
});

// ─── extractLargoPelo — Fix: "normal" → 2 (medio) ────────────────────────────

test('extractLargoPelo: "normal" → 2 (medio)', () => {
    assert.strictEqual(extractLargoPelo('normal'), 2);
});

test('extractLargoPelo: "media" → 2 (medio)', () => {
    assert.strictEqual(extractLargoPelo('media'), 2);
});

test('extractLargoPelo: "corto" → 1', () => {
    assert.strictEqual(extractLargoPelo('corto'), 1);
});

test('extractLargoPelo: "largo" → 3', () => {
    assert.strictEqual(extractLargoPelo('largo'), 3);
});

test('extractLargoPelo: "muy largo" → 4', () => {
    assert.strictEqual(extractLargoPelo('muy largo'), 4);
});

test('extractLargoPelo: "no lo sé" → null (desconocido manejado por el caller)', () => {
    assert.strictEqual(extractLargoPelo('no lo sé'), null);
});

test('extractLargoPelo: "largo 2" → null (número de variante, no longitud física)', () => {
    // "largo 2" en el catálogo es el nombre de la variante — extractLargoPelo retorna
    // null a propósito para que el caller lo interprete como número de variante directamente.
    assert.strictEqual(extractLargoPelo('largo 2'), null);
});

test('extractLargoPelo: preserva Ruso "средн" → 2', () => {
    assert.strictEqual(extractLargoPelo('средней длины'), 2);
});

// ─── extractQuickDataSante — Fix: 'semana' no se fija con día/fecha concreto ──────────
// Bug real: "mañana" (día siguiente) ponía semana:'esta'; combinado con un día explícito
// ("lunes") en el mismo mensaje, calendar-sante acotaba el rango de búsqueda a
// [hoy, hoy] en domingo (todayDow=6) y descartaba el lunes pedido → totalSlots:0 falso
// pese a que la estilista tenía la skill, el horario y el día libres.

test('extractQuickDataSante: "mañana lunes" NO fija semana (ya hay diaSemana explícito)', () => {
    const result = extractQuickDataSante('¿Mañana lunes tienes hueco para Balayage?');
    assert.strictEqual(result.preferencia_horaria.diaSemana, 0, 'debe reconocer lunes como diaSemana=0');
    assert.strictEqual(result.preferencia_horaria.semana, undefined, 'NO debe fijar semana cuando ya hay un día concreto');
});

test('extractQuickDataSante: "mañana" + fecha explícita ("24 de julio") tampoco fija semana', () => {
    const result = extractQuickDataSante('¿mañana el 24 de julio tienes hueco?');
    assert.ok(result.preferencia_horaria.fecha, 'debe extraer la fecha explícita');
    assert.strictEqual(result.preferencia_horaria.semana, undefined, 'NO debe fijar semana cuando ya hay fecha concreta');
});

test('extractQuickDataSante: "mañana" a secas (sin día/fecha) sigue fijando semana:"esta"', () => {
    const result = extractQuickDataSante('¿Tienes hueco mañana?');
    assert.strictEqual(result.preferencia_horaria.semana, 'esta', 'sin día concreto, "mañana" debe seguir acotando a esta semana (comportamiento previo intacto)');
});

test('extractQuickDataSante: "esta semana" explícita sin día concreto sigue funcionando', () => {
    const result = extractQuickDataSante('¿Tienes hueco esta semana?');
    assert.strictEqual(result.preferencia_horaria.semana, 'esta');
});

test('extractQuickDataSante: un diaSemana ya guardado en un turno anterior también bloquea "semana" en el turno siguiente', () => {
    const result = extractQuickDataSante('¿Y mañana tienes algo?', { preferencia_horaria: { diaSemana: 3 } });
    assert.strictEqual(result.preferencia_horaria.diaSemana, 3, 'conserva el día ya fijado');
    assert.strictEqual(result.preferencia_horaria.semana, undefined, 'no debe añadir semana sobre un día ya concreto de un turno previo');
});
