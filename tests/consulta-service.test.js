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
const CATALOG = [
    { categoria: 'Cortes', nombre: 'Corte mujer', precio: 35, duracion: 60 },
    { categoria: 'Consulta', nombre: 'Consulta', precio: null, duracion: 300 },
];
const CONSULTA = CATALOG.find(s => s.categoria === 'Consulta');

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
test('4 · buildSanteConfirmationMessage (ES): 20 min, sin precio numérico, con nota', () => {
    const msg = buildSanteConfirmationMessage({
        nombre: 'María', fecha: '2026-07-14', hora: '10:00',
        servicio: 'Consulta', stylistNombre: 'Veronika',
        precio: null, duracion: 300, categoria: 'Consulta', language: 'es',
    });
    assert.ok(msg.includes('20'), 'muestra 20 min');
    assert.ok(/se confirma en el sal[oó]n/i.test(msg), 'precio a confirmar en el salón');
    assert.ok(msg.includes('tiempo reservado'), 'incluye la nota de tiempo reservado');
    assert.ok(!msg.includes('300'), 'NO muestra 300');
    assert.ok(!/5\s*horas/i.test(msg), 'NO dice 5 horas');
    assert.ok(!msg.includes('€'), 'NO muestra símbolo de euro');
});

test('4 · buildSanteConfirmationMessage (EN): i18n consulta', () => {
    const msg = buildSanteConfirmationMessage({
        nombre: 'Anna', fecha: '2026-07-14', hora: '10:00',
        servicio: 'Consulta', stylistNombre: 'Natalia',
        precio: null, duracion: 300, categoria: 'Consulta', language: 'en',
    });
    assert.ok(msg.includes('20'), 'shows 20 min');
    assert.ok(/confirmed at the salon/i.test(msg), 'price confirmed at salon');
    assert.ok(!msg.includes('€') && !msg.includes('300'), 'no euro, no 300');
});

if (!process.exitCode) console.log('\nTodos los tests de Consulta OK');
process.exit(process.exitCode || 0);
