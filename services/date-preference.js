/**
 * date-preference.js — Fuente ÚNICA de verdad para la preferencia de fecha/hora del salón.
 *
 * Reemplaza el manejo disperso anterior (session.weekPreference + resolveStickyWeek en bot.js
 * + merges tangled en helpers.js). Un solo store —`session.partialData.preferencia_horaria`—
 * y un solo reducer puro e idempotente que aplica la "señal" detectada en el turno actual.
 *
 * INVARIANTES del store tras cada aplicación:
 *   - `asap:true`  ⇒ sin `semana` (buscar desde ya, sin acotar la semana). Puede convivir con
 *      una `fecha`/`diaSemana` que la clienta pidió explícitamente — ver ASAP FUERTE vs DÉBIL.
 *   - `fecha` (YYYY-MM-DD) ⇒ sin diaSemana; `semana` PUEDE quedar como CONTEXTO (para
 *      resolver un cambio de día posterior, "mejor el miércoles"), pero el motor honra la
 *      fecha (blindaje calendar-sante.js: el filtro de semana se ignora si hay fecha).
 *   - `diaSemana` sin `fecha` ⇒ día "pelado": el motor elige la ocurrencia más cercana
 *     (+ filtro de semana si `semana` sigue presente y no se pudo resolver).
 *   - `semana` sin fecha/diaSemana ⇒ a la espera de un día.
 *   - `periodo` ('mañana'|'tarde') es ORTOGONAL: nunca toca el ancla de fecha.
 *
 * Clave contra la deriva 21→28: en cuanto hay CONTEXTO de semana + un día, el combo se
 * colapsa a una `fecha` absoluta UNA vez. Repetir el turno (typo) recalcula la MISMA fecha
 * (idempotente) — ya no queda un `semana` suelto que un turno posterior vuelva a aplicar.
 *
 * ASAP FUERTE vs DÉBIL (bug de producción del 28/07): "el más cercano" / "cualquiera" NO
 * significan lo mismo que "lo antes posible". Las primeras son la respuesta a una PREGUNTA DE
 * ELECCIÓN y, por sí solas, no dicen cuándo; las segundas son una corrección temporal
 * explícita. Por eso:
 *   - `signal.asap`     (FUERTE, "lo antes posible") → borra fecha/diaSemana/semana.
 *   - `signal.asapWeak` (DÉBIL,  "el más cercano")   → marca asap y borra SOLO `semana`;
 *      una fecha/día que la clienta ya pidió SOBREVIVE. Sin esto, la secuencia real
 *      "el sabado" → "el mas cercano" perdía el sábado que Eva acababa de pedir.
 */

const { resolveWeekdayToDate, mondayDow } = require('./date-utils');

