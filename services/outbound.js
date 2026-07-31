/**
 * outbound.js — Resolución ÚNICA del proveedor de salida + reglas de la ventana de 24 h.
 *
 * Antes había dos resoluciones distintas: webhook.js enrutaba por presencia de
 * SANTE_360_API_KEY y server.js por org.channel. Dos fuentes de verdad para "¿por dónde
 * sale este mensaje?" es exactamente el fallo que ya costó una doble entrada sobre el
 * mismo número. Aquí manda el REGISTRY (getOrgChannel), como dice CLAUDE.md: el canal es
 * un dato de la org, nunca se deriva de una variable de entorno.
 */

const { getOrgChannel, CHANNEL_WWEBJS } = require('./org-registry');
const { get360Config, build360Client } = require('./providers/threesixty-dialog');

/** ¿La org habla por Cloud API (no por whatsapp-web.js)? Lo decide el registry. */
function isCloudChannel(orgId) {
    return getOrgChannel(orgId) !== CHANNEL_WWEBJS;
}

/**
 * Cliente saliente para una org. `fallbackClient` es el que ya tenía el llamador
 * (el Client de whatsapp-web.js del Map de server.js).
 *
 * Si el canal es cloud pero falta la config 360, devolvemos el fallback a propósito:
 * para esa org el fallback ES el cliente 360 (server.js lo inyecta igualmente), que
 * lanza "360dialog no configurado" — un error explícito es mejor que un null silencioso.
 */
function resolveOutboundClient(orgId, fallbackClient = null) {
    if (isCloudChannel(orgId) && get360Config(orgId)) return build360Client(orgId);
    return fallbackClient;
}

/**
 * Normaliza el valor de config de una plantilla al par { name, language } que necesita
 * sendTemplate. Acepta tres formas para no obligar a migrar config al aprobar idiomas:
 *
 *   'sante_recordatorio_cita'                          → { name, language: 'es' }
 *   { name: 'sante_…', language: 'es_ES' }             → tal cual
 *   { es: {name,language}, en: {name,language} }       → la del idioma, con fallback a 'es'
 *
 * La tercera se distingue de la segunda por NO tener clave `name`.
 * Devuelve null si no hay nada usable → el llamador debe loguear y NO marcar enviado.
 */
function parseTemplateConfig(raw, language = 'es') {
    if (!raw) return null;

    if (typeof raw === 'string') {
        const name = raw.trim();
        return name ? { name, language: 'es' } : null;
    }
    if (typeof raw !== 'object') return null;

    if (typeof raw.name === 'string') {
        const name = raw.name.trim();
        return name ? { name, language: raw.language || 'es' } : null;
    }

    // Mapa por idioma: el de la clienta si existe, si no el español aprobado.
    const entry = raw[language] || raw.es;
    if (!entry) return null;
    return parseTemplateConfig(entry, language);
}

/**
 * Decide CÓMO debe salir un mensaje automático (recordatorio / reseña) a un contacto.
 * Único sitio donde vive la regla; reminder.js y review.js solo ejecutan el veredicto.
 *
 *   'free_text'     → canal wwebjs, o ventana de 24 h abierta: texto libre, como siempre.
 *   'template'      → fuera de ventana y con plantilla configurada.
 *   'sin_plantilla' → fuera de ventana y SIN plantilla: el llamador debe loguear y NO
 *                     marcar el registro como enviado, para reintentarlo al configurarla.
 *
 * `db` se requiere aquí dentro (no arriba) siguiendo la convención de requires perezosos
 * del proyecto: así webhook.js puede cargar este módulo solo para resolver el cliente.
 */
async function resolveAutomatedSend(orgId, { telefono, language = 'es', plantillaClave }) {
    if (!isCloudChannel(orgId)) return { mode: 'free_text' };

    const { getLastInboundAt, isWithin24hWindow, getConfigValue } = require('./db');

    const lastInboundAt = await getLastInboundAt(orgId, telefono);
    if (isWithin24hWindow(lastInboundAt)) return { mode: 'free_text', lastInboundAt };

    const template = parseTemplateConfig(await getConfigValue(orgId, plantillaClave), language);
    if (!template) return { mode: 'sin_plantilla', lastInboundAt };

    return { mode: 'template', template, lastInboundAt };
}

module.exports = {
    isCloudChannel,
    resolveOutboundClient,
    parseTemplateConfig,
    resolveAutomatedSend,
};
