// TZ=UTC A PROPÓSITO: demuestra que el motor de huecos de Sante es correcto
// independientemente de la zona horaria del PROCESO. Antes, con el proceso en UTC, las
// citas (timestamps UTC) se leían desplazadas respecto al horario (texto local Madrid) y
// se ofrecían horas ocupadas o se sobre-reservaba el día. Debe fijarse antes de requerir
// el módulo, porque los formateadores Intl se crean al cargarlo.
process.env.TZ = 'UTC';

// Test hermético: solo ejercita funciones PURAS (sin BD ni red). calendar-sante requiere la
// capa db → supabase, que construye su cliente al cargar; le damos credenciales ficticias
// para que el require no falle. Nunca se hace ninguna llamada real.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const calendarSante = require('../services/calendar-sante');
const { _internals } = calendarSante;
const { computeFreeSlots, toLocalDateStr, toMinutes, addDaysStr, mondayDow } = _internals;

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

const M = h => h * 60;                                  // hora → minutos
const HH = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
const asHours = arr => arr.map(HH);

// ─── El bug reportado: Irina sáb 10–19, citas 10–12 y 17–19, corte 30 min ─────────────
// Deja libre 12:00–17:00 → debe ofrecer 12:00, 12:30 … 16:30 (10 huecos).
test('CASO IRINA: citas parciales 10–12 y 17–19 → huecos 12:00…16:30', () => {
    const starts = computeFreeSlots({
        workStart: M(10), workEnd: M(19),
        occupied: [{ start: M(10), end: M(12) }, { start: M(17), end: M(19) }],
        serviceDuration: 30,
    });
    assert.deepStrictEqual(asHours(starts), [
        '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
    ]);
});

// ─── Hueco entre la 2ª y la 3ª cita (tres citas parciales el mismo día) ───────────────
test('TRES CITAS: huecos en cada tramo libre entre 10–11, 13–14 y 16–17', () => {
    const starts = computeFreeSlots({
        workStart: M(10), workEnd: M(18),
        occupied: [{ start: M(10), end: M(11) }, { start: M(13), end: M(14) }, { start: M(16), end: M(17) }],
        serviceDuration: 30,
    });
    // Tramos libres: 11–13, 14–16, 17–18 (este último sin margen antes del cierre 18:00
    // para un servicio de 30': 17:00→17:30 vale, 17:30→18:00 NO por el guard < workEnd).
    assert.deepStrictEqual(asHours(starts), [
        '11:00', '11:30', '12:00', '12:30',   // 11–13
        '14:00', '14:30', '15:00', '15:30',   // 14–16
        '17:00',                              // 17–18 (solo 17:00; 17:30 tocaría el cierre)
    ]);
});

// ─── Citas en el borde inicial y final del turno → hueco central grande ───────────────
test('BORDES: cita al abrir y al cerrar → todo el centro libre', () => {
    const starts = computeFreeSlots({
        workStart: M(9), workEnd: M(18),
        occupied: [{ start: M(9), end: M(10) }, { start: M(17), end: M(18) }],
        serviceDuration: 60,
    });
    assert.strictEqual(starts[0], M(10));      // primer hueco a las 10:00
    assert.strictEqual(starts[starts.length - 1], M(16)); // último 16:00 (16–17, < cierre)
    assert.ok(!starts.includes(M(9)) && !starts.includes(M(17)), 'no ofrece horas ocupadas');
});

// ─── Día completamente ocupado → 0 huecos (0 legítimo) ────────────────────────────────
test('DÍA LLENO: una cita cubre todo el turno → sin huecos', () => {
    const starts = computeFreeSlots({
        workStart: M(10), workEnd: M(19),
        occupied: [{ start: M(10), end: M(19) }],
        serviceDuration: 30,
    });
    assert.deepStrictEqual(starts, []);
});

// ─── El estado de la cita no interviene: no_show bloquea igual que confirmed ──────────
// computeFreeSlots recibe INTERVALOS; da lo mismo de qué estado vengan. Este test fija que
// añadir el intervalo 17–19 (la cita no_show del caso real) elimina esas horas del resultado.
test('NO_SHOW BLOQUEA: añadir el intervalo 17–19 quita 17:00+ de los huecos', () => {
    const base = { workStart: M(10), workEnd: M(19), serviceDuration: 30 };
    const sinNoShow = computeFreeSlots({ ...base, occupied: [{ start: M(10), end: M(12) }] });
    const conNoShow = computeFreeSlots({ ...base, occupied: [{ start: M(10), end: M(12) }, { start: M(17), end: M(19) }] });
    assert.ok(sinNoShow.includes(M(17)), 'sin la no_show sí habría hueco a las 17:00');
    assert.ok(!conNoShow.includes(M(17)), 'con la no_show NO debe ofrecer las 17:00');
});

