const assert = require('assert');
const { _internals } = require('../bot');
const { assignStylistIfAppropriate, stylistCanDoService } = _internals;
const { extractStylistFromText } = require('../services/helpers');

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

// Estilistas elegibles para un corte (Cortes): las 3 que hacen el servicio.
const CORTE = [
    { id: 'irina',    name: 'Irina' },
    { id: 'veronika', name: 'Veronika' },
    { id: 'yulia',    name: 'Yulia' },
];
// Mechas/balayage: dos coloristas elegibles.
const MECHAS = [
    { id: 'veronika', name: 'Veronika' },
    { id: 'yulia',    name: 'Yulia' },
];

// ─── El bug reproducido: "el más cercano" con varias elegibles ────────────────
// Con anyStylists activo NUNCA se debe fijar una estilista concreta: la función
// deja selectedStylist null para que loadAvailableSlots busque combinado.

test('CORTES: varias elegibles + anyStylists → NO fija estilista (deja null)', () => {
    const session = { selectedStylist: null, anyStylists: true, prefiereMasCercano: true };
    assignStylistIfAppropriate(session, CORTE);
    assert.strictEqual(session.selectedStylist, null,
        'No debe autoasignar Irina cuando la clienta pidió el más cercano');
});

test('CORTES: preferredStylistId presente NO fuerza estilista con varias elegibles', () => {
    // Clienta recurrente cuya habitual es Irina, pero pidió "el más cercano".
    const session = {
        selectedStylist: null, anyStylists: true, prefiereMasCercano: true,
        preferredStylistId: 'irina',
    };
    assignStylistIfAppropriate(session, CORTE);
    assert.strictEqual(session.selectedStylist, null,
        'La habitual no debe colarse cuando hay varias elegibles y pidió el más cercano');
});

test('MECHAS: varias elegibles + anyStylists → NO fija estilista (deja null)', () => {
    const session = { selectedStylist: null, anyStylists: true, prefiereMasCercano: true };
    assignStylistIfAppropriate(session, MECHAS);
    assert.strictEqual(session.selectedStylist, null);
});

// ─── Varias elegibles sin preferencia declarada → tampoco se fija (se preguntará) ─
test('varias elegibles sin anyStylists → null (se preguntará preferencia)', () => {
    const session = { selectedStylist: null, anyStylists: false, prefiereMasCercano: false };
    assignStylistIfAppropriate(session, CORTE);
    assert.strictEqual(session.selectedStylist, null,
        'Con varias elegibles nunca se autoasigna una arbitraria');
});

// ─── Una sola elegible → se asigna directamente (ahorra un turno) ─────────────
test('una sola elegible → se asigna directamente', () => {
    const session = { selectedStylist: null, anyStylists: false, prefiereMasCercano: false };
    assignStylistIfAppropriate(session, [{ id: 'larisa', name: 'Larisa' }]);
    assert.deepStrictEqual(session.selectedStylist, { id: 'larisa', nombre: 'Larisa' });
});

test('una sola elegible se asigna aunque anyStylists (no hay elección real que respetar)', () => {
    const session = { selectedStylist: null, anyStylists: true, prefiereMasCercano: true };
    assignStylistIfAppropriate(session, [{ id: 'larisa', name: 'Larisa' }]);
    assert.deepStrictEqual(session.selectedStylist, { id: 'larisa', nombre: 'Larisa' });
});

// ─── Preferencia explícita ya elegida y sigue elegible → se conserva ─────────
test('estilista ya elegida y elegible → se conserva', () => {
    const session = { selectedStylist: { id: 'veronika', nombre: 'Veronika' }, anyStylists: false };
    assignStylistIfAppropriate(session, CORTE);
    assert.deepStrictEqual(session.selectedStylist, { id: 'veronika', nombre: 'Veronika' });
});

