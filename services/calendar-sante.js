/**
 * calendar-sante.js — Motor de disponibilidad real para salón de belleza
 * Fuente de verdad: stylist_schedules - appointments - schedule_blocks
 */

const db = require('./db');
const logger = require('../lib/logger');
// Aritmética de fecha/hora del negocio (TZ-safe, pura). Compartida con date-preference.js:
// la resolución "día+semana → fecha" tiene que ser LA MISMA en el motor y en el reducer de
// preferencia, o el bot verbaliza una fecha y busca huecos en otra.
const { BUSINESS_TZ, toMinutes, toLocalDateStr, addDaysStr, mondayDow, resolveWeekdayToDate } = require('./date-utils');

const DIAS_SEMANA = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const SLOT_OFFER_STEP_MIN = 30; // intervalo entre huecos ofrecidos dentro de una ventana libre (10:00, 10:30, 11:00...)
// Mínimo de días de calendario que debe cubrir la ventana de `semana:'esta'` para seguir
// siendo un filtro DURO. Por debajo, se relaja (ver buildSlots).
const MIN_DIAS_VENTANA_SEMANA = 2;

// Causas por las que el motor puede devolver CERO huecos. Antes las cinco eran
// indistinguibles —un `[]` pelado— y el bot acababa comunicando un salón lleno como si
// fuera una avería técnica ("problema técnico… paso tu solicitud al equipo"), que es
// exactamente lo que le pasó a una clienta real el 27/07/2026 con la agenda vacía.
// Un error de BD ya no llega hasta aquí: db.js lanza (ver assertRead).
const CAUSAS_CERO = {
    SIN_ESTILISTAS: 'sin_estilistas',                   // la org no tiene estilistas activas
    SIN_SKILL: 'sin_skill',                             // nadie sabe hacer ese servicio
    SIN_HORARIO: 'sin_horario',                         // nadie trabaja ningún día del rango
    NO_CABE: 'no_cabe_antes_del_cierre',                // el servicio no cabe en la jornada
    AGENDA_LLENA: 'agenda_llena',                       // hay hueco teórico, pero está todo cogido
};

