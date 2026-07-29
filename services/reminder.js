/**
 * Reminder Worker — Multi-org
 * Cada 5 minutos: para cada org, envía recordatorios 24h antes de la cita
 * y auto-completa citas cuya hora de fin ya pasó.
 */

const { getAppointmentsPendientesRecordatorio, marcarRecordatorioSent, getConfigValue, getAgentConfig, autoCompleteAppointments } = require('./db');
const logger = require('../lib/logger');

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
let waClients = null; // Map<orgId, { client, orgId, ... }>

// Mismo patrón que REVIEW_TEMPLATES en review.js: la clienta habla en su idioma durante
// toda la conversación (bot.js detecta ES/EN/RU/UK), así que el recordatorio no puede ser
// el único mensaje que le llega siempre en español.
const REMINDER_TEMPLATES = {
    es: (nombre, salon, hora) =>
        `Hola ${nombre || ''} 😊 Te recordamos tu cita en ${salon} a las ${hora || ''}. ¡Te esperamos!`,
    en: (nombre, salon, hora) =>
        `Hi ${nombre || ''} 😊 Just a reminder of your appointment at ${salon} at ${hora || ''}. See you soon!`,
    ru: (nombre, salon, hora) =>
        `Привет ${nombre || ''} 😊 Напоминаем о вашей записи в ${salon} в ${hora || ''}. Ждём вас!`,
    uk: (nombre, salon, hora) =>
        `Привіт ${nombre || ''} 😊 Нагадуємо про ваш запис у ${salon} о ${hora || ''}. Чекаємо на вас!`,
};

function buildReminderMessage(nombre, salon, hora, language) {
    const template = REMINDER_TEMPLATES[language] || REMINDER_TEMPLATES.es;
    return template(nombre, salon, hora);
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

// Resuelve el chatId de WhatsApp. Prioriza el JID canónico persistido (contacts.metadata.wa_jid);
// para un LID (~15 dígitos) usa @lid y para un número real @c.us. Evita "<lid>@c.us" (chat
// inexistente que hace fallar el envío).
function resolveChatId(telefono, waJid) {
    if (waJid && typeof waJid === 'string' && waJid.includes('@')) return waJid;
    const digits = String(telefono || '').replace(/@c\.us$|@lid$/g, '').replace(/\D/g, '');
    if (!digits) return null;
    return digits.length >= 14 ? `${digits}@lid` : `${digits}@c.us`;
}

async function sendReminderMessage(orgId, telefono, mensaje, waJid) {
    const entry = waClients?.get(orgId);
    if (!entry?.client) {
        logger.warn('reminder_wa_no_disponible', { orgId });
        return false;
    }
    const chatId = resolveChatId(telefono, waJid);
    if (!chatId) {
        logger.warn('reminder_sin_chatid', { orgId, telefono });
        return false;
    }
    try {
        await entry.client.sendMessage(chatId, mensaje);
        return true;
    } catch (e) {
        logger.error('reminder_error_envio', { orgId, telefono, chatId, error: e.message });
        return false;
    }
}

async function checkAndSendReminders() {
    if (!waClients) return;

    for (const [orgId] of waClients) {
        try {
            // Auto-completar citas pasadas
            await autoCompleteAppointments(orgId);

            // Recordatorios
            const minutosDb = await getConfigValue(orgId, 'minutos_recordatorio');
            const minutosAntes = minutosDb !== null ? Number(minutosDb) : 1440;

            const agentCfg = await getAgentConfig(orgId);
            const info = agentCfg?.business_info || {};
            const companyName = info.companyName || 'nuestro centro';
            const botName = info.botName || '';

            const pendientes = await getAppointmentsPendientesRecordatorio(orgId);

            for (const record of pendientes) {
                if (!record.telefono || !record.fecha_cita) continue;

                const minutosRestantes = minutosHastaCita(record.fecha_cita, record.hora_cita);
                if (minutosRestantes < 0 || minutosRestantes > minutosAntes) continue;

                const mensaje = buildReminderMessage(record.nombre, companyName, record.hora_cita, record.language);
                const sent = await sendReminderMessage(orgId, record.telefono, mensaje, record.wa_jid);

                if (sent) {
                    await marcarRecordatorioSent(orgId, record.id);
                    logger.info('recordatorio_enviado', { orgId, nombre: record.nombre, telefono: record.telefono, minutos_restantes: Math.round(minutosRestantes) });
                }
            }
        } catch (e) {
            logger.error('reminder_error_org', { orgId, error: e.message });
        }
    }
}

function startReminderWorker(clients) {
    waClients = clients;
    logger.info('reminder_worker_iniciado');
    setInterval(checkAndSendReminders, CHECK_INTERVAL_MS);
    setTimeout(checkAndSendReminders, 60 * 1000);
}

module.exports = { startReminderWorker, buildReminderMessage };
