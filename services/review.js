/**
 * Review Worker — Multi-org
 * Cada 5 minutos: para cada org, envía mensaje de reseña Google
 * N horas después de que la cita se marque como completada.
 */

const { getCompletedAppointmentsForReview, getConfigValue, getAgentConfig, updateAppointment } = require('./db');
const { resolveOutboundClient, resolveAutomatedSend } = require('./outbound');
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

/**
 * Envía la petición de reseña por la vía que corresponda. La reseña sale 2 h DESPUÉS de la
 * cita, así que en Cloud API está fuera de la ventana de 24 h siempre que la clienta no
 * haya escrito ese mismo día: sin plantilla, Meta devuelve 200 y el mensaje no llega,
 * pero `resena_enviada` quedaba en true y esa reseña no se pedía nunca más.
 *
 * @returns {'enviado'|'fallo'|'sin_plantilla'}
 */
async function sendReviewMessage(orgId, { telefono, language, waJid }, { mensaje, templateParams }) {
    const entry = waClients?.get(orgId);
    if (!entry?.client) {
        logger.warn('review_wa_no_disponible', { orgId });
        return 'fallo';
    }
    const chatId = resolveChatId(telefono, waJid);
    if (!chatId) {
        logger.warn('review_sin_chatid', { orgId, telefono });
        return 'fallo';
    }

    const client = resolveOutboundClient(orgId, entry.client);
    if (!client) {
        logger.warn('review_wa_no_disponible', { orgId });
        return 'fallo';
    }

    try {
        const decision = await resolveAutomatedSend(orgId, {
            telefono,
            language: language || 'es',
            plantillaClave: 'plantilla_resena',
        });

        if (decision.mode === 'sin_plantilla') {
            // No marcamos resena_enviada: la cita sigue pendiente hasta que haya plantilla.
            logger.warn('resena_sin_plantilla_configurada', { orgId, telefono, language: language || 'es' });
            return 'sin_plantilla';
        }

        if (decision.mode === 'template') {
            await client.sendTemplate(chatId, {
                name: decision.template.name,
                language: decision.template.language,
                params: templateParams, // [{{1}} nombre, {{2}} enlace]
            });
            logger.info('resena_por_plantilla', { orgId, telefono, plantilla: decision.template.name });
        } else {
            await client.sendMessage(chatId, mensaje);
        }
        return 'enviado';
    } catch (e) {
        logger.error('review_error_envio', { orgId, telefono, chatId, error: e.message });
        return 'fallo';
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
                const resultado = await sendReviewMessage(orgId, { telefono: phone, language, waJid }, {
                    mensaje,
                    templateParams: [nombre || '', googleLink],
                });

                if (resultado === 'enviado') {
                    await updateAppointment(orgId, apt.id, { resenaEnviada: true });
                    logger.info('resena_enviada', { orgId, nombre, telefono: phone });
                }
            }
        } catch (e) {
            logger.error('review_error_org', { orgId, error: e.message });
        }
    }
}

// Inyecta el Map de clientes. Separado de startReviewWorker para que el test pueda
// ejercitar el motor real (checkAndSendReviews) sin arrancar los timers.
function setClients(clients) {
    waClients = clients;
}

function startReviewWorker(clients) {
    setClients(clients);
    logger.info('review_worker_iniciado');
    setInterval(checkAndSendReviews, CHECK_INTERVAL_MS);
    setTimeout(checkAndSendReviews, 2 * 60 * 1000);
}

module.exports = { startReviewWorker, buildReviewMessage, checkAndSendReviews, setClients };
