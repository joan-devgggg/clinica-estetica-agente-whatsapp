/**
 * verify-sante-robustez.js — Prueba en seco ADVERSARIAL del bot de Sante.
 *
 * Complementa a verify:sante. Aquél verifica que el camino FELIZ funciona para todo el
 * catálogo; éste ataca los caminos de FALLO: qué hace el bot cuando no entiende algo,
 * cuando la BD falla, cuando la clienta escribe algo que nadie previó.
 *
 * Motivación (auditoría 28/07/2026): la única sesión real registrada terminó con el bot
 * diciendo "problema técnico" y escalando, sobre un sábado con dos estilistas libres
 * 10:00–19:00, cero bloqueos y cero citas. El cero de huecos fue espurio y el logging
 * actual no permite saber por qué. Antes del broadcast a ~698 contactos hay que
 * reproducir eso en frío.
 *
 *   NIVEL A (este fichero, sin LLM, segundos, 0 tokens)
 *     A1  Nombres de estilista mal escritos → ¿match o silencio?
 *     A2  Expresiones de fecha que nadie ha probado → ¿señal correcta?
 *     A3  Las 5 causas distintas de "[] huecos" → ¿son distinguibles?
 *     A4  Errores de BD → ¿se degradan a "no hay huecos" o a disponibilidad fantasma?
 *     A5  Media que no es audio por Cloud API → ¿responde algo o silencio?
 *
 *   NIVEL B (tests/verify-sante-robustez-llm.js, con LLM real)
 *     Escenarios conversacionales completos, incluida la repro de la sesión de Eva.
 *
 * Uso:  npm run verify:robustez          (necesita SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 *
 * Clasificación de resultados:
 *   OK   la defensa existe y funciona
 *   GAP  deficiencia conocida y CUANTIFICADA, fuera del alcance del arreglo en curso
 *        (no marca el proceso como fallido: es medición, no regresión)
 *   BUG  lo que la Fase 2 debe arreglar. Hace fallar el proceso A PROPÓSITO hasta entonces.
 *
 * NOTA: no forma parte de `npm test` (hermético, sin credenciales). No toca San Remo.
 */
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Madrid';

const { SANTE_ORG_ID: ORG } = require('../services/org-registry');
const db = require('../services/db');
const supabase = require('../services/supabase');
const calendarSante = require('../services/calendar-sante');
const {
    extractStylistFromText,
    extractDateSignalSante,
    normalizeText,
} = require('../services/helpers');
const { applyDatePreference } = require('../services/date-preference');
const { resolveWeekdayToDate } = require('../services/date-utils');
const { buildInboundAdapters } = require('../services/providers/threesixty-dialog');

// ─── Runner ──────────────────────────────────────────────────────────────────────────
const rows = [];
const counts = { OK: 0, GAP: 0, BUG: 0 };
function probe(bloque, estado, etiqueta, detalle) {
    rows.push({ bloque, estado, etiqueta, detalle: detalle || '' });
    counts[estado]++;
    if (estado === 'BUG') process.exitCode = 1;
}
const ok = (b, l, d) => probe(b, 'OK', l, d);
const gap = (b, l, d) => probe(b, 'GAP', l, d);
const bug = (b, l, d) => probe(b, 'BUG', l, d);

// ─── Mock de `Date` (mismo patrón que verify-sante-catalog.js) ───────────────────────
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
    try { return await fn(); } finally { global.Date = RealDate; }
}

// Horario sintético abierto: 10–19 los 7 días, sin citas ni bloqueos. Sobre esto, un 0 de
// huecos SIEMPRE tiene una causa concreta y nombrable — nunca es ruido de agenda.
const SCHEDULE_ABIERTO = [0, 1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d, start_time: '10:00:00', end_time: '19:00:00' }));

