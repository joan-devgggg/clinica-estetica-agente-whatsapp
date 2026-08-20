#!/usr/bin/env node
/**
 * medir-borde-jornada.js — Cuánto cuesta el defecto D3, contra la agenda REAL.
 *
 * SOLO LECTURA. No escribe nada, ni en Supabase ni en disco.
 *
 * ── QUÉ MIDE ────────────────────────────────────────────────────────────────────────────
 *
 * `computeFreeSlots` recorre cada ventana libre con
 *
 *     t + serviceDuration <= winEnd  &&  t + serviceDuration < workEnd
 *
 * y la segunda condición SOBRA: `winEnd` ya viene capado a `workEnd` (las ventanas se
 * construyen con `Math.min(occ.start, workEnd)` y la última es `[cursor, workEnd]`), así que
 * lo único que hace ese `<` estricto es tirar el hueco cuya cita terminaría EXACTAMENTE al
 * cierre. Uno por jornada, por estilista y por servicio.
 *
 * Y el sistema ya está desalineado consigo mismo: `reservar_hueco()` (migración 043, ya
 * aplicada) usa `v_fin <= end_time` —permisivo, y su comentario dice que se dejó así a
 * propósito esperando este arreglo— y `tests/lib/agenda-audit.js` valida las citas con
 * `finMin <= c` («ends_at incluido»). El motor es el único que dice `<`.
 *
 * ── CÓMO LO MIDE, Y POR QUÉ ES FIABLE ───────────────────────────────────────────────────
 *
 * Lee los MISMOS datos que `prepararMotor` (estilistas, horarios, bloqueos, citas, días
 * bloqueados) y recorre los MISMOS días. Para cada (estilista, día) calcula los huecos dos
 * veces: con la regla de hoy y con la candidata.
 *
 * La regla de hoy NO se reimplementa: se llama a `computeFreeSlots` de verdad
 * (`_internals`). Y la candidata, que sí es local, se comprueba contra ella en modo estricto
 * en CADA caso — si alguna vez difirieran, el script aborta. Así la única diferencia que
 * puede aparecer en el informe es la del `<=`, no un error de copia.
 *
 * ── DOS NÚMEROS, NO UNO ─────────────────────────────────────────────────────────────────
 *
 *   · FILAS   — (servicio × estilista × día). Es lo que produce el motor por dentro.
 *   · HORAS   — las que la clienta VE. El enlace agrupa por (día, hora), así que dos
 *               estilistas que ganan las 18:00 el mismo día son UN hueco más en pantalla,
 *               no dos. Éste es el número honesto, y es bastante más pequeño.
 *
 * Uso:  node scripts/medir-borde-jornada.js [sante] [--dias 90] [--servicio "Cat|Nombre"]
 */
require('dotenv').config();

const db = require('../services/db');
const { resolverOrgArg } = require('../services/org-registry');
const {
    botOfferableCatalog, isReactiveOnlyService, resolveAppointmentDurationMin, serviceCatalogKey,
} = require('../services/helpers');
const cal = require('../services/calendar-sante');
const { computeFreeSlots, recortarAlDia, toLocalDateStr, addDaysStr, mondayDow } = cal._internals;

const PASO_MIN = 30;   // SLOT_OFFER_STEP_MIN

const args = process.argv.slice(2);
const flag = (nombre, porDefecto) => {
    const i = args.indexOf(nombre);
    return i >= 0 && args[i + 1] ? args[i + 1] : porDefecto;
};
const DIAS = Number(flag('--dias', '90'));
const SOLO_SERVICIO = flag('--servicio', null);
const orgArg = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--dias' && args[args.indexOf(a) - 1] !== '--servicio');

/**
 * La regla CANDIDATA: la misma función, sin el `< workEnd`. `estricto:true` la devuelve a la
 * de hoy, que es lo que permite compararla con la de verdad en cada caso.
 */
function huecosCon({ workStart, workEnd, occupied, serviceDuration, estricto }) {
    const sorted = [...occupied].sort((a, b) => a.start - b.start);
    const freeWindows = [];
    let cursor = workStart;
    for (const occ of sorted) {
        if (occ.start > cursor) freeWindows.push([cursor, Math.min(occ.start, workEnd)]);
        cursor = Math.max(cursor, occ.end);
    }
    if (cursor < workEnd) freeWindows.push([cursor, workEnd]);
    const starts = [];
    for (const [winStart, winEnd] of freeWindows) {
        for (let t = winStart; t + serviceDuration <= winEnd; t += PASO_MIN) {
            if (estricto && t + serviceDuration >= workEnd) continue;
            starts.push(t);
        }
    }
    return starts;
}

