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
    // Tramos libres: 11–13, 14–16, 17–18. El último da DOS huecos, no uno: 17:30→18:00
    // termina justo al cierre y es un hueco legítimo. Hasta el 20/08/2026 esta línea decía
    // «17:30 NO por el guard < workEnd» — o sea que el test congelaba el defecto D3.
    assert.deepStrictEqual(asHours(starts), [
        '11:00', '11:30', '12:00', '12:30',   // 11–13
        '14:00', '14:30', '15:00', '15:30',   // 14–16
        '17:00', '17:30',                     // 17–18, cerrando la jornada exacta
    ]);
});

// ─── D3 · el último hueco de la jornada ───────────────────────────────────────────────
//
// El defecto vivió aquí desde el principio y lo tapaba una persona: en una conversación,
// que el bot no ofrezca las 18:30 no se nota. En una página pública es dinero todos los
// días. MEDIDO contra la agenda real antes de arreglarlo (`npm run medir:borde -- sante`,
// 90 días, 20/08/2026): 9.380 filas de más en el catálogo entero, 4.405 horas visibles, y
// un servicio de 30′ gana UNA hora al final de 76 de los próximos 90 días. Las tres
// comprobaciones salieron a cero: ninguno empieza antes de abrir, ninguno pasa del cierre,
// ninguno pisa una cita.
//
// Lo que estos bloques congelan no es el número —que cambia con la agenda— sino las dos
// mitades de la regla: que el hueco que ACABA en el cierre se ofrece, y que el que lo PASA
// no. Sin el segundo, «arreglar» D3 sería abrir el agujero contrario.

test('D3: el hueco que termina EXACTAMENTE al cierre se ofrece', () => {
    const starts = computeFreeSlots({
        workStart: M(10), workEnd: M(19), occupied: [], serviceDuration: 30,
    });
    assert.strictEqual(asHours(starts).pop(), '18:30',
        'se ha vuelto a perder el último hueco de la jornada (D3)');
});

test('D3: y el que PASA del cierre sigue sin ofrecerse', () => {
    // La otra mitad. Jornada de 10 a 19 y un servicio de 45′: 18:30 acabaría a las 19:15.
    const starts = computeFreeSlots({
        workStart: M(10), workEnd: M(19), occupied: [], serviceDuration: 45,
    });
    assert.strictEqual(asHours(starts).pop(), '18:00',
        'se está ofreciendo una cita que se sale del horario');
});

test('D3: una jornada que cabe JUSTA da exactamente un hueco', () => {
    // Alisado de 5 h en una jornada de 5 h. Antes daba cero, y `diagnosticarCero` lo llamaba
    // «no cabe» — que era mentira: cabe, clavado.
    const starts = computeFreeSlots({
        workStart: M(14), workEnd: M(19), occupied: [], serviceDuration: 300,
    });
    assert.deepStrictEqual(asHours(starts), ['14:00']);
});

test('D3: el hueco del final NO se cuela encima de la cita siguiente', () => {
    // La ventana se capa en el inicio de lo ocupado, no en el cierre. Si alguien «arregla»
    // D3 comparando solo contra workEnd, esto se llena de huecos encima de una clienta.
    const starts = computeFreeSlots({
        workStart: M(10), workEnd: M(19),
        occupied: [{ start: M(12), end: M(13) }],
        serviceDuration: 60,
    });
    assert.ok(!asHours(starts).includes('11:30'), 'ofrece un hueco que pisa la cita de las 12:00');
    assert.ok(asHours(starts).includes('11:00'), 'y el que termina justo cuando empieza la cita, sí');
    assert.ok(asHours(starts).includes('18:00'), 'el último de la jornada sigue estando');
});

