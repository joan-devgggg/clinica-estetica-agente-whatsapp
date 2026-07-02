/**
 * calendar-sante.js — Motor de disponibilidad real para salón de belleza
 * Fuente de verdad: stylist_schedules - appointments - schedule_blocks
 */

const db = require('./db');
const logger = require('../lib/logger');

const DIAS_SEMANA = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const SLOT_OFFER_STEP_MIN = 30; // intervalo entre huecos ofrecidos dentro de una ventana libre (10:00, 10:30, 11:00...)

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
    const todayStr = toLocalDateStr(now);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    if (!preferencia.asap) {
        from.setDate(from.getDate() + 1); // start from tomorrow (default)
    }
    // asap: start from today so we find the nearest real slots

    const to = new Date(from);
    to.setDate(to.getDate() + 14);

    const fromStr = from.toISOString();
    const toStr = to.toISOString();

    // Prefetch blocked days (whole-day closures per stylist or salon-wide)
    const fromDateStr = from.toISOString().slice(0, 10);
    const toDateStr = to.toISOString().slice(0, 10);
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
    function buildSlots(pref) {
        // Pre-compute week bounds once before the loops
        let startOfNextWeek = null, endOfNextWeek = null, endOfThisWeek = null;
        if (pref.semana === 'siguiente') {
            const daysToSunday = 7 - (now.getDay() || 7);
            startOfNextWeek = new Date(now);
            startOfNextWeek.setHours(0, 0, 0, 0);
            startOfNextWeek.setDate(now.getDate() + daysToSunday + 1); // lunes próxima semana
            endOfNextWeek = new Date(startOfNextWeek);
            endOfNextWeek.setDate(startOfNextWeek.getDate() + 6); // domingo próxima semana
            console.log('rango semana siguiente:', toLocalDateStr(startOfNextWeek), toLocalDateStr(endOfNextWeek));
        } else if (pref.semana === 'esta') {
            endOfThisWeek = new Date(now);
            endOfThisWeek.setDate(now.getDate() + (7 - (now.getDay() || 7)));
        }

        const out = [];
        for (const { stylist, scheduleByDay, blocks, appointments } of stylistData) {
            for (let d = 0; d < 14; d++) {
                const date = new Date(from);
                date.setDate(from.getDate() + d);

                // JS getDay: 0=Sunday, our schema: 0=Monday
                const jsDay = date.getDay();
                const dayOfWeek = jsDay === 0 ? 6 : jsDay - 1; // convert to 0=Monday

                const daySchedule = scheduleByDay.get(dayOfWeek);
                if (!daySchedule) continue; // la estilista NO trabaja este día → sin huecos

                const dateStr = toLocalDateStr(date);

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
                if (pref.semana === 'siguiente') {
                    if (date < startOfNextWeek || date > endOfNextWeek) continue;
                } else if (pref.semana === 'esta') {
                    if (date > endOfThisWeek) continue;
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

                const occupied = [...dayAppts, ...dayBlocks].sort((a, b) => a.start - b.start);

                // Construir las ventanas libres (huecos entre citas/bloqueos y hasta el cierre).
                const freeWindows = [];
                let cursor = workStart;
                for (const occ of occupied) {
                    if (occ.start > cursor) freeWindows.push([cursor, Math.min(occ.start, workEnd)]);
                    cursor = Math.max(cursor, occ.end);
                }
                if (cursor < workEnd) freeWindows.push([cursor, workEnd]);

                // Recorrer cada ventana en pasos de SLOT_OFFER_STEP_MIN para ofrecer varios
                // huecos (10:00, 11:00, 12:00...), no solo el inicio de la ventana.
                // ASAP + hoy: saltar huecos que ya han pasado (buffer de 60 min).
                const minStart = (pref.asap && dateStr === todayStr) ? nowMinutes + 60 : 0;
                for (const [winStart, winEnd] of freeWindows) {
                    // t + serviceDuration <= winEnd: no solapar la siguiente cita ni salir de
                    // la ventana libre. Además t + serviceDuration < workEnd: nunca ofrecer un
                    // hueco cuya cita terminaría exactamente al cierre o después (sin margen).
                    for (let t = winStart; t + serviceDuration <= winEnd && t + serviceDuration < workEnd; t += SLOT_OFFER_STEP_MIN) {
                        if (t < minStart) continue;
                        addSlot(out, dateStr, t, diaNombre, stylist, serviceDuration, pref);
                    }
                }
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
        const { fecha, diaSemana, ...resto } = preferencia;
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

function toMinutes(date) {
    return date.getHours() * 60 + date.getMinutes();
}

// Formatea una fecha como YYYY-MM-DD en hora LOCAL (no UTC).
// Imprescindible: date.toISOString() convierte a UTC y, en zonas adelantadas
// (España, UTC+1/+2), la medianoche local cae el día anterior → desfase de un día.
function toLocalDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
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

module.exports = { getAvailableSlots, bookAppointment, cancelAppointment, formatSlotForMessage };
