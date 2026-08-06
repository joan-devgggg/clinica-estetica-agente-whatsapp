/**
 * Review Worker — Multi-org
 * Cada 5 minutos: para cada org, envía mensaje de reseña Google
 * N horas después de que la cita se marque como completada.
 */

const { getCompletedAppointmentsForReview, getConfigValue, getAgentConfig, updateAppointment } = require('./db');
const { resolveOutboundClient, resolveAutomatedSend } = require('./outbound');
const { noteSendResult } = require('./channel-health');
const { alertOnce } = require('./admin-alerts');
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
async function sendReviewMessage(orgId, { telefono, language, waJid }, { mensaje, templateParams }, { client: clientOverride = null } = {}) {
    // El panel resuelve su propio cliente saliente (getOutboundClient) y lo inyecta; el
    // worker lo saca de su Map. Un solo embudo de envío para los dos, que es justo lo que
    // faltaba: la ruta del panel no mandaba nada.
    let client = clientOverride;
    if (!client) {
        const entry = waClients?.get(orgId);
        if (!entry?.client) {
            logger.warn('review_wa_no_disponible', { orgId });
            return 'fallo';
        }
        client = resolveOutboundClient(orgId, entry.client);
    }
    const chatId = resolveChatId(telefono, waJid);
    if (!chatId) {
        logger.warn('review_sin_chatid', { orgId, telefono });
        return 'fallo';
    }

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
        // Salud del canal: este envío no pasa por waSendMessage, así que se reporta aquí.
        noteSendResult(orgId, { ok: true });
        return 'enviado';
    } catch (e) {
        logger.error('review_error_envio', { orgId, telefono, chatId, error: e.message });
        noteSendResult(orgId, { ok: false, error: e, contexto: 'petición de reseña' });
        return 'fallo';
    }
}

// ─── Enviar y APUNTAR son dos cosas, y entre las dos cabe una reseña repetida ────────────
//
// El envío marcaba con un `updateAppointment` suelto, y esa función LANZA ante cualquier
// error de escritura. El `try` que lo recogía estaba al nivel de la ORG, fuera del bucle de
// citas, así que un fallo de marcado con el mensaje ya entregado hacía dos cosas: abortaba el
// resto de citas pendientes de esa org en ese tic, y dejaba `resena_enviada` en false — o sea
// que al tic siguiente (5 min) la misma cita volvía a estar pendiente y la clienta recibía la
// petición otra vez. Y otra. Cada cinco minutos hasta que la escritura funcionara.
//
// Regla, la misma que sostiene el registro de campañas: **después de un envío entregado, el
// marcado se reintenta y su fallo NUNCA puede convertirse en un segundo envío.**
//
// Tres piezas: reintentos, memoria de lo entregado-sin-apuntar (para que el tic siguiente
// reintente el MARCADO en vez de reenviar), y aviso a una persona cuando aun así no se pudo.
const REINTENTOS_MARCADO = 3;

// `${orgId}|${appointmentId}` → { desde }. En RAM y a propósito: un reinicio la pierde y esa
// cita podría recibir una segunda petición, que es exactamente el riesgo que ya se asume en
// `admin-alerts` y en el registro de campañas. Persistirlo es marcar la fila, y marcar la
// fila es justo lo que no se ha podido hacer.
const enviadasSinMarcar = new Map();
const claveMarcado = (orgId, appointmentId) => `${orgId}|${appointmentId}`;

const MENSAJE_SIN_MARCAR = (nombre, telefono) =>
    '⚠️ <b>Reseña pedida y sin apuntar</b>\n\n'
    + `Le he pedido la reseña a ${nombre || 'una clienta'} (${telefono || 'sin teléfono'}) y el `
    + 'mensaje salió, pero no he podido dejar constancia en su cita.\n\n'
    + 'No se la voy a volver a pedir. Si el problema sigue, márcala a mano en el panel.';

/**
 * Marca `resena_enviada` de una cita cuyo mensaje YA salió. Nunca lanza.
 *
 * @returns {Promise<boolean>} true si quedó apuntado.
 */
async function marcarResenaEnviada(orgId, { id, telefono, nombre }, actor) {
    const clave = claveMarcado(orgId, id);
    let ultimoError = null;

    for (let intento = 0; intento < REINTENTOS_MARCADO; intento++) {
        if (intento > 0) await new Promise(r => setTimeout(r, 200 * intento));
        try {
            await updateAppointment(orgId, id, { resenaEnviada: true, actor });
            enviadasSinMarcar.delete(clave);
            logger.info('resena_enviada', { orgId, appointmentId: id, telefono, actor });
            return true;
        } catch (e) {
            ultimoError = e;
        }
    }

    // Se entregó y no se pudo apuntar. Queda anotado en memoria para que el worker NO lo
    // reenvíe: el tic siguiente reintentará este mismo marcado.
    if (!enviadasSinMarcar.has(clave)) enviadasSinMarcar.set(clave, { desde: Date.now() });
    logger.error('resena_enviada_sin_registrar', {
        orgId, appointmentId: id, telefono, actor: actor || null,
        error: ultimoError?.message || null,
    });
    await alertOnce(orgId, `resena_sin_marcar|${id}`, MENSAJE_SIN_MARCAR(nombre, telefono));
    return false;
}

/** Solo para tests: olvida lo entregado-sin-apuntar. */
function _resetPendientesDeMarcar() { enviadasSinMarcar.clear(); }

