/**
 * tests/huecos-alternativas.test.js — El dedupe por fecha-hora ya no tira estilistas.
 *
 * El motor genera una fila por (estilista, fecha, hora) y luego deduplica por (fecha,hora)
 * para no soltarle a la clienta las mismas 10:00 cuatro veces con cuatro nombres. Esa
 * decisión de PRESENTACIÓN es buena y no se toca. Lo que estaba mal es que la fila
 * sobrante se TIRABA, y con ella el dato de que había más gente libre a esa hora.
 *
 * Dos consecuencias, las dos medidas el 13/08/2026 contra el motor real:
 *
 *   1. `db.getStylistsByOrg` ordena `.order('name')` y el sort final solo compara
 *      fecha+hora (estable en V8), así que en cada empate ganaba SIEMPRE la
 *      alfabéticamente primera. Con las cuatro generalistas de Sante —Irina, Natalia,
 *      Veronika, Yulia, mismas skills— Irina se llevaba el 100 % de las ofertas.
 *   2. Peor, y es el bug vivo: bot.js contaba las estilistas distintas SOBRE ESTA LISTA
 *      para decidir si saltarse la pregunta de preferencia ("solo hay una posible, p.ej.
 *      masajes → Larisa"). Colapsadas a una, contaba 1 y fijaba a Irina **sin preguntar
 *      nunca**. La clienta no llegaba a ver la pregunta de estilista.
 *
 * LA PARTE QUE HAY QUE PROTEGER ES LA PARIDAD: la lista devuelta tiene que seguir siendo
 * byte por byte la de antes —mismas horas, mismo orden, misma ganadora—. Si algún día
 * alguien "mejora" esto repartiendo los huecos entre estilistas, esos tests saltan, y esa
 * es una decisión del salón, no del código.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');
const path = require('path');

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

const { getAvailableSlots } = require('../services/calendar-sante');

const jornadaCompleta = () => [0, 1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d, start_time: '10:00', end_time: '19:00' }));

// Las cuatro generalistas reales de Sante: mismas skills, mismo horario. `getStylistsByOrg`
// las entrega ordenadas por nombre, y así se pasan aquí.
const CUATRO = ['Irina', 'Natalia', 'Veronika', 'Yulia'].map((name, i) => ({
    id: `sty-${i + 1}`, name, active: true, skills: ['Cortes'],
}));

const hoy = new Date();
const dia = n => new Date(hoy.getTime() + n * 86400000).toISOString().slice(0, 10);

function conEstilistas(stylists, extra = {}) {
    FIXTURE = {
        stylists,
        schedules: Object.fromEntries(stylists.map(s => [s.id, jornadaCompleta()])),
        ...extra,
    };
}

// Lo que hace bot.js para decidir si se salta la pregunta de estilista.
const contarEstilistas = slots =>
    new Set(slots.flatMap(s => (s.alternativas ?? [{ id: s.stylistId }]).map(a => a.id))).size;

// ─── Paridad: la lista visible no cambia ─────────────────────────────────────────────

test('PARIDAD: una fila por (fecha,hora), en orden cronológico, sin repetir hora', async () => {
    conEstilistas(CUATRO);
    const slots = await getAvailableSlots('org', { serviceDuration: 60, serviceCategory: 'Cortes' });

    const claves = slots.map(s => `${s.fecha} ${s.hora}`);
    assert.strictEqual(new Set(claves).size, claves.length, 'hay una hora repetida en la lista');
    assert.deepStrictEqual(claves, [...claves].sort(), 'la lista no está en orden cronológico');
});

test('PARIDAD: gana la estilista alfabéticamente primera, como antes', async () => {
    conEstilistas(CUATRO);
    const slots = await getAvailableSlots('org', { serviceDuration: 60, serviceCategory: 'Cortes' });
    // Con las cuatro libres a todas horas, la ganadora es siempre Irina. Esto NO es un
    // elogio del reparto: es la conducta que había y que este arreglo no cambia.
    assert.deepStrictEqual([...new Set(slots.map(s => s.stylistName))], ['Irina']);
});

test('PARIDAD: el tope de 20 huecos sigue aplicándose sobre HORAS, no sobre filas', async () => {
    conEstilistas(CUATRO);
    const slots = await getAvailableSlots('org', { serviceDuration: 60, serviceCategory: 'Cortes' });
    assert.strictEqual(slots.length, 20);
});

test('PARIDAD: una sola estilista da exactamente la misma lista que las cuatro', async () => {
    conEstilistas([CUATRO[0]]);
    const sola = await getAvailableSlots('org', { serviceDuration: 60, serviceCategory: 'Cortes' });
    conEstilistas(CUATRO);
    const todas = await getAvailableSlots('org', { serviceDuration: 60, serviceCategory: 'Cortes' });
    assert.deepStrictEqual(
        todas.map(s => `${s.fecha} ${s.hora} ${s.stylistName}`),
        sola.map(s => `${s.fecha} ${s.hora} ${s.stylistName}`),
    );
});

// ─── Lo que se gana: las alternativas ────────────────────────────────────────────────

test('cada hueco lleva a TODAS las estilistas libres a esa hora', async () => {
    conEstilistas(CUATRO);
    const slots = await getAvailableSlots('org', { serviceDuration: 60, serviceCategory: 'Cortes' });
    for (const s of slots) {
        assert.deepStrictEqual(
            s.alternativas.map(a => a.name),
            ['Irina', 'Natalia', 'Veronika', 'Yulia'],
            `el hueco ${s.fecha} ${s.hora} perdió estilistas`,
        );
    }
});

test('la ganadora va SIEMPRE la primera de sus propias alternativas', async () => {
    conEstilistas(CUATRO);
    const slots = await getAvailableSlots('org', { serviceDuration: 60, serviceCategory: 'Cortes' });
    for (const s of slots) {
        assert.strictEqual(s.alternativas[0].id, s.stylistId);
    }
});

test('el ÚLTIMO hueco de la lista también lleva sus alternativas', async () => {
    // El borde del tope: la hora nº 20 no puede quedarse con una sola estilista.
    // NOTA: esto NO protege el `continue` frente a un `break` — probado por mutación, el
    // cambio no tumba nada, porque el sort ya agrupa las filas de una misma hora. Lo que
    // sí protege es que las alternativas lleguen hasta el final de la lista.
    conEstilistas(CUATRO);
    const slots = await getAvailableSlots('org', { serviceDuration: 60, serviceCategory: 'Cortes' });
    assert.strictEqual(slots.at(-1).alternativas.length, 4);
});

test('con una estilista ocupada, ella no figura entre las alternativas de esa hora', async () => {
    const manana = dia(1);
    conEstilistas(CUATRO, {
        appts: { 'sty-1': [{ starts_at: `${manana}T10:00:00+02:00`, ends_at: `${manana}T11:00:00+02:00` }] },
    });
    const slots = await getAvailableSlots('org', { serviceDuration: 60, serviceCategory: 'Cortes' });
    const alas10 = slots.find(s => s.fecha === manana && s.hora === '10:00');
    assert.ok(alas10, 'las 10:00 deberían seguir ofreciéndose: quedan tres estilistas libres');
    const nombres = alas10.alternativas.map(a => a.name);
    assert.ok(!nombres.includes('Irina'), `Irina está ocupada y figura como libre: ${nombres.join(', ')}`);
    assert.deepStrictEqual(nombres, ['Natalia', 'Veronika', 'Yulia']);
    // Y la ganadora pasa a ser la siguiente alfabética, no un hueco sin estilista.
    assert.strictEqual(alas10.stylistName, 'Natalia');
});

// ─── El bug vivo: bot.js contaba sobre la lista colapsada ────────────────────────────

test('BOT: con cuatro estilistas libres se cuentan CUATRO, no una', async () => {
    conEstilistas(CUATRO);
    const slots = await getAvailableSlots('org', { serviceDuration: 60, serviceCategory: 'Cortes' });
    assert.strictEqual(contarEstilistas(slots), 4);
    assert.notStrictEqual(contarEstilistas(slots), 1, 'volvería a fijarse una estilista sin preguntar');
});

test('BOT: con una sola estilista posible se sigue contando UNA (masajes → Larisa)', async () => {
    // El caso que el bloque de bot.js existe para resolver tiene que seguir funcionando:
    // si de verdad solo hay una, se asigna sola y no se pregunta.
    conEstilistas([{ id: 'sty-9', name: 'Larisa', active: true, skills: ['Masajes y SPA'] }]);
    const slots = await getAvailableSlots('org', { serviceDuration: 60, serviceCategory: 'Masajes y SPA' });
    assert.ok(slots.length > 0);
    assert.strictEqual(contarEstilistas(slots), 1);
});

test('BOT: una sesión rehidratada SIN alternativas no rompe la cuenta', async () => {
    // Huecos guardados en SQLite antes de que existiera el campo. El `??` los cubre.
    const viejos = [
        { fecha: '2026-08-20', hora: '10:00', stylistId: 'sty-1' },
        { fecha: '2026-08-20', hora: '11:00', stylistId: 'sty-1' },
    ];
    assert.strictEqual(contarEstilistas(viejos), 1);
});
