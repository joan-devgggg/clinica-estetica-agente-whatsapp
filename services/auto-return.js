/**
 * Auto-Return Worker — Multi-org
 *
 * Devuelve al bot (`bot_mode = 'auto'`) las conversaciones que llevan N días de SILENCIO
 * TOTAL en manual. "Silencio total" = nadie ha escrito nada, ni la clienta ni nosotros:
 * se mide sobre `conversations.last_message_at`, que se refresca con cualquier mensaje en
 * cualquier dirección.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 * `bot_mode = 'manual'` se pone solo (basta con contestar desde el panel) y no se quita
 * solo. La conversación se queda muda para siempre: el bot no contesta porque cree que hay
 * una persona atendiendo, y la persona hace tiempo que pasó a otra cosa. La clienta escribe
 * y no le responde nadie. Cuantas más conversaciones se atienden a mano, más agujeros de
 * estos quedan detrás.
 *
 * ── Lo que NO devuelve, nunca ────────────────────────────────────────────────
 *   · Escalada sin resolver (`escalation_reason`): alguien prometió que atendería una
 *     persona. Que el bot se ponga a hablar encima rompe esa promesa sin avisar.
 *   · Acción pendiente en `pending_actions`: hay un bizum o una escalada esperando en la
 *     cola de Telegram; el caso sigue abierto aunque la conversación esté callada.
 *   · Lista negra: al bot se le apagó a propósito.
 * Las tres se comprueban dos veces —al decidir y otra vez en el UPDATE, como
 * compare-and-set— porque entre una cosa y la otra pasan minutos.
 *
 * ── Alcance ──────────────────────────────────────────────────────────────────
 * Corre para TODAS las orgs del Map de clientes, San Remo incluida. Para desactivarlo en
 * una org concreta basta con poner `dias_retorno_auto = 0` en su `config`.
 */

const {
    getContactosEnManual,
    getContactIdsConAccionPendiente,
    devolverContactoAAuto,
    getConfigValue,
} = require('./db');
const logger = require('../lib/logger');

const CHECK_INTERVAL_MS = 60 * 60 * 1000;   // cada hora: el umbral son días, no minutos
const PRIMER_BARRIDO_MS = 2 * 60 * 1000;    // deja arrancar a los clientes de WhatsApp
const DIAS_SILENCIO_POR_DEFECTO = 7;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

let waClients = null; // Map<orgId, { client, orgId, ... }>

/** Días transcurridos entre `desdeIso` y `ahora`, o null si la fecha no es legible. */
function diasDesde(desdeIso, ahora) {
    if (!desdeIso) return null;
    const t = new Date(desdeIso).getTime();
    if (Number.isNaN(t)) return null;
    return (ahora.getTime() - t) / MS_POR_DIA;
}

/**
 * Decide si UNA conversación vuelve al bot. Función pura: toda la política vive aquí y se
 * prueba sin base de datos (tests/retorno-auto-silencio.test.js).
 *
 * @returns {{retorna: boolean, motivo: string, dias: number|null}}
 */
function decidirRetorno(contacto, { ahora, diasSilencio, tieneAccionPendiente }) {
    const dias = diasDesde(contacto.ultima_actividad_at, ahora);

    if (contacto.bot_mode !== 'manual') return { retorna: false, motivo: 'no_esta_en_manual', dias };
    if (contacto.is_blacklisted)        return { retorna: false, motivo: 'lista_negra', dias };
    if (contacto.escalation_reason)     return { retorna: false, motivo: 'escalada_sin_resolver', dias };
    if (tieneAccionPendiente)           return { retorna: false, motivo: 'accion_pendiente', dias };

    // Sin fecha de última actividad no se puede medir silencio, y "no sé" no es "sí".
    // Devolver al bot una conversación cuya historia no podemos leer es adivinar.
    if (dias === null) return { retorna: false, motivo: 'sin_actividad_registrada', dias: null };

    if (dias < diasSilencio) return { retorna: false, motivo: 'silencio_insuficiente', dias };

    return { retorna: true, motivo: 'silencio_cumplido', dias };
}

/** Cuántos días de silencio exige esta org. 0 o negativo = desactivado. */
async function resolverDiasSilencio(orgId) {
    const valor = await getConfigValue(orgId, 'dias_retorno_auto');
    if (valor === null || valor === undefined || valor === '') return DIAS_SILENCIO_POR_DEFECTO;
    const n = Number(valor);
    if (!Number.isFinite(n)) {
        logger.warn('retorno_auto_config_ilegible', { orgId, valor });
        return DIAS_SILENCIO_POR_DEFECTO;
    }
    return n;
}

async function checkAndReturnToAuto() {
    if (!waClients) return;

    for (const [orgId] of waClients) {
        try {
            const diasSilencio = await resolverDiasSilencio(orgId);
            if (diasSilencio <= 0) {
                logger.info('retorno_auto_desactivado', { orgId });
                continue;
            }

            const contactos = await getContactosEnManual(orgId);
            if (contactos.length === 0) continue;

            const conAccionPendiente = await getContactIdsConAccionPendiente(orgId);
            const ahora = new Date();

            for (const contacto of contactos) {
                const decision = decidirRetorno(contacto, {
                    ahora,
                    diasSilencio,
                    tieneAccionPendiente: conAccionPendiente.has(contacto.id),
                });
                if (!decision.retorna) continue;

                const diasEnteros = Math.floor(decision.dias);
                const cambiada = await devolverContactoAAuto(orgId, contacto.id, {
                    at: ahora.toISOString(),
                    dias_silencio: diasEnteros,
                    ultima_actividad_at: contacto.ultima_actividad_at,
                });

                if (cambiada) {
                    logger.info('retorno_auto_aplicado', {
                        orgId, contactId: contacto.id, telefono: contacto.telefono,
                        dias_silencio: diasEnteros,
                    });
                } else {
                    // Carrera perdida: la fila dejó de cumplir las condiciones entre la
                    // lectura y el UPDATE (alguien tomó el control, o el bot escaló).
                    logger.info('retorno_auto_descartado_en_carrera', {
                        orgId, contactId: contacto.id,
                    });
                }
            }
        } catch (e) {
            logger.error('retorno_auto_error_org', { orgId, error: e.message });
        }
    }
}

// Inyecta el Map de clientes. Separado de startAutoReturnWorker para que el test pueda
// ejercitar el motor real sin arrancar los timers — mismo patrón que reminder.js.
function setClients(clients) {
    waClients = clients;
}

function startAutoReturnWorker(clients) {
    setClients(clients);
    logger.info('auto_return_worker_iniciado', { dias_por_defecto: DIAS_SILENCIO_POR_DEFECTO });
    setInterval(checkAndReturnToAuto, CHECK_INTERVAL_MS);
    setTimeout(checkAndReturnToAuto, PRIMER_BARRIDO_MS);
}

module.exports = {
    startAutoReturnWorker,
    checkAndReturnToAuto,
    setClients,
    decidirRetorno,
    diasDesde,
    resolverDiasSilencio,
    DIAS_SILENCIO_POR_DEFECTO,
};
