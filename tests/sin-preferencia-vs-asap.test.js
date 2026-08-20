// Regresión del bug de producción del 28/07/2026 (dos conversaciones reales, 01:40 Madrid).
//
// Causa raíz: "el más cercano" se leía DOS veces con normalizaciones opuestas.
//   - helpers.js (asapRe) sobre texto NORMALIZADO (sin tildes) → ponía preferencia.asap
//   - bot.js   (meDaIgual) sobre texto CRUDO (con tildes)      → ponía prefiereMasCercano
// Una clienta escribiendo "El mas cercano" SIN tilde activaba solo la primera:
//   1) contaminaba la preferencia de FECHA con asap (respondiendo a una pregunta de ESTILISTA),
//   2) no activaba la intención de estilista → askStylistFirst se quedaba pegado a true →
//      loadAvailableSlots NUNCA se llamaba → availableSlots=[] → el LLM aplicaba el caso 7
//      ("la lista de huecos no carga") → "problema técnico" y escalada.
// Eva pidió el sábado (8 huecos reales con Irina) y Alberto "esta semana" (51 huecos reales).
//
// Este test congela: un solo detector normalizado, el gating por contexto (asap débil), el
// fail-safe anti-bloqueo del gating de estilista, y que el motor devuelve los huecos reales.

process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { extractQuickDataSante, detectNoPreferenceSignal, extractDateSignalSante } = require('../services/helpers');
const calendarSante = require('../services/calendar-sante');
const db = require('../services/db');
const { computeStylistGating, announcesHumanHandover, offersHumanHandover } = require('../bot')._internals;

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

// El instante EXACTO de las dos conversaciones: martes 28/07/2026, 01:40 Madrid.
const MARTES_0140 = '2026-07-27T23:40:00.000Z';

// ─── 1. UNA sola lectura, siempre sin tildes ──────────────────────────────────
test('el detector es insensible a tildes: "el mas cercano" ≡ "el más cercano"', () => {
    for (const txt of ['El mas cercano', 'el más cercano', 'EL MAS CERCANO', 'el mas cercano disponible']) {
        const s = detectNoPreferenceSignal(txt);
        assert.strictEqual(s.sinPreferencia, true, `"${txt}" debe leerse como "me da igual quién"`);
    }
});

test('se distingue lo TEMPORAL de lo SIN PREFERENCIA', () => {
    assert.deepStrictEqual(detectNoPreferenceSignal('lo antes posible'),
        { asapTemporal: true, sinPreferencia: false });
    assert.deepStrictEqual(detectNoPreferenceSignal('el mas cercano'),
        { asapTemporal: false, sinPreferencia: true });
    assert.deepStrictEqual(detectNoPreferenceSignal('el jueves por la tarde'),
        { asapTemporal: false, sinPreferencia: false });
});

test('"el mas cercano" produce asap DÉBIL; "lo antes posible" asap FUERTE', () => {
    assert.deepStrictEqual(extractDateSignalSante('el mas cercano'), { asapWeak: true });
    assert.deepStrictEqual(extractDateSignalSante('lo antes posible'), { asap: true });
});

// ─── 2. Gating por contexto: la fecha no se contamina ─────────────────────────
test('CONV 1 (Eva): "El sabado" → "El mas cercano" CONSERVA el sábado', () => {
    let pd = extractQuickDataSante('El sabado', {});
    assert.strictEqual(pd.preferencia_horaria.diaSemana, 5, 'sábado = 5');
    // La pregunta abierta era la de ESTILISTA: "el más cercano" contesta a QUIÉN, no a CUÁNDO.
    pd = extractQuickDataSante('El mas cercano', pd, [], [], { stylistQuestionPending: true });
    assert.deepStrictEqual(pd.preferencia_horaria, { diaSemana: 5 },
        'ni asap ni nada más: la preferencia de fecha queda intacta');
});

test('sin pregunta de estilista abierta, "el mas cercano" SÍ adelanta la búsqueda…', () => {
    const pd = extractQuickDataSante('el mas cercano', {});
    assert.strictEqual(pd.preferencia_horaria.asap, true);
});

test('…pero ni siquiera entonces borra un día que la clienta ya pidió (asap DÉBIL)', () => {
    let pd = extractQuickDataSante('El sabado', {});
    pd = extractQuickDataSante('el mas cercano', pd);
    assert.strictEqual(pd.preferencia_horaria.diaSemana, 5, 'el sábado sobrevive');
    assert.strictEqual(pd.preferencia_horaria.asap, true, 'y además busca desde ya');
});

