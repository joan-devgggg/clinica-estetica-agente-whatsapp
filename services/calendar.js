/**
 * Calendar Adapter — Interfaz genérica de calendario
 * Actualmente usa datos mock para desarrollo.
 * Cuando la clínica decida el sistema (Calendly, Acuity, Google Calendar, etc.)
 * se implementan los métodos reales sin tocar el resto del código.
 */

const config = require('../config.json');
const logger = require('../lib/logger');

// Mock: slots disponibles para los próximos 7 días
function generateMockSlots() {
    const slots = [];
    const now = new Date();
    const horario = config.horario || {};
    const diasSemana = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

    for (let d = 1; d <= 14; d++) {
        const date = new Date(now);
        date.setDate(now.getDate() + d);
        const diaNombre = diasSemana[date.getDay()];
        const horarioDia = horario[diaNombre];
        if (!horarioDia) continue;

        const [hApertura] = horarioDia.apertura.split(':').map(Number);
        const [hCierre] = horarioDia.cierre.split(':').map(Number);

        for (let h = hApertura; h < hCierre; h++) {
            slots.push({
                id: `slot_${date.toISOString().split('T')[0]}_${h}`,
                fecha: date.toISOString().split('T')[0],
                hora: `${String(h).padStart(2, '0')}:00`,
                diaNombre,
                periodo: h < 14 ? 'mañana' : 'tarde',
                disponible: true
            });
        }
    }
    return slots;
}

/**
 * Filtra slots según preferencia del cliente
 * preferencia: { periodo?: 'mañana'|'tarde', semana?: 'esta'|'siguiente' }
 */
function filtrarPorPreferencia(slots, preferencia = {}) {
    let filtered = [...slots];

    if (preferencia.periodo) {
        filtered = filtered.filter(s => s.periodo === preferencia.periodo);
    }

    if (preferencia.semana === 'siguiente') {
        const hoy = new Date();
        const finDeEsta = new Date(hoy);
        finDeEsta.setDate(hoy.getDate() + (7 - hoy.getDay()));
        filtered = filtered.filter(s => new Date(s.fecha) > finDeEsta);
    } else if (preferencia.semana === 'esta') {
        const hoy = new Date();
        const finDeEsta = new Date(hoy);
        finDeEsta.setDate(hoy.getDate() + (7 - hoy.getDay()));
        filtered = filtered.filter(s => new Date(s.fecha) <= finDeEsta);
    }

    return filtered;
}

/**
 * Obtiene slots disponibles según preferencia del cliente
 * @param {object} preferencia - { periodo, semana }
 * @param {number} duracionMinutos - duración del tratamiento
 * @returns {Array} slots disponibles ordenados
 */
async function getAvailableSlots(preferencia = {}, duracionMinutos = 60) {
    // TODO: reemplazar por llamada a API real (Calendly, Acuity, etc.)
    const allSlots = generateMockSlots();
    const filtered = filtrarPorPreferencia(allSlots, preferencia);
    return filtered.slice(0, 5); // Devolver máximo 5 opciones
}

/**
 * Reserva un slot para un cliente
 * @param {object} slot - slot a reservar
 * @param {object} clientData - { nombre, telefono, tratamiento }
 * @returns {object} { success, appointmentId, slot }
 */
async function bookAppointment(slot, clientData) {
    // TODO: reemplazar por llamada a API real
    logger.info('mock_cita_reservada', { fecha: slot.fecha, hora: slot.hora, nombre: clientData.nombre });
    return {
        success: true,
        appointmentId: `apt_${slot.id}_${Date.now()}`,
        slot
    };
}

/**
 * Cancela una cita existente
 * @param {string} appointmentId
 */
async function cancelAppointment(appointmentId) {
    // TODO: reemplazar por llamada a API real
    logger.info('mock_cita_cancelada', { appointmentId });
    return { success: true };
}

/**
 * Reagenda una cita
 * @param {string} appointmentId
 * @param {object} newSlot
 */
async function rescheduleAppointment(appointmentId, newSlot) {
    // TODO: reemplazar por llamada a API real
    logger.info('mock_cita_reagendada', { appointmentId, fecha: newSlot.fecha, hora: newSlot.hora });
    return { success: true, appointmentId, slot: newSlot };
}

/**
 * Obtiene citas completadas desde una fecha dada (para el worker de reseñas)
 * @param {Date} since
 * @returns {Array} citas completadas
 */
async function getCompletedAppointments(since) {
    // TODO: reemplazar por llamada a API real
    // En producción, esto consultará el calendario para citas finalizadas
    return [];
}

/**
 * Formatea un slot para mostrarlo en WhatsApp de forma natural
 */
function formatSlotForMessage(slot) {
    const diasEs = {
        lunes: 'el lunes', martes: 'el martes', miercoles: 'el miércoles',
        jueves: 'el jueves', viernes: 'el viernes', sabado: 'el sábado', domingo: 'el domingo'
    };
    const fecha = new Date(slot.fecha + 'T00:00:00');
    const dia = fecha.getDate();
    const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const mes = meses[fecha.getMonth()];
    return `${diasEs[slot.diaNombre]} ${dia} de ${mes} a las ${slot.hora}`;
}

module.exports = {
    getAvailableSlots,
    bookAppointment,
    cancelAppointment,
    rescheduleAppointment,
    getCompletedAppointments,
    formatSlotForMessage
};