// Aplica la señal de fecha del turno al estado actual y devuelve el NUEVO store (no muta).
//   current : preferencia_horaria previa (objeto plano) — puede venir vacío/undefined.
//   signal  : lo que ESTE mensaje expresa sobre la fecha. Campos:
//             { asap?, asapWeak?, fecha?, diaSemana?, semana?, semanaWeak?, periodo? }
//             - `semana`     : semana EXPLÍCITA ("esta semana", "la semana que viene").
//             - `semanaWeak` : semana DÉBIL derivada de "mañana" a secas (día siguiente);
//                              solo cuenta si no hay ningún día concreto en juego.
//             - `asap`/`asapWeak` : ver ASAP FUERTE vs DÉBIL arriba.
//   now     : instante de referencia (Date). Inyectable para tests deterministas.
function applyDatePreference(current, signal, now = new Date()) {
    const next = { ...(current || {}) };
    signal = signal || {};

    // Periodo es ortogonal al ancla de fecha: se fusiona siempre, sin afectar al resto.
    if (signal.periodo) next.periodo = signal.periodo;

    // La semana débil ("mañana") solo asciende a señal de semana si NO hay ningún día
    // concreto ni en la señal ni en el estado (comportamiento previo: "mañana lunes" o un
    // diaSemana ya fijado bloquean el "esta semana" implícito de "mañana").
    let semanaSignal = signal.semana;
    if (!semanaSignal && signal.semanaWeak) {
        const dayAnywhere = Number.isInteger(signal.diaSemana) || !!signal.fecha ||
            Number.isInteger(next.diaSemana) || !!next.fecha;
        if (!dayAnywhere) semanaSignal = signal.semanaWeak;
    }

    const hasDateSignal = !!signal.asap || !!signal.asapWeak || !!signal.fecha ||
        Number.isInteger(signal.diaSemana) || !!semanaSignal;
    // Sin señal de fecha este turno → el ancla previa se mantiene intacta.
    if (!hasDateSignal) return next;

    // 1. asap FUERTE ("lo antes posible") gana sobre todo: es una corrección temporal
    //    explícita, así que limpia cualquier restricción de fecha.
    if (signal.asap) {
        delete next.fecha; delete next.diaSemana; delete next.semana;
        next.asap = true;
        return next;
    }

    // 2. asap DÉBIL ("el más cercano", "cualquiera") SIN ningún día en el mismo mensaje:
    //    arranca la búsqueda desde ya y suelta el filtro de semana (que sí sobra), pero
    //    CONSERVA la fecha/día que la clienta pidió antes. Si el mensaje trae además un día,
    //    ese día manda y la señal débil se ignora (cae al tratamiento normal de abajo).
    if (signal.asapWeak && !signal.fecha && !Number.isInteger(signal.diaSemana) && !semanaSignal) {
        next.asap = true;
        delete next.semana;
        return next;
    }

    // Cualquier señal de fecha concreta cancela un asap previo.
    delete next.asap;

    // 3. Fecha ABSOLUTA ("24 de julio"): determina la semana por sí sola → limpia día y
    //    contexto de semana heredado (un 'siguiente' viejo re-acotaría y excluiría la fecha).
    if (signal.fecha) {
        next.fecha = signal.fecha;
        delete next.diaSemana; delete next.semana;
        return next;
    }

    // 4. Señal de DÍA (con contexto de semana explícito o heredado).
    if (Number.isInteger(signal.diaSemana)) {
        const semanaCtx = semanaSignal || next.semana; // hereda el contexto de semana si lo hay
        if (semanaCtx) {
            const resolved = resolveWeekdayToDate(now, signal.diaSemana, semanaCtx);
            if (resolved) {
                next.fecha = resolved;
                delete next.diaSemana;
                next.semana = semanaCtx; // se conserva como CONTEXTO para cambios de día futuros
                return next;
            }
            // No resoluble (p.ej. 'esta' con el día ya pasado): se conserva el combo y decide el motor.
            next.diaSemana = signal.diaSemana;
            next.semana = semanaCtx;
            delete next.fecha;
            return next;
        }
        // Día pelado, sin contexto de semana: el motor elige la ocurrencia más cercana.
        next.diaSemana = signal.diaSemana;
        delete next.fecha; delete next.semana;
        return next;
    }

    // 5. Señal de SEMANA sola (sin día en la señal). Si el estado ya tiene un día (pelado o
    //    ya resuelto a fecha), recalcula ese mismo día para la nueva semana.
    const dow = Number.isInteger(next.diaSemana) ? next.diaSemana
        : (next.fecha ? mondayDow(next.fecha) : null);
    if (dow !== null) {
        const resolved = resolveWeekdayToDate(now, dow, semanaSignal);
        if (resolved) {
            next.fecha = resolved;
            delete next.diaSemana;
            next.semana = semanaSignal;
            return next;
        }
        next.diaSemana = dow;
        next.semana = semanaSignal;
        delete next.fecha;
        return next;
    }
    // Sin día todavía: solo recordamos la semana, a la espera de que llegue un día.
    next.semana = semanaSignal;
    delete next.fecha; delete next.diaSemana;
    return next;
}

module.exports = { applyDatePreference };
