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

async function sendReviewMessage(orgId, telefono, mensaje) {
    const entry = waClients?.get(orgId);
    if (!entry?.client) {
        logger.warn('review_wa_no_disponible', { orgId });
        return false;
    }
    try {
        const chatId = telefono.includes('@c.us') ? telefono : `${telefono}@c.us`;
        await entry.client.sendMessage(chatId, mensaje);
        return true;
    } catch (e) {
        logger.error('review_error_envio', { orgId, telefono, error: e.message });
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
                if (!phone) continue;

                const mensaje = buildReviewMessage(nombre, companyName, googleLink, language);
                const sent = await sendReviewMessage(orgId, phone, mensaje);

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