// ─── Entrada desordenada → se ordena internamente ────────────────────────────────────
test('ROBUSTEZ: occupied desordenado da el mismo resultado', () => {
    const ordered = computeFreeSlots({ workStart: M(10), workEnd: M(19), serviceDuration: 30, occupied: [{ start: M(10), end: M(12) }, { start: M(17), end: M(19) }] });
    const shuffled = computeFreeSlots({ workStart: M(10), workEnd: M(19), serviceDuration: 30, occupied: [{ start: M(17), end: M(19) }, { start: M(10), end: M(12) }] });
    assert.deepStrictEqual(shuffled, ordered);
});

// ─── minStart (buffer asap de hoy) descarta huecos ya pasados ─────────────────────────
test('MINSTART: descarta huecos por debajo del umbral', () => {
    const starts = computeFreeSlots({ workStart: M(10), workEnd: M(19), serviceDuration: 30, occupied: [], minStart: M(15) });
    assert.strictEqual(starts[0], M(15));
    assert.ok(!starts.some(t => t < M(15)));
});

// ─── TZ-INDEPENDENCIA: el corazón del fix estructural ─────────────────────────────────
// Con el proceso en UTC, una cita guardada 08:00 UTC = 10:00 Madrid debe leerse como 600.
test('TZ-PROOF: toMinutes lee la hora en TZ de negocio (Madrid), no del proceso (UTC)', () => {
    assert.strictEqual(process.env.TZ, 'UTC', 'este test corre con el proceso en UTC');
    assert.strictEqual(toMinutes(new Date('2026-07-11T08:00:00Z')), M(10)); // 08 UTC → 10 Madrid (verano UTC+2)
    assert.strictEqual(toMinutes(new Date('2026-07-11T15:00:00Z')), M(17)); // 15 UTC → 17 Madrid
    assert.strictEqual(toMinutes(new Date('2026-01-15T09:00:00Z')), M(10)); // invierno UTC+1: 09 UTC → 10 Madrid
});

test('TZ-PROOF: toLocalDateStr da la fecha de negocio, no la del proceso', () => {
    // 22:30 UTC del 11-jul = 00:30 Madrid del 12-jul → fecha de negocio 2026-07-12.
    assert.strictEqual(toLocalDateStr(new Date('2026-07-11T22:30:00Z')), '2026-07-12');
    assert.strictEqual(toLocalDateStr(new Date('2026-07-11T08:00:00Z')), '2026-07-11');
});

// ─── Aritmética de calendario pura (usada para recorrer los 14 días) ─────────────────
test('addDaysStr suma días de calendario y cruza fin de mes/año', () => {
    assert.strictEqual(addDaysStr('2026-07-11', 1), '2026-07-12');
    assert.strictEqual(addDaysStr('2026-07-31', 1), '2026-08-01');
    assert.strictEqual(addDaysStr('2026-12-31', 1), '2027-01-01');
    assert.strictEqual(addDaysStr('2026-07-11', 0), '2026-07-11');
});

test('mondayDow: 0=lunes … 6=domingo', () => {
    assert.strictEqual(mondayDow('2026-07-11'), 5); // sábado
    assert.strictEqual(mondayDow('2026-07-13'), 0); // lunes
    assert.strictEqual(mondayDow('2026-07-12'), 6); // domingo
});

if (!process.exitCode) console.log('\nTodos los tests de huecos Sante OK');

// ─── INTEGRACIÓN: getAvailableSlots end-to-end, bug real "domingo + mañana" ───────────
// Reproduce el caso Veronika/Mechas Balayage sin tocar Supabase: se mockean las funciones
// de services/db.js (mismo objeto de módulo que usa calendar-sante.js, así que parchearlas
// aquí basta) y se controla "ahora" para fijar el día de HOY en domingo — el caso donde
// endOfThisWeekStr colapsaba a [hoy, hoy] y descartaba el lunes pedido (totalSlots:0 falso
// pese a skill, horario y agenda libres reales).
const db = require('../services/db');

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

