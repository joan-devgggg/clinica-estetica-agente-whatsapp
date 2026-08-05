/**
 * admin-alerts.js — Avisos al admin de la organización, con throttle por asunto.
 *
 * Existe porque hay fallos que NO deben degradarse en silencio ni en un mensaje roto a la
 * clienta: si el bot no puede mandar un automatismo (recordatorio, reseña…), la única salida
 * honesta es que lo sepa una persona y lo haga a mano.
 *
 * El throttle es el punto: los workers tican cada 5 minutos y la ventana de un recordatorio
 * dura 24 h. Sin él, un solo caso bloqueado son ~288 mensajes de Telegram al admin, que es
 * la forma más rápida de que deje de leerlos.
 *
 * La clave de throttle la elige quien llama y debe identificar el ASUNTO, no el intento:
 * para un recordatorio, la cita. Así se avisa una vez por cita, no una por tic.
 *
 * Deliberadamente genérico: el aviso de fallo de canal (pendiente) reutiliza `alertOnce`
 * con otra clave, sin tocar nada de aquí.
 */
const { notifyOrgAdmin } = require('./telegram');
const logger = require('../lib/logger');

// clave → timestamp del último aviso.
//
// ⚠️ LIMITACIÓN CONOCIDA Y ACEPTADA (04/08/2026): el throttle vive en RAM, así que se pierde
// en cada redeploy de Railway y en cada reinicio de PM2. Consecuencia práctica: si un
// recordatorio sigue bloqueado después de un despliegue, Yulia recibe otra vez el mismo
// aviso. Un despliegue al día = como mucho un aviso repetido al día por cita bloqueada.
//
// Se asume a propósito, en vez de persistirlo en Supabase, porque el fallo por este lado es
// molesto (aviso duplicado) y por el otro es grave (aviso perdido → clienta sin recordatorio
// y nadie enterado). Si algún día molesta de verdad, la solución es una tabla `admin_alerts`
// con (organization_id, clave, enviado_at), no alargar la vida del Map.
const _avisados = new Map();

// Poda para que el Map no crezca sin límite en un proceso de vida larga.
const RETENCION_MS = 7 * 24 * 60 * 60 * 1000;

function _podar(ahora) {
    if (_avisados.size < 500) return;
    for (const [k, ts] of _avisados) {
        if (ahora - ts > RETENCION_MS) _avisados.delete(k);
    }
}

/**
 * Manda `mensaje` al admin de la org UNA vez por `clave`.
 *
 * La clave se marca SOLO si Telegram confirmó la entrega. Antes se marcaba antes de enviar
 * y `notifyOrgAdmin` no se esperaba: si no había bot arrancado, si la org no tenía admins o
 * si Telegram rechazaba el mensaje, esto registraba `admin_alert_enviado`, daba la clave por
 * avisada y **el aviso no se reintentaba jamás**. El caso que lo destapó (05/08/2026) fue un
 * recordatorio bloqueado por falta de nombre: el único log que prueba entrega es
 * `telegram_notify_ok`, y podía no existir.
 *
 * La clave se reserva ANTES del await y se libera si el envío falla. Sin la reserva, dos
 * tics solapados del mismo worker mandarían el aviso dos veces; sin la liberación,
 * volveríamos al bug.
 *
 * @returns {Promise<boolean>} true solo si el aviso llegó a Telegram.
 */
async function alertOnce(orgId, clave, mensaje) {
    const k = `${orgId}|${clave}`;
    const ahora = Date.now();
    if (_avisados.has(k)) return false;
    _podar(ahora);
    _avisados.set(k, ahora);

    let entregado = false;
    try {
        entregado = await notifyOrgAdmin(orgId, mensaje);
    } catch (e) {
        // Que no se pueda avisar no puede tumbar al worker que estaba avisando.
        logger.error('admin_alert_error', { orgId, clave, error: e.message });
    }

    if (!entregado) {
        _avisados.delete(k);
        logger.error('admin_alert_no_entregado', { orgId, clave });
        return false;
    }

    logger.info('admin_alert_enviado', { orgId, clave });
    return true;
}

/**
 * Olvida una clave concreta para que su próximo aviso vuelva a salir.
 *
 * Lo usa el aviso de canal caído: cuando el canal se recupera hay que liberar la clave, o el
 * siguiente corte del mismo tipo quedaría callado para siempre.
 */
function clearAlert(orgId, clave) {
    return _avisados.delete(`${orgId}|${clave}`);
}

/** Solo para tests: olvida el throttle. */
function _resetThrottle() { _avisados.clear(); }

module.exports = { alertOnce, clearAlert, _resetThrottle };
