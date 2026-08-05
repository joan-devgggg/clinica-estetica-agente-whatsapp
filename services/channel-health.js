/**
 * channel-health.js — "No sale NADA por WhatsApp y nadie se ha enterado".
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 * Cada envío falla en su propio `catch` y ahí muere: el worker de recordatorios reintenta
 * dentro de 5 minutos, la campaña marca esa fila como 'failed', el panel devuelve un 503 a
 * quien estuviera mirando. Nadie suma. El 1 y el 2 de agosto de 2026, 360dialog bloqueó los
 * envíos de Sante: entraban mensajes, no salía ni uno, y no se supo hasta horas después.
 * Cada pieza hizo lo suyo correctamente y el conjunto se quedó mudo.
 *
 * Aquí se cuenta: N fallos seguidos ATRIBUIBLES A LA PLATAFORMA en la misma org → un aviso.
 * Y cuando vuelve a salir algo, un aviso de recuperación — sin él, quien recibió la alarma
 * se queda sin saber si sigue rota, que es la mitad del valor.
 *
 * ── Qué cuenta y qué no ──────────────────────────────────────────────────────
 * Solo errores de PLATAFORMA (la clave revocada, Meta caída, el frame de puppeteer muerto).
 * Los errores por DESTINATARIO no cuentan y es deliberado: una campaña normal acumula
 * decenas de "fuera de la ventana de 24 h" seguidos, y con ellos en la cuenta el aviso
 * saltaría en cada envío masivo hasta que nadie volviera a leerlo.
 *
 * Este módulo NO decide cuándo enviar ni reintenta nada: solo observa resultados que otros
 * ya tienen en la mano y decide si hay que despertar a una persona.
 */

const { alertOnce, clearAlert } = require('./admin-alerts');
const logger = require('../lib/logger');

/** Fallos consecutivos de plataforma antes de avisar. */
const FALLOS_PARA_AVISAR = 3;

// Errores de puppeteer que ya clasifica bot.js como transitorios (TRANSIENT_WA_ERRORS), más
// los de conexión. Se repiten aquí en vez de importarlos de bot.js a propósito: importar
// bot.js desde aquí crearía un ciclo (bot.js → channel-health → bot.js) y este módulo tiene
// que poder cargarse suelto en un test.
const PATRONES_PLATAFORMA = [
    'detached frame', 'execution context was destroyed', 'target closed', 'session closed',
    'most likely the page has been closed', 'not connected', 'protocol error',
    'econnrefused', 'econnreset', 'etimedout', 'socket hang up', 'network error',
];

// Códigos de Cloud API que hablan del DESTINATARIO o del contenido, no del canal.
// 131047: fuera de la ventana de 24 h. 132000/132001/132005: la plantilla (parámetros,
// idioma, no aprobada). 131026: ese número no puede recibir mensajes.
const CODIGOS_DESTINATARIO = ['131047', '131026', '132000', '132001', '132005'];

/** HTTP que devuelve `360dialog send <status>: <cuerpo>` (threesixty-dialog.js → post360). */
const HTTP_360 = /360dialog send (\d{3})/i;

/**
 * ¿De quién es la culpa de este fallo?
 *
 * @returns {{tipo: 'plataforma'|'destinatario', codigo: string} | null}
 *          null = no se puede atribuir; no cuenta ni para bien ni para mal.
 */
function classifyChannelError(err) {
    const msg = String(err?.message || err || '');
    if (!msg) return null;
    const bajo = msg.toLowerCase();

    // Cloud API: el código de Meta manda sobre el HTTP. Un 400 con 131047 es "esta clienta
    // está fuera de ventana", no "el canal está caído".
    const codigoMeta = CODIGOS_DESTINATARIO.find(c => msg.includes(c));
    if (codigoMeta) return { tipo: 'destinatario', codigo: codigoMeta };

    const http = msg.match(HTTP_360);
    if (http) {
        const status = Number(http[1]);
        // 401/403 = clave revocada o número bloqueado; 429 = límite; 5xx = Meta caída.
        // Son exactamente los del bloqueo del 1-2 de agosto.
        if (status === 401 || status === 403 || status === 429 || status >= 500) {
            return { tipo: 'plataforma', codigo: `http_${status}` };
        }
        // Otro 4xx sin código conocido: del destinatario o del payload, no del canal.
        return { tipo: 'destinatario', codigo: `http_${status}` };
    }

    if (msg.includes('360dialog no configurado')) {
        return { tipo: 'plataforma', codigo: 'sin_configuracion' };
    }

    const patron = PATRONES_PLATAFORMA.find(p => bajo.includes(p));
    if (patron) return { tipo: 'plataforma', codigo: patron.replace(/\s+/g, '_') };

    return null;
}

