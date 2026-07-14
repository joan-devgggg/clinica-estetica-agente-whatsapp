/**
 * calendar-sante.js — Motor de disponibilidad real para salón de belleza
 * Fuente de verdad: stylist_schedules - appointments - schedule_blocks
 */

const db = require('./db');
const logger = require('../lib/logger');

const DIAS_SEMANA = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const SLOT_OFFER_STEP_MIN = 30; // intervalo entre huecos ofrecidos dentro de una ventana libre (10:00, 10:30, 11:00...)

// Zona horaria del NEGOCIO. Los horarios (`stylist_schedules`) se guardan como texto de
// pared local ("10:00"), pero las citas/bloqueos son timestamps UTC. Para que ambos se
// comparen en el MISMO reloj hay que interpretarlos siempre en esta TZ — nunca en la del
// proceso. Si no, un servidor en UTC (o cualquier otra TZ) calcularía huecos desplazados y
// podría ofrecer horas ocupadas o hasta sobre-reservar el día entero. Antes esto solo
// funcionaba porque server.js fija process.env.TZ='Europe/Madrid'; ahora es correcto por
// construcción en cualquier entorno (tests, scripts, workers) sin depender de ese pin.
const BUSINESS_TZ = process.env.SALON_TZ || 'Europe/Madrid';
const _dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const _timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/**
 * Devuelve huecos disponibles para un servicio en los próximos 14 días.
 * @param {string} orgId
 * @param {object} options
 * @param {number} options.serviceDuration — duración en minutos
 * @param {string} options.serviceCategory — categoría del servicio (para filtrar estilistas por skill)
 * @param {string} [options.preferredStylistId] — si la clienta pide una estilista concreta
 * @param {object} [options.preferencia] — { periodo: 'mañana'|'tarde', semana: 'esta'|'siguiente' }
 * @returns {Array} — top slots con { fecha, hora, diaNombre, stylistId, stylistName, texto }
 */
