// Cobertura offline del servicio "Consulta" (valoración) de Sante — DETERMINISTA, sin WhatsApp/LLM.
// 1) detección reactiva de intención, 2) resolución de categoría + skill matching,
// 3) asignación de estilista, 4) mensaje de confirmación transparente (20 min, sin precio).
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
    detectConsultaValoracion, extractServiceFromText, buildSanteConfirmationMessage,
} = require('../services/helpers');
const { stylistCanDoService, assignStylistIfAppropriate } = require('../bot')._internals;

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// Catálogo mínimo con la entrada Consulta (igual forma que agent_configs.services).
// Incluye la consulta tricológica porque las dos COLISIONAN por nombre: ver bloque 2-bis.
const CATALOG = [
    { categoria: 'Cortes', nombre: 'Corte mujer', precio: 35, duracion: 60 },
    { categoria: 'Consulta', nombre: 'Consulta', precio: null, duracion: 60 },
    { categoria: 'Diagnóstico Capilar', nombre: 'Consulta tricológica con Yulia', precio: 85, duracion: 60 },
];
const CONSULTA = CATALOG.find(s => s.categoria === 'Consulta');
const TRICO = CATALOG.find(s => s.categoria === 'Diagnóstico Capilar');

// Estilistas: las 4 de pelo general tienen la skill "Consulta"; las demás no.
const VERONIKA = { id: '0101', name: 'Veronika', skills: ['Cortes', 'Consulta'] };
const NATALIA  = { id: '0107', name: 'Natalia', skills: ['Cortes', 'Consulta'] };
const OLGHA    = { id: '0104', name: 'Olgha', skills: ['Manicura/Pedicura'] };
const YULIA_T  = { id: '0108', name: 'Yulia-Tricóloga', skills: ['Diagnóstico Capilar', 'Dermapen Hair Loss'] };
const TETIANA  = { id: '0106', name: 'Tetiana', skills: ['Extensiones de cabello'] };

// ─── 1: detección reactiva ────────────────────────────────────────────────────────────
test('1 · detectConsultaValoracion: positivos (pide asesoramiento)', () => {
    assert.ok(detectConsultaValoracion('no sé qué hacerme, ¿me asesoráis?'));
    assert.ok(detectConsultaValoracion('quiero que me recomienden algo'));
    assert.ok(detectConsultaValoracion('no sé qué necesito, ¿podéis verlo en persona?'));
    assert.ok(detectConsultaValoracion('quiero una consulta'));
    assert.ok(detectConsultaValoracion('no sé qué me queda mejor'));
    assert.ok(detectConsultaValoracion("i don't know what to do with my hair, can you recommend something"));
});

test('1 · detectConsultaValoracion: negativos (servicio concreto / duda de largo)', () => {
    assert.ok(!detectConsultaValoracion('quiero un corte de puntas'));
    assert.ok(!detectConsultaValoracion('no sé si prefiero corto o largo'));
    assert.ok(!detectConsultaValoracion('balayage largo 2'));
    assert.ok(!detectConsultaValoracion('quiero manicura'));
    assert.ok(!detectConsultaValoracion('me recomendó este sitio una amiga'));
    assert.ok(!detectConsultaValoracion(''));
});

// ─── 2: resolución de categoría + skill matching ──────────────────────────────────────
test('2 · el catálogo resuelve la categoría Consulta', () => {
    assert.ok(CONSULTA, 'la entrada Consulta existe');
    const resolved = extractServiceFromText('Consulta', CATALOG);
    assert.ok(resolved && resolved.categoria === 'Consulta', 'extractServiceFromText resuelve a Consulta');
});

test('2 · stylistCanDoService: las 4 de pelo general sí, las demás no', () => {
    assert.ok(stylistCanDoService(VERONIKA, CONSULTA));
    assert.ok(stylistCanDoService(NATALIA, CONSULTA));
    assert.ok(!stylistCanDoService(OLGHA, CONSULTA));
    assert.ok(!stylistCanDoService(YULIA_T, CONSULTA));
    assert.ok(!stylistCanDoService(TETIANA, CONSULTA));
});

// ─── 2-bis: la colisión "Consulta" ⊂ "Consulta tricológica con Yulia" ─────────────────
// Incidente 34624184532 (02/08/2026). La pasada 1a de extractServiceFromText es
// `t.includes(svcName)` puro, y "consulta" es substring de casi cualquier forma de pedir la
// tricológica. Las pasadas que sí distinguen (1b y el fuzzy por CATEGORY_KEYWORDS, que mapea
// tricolog/diagnostico/capilar → Diagnóstico Capilar) sólo corren `if (!bestMatch)`, así que
// nunca se alcanzaban: se reservaba la Consulta de valoración sin precio en vez de los 85€,
// Y el filtro de skills pasaba a ser la categoría "Consulta", que excluye a la tricóloga.
// OJO: desde 029_consulta_60min.sql las dos duran 60 min, así que la DURACIÓN ya no las
// distingue — el discriminador que importa es el precio (85€ vs null) y la categoría, que es
// la que decide qué estilistas son elegibles.
test('2-bis · pedir la tricológica resuelve a la tricológica, no a la de valoración', () => {
    for (const frase of ['consulta tricologica', 'quiero una consulta tricológica',
        'quiero una consulta capilar', 'consulta por caída del pelo',
        'quiero la consulta tricologica con Yulia', 'diagnóstico capilar']) {
        const r = extractServiceFromText(frase, CATALOG);
        assert.ok(r, `"${frase}" debe resolver`);
        assert.strictEqual(r.categoria, 'Diagnóstico Capilar', `"${frase}"`);
        assert.strictEqual(r.precio, 85, `"${frase}" cobra 85€, no un precio a confirmar`);
    }
});