test('un asap FUERTE ("lo antes posible") sí es una corrección: suelta el día', () => {
    let pd = extractQuickDataSante('El sabado', {});
    pd = extractQuickDataSante('lo antes posible', pd);
    assert.deepStrictEqual(pd.preferencia_horaria, { asap: true });
});

test('CONV 2 (Alberto): "El mas cercano" → "Esta semana" NO deja asap pegado', () => {
    let pd = extractQuickDataSante('El mas cercano', {}, [], [], { stylistQuestionPending: true });
    assert.deepStrictEqual(pd.preferencia_horaria, undefined, 'el turno de estilista no toca la fecha');
    pd = extractQuickDataSante('Esta semana', pd);
    assert.deepStrictEqual(pd.preferencia_horaria, { semana: 'esta' },
        'sin el asap fantasma que capaba los huecos a 5 y solo del día de hoy');
});

// ─── 3. El gating de estilista no puede bloquearse para siempre ───────────────
test('FAIL-SAFE: la pregunta de estilista se hace UNA vez; luego cae a búsqueda combinada', () => {
    const base = { selectedService: { nombre: 'Consulta' }, selectedStylist: null, prefiereMasCercano: false };
    const t1 = computeStylistGating({ ...base, stylistQuestionAsked: false }, 4);
    assert.deepStrictEqual(t1, { anyStylists: false, askStylistFirst: true }, 'turno 1: preguntar');
    // La clienta contesta algo que ningún detector reconoce → no fija estilista ni prefiereMasCercano.
    const t2 = computeStylistGating({ ...base, stylistQuestionAsked: true }, 4);
    assert.deepStrictEqual(t2, { anyStylists: true, askStylistFirst: false },
        'turno 2: NO repreguntar — buscar en combinado para que el motor se ejecute sí o sí');
});

test('con "el más cercano" reconocido, la búsqueda combinada arranca ya en el primer turno', () => {
    const g = computeStylistGating({
        selectedService: { nombre: 'Consulta' }, selectedStylist: null,
        prefiereMasCercano: true, stylistQuestionAsked: false,
    }, 4);
    assert.deepStrictEqual(g, { anyStylists: true, askStylistFirst: false });
});

test('con una sola elegible (o ya fijada) el gating no interviene', () => {
    const svc = { nombre: 'Relajante completo' };
    assert.deepStrictEqual(computeStylistGating({ selectedService: svc, selectedStylist: null }, 1),
        { anyStylists: false, askStylistFirst: false });
    assert.deepStrictEqual(computeStylistGating({ selectedService: svc, selectedStylist: { id: 'x' } }, 4),
        { anyStylists: false, askStylistFirst: false });
});

// ─── 4. Escalada anunciada = escalada ejecutada ───────────────────────────────
test('el texto real de la Conv 2 se reconoce como traspaso al equipo', () => {
    assert.strictEqual(announcesHumanHandover(
        'Disculpa, estoy teniendo un problema técnico para cargar los huecos disponibles 😅 Voy a pasar tu solicitud a nuestro equipo para que te atiendan directamente y te confirmen la cita 🙏'), true);
    assert.strictEqual(announcesHumanHandover(
        'Lamento Eva, en este momento estoy teniendo un problema técnico para cargar la disponibilidad del sábado 😅 Voy a pasar tu solicitud a nuestro equipo para que te atiendan directamente'), true);
});

test('mencionar al equipo sin prometer traspaso NO cuenta como escalada', () => {
    for (const txt of [
        'El equipo abre a las 10 y cierra a las 19',
        'Nuestro equipo está formado por cinco estilistas',
        'Perfecto, te lo apunto. ¿Necesitas algo más?',
    ]) assert.strictEqual(announcesHumanHandover(txt), false, txt);
});

// Los casos 1-6 del prompt PIDEN permiso antes de escalar: esa pregunta no puede disparar
// el backstop, o escalaríamos sin que la clienta haya dicho que sí.
test('PREGUNTAR si quiere el traspaso NO es anunciarlo', () => {
    for (const txt of [
        'Por supuesto 😊 ¿Quieres que te ponga en contacto con nuestro equipo?',
        '¿Te paso con nuestro equipo para que lo vean?',
        'Puedo pasar tu caso a nuestro equipo, ¿te parece bien?',
    ]) assert.strictEqual(announcesHumanHandover(txt), false, txt);
});

test('…pero la afirmación en el turno siguiente sí lo es', () => {
    assert.strictEqual(announcesHumanHandover(
        '¿Te viene bien el jueves? Si no, paso tu solicitud a nuestro equipo.'), true,
    'una frase afirmativa de traspaso cuenta aunque el mensaje lleve otra pregunta');
});