/**
 * Pide la reseña de UNA cita concreta y solo entonces la marca. La usa el botón del panel.
 *
 * Hasta el 06/08/2026 `POST /api/reviews/:id/send` NO enviaba nada: ponía
 * `resena_enviada = true` y devolvía {ok:true}, y el panel cantaba "Reseña enviada". Como
 * `getCompletedAppointmentsForReview` filtra por `resena_enviada = false`, el clic sacaba la
 * cita TAMBIÉN de la cola del worker — o sea que era la forma más eficaz de garantizar que
 * esa reseña no se pidiera nunca. Cinco reseñas reales se perdieron así.
 *
 * La cita se busca dentro de `getCompletedAppointmentsForReview`, no por id suelto, para que
 * el botón solo pueda mandar lo que el worker también consideraría válido: completada, no
 * enviada, pasada la ventana y con la clienta fuera de la lista negra. Un id que no esté ahí
 * es un 'no_pendiente', no un envío.
 *
 * @returns {{ok: boolean, motivo?: string, registrado?: boolean}}
 */
async function sendReviewForAppointment(orgId, appointmentId, { client = null, actor = null } = {}) {
    const agentCfg = await getAgentConfig(orgId);
    const info = agentCfg?.business_info || {};
    const googleLink = info.googleReviewLink;
    if (!googleLink) return { ok: false, motivo: 'sin_enlace' };

    const horasResenaDb = await getConfigValue(orgId, 'horas_resena');
    const pendientes = await getCompletedAppointmentsForReview(orgId, Number(horasResenaDb) || 0);
    const apt = (pendientes || []).find(a => a.id === appointmentId);
    if (!apt) return { ok: false, motivo: 'no_pendiente' };

    const telefono = apt.contacts?.wa_phone || apt.phone;
    if (!telefono) return { ok: false, motivo: 'sin_telefono' };

    const nombre = apt.contacts?.full_name || apt.full_name;
    const language = apt.contacts?.language || 'es';
    const waJid = apt.contacts?.metadata?.wa_jid || null;
    const companyName = info.companyName || 'nuestro centro';
    const mensaje = buildReviewMessage(nombre, companyName, googleLink, language);

    const resultado = await sendReviewMessage(orgId, { telefono, language, waJid }, {
        mensaje, templateParams: [nombre || '', googleLink],
    }, { client });
    if (resultado !== 'enviado') return { ok: false, motivo: resultado };

    // Marcar va DESPUÉS del envío y nunca antes. Y si el marcado falla, el envío ya se hizo:
    // devolver error haría que el operador volviera a pulsar y la clienta recibiera dos
    // peticiones de reseña. Se informa de que salió pero no se pudo apuntar.
    //
    // El fallo se anota además en `enviadasSinMarcar`, que es lo que impide que el worker
    // —que sigue viendo la cita pendiente porque la fila no se escribió— se la mande otra vez
    // dentro de cinco minutos.
    const registrado = await marcarResenaEnviada(orgId, { id: apt.id, telefono, nombre }, actor);
    return registrado ? { ok: true, registrado: true } : { ok: true, registrado: false };
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
                // El try va por CITA, no por org. Estaba fuera del bucle: cualquier fallo en
                // una cita se llevaba por delante a todas las siguientes de esa org en ese
                // tic, sin dejar rastro de cuáles.
                try {
                    const phone = apt.contacts?.wa_phone || apt.phone;
                    const nombre = apt.contacts?.full_name || apt.full_name;
                    const language = apt.contacts?.language || 'es';
                    const waJid = apt.contacts?.metadata?.wa_jid || null;
                    if (!phone) continue;

                    // Ya se le pidió y solo faltó apuntarlo: se reintenta el MARCADO, jamás
                    // el envío. Sin esto la cita sigue "pendiente" en BD y se le vuelve a
                    // pedir la reseña cada cinco minutos.
                    if (enviadasSinMarcar.has(claveMarcado(orgId, apt.id))) {
                        await marcarResenaEnviada(orgId, { id: apt.id, telefono: phone, nombre }, 'worker:review');
                        continue;
                    }

                    const mensaje = buildReviewMessage(nombre, companyName, googleLink, language);
                    const resultado = await sendReviewMessage(orgId, { telefono: phone, language, waJid }, {
                        mensaje,
                        templateParams: [nombre || '', googleLink],
                    });

                    if (resultado === 'enviado') {
                        await marcarResenaEnviada(orgId, { id: apt.id, telefono: phone, nombre }, 'worker:review');
                    }
                } catch (e) {
                    logger.error('review_error_cita', { orgId, appointmentId: apt.id, error: e.message });
                }
            }

            // Poda: lo que ya no está pendiente en BD está apuntado (a mano o por un
            // reintento), así que su entrada sobra. Sin esto el Map crece con citas muertas
            // en un proceso de vida larga.
            const idsPendientes = new Set(pendientes.map(a => a.id));
            for (const clave of enviadasSinMarcar.keys()) {
                const [org, aptId] = clave.split('|');
                if (org === orgId && !idsPendientes.has(aptId)) enviadasSinMarcar.delete(clave);
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

module.exports = {
    startReviewWorker, buildReviewMessage, checkAndSendReviews, setClients,
    sendReviewForAppointment,
    _resetPendientesDeMarcar,
};