async function getAvailableSlots(orgId, { serviceDuration = 60, serviceCategory, preferredStylistId, preferencia = {} } = {}) {
    const allStylists = await db.getStylistsByOrg(orgId);
    if (!allStylists.length) return [];

    // Filtrar por skill: SOLO estilistas cuyo `skills` incluye exactamente la categoría
    // del servicio. Antes había un fallback a TODAS las estilistas si ninguna hacía match,
    // y eso colaba a Larisa (solo masajes) o a Olgha (solo uñas) en cortes/color. Ahora,
    // si nadie tiene la skill, devolvemos lista vacía (sin huecos) en vez de ofrecer a
    // quien no sabe hacer el servicio — preferimos "no hay hueco" antes que asignar mal.
    let eligible = allStylists;
    if (serviceCategory) {
        eligible = allStylists.filter(s => {
            const skills = Array.isArray(s.skills) ? s.skills : [];
            return skills.some(skill => String(skill).toLowerCase() === String(serviceCategory).toLowerCase());
        });
        if (!eligible.length) {
            logger.warn('sante_sin_estilista_para_categoria', { orgId, serviceCategory });
            return [];
        }
    }

    // Si la clienta eligió una estilista concreta, FILTRAMOS a ella (no solo ordenar).
    // Antes se ordenaba preferida-primero pero se conservaban las demás como fallback;
    // tras el dedup por fecha-hora eso dejaba huecos de OTRA estilista en horas donde la
    // preferida no trabajaba, y un match por hora podía guardar la estilista equivocada
    // (BUG 2). Si la preferida no tiene NINGÚN hueco, caemos al resto elegible para no
    // dejar a la clienta sin opciones.
    if (preferredStylistId) {
        const onlyPreferred = eligible.filter(s => s.id === preferredStylistId);
        if (onlyPreferred.length) eligible = onlyPreferred;
    }

    const now = new Date();
    const todayStr = toLocalDateStr(now);   // fecha de HOY en TZ de negocio
    const nowMinutes = toMinutes(now);      // minuto-del-día de AHORA en TZ de negocio

    // Fecha-calendario de inicio (TZ de negocio): hoy si asap, mañana por defecto. Todo el
    // recorrido de 14 días se hace sobre strings YYYY-MM-DD, independiente de la TZ del proceso.
    const startDateStr = preferencia.asap ? todayStr : addDaysStr(todayStr, 1);
    const endDateStr = addDaysStr(startDateStr, 14);
    const fromDateStr = startDateStr;
    const toDateStr = endDateStr;

    // Rango para las consultas a BD: cubre los 14 días de negocio con ±1 día de holgura
    // (el filtrado fino se hace luego re-agrupando cada cita/bloqueo por su fecha de negocio).
    const fromStr = new Date(new Date(startDateStr + 'T00:00:00Z').getTime() - 24 * 3600 * 1000).toISOString();
    const toStr = new Date(new Date(endDateStr + 'T00:00:00Z').getTime() + 24 * 3600 * 1000).toISOString();
    const allBlockedDays = await db.getBlockedDays(orgId, { from: fromDateStr, to: toDateStr });
    const salonBlockedDates = new Set(allBlockedDays.filter(b => !b.stylist_id).map(b => b.fecha));
    const stylistBlockedDates = new Map();
    for (const b of allBlockedDays) {
        if (!b.stylist_id) continue;
        if (!stylistBlockedDates.has(b.stylist_id)) stylistBlockedDates.set(b.stylist_id, new Set());
        stylistBlockedDates.get(b.stylist_id).add(b.fecha);
    }

    // Prefetch del horario/bloqueos/citas de cada estilista UNA sola vez. Así podemos
    // recorrer los días dos veces (con el filtro de día pedido y, si no hay nada, sin él)
    // sin volver a pegarle a la base de datos.
    const stylistData = [];
    for (const stylist of eligible) {
        const schedule = await db.getStylistSchedule(orgId, stylist.id);
        const blocks = await db.getScheduleBlocks(orgId, stylist.id, fromStr, toStr);
        const appointments = await db.getAppointmentsByStylistAndRange(orgId, stylist.id, fromStr, toStr);
        const scheduleByDay = new Map();
        for (const s of schedule) scheduleByDay.set(s.day_of_week, s);
        stylistData.push({ stylist, scheduleByDay, blocks, appointments });
    }

    // Recorre los próximos 14 días y construye los huecos reales según horario, citas y
    // bloqueos. `pref` puede traer filtros de día/semana/franja. NUNCA inventa huecos:
    // si la estilista no trabaja ese día (no hay daySchedule), simplemente no se generan.
    // Los 14 días de calendario a recorrer, en TZ de negocio, con su día de la semana
    // (0=lunes). Aritmética pura de fechas → idéntico en cualquier TZ del proceso.
    const calendarDays = [];
    for (let d = 0; d < 14; d++) {
        const dateStr = addDaysStr(startDateStr, d);
        calendarDays.push({ dateStr, dayOfWeek: mondayDow(dateStr) });
    }
    const todayDow = mondayDow(todayStr);

    function buildSlots(pref) {
        // Límites de semana como strings YYYY-MM-DD (comparables con < y >).
        let startOfNextWeekStr = null, endOfNextWeekStr = null, endOfThisWeekStr = null;
        if (pref.semana === 'siguiente') {
            const daysToSunday = 6 - todayDow;              // días hasta el domingo de esta semana
            startOfNextWeekStr = addDaysStr(todayStr, daysToSunday + 1); // lunes próxima semana
            endOfNextWeekStr = addDaysStr(startOfNextWeekStr, 6);        // domingo próxima semana
            console.log('rango semana siguiente:', startOfNextWeekStr, endOfNextWeekStr);
        } else if (pref.semana === 'esta') {
            // Se ancla a la semana de INICIO de la búsqueda (startDateStr = mañana, o
            // hoy si asap), no a la de HOY. Si hoy es domingo, todayDow=6 y "6-6=0"
            // daba endOfThisWeekStr = hoy mismo → un rango [hoy,hoy] que dejaba fuera
            // TODO el calendario futuro, incluido el lunes que la clienta pedía
            // (root cause del bug totalSlots:0 con Veronika/Balayage). Anclarlo al
            // inicio real de la búsqueda cubre siempre la semana que corresponde.
            const startDow = mondayDow(startDateStr);
            endOfThisWeekStr = addDaysStr(startDateStr, 6 - startDow); // domingo de la semana de inicio
        }

        const out = [];
        for (const { stylist, scheduleByDay, blocks, appointments } of stylistData) {
            for (const { dateStr, dayOfWeek } of calendarDays) {
                const daySchedule = scheduleByDay.get(dayOfWeek);
                if (!daySchedule) continue; // la estilista NO trabaja este día → sin huecos

                // Skip entire day if blocked (salon-wide or stylist-specific)
                if (salonBlockedDates.has(dateStr)) continue;
                if (stylistBlockedDates.get(stylist.id)?.has(dateStr)) continue;
                const diaNombre = DIAS_SEMANA[dayOfWeek];

                // Filtro por fecha concreta ("el 24") o día de la semana ("el miércoles").
                // La fecha exacta manda sobre el día de la semana si ambas vienen dadas.
                if (pref.fecha) {
                    if (dateStr !== pref.fecha) continue;
                } else if (Number.isInteger(pref.diaSemana)) {
                    if (dayOfWeek !== pref.diaSemana) continue;
                }

                // Filter by week preference: 'siguiente' → solo lunes-domingo de la próxima
                // semana (rango explícito, no open-ended). 'esta' → hasta el domingo actual.
                // BLINDAJE: una `fecha` absoluta ya filtró a un único día arriba y determina la
                // semana por sí sola; el filtro de semana NO debe re-acotar y excluirla (un
                // 'semana' heredado de un turno anterior daría un falso totalSlots:0 para la
                // fecha pedida). La limpieza en origen vive en resolveStickyWeek/extractQuickDataSante.
                if (!pref.fecha) {
                    if (pref.semana === 'siguiente') {
                        if (dateStr < startOfNextWeekStr || dateStr > endOfNextWeekStr) continue;
                    } else if (pref.semana === 'esta') {
                        if (dateStr > endOfThisWeekStr) continue;
                    }
                }

                // Working hours for this day
                const [startH, startM] = daySchedule.start_time.split(':').map(Number);
                const [endH, endM] = daySchedule.end_time.split(':').map(Number);
                const workStart = startH * 60 + startM;
                const workEnd = endH * 60 + endM;

                // Filter by period preference
                if (pref.periodo === 'mañana' || pref.periodo === 'manana') {
                    if (workStart >= 14 * 60) continue; // skip if starts after 14:00
                }

                // Existing appointments for this stylist on this date
                const dayAppts = appointments.filter(a => {
                    const aDate = toLocalDateStr(new Date(a.starts_at));
                    return aDate === dateStr;
                }).map(a => ({
                    start: toMinutes(new Date(a.starts_at)),
                    end: toMinutes(new Date(a.ends_at)),
                }));

                // Blocks on this date
                const dayBlocks = blocks.filter(b => {
                    const bStart = toLocalDateStr(new Date(b.starts_at));
                    const bEnd = toLocalDateStr(new Date(b.ends_at));
                    return bStart <= dateStr && bEnd >= dateStr;
                }).map(b => ({
                    start: toMinutes(new Date(b.starts_at)),
                    end: toMinutes(new Date(b.ends_at)),
                }));

                // ASAP + hoy: saltar huecos que ya han pasado (buffer de 60 min).
                const minStart = (pref.asap && dateStr === todayStr) ? nowMinutes + 60 : 0;
                // Ventanas libres + barrido en pasos → varios huecos (12:00, 12:30...), no
                // solo el inicio. Lógica pura en computeFreeSlots (fijada por tests).
                const starts = computeFreeSlots({
                    workStart, workEnd,
                    occupied: [...dayAppts, ...dayBlocks],
                    serviceDuration, minStart,
                });
                for (const t of starts) addSlot(out, dateStr, t, diaNombre, stylist, serviceDuration, pref);
            }
        }
        return out;
    }

    let slots = buildSlots(preferencia);

    // Fallback anti-invención (BUG 1/2/3): si se pidió un DÍA concreto en el que la(s)
    // estilista(s) no trabaja(n), buildSlots devuelve [] y antes el LLM acababa inventando
    // fechas. En vez de eso, recalculamos los huecos REALES más cercanos de esa misma
    // estilista/servicio ignorando solo el filtro de día (conservando semana/franja),
    // para proponer alternativas verídicas y próximas, nunca inventadas.
    let pedidoDiaSinHueco = false;
    if (!slots.length && (preferencia.fecha || Number.isInteger(preferencia.diaSemana))) {
        // 'semana' también se despoja: si se quedara, seguiría acotando el rango (p.ej.
        // 'esta' un domingo) y este reintento fallaría en falso igual que el primero,
        // dejando pedidoDiaSinHueco en false para siempre y sin alternativas reales.
        const { fecha, diaSemana, semana, ...resto } = preferencia;
        slots = buildSlots(resto);
        pedidoDiaSinHueco = slots.length > 0;
    }

    // Sort: preferred stylist first, then by date
    if (preferredStylistId) {
        slots.sort((a, b) => {
            if (a.stylistId === preferredStylistId && b.stylistId !== preferredStylistId) return -1;
            if (b.stylistId === preferredStylistId && a.stylistId !== preferredStylistId) return 1;
            return new Date(`${a.fecha}T${a.hora}`) - new Date(`${b.fecha}T${b.hora}`);
        });
    } else {
        slots.sort((a, b) => new Date(`${a.fecha}T${a.hora}`) - new Date(`${b.fecha}T${b.hora}`));
    }

    // Deduplicar por fecha-hora (una estilista por hueco).
    // Cuando hay un día concreto CON huecos reales devolvemos TODOS los de ese día;
    // sin día concreto (o en fallback de día sin hueco), cap generoso para no saturar.
    const diaConcreto = !pedidoDiaSinHueco && !!(preferencia.fecha || Number.isInteger(preferencia.diaSemana));
    const MAX_TOTAL = diaConcreto ? Infinity : (preferencia.asap ? 5 : 20);
    const seen = new Set();
    const unique = [];
    for (const s of slots) {
        const key = `${s.fecha}-${s.hora}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(s);
        if (unique.length >= MAX_TOTAL) break;
    }

    // Bandera para que el bot avise al LLM: el día pedido no tenía disponibilidad real
    // y estos son los huecos más cercanos (alternativas verídicas, no inventadas).
    unique.requestedDayUnavailable = pedidoDiaSinHueco;
    return unique;
}

function addSlot(slots, dateStr, minuteOfDay, diaNombre, stylist, serviceDuration, preferencia) {
    const hora = `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;
    const hourNum = Math.floor(minuteOfDay / 60);

    if (preferencia.periodo === 'mañana' || preferencia.periodo === 'manana') {
        if (hourNum >= 14) return;
    } else if (preferencia.periodo === 'tarde') {
        if (hourNum < 14) return;
    }

    const fechaDate = new Date(dateStr + 'T12:00:00');
    const fechaFormatted = fechaDate.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });

    slots.push({
        fecha: dateStr,
        hora,
        diaNombre,
        stylistId: stylist.id,
        stylistName: stylist.name,
        texto: `el ${fechaFormatted} a las ${hora} con ${stylist.name}`,
    });
}