test('2-bis · la Consulta reactiva SIGUE resolviendo cuando no hay discriminador', () => {
    // La regla de especificidad sólo promueve el nombre largo si la clienta ha dicho la
    // parte que los distingue. Sin ella, gana el corto (comportamiento de siempre).
    for (const frase of ['consulta', 'quiero una consulta', 'necesito una consulta']) {
        const r = extractServiceFromText(frase, CATALOG);
        assert.ok(r && r.categoria === 'Consulta', `"${frase}" → Consulta reactiva`);
        assert.strictEqual(r.precio, null, 'la reactiva no tiene precio fijo');
    }
});

test('2-bis · "una consulta con Yulia" NO basta para cobrar 85€', () => {
    // Hay DOS Yulia en el equipo (colorista y tricóloga): el nombre de pila no es
    // discriminador suficiente. Conservador a propósito.
    const r = extractServiceFromText('me gustaría una consulta con Yulia', CATALOG);
    assert.ok(r && r.categoria === 'Consulta', 'se queda en la reactiva');
});

test('2-bis · con la tricológica seleccionada, Yulia-Tricóloga SÍ puede hacerla', () => {
    // El efecto en cadena del bug: con categoría "Consulta" la especialista quedaba fuera
    // y el bot ofrecía a Veronika/Natalia para un diagnóstico capilar.
    assert.ok(stylistCanDoService(YULIA_T, TRICO), 'la tricóloga puede con su propio servicio');
    assert.ok(!stylistCanDoService(NATALIA, TRICO), 'una colorista sin la skill, no');
});

// ─── 3: asignación de estilista ───────────────────────────────────────────────────────
test('3 · assignStylistIfAppropriate: varias elegibles → null; una sola → asignada', () => {
    const varias = { selectedService: CONSULTA, selectedStylist: null, anyStylists: false, prefiereMasCercano: false };
    assignStylistIfAppropriate(varias, [VERONIKA, NATALIA]);
    assert.strictEqual(varias.selectedStylist, null, 'varias → deja null (pregunta / más cercano)');

    const una = { selectedService: CONSULTA, selectedStylist: null, anyStylists: false, prefiereMasCercano: false };
    assignStylistIfAppropriate(una, [VERONIKA]);
    assert.ok(una.selectedStylist && una.selectedStylist.id === VERONIKA.id, 'una sola → asignada');
});

// ─── 4: confirmación transparente ─────────────────────────────────────────────────────
// La duración VISIBLE sigue siendo 20 min y el precio sigue sin darse: eso no lo cambia
// 029_consulta_60min.sql. Lo que SÍ desaparece es la promesa "ya tendrás tiempo reservado a
// continuación sin esperar": era cierta con el bloque de 300 min (20 de consulta + la tarde
// por delante) y con 60 deja de serlo — quedan 40 min, que no dan para un color ni un
// balayage. Prometerlo generaba en el salón la expectativa que provoca la queja.
test('4 · buildSanteConfirmationMessage (ES): 20 min, sin precio numérico, SIN promesa de continuidad', () => {
    const msg = buildSanteConfirmationMessage({
        nombre: 'María', fecha: '2026-07-14', hora: '10:00',
        servicio: 'Consulta', stylistNombre: 'Veronika',
        precio: null, duracion: 60, categoria: 'Consulta', language: 'es',
    });
    assert.ok(msg.includes('20'), 'muestra 20 min');
    assert.ok(/se confirma en el sal[oó]n/i.test(msg), 'precio a confirmar en el salón');
    assert.ok(!/tiempo reservado/i.test(msg), 'NO promete tiempo reservado a continuación');
    assert.ok(!/sin esperar/i.test(msg), 'NO promete que no habrá espera');
    assert.ok(!msg.includes('60'), 'NO filtra la duración del bloque');
    assert.ok(!/5\s*horas/i.test(msg), 'NO dice 5 horas');
    assert.ok(!msg.includes('€'), 'NO muestra símbolo de euro');
});

test('4 · buildSanteConfirmationMessage (EN): i18n consulta', () => {
    const msg = buildSanteConfirmationMessage({
        nombre: 'Anna', fecha: '2026-07-14', hora: '10:00',
        servicio: 'Consulta', stylistNombre: 'Natalia',
        precio: null, duracion: 60, categoria: 'Consulta', language: 'en',
    });
    assert.ok(msg.includes('20'), 'shows 20 min');
    assert.ok(/confirmed at the salon/i.test(msg), 'price confirmed at salon');
    assert.ok(!/time reserved/i.test(msg), 'no promise of time reserved right after');
    assert.ok(!msg.includes('€') && !msg.includes('60'), 'no euro, no block duration');
});

// Las otras dos lenguas comparten la misma rama de código, pero la nota vivía duplicada en
// las cuatro tablas de i18n: si alguien restaura una, este test lo caza.
test('4 · RU y UK tampoco prometen continuidad', () => {
    for (const [language, nombre] of [['ru', 'Оксана'], ['uk', 'Оксана']]) {
        const msg = buildSanteConfirmationMessage({
            nombre, fecha: '2026-07-14', hora: '10:00',
            servicio: 'Consulta', stylistNombre: 'Yulia',
            precio: null, duracion: 60, categoria: 'Consulta', language,
        });
        assert.ok(msg.includes('20'), `${language}: muestra 20 min`);
        assert.ok(!/зарезервировано|зарезервовано/.test(msg), `${language}: sin promesa de continuidad`);
        assert.ok(!msg.includes('€') && !msg.includes('60'), `${language}: ni precio ni duración de bloque`);
    }
});

if (!process.exitCode) console.log('\nTodos los tests de Consulta OK');
process.exit(process.exitCode || 0);