// Sustituye el Date global mientras corre `fn`, fijando lo que devuelve `new Date()` (sin
// argumentos) a `isoString`; cualquier `new Date(algo)` con argumentos se comporta con
// normalidad (delega en el Date real vía super(...args)).
async function withMockedNow(isoString, fn) {
    const RealDate = Date;
    class MockDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) { super(isoString); return; }
            super(...args);
        }
        static now() { return new RealDate(isoString).getTime(); }
    }
    global.Date = MockDate;
    try {
        return await fn();
    } finally {
        global.Date = RealDate;
    }
}

const VERONIKA_ID = 'stylist-veronika-test';

function mockDbForVeronika({ appointments = [] } = {}) {
    db.getStylistsByOrg = async () => [
        { id: VERONIKA_ID, name: 'Veronika', active: true, skills: ['Mechas Balayage'] },
    ];
    db.getStylistSchedule = async () => [
        { day_of_week: 0, start_time: '10:00:00', end_time: '19:00:00' }, // lunes 10–19
    ];
    db.getBlockedDays = async () => [];
    db.getScheduleBlocks = async () => [];
    db.getAppointmentsByStylistAndRange = async () => appointments;
}

(async () => {
    // 2026-07-12 es domingo y 2026-07-13 es lunes (confirmado: new Date('2026-07-12T12:00:00Z').getUTCDay() === 0).
    mockDbForVeronika();

    await testAsync('DOMINGO + "mañana lunes" (semana:esta + diaSemana:0 en el mismo mensaje) → SÍ hay huecos reales el lunes', async () => {
        await withMockedNow('2026-07-12T09:00:00Z', async () => {
            const slots = await calendarSante.getAvailableSlots('org-test', {
                serviceDuration: 240,
                serviceCategory: 'Mechas Balayage',
                preferredStylistId: VERONIKA_ID,
                // Combinación que producía el bug real antes del fix: 'manana' ponía
                // semana:'esta' Y 'lunes' ponía diaSemana:0 en el mismo mensaje.
                preferencia: { semana: 'esta', diaSemana: 0 },
            });
            assert.ok(slots.length > 0, 'debe encontrar huecos reales el lunes, no totalSlots:0 falso');
            assert.ok(slots.every(s => s.fecha === '2026-07-13'), 'todos los huecos deben ser del lunes 13/07');
            assert.ok(slots.some(s => s.hora === '10:00'), 'debe ofrecer el hueco de apertura (10:00)');
        });
    });

    await testAsync('DOMINGO + semana:"esta" sola (sin día explícito) cubre la semana que empieza mañana, no [hoy,hoy]', async () => {
        await withMockedNow('2026-07-12T09:00:00Z', async () => {
            const slots = await calendarSante.getAvailableSlots('org-test', {
                serviceDuration: 60,
                serviceCategory: 'Mechas Balayage',
                preferredStylistId: VERONIKA_ID,
                preferencia: { semana: 'esta' },
            });
            assert.ok(slots.length > 0, 'la semana que empieza mañana (lunes) debe tener huecos, no un rango vacío por anclar a HOY (domingo)');
        });
    });

    await testAsync('MARTES (día normal, no domingo) + semana:"esta" sigue acotando al domingo de esa misma semana', async () => {
        // Control: el fix ancla a la semana de startDateStr, que en un día normal es la
        // misma semana que HOY — no debe cambiar el comportamiento fuera del caso domingo.
        await withMockedNow('2026-07-14T09:00:00Z', async () => { // martes 14/07/2026
            const slots = await calendarSante.getAvailableSlots('org-test', {
                serviceDuration: 60,
                serviceCategory: 'Mechas Balayage',
                preferredStylistId: VERONIKA_ID,
                preferencia: { semana: 'esta' },
            });
            // Veronika solo trabaja lunes en este mock: "esta semana" desde el martes 14 ya
            // dejó atrás el lunes 13 → 0 huecos es el resultado CORRECTO aquí (no un bug).
            // (slots trae además la propiedad no-índice `requestedDayUnavailable`, por eso
            // se compara la longitud y no con deepStrictEqual contra un array literal.)
            assert.strictEqual(slots.length, 0, 'el lunes de esta semana ya pasó; no debe inventar huecos');
        });
    });

    if (!process.exitCode) console.log('\nTodos los tests de integración getAvailableSlots (domingo/semana) OK');
})();