// Minuto-del-día (0..1439) de un instante, medido en la TZ de negocio (no la del proceso).
// Así una cita guardada como 08:00 UTC se lee como 600 (10:00 Madrid) en cualquier servidor.
function toMinutes(date) {
    const p = Object.fromEntries(_timeFmt.formatToParts(date).map(x => [x.type, x.value]));
    return Number(p.hour) * 60 + Number(p.minute);
}

// Formatea un instante como YYYY-MM-DD en la TZ de negocio (no UTC ni la del proceso).
// Imprescindible: toISOString() da UTC y, en zonas adelantadas (España, UTC+1/+2), la
// medianoche local cae el día anterior → desfase de un día. Y getFullYear/getDate usan la
// TZ del proceso, que en un servidor no-Madrid también desfasa.
function toLocalDateStr(date) {
    const p = Object.fromEntries(_dateFmt.formatToParts(date).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
}

// Suma n días de CALENDARIO a un 'YYYY-MM-DD' con aritmética pura en UTC (sin TZ, sin DST).
// Devuelve otro 'YYYY-MM-DD'. Como YYYY-MM-DD ordena lexicográficamente igual que
// cronológicamente, los strings resultantes se pueden comparar con < y >.
function addDaysStr(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// Día de la semana (0=lunes … 6=domingo) de un 'YYYY-MM-DD', TZ-free.
function mondayDow(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=domingo
    return jsDay === 0 ? 6 : jsDay - 1;
}

// Cálculo puro de huecos: resta los intervalos `occupied` del horario [workStart,workEnd] y
// barre cada ventana libre en pasos de `step`, devolviendo los minutos-de-día de inicio
// válidos para un servicio de `serviceDuration`. Sin dependencias de BD ni de reloj — esta
// es la lógica que los tests de regresión fijan para SIEMPRE (citas parciales, huecos entre
// varias citas, bordes del turno). El estado de la cita (confirmed/no_show) no interviene
// aquí: quien construye `occupied` decide qué bloquea (la capa db excluye solo 'cancelled').
function computeFreeSlots({ workStart, workEnd, occupied = [], serviceDuration, step = SLOT_OFFER_STEP_MIN, minStart = 0 }) {
    const sorted = [...occupied].sort((a, b) => a.start - b.start);
    const freeWindows = [];
    let cursor = workStart;
    for (const occ of sorted) {
        if (occ.start > cursor) freeWindows.push([cursor, Math.min(occ.start, workEnd)]);
        cursor = Math.max(cursor, occ.end);
    }
    if (cursor < workEnd) freeWindows.push([cursor, workEnd]);

    // t + serviceDuration <= winEnd: no solapar la siguiente cita ni salir de la ventana.
    // Además t + serviceDuration < workEnd: nunca ofrecer un hueco cuya cita terminaría
    // exactamente al cierre o después (sin margen).
    const starts = [];
    for (const [winStart, winEnd] of freeWindows) {
        for (let t = winStart; t + serviceDuration <= winEnd && t + serviceDuration < workEnd; t += step) {
            if (t < minStart) continue;
            starts.push(t);
        }
    }
    return starts;
}

function formatSlotForMessage(slot) {
    return slot.texto || `el ${slot.diaNombre} ${slot.fecha} a las ${slot.hora} con ${slot.stylistName}`;
}

async function bookAppointment(orgId, slot, contactId, { servicio, duracionMin, stylistId, notas } = {}) {
    const apt = await db.saveAppointment(orgId, contactId, {
        servicio,
        fecha: slot.fecha,
        hora: slot.hora,
        duracionMin: duracionMin || 60,
        estado: 'confirmed',
        stylistId: stylistId || slot.stylistId,
        notas,
    });
    return apt ? { success: true, appointmentId: apt.id, appointment: apt } : { success: false };
}

async function cancelAppointment(orgId, appointmentId) {
    const result = await db.updateAppointment(orgId, appointmentId, { estado: 'cancelled' });
    return { success: !!result };
}

// Reagenda una cita EXISTENTE moviéndola al nuevo hueco (UPDATE in-place vía la rama
// {fecha,hora,duracionMin} de db.updateAppointment, que recalcula starts_at/ends_at). No crea
// una fila nueva: evita la cita huérfana/duplicada que dejaba el flujo anterior (creaba con
// bookAppointment y no cancelaba la vieja). Simétrica con book/cancel para poder mockearla.
async function rescheduleAppointment(orgId, appointmentId, slot, { servicio, duracionMin, stylistId, notas } = {}) {
    const result = await db.updateAppointment(orgId, appointmentId, {
        servicio,
        fecha: slot.fecha,
        hora: slot.hora,
        duracionMin: duracionMin || 60,
        stylistId: stylistId || slot.stylistId,
        notas,
    });
    return result ? { success: true, appointmentId: result.id, appointment: result } : { success: false };
}

module.exports = { getAvailableSlots, bookAppointment, cancelAppointment, rescheduleAppointment, formatSlotForMessage };
// Expuesto para tests de regresión (huecos + TZ-independencia), no para uso en producción.
module.exports._internals = { computeFreeSlots, toLocalDateStr, toMinutes, addDaysStr, mondayDow, BUSINESS_TZ };