function stubDb({ stylists, schedule = SCHEDULE_ABIERTO, appointments = [], blockedDays = [], blocks = [] }) {
    const real = {
        getStylistsByOrg: db.getStylistsByOrg,
        getStylistSchedule: db.getStylistSchedule,
        getBlockedDays: db.getBlockedDays,
        getScheduleBlocks: db.getScheduleBlocks,
        getAppointmentsByStylistAndRange: db.getAppointmentsByStylistAndRange,
    };
    db.getStylistsByOrg = async () => stylists;
    db.getStylistSchedule = async () => (typeof schedule === 'function' ? schedule() : schedule);
    db.getBlockedDays = async () => blockedDays;
    db.getScheduleBlocks = async () => blocks;
    db.getAppointmentsByStylistAndRange = async (...a) =>
        (typeof appointments === 'function' ? appointments(...a) : appointments);
    return () => Object.assign(db, real);
}

// Silencia los console.log de depuración de calendar-sante durante las baterías.
function silenced(fn) {
    const orig = {};
    for (const m of ['log', 'info', 'warn', 'debug']) { orig[m] = console[m]; console[m] = () => {}; }
    return Promise.resolve(fn()).finally(() => Object.assign(console, orig));
}

// Query de Supabase que SIEMPRE falla, encadenable como la real.
// Reproduce lo que devuelve supabase-js ante RLS denegado / timeout / error de red.
function failingQuery(error) {
    const q = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'then') return (resolve) => resolve({ data: null, error, count: null });
            if (prop === 'catch' || prop === 'finally') return () => q;
            return () => q;
        },
    });
    return q;
}

// Query de Supabase que siempre resuelve con `data`, encadenable como la real.
function succeedingQuery(data) {
    const q = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'then') return (resolve) => resolve({ data, error: null, count: null });
            if (prop === 'catch' || prop === 'finally') return () => q;
            return () => q;
        },
    });
    return q;
}

// Hace fallar SOLO las lecturas de `tabla`; el resto pasa al Supabase real.
function stubSupabaseFailFor(tabla, error = { message: 'simulated failure', code: 'PGRST000' }) {
    const realFrom = supabase.from.bind(supabase);
    supabase.from = (t) => (t === tabla ? failingQuery(error) : realFrom(t));
    return () => { supabase.from = realFrom; };
}

// Devuelve `data` para `tabla`; el resto pasa al Supabase real.
function stubSupabaseReturnFor(tabla, data) {
    const realFrom = supabase.from.bind(supabase);
    supabase.from = (t) => (t === tabla ? succeedingQuery(data) : realFrom(t));
    return () => { supabase.from = realFrom; };
}

const addDays = (dateStr, n) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};

// 13/07/2026 es lunes → anclas Lun..Dom conocidas.
const ANCHORS = [
    ['lunes', '2026-07-13'], ['martes', '2026-07-14'], ['miércoles', '2026-07-15'],
    ['jueves', '2026-07-16'], ['viernes', '2026-07-17'], ['sábado', '2026-07-18'], ['domingo', '2026-07-19'],
];

