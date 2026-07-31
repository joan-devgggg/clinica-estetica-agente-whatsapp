/**
 * Reminder Worker — Multi-org
 * Cada 5 minutos: para cada org, envía recordatorios 24h antes de la cita
 * y auto-completa citas cuya hora de fin ya pasó.
 */

const { getAppointmentsPendientesRecordatorio, marcarRecordatorioSent, getConfigValue, getAgentConfig, autoCompleteAppointments } = require('./db');
const { resolveOutboundClient, resolveAutomatedSend } = require('./outbound');
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

/**
 * Envía el recordatorio por la vía que corresponda.
 *
 * En Cloud API (Sante) el texto libre SOLO se entrega dentro de las 24 h desde el último
 * mensaje entrante de la clienta, y entre reservar y la visita pasan días: el recordatorio
 * cae fuera casi siempre. Antes se mandaba igual, Meta respondía 200, y el worker marcaba
 * `recordatorio_enviado = true` sobre un mensaje que nadie recibió — y ya no se reintentaba.
 * Fuera de ventana va por plantilla aprobada.
 *
 * @returns {'enviado'|'fallo'|'sin_plantilla'}
 */
async function sendReminderMessage(orgId, record, { mensaje, templateParams }) {
    const entry = waClients?.get(orgId);
    if (!entry?.client) {
        logger.warn('reminder_wa_no_disponible', { orgId });
        return 'fallo';
    }
    const chatId = resolveChatId(record.telefono, record.wa_jid);
    if (!chatId) {
        logger.warn('reminder_sin_chatid', { orgId, telefono: record.telefono });
        return 'fallo';
    }

    const client = resolveOutboundClient(orgId, entry.client);
    if (!client) {
        logger.warn('reminder_wa_no_disponible', { orgId });
        return 'fallo';
    }

    try {
        const decision = await resolveAutomatedSend(orgId, {
            telefono: record.telefono,
            language: record.language || 'es',
            plantillaClave: 'plantilla_recordatorio',
        });

        if (decision.mode === 'sin_plantilla') {
            // No marcamos enviado: queda pendiente y saldrá solo en cuanto se configure.
            logger.warn('recordatorio_sin_plantilla_configurada', {
                orgId, telefono: record.telefono, language: record.language || 'es',
            });
            return 'sin_plantilla';
        }

        if (decision.mode === 'template') {
            await client.sendTemplate(chatId, {
                name: decision.template.name,
                language: decision.template.language,
                params: templateParams, // [{{1}} nombre, {{2}} hora]
            });
            logger.info('recordatorio_por_plantilla', {
                orgId, telefono: record.telefono, plantilla: decision.template.name,
            });
        } else {
            await client.sendMessage(chatId, mensaje);
        }
        return 'enviado';
    } catch (e) {
        logger.error('reminder_error_envio', { orgId, telefono: record.telefono, chatId, error: e.message });
        return 'fallo';
    }
}

async function checkAndSendReminders() {
    if (!waClients) return;

    for (const [orgId] of waClients) {
        try {
            // Auto-completar citas pasadas
            await autoCompleteAppointments(orgId);

            // Recordatorios.
            // Se leen las DOS claves porque las orgs no las escriben igual: San Remo tiene
            // `minutos_recordatorio`, Sante `horas_recordatorio`. Mirando solo la primera, el
            // 24 de Sante era una config muerta —funcionaba por el default de 1440— y
            // cambiarla no habría surtido ningún efecto.
            const minutosDb = await getConfigValue(orgId, 'minutos_recordatorio');
            const horasDb   = minutosDb === null ? await getConfigValue(orgId, 'horas_recordatorio') : null;
            const minutosAntes = minutosDb !== null ? Number(minutosDb)
                               : horasDb !== null ? Number(horasDb) * 60
                               : 1440;

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
                const resultado = await sendReminderMessage(orgId, record, {
                    mensaje,
                    templateParams: [record.nombre || '', record.hora_cita || ''],
                });

                if (resultado === 'enviado') {
                    await marcarRecordatorioSent(orgId, record.id);
                    logger.info('recordatorio_enviado', { orgId, nombre: record.nombre, telefono: record.telefono, minutos_restantes: Math.round(minutosRestantes) });
                }
            }
        } catch (e) {
            logger.error('reminder_error_org', { orgId, error: e.message });
        }
    }
}

// Inyecta el Map de clientes. Separado de startReminderWorker para que el test pueda
// ejercitar el motor real (checkAndSendReminders) sin arrancar los timers.
function setClients(clients) {
    waClients = clients;
}

function startReminderWorker(clients) {
    setClients(clients);
    logger.info('reminder_worker_iniciado');
    setInterval(checkAndSendReminders, CHECK_INTERVAL_MS);
    setTimeout(checkAndSendReminders, 60 * 1000);
}

module.exports = { startReminderWorker, buildReminderMessage, checkAndSendReminders, setClients };