const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

(async () => {
    const orgs = resolverOrgArg(orgArg);
    if (!orgs) { console.error(`Org no reconocida: ${orgArg}`); process.exit(2); }
    const org = orgs.find(o => o.type === 'salon');
    if (!org) { console.error('Este medidor es del motor del SALÓN.'); process.exit(2); }
    const orgId = org.orgId;

    // ── 1 · El catálogo que ofrece el ENLACE (el del bot, menos la Consulta) ──
    const cfg = await db.getAgentConfig(orgId);
    if (!cfg || !Array.isArray(cfg.services)) { console.error('No se ha podido leer el catálogo.'); process.exit(2); }
    let servicios = botOfferableCatalog(cfg.services).filter(s => !isReactiveOnlyService(s));
    if (SOLO_SERVICIO) servicios = servicios.filter(s => serviceCatalogKey(s) === SOLO_SERVICIO);
    const conDuracion = [];
    for (const s of servicios) {
        const d = resolveAppointmentDurationMin(s, cfg.services);
        if (d.resuelto) conDuracion.push({ entrada: s, key: serviceCatalogKey(s), dur: d.minutos });
    }

    // ── 2 · Los mismos datos que prepararMotor, UNA vez ──
    const todayStr = toLocalDateStr(new Date());
    const startDateStr = addDaysStr(todayStr, 1);          // el enlace no pide asap
    const endDateStr = addDaysStr(startDateStr, DIAS);
    const fromStr = new Date(new Date(startDateStr + 'T00:00:00Z').getTime() - 864e5).toISOString();
    const toStr = new Date(new Date(endDateStr + 'T00:00:00Z').getTime() + 864e5).toISOString();

    const estilistas = await db.getStylistsByOrg(orgId);
    const allBlockedDays = await db.getBlockedDays(orgId, { from: startDateStr, to: endDateStr });
    const salonBlocked = new Set(allBlockedDays.filter(b => !b.stylist_id).map(b => b.fecha));
    const styBlocked = new Map();
    for (const b of allBlockedDays) {
        if (!b.stylist_id) continue;
        if (!styBlocked.has(b.stylist_id)) styBlocked.set(b.stylist_id, new Set());
        styBlocked.get(b.stylist_id).add(b.fecha);
    }
    const datos = [];
    for (const stylist of estilistas) {
        const [schedule, blocks, appointments] = await Promise.all([
            db.getStylistSchedule(orgId, stylist.id),
            db.getScheduleBlocks(orgId, stylist.id, fromStr, toStr),
            db.getAppointmentsByStylistAndRange(orgId, stylist.id, fromStr, toStr),
        ]);
        const scheduleByDay = new Map();
        for (const s of schedule) scheduleByDay.set(s.day_of_week, s);
        datos.push({ stylist, scheduleByDay, blocks, appointments });
    }

    const dias = [];
    for (let d = 0; d < DIAS; d++) dias.push(addDaysStr(startDateStr, d));

    // ── 3 · Comparar, servicio a servicio ──
    let filasExtra = 0, horasExtra = 0, discrepancias = 0;
    let fueraDeHorario = 0, pisanElCierre = 0, solapan = 0, terminanJusto = 0;
    const porDia = new Map();          // fecha → horas nuevas VISIBLES (set de horas por servicio)
    const porServicio = new Map();     // key → filas
    const ejemplos = [];

    for (const svc of conDuracion) {
        const cat = svc.entrada.categoria;
        const eligibles = datos.filter(({ stylist }) => {
            const skills = Array.isArray(stylist.skills) ? stylist.skills : [];
            return skills.some(sk => String(sk).toLowerCase() === String(cat).toLowerCase());
        });
        if (!eligibles.length) continue;

        for (const fecha of dias) {
            const dow = mondayDow(fecha);
            const antes = new Set(), despues = new Set();
            for (const { stylist, scheduleByDay, blocks, appointments } of eligibles) {
                if (salonBlocked.has(fecha)) continue;
                if (styBlocked.get(stylist.id)?.has(fecha)) continue;
                const ds = scheduleByDay.get(dow);
                if (!ds) continue;
                const [sH, sM] = ds.start_time.split(':').map(Number);
                const [eH, eM] = ds.end_time.split(':').map(Number);
                const workStart = sH * 60 + sM, workEnd = eH * 60 + eM;
                const occupied = [
                    ...appointments.map(a => recortarAlDia(a.starts_at, a.ends_at, fecha)).filter(Boolean),
                    ...blocks.map(b => recortarAlDia(b.starts_at, b.ends_at, fecha)).filter(Boolean),
                ];

                const real = computeFreeSlots({ workStart, workEnd, occupied, serviceDuration: svc.dur });
                const mio = huecosCon({ workStart, workEnd, occupied, serviceDuration: svc.dur, estricto: true });
                if (real.join(',') !== mio.join(',')) { discrepancias++; continue; }
                const nuevo = huecosCon({ workStart, workEnd, occupied, serviceDuration: svc.dur, estricto: false });

                real.forEach(t => antes.add(t));
                nuevo.forEach(t => despues.add(t));

                for (const t of nuevo.filter(x => !real.includes(x))) {
                    filasExtra++;
                    porServicio.set(svc.key, (porServicio.get(svc.key) || 0) + 1);
                    // ── Las tres comprobaciones que pediste ──
                    if (t < workStart) fueraDeHorario++;
                    if (t + svc.dur > workEnd) pisanElCierre++;
                    if (t + svc.dur === workEnd) terminanJusto++;
                    if (occupied.some(o => t < o.end && t + svc.dur > o.start)) solapan++;
                    if (ejemplos.length < 6) {
                        ejemplos.push(`${fecha} ${hhmm(t)}–${hhmm(t + svc.dur)} · ${stylist.name} · `
                            + `${svc.key} (${svc.dur}′) · jornada ${hhmm(workStart)}–${hhmm(workEnd)}`);
                    }
                }
            }
            const nuevasVisibles = [...despues].filter(t => !antes.has(t)).length;
            if (nuevasVisibles) {
                horasExtra += nuevasVisibles;
                porDia.set(fecha, (porDia.get(fecha) || 0) + nuevasVisibles);
            }
        }
    }

    // ── 4 · Informe ──
    console.log(`\nD3 · EL ÚLTIMO HUECO DE CADA JORNADA — ${org.slug}`);
    console.log(`Horizonte: ${startDateStr} → ${dias[dias.length - 1]} (${DIAS} días)`);
    console.log(`Catálogo ofertable por el enlace: ${conDuracion.length} servicios con duración resuelta`);
    console.log(`Estilistas leídas: ${estilistas.length}\n`);

    if (discrepancias) {
        console.error(`ABORTA: la regla local y computeFreeSlots difieren en ${discrepancias} casos.`);
        console.error('La medida no es fiable. No toques el motor.');
        process.exit(1);
    }
    console.log('Equivalencia comprobada: la regla local en modo estricto coincide con');
    console.log('computeFreeSlots en TODOS los casos medidos. La única diferencia es el `<=`.\n');

    console.log(`FILAS de más (servicio × estilista × día) ....... ${filasExtra}`);
    console.log(`HORAS de más que la clienta VE (día × hora) ..... ${horasExtra}`);
    console.log(`Días del horizonte con algún hueco nuevo ........ ${porDia.size} de ${DIAS}\n`);

    console.log('LAS TRES COMPROBACIONES:');
    console.log(`  huecos que empiezan antes de abrir ............ ${fueraDeHorario}   (tiene que ser 0)`);
    console.log(`  huecos cuya cita PASA del cierre .............. ${pisanElCierre}   (tiene que ser 0)`);
    console.log(`  huecos que pisan una cita o un bloqueo ........ ${solapan}   (tiene que ser 0)`);
    console.log(`  huecos que terminan JUSTO al cierre ........... ${terminanJusto}   (= todos: ${filasExtra})\n`);

    if (ejemplos.length) {
        console.log('EJEMPLOS:');
        for (const e of ejemplos) console.log(`  ${e}`);
        console.log('');
    }

    const conAlgo = [...porDia.entries()].sort();
    console.log(`DÍA A DÍA (horas nuevas visibles; solo los ${conAlgo.length} días con algo):`);
    for (const [fecha, n] of conAlgo) console.log(`  ${fecha}  ${String(n).padStart(3)}`);

    const top = [...porServicio.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) {
        console.log('\nPOR SERVICIO (filas, los 8 primeros):');
        for (const [k, n] of top) console.log(`  ${String(n).padStart(4)}  ${k}`);
    }

    const malos = fueraDeHorario + pisanElCierre + solapan;
    console.log(`\n${malos === 0 ? 'LIMPIO' : 'HAY ' + malos + ' HUECOS QUE NO DEBERÍAN EXISTIR'}\n`);
    process.exit(malos === 0 ? 0 : 1);
})().catch(e => { console.error('medir-borde-jornada:', e.message); process.exit(2); });
