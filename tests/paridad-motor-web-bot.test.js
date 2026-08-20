/**
 * tests/paridad-motor-web-bot.test.js — El enlace y el bot ven la MISMA agenda.
 *
 * `getAvailableDays` es lo que la vista de mes del enlace necesita: qué días tienen algún
 * hueco. `getAvailableSlots` es lo que ya usa el bot. La promesa del brief
 * (docs/enlace-publico-reserva.md §3, «el enlace no añade ni una línea de lógica de
 * disponibilidad») es que las dos salgan del MISMO motor, y ese es todo el contenido de este
 * fichero.
 *
 * ── Por qué es la protección que hace falta y no un test más ─────────────────────────────
 *
 * Un segundo motor no falla ruidosamente: falla pintando un día en VERDE que al abrirlo no
 * tiene nada, o en gris uno que sí. La clienta no ve un error, ve una página que le miente
 * y se va. Y como los dos caminos son «correctos» por separado, nadie sabría cuál de los dos
 * arreglar. Por eso la garantía no es un comentario: `prepararMotor` hace el prefetch UNA vez
 * y las dos funciones construyen sus filas con el MISMO `buildSlots`.
 *
 * La forma de la aserción aprovecha algo que ya estaba en el motor: **con `preferencia.fecha`
 * anclada, el tope de resultados deja de aplicarse** (`MAX_TOTAL = Infinity`), así que
 * preguntar por un día concreto devuelve TODOS sus huecos y se puede comparar de verdad,
 * sin que un recorte de presentación disimule una divergencia.
 *
 * ── Las tres diferencias que SÍ tiene el camino web, y son a propósito ───────────────────
 *
 *   · sin tope (una rejilla de 3 meses recortada a 20 filas pinta el resto en gris),
 *   · sin fallback de ETAPA A/B (rescates de conversación; una rejilla ya enseña los días
 *     buenos),
 *   · sin dedupe por hora (un día cuenta sus horas distintas y TODAS sus estilistas).
 *
 * Ninguna de las tres toca qué huecos EXISTEN, que es lo que aquí se compara.
 *
 * ── Sabotajes medidos (20/08/2026), cada uno una forma real de que los dos motores se
 *    separen. Los cinco caen, y los caza el mismo par de bloques: los dos PARIDAD son los
 *    que llevan el peso, y los demás dicen POR DÓNDE se rompió.
 *
 *   1. la rejilla se recorta con el tope de 20 del bot ............................ 2 rojos
 *        («un día que la rejilla NO lista…» + «la rejilla NO tiene tope»)
 *   2. el camino web deja de mirar los días bloqueados ........................... 2 rojos
 *        («cada día de la rejilla…» + «el día bloqueado del salón…»)
 *   3. la rejilla se cablea su propio horizonte de 14 ............................ 2 rojos
 *        (los mismos que el 1: un horizonte propio se ve igual que un tope)
 *   4. un día cuenta FILAS en vez de horas distintas ............................. 2 rojos
 *   5. la rejilla deduplica por hora como el bot y pierde estilistas ............. 2 rojos
 *        («cada día de la rejilla…» + «tres estilistas a las 10:00 son UN hueco»)
 *
 * El horizonte y el prefetch tienen su propio fichero y sus propios sabotajes:
 * `tests/horizonte-y-prefetch.test.js`.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const fs = require('fs');
const { test } = require('node:test');
const path = require('path');

const dbPath = require.resolve(path.join(__dirname, '../services/db.js'));
let FIXTURE = {};
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        getStylistsByOrg: async () => FIXTURE.stylists || [],
        getBlockedDays: async () => FIXTURE.blockedDays || [],
        getStylistSchedule: async (_o, id) => (FIXTURE.schedules || {})[id] || [],
        getScheduleBlocks: async (_o, id) => (FIXTURE.blocks || {})[id] || [],
        getAppointmentsByStylistAndRange: async (_o, id) => (FIXTURE.appts || {})[id] || [],
    },
};

const { getAvailableSlots, getAvailableDays, CAUSAS_CERO } = require('../services/calendar-sante');

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
// 0 = lunes, igual que mondayDow / stylist_schedules.
const dow = fecha => (new Date(fecha + 'T12:00:00Z').getUTCDay() + 6) % 7;

const HORIZONTE = 45;   // suficiente para cruzar varias semanas sin que el test tarde
const DUR = 60;
const CAT = 'Cortes';

// ─── Una agenda con TODAS las formas de "no hay hueco" a la vez ──────────────────────────
// Un fixture donde todo está libre no distingue un motor bueno de uno que no mira nada. Aquí
// hay: días que nadie trabaja (domingo), una estilista a media jornada, un día bloqueado del
// salón entero, un bloqueo de una sola estilista, y citas que parten la jornada.
const EQUIPO = [
    { id: 'sty-irina',    name: 'Irina',    active: true, skills: ['Cortes'] },
    { id: 'sty-natalia',  name: 'Natalia',  active: true, skills: ['Cortes'] },
    { id: 'sty-veronika', name: 'Veronika', active: true, skills: ['Cortes'] },
    { id: 'sty-larisa',   name: 'Larisa',   active: true, skills: ['Masajes y SPA'] },
];

// Irina: L-S 10-19. Natalia: solo martes y jueves, 10-14. Veronika: L-V 15-19.
const HORARIOS = {
    'sty-irina':    [0, 1, 2, 3, 4, 5].map(d => ({ day_of_week: d, start_time: '10:00', end_time: '19:00' })),
    'sty-natalia':  [1, 3].map(d => ({ day_of_week: d, start_time: '10:00', end_time: '14:00' })),
    'sty-veronika': [0, 1, 2, 3, 4].map(d => ({ day_of_week: d, start_time: '15:00', end_time: '19:00' })),
    'sty-larisa':   [0, 1, 2, 3, 4].map(d => ({ day_of_week: d, start_time: '10:00', end_time: '19:00' })),
};

const iso = (fecha, hora) => `${fecha}T${hora}:00+02:00`;

// Los días con significado se ELIGEN por su día de la semana, no por un offset fijo: con un
// `dia(9)` cableado, el fixture cambia de sentido según el día en que se corra el test. La
// primera versión de este fichero cayó justo ahí — el sábado solo trabaja Irina, así que
// bloquearla vaciaba el día entero y el bloque afirmaba lo contrario de lo que quería.
// Entre semana (dow 0-4) trabajan Irina Y Veronika, que es lo que hace observable "quitar a
// una sin cerrar el día".
const entreSemana = desde => {
    for (let n = desde; n <= HORIZONTE; n++) if (dow(dia(n)) <= 4) return n;
    throw new Error('el horizonte no contiene ni un día laborable: revisa HORIZONTE');
};
const N_CERRADO = entreSemana(4);              // el salón entero cierra ese día
const N_BLOQ_IRINA = entreSemana(N_CERRADO + 1); // solo Irina está bloqueada

function agendaCompleta() {
    FIXTURE = {
        stylists: EQUIPO,
        schedules: HORARIOS,
        // Día bloqueado del salón entero (nadie trabaja) y uno solo de Irina.
        blockedDays: [
            { fecha: dia(N_CERRADO), stylist_id: null },
            { fecha: dia(N_BLOQ_IRINA), stylist_id: 'sty-irina' },
        ],
        // Un bloqueo por horas de Veronika, y uno multi-día de Natalia.
        blocks: {
            'sty-veronika': [{ starts_at: iso(dia(2), '15:00'), ends_at: iso(dia(2), '19:00') }],
            'sty-natalia':  [{ starts_at: iso(dia(12), '09:00'), ends_at: iso(dia(14), '20:00') }],
        },
        // Citas que parten la jornada de Irina en varios días.
        appts: {
            'sty-irina': [
                { starts_at: iso(dia(1), '10:00'), ends_at: iso(dia(1), '13:00') },
                { starts_at: iso(dia(3), '10:00'), ends_at: iso(dia(3), '18:30') },
                { starts_at: iso(dia(7), '11:00'), ends_at: iso(dia(7), '12:00') },
            ],
        },
    };
}

const pedirDias = (opts = {}) =>
    getAvailableDays('org', { serviceDuration: DUR, serviceCategory: CAT, horizonteDias: HORIZONTE, ...opts });
const pedirHuecos = (opts = {}) =>
    getAvailableSlots('org', { serviceDuration: DUR, serviceCategory: CAT, horizonteDias: HORIZONTE, ...opts });

// ─── PARIDAD: lo que la rejilla promete, el día lo cumple ────────────────────────────────

test('PARIDAD: cada día de la rejilla tiene EXACTAMENTE esos huecos al abrirlo', async () => {
    agendaCompleta();
    const dias = await pedirDias();
    assert.ok(dias.length > 0, 'la rejilla no devolvió ningún día: el fixture no prueba nada');

    for (const d of dias) {
        const huecos = await pedirHuecos({ preferencia: { fecha: d.fecha } });
        // Con la fecha anclada NO hay tope (MAX_TOTAL = Infinity), así que esto compara
        // listas enteras y no dos recortes.
        assert.strictEqual(huecos.requestedDayUnavailable, false,
            `la rejilla da ${d.fecha} por bueno y el motor no encontró nada ese día`);
        const horas = new Set(huecos.map(s => s.hora));
        assert.strictEqual(horas.size, d.huecos,
            `${d.fecha}: la rejilla dice ${d.huecos} huecos y el día tiene ${horas.size}`);

        const deLaRejilla = d.estilistas.map(e => e.name).sort();
        const delDia = [...new Set(huecos.flatMap(s => s.alternativas.map(a => a.name)))].sort();
        assert.deepStrictEqual(delDia, deLaRejilla,
            `${d.fecha}: la rejilla dice ${deLaRejilla.join(', ')} y el día da ${delDia.join(', ')}`);
    }
});

test('PARIDAD: un día que la rejilla NO lista no tiene ni un hueco', async () => {
    // La otra mitad, y la que caza el motor perezoso: uno que devolviera solo los primeros
    // días pasaría el bloque anterior entero.
    agendaCompleta();
    const dias = await pedirDias();
    const conHueco = new Set(dias.map(d => d.fecha));
    let comprobados = 0;

    for (let n = 1; n <= HORIZONTE; n++) {
        const fecha = dia(n);
        if (conHueco.has(fecha)) continue;
        comprobados += 1;
        const huecos = await pedirHuecos({ preferencia: { fecha } });
        assert.ok(huecos.every(s => s.fecha !== fecha),
            `${fecha} no está en la rejilla pero el motor sí ofrece huecos ese día`);
    }
    assert.ok(comprobados > 0, 'no hubo ni un día sin huecos: el fixture no prueba la otra mitad');
});

test('PARIDAD: el día bloqueado del salón no aparece en ninguna de las dos', async () => {
    agendaCompleta();
    const fecha = dia(N_CERRADO);
    const dias = await pedirDias();
    assert.ok(!dias.some(d => d.fecha === fecha), 'el día bloqueado del salón está en la rejilla');
    const huecos = await pedirHuecos({ preferencia: { fecha } });
    assert.ok(huecos.every(s => s.fecha !== fecha), 'el día bloqueado del salón tiene huecos');
});

test('PARIDAD: el bloqueo de UNA estilista la quita de ese día, no el día entero', async () => {
    agendaCompleta();
    const fecha = dia(N_BLOQ_IRINA);
    const dias = await pedirDias();
    const bloqueada = dias.find(d => d.fecha === fecha);
    assert.ok(bloqueada, `${fecha} es laborable y debería seguir teniendo huecos de las demás`);
    assert.ok(!bloqueada.estilistas.some(e => e.name === 'Irina'),
        'Irina tiene el día bloqueado y la rejilla la da por libre');
    // Y el camino del bot dice lo mismo ese día: la paridad también vale para QUIÉN.
    const huecos = await pedirHuecos({ preferencia: { fecha } });
    assert.ok(huecos.every(s => s.alternativas.every(a => a.name !== 'Irina')),
        'Irina está bloqueada y el motor la ofrece al bot');
});

// ─── Lo que la rejilla hace DISTINTO, y es a propósito ───────────────────────────────────

test('la rejilla NO tiene tope: llega hasta el final del horizonte', async () => {
    // El MAX_TOTAL de 20 es una decisión de conversación. Aplicado a tres meses de
    // calendario, pintaría de gris todo lo que hay después de los primeros días.
    agendaCompleta();
    const dias = await pedirDias();
    assert.ok(dias.length > 20, `la rejilla se quedó en ${dias.length} días: parece recortada por el tope del bot`);
    const ultimoUtil = [...Array(HORIZONTE).keys()]
        .map(i => dia(HORIZONTE - i))
        .find(f => dow(f) !== 6);
    assert.ok(dias.some(d => d.fecha === ultimoUtil),
        `el último día laborable del horizonte (${ultimoUtil}) no llegó a la rejilla`);
});

test('la lista del BOT sí sigue teniendo su tope de 20 — la rejilla no se lo ha llevado', async () => {
    agendaCompleta();
    const huecos = await pedirHuecos({});
    assert.strictEqual(huecos.length, 20);
});

test('la rejilla va en orden cronológico y sin repetir día', async () => {
    agendaCompleta();
    const dias = await pedirDias();
    const fechas = dias.map(d => d.fecha);
    assert.strictEqual(new Set(fechas).size, fechas.length, 'hay un día repetido');
    assert.deepStrictEqual(fechas, [...fechas].sort(), 'la rejilla no está en orden cronológico');
});

test('un día cuenta HORAS distintas, no filas: tres estilistas a las 10:00 son UN hueco', async () => {
    // Sin esto, un día con cuatro generalistas libres diría "64 huecos" y la clienta abriría
    // el día esperando 64 opciones. La rejilla cuenta lo que se puede elegir.
    FIXTURE = {
        stylists: EQUIPO.filter(s => s.skills.includes('Cortes')),
        schedules: {
            'sty-irina':    [{ day_of_week: dow(dia(1)), start_time: '10:00', end_time: '12:00' }],
            'sty-natalia':  [{ day_of_week: dow(dia(1)), start_time: '10:00', end_time: '12:00' }],
            'sty-veronika': [{ day_of_week: dow(dia(1)), start_time: '10:00', end_time: '12:00' }],
        },
        blockedDays: [], blocks: {}, appts: {},
    };
    const dias = await pedirDias();
    const d = dias.find(x => x.fecha === dia(1));
    assert.ok(d, 'el día de prueba no salió');
    // 10:00-12:00 con servicio de 60 min y paso de 30: solo cabe empezar a las 10:00
    // (10:30 terminaría a las 11:30 < 12:00, así que también entra). Lo que importa es que
    // sean HORAS y no filas: tres estilistas no multiplican por tres.
    const huecos = await pedirHuecos({ preferencia: { fecha: dia(1) } });
    assert.strictEqual(d.huecos, new Set(huecos.map(s => s.hora)).size);
    assert.deepStrictEqual(d.estilistas.map(e => e.name), ['Irina', 'Natalia', 'Veronika']);
});

// ─── La causa del cero viaja igual por los dos caminos ───────────────────────────────────

test('un cero de la rejilla NUNCA es un [] pelado: lleva la misma causa que el bot', async () => {
    agendaCompleta();
    const sinSkill = await getAvailableDays('org', {
        serviceDuration: DUR, serviceCategory: 'Extensiones', horizonteDias: HORIZONTE,
    });
    assert.strictEqual(sinSkill.length, 0);
    assert.strictEqual(sinSkill.causa, CAUSAS_CERO.SIN_SKILL);

    // Y la misma pregunta al camino del bot da la MISMA causa: si divergieran, la web diría
    // "está todo cogido" donde el bot dice "nadie hace eso", y son dos cosas distintas.
    const mismaAlBot = await getAvailableSlots('org', {
        serviceDuration: DUR, serviceCategory: 'Extensiones', horizonteDias: HORIZONTE,
    });
    assert.strictEqual(mismaAlBot.causa, sinSkill.causa);
});

test('un servicio que no cabe en ninguna jornada da no_cabe, no agenda_llena', async () => {
    agendaCompleta();
    const dias = await getAvailableDays('org', {
        serviceDuration: 10 * 60, serviceCategory: CAT, horizonteDias: HORIZONTE,
    });
    assert.strictEqual(dias.length, 0);
    assert.strictEqual(dias.causa, CAUSAS_CERO.NO_CABE);
});

test('con huecos, la causa es null en los dos caminos', async () => {
    agendaCompleta();
    assert.strictEqual((await pedirDias()).causa, null);
    assert.strictEqual((await pedirHuecos({})).causa, null);
});

// ─── San Remo: estructuralmente fuera ────────────────────────────────────────────────────

test('SAN REMO: su motor no tiene getAvailableDays, y el del salón solo se alcanza por orgType', () => {
    // Dos puertas, y las dos son estructurales y no de configuración:
    //   1. El motor de mesas de San Remo (services/calendar.js) ni siquiera exporta la
    //      función: no hay nada que llamar por error.
    //   2. El único camino del bot hasta calendar-sante está dentro de la rama
    //      `session.orgType === 'salon'`; el `else` es el mock de mesas.
    const sanRemo = require('../services/calendar.js');
    assert.strictEqual(sanRemo.getAvailableDays, undefined,
        'el motor de San Remo ha empezado a exponer la rejilla del salón');

    const bot = fs.readFileSync(path.join(__dirname, '../bot.js'), 'utf8');
    const gate = bot.indexOf("if (session.orgType === 'salon')");
    const primeraSante = bot.indexOf('calendarSante.getAvailableSlots');
    assert.ok(gate > 0 && primeraSante > gate,
        'el motor del salón se alcanza antes del gate de orgType: San Remo dejaría de estar fuera por construcción');
});
