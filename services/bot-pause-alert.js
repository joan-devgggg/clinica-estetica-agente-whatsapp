/**
 * bot-pause-alert.js — Aviso de "el bot está pausado y estamos tirando mensajes".
 *
 * El 01/08/2026 alguien pausó el bot de Sante a nivel de ORGANIZACIÓN desde el panel
 * creyendo que pausaba una sola conversación. Durante 3 h 56 min todos los mensajes
 * entrantes de todas las clientas se descartaron y NADIE se enteró: los dos puntos de
 * descarte (`process_core_bot_inactivo` en bot.js y `360d_msg_ignorado_bot_pausado` en el
 * adapter de 360dialog) eran `logger.info` silenciosos. Una clienta se quedó esperando
 * cuatro horas.
 *
 * Aquí NO se decide si el bot está pausado (eso es isBotActivo). Aquí solo se avisa de que
 * un mensaje real se acaba de tirar por esa causa, con throttle para no inundar Telegram:
 * un aviso por org cada ALERT_THROTTLE_MS, y el siguiente resume cuántos se tiraron entre
 * medias.
 */

const logger = require('../lib/logger');

const ALERT_THROTTLE_MS = 15 * 60 * 1000;

const _lastAlertAt = new Map();  // orgId → timestamp del último aviso enviado
const _droppedSince = new Map(); // orgId → mensajes descartados desde ese aviso

/**
 * Registra que se ha descartado un mensaje entrante porque el bot de la org está pausado,
 * y avisa a los admins de Telegram si toca. Nunca lanza: un fallo avisando no puede
 * romper el webhook.
 *
 * @param {string} orgId
 * @param {string|null} telefono  Teléfono de quien escribió (para el aviso).
 * @param {string} origen         Punto de descarte, para el log.
 */
function notePausedDrop(orgId, telefono, origen) {
    if (!orgId) return;

    const pendientes = (_droppedSince.get(orgId) || 0) + 1;
    _droppedSince.set(orgId, pendientes);

    logger.warn('mensaje_descartado_bot_pausado', {
        orgId,
        telefono: telefono || null,
        origen,
        descartadosDesdeUltimoAviso: pendientes,
    });

    const ahora = Date.now();
    const ultimo = _lastAlertAt.get(orgId) || 0;
    if (ahora - ultimo < ALERT_THROTTLE_MS) return;

    _lastAlertAt.set(orgId, ahora);
    _droppedSince.set(orgId, 0);

    const extra = pendientes > 1
        ? `\n\nSe han descartado <b>${pendientes}</b> mensajes desde el último aviso.`
        : '';
    const mensaje =
        '⚠️ <b>El bot está PAUSADO para toda la organización</b>\n\n' +
        `Acaba de escribir ${telefono ? `<b>${telefono}</b>` : 'una clienta'} y su mensaje ` +
        'se ha descartado: no se le va a responder, ni ahora ni al reactivar el bot.' +
        extra +
        '\n\nSi solo querías pausar una conversación, usa el botón dentro de ese chat. ' +
        'Para reactivar el bot de todas: Panel → Configuración.';

    try {
        const { notifyOrgAdmin } = require('./telegram');
        notifyOrgAdmin(orgId, mensaje);
    } catch (e) {
        logger.error('bot_pausado_aviso_error', { orgId, error: e.message });
    }
}

/**
 * Reinicia el throttle de una org. Se llama al REACTIVAR el bot para que la próxima pausa
 * avise de inmediato en vez de quedarse callada hasta que expire la ventana anterior.
 */
function resetPauseAlert(orgId) {
    _lastAlertAt.delete(orgId);
    _droppedSince.delete(orgId);
}

module.exports = { notePausedDrop, resetPauseAlert, ALERT_THROTTLE_MS };
