// Regresión: contaminación de `preferencia_horaria.semana` entre turnos.
// Bug real: tras "la semana que viene" y luego una fecha concreta ("el martes 14 de julio"),
// `semana:'siguiente'` sobrevivía y el motor excluía la fecha pedida → falso totalSlots:0 /
// "ese día no está disponible". Fija los tres fixes:
//   A) la señal del turno se fusiona en el ÚNICO store vía el reducer idempotente
//      applyDatePreference (services/date-preference.js): una fecha ABSOLUTA limpia la semana
//      heredada, y un contexto de semana + un día se COLAPSA a una fecha absoluta.
//   B) ya no existe sticky paralelo (session.weekPreference / resolveStickyWeek, eliminados):
//      un turno = extractQuickDataSante y nada más.
//   C) getAvailableSlots ignora el filtro de 'semana' cuando hay 'fecha' (services/calendar-sante.js)

// Fake creds Supabase (nunca se hace llamada real) + TZ fija para que las fechas resuelvan
// deterministas. Debe ir antes de requerir los módulos (construyen cliente/Intl al cargar).
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { extractQuickDataSante } = require('../services/helpers');
const { mondayDow } = require('../services/date-utils');
const calendarSante = require('../services/calendar-sante');
const db = require('../services/db');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (error) { console.error(`fail - ${name}`); console.error(error); process.exitCode = 1; }
}
async function testAsync(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (error) { console.error(`fail - ${name}`); console.error(error); process.exitCode = 1; }
}

// new Date() sin args → instante fijo; con args → Date real. (Igual que calendar-sante-slots.test.js)
async function withMockedNow(isoString, fn) {
    const RealDate = Date;
    class MockDate extends RealDate {
        constructor(...args) { if (args.length === 0) { super(isoString); return; } super(...args); }
        static now() { return new RealDate(isoString).getTime(); }
    }
    global.Date = MockDate;
    try { return await fn(); } finally { global.Date = RealDate; }
}

// HOY = lunes 13/07/2026 → "semana que viene" = 20..26 jul ; el martes 14 es de ESTA semana.
const LUNES = '2026-07-13T09:00:00Z';

// Un turno real de salón: TODA la preferencia de fecha entra por aquí (bot.js ya no llama a
// ningún sticky adicional). `opts` es lo que bot.js le pasa sobre el contexto del turno.
function turno(session, text, opts = {}) {
    session.partialData = extractQuickDataSante(text, session.partialData, [], [], opts);
    return session;
}

// ─── Fix A: día + contexto de semana COLAPSAN a una fecha absoluta ────────────────────
test('FIX A: "semana que viene" → "el jueves" colapsa a la fecha del jueves próximo', () => {
    const RealDate = Date;
    class MockDate extends RealDate {
        constructor(...args) { if (args.length === 0) { super(LUNES); return; } super(...args); }
        static now() { return new RealDate(LUNES).getTime(); }
    }
    global.Date = MockDate;
    try {
        let pd = extractQuickDataSante('la semana que viene', {});
        pd = extractQuickDataSante('el jueves', pd);
        assert.strictEqual(pd.preferencia_horaria.fecha, '2026-07-23', 'jueves de la semana que viene');
        assert.strictEqual(pd.preferencia_horaria.diaSemana, undefined, 'el día se consume en la fecha');
        assert.strictEqual(pd.preferencia_horaria.semana, 'siguiente', 'la semana queda como CONTEXTO');
    } finally { global.Date = RealDate; }
});

// ─── Fix B: el reducer sustituye al sticky paralelo (ya no hay resolveStickyWeek) ──────
test('FIX B: una fecha ABSOLUTA no arrastra la semana heredada', () => {
    const { applyDatePreference } = require('../services/date-preference');
    const out = applyDatePreference({ semana: 'siguiente' }, { fecha: '2026-07-14' }, new Date(LUNES));
    assert.strictEqual(out.fecha, '2026-07-14');
    assert.strictEqual(out.semana, undefined, 'no re-inyecta semana');
});

test('FIX B: sin señal de fecha en el turno, el ancla previa se mantiene intacta', () => {
    const { applyDatePreference } = require('../services/date-preference');
    const prev = { fecha: '2026-07-14', semana: 'esta' };
    assert.deepStrictEqual(applyDatePreference(prev, {}, new Date(LUNES)), prev);
});

