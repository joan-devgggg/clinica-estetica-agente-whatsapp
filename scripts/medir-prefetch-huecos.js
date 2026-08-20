#!/usr/bin/env node
/**
 * medir:prefetch — cuánto cuesta UNA carga de huecos, contra la Supabase real.
 *
 *   npm run medir:prefetch -- sante [--horizonte 90] [--repeticiones 5] [--dias]
 *
 * `--dias` mide getAvailableDays (la rejilla de mes del enlace) en vez de getAvailableSlots.
 *
 * SOLO LECTURA. No escribe nada, ni en Supabase ni en disco.
 *
 * Existe por D7 del brief del enlace (docs/enlace-publico-reserva.md): el prefetch del motor
 * hace tres consultas EN SERIE por estilista. Con 14 días y una conversación por medio eso se
 * disimula; con 90 días y una llamada por clic de un formulario público, no. Este script es la
 * cinta métrica: cuenta las consultas, cuántas van encadenadas, y el reloj de pared.
 *
 * Lo que mide y lo que NO:
 *   · MIDE viajes a la BD y latencia real desde esta máquina. La latencia depende de la red de
 *     quien lo lance, así que el número que COMPARA de una versión a otra es el de VIAJES y el
 *     de PROFUNDIDAD (viajes encadenados), que no dependen de dónde estés sentado.
 *   · NO mide producción: Railway está más cerca de Supabase que un portátil.
 *
 * Códigos de salida: 0 medido · 2 no se pudo leer.
 */
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Madrid';

const { resolverOrgArg } = require('../services/org-registry');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Configúralos en .env.');
    process.exit(2);
}

const db = require('../services/db');

// Las cinco lecturas del motor. Se envuelven para contar viajes y medir cada una; el
// contador de PROFUNDIDAD cuenta tandas: una tanda son las llamadas que arrancan mientras
// no ha vuelto ninguna de las anteriores (o sea, las que van en paralelo de verdad).
const LECTURAS = [
    'getStylistsByOrg', 'getBlockedDays', 'getStylistSchedule',
    'getScheduleBlocks', 'getAppointmentsByStylistAndRange',
    // Las de la versión por lotes, si existen (no rompe si aún no están).
    'getStylistSchedulesByStylists', 'getScheduleBlocksByStylists', 'getAppointmentsByStylistsAndRange',
];

function instrumentar() {
    const stats = { viajes: 0, porFuncion: {}, msTotalEnBD: 0, tandas: 0 };
    let enVuelo = 0;
    const originales = {};
    for (const fn of LECTURAS) {
        if (typeof db[fn] !== 'function') continue;
        originales[fn] = db[fn];
        db[fn] = async (...args) => {
            if (enVuelo === 0) stats.tandas += 1;   // arranca una tanda nueva
            enVuelo += 1;
            stats.viajes += 1;
            stats.porFuncion[fn] = (stats.porFuncion[fn] || 0) + 1;
            const t0 = process.hrtime.bigint();
            try {
                return await originales[fn](...args);
            } finally {
                stats.msTotalEnBD += Number(process.hrtime.bigint() - t0) / 1e6;
                enVuelo -= 1;
            }
        };
    }
    return { stats, restaurar: () => { for (const [fn, orig] of Object.entries(originales)) db[fn] = orig; } };
}

function parseArgs(argv) {
    let org = null, horizonte = null, repeticiones = 5, dias = false;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--horizonte') { horizonte = Number(argv[++i]); continue; }
        if (argv[i] === '--repeticiones') { repeticiones = Number(argv[++i]); continue; }
        if (argv[i] === '--dias') { dias = true; continue; }
        if (!argv[i].startsWith('--')) org = argv[i];
    }
    return { org, horizonte, repeticiones, dias };
}

const mediana = xs => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function main() {
    const { org: orgArg, horizonte, repeticiones, dias } = parseArgs(process.argv.slice(2));
    const encontradas = resolverOrgArg(orgArg);
    if (!encontradas || encontradas.length !== 1) {
        console.error('❌ Hace falta UNA org. Uso: npm run medir:prefetch -- sante [--horizonte 90]');
        process.exit(2);
    }
    const org = encontradas[0];
    // El motor de huecos es del SALÓN. San Remo usa el mock de mesas y no pasa por aquí:
    // gateado por el tipo de org, estructuralmente, no por una config vacía.
    if (org.type !== 'salon') {
        console.error(`❌ ${org.slug} no es un salón: su disponibilidad no sale de calendar-sante.`);
        process.exit(2);
    }

    const calendarSante = require('../services/calendar-sante');
    // Una categoría con varias estilistas es la que hace visible el N+1. 'Cortes' la tienen
    // las generalistas; si un día no la tuviera nadie, el motor devuelve sin_skill y se dice.
    const CATEGORIA = 'Cortes';
    const DURACION = 60;

    const opciones = horizonte ? { horizonteDias: horizonte } : {};
    const etiqueta = horizonte ? `${horizonte} días` : 'default del motor';

    const consultar = dias ? calendarSante.getAvailableDays : calendarSante.getAvailableSlots;
    const QUE = dias ? 'DÍAS con hueco (rejilla de mes)' : 'huecos (lista del bot)';

    // Una corrida de calentamiento: la primera paga el TLS y el DNS, y eso no es el prefetch.
    await consultar(org.orgId, { serviceDuration: DURACION, serviceCategory: CATEGORIA, ...opciones });

    const muestras = [];
    let ultimo = null;
    for (let i = 0; i < repeticiones; i++) {
        const { stats, restaurar } = instrumentar();
        const t0 = process.hrtime.bigint();
        const slots = await consultar(org.orgId, {
            serviceDuration: DURACION, serviceCategory: CATEGORIA, ...opciones,
        });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        restaurar();
        muestras.push({ ms, ...stats, huecos: slots.length, causa: slots.causa || null });
        ultimo = muestras.at(-1);
    }

    const wall = muestras.map(m => m.ms);
    console.log(`\n⏱  Prefetch de huecos · ${org.slug} · horizonte: ${etiqueta} · ${repeticiones} corridas\n`);
    console.log(`   Servicio de prueba: categoría "${CATEGORIA}", ${DURACION} min`);
    console.log(`   Midiendo:           ${QUE}`);
    console.log(`   Filas devueltas:    ${ultimo.huecos}${ultimo.causa ? ` (causa: ${ultimo.causa})` : ''}`);
    console.log('');
    console.log(`   VIAJES a la BD:     ${ultimo.viajes}`);
    console.log(`   TANDAS (en serie):  ${ultimo.tandas}   ← lo que hay que bajar; es profundidad, no volumen`);
    console.log(`   Reloj de pared:     mediana ${mediana(wall).toFixed(0)} ms · min ${Math.min(...wall).toFixed(0)} · max ${Math.max(...wall).toFixed(0)}`);
    console.log(`   Suma de las esperas: ${ultimo.msTotalEnBD.toFixed(0)} ms`);
    console.log('');
    console.log('   Desglose por lectura:');
    for (const [fn, n] of Object.entries(ultimo.porFuncion).sort((a, b) => b[1] - a[1])) {
        console.log(`     ${String(n).padStart(3)} × ${fn}`);
    }
    console.log('');
}

main().catch(e => {
    console.error('❌ No se pudo medir:', e?.message || e);
    process.exit(2);
});