// ─── 4b. El traspaso que no era "al equipo" ───────────────────────────────────
// El destino solo reconocía al "equipo", pero de las cuatro preguntas de traspaso escritas
// en el prompt de Sante TRES mandan a "una especialista". Y "poner en contacto" —la fórmula
// literal de esas preguntas— no estaba entre los verbos. O sea: la mayoría de los traspasos
// del salón no los veía ninguna de las dos redes.
test('traspaso a especialista / salón / chicas también es traspaso', () => {
    for (const txt of [
        'Te pongo en contacto con una especialista para que te asesore',
        'Paso tu caso a una de nuestras especialistas',
        'Aviso al salón para que te llamen',
        'Comento con las chicas del salón y te dicen',
        'Te pongo en contacto con alguien del equipo',
    ]) assert.strictEqual(announcesHumanHandover(txt), true, txt);
});

test('mencionar el salón sin traspasar NO cuenta (el destino exige preposición)', () => {
    for (const txt of [
        'Te paso a comentarte los precios del salón',
        'Te espero en el salón el jueves',
        'La especialista te lo confirmará en el salón',
        'El salón abre de lunes a sábado',
    ]) assert.strictEqual(announcesHumanHandover(txt), false, txt);
});

// ─── 4c. La pregunta que nadie apuntaba ───────────────────────────────────────
// La regla del prompt PROHÍBE escalar en el mensaje que pregunta y manda esperar un "sí".
// Nadie apuntaba que la pregunta se había hecho, así que el "sí" volvía al LLM y, si no
// ponía accion:escalar_humano, la clienta que había dicho que sí no llegaba a nadie.
test('offersHumanHandover reconoce las preguntas EXACTAS del prompt', () => {
    for (const txt of [
        'Las extensiones requieren una valoración personalizada 😊 ¿Quieres que te ponga en contacto con una especialista para que te asesore?',
        'La permanente requiere una valoración personalizada 😊 ¿Quieres que te ponga en contacto con una especialista?',
        'Por supuesto 😊 ¿Quieres que te ponga en contacto con nuestro equipo?',
        '¿Te paso con nuestro equipo para que lo vean?',
    ]) assert.strictEqual(offersHumanHandover(txt), true, txt);
});

test('las dos redes son excluyentes: una pregunta no se anuncia y un anuncio no se pregunta', () => {
    const pregunta = '¿Quieres que te ponga en contacto con una especialista?';
    const anuncio = 'Voy a pasar tu solicitud a nuestro equipo para que te atiendan directamente';
    assert.strictEqual(offersHumanHandover(pregunta), true);
    assert.strictEqual(announcesHumanHandover(pregunta), false, 'preguntar no escala: se espera el sí');
    assert.strictEqual(offersHumanHandover(anuncio), false);
    assert.strictEqual(announcesHumanHandover(anuncio), true, 'anunciarlo sí escala en el acto');
});

test('una respuesta normal no arma ninguna espera', () => {
    for (const txt of [
        '¿Te viene bien el jueves a las 10?',
        '¿Necesitas algo más?',
        '¿Quieres que te reserve el hueco de las 16:00?',
        '¿Prefieres con Irina o con Veronika?',
    ]) assert.strictEqual(offersHumanHandover(txt), false, txt);
});

// El "sí" lo resuelve la MISMA maquinaria que ya usan extensiones/permanente, no una
// segunda: por eso la oferta se apunta en pendingEscalation y no en un flag paralelo.
// ACTUALIZADO 15/08/2026: el armado dejó de pasar por offersHumanHandover (solo
// castellano) y pasa por detectaOfertaTraspaso — la MISMA función que usa el barrido de
// promesas (anillo 1, commits 64c6291/21e0d45). Este grep se quedó mirando el call site
// viejo y llevaba npm test en rojo desde ese refactor.
test('la oferta se apunta en pendingEscalation, y el bloque que lo consume sigue ahí', () => {
    const BOT = require('fs').readFileSync(require('path').join(__dirname, '..', 'bot.js'), 'utf8');
    assert.ok(/detectaOfertaTraspaso\(aiResponse\.respuesta\)/.test(BOT), 'se mira sobre el texto final');
    assert.ok(/session\.pendingEscalationService = 'traspaso'/.test(BOT));
    assert.ok(/if \(orgType === 'salon' && session\.pendingEscalation\)/.test(BOT),
        'el bloque determinista que resuelve el sí/no debe seguir existiendo');
    // Y no se arma si ya se está escalando en este turno.
    assert.ok(/aiResponse\.accion !== 'escalar_humano'\s*\n\s*&& !session\.pendingEscalation && detectaOfertaTraspaso/.test(BOT));
});