test('FIX B: asap FUERTE ("lo antes posible") sigue olvidando la semana y el día', () => {
    const { applyDatePreference } = require('../services/date-preference');
    const out = applyDatePreference({ semana: 'siguiente', diaSemana: 1 }, { asap: true }, new Date(LUNES));
    assert.deepStrictEqual(out, { asap: true });
});

// ─── Casos con fecha absoluta (necesitan "hoy" mockeado) + Fix C / end-to-end ─────────
function mockOpenSchedule() {
    const S = { id: 'stylist-test', name: 'Ana', active: true, skills: ['Cortes'] };
    db.getStylistsByOrg = async () => [S];
    db.getStylistSchedule = async () => [0, 1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d, start_time: '10:00:00', end_time: '19:00:00' }));
    db.getBlockedDays = async () => [];
    db.getScheduleBlocks = async () => [];
    db.getAppointmentsByStylistAndRange = async () => [];
    return S;
}

// Horario realista de Sante: lunes a sábado 10–19, DOMINGO CERRADO (sin fila para el día 6).
function mockLunesASabado() {
    const S = { id: 'stylist-test', name: 'Ana', active: true, skills: ['Cortes'] };
    db.getStylistsByOrg = async () => [S];
    db.getStylistSchedule = async () => [0, 1, 2, 3, 4, 5].map(d => ({ day_of_week: d, start_time: '10:00:00', end_time: '19:00:00' }));
    db.getBlockedDays = async () => [];
    db.getScheduleBlocks = async () => [];
    db.getAppointmentsByStylistAndRange = async () => [];
    return S;
}