(async () => {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('❌ Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env');
        process.exit(1);
    }
    const cfg = await db.getAgentConfig(ORG);
    const catalog = Array.isArray(cfg?.services) ? cfg.services : [];
    const stylists = await db.getStylistsByOrg(ORG);
    if (!catalog.length || !stylists.length) {
        console.error('❌ Catálogo o estilistas vacíos — revisa credenciales/ORG.');
        process.exit(1);
    }
    console.log(`\nSante: ${catalog.length} servicios · ${stylists.length} estilistas activas\n`);

    // ═══ A1 — Nombres de estilista ════════════════════════════════════════════════════
    // El matching es un String.includes() puro (helpers.js:512-531). Aquí se cuantifica
    // exactamente qué variantes reales de escritura se pierden, para dimensionar la
    // tabla de alias que haría falta.
    console.log('▶ A1 · Reconocimiento de estilista');
    const variantes = [
        // [texto de la clienta, nombre que espera acertar]
        ['quiero con Irina', 'Irina'],
        ['con IRINA por favor', 'Irina'],
        ['con irina', 'Irina'],
        ['me gustaría con Verónika', 'Veronika'],
        ['con veronika', 'Veronika'],
        ['con Yulia', 'Yulia'],
        ['con Yulia-Tricóloga', 'Yulia-Tricóloga'],
        ['con la tricologa Yulia', 'Yulia-Tricóloga'],
        ['con Olgha', 'Olgha'],
        ['con Larisa', 'Larisa'],
        ['con Tetiana', 'Tetiana'],
        ['con Natalia', 'Natalia'],
        // Variantes que una clienta real escribiría — hoy TODAS fallan
        ['con Olga', 'Olgha'],
        ['quiero con Veronica', 'Veronika'],
        ['con Verónica', 'Veronika'],
        ['con Julia', 'Yulia'],
        ['con Tatiana', 'Tetiana'],
        ['con Larissa', 'Larisa'],
        ['con Irinaa', 'Irina'],
        ['con Nataly', 'Natalia'],
        ['con Vero', 'Veronika'],
        ['con Irina 😊', 'Irina'],
    ];
    let fallos = [];
    for (const [texto, esperado] of variantes) {
        const m = extractStylistFromText(texto, stylists);
        const acertado = m && normalizeText(m.name) === normalizeText(esperado);
        if (acertado) ok('A1', `"${texto}" → ${esperado}`);
        else { fallos.push(texto); gap('A1', `"${texto}" → ${m ? m.name : 'SIN MATCH'}`, `esperado ${esperado}`); }
    }
    console.log(`   ${variantes.length - fallos.length}/${variantes.length} reconocidas · ${fallos.length} perdidas`);

    // El punto clave no es que falle el match: es que al fallar NO se dice nada.
    // Se comprueba que no existe ningún mensaje de "no encuentro a esa estilista".
    const botSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'bot.js'), 'utf8');
    const hayMsgEstilista = /no (te )?(he )?(encontrado|reconozco|localizo)[^\n]{0,40}estilista|esa estilista no/i.test(botSrc);
    if (hayMsgEstilista) ok('A1', 'existe mensaje de estilista no reconocida');
    else gap('A1', 'NO existe mensaje de estilista no reconocida', 'la petición se descarta en silencio (bot.js:2328-2341, 2766-2773)');

    // ═══ A2 — Expresiones de fecha ════════════════════════════════════════════════════
    // Se afirma la SEÑAL producida, que es lo que decide qué días busca el motor.
    console.log('▶ A2 · Interpretación de fecha/hora');
    const HOY = '2026-07-16T09:00:00';   // jueves 16/07/2026, 09:00 Madrid
    await withMockedNow(HOY, async () => {
        const casos = [
            // [texto, predicado sobre la señal, descripción de lo esperado, severidad si falla]
            ['el jueves', s => s.diaSemana === 3, 'diaSemana=3', 'BUG'],
            ['la semana que viene', s => s.semana === 'siguiente', "semana='siguiente'", 'BUG'],
            ['esta semana', s => s.semana === 'esta', "semana='esta'", 'BUG'],
            ['lo antes posible', s => s.asap === true, 'asap fuerte', 'BUG'],
            ['el más cercano', s => s.asapWeak === true, 'asap débil', 'BUG'],
            ['el 24', s => !!s.fecha, 'fecha absoluta', 'BUG'],
            ['por la mañana', s => s.periodo === 'mañana', "periodo='mañana'", 'BUG'],
            // Los que hoy se pierden o se interpretan mal
            ['hoy', s => s.asap === true, 'asap (para poder ofrecer HOY)', 'GAP'],
            ['mañana', s => !!s.fecha, 'la fecha de mañana', 'GAP'],
            ['pasado mañana', s => !!s.fecha, 'fecha a +2 días', 'GAP'],
            ['el finde', s => !!s.fecha || Number.isInteger(s.diaSemana), 'sáb/dom', 'GAP'],
            ['el fin de semana', s => !!s.fecha || Number.isInteger(s.diaSemana), 'sáb/dom', 'GAP'],
            ['a mediodía', s => !!s.periodo, 'alguna franja', 'GAP'],
            ['el jueves 16h', s => !s.fecha, 'NO leer 16 como día del mes', 'GAP'],
            ['dame el siguiente hueco', s => s.semana !== 'siguiente', 'NO saltar a la semana que viene', 'GAP'],
        ];
        for (const [texto, pred, esperado, sev] of casos) {
            const s = extractDateSignalSante(texto);
            const resumen = JSON.stringify(s);
            if (pred(s)) ok('A2', `"${texto}" → ${esperado}`);
            else if (sev === 'BUG') bug('A2', `"${texto}" NO produce ${esperado}`, resumen);
            else gap('A2', `"${texto}" NO produce ${esperado}`, resumen);
        }

        // "hoy" end-to-end: ¿puede el motor llegar a ofrecer un hueco de HOY?
        const sHoy = extractDateSignalSante('quiero cita hoy');
        const prefHoy = applyDatePreference({}, sHoy, new Date());
        if (prefHoy.asap) ok('A2', '"hoy" permite arrancar la búsqueda en el día actual');
        else gap('A2', '"hoy" NUNCA puede devolver un hueco de hoy',
            `preferencia=${JSON.stringify(prefHoy)} → startDate=mañana (calendar-sante.js:67)`);
    });

    // Ventana "esta semana" en los 7 días de la semana: el reducer no tiene guard de
    // colapso y el motor sí. Se comprueba que la combinación no deja a nadie sin fecha.
    for (const [dia, fecha] of ANCHORS) {
        await withMockedNow(`${fecha}T09:00:00`, async () => {
            const sinResolver = [];
            for (let d = 0; d <= 6; d++) {
                if (resolveWeekdayToDate(new Date(), d, 'esta') === null) sinResolver.push(d);
            }
            // Que algunos días no caigan en "esta semana" es correcto (ya pasaron). Lo que
            // se vigila es el colapso total: ningún día resoluble.
            if (sinResolver.length === 7) {
                bug('A2', `"esta semana" en ${dia}: NINGÚN día de la semana resoluble`, 'ventana colapsada a 0');
            } else {
                ok('A2', `"esta semana" en ${dia}: ${7 - sinResolver.length}/7 días resolubles`);
            }
        });
    }

    // ═══ A3 — Las 5 causas de "[] huecos" ═════════════════════════════════════════════
    // Éste es el test que valida la Fase 2.2: hoy las cinco son indistinguibles para el
    // llamador, y por eso un salón lleno se comunica como avería técnica.
    console.log('▶ A3 · Causas distinguibles de cero huecos');
    const catConSkill = stylists.find(s => (s.skills || []).length)?.skills?.[0];
    const svcDeEsaCat = catalog.find(s => normalizeText(s.categoria) === normalizeText(catConSkill));
    const durNormal = svcDeEsaCat?.duracion || 60;
    const elegibles = stylists.filter(s => (s.skills || []).some(k => normalizeText(k) === normalizeText(catConSkill)));

    const escenarios = [
        {
            causa: 'sin_estilistas',
            desc: 'la org no tiene ninguna estilista activa',
            stub: { stylists: [] },
            args: { serviceDuration: durNormal, serviceCategory: catConSkill },
        },
        {
            causa: 'sin_skill',
            desc: 'ninguna estilista tiene la skill del servicio',
            stub: { stylists },
            args: { serviceDuration: 60, serviceCategory: 'Categoria Que No Existe ZZZ' },
        },
        {
            causa: 'sin_horario',
            desc: 'la estilista no tiene ninguna fila de horario (no trabaja nunca)',
            stub: { stylists: elegibles, schedule: [] },
            args: { serviceDuration: durNormal, serviceCategory: catConSkill },
        },
        {
            causa: 'no_cabe_antes_del_cierre',
            desc: 'el servicio no cabe en la jornada (600 min en 10–19)',
            stub: { stylists: elegibles },
            args: { serviceDuration: 600, serviceCategory: catConSkill },
        },
        {
            causa: 'agenda_llena',
            desc: 'hay horario y skill, pero todo está reservado',
            stub: {
                stylists: elegibles,
                // Una cita que tapa 10:00–19:00 todos los días del rango consultado.
                appointments: (_org, stylistId, from, to) => {
                    const out = [];
                    let d = String(from).slice(0, 10);
                    const end = String(to).slice(0, 10);
                    while (d <= end) {
                        out.push({ id: `x${d}`, stylist_id: stylistId, status: 'confirmed', service: 'x',
                            starts_at: `${d}T08:00:00.000Z`, ends_at: `${d}T21:00:00.000Z` });
                        d = addDays(d, 1);
                    }
                    return out;
                },
            },
            args: { serviceDuration: durNormal, serviceCategory: catConSkill },
        },
    ];

    const causasVistas = new Map();
    for (const esc of escenarios) {
        const restore = stubDb(esc.stub);
        try {
            const slots = await silenced(() => withMockedNow('2026-07-16T09:00:00', () =>
                calendarSante.getAvailableSlots(ORG, esc.args)));
            const causa = slots?.causa ?? null;
            causasVistas.set(esc.causa, { n: slots.length, causa });
            if (slots.length > 0) {
                gap('A3', `${esc.causa}: devolvió ${slots.length} huecos`, `escenario no reproducido (${esc.desc})`);
            } else if (causa === esc.causa) {
                ok('A3', `${esc.causa}: 0 huecos con causa correcta`);
            } else if (causa) {
                bug('A3', `${esc.causa}: causa reportada "${causa}"`, `esperada "${esc.causa}"`);
            } else {
                bug('A3', `${esc.causa}: 0 huecos SIN causa`, `${esc.desc} — indistinguible de agenda llena`);
            }
        } finally { restore(); }
    }
    // Defensa que SÍ existe y conviene fijar: pedir un día que la estilista no trabaja no
    // produce un cero, sino alternativas reales + la bandera para avisar (ETAPA B).
    {
        const restore = stubDb({ stylists: elegibles, schedule: [{ day_of_week: 0, start_time: '10:00:00', end_time: '19:00:00' }] });
        try {
            // 2026-07-22 es miércoles; el horario solo cubre el lunes (day_of_week=0).
            const slots = await silenced(() => withMockedNow('2026-07-16T09:00:00', () =>
                calendarSante.getAvailableSlots(ORG, {
                    serviceDuration: durNormal, serviceCategory: catConSkill,
                    preferencia: { fecha: '2026-07-22' },
                })));
            if (slots.length > 0 && slots.requestedDayUnavailable) {
                ok('A3', `día no trabajado → ${slots.length} alternativas reales + bandera de aviso`);
            } else if (slots.length > 0) {
                bug('A3', 'día no trabajado → alternativas SIN bandera', 'la clienta no se entera de que cambió el día');
            } else {
                bug('A3', 'día no trabajado → 0 huecos', 'ETAPA B no propuso alternativas');
            }
        } finally { restore(); }
    }

    const distintas = new Set([...causasVistas.values()].filter(v => v.n === 0).map(v => v.causa));
    if (distintas.size <= 1 && causasVistas.size > 1) {
        bug('A3', 'las causas de cero son INDISTINGUIBLES entre sí',
            `${causasVistas.size} escenarios distintos → ${distintas.size} causa(s) reportada(s)`);
    } else {
        ok('A3', `causas distinguibles (${distintas.size} valores distintos)`);
    }

    // ═══ A4 — Errores de BD ═══════════════════════════════════════════════════════════
    // Cada lectura del camino de disponibilidad se hace fallar por separado. Un error de
    // infraestructura NO debe poder disfrazarse de "no hay huecos" ni de "hay hueco".
    console.log('▶ A4 · Errores de BD vs. ausencia de huecos');
    const lecturas = [
        ['stylists', 'getStylistsByOrg', () => db.getStylistsByOrg(ORG)],
        ['stylist_schedules', 'getStylistSchedule', () => db.getStylistSchedule(ORG, stylists[0].id)],
        ['schedule_blocks', 'getScheduleBlocks', () => db.getScheduleBlocks(ORG, stylists[0].id, '2026-07-01', '2026-07-31')],
        ['blocked_days', 'getBlockedDays', () => db.getBlockedDays(ORG, { from: '2026-07-01', to: '2026-07-31' })],
        ['appointments', 'getAppointmentsByStylistAndRange', () => db.getAppointmentsByStylistAndRange(ORG, stylists[0].id, '2026-07-01T00:00:00Z', '2026-07-31T00:00:00Z')],
    ];
    for (const [tabla, fn, call] of lecturas) {
        const restore = stubSupabaseFailFor(tabla);
        try {
            const res = await call();
            bug('A4', `${fn}: error de BD → devuelve ${JSON.stringify(res)}`,
                'el error se traga y se convierte en "sin datos"');
        } catch (e) {
            ok('A4', `${fn}: error de BD → lanza excepción`, e.message);
        } finally { restore(); }
    }

    // El caso peligroso: si falla la lectura de CITAS y se degrada a [], el motor cree que
    // la agenda está vacía y ofrece huecos YA RESERVADOS (doble reserva). Se ejercita
    // haciendo fallar la tabla en SUPABASE — no en la capa db — para atravesar el camino
    // real de principio a fin.
    {
        // OJO al orden: hay que capturar la función REAL antes de que stubDb la sustituya,
        // porque justo ésa es la que queremos dejar sin stub para que llegue a supabase.
        const realGetAppts = db.getAppointmentsByStylistAndRange;
        const restoreDb = stubDb({ stylists: elegibles });   // horario abierto y sin bloqueos
        db.getAppointmentsByStylistAndRange = realGetAppts;   // ← ésta sí pega a supabase
        const restoreSb = stubSupabaseFailFor('appointments');
        let veredicto;
        try {
            const slots = await silenced(() => withMockedNow('2026-07-16T09:00:00', () =>
                calendarSante.getAvailableSlots(ORG, { serviceDuration: durNormal, serviceCategory: catConSkill })));
            veredicto = { tipo: 'devolvio', n: slots.length };
        } catch (e) {
            veredicto = { tipo: 'lanzo', msg: e.message };
        } finally { restoreSb(); restoreDb(); }

        if (veredicto.tipo === 'lanzo') {
            ok('A4', 'lectura de citas fallida → excepción (sin huecos fantasma)', veredicto.msg);
        } else if (veredicto.n > 0) {
            bug('A4', 'DISPONIBILIDAD FANTASMA si falla la lectura de citas',
                `ofreció ${veredicto.n} huecos sin haber podido comprobar las citas existentes`);
        } else {
            bug('A4', 'lectura de citas fallida → 0 huecos silenciosos',
                'indistinguible de "no hay hueco": la clienta pierde la cita y nadie se entera');
        }
    }

    // getAgentConfig no debe CACHEAR un fallo: antes guardaba `null` con timestamp fresco y
    // dejaba a la org sin catálogo 60 s. Se comprueba con una org ficticia (para no tocar la
    // entrada real de Sante): primero falla, y en la llamada siguiente —ya con la BD sana—
    // debe volver a consultar y devolver el dato bueno, no el null cacheado.
    {
        const ORG_FALSA = '00000000-dead-beef-0000-000000000001';
        const restoreFail = stubSupabaseFailFor('agent_configs');
        const durante = await db.getAgentConfig(ORG_FALSA);
        restoreFail();

        const CONFIG_BUENA = { id: 'fake-cfg', organization_id: ORG_FALSA, services: [{ nombre: 'X', categoria: 'X' }] };
        const restoreOk = stubSupabaseReturnFor('agent_configs', CONFIG_BUENA);
        const despues = await db.getAgentConfig(ORG_FALSA);
        restoreOk();

        if (durante !== null) {
            ok('A4', 'getAgentConfig devuelve copia previa buena ante un fallo', 'degradación elegante');
        } else if (despues && despues.id === 'fake-cfg') {
            ok('A4', 'getAgentConfig NO cachea el fallo (reintenta y recupera)');
        } else {
            bug('A4', 'getAgentConfig CACHEA el fallo',
                'tras restaurarse la BD sigue devolviendo null → catálogo vacío 60 s para todas las clientas');
        }
    }

    // ═══ A5 — Media que no es audio por Cloud API ═════════════════════════════════════
    // El adaptador marca hasMedia solo para audio; con una foto sin caption el bot llega a
    // `if (!userText) { if (message.hasMedia) {...} return; }` con AMBOS falsos → silencio.
    console.log('▶ A5 · Media entrante por 360dialog (Cloud API)');
    const tiposMedia = [
        ['image', { image: { id: 'mid.1', mime_type: 'image/jpeg' } }],
        ['sticker', { sticker: { id: 'mid.2', mime_type: 'image/webp' } }],
        ['video', { video: { id: 'mid.3', mime_type: 'video/mp4' } }],
        ['document', { document: { id: 'mid.4', mime_type: 'application/pdf' } }],
        ['location', { location: { latitude: 38.34, longitude: -0.48 } }],
    ];
    for (const [tipo, extra] of tiposMedia) {
        const { message } = buildInboundAdapters(
            { from: '34600111222', id: `wamid.${tipo}`, type: tipo, ...extra },
            { display_phone_number: '34641029104' }, ORG);
        const textoVacio = !(message.body || '').trim();
        // Reproduce la condición exacta de bot.js:3283-3288.
        const responderia = !textoVacio || message.hasMedia;
        if (responderia) ok('A5', `${tipo}: el bot llega a responder algo`);
        else gap('A5', `${tipo}: SILENCIO TOTAL`, 'body vacío y hasMedia=false → return sin enviar nada');
    }
    // Contraste con audio, que sí se maneja.
    {
        const { message } = buildInboundAdapters(
            { from: '34600111222', id: 'wamid.audio', type: 'audio', audio: { id: 'mid.9', mime_type: 'audio/ogg' } },
            { display_phone_number: '34641029104' }, ORG);
        if (message.hasMedia && message.type === 'ptt') ok('A5', 'audio: se marca como ptt + hasMedia → se transcribe');
        else bug('A5', 'audio: el adaptador ya no lo marca como ptt/hasMedia', JSON.stringify({ t: message.type, h: message.hasMedia }));
    }

    // ─── Resumen ──────────────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(78));
    const porBloque = {};
    for (const r of rows) {
        (porBloque[r.bloque] ||= { OK: 0, GAP: 0, BUG: 0 })[r.estado]++;
    }
    console.log('RESUMEN POR BLOQUE');
    const nombres = { A1: 'Estilistas', A2: 'Fecha/hora', A3: 'Causas de cero', A4: 'Errores de BD', A5: 'Media Cloud API' };
    for (const [b, c] of Object.entries(porBloque)) {
        console.log(`  ${b} ${(nombres[b] || '').padEnd(16)} OK ${String(c.OK).padStart(3)} · GAP ${String(c.GAP).padStart(3)} · BUG ${String(c.BUG).padStart(3)}`);
    }
    const problemas = rows.filter(r => r.estado !== 'OK');
    if (problemas.length) {
        console.log('\nDETALLE (GAP = medido, fuera de alcance · BUG = lo arregla la Fase 2)');
        for (const r of problemas) {
            console.log(`  [${r.estado}] ${r.bloque} · ${r.etiqueta}${r.detalle ? `\n         ${r.detalle}` : ''}`);
        }
    }
    console.log('\n' + '─'.repeat(78));
    console.log(`TOTAL  OK ${counts.OK} · GAP ${counts.GAP} · BUG ${counts.BUG}`);
    console.log(counts.BUG
        ? `\n⚠️  ${counts.BUG} BUG(s): esperado ANTES de la Fase 2. Debe quedar en 0 después.`
        : '\n✅ Sin BUGs. Los GAP son deficiencias conocidas y fuera del alcance actual.');
    console.log('═'.repeat(78) + '\n');
})().catch(e => { console.error('\n💥 Error inesperado:', e); process.exit(1); });
