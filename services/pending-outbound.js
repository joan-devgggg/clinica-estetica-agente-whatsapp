/**
 * services/pending-outbound.js — Salientes automáticos que la conversación tiene que ver.
 *
 * El recordatorio de 24 h lo envía un worker, no la conversación: no pasaba por
 * `session.history`, y el prompt del LLM se construye SOLO de `session.history` (no lee
 * la tabla `messages` en ningún punto). Resultado (Barbora Jalova, 13/08/2026): contestó
 * «Hola, si confirmado 😊» a nuestro propio recordatorio y el bot, ciego, le respondió
 * «¿Qué día o semana te viene mejor?» — y de propina el turno le regresó la ficha a
 * 'pendiente' (bloque 1c del nocturno 14/08).
 *
 * Mismo patrón que `pendingMediaHistory` (bot.js): el worker ANOTA aquí el saliente y
 * `processMessageCore` lo DRENA al historial en el siguiente turno de la clienta, ANTES
 * de su mensaje — que es el orden real en que ocurrió. Vive en módulo propio, y no en
 * bot.js, para que reminder.js no tenga que requerir el bot entero: los tests herméticos
 * del worker stubean db/outbound y no pueden permitirse que un require arrastre bot.js
 * (timers, telegram, memoria de sesiones).
 *
 * La clave normaliza el teléfono a dígitos: el worker conoce '34603426950' y el bot
 * '34603426950@c.us', y son la misma conversación.
 */

// Tope defensivo: si nadie drena (la clienta no vuelve a escribir), la memoria no crece
// sin límite por conversación. Con recordatorios de verdad rara vez habrá más de uno.
const MAX_TURNOS_POR_CONVERSACION = 4;

const pendientes = new Map();

function turnKey(orgId, telefono) {
    const digits = String(telefono || '').replace(/\D/g, '');
    return digits ? `${orgId}:${digits}` : null;
}

/**
 * Anota un saliente automático ya ENVIADO. `ttlMs` dice cuánto tiempo sigue explicando la
 * conversación: un recordatorio de cita lo hace hasta la cita misma (el llamador pasa su
 * ttl); sin ttl propio caduca con el timeout de sesión que se pase al drenar.
 */
function notePendingOutboundTurn(orgId, telefono, contenido, { ttlMs = null } = {}) {
    const key = turnKey(orgId, telefono);
    if (!key || !contenido) return false;
    const turnos = pendientes.get(key) || [];
    turnos.push({ role: 'assistant', content: contenido, ts: Date.now(), ttlMs });
    pendientes.set(key, turnos.slice(-MAX_TURNOS_POR_CONVERSACION));
    return true;
}

/**
 * Devuelve los turnos aún vigentes y vacía la entrada. No toca la sesión: el que drena
 * decide dónde ponerlos (bot.js los mete en session.history antes del turno de la clienta).
 */
function drainPendingOutboundTurns(orgId, telefono, defaultTtlMs) {
    const key = turnKey(orgId, telefono);
    if (!key) return [];
    const turnos = pendientes.get(key);
    if (!turnos?.length) return [];
    pendientes.delete(key);
    const ahora = Date.now();
    return turnos.filter(t => ahora - t.ts < (t.ttlMs || defaultTtlMs || 0));
}

/** Solo para tests. */
function _resetPendingOutbound() { pendientes.clear(); }

module.exports = { notePendingOutboundTurn, drainPendingOutboundTurns, turnKey, _resetPendingOutbound };
