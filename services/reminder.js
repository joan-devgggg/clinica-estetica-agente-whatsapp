/**
 * Reminder Worker — Multi-org
 * Cada 5 minutos: para cada org, envía recordatorios 24h antes de la cita
 * y auto-completa citas cuya hora de fin ya pasó.
 */

const { getAppointmentsPendientesRecordatorio, marcarRecordatorioSent, getConfigValue, getAgentConfig, autoCompleteAppointments } = require('./db');
const logger = require('../lib/logger');

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
let waClients = null; // Map<orgId, { client, orgId, ... }>

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

                const mensaje = `Hola ${record.nombre || ''} 😊 Te recordamos tu cita en ${companyName} a las ${record.hora_cita || ''}. ¡Te esperamos!`;
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

module.exports = { startReminderWorker };
