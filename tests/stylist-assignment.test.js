const assert = require('assert');
const { _internals } = require('../bot');
const { assignStylistIfAppropriate } = _internals;

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

// bot.js deja un setInterval (GC) que mantiene vivo el event loop: forzamos la salida.
process.exit(process.exitCode || 0);
