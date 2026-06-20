/**
 * calendar-sante.js — Motor de disponibilidad real para salón de belleza
 * Fuente de verdad: stylist_schedules - appointments - schedule_blocks
 */

const db = require('./db');
const logger = require('../lib/logger');

const DIAS_SEMANA = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const SLOT_STEP_MIN = 15; // granularidad de slots

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

    // Filter by skills
    let eligible = allStylists;
    if (serviceCategory) {
        eligible = allStylists.filter(s => {
            const skills = Array.isArray(s.skills) ? s.skills : [];
            return skills.some(skill => skill.toLowerCase() === serviceCategory.toLowerCase());
        });
        if (!eligible.length) eligible = allStylists;
    }

    // If preferred stylist, put her first (but keep others as fallback)
    if (preferredStylistId) {
        eligible.sort((a, b) => {
            if (a.id === preferredStylistId) return -1;
            if (b.id === preferredStylistId) return 1;
            return 0;
        });
    }

    const now = new Date();
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() + 1); // start from tomorrow

    const to = new Date(from);
    to.setDate(to.getDate() + 14);

    const fromStr = from.toISOString();
    const toStr = to.toISOString();

    const slots = [];

    for (const stylist of eligible) {
        const schedule = await db.getStylistSchedule(orgId, stylist.id);
        const blocks = await db.getScheduleBlocks(orgId, stylist.id, fromStr, toStr);
        const appointments = await db.getAppointmentsByStylistAndRange(orgId, stylist.id, fromStr, toStr);

        const scheduleByDay = new Map();
        for (const s of schedule) {
            scheduleByDay.set(s.day_of_week, s);
        }

        // Iterate each day
        for (let d = 0; d < 14; d++) {
            const date = new Date(from);
            date.setDate(from.getDate() + d);

            // JS getDay: 0=Sunday, our schema: 0=Monday
            const jsDay = date.getDay();
            const dayOfWeek = jsDay === 0 ? 6 : jsDay - 1; // convert to 0=Monday

            const daySchedule = scheduleByDay.get(dayOfWeek);
            if (!daySchedule) continue;

            const dateStr = date.toISOString().split('T')[0];
            const diaNombre = DIAS_SEMANA[dayOfWeek];

            // Filter by preference
            if (preferencia.semana === 'siguiente') {
                const endOfThisWeek = new Date(now);
                endOfThisWeek.setDate(now.getDate() + (7 - (now.getDay() || 7)));
                if (date <= endOfThisWeek) continue;
            } else if (preferencia.semana === 'esta') {
                const endOfThisWeek = new Date(now);
                endOfThisWeek.setDate(now.getDate() + (7 - (now.getDay() || 7)));
                if (date > endOfThisWeek) continue;
            }

            // Working hours for this day
            const [startH, startM] = daySchedule.start_time.split(':').map(Number);
            const [endH, endM] = daySchedule.end_time.split(':').map(Number);
            const workStart = startH * 60 + startM;
            const workEnd = endH * 60 + endM;

            // Filter by period preference
            if (preferencia.periodo === 'mañana' || preferencia.periodo === 'manana') {
                if (workStart >= 14 * 60) continue; // skip if starts after 14:00
            } else if (preferencia.periodo === 'tarde') {
                // we'll filter individual slots below
            }

            // Existing appointments for this stylist on this date
            const dayAppts = appointments.filter(a => {
                const aDate = new Date(a.starts_at).toISOString().split('T')[0];
                return aDate === dateStr;
            }).map(a => ({
                start: toMinutes(new Date(a.starts_at)),
                end: toMinutes(new Date(a.ends_at)),
            }));

            // Blocks on this date
            const dayBlocks = blocks.filter(b => {
                const bStart = new Date(b.starts_at).toISOString().split('T')[0];
                const bEnd = new Date(b.ends_at).toISOString().split('T')[0];
                return bStart <= dateStr && bEnd >= dateStr;
            }).map(b => ({
                start: toMinutes(new Date(b.starts_at)),
                end: toMinutes(new Date(b.ends_at)),
            }));

            const occupied = [...dayAppts, ...dayBlocks].sort((a, b) => a.start - b.start);

            // Find free windows
            let cursor = workStart;
            for (const occ of occupied) {
                if (cursor + serviceDuration <= occ.start) {
                    addSlot(slots, dateStr, cursor, diaNombre, stylist, serviceDuration, preferencia);
                }
                cursor = Math.max(cursor, occ.end);
            }
            // After last occupied slot
            if (cursor + serviceDuration <= workEnd) {
                addSlot(slots, dateStr, cursor, diaNombre, stylist, serviceDuration, preferencia);
            }
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

    // Deduplicate: one slot per date-time-stylist combo, max 5
    const seen = new Set();
    const unique = [];
    for (const s of slots) {
        const key = `${s.fecha}-${s.hora}-${s.stylistId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(s);
        if (unique.length >= 5) break;
    }

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