// Marca la causa en el array de resultado. `causa` es null cuando SÍ hay huecos: el
// llamador distingue "no hay nada que decir" de cada motivo concreto.
function conCausa(slots, causa) {
    slots.causa = causa || null;
    return slots;
}

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
    if (!allStylists.length) return conCausa([], 'sin_estilistas');

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
            return conCausa([], 'sin_skill');
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

    // ¿Se ha tenido que soltar (total o parcialmente) el filtro de semana que pidió la
    // clienta? El bot lo usa para DECIRLO en voz alta en vez de proponer en silencio días de
    // otra semana. Lo escribe buildSlots (ventana blanda) y la ETAPA A del fallback.
    let weekPreferenceRelaxed = false;

    function buildSlots(pref) {
        // Límites de semana como strings YYYY-MM-DD (comparables con < y >).
        let startOfNextWeekStr = null, endOfNextWeekStr = null, endOfThisWeekStr = null;
        // La ventana de 'esta' se encoge un día por jornada: un viernes deja 2 días y un
        // sábado deja 1 (domingo, cerrado). Por debajo de MIN_DIAS_VENTANA_SEMANA deja de
        // tener sentido como filtro DURO — solo produce falsos "no hay huecos" — y pasa a ser
        // preferencia blanda: no acota, y se avisa a la clienta (weekPreferenceRelaxed).
        let ventanaSemanaBlanda = false;
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
            const diasEnVentana = (6 - startDow) + 1;
            if (diasEnVentana < MIN_DIAS_VENTANA_SEMANA) {
                ventanaSemanaBlanda = true;
                weekPreferenceRelaxed = true;
                logger.info('sante_ventana_semana_relajada', { orgId, startDateStr, endOfThisWeekStr, diasEnVentana });
            }
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
                    } else if (pref.semana === 'esta' && !ventanaSemanaBlanda) {
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
    if (!slots.length && (preferencia.semana || preferencia.fecha || Number.isInteger(preferencia.diaSemana))) {
        // ETAPA A — soltar SOLO el filtro de semana, CONSERVANDO el día pedido. La ventana de
        // 'esta'/'siguiente' es la restricción que más falsos vacíos produce: cerca del fin de
        // semana "esta semana" se queda en 1-2 días y excluye el día que la clienta acaba de
        // pedir (bug real del 24/07: viernes + "el más cercano" → "mañana" → "lunes" daba 0
        // huecos del lunes teniendo 16 libres). Si con el día intacto SÍ hay huecos, el día
        // pedido está disponible y no hay nada que advertir → pedidoDiaSinHueco sigue false.
        if (preferencia.semana) {
            const { semana, ...sinSemana } = preferencia;
            slots = buildSlots(sinSemana);
            // Si estos huecos salen de haber soltado la semana, la clienta pidió una semana
            // que no podemos honrar: hay que decírselo, no proponer otra en silencio.
            if (slots.length) weekPreferenceRelaxed = true;
        }
        // ETAPA B — si sigue vacío, es el DÍA pedido el que no tiene hueco. Soltamos también
        // día/fecha para proponer las alternativas reales más cercanas, nunca inventadas, y
        // marcamos la bandera para que el bot lo avise. Cuerpo idéntico al anterior.
        if (!slots.length && (preferencia.fecha || Number.isInteger(preferencia.diaSemana))) {
            const { fecha, diaSemana, semana, ...resto } = preferencia;
            slots = buildSlots(resto);
            pedidoDiaSinHueco = slots.length > 0;
        }
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

    // Banderas para que el bot avise al LLM en vez de callarse:
    //  - requestedDayUnavailable: el DÍA pedido no tenía disponibilidad real y estos son los
    //    huecos más cercanos (alternativas verídicas, no inventadas).
    //  - weekPreferenceRelaxed: la SEMANA pedida no se ha podido honrar (ventana agotada o
    //    sin huecos) y estos huecos caen fuera de ella.
    unique.requestedDayUnavailable = pedidoDiaSinHueco;
    unique.weekPreferenceRelaxed = weekPreferenceRelaxed && unique.length > 0;

    if (unique.length) return conCausa(unique, null);

    // Cero real tras haberlo intentado todo (incluidas ETAPA A y B). Se diagnostica el
    // PORQUÉ recorriendo lo que ya está en memoria — sin volver a la BD — para que el bot
    // pueda decir la verdad ("está completo" / "no cabe en la jornada") en vez del
    // "no hay huecos cargados" genérico que el LLM interpreta como avería.
    let hayAlgunaJornada = false;   // ¿alguien trabaja algún día del rango?
    let cabeEnAlgunaJornada = false; // ¿el servicio cabe en alguna de esas jornadas?
    for (const { scheduleByDay } of stylistData) {
        for (const { dayOfWeek } of calendarDays) {
            const ds = scheduleByDay.get(dayOfWeek);
            if (!ds) continue;
            hayAlgunaJornada = true;
            const [sH, sM] = ds.start_time.split(':').map(Number);
            const [eH, eM] = ds.end_time.split(':').map(Number);
            // Mismo criterio estricto que computeFreeSlots: la cita debe TERMINAR antes del
            // cierre, no justo al cierre.
            if ((sH * 60 + sM) + serviceDuration < (eH * 60 + eM)) { cabeEnAlgunaJornada = true; break; }
        }
        if (cabeEnAlgunaJornada) break;
    }

    const causa = !hayAlgunaJornada ? CAUSAS_CERO.SIN_HORARIO
        : !cabeEnAlgunaJornada ? CAUSAS_CERO.NO_CABE
        : CAUSAS_CERO.AGENDA_LLENA;

    logger.warn('sante_cero_huecos_diagnosticado', {
        orgId, causa, serviceCategory, serviceDuration,
        estilistasElegibles: eligible.length,
        preferencia,
    });
    return conCausa(unique, causa);
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

module.exports = { getAvailableSlots, bookAppointment, cancelAppointment, rescheduleAppointment, formatSlotForMessage, CAUSAS_CERO };
// Expuesto para tests de regresión (huecos + TZ-independencia), no para uso en producción.
module.exports._internals = { computeFreeSlots, toLocalDateStr, toMinutes, addDaysStr, mondayDow, resolveWeekdayToDate, BUSINESS_TZ };
