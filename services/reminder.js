/**
 * Reminder Worker — Envía WhatsApp de recordatorio antes de la cita
 * Corre cada 5 minutos. Busca citas confirmadas cuyo recordatorio no se ha enviado
 * y que estén dentro del margen configurado (minutosAntes).
 */

const config = require('../config.json');
const { getLeadsPendientesRecordatorio, marcarRecordatorioSent, getConfigValue } = require('./db');

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
let waClient = null;

function buildReminderMessage(nombre, hora) {
    const template = config.reminder?.mensaje ||
        'Hola {nombre} 😊 Te recordamos que tienes tu cita en {clinica} a las {hora}. ¡Te esperamos!';
    return template
        .replace('{nombre}', nombre || '')
        .replace('{clinica}', config.companyName || 'la clínica')
        .replace('{hora}', hora || '');
}

function minutosHastaCita(fechaStr, horaStr) {
    if (!fechaStr) return Infinity;
    try {
        const fechaHora = new Date(`${fechaStr}T${horaStr || '00:00'}:00`);
        return (fechaHora.getTime() - Date.now()) / 60000;
    } catch {
        return Infinity;
    }
}

async function sendReminderMessage(telefono, mensaje) {
    if (!waClient) {
        console.warn('⚠️ Reminder worker: cliente WhatsApp no disponible');
        return false;
    }
    try {
        const chatId = telefono.includes('@c.us') ? telefono : `${telefono}@c.us`;
        await waClient.sendMessage(chatId, mensaje);
        return true;
    } catch (e) {
        console.error('Reminder worker error enviando WA:', e.message);
        return false;
    }
}

async function checkAndSendReminders() {
    const horasDb = getConfigValue('horas_recordatorio');
    const minutosAntes = horasDb !== null ? horasDb * 60 : (config.reminder?.minutosAntes ?? 60);

    let pendientes;
    try {
        pendientes = await getLeadsPendientesRecordatorio();
    } catch (e) {
        console.error('Reminder worker error consultando Airtable:', e.message);
        return;
    }

    for (const record of pendientes) {
        const Nombre     = record.nombre;
        const Telefono   = record.telefono;
        const Fecha_cita = record.fecha_cita;
        const Hora_cita  = record.hora_cita;
        if (!Telefono || !Fecha_cita) continue;

        const minutosRestantes = minutosHastaCita(Fecha_cita, Hora_cita);

        // Solo enviar si la cita está en el futuro y dentro del margen configurado
        if (minutosRestantes < 0 || minutosRestantes > minutosAntes) continue;

        const mensaje = buildReminderMessage(Nombre, Hora_cita);
        const sent = await sendReminderMessage(Telefono, mensaje);

        if (sent) {
            await marcarRecordatorioSent(record.id);
            console.log(`🔔 Recordatorio enviado a ${Nombre} (${Telefono}) — cita en ${Math.round(minutosRestantes)} min`);
        }
    }
}

function startReminderWorker(client) {
    waClient = client;
    console.log('🔔 Reminder worker iniciado — comprobando cada 5 minutos');
    setInterval(checkAndSendReminders, CHECK_INTERVAL_MS);
    setTimeout(checkAndSendReminders, 60 * 1000);
}

module.exports = { startReminderWorker };