test('D3 · EL INVARIANTE: nada empieza antes de abrir, nada pasa del cierre, nada pisa', () => {
    // Lo que el medidor comprueba contra la agenda real, aquí contra 3.000 combinaciones.
    // Es la forma de que «no se sale del horario» deje de ser una medida de un día y pase a
    // ser una propiedad: se sostiene con CUALQUIER horario, duración y ocupación.
    let casos = 0;
    for (let ini = 8; ini <= 11; ini++) {
        for (let fin = ini + 1; fin <= 21; fin++) {
            for (const dur of [15, 30, 45, 60, 90, 120, 300]) {
                for (const occupied of [
                    [],
                    [{ start: M(ini), end: M(ini) + 60 }],
                    [{ start: M(fin) - 60, end: M(fin) }],
                    [{ start: M(ini) + 90, end: M(ini) + 150 }, { start: M(fin) - 45, end: M(fin) }],
                ]) {
                    const workStart = M(ini), workEnd = M(fin);
                    const starts = computeFreeSlots({ workStart, workEnd, occupied, serviceDuration: dur });
                    for (const t of starts) {
                        casos++;
                        assert.ok(t >= workStart, `${HH(t)} empieza antes de abrir (${HH(workStart)})`);
                        assert.ok(t + dur <= workEnd,
                            `${HH(t)}+${dur}′ pasa del cierre ${HH(workEnd)}`);
                        for (const o of occupied) {
                            assert.ok(!(t < o.end && t + dur > o.start),
                                `${HH(t)}+${dur}′ pisa ${HH(o.start)}–${HH(o.end)}`);
                        }
                    }
                }
            }
        }
    }
    assert.ok(casos > 3000, `solo se han comprobado ${casos} huecos: el barrido se ha quedado corto`);
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

// Horario REALISTA de Sante: lunes a sábado 10–19 y DOMINGO CERRADO (el día 6 no existe en
// stylist_schedules). El domingo cerrado es esencial aquí: es lo que convierte la ventana
// colapsada de "esta semana" en 0 huecos cuando hoy es viernes o sábado.
function mockDbLunesASabado() {
    db.getStylistsByOrg = async () => [
        { id: VERONIKA_ID, name: 'Veronika', active: true, skills: ['Mechas Balayage'] },
    ];
    db.getStylistSchedule = async () => [0, 1, 2, 3, 4, 5].map(d => (
        { day_of_week: d, start_time: '10:00:00', end_time: '19:00:00' }
    ));
    db.getBlockedDays = async () => [];
    db.getScheduleBlocks = async () => [];
    db.getAppointmentsByStylistAndRange = async () => [];
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

    await testAsync('MARTES + semana:"esta" sin hueco en esa ventana → huecos reales más cercanos, NUNCA 0', async () => {
        // DECISIÓN CAMBIADA (hotfix 25/07/2026). Antes este test exigía `slots.length === 0`
        // con el argumento de que "esta semana ya dejó atrás el lunes → 0 es correcto". En
        // producción ese 0 es justo lo que rompe: el bot recibe totalSlots:0, el LLM lo lee
        // como fallo del sistema (caso 7 del system prompt, "la lista de huecos no carga") y
        // escala a humano teniendo el calendario huecos de sobra. Ahora el fallback suelta el
        // filtro de semana y devuelve los huecos REALES más cercanos: sigue sin inventar nada
        // (todos caen en días que Veronika trabaja), pero ya no hay falso 0.
        await withMockedNow('2026-07-14T09:00:00Z', async () => { // martes 14/07/2026
            const slots = await calendarSante.getAvailableSlots('org-test', {
                serviceDuration: 60,
                serviceCategory: 'Mechas Balayage',
                preferredStylistId: VERONIKA_ID,
                preferencia: { semana: 'esta' },
            });
            assert.ok(slots.length > 0, 'debe ofrecer los huecos reales más cercanos, no un falso 0 que hace escalar');
            // Veronika solo trabaja lunes en este mock → ningún hueco puede caer en otro día.
            assert.ok(slots.every(s => mondayDow(s.fecha) === 0), 'todos los huecos deben ser en lunes (día real de trabajo)');
            assert.strictEqual(slots[0].fecha, '2026-07-20', 'el más cercano es el lunes siguiente, no uno inventado');
            // No se pidió ningún DÍA, solo una semana: la bandera de "día pedido sin hueco"
            // no aplica (la reserva el caso en que la clienta nombra un día concreto).
            assert.ok(!slots.requestedDayUnavailable, 'sin día pedido no debe marcarse requestedDayUnavailable');
        });
    });

    // ─── Ningún día como "hoy" puede producir un falso 0 con semana:"esta" ───────────────
    // Root cause del bug del 24/07: la ventana de "esta semana" va de [inicio_búsqueda ..
    // domingo de esa semana], así que un viernes son 2 días y un sábado 1 solo — y ese único
    // día es el domingo, el que el salón cierra. Con horario real (domingo CERRADO) el motor
    // devolvía 0 y el bot escalaba por error técnico. Se prueban los 7 anclajes de "hoy".
    // (El horario sintético de verify:sante abre los 7 días, y por eso nunca lo detectó.)
    mockDbLunesASabado();

    const ANCLAS = [
        ['lunes', '2026-07-13'], ['martes', '2026-07-14'], ['miércoles', '2026-07-15'],
        ['jueves', '2026-07-16'], ['viernes', '2026-07-17'], ['sábado', '2026-07-18'],
        ['domingo', '2026-07-19'],
    ];
    for (const [diaNombre, anclaISO] of ANCLAS) {
        await testAsync(`HOY=${diaNombre} + semana:"esta" (domingo cerrado) → nunca 0 huecos`, async () => {
            await withMockedNow(`${anclaISO}T09:00:00Z`, async () => {
                const slots = await calendarSante.getAvailableSlots('org-test', {
                    serviceDuration: 60,
                    serviceCategory: 'Mechas Balayage',
                    preferredStylistId: VERONIKA_ID,
                    preferencia: { semana: 'esta' },
                });
                assert.ok(slots.length > 0, `HOY=${diaNombre}: la ventana de "esta semana" no puede vaciar el resultado`);
                assert.ok(slots.every(s => mondayDow(s.fecha) !== 6), 'ningún hueco en domingo (cerrado)');
            });
        });
    }

    // ─── Control: la etapa B del fallback sigue viva ─────────────────────────────────────
    // Cuando el día pedido REALMENTE no tiene hueco (Veronika solo trabaja lunes y se pide
    // domingo), hay que seguir soltando el día para dar alternativas verídicas Y marcar la
    // bandera, que es lo que hace que el bot avise en vez de afirmar que ese día está libre.
    mockDbForVeronika();

    await testAsync('ETAPA B intacta: día pedido sin hueco → alternativas reales + requestedDayUnavailable', async () => {
        await withMockedNow('2026-07-14T09:00:00Z', async () => { // martes 14/07/2026
            const slots = await calendarSante.getAvailableSlots('org-test', {
                serviceDuration: 60,
                serviceCategory: 'Mechas Balayage',
                preferredStylistId: VERONIKA_ID,
                preferencia: { diaSemana: 6 }, // domingo: Veronika no trabaja
            });
            assert.ok(slots.length > 0, 'debe ofrecer alternativas reales');
            assert.strictEqual(slots.requestedDayUnavailable, true, 'debe avisar de que el día pedido no tiene hueco');
            assert.ok(slots.every(s => mondayDow(s.fecha) === 0), 'las alternativas caen en días que sí trabaja (lunes)');
        });
    });

    if (!process.exitCode) console.log('\nTodos los tests de integración getAvailableSlots (domingo/semana) OK');
})();
