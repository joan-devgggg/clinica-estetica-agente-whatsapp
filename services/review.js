/**
 * Review Worker — Multi-org
 * Cada 5 minutos: para cada org, envía mensaje de reseña Google
 * N horas después de que la cita se marque como completada.
 */

const { getCompletedAppointmentsForReview, getConfigValue, getAgentConfig, updateAppointment } = require('./db');
const logger = require('../lib/logger');

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
let waClients = null;

const REVIEW_TEMPLATES = {
    es: (nombre, salon, link) =>
        `Hola ${nombre || ''} 😊 Esperamos que hayas disfrutado tu visita a ${salon}. Nos encantaría conocer tu opinión:\n${link}`,
    en: (nombre, salon, link) =>
        `Hi ${nombre || ''} 😊 We hope you enjoyed your visit to ${salon}. We'd love to hear your feedback:\n${link}`,
    ru: (nombre, salon, link) =>
        `Привет ${nombre || ''} 😊 Надеемся, вам понравился визит в ${salon}. Будем рады вашему отзыву:\n${link}`,
    uk: (nombre, salon, link) =>
        `Привіт ${nombre || ''} 😊 Сподіваємось, вам сподобався візит до ${salon}. Будемо раді вашому відгуку:\n${link}`,
};

function buildReviewMessage(nombre, salon, link, language) {
    const template = REVIEW_TEMPLATES[language] || REVIEW_TEMPLATES.es;
    return template(nombre, salon, link);
}

// Resuelve el chatId de WhatsApp. Prioriza el JID canónico persistido (contacts.metadata.wa_jid,
// p.ej. "<lid>@lid"); si no, para un LID (~15 dígitos) usa @lid y para un número real @c.us.
// Construir "<lid>@c.us" apunta a un chat inexistente y el envío falla ("No LID for user").
function resolveChatId(telefono, waJid) {
    if (waJid && typeof waJid === 'string' && waJid.includes('@')) return waJid;
    const digits = String(telefono || '').replace(/@c\.us$|@lid$/g, '').replace(/\D/g, '');
    if (!digits) return null;
    return digits.length >= 14 ? `${digits}@lid` : `${digits}@c.us`;
}

async function sendReviewMessage(orgId, telefono, mensaje, waJid) {
    const entry = waClients?.get(orgId);
    if (!entry?.client) {
        logger.warn('review_wa_no_disponible', { orgId });
        return false;
    }
    const chatId = resolveChatId(telefono, waJid);
    if (!chatId) {
        logger.warn('review_sin_chatid', { orgId, telefono });
        return false;
    }
    try {
        await entry.client.sendMessage(chatId, mensaje);
        return true;
    } catch (e) {
        logger.error('review_error_envio', { orgId, telefono, chatId, error: e.message });
        return false;
    }
}

async function checkAndSendReviews() {
    if (!waClients) return;

    for (const [orgId] of waClients) {
        try {
            const horasResenaDb = await getConfigValue(orgId, 'horas_resena');
            const horasResena = horasResenaDb !== null ? Number(horasResenaDb) : null;
            if (horasResena === null) continue;

            const agentCfg = await getAgentConfig(orgId);
            const info = agentCfg?.business_info || {};
            const googleLink = info.googleReviewLink;
            if (!googleLink) continue;

            const companyName = info.companyName || 'nuestro centro';
            const pendientes = await getCompletedAppointmentsForReview(orgId, horasResena);

            for (const apt of pendientes) {
                const phone = apt.contacts?.wa_phone || apt.phone;
                const nombre = apt.contacts?.full_name || apt.full_name;
                const language = apt.contacts?.language || 'es';
                const waJid = apt.contacts?.metadata?.wa_jid || null;
                if (!phone) continue;

                const mensaje = buildReviewMessage(nombre, companyName, googleLink, language);
                const sent = await sendReviewMessage(orgId, phone, mensaje, waJid);

                if (sent) {
                    await updateAppointment(orgId, apt.id, { resenaEnviada: true });
                    logger.info('resena_enviada', { orgId, nombre, telefono: phone });
                }
            }
        } catch (e) {
            logger.error('review_error_org', { orgId, error: e.message });
        }
    }
}

function startReviewWorker(clients) {
    waClients = clients;
    logger.info('review_worker_iniciado');
    setInterval(checkAndSendReviews, CHECK_INTERVAL_MS);
    setTimeout(checkAndSendReviews, 2 * 60 * 1000);
}

module.exports = { startReviewWorker };
