/**
 * tests/bloqueo-multidia.test.js — Un bloqueo (o una cita) que cruza la medianoche.
 *
 * El fallo: `toMinutes` devuelve el minuto DEL DÍA y tira la fecha. Aplicado a los dos
 * extremos de un intervalo que empieza un día y acaba otro, el resultado no es ese
 * intervalo, y falla de DOS formas distintas — por eso hay dos familias de casos aquí:
 *
 *   (a) INVERTIDO — 14 a las 18:00 → 15 a las 13:00 daba {start:1080, end:780}.
 *       En computeFreeSlots el `cursor` no avanza y el día entero queda libre: el bloqueo
 *       no bloquea ni siquiera su propio día de inicio.
 *   (b) NO INVERTIDO — 14 a las 12:00 → 15 a las 16:00 daba {start:720, end:960}, que
 *       parece sano. Se aplica como "de 12:00 a 16:00" en LOS DOS días: el 14 se ofrece de
 *       16:00 en adelante y el 15 de 10:00 a 12:00, con la estilista fuera las dos veces.
 *
 * Es el que más engaña de los dos: no hay ningún síntoma raro que mirar, solo huecos
 * ofrecidos de más. Medido el 13/08/2026 contra el motor real.
 *
 * Hoy los 7 bloqueos de Sante son de un solo día, así que esto es una red PREVENTIVA: el
 * día que alguien cargue unas vacaciones como un bloque largo, salta aquí y no en la
 * agenda de una clienta. El control de "un solo día" fija que ese camino no cambia.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');
const path = require('path');

// ─── Stub de la capa db, ANTES de requerir el motor ───────────────────────────────────
const dbPath = require.resolve(path.join(__dirname, '../services/db.js'));
let FIXTURE = {};
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        getStylistsByOrg: async () => FIXTURE.stylists || [],
        getBlockedDays: async () => [],
        getStylistSchedule: async (_o, id) => (FIXTURE.schedules || {})[id] || [],
        getScheduleBlocks: async (_o, id) => (FIXTURE.blocks || {})[id] || [],
        getAppointmentsByStylistAndRange: async (_o, id) => (FIXTURE.appts || {})[id] || [],
    },
};

const { getAvailableSlots, _internals } = require('../services/calendar-sante');
const { recortarAlDia } = _internals;

const ESTILISTA = { id: 'sty-1', name: 'Irina', active: true, skills: ['Cortes'] };
const jornadaCompleta = () => [0, 1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d, start_time: '10:00', end_time: '19:00' }));

// Fechas relativas: el motor solo mira de mañana en adelante.
// El día se corta en hora de MADRID, que es donde vive el motor (BUSINESS_TZ) — no en UTC.
// Con toISOString() (UTC), entre las 00:00 y las 02:00 de Madrid "mañana" salía HOY y los
// tres bloques de bloqueo fallaban solo a esas horas (visto el 14/08/2026 a las ~00:30:
// rojo con UTC, verde con Madrid, sin tocar nada más).
// El HOY en hora de MADRID, no UTC: entre las 00:00 y las 02:00 de Madrid toISOString()
// daría el día anterior.
const HOY_STR = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
// Días de CALENDARIO, con la misma función que usa el motor (`addDaysStr`), no sumando
// 86 400 000 ms. Los milisegundos y los días de calendario dejan de coincidir en cuanto se
// cruza un cambio de hora: el 21/08/2026, con el horizonte ya en 90 días, `hoy + 90*86400000`
// caía en el 18 de noviembre y el día 90 del motor era el 19 — porque el 25 de octubre
// Madrid pasa a invierno y ese día dura 25 horas. El motor cuenta fechas (addDaysStr, UTC
// puro) y es inmune; el test contaba tiempo y se puso rojo solo, de un día para otro.
const { addDaysStr } = require('../services/date-utils');
const dia = n => addDaysStr(HOY_STR, n);
const D1 = dia(1), D2 = dia(2);

async function horasDe(bloque, fecha, { serviceDuration = 30 } = {}) {
    FIXTURE = {
        stylists: [ESTILISTA],
        schedules: { 'sty-1': jornadaCompleta() },
        blocks: { 'sty-1': bloque ? [bloque] : [] },
    };
    const slots = await getAvailableSlots('org', { serviceDuration, serviceCategory: 'Cortes' });
    return slots.filter(s => s.fecha === fecha).map(s => s.hora);
}

// ─── La función pura ─────────────────────────────────────────────────────────────────

test('recortarAlDia: un intervalo de un solo día se devuelve tal cual', () => {
    assert.deepStrictEqual(
        recortarAlDia(`${D1}T15:00:00+02:00`, `${D1}T18:00:00+02:00`, D1),
        { start: 15 * 60, end: 18 * 60 },
    );
});

test('recortarAlDia: el día de INICIO se recorta hasta el final del día', () => {
    // 18:00 → medianoche. Antes daba end=780 (13:00), o sea un intervalo invertido.
    assert.deepStrictEqual(
        recortarAlDia(`${D1}T18:00:00+02:00`, `${D2}T13:00:00+02:00`, D1),
        { start: 18 * 60, end: 24 * 60 },
    );
});

test('recortarAlDia: el día de FIN se recorta desde el principio del día', () => {
    assert.deepStrictEqual(
        recortarAlDia(`${D1}T18:00:00+02:00`, `${D2}T13:00:00+02:00`, D2),
        { start: 0, end: 13 * 60 },
    );
});

test('recortarAlDia: un día CENTRAL queda ocupado entero', () => {
    const D3 = dia(3);
    assert.deepStrictEqual(
        recortarAlDia(`${D1}T18:00:00+02:00`, `${D3}T13:00:00+02:00`, D2),
        { start: 0, end: 24 * 60 },
    );
});

test('recortarAlDia: un día que el intervalo no toca devuelve null', () => {
    assert.strictEqual(recortarAlDia(`${D1}T10:00:00+02:00`, `${D1}T12:00:00+02:00`, D2), null);
    assert.strictEqual(recortarAlDia(`${D2}T10:00:00+02:00`, `${D2}T12:00:00+02:00`, D1), null);
});

test('recortarAlDia: fechas ilegibles o intervalo vacío devuelven null y no ocupan nada', () => {
    assert.strictEqual(recortarAlDia('no-es-una-fecha', `${D1}T12:00:00+02:00`, D1), null);
    assert.strictEqual(recortarAlDia(`${D1}T12:00:00+02:00`, `${D1}T12:00:00+02:00`, D1), null);
    // Un intervalo ya invertido en origen NO se cuela: se descarta en vez de dejar el día
    // abierto sin que nadie se entere (regla 3).
    assert.strictEqual(recortarAlDia(`${D1}T18:00:00+02:00`, `${D1}T10:00:00+02:00`, D1), null);
});

// ─── El motor de verdad ──────────────────────────────────────────────────────────────

test('(a) INVERTIDO: el bloqueo muerde en su propio día de inicio', async () => {
    // 18:00 → 19:00 del día 1 está bloqueado. Con servicio de 30' el último hueco es 17:30.
    const horas = await horasDe({ starts_at: `${D1}T18:00:00+02:00`, ends_at: `${D2}T13:00:00+02:00` }, D1);
    assert.ok(!horas.includes('18:00'), `18:00 no debería ofrecerse, salió: ${horas.join(' ')}`);
    assert.strictEqual(horas.at(-1), '17:30');
});

test('(a) INVERTIDO: el bloqueo muerde la mañana del día de fin', async () => {
    const horas = await horasDe({ starts_at: `${D1}T18:00:00+02:00`, ends_at: `${D2}T13:00:00+02:00` }, D2);
    for (const h of ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30']) {
        assert.ok(!horas.includes(h), `${h} está dentro del bloqueo y se ofreció: ${horas.join(' ')}`);
    }
    assert.strictEqual(horas[0], '13:00');
});

test('(b) NO INVERTIDO: no se aplica la MISMA franja a los dos días', async () => {
    const bloque = { starts_at: `${D1}T12:00:00+02:00`, ends_at: `${D2}T16:00:00+02:00` };

    // Día de inicio: de 12:00 en adelante la estilista ya no está.
    const dia1 = await horasDe(bloque, D1);
    assert.deepStrictEqual(dia1, ['10:00', '10:30', '11:00', '11:30']);

    // Día de fin: hasta las 16:00 tampoco. Antes se ofrecía 10:00–12:00 aquí.
    const dia2 = await horasDe(bloque, D2);
    assert.strictEqual(dia2[0], '16:00');
    assert.ok(!dia2.includes('10:00'), `10:00 del día de fin está bloqueado y se ofreció: ${dia2.join(' ')}`);
});

test('CONTROL: un bloqueo de un solo día se comporta EXACTAMENTE igual que antes', async () => {
    const horas = await horasDe({ starts_at: `${D1}T15:00:00+02:00`, ends_at: `${D1}T18:00:00+02:00` }, D1);
    assert.deepStrictEqual(horas, [
        '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30',
        // Tras el bloqueo quedan DOS, no uno: 18:30→19:00 termina justo al cierre y es un
        // hueco legítimo. Hasta el 20/08/2026 aquí ponía «18:30 no cabe antes del cierre
        // (guard deliberado)» — el guard era el defecto D3, y este test lo congelaba.
        '18:00', '18:30',
    ]);
});

test('CONTROL: el día siguiente a un bloqueo de un solo día queda intacto', async () => {
    const horas = await horasDe({ starts_at: `${D1}T15:00:00+02:00`, ends_at: `${D1}T18:00:00+02:00` }, D2);
    assert.strictEqual(horas[0], '10:00');
});

test('Una CITA que cruza la medianoche también bloquea el día siguiente', async () => {
    // Misma clase de fallo por el mismo motivo, y por eso pasa por el mismo recorte.
    FIXTURE = {
        stylists: [ESTILISTA],
        schedules: { 'sty-1': jornadaCompleta() },
        appts: { 'sty-1': [{ starts_at: `${D1}T18:00:00+02:00`, ends_at: `${D2}T13:00:00+02:00` }] },
    };
    const slots = await getAvailableSlots('org', { serviceDuration: 30, serviceCategory: 'Cortes' });
    const dia2 = slots.filter(s => s.fecha === D2).map(s => s.hora);
    assert.strictEqual(dia2[0], '13:00');
});
