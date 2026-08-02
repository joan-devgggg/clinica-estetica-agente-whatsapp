// Regresión del incidente Valeria Rivera (01/08/2026, Sante).
//
// El bot preguntó: "¿Tienes estilista de confianza o prefieres que te busque el hueco más
// cercano disponible?" y la clienta contestó, a las 16:22:25: "No tengo estilista".
//
// Nadie reconocía esa respuesta. SIN_PREFERENCIA_RE cubre "no tengo preferencia" pero no
// "no tengo estilista", así que prefiereMasCercano se quedaba en false. (La conversación
// murió ahí por otra causa —alguien pausó el bot de toda la org—, pero este agujero era
// real y seguía abierto.)
//
// El arreglo NO amplía SIN_PREFERENCIA_RE: ese flag lo consume también
// extractDateSignalSante para emitir asapWeak, y "no tengo estilista" responde a QUIÉN, no
// a CUÁNDO. Va en un detector aparte, detectNoStylistPreference, que bot.js solo consulta
// cuando la pregunta de estilista está pendiente.
//
// Este test congela las dos mitades: que la respuesta se reconoce y arranca la búsqueda
// combinada, y que NO contamina la preferencia de fecha.

process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
    detectNoStylistPreference, detectNoPreferenceSignal,
    extractDateSignalSante, extractQuickDataSante,
} = require('../services/helpers');
const calendarSante = require('../services/calendar-sante');
const db = require('../services/db');
const { computeStylistGating } = require('../bot')._internals;

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (error) { console.error(`fail - ${name}`); console.error(error); process.exitCode = 1; }
}
async function testAsync(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (error) { console.error(`fail - ${name}`); console.error(error); process.exitCode = 1; }
}

async function withMockedNow(isoString, fn) {
    const RealDate = Date;
    class MockDate extends RealDate {
        constructor(...args) { if (args.length === 0) { super(isoString); return; } super(...args); }
        static now() { return new RealDate(isoString).getTime(); }
    }
    global.Date = MockDate;
    try { return await fn(); } finally { global.Date = RealDate; }
}

// ─── 1. La frase exacta del incidente se reconoce ─────────────────────────────

test('la frase LITERAL del incidente se reconoce', () => {
    assert.strictEqual(detectNoStylistPreference('No tengo estilista'), true);
});

test('variantes en español de "no tengo estilista de confianza"', () => {
    for (const txt of [
        'No tengo estilista',
        'no tengo estilista fija',
        'No tengo una estilista',
        'no tengo peluquera',
        'No tengo ninguna',
        'no tengo ninguno',
        'Ninguna en particular',
        'ninguno en concreto',
        'No tengo a nadie',
        'no conozco a nadie',
        'Es mi primera vez',
        'es la primera vez que voy',
        'nunca he venido',
        'Soy nueva',
    ]) assert.strictEqual(detectNoStylistPreference(txt), true, `debería reconocerse: "${txt}"`);
});

test('equivalentes EN / RU / UK', () => {
    for (const txt of [
        "I don't have a stylist", 'I dont have a hairdresser', 'no stylist',
        'first time', "I don't know anyone",
        'у меня нет мастера', 'без мастера', 'первый раз', 'никого не знаю',
        'немає майстра', 'без майстра', 'перший раз', 'вперше',
    ]) assert.strictEqual(detectNoStylistPreference(txt), true, `debería reconocerse: "${txt}"`);
});

test('no se dispara con respuestas que SÍ eligen o que hablan de otra cosa', () => {
    for (const txt of [
        'Irina',
        'Con Veronika porfa',
        'quiero mechas',
        'el jueves por la tarde',
        'no tengo tiempo esta semana',
        'no tengo coche',
        '¿cuánto cuesta?',
    ]) assert.strictEqual(detectNoStylistPreference(txt), false, `NO debería reconocerse: "${txt}"`);
});

// ─── 2. No contamina la señal de FECHA ────────────────────────────────────────
// Es la razón de que exista un detector aparte en vez de ampliar SIN_PREFERENCIA_RE.

test('"No tengo estilista" no es señal temporal: ni asap ni asapWeak', () => {
    assert.deepStrictEqual(detectNoPreferenceSignal('No tengo estilista'),
        { asapTemporal: false, sinPreferencia: false },
        'no debe colarse en el detector que alimenta la fecha');
    assert.deepStrictEqual(extractDateSignalSante('No tengo estilista'), {},
        'la señal de fecha de ese mensaje está VACÍA');
});

test('contestando a la pregunta de estilista, la fecha ya pedida sobrevive intacta', () => {
    let pd = extractQuickDataSante('El jueves', {});
    assert.strictEqual(pd.preferencia_horaria.diaSemana, 3, 'jueves = 3');
    pd = extractQuickDataSante('No tengo estilista', pd, [], [], { stylistQuestionPending: true });
    assert.deepStrictEqual(pd.preferencia_horaria, { diaSemana: 3 },
        'ni asap ni nada más: responde a QUIÉN, no a CUÁNDO');
});

test('sin haber pedido fecha, "No tengo estilista" no inventa ninguna', () => {
    const pd = extractQuickDataSante('No tengo estilista', {}, [], [], { stylistQuestionPending: true });
    assert.deepStrictEqual(pd.preferencia_horaria, undefined);
});

// ─── 3. El gating: la respuesta abre la búsqueda combinada ────────────────────