// ─── 5. Los huecos reales que el bot no vio ───────────────────────────────────
// Horarios reales de Sante para las categorías implicadas, 10:00–19:00:
//   Consulta        → Irina (mar/jue/sáb), Natalia (mié/jue/vie), Veronika (mar/jue/vie), Yulia (lun/mié/vie)
//   Mechas clásicas → las mismas cuatro
// El sábado 1-ago SOLO trabaja Irina: por eso la consulta tenía exactamente 8 huecos.
function mockEquipoSante() {
    const SKILLS = ['Consulta', 'Mechas clásicas'];
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

(async () => {
    mockEquipoSante();

    await testAsync('CONV 1: la preferencia limpia devuelve los 8 huecos reales del sábado 1-ago', async () => {
        await withMockedNow(MARTES_0140, async () => {
            let pd = extractQuickDataSante('El sabado', {});
            pd = extractQuickDataSante('El mas cercano', pd, [], [], { stylistQuestionPending: true });
            // 300 min es la duración que la Consulta tenía el día del incidente; hoy son 60
            // (029_consulta_60min.sql). Se conserva a propósito: lo que este test fija es el
            // PARSEO de "El sabado" + "El mas cercano", y los 8 huecos de 10:00 a 13:30 son la
            // huella exacta de aquel bug. Con 60 min serían 16 y la regresión dejaría de ser
            // comparable con lo que Eva no llegó a ver.
            const slots = await calendarSante.getAvailableSlots('org', {
                serviceDuration: 300, serviceCategory: 'Consulta',
                preferredStylistId: null, preferencia: pd.preferencia_horaria,
            });
            const sabado = slots.filter(s => s.fecha === '2026-08-01');
            // Eran 8 hasta el 20/08/2026 y ahora son 9: el noveno es 14:00, que con 300' cierra
            // la jornada CLAVADO a las 19:00 y hasta el arreglo de D3 se tiraba. Lo que este
            // test fija sigue siendo el PARSEO de «El sabado» + «El mas cercano» —que la
            // preferencia salga limpia y el sábado tenga huecos—, no cuántos son; el hueco
            // nuevo es del motor y está congelado en calendar-sante-slots.
            assert.strictEqual(sabado.length, 9, 'los huecos que Eva nunca llegó a ver');
            assert.deepStrictEqual(sabado.map(s => s.hora),
                ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00']);
            assert.ok(sabado.every(s => s.stylistName === 'Irina'), 'el sábado solo trabaja Irina');
        });
    });

    await testAsync('CONV 2: "esta semana" sin asap fantasma abre miércoles y jueves, no solo hoy', async () => {
        await withMockedNow(MARTES_0140, async () => {
            let pd = extractQuickDataSante('El mas cercano', {}, [], [], { stylistQuestionPending: true });
            pd = extractQuickDataSante('Esta semana', pd);
            const slots = await calendarSante.getAvailableSlots('org', {
                serviceDuration: 180, serviceCategory: 'Mechas clásicas',
                preferredStylistId: null, preferencia: pd.preferencia_horaria,
            });
            assert.ok(slots.length >= 20, `esperados >=20 huecos, hubo ${slots.length}`);
            const dias = [...new Set(slots.map(s => s.fecha))];
            assert.ok(dias.includes('2026-07-29') && dias.includes('2026-07-30'),
                `debe abrir miércoles y jueves; abrió ${dias.join(', ')}`);
            assert.ok(!slots.weekPreferenceRelaxed, 'un martes "esta semana" aún tiene días: filtro duro');
        });
    });

    await testAsync('CONTRASTE: con el asap fantasma el motor solo daba 5 huecos, todos de hoy', async () => {
        await withMockedNow(MARTES_0140, async () => {
            const slots = await calendarSante.getAvailableSlots('org', {
                serviceDuration: 180, serviceCategory: 'Mechas clásicas',
                preferredStylistId: null, preferencia: { asap: true, semana: 'esta' },
            });
            assert.strictEqual(slots.length, 5, 'el tope de asap capaba la lista a 5');
            assert.ok(slots.every(s => s.fecha === '2026-07-28'), 'y todos del mismo día');
        });
    });

    if (!process.exitCode) console.log('\nTodos los tests de "sin preferencia" vs asap OK');
    process.exit(process.exitCode || 0);
})();
