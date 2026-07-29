const assert = require('assert');
const { _internals } = require('../bot');
const { assignStylistIfAppropriate, stylistCanDoService, applyStylistMention } = _internals;
const { extractStylistFromText, resolveStylistMention } = require('../services/helpers');

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

// ─── Veredicto de mención de estilista (resolveStylistMention) ────────────────
// El matching era un String.includes() puro: "Iryna" o "Carmen" devolvían null y los
// call sites de bot.js los descartaban en silencio. Ahora se distingue acierto,
// casi-acierto, nombre inexistente y "no nombró a nadie".
const ROSTER = ['Veronika', 'Irina', 'Yulia', 'Yulia-Tricóloga', 'Olgha', 'Larisa', 'Tetiana', 'Natalia']
    .map((name, i) => ({ id: `s${i}`, name }));
const CATALOGO = [
    { nombre: 'Mujer y secado', categoria: 'Cortes', precio: 35, duracion: 60 },
    { nombre: 'Largo 2', categoria: 'Mechas Balayage', precio: 150, duracion: 180 },
    { nombre: 'Manicura + gel', categoria: 'Manicura/Pedicura', precio: 30, duracion: 60 },
    { nombre: 'Aromaterapia relax', categoria: 'Masajes y SPA', precio: 60, duracion: 60 },
];
const verdict = (txt, opts) => resolveStylistMention(txt, ROSTER, { servicesCatalog: CATALOGO, ...opts });

test('veredicto exacto: nombre bien escrito → exact, sin corrección', () => {
    // "Irinaa" entra por aquí y no por fuzzy: "irina" es substring literal de "irinaa".
    // El resultado es el mismo (Irina), así que no hay nada que corregirle a la clienta.
    for (const txt of ['quiero con Irina', 'con IRINA por favor', 'con veronika', 'con Irina 😊', 'con Irinaa']) {
        const v = verdict(txt);
        assert.strictEqual(v.status, 'exact', `"${txt}" debería ser exact, fue ${v.status}`);
    }
    assert.strictEqual(verdict('quiero con Irina').stylist.name, 'Irina');
});

test('veredicto exacto: nombre compuesto por token-set ("la tricologa Yulia")', () => {
    assert.strictEqual(verdict('con la tricologa Yulia').stylist.name, 'Yulia-Tricóloga');
});

test('veredicto fuzzy: las erratas reales de la tabla A1 se corrigen', () => {
    const casos = [
        ['con Iryna', 'Irina'], ['con Olga', 'Olgha'], ['quiero con Veronica', 'Veronika'],
        ['con Verónica', 'Veronika'], ['con Julia', 'Yulia'], ['con Tatiana', 'Tetiana'],
        ['con Larissa', 'Larisa'], ['con Nataly', 'Natalia'],
    ];
    for (const [txt, esperado] of casos) {
        const v = verdict(txt);
        assert.strictEqual(v.status, 'fuzzy', `"${txt}" debería ser fuzzy, fue ${v.status}`);
        assert.strictEqual(v.stylist.name, esperado, `"${txt}" → ${v.stylist?.name}, esperado ${esperado}`);
        assert.strictEqual(v.sugerencia, esperado);
    }
});

test('veredicto fuzzy: hipocorístico por prefijo ("Vero" → Veronika)', () => {
    const v = verdict('con Vero');
    assert.strictEqual(v.status, 'fuzzy');
    assert.strictEqual(v.stylist.name, 'Veronika');
});

test('veredicto unknown: nombre inexistente conserva la mención para poder citarla', () => {
    const v = verdict('con Carmen');
    assert.strictEqual(v.status, 'unknown');
    assert.strictEqual(v.stylist, null);
    assert.strictEqual(v.mencion, 'Carmen');
});

test('veredicto unknown: respuesta escueta a la pregunta de estilista ("Carmen")', () => {
    assert.strictEqual(verdict('Carmen', { expectingStylist: true }).status, 'unknown');
    // Sin la pregunta abierta y sin marcador, un nombre suelto no se interpreta.
    assert.strictEqual(verdict('Carmen').status, 'none');
});

// ─── Falsos positivos: lo que NUNCA debe anunciarse como estilista inexistente ──
// Un falso "no tengo a ninguna Mechas" es peor que el silencio que venimos a arreglar.
test('none: servicios y fechas tras "con/para" no son nombres de persona', () => {
    for (const txt of ['quiero un corte de mujer', 'para el martes', 'una manicura',
        'con mechas balayage', 'para mañana por la tarde', 'con gel', 'con prisa',
        'lo antes posible', 'me da igual', 'con descuento']) {
        assert.strictEqual(verdict(txt).status, 'none', `"${txt}" no debe producir mención`);
    }
});

test('none: la clienta nombrándose a sí misma no es una estilista', () => {
    assert.strictEqual(verdict('la cita es para Carmen', { excludeNames: ['Carmen'] }).status, 'none');
});

test('none: "para mi amiga Carmen" es un acompañante, no una petición de estilista', () => {
    assert.strictEqual(verdict('la cita es para mi amiga Carmen', { guestBooking: true }).status, 'none');
});

test('empate entre personas distintas → none (no adivina)', () => {
    // "Marina" está a distancia 1 de Marisa y de Marino: dos personas distintas.
    const ambiguo = [{ id: 'a', name: 'Marisa' }, { id: 'b', name: 'Marino' }];
    const v = resolveStylistMention('con Marina', ambiguo, { servicesCatalog: CATALOGO });
    assert.notStrictEqual(v.status, 'fuzzy', 'no debe elegir una de dos candidatas equidistantes');
});