// orgId → { codigo, fallos, avisado }
const _estado = new Map();

function _get(orgId) {
    if (!_estado.has(orgId)) _estado.set(orgId, { codigo: null, fallos: 0, avisado: false });
    return _estado.get(orgId);
}

const claveAviso = codigo => `canal|${codigo}`;

const MENSAJE_CAIDO = (codigo, contexto) =>
    '🚨 <b>WhatsApp no está enviando</b>\n\n'
    + `Han fallado <b>${FALLOS_PARA_AVISAR} envíos seguidos</b> por el mismo motivo `
    + `(<code>${codigo}</code>).\n\n`
    + 'Mientras dure, no salen respuestas del bot, ni recordatorios, ni campañas — '
    + 'aunque las clientas sigan escribiendo.\n\n'
    + (contexto ? `Último intento: ${contexto}\n\n` : '')
    + 'Suele ser la conexión del número o la clave del proveedor. Te aviso en cuanto vuelva.';

const MENSAJE_RECUPERADO = codigo =>
    '✅ <b>WhatsApp vuelve a enviar</b>\n\n'
    + `El fallo (<code>${codigo}</code>) ha dejado de darse: el último envío ha salido bien.`;

/**
 * Registra el resultado de UN envío lógico (no de cada reintento interno).
 *
 * Nunca lanza: observar los envíos no puede romper los envíos.
 *
 * @param {string} orgId
 * @param {{ok: boolean, error?: Error|string, contexto?: string}} resultado
 */
async function noteSendResult(orgId, { ok, error = null, contexto = null } = {}) {
    if (!orgId) return;
    try {
        const estado = _get(orgId);

        if (ok) {
            if (estado.avisado) {
                const codigo = estado.codigo;
                estado.avisado = false;
                // Se libera la clave ANTES de avisar: si no, un corte posterior del mismo
                // tipo quedaría callado para siempre por el throttle.
                clearAlert(orgId, claveAviso(codigo));
                logger.info('canal_recuperado', { orgId, codigo });
                await alertOnce(orgId, `canal_ok|${codigo}|${Date.now()}`, MENSAJE_RECUPERADO(codigo));
            }
            estado.codigo = null;
            estado.fallos = 0;
            return;
        }

        const clasificado = classifyChannelError(error);
        if (!clasificado || clasificado.tipo !== 'plataforma') {
            // Un fallo del destinatario no rompe la racha ni la alimenta: no dice nada
            // sobre el canal.
            return;
        }

        // Un motivo distinto empieza racha nueva: tres fallos por tres causas distintas no
        // son un canal caído.
        if (estado.codigo !== clasificado.codigo) {
            estado.codigo = clasificado.codigo;
            estado.fallos = 0;
            estado.avisado = false;
        }
        estado.fallos++;

        logger.warn('envio_fallido_plataforma', {
            orgId, codigo: clasificado.codigo, consecutivos: estado.fallos,
        });

        if (estado.fallos < FALLOS_PARA_AVISAR || estado.avisado) return;

        estado.avisado = true;
        const entregado = await alertOnce(orgId, claveAviso(clasificado.codigo),
            MENSAJE_CAIDO(clasificado.codigo, contexto));
        // Si el aviso no salió, no lo damos por dado: alertOnce ya liberó su clave y el
        // siguiente fallo vuelve a intentarlo.
        if (!entregado) estado.avisado = false;
    } catch (e) {
        logger.error('channel_health_error', { orgId, error: e.message });
    }
}

/** Solo para tests. */
function _reset() { _estado.clear(); }

module.exports = {
    noteSendResult,
    classifyChannelError,
    FALLOS_PARA_AVISAR,
    _reset,
};