test('reconocida la respuesta, el gating deja de preguntar y busca en combinado', () => {
    const base = { selectedService: { nombre: 'Corte mujer' }, selectedStylist: null };
    // Turno 1: el bot pregunta por la estilista.
    assert.deepStrictEqual(
        computeStylistGating({ ...base, prefiereMasCercano: false, stylistQuestionAsked: false }, 4),
        { anyStylists: false, askStylistFirst: true }, 'turno 1: preguntar');
    // Turno 2: "No tengo estilista" → bot.js pone prefiereMasCercano = true.
    assert.deepStrictEqual(
        computeStylistGating({ ...base, prefiereMasCercano: true, stylistQuestionAsked: true }, 4),
        { anyStylists: true, askStylistFirst: false },
        'turno 2: buscar huecos de TODAS las elegibles, sin fijar estilista');
});

// ─── 4. El motor real devuelve huecos en ese turno ────────────────────────────
// Reproduce el turno exacto: servicio resuelto + pregunta de estilista pendiente +
// "No tengo estilista". El sábado 01/08/2026 —el día del incidente— solo trabajaba Irina.

function mockEquipoSante() {
    const SKILLS = ['Corte mujer'];
    const equipo = [
        { id: 'irina', name: 'Irina', skills: SKILLS, dias: [1, 3, 5] },
        { id: 'natalia', name: 'Natalia', skills: SKILLS, dias: [2, 3, 4] },
        { id: 'veronika', name: 'Veronika', skills: SKILLS, dias: [1, 3, 4] },
        { id: 'yulia', name: 'Yulia', skills: SKILLS, dias: [0, 2, 4] },
    ];
    db.getStylistsByOrg = async () => equipo.map(({ id, name, skills }) => ({ id, name, skills, active: true }));
    db.getStylistSchedule = async (_org, id) => equipo.find(s => s.id === id).dias
        .map(d => ({ day_of_week: d, start_time: '10:00:00', end_time: '19:00:00' }));
    db.getBlockedDays = async () => [];
    db.getScheduleBlocks = async () => [];
    db.getAppointmentsByStylistAndRange = async () => [];
}

// Sábado 01/08/2026, 16:22 Madrid: el minuto exacto en que ella contestó.
const SABADO_1622 = '2026-08-01T14:22:25.000Z';

(async () => {
    mockEquipoSante();

    await testAsync('el turno del incidente devuelve huecos reales, no una lista vacía', async () => {
        await withMockedNow(SABADO_1622, async () => {
            // Servicio ya resuelto ("Solo un corte y secado") y la pregunta de estilista
            // pendiente del turno anterior. Llega "No tengo estilista".
            const pd = extractQuickDataSante('No tengo estilista', {}, [], [],
                { stylistQuestionPending: true });
            const gating = computeStylistGating({
                selectedService: { nombre: 'Corte mujer' }, selectedStylist: null,
                prefiereMasCercano: true, stylistQuestionAsked: true,
            }, 4);
            assert.strictEqual(gating.askStylistFirst, false, 'ya no se repregunta');
            assert.strictEqual(gating.anyStylists, true, 'búsqueda combinada');

            const slots = await calendarSante.getAvailableSlots('org', {
                serviceDuration: 60, serviceCategory: 'Corte mujer',
                preferredStylistId: null, preferencia: pd.preferencia_horaria,
            });
            // Lo que se congela: el motor SE EJECUTA y devuelve huecos. Antes, la respuesta
            // no reconocida dejaba el turno sin resolver y la lista vacía.
            assert.ok(slots.length > 0, `el motor debe devolver huecos; devolvió ${slots.length}`);

            // Y arranca MAÑANA, no el mismo sábado: calendar-sante solo ofrece el día en
            // curso cuando la preferencia trae `asap` (calendar-sante.js, startDateStr).
            // Como "No tengo estilista" responde a QUIÉN y no emite señal temporal, no lo
            // trae — que es exactamente lo que queremos. Si algún día alguien mete la frase
            // en SIN_PREFERENCIA_RE "para que funcione", esta aserción lo delata.
            assert.ok(!slots.some(s => s.fecha === '2026-08-01'),
                'no debe adelantar al mismo día: la clienta no dijo nada sobre cuándo');
            assert.strictEqual(slots[0].fecha, '2026-08-03',
                'primer día abierto tras el sábado (domingo cierra)');

            // Búsqueda combinada: huecos de varias estilistas, ninguna fijada.
            assert.ok(new Set(slots.map(s => s.stylistName)).size > 1,
                'debe proponer huecos de más de una estilista');
        });
    });

    await testAsync('CONTRASTE: antes del arreglo la respuesta no abría nada', async () => {
        // prefiereMasCercano se quedaba en false porque nadie leía la frase; con la pregunta
        // ya hecha, el fail-safe salvaba el turno, pero la intención de la clienta se perdía
        // y cualquier turno posterior volvía a tratarla como "sin decidir".
        const sinReconocer = computeStylistGating({
            selectedService: { nombre: 'Corte mujer' }, selectedStylist: null,
            prefiereMasCercano: false, stylistQuestionAsked: false,
        }, 4);
        assert.deepStrictEqual(sinReconocer, { anyStylists: false, askStylistFirst: true },
            'sin reconocer la respuesta, el bot vuelve a preguntar lo mismo');
    });

    if (!process.exitCode) console.log('\nTests de "No tengo estilista" OK');
    process.exit(process.exitCode || 0);
})();