test('empate Yulia / Yulia-Tricóloga se resuelve al nombre simple', () => {
    // Comparten nombre de pila: no es ambigüedad real, gana el simple.
    assert.strictEqual(verdict('con Yulya').stylist.name, 'Yulia');
});

test('assumePersonName: el campo del LLM no necesita marcador ("con/para")', () => {
    assert.strictEqual(verdict('Carmen', { assumePersonName: true }).status, 'unknown');
    assert.strictEqual(verdict('Irina', { assumePersonName: true }).status, 'exact');
    // Pero si el LLM mete basura que es un servicio, no se anuncia como estilista.
    assert.strictEqual(verdict('manicura', { assumePersonName: true }).status, 'none');
});

test('roster vacío o texto vacío → none (no revienta)', () => {
    assert.strictEqual(resolveStylistMention('con Irina', []).status, 'none');
    assert.strictEqual(resolveStylistMention('', ROSTER).status, 'none');
    assert.strictEqual(resolveStylistMention(null, ROSTER).status, 'none');
});

// ─── applyStylistMention: veredicto → estado de sesión ────────────────────────
const nuevaSesion = (extra = {}) => ({
    selectedService: { nombre: 'Mujer y secado', categoria: 'Cortes' },
    selectedStylist: null, availableSlots: [], currentSlotIndex: 0,
    anyStylists: false, prefiereMasCercano: false,
    stylistMentionUnknown: null, stylistMentionCorrected: null,
    stylistMentionNoSkill: null, stylistMentionRejected: null,
    partialData: {}, ...extra,
});
const SKILLED = [
    { id: 'irina', name: 'Irina', skills: ['Cortes'] },
    { id: 'larisa', name: 'Larisa', skills: ['Masajes y SPA'] },
];

test('applyStylistMention: exact elegible → fija la estilista, sin avisos', () => {
    const s = nuevaSesion();
    applyStylistMention(s, resolveStylistMention('con Irina', SKILLED));
    assert.strictEqual(s.selectedStylist.nombre, 'Irina');
    assert.strictEqual(s.stylistMentionCorrected, null);
    assert.strictEqual(s.stylistMentionUnknown, null);
});

test('applyStylistMention: fuzzy → fija la estilista Y deja el aviso de corrección', () => {
    const s = nuevaSesion();
    applyStylistMention(s, resolveStylistMention('con Iryna', SKILLED));
    assert.strictEqual(s.selectedStylist.nombre, 'Irina');
    assert.deepStrictEqual(s.stylistMentionCorrected, { mencion: 'iryna', nombre: 'Irina' });
});

test('applyStylistMention: unknown → NO fija nada y deja la mención para avisar', () => {
    const s = nuevaSesion();
    applyStylistMention(s, resolveStylistMention('con Carmen', SKILLED));
    assert.strictEqual(s.selectedStylist, null);
    assert.strictEqual(s.stylistMentionUnknown, 'Carmen');
});

test('applyStylistMention: unknown ya avisada no se repite', () => {
    const s = nuevaSesion({ stylistMentionRejected: 'carmen' });
    applyStylistMention(s, resolveStylistMention('con Carmen', SKILLED));
    assert.strictEqual(s.stylistMentionUnknown, null, 'no debe reabrir el aviso cada turno');
});

test('applyStylistMention: estilista real sin la skill → no la fija, pero lo explica', () => {
    const s = nuevaSesion();
    applyStylistMention(s, resolveStylistMention('con Larisa', SKILLED));
    assert.strictEqual(s.selectedStylist, null, 'Larisa no hace Cortes');
    assert.strictEqual(s.stylistMentionNoSkill.nombre, 'Larisa');
});

test('applyStylistMention: cambio de estilista invalida los huecos de la anterior', () => {
    const s = nuevaSesion({
        selectedStylist: { id: 'otra', nombre: 'Veronika' },
        availableSlots: [{ texto: 'jueves 11:00' }], currentSlotIndex: 2,
    });
    applyStylistMention(s, resolveStylistMention('con Irina', SKILLED));
    assert.strictEqual(s.selectedStylist.nombre, 'Irina');
    assert.deepStrictEqual(s.availableSlots, [], 'los huecos de Veronika no valen para Irina');
    assert.strictEqual(s.currentSlotIndex, 0);
});

test('applyStylistMention: preferencia explícita anula "el más cercano"', () => {
    const s = nuevaSesion({ prefiereMasCercano: true, anyStylists: true });
    applyStylistMention(s, resolveStylistMention('con Irina', SKILLED));
    assert.strictEqual(s.prefiereMasCercano, false);
    assert.strictEqual(s.anyStylists, false);
});

test('applyStylistMention: none no toca nada', () => {
    const s = nuevaSesion();
    applyStylistMention(s, resolveStylistMention('quiero un corte', SKILLED));
    assert.strictEqual(s.selectedStylist, null);
    assert.strictEqual(s.stylistMentionUnknown, null);
    assert.strictEqual(s.stylistMentionNoSkill, null);
});

// bot.js deja un setInterval (GC) que mantiene vivo el event loop: forzamos la salida.
process.exit(process.exitCode || 0);
