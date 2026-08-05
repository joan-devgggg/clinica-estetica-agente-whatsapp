/**
 * llm-health.js — "El modelo no contesta y las clientas están recibiendo el fallback".
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 * El 05/08/2026 se acabó el saldo de OpenRouter. Cada llamada devolvía 402, `getChatbotResponse`
 * agotaba sus reintentos, se rendía y devolvía el fallback —"Perdona, no he podido procesar
 * tu mensaje. ¿Me lo repites? 😊"— a la clienta. El bot siguió contestando educadamente a todo
 * el mundo sin entender nada, y nadie se enteró hasta que se miró un log a mano.
 *
 * Es el mismo agujero que tapó channel-health.js, un piso más abajo: allí no SALÍA nada, aquí
 * sale algo que no significa nada. Y se parece más de lo que apetece: cada fallo moría en su
 * propio `catch`, con su log, y nadie sumaba.
 *
 * ── Qué cuenta y qué no ──────────────────────────────────────────────────────
 * Solo el PROVEEDOR: la llamada HTTP a OpenRouter falla. Si el modelo responde y lo que
 * devuelve no es JSON parseable (`no_json_in_response`, `json_parse_failed`), eso NO cuenta —
 * el proveedor está en pie y el problema es otro. Meterlo aquí convertiría este aviso en un
 * medidor de la calidad del modelo, que es otra cosa y con otro umbral.
 *
 * ── Cuenta de pago vs avería ────────────────────────────────────────────────
 * Se distinguen porque lo que tiene que hacer la persona que recibe el aviso es distinto:
 *   · `cuenta` (402, 401, 403) — no se arregla solo. Hay que pagar o renovar la clave.
 *   · `transitorio` (429, 5xx, red) — suele volver solo; el aviso es para no buscar el fallo
 *     donde no está mientras dura.
 *
 * Este módulo NO reintenta ni decide nada del flujo: solo mira resultados que openai.js ya
 * tiene en la mano y decide si hay que despertar a una persona.
 */

const { alertOnce, clearAlert } = require('./admin-alerts');
const logger = require('../lib/logger');

// Fallos consecutivos con el MISMO código antes de avisar. El umbral depende del tipo, y no
// por afinar: un 402 o un 401 son CIERTOS desde el primer fallo —no existe el "sin saldo
// pasajero"—, así que esperar a tres solo garantiza que tres clientas reciban el fallback
// antes de que nadie se entere. Un 429 o un 5xx sí pueden ser un tropiezo aislado, y ahí el
// umbral es lo que evita despertar a alguien por nada.
const FALLOS_PARA_AVISAR = { cuenta: 1, transitorio: 3 };

/** Compat: lo que importaba de la constante vieja era el umbral del caso ruidoso. */
const UMBRAL_TRANSITORIO = FALLOS_PARA_AVISAR.transitorio;

/** Errores de red: el proveedor ni siquiera contestó. */
const PATRONES_RED = [
    'econnrefused', 'econnreset', 'etimedout', 'enotfound', 'socket hang up',
    'network error', 'fetch failed', 'timeout', 'aborted',
];

/**
 * ¿Es este fallo del proveedor, y de qué tipo?
 *
 * @returns {{tipo: 'cuenta'|'transitorio', codigo: string} | null}
 *          null = no atribuible al proveedor; no cuenta ni para bien ni para mal.
 */
function classifyLlmError(err) {
    if (!err) return null;
    const msg = String(err?.message || err || '');
    const bajo = msg.toLowerCase();
    const status = Number(err?.status || err?.statusCode) || null;

    // El status del SDK manda. Si no viene (algunos errores lo traen solo en el texto), se
    // rescata del mensaje: "402 Insufficient credits…" es literalmente lo que devolvió
    // OpenRouter el 05/08.
    const httpDelTexto = msg.match(/\b(40[0-9]|41[0-9]|42[0-9]|5\d{2})\b/);
    const code = status || (httpDelTexto ? Number(httpDelTexto[1]) : null);

    if (code === 402) return { tipo: 'cuenta', codigo: 'http_402' };
    if (code === 401) return { tipo: 'cuenta', codigo: 'http_401' };
    if (code === 403) return { tipo: 'cuenta', codigo: 'http_403' };
    if (code === 429) return { tipo: 'transitorio', codigo: 'http_429' };
    if (code && code >= 500) return { tipo: 'transitorio', codigo: `http_${code}` };

    // Sin saldo puede llegar sin código numérico según por dónde venga envuelto.
    if (bajo.includes('insufficient credit') || bajo.includes('insufficient_quota')
        || bajo.includes('quota')) {
        return { tipo: 'cuenta', codigo: 'sin_saldo' };
    }
    if (bajo.includes('invalid api key') || bajo.includes('no auth credentials')
        || bajo.includes('unauthorized')) {
        return { tipo: 'cuenta', codigo: 'clave_invalida' };
    }

    const patron = PATRONES_RED.find(p => bajo.includes(p));
    if (patron) return { tipo: 'transitorio', codigo: patron.replace(/\s+/g, '_') };

    // Un 400 es NUESTRO payload, no el proveedor. Y lo desconocido no se cuenta: inflar la
    // racha con lo que no se entiende es cómo un aviso se vuelve ruido.
    return null;
}

// orgId → { codigo, fallos, avisado }
//
// El estado es POR ORG aunque la clave de OpenRouter sea única para todo el proceso. Se
// asume a sabiendas: un 402 rompe a las dos organizaciones a la vez, pero cada una avisa a
// su gente cuando le llegan a ella los 3 fallos. La consecuencia práctica es que una org con
// poco tráfico tarda más en avisar que una con mucho — y eso es correcto, porque mide el
// daño real recibido, no el estado de una cuenta que quien recibe el aviso no controla.
const _estado = new Map();

