/**
 * Review Worker — Envía WhatsApp de reseña Google tras la cita
 * Corre cada 5 minutos. Busca citas completadas sin reseña enviada.
 */

const config = require('../config.json');
const { getAppointmentsPendientesResena, marcarResenaSent, getConfigValue } = require('./db');
const logger = require('../lib/logger');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // cada 5 minutos
let waClient = null;

function buildReviewMessage(nombre) {
    const template = config.review?.mensaje ||
        'Hola {nombre} 😊 Esperamos que tu experiencia haya sido genial. Si tienes un momento, nos ayudaría muchísimo que dejaras tu opinión aquí: {link} ¡Gracias!';
    const link = process.env.GOOGLE_REVIEW_LINK || config.review?.googleReviewLink || 'https://g.page/r/';
    return template
        .replace('{nombre}', nombre || '')
        .replace('{link}', link);
}

function calcularMinutosDesde(fechaStr, horaStr) {
    if (!fechaStr) return Infinity;
    try {
        const fechaHora = new Date(`${fechaStr}T${horaStr || '00:00'}:00`);
        return (Date.now() - fechaHora.getTime()) / 60000;
    } catch {
        return Infinity;
    }
}

async function sendReviewMessage(telefono, mensaje) {
    if (!waClient) {
        logger.warn('review_wa_no_disponible');
        return false;
    }
    try {
        const chatId = telefono.includes('@c.us') ? telefono : `${telefono}@c.us`;
        await waClient.sendMessage(chatId, mensaje);
        return true;
    } catch (e) {
        logger.error('review_error_envio', { telefono, error: e.message });
        return false;
    }
}

async function checkAndSendReviews() {
    const minutosDb = getConfigValue('minutos_resena');
    const minutosEspera = minutosDb !== null ? minutosDb : (config.conversation?.minutosResena || config.review?.minutosEspera || 30);

    let pendientes;
    try {
        pendientes = await getAppointmentsPendientesResena();
    } catch (e) {
        logger.error('review_error_db', { error: e.message });
        return;
    }

    for (const record of pendientes) {
        const Nombre    = record.nombre;
        const Telefono  = record.telefono;
        const Fecha_cita = record.fecha_cita;
        const Hora_cita  = record.hora_cita;
        if (!Telefono) continue;

        const minutosTranscurridos = calcularMinutosDesde(Fecha_cita, Hora_cita);
        if (minutosTranscurridos < minutosEspera) continue;

        const mensaje = buildReviewMessage(Nombre);
        const sent = await sendReviewMessage(Telefono, mensaje);

        if (sent) {
            await marcarResenaSent(record.id);
            logger.info('resena_enviada', { nombre: Nombre, telefono: Telefono });
        }
    }
}

/**
 * Inicializa el worker con el cliente de WhatsApp
 * @param {object} client - instancia de whatsapp-web.js Client
 */
function startReviewWorker(client) {
    waClient = client;
    logger.info('review_worker_iniciado');
    setInterval(checkAndSendReviews, CHECK_INTERVAL_MS);
    // Primera comprobación al arrancar (con delay de 1 min para que WA esté listo)
    setTimeout(checkAndSendReviews, 60 * 1000);
}

module.exports = { startReviewWorker };