// ─── Estilista que dejó de ser elegible (cambió el servicio) → se limpia ─────
test('estilista ya NO elegible (cambió el servicio) → se limpia a null', () => {
    // Larisa (masajes) fue elegida antes; ahora el servicio es corte → no es elegible.
    const session = { selectedStylist: { id: 'larisa', nombre: 'Larisa' }, anyStylists: false };
    assignStylistIfAppropriate(session, CORTE);
    assert.strictEqual(session.selectedStylist, null);
});

test('estilista ya no elegible pero queda una sola alternativa → reasigna a esa', () => {
    const session = { selectedStylist: { id: 'larisa', nombre: 'Larisa' }, anyStylists: false };
    assignStylistIfAppropriate(session, [{ id: 'olgha', name: 'Olgha' }]);
    assert.deepStrictEqual(session.selectedStylist, { id: 'olgha', nombre: 'Olgha' });
});

// ─── Robustez ────────────────────────────────────────────────────────────────
test('lista de elegibles vacía → null (no revienta)', () => {
    const session = { selectedStylist: null, anyStylists: false };
    assignStylistIfAppropriate(session, []);
    assert.strictEqual(session.selectedStylist, null);
});

// ─── Roster: distinción de nombre Yulia vs Yulia-Tricóloga (extractStylistFromText) ───
// Guarda el orden por longitud de nombre: un nombre compuesto no debe confundirse por
// inclusión de substring con el nombre corto que lo prefija.
const YULIA = { id: 'yulia', name: 'Yulia' };
const YULIA_TRI = { id: 'yulia-tri', name: 'Yulia-Tricóloga' };
const TEAM_YULIAS = [YULIA, YULIA_TRI];

test('nombre: "con yulia" → la Yulia de pelo (no la tricóloga)', () => {
    assert.strictEqual(extractStylistFromText('quiero con yulia', TEAM_YULIAS)?.id, 'yulia');
});
test('nombre: "yulia tricologa" (sin acento/guion) → Yulia-Tricóloga', () => {
    assert.strictEqual(extractStylistFromText('me atiende yulia tricologa', TEAM_YULIAS)?.id, 'yulia-tri');
});
test('nombre: "con yulia-tricóloga" → Yulia-Tricóloga', () => {
    assert.strictEqual(extractStylistFromText('con yulia-tricóloga porfa', TEAM_YULIAS)?.id, 'yulia-tri');
});

// ─── Roster: filtro por skill (stylistCanDoService) ───────────────────────────
const TETIANA = { id: 'tetiana', name: 'Tetiana', skills: ['Extensiones de cabello'] };
const NATALIA = { id: 'natalia', name: 'Natalia', skills: ['Cortes', 'Mechas Balayage', 'Color Premium'] };
const YULIA_TRI_SK = { id: 'yulia-tri', name: 'Yulia-Tricóloga', skills: ['Dermapen Hair Loss', 'Diagnóstico Capilar'] };

test('skill: Tetiana (solo extensiones) NO puede hacer Cortes ni pelo general', () => {
    assert.ok(!stylistCanDoService(TETIANA, { categoria: 'Cortes' }));
    assert.ok(!stylistCanDoService(TETIANA, { categoria: 'Mechas Balayage' }));
});
test('skill: Yulia-Tricóloga NO hace Cortes pero SÍ Diagnóstico Capilar', () => {
    assert.ok(!stylistCanDoService(YULIA_TRI_SK, { categoria: 'Cortes' }));
    assert.ok(stylistCanDoService(YULIA_TRI_SK, { categoria: 'Diagnóstico Capilar' }));
});
test('skill: Natalia hace Mechas Balayage y Cortes', () => {
    assert.ok(stylistCanDoService(NATALIA, { categoria: 'Mechas Balayage' }));
    assert.ok(stylistCanDoService(NATALIA, { categoria: 'Cortes' }));
});

// bot.js deja un setInterval (GC) que mantiene vivo el event loop: forzamos la salida.
process.exit(process.exitCode || 0);