function _get(orgId) {
    if (!_estado.has(orgId)) _estado.set(orgId, { codigo: null, fallos: 0, avisado: false });
    return _estado.get(orgId);
}

const claveAviso = codigo => `llm|${codigo}`;

const MENSAJE_CUENTA = (codigo, contexto) =>
    '🚨 <b>El asistente no está entendiendo los mensajes</b>\n\n'
    + `Acaba de fallar una conversación por un problema de la cuenta del proveedor `
    + `(<code>${codigo}</code>), y esto no es pasajero: <b>van a fallar todas</b>.\n\n`
    + 'Mientras dure, a cada clienta que escriba le contesta <i>"Perdona, no he podido '
    + 'procesar tu mensaje"</i>. Sigue respondiendo, pero no entiende nada: no coge citas, '
    + 'no mira huecos y no reconoce servicios.\n\n'
    + '<b>Esto no se arregla solo.</b> Es la cuenta del proveedor del modelo: hay que '
    + 'recargar saldo o renovar la clave de acceso.\n\n'
    + (contexto ? `Último intento: ${contexto}\n\n` : '')
    + 'Te aviso en cuanto vuelva a funcionar.';

const MENSAJE_TRANSITORIO = (codigo, contexto) =>
    '⚠️ <b>El asistente está fallando temporalmente</b>\n\n'
    + `Han fallado <b>${FALLOS_PARA_AVISAR.transitorio} conversaciones seguidas</b> por el `
    + `mismo motivo (<code>${codigo}</code>).\n\n`
    + 'Mientras dure, a cada clienta que escriba le contesta <i>"Perdona, no he podido '
    + 'procesar tu mensaje"</i> en lugar de atenderla.\n\n'
    + 'Suele ser una caída o una saturación del proveedor y se recupera solo. '
    + 'Si en un rato no te llega el aviso de que ha vuelto, avísanos.\n\n'
    + (contexto ? `Último intento: ${contexto}\n\n` : '')
    + 'Te aviso en cuanto vuelva a funcionar.';

const MENSAJE_RECUPERADO = codigo =>
    '✅ <b>El asistente vuelve a funcionar</b>\n\n'
    + `El fallo (<code>${codigo}</code>) ha dejado de darse: la última conversación se ha `
    + 'entendido bien. Las clientas que escriban ahora reciben respuesta normal.\n\n'
    + 'Las que escribieron mientras estaba caído recibieron un mensaje de disculpa; '
    + 'si alguna quedó a medias, conviene repasar el panel.';

/**
 * Registra el resultado de UNA llamada lógica al modelo (no de cada reintento interno).
 *
 * Lo llama openai.js solo en el intento DEFINITIVO: los reintentos de una misma llamada son
 * una conversación, no varias. Es la misma regla que en waSendMessage, y por el mismo motivo —
 * contar cada reintento dispararía el aviso con un solo tropiezo.
 *
 * Nunca lanza: observar las llamadas no puede romper las llamadas.
 *
 * @param {string} orgId
 * @param {{ok: boolean, error?: Error|string, contexto?: string}} resultado
 */
async function noteLlmResult(orgId, { ok, error = null, contexto = null } = {}) {
    if (!orgId) return;
    try {
        const estado = _get(orgId);

        if (ok) {
            if (estado.avisado) {
                const codigo = estado.codigo;
                estado.avisado = false;
                // Se libera la clave ANTES de avisar: si no, la siguiente caída del mismo
                // tipo quedaría callada para siempre por el throttle.
                clearAlert(orgId, claveAviso(codigo));
                logger.info('llm_recuperado', { orgId, codigo });
                await alertOnce(orgId, `llm_ok|${codigo}|${Date.now()}`, MENSAJE_RECUPERADO(codigo));
            }
            estado.codigo = null;
            estado.fallos = 0;
            return;
        }

        const clasificado = classifyLlmError(error);
        if (!clasificado) return;

        // Un motivo distinto empieza racha nueva: tres fallos por tres causas distintas no
        // son un proveedor caído.
        if (estado.codigo !== clasificado.codigo) {
            estado.codigo = clasificado.codigo;
            estado.fallos = 0;
            estado.avisado = false;
        }
        estado.fallos++;

        logger.warn('llm_fallo_proveedor', {
            orgId, codigo: clasificado.codigo, tipo: clasificado.tipo, consecutivos: estado.fallos,
        });

        const umbral = FALLOS_PARA_AVISAR[clasificado.tipo] ?? FALLOS_PARA_AVISAR.transitorio;
        if (estado.fallos < umbral || estado.avisado) return;

        estado.avisado = true;
        const mensaje = clasificado.tipo === 'cuenta'
            ? MENSAJE_CUENTA(clasificado.codigo, contexto)
            : MENSAJE_TRANSITORIO(clasificado.codigo, contexto);
        const entregado = await alertOnce(orgId, claveAviso(clasificado.codigo), mensaje);
        // Si el aviso no salió, no lo damos por dado: alertOnce ya liberó su clave y el
        // siguiente fallo vuelve a intentarlo.
        if (!entregado) estado.avisado = false;
    } catch (e) {
        logger.error('llm_health_error', { orgId, error: e.message });
    }
}

/** Solo para tests. */
function _reset() { _estado.clear(); }

module.exports = {
    noteLlmResult,
    classifyLlmError,
    FALLOS_PARA_AVISAR,
    UMBRAL_TRANSITORIO,
    _reset,
};
