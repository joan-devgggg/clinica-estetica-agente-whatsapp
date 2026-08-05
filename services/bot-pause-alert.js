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
const { alertOnce, clearAlert } = require('./admin-alerts');
const { minutosDeAperturaEntre, pausaVieneDeAntesDeAbrir } = require('./horario-apertura');

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

// ─── Vigilancia: pausado demasiado tiempo, escriba alguien o no ──────────────
//
// `notePausedDrop` es REACTIVO: solo salta cuando llega un mensaje y se tira. Eso deja un
// agujero entero — la pausa de noche o en domingo no se manifiesta hasta que la primera
// clienta se lleva el golpe, que es justo lo que había que evitar. Esto lo cierra: mira el
// estado, no el tráfico.
//
// El umbral son 2 h DE APERTURA, no de reloj. Con datos de Sante (31/07–04/08, 122
// entrantes): en horario, el hueco entre mensajes es p95 = 1,5 h, así que con el salón
// abierto el aviso reactivo ya ha saltado en >95% de los casos antes de las 2 h — este no
// duplica, cubre lo que aquel no ve. Y con el reloj parado fuera del horario, nadie recibe
// un Telegram de madrugada por una pausa que no está costando nada. El incidente real del
// 01/08 (3 h 56 min) se habría cortado por la mitad.

const MINUTOS_PARA_AVISAR = 120;
const WATCHDOG_INTERVAL_MS = 10 * 60 * 1000;

/**
 * ¿Toca avisar de que esta org lleva demasiado pausada? Función PURA.
 *
 * @param {object} p
 * @param {Date|string|null} p.pausadoDesde  config.updated_at de `bot_activo`.
 * @param {Date}   p.ahora
 * @param {object} p.horario                 config.horario (puede faltar).
 * @returns {{avisar: boolean, motivo: string, minutosAbierto: number}}
 */
function decidirAvisoPausa({ pausadoDesde, ahora, horario }) {
    if (!pausadoDesde) return { avisar: false, motivo: 'sin_fecha_de_pausa', minutosAbierto: 0 };
    const desde = pausadoDesde instanceof Date ? pausadoDesde : new Date(pausadoDesde);
    if (Number.isNaN(desde.getTime())) {
        return { avisar: false, motivo: 'fecha_de_pausa_ilegible', minutosAbierto: 0 };
    }

    const { minutos } = minutosDeAperturaEntre(desde, ahora, horario);

    // El salón acaba de abrir con el bot ya pausado: no se espera a acumular nada, porque el
    // daño empieza con la primera clienta del día.
    if (pausaVieneDeAntesDeAbrir(desde, ahora, horario)) {
        return { avisar: true, motivo: 'abierto_con_pausa_anterior', minutosAbierto: minutos };
    }

    if (minutos >= MINUTOS_PARA_AVISAR) {
        return { avisar: true, motivo: 'acumulado', minutosAbierto: minutos };
    }
    return { avisar: false, motivo: 'aun_no', minutosAbierto: minutos };
}

const claveAviso = pausadoDesde => `bot_pausado|${new Date(pausadoDesde).toISOString()}`;

function mensajePausaLarga(minutosAbierto, motivo) {
    const horas = Math.floor(minutosAbierto / 60);
    const mins = minutosAbierto % 60;
    const cuanto = motivo === 'abierto_con_pausa_anterior' && minutosAbierto < 60
        ? 'desde antes de abrir'
        : `${horas} h ${String(mins).padStart(2, '0')} min de horario de atención`;
    return '⏸️ <b>El bot lleva pausado ' + cuanto + '</b>\n\n'
        + 'Está pausado para TODA la organización: los mensajes que lleguen no se responden, '
        + 'ni ahora ni al reactivarlo.\n\n'
        + 'Si es a propósito, ignora este aviso. Si no: Panel → Configuración → reactivar.';
}

const MENSAJE_REACTIVADO =
    '▶️ <b>El bot vuelve a responder</b>\n\n'
    + 'Ya está activo para toda la organización.';

// orgId → instante de la pausa por la que se avisó (para saber si hay que dar el "vuelve").
const _avisadoPor = new Map();

/**
 * Una pasada del vigilante para una org. Se le inyectan los datos ya leídos para que sea
 * probable sin BD.
 *
 * @param {string} orgId
 * @param {{activo: boolean, pausadoDesde: string|Date|null, horario: object}} estado
 * @param {Date} ahora
 */
async function revisarPausaProlongada(orgId, { activo, pausadoDesde, horario }, ahora = new Date()) {
    // Reactivado: si habíamos avisado, se cierra el aviso y se libera su clave.
    if (activo !== false) {
        const previa = _avisadoPor.get(orgId);
        if (previa) {
            _avisadoPor.delete(orgId);
            clearAlert(orgId, claveAviso(previa));
            logger.info('bot_pausa_resuelta', { orgId });
            await alertOnce(orgId, `bot_activo|${Date.now()}`, MENSAJE_REACTIVADO);
        }
        return false;
    }

    const decision = decidirAvisoPausa({ pausadoDesde, ahora, horario });
    if (!decision.avisar) return false;

    // `alertOnce` con la clave del episodio: un aviso por pausa, no uno cada 10 minutos.
    const entregado = await alertOnce(orgId, claveAviso(pausadoDesde),
        mensajePausaLarga(decision.minutosAbierto, decision.motivo));
    if (entregado) {
        _avisadoPor.set(orgId, pausadoDesde);
        logger.warn('bot_pausado_demasiado', {
            orgId, motivo: decision.motivo, minutosAbierto: decision.minutosAbierto,
        });
    }
    return entregado;
}

/**
 * Arranca el vigilante. Lee de la BD aquí y solo aquí: `revisarPausaProlongada` se queda
 * puro de I/O para poder probarlo.
 */
function startPauseWatchdog(orgIds) {
    const orgs = Array.isArray(orgIds) ? orgIds : [...(orgIds?.keys?.() || [])];
    const db = require('./db');

    async function tick() {
        for (const orgId of orgs) {
            try {
                const entrada = await db.getConfigEntry(orgId, 'bot_activo');
                const horario = await db.getConfigValue(orgId, 'horario');
                await revisarPausaProlongada(orgId, {
                    activo: entrada?.valor !== false,
                    pausadoDesde: entrada?.updated_at || null,
                    horario,
                }, new Date());
            } catch (e) {
                logger.error('pause_watchdog_error', { orgId, error: e.message });
            }
        }
    }

    logger.info('pause_watchdog_iniciado', { orgs: orgs.length, minutosParaAvisar: MINUTOS_PARA_AVISAR });
    setInterval(tick, WATCHDOG_INTERVAL_MS);
    setTimeout(tick, 60 * 1000);
}

/** Solo para tests. */
function _resetWatchdog() { _avisadoPor.clear(); }

module.exports = {
    notePausedDrop, resetPauseAlert, ALERT_THROTTLE_MS,
    decidirAvisoPausa, revisarPausaProlongada, startPauseWatchdog,
    MINUTOS_PARA_AVISAR, WATCHDOG_INTERVAL_MS, _resetWatchdog,
};