(async () => {
    // Fix A con fecha absoluta
    await testAsync('FIX A: "semana que viene" → "el martes 14 de julio" borra semana, conserva fecha', async () => {
        await withMockedNow(LUNES, async () => {
            let pd = extractQuickDataSante('quiero para la semana que viene', {});
            assert.strictEqual(pd.preferencia_horaria.semana, 'siguiente', 'T1 fija siguiente');
            pd = extractQuickDataSante('el martes 14 de julio', pd);
            assert.strictEqual(pd.preferencia_horaria.fecha, '2026-07-14', 'resuelve la fecha absoluta');
            assert.strictEqual(pd.preferencia_horaria.semana, undefined, 'la semana heredada se limpia');
            assert.strictEqual(mondayDow(pd.preferencia_horaria.fecha), 1, 'la fecha resuelta ES un martes');
        });
    });

    await testAsync('FIX A: "esta semana" → "el 24" (día del mes suelto) borra semana', async () => {
        await withMockedNow(LUNES, async () => {
            let pd = extractQuickDataSante('esta semana mejor', {});
            assert.strictEqual(pd.preferencia_horaria.semana, 'esta');
            pd = extractQuickDataSante('el 24', pd);
            assert.ok(pd.preferencia_horaria.fecha, 'resuelve "el 24" a una fecha');
            assert.strictEqual(pd.preferencia_horaria.semana, undefined, 'sin semana tras fecha absoluta');
        });
    });

    // Idempotencia: repetir el MISMO turno (typo) nunca desplaza la semana (deriva 21→28).
    await testAsync('IDEMPOTENCIA: repetir "el martes de la semana que viene" da SIEMPRE la misma fecha', async () => {
        await withMockedNow(LUNES, async () => {
            let pd = extractQuickDataSante('el martes de la semana que viene', {});
            assert.strictEqual(pd.preferencia_horaria.fecha, '2026-07-21');
            pd = extractQuickDataSante('el martes de la semana que viene', pd);
            pd = extractQuickDataSante('el martes de la semana que viene', pd);
            assert.strictEqual(pd.preferencia_horaria.fecha, '2026-07-21', 'jamás deriva al 28');
        });
    });

    mockOpenSchedule();

    await testAsync('FIX C: pref contaminada {semana:siguiente, fecha:<esta semana>} → el motor honra la fecha', async () => {
        await withMockedNow(LUNES, async () => {
            const slots = await calendarSante.getAvailableSlots('org', {
                serviceDuration: 60,
                serviceCategory: 'Cortes',
                preferredStylistId: null,
                preferencia: { semana: 'siguiente', diaSemana: 1, fecha: '2026-07-14' },
            });
            assert.ok(slots.length > 0, 'debe devolver huecos del martes 14, no falso 0 por semana heredada');
            assert.ok(slots.every(s => s.fecha === '2026-07-14'), 'todos los huecos son de la fecha pedida');
            assert.ok(!slots.requestedDayUnavailable, 'no marca el día como no disponible');
        });
    });

    await testAsync('END-TO-END: los 2 turnos producen pref limpia y huecos reales del martes 14', async () => {
        await withMockedNow(LUNES, async () => {
            const session = { partialData: {} };
            turno(session, 'la semana que viene');
            turno(session, 'el martes 14 de julio');
            const pref = session.partialData.preferencia_horaria;
            assert.strictEqual(pref.semana, undefined, 'la pref final no arrastra semana');
            const slots = await calendarSante.getAvailableSlots('org', {
                serviceDuration: 60, serviceCategory: 'Cortes', preferredStylistId: null, preferencia: pref,
            });
            assert.ok(slots.length > 0 && slots.every(s => s.fecha === '2026-07-14'), 'huecos del 14/07');
            assert.ok(!slots.requestedDayUnavailable, 'sin falso "día no disponible"');
        });
    });

    // ─── Regresión del bug de producción del 24/07/2026 ──────────────────────────────────
    // Conversación real: la clienta responde "el mas cercano" a la pregunta de ESTILISTA,
    // luego "mañana" y luego "lunes". El estado que producía el código de entonces era
    // {asap, semana:'esta', diaSemana:0}: la ventana de "esta semana" un viernes/sábado NO
    // llega al lunes, así que el motor devolvía 0 huecos del lunes y el LLM escalaba por
    // "error técnico" — teniendo el lunes 16 huecos libres.
    // Ahora el reducer deja el estado LIMPIO ({diaSemana:0, semana:'esta'}: "el más cercano"
    // ya no contamina con asap), y el fallback escalonado sigue garantizando que el día
    // pedido nunca se pierda. Se prueba con "hoy" en viernes Y en sábado (el sábado es el
    // peor caso: la ventana colapsa a un solo día, el domingo, que está cerrado).
    mockLunesASabado();

    for (const [diaNombre, hoyISO, lunesEsperado] of [
        ['viernes', '2026-07-24T13:45:00Z', '2026-07-27'],
        ['sábado', '2026-07-25T09:00:00Z', '2026-07-27'],
    ]) {
        await testAsync(`BUG 24/07 (hoy=${diaNombre}): "el mas cercano" → "mañana" → "lunes" da huecos DEL LUNES`, async () => {
            await withMockedNow(hoyISO, async () => {
                const session = { partialData: {} };
                turno(session, 'el mas cercano');
                turno(session, 'mañana');
                turno(session, 'lunes');
                const pref = session.partialData.preferencia_horaria;
                assert.deepStrictEqual(pref, { diaSemana: 0, semana: 'esta' },
                    'el día pedido sobrevive y "el más cercano" ya no deja asap pegado');

                const slots = await calendarSante.getAvailableSlots('org', {
                    serviceDuration: 60, serviceCategory: 'Cortes', preferredStylistId: null, preferencia: pref,
                });
                assert.ok(slots.length > 0, 'no puede devolver 0 huecos: eso es lo que hacía escalar por error técnico');
                assert.ok(slots.some(s => s.fecha === lunesEsperado),
                    `debe ofrecer huecos del lunes ${lunesEsperado}, que es el día que pidió la clienta`);
                assert.ok(slots.every(s => new Date(s.fecha + 'T12:00:00').getDay() === 1),
                    'con el día pedido intacto, todos los huecos son de un lunes');
                assert.ok(!slots.requestedDayUnavailable,
                    'el lunes SÍ tiene hueco → no debe avisar de que el día pedido no está disponible');
                assert.ok(slots.weekPreferenceRelaxed,
                    'el lunes cae fuera de "esta semana": hay que avisarlo, no colarlo en silencio');
            });
        });
    }

    if (!process.exitCode) console.log('\nTodos los tests de persistencia de preferencia OK');
    process.exit(process.exitCode || 0);
})();
