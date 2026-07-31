/**
 * threesixty-dialog.js — Adapter de canal 360dialog (WhatsApp Cloud API).
 *
 * Aísla TODO lo específico de 360dialog para poder reutilizar el pipeline
 * conversacional de bot.js (`handleIncomingMessage`) sin duplicar código: los
 * mensajes entrantes de Cloud API se adaptan a la misma superficie `message` /
 * `client` que consume whatsapp-web.js hoy.
 *
 * Multi-tenant: `get360Config` es un registry por orgId. Solo Sante está
 * configurada por ahora; una org sin config 360 (p.ej. San Remo) devuelve null
 * y el webhook la ignora — nunca se procesa aquí.
 *
 * HTTP: `fetch` global (Node 18+; ya usado en services/transcription.js). Sin axios.
 */

const { SANTE_ORG_ID } = require('../org-registry');
const logger = require('../../lib/logger');

const DEFAULT_BASE_URL = 'https://waba-v2.360dialog.io';

function getBaseUrl() {
    return process.env.WHATSAPP_360_BASE_URL || DEFAULT_BASE_URL;
}

/**
 * Config de 360dialog por organización. Lee process.env en cada llamada (para
 * testeabilidad y para no cachear una key ausente al arrancar). Devuelve null si
 * la org no tiene canal 360 configurado → el llamador debe ignorar ese mensaje.
 */
function get360Config(orgId) {
    const registry = {
        [SANTE_ORG_ID]: {
            apiKey: process.env.SANTE_360_API_KEY || '',
            phoneNumberId: process.env.SANTE_360_PHONE_NUMBER_ID || '',
        },
    };
    const cfg = registry[orgId];
    if (!cfg || !cfg.apiKey) return null;
    return { ...cfg, baseUrl: getBaseUrl() };
}

function digitsFromJid(jid) {
    return String(jid || '').replace('@c.us', '').replace('@lid', '').replace(/\D/g, '');
}

/**
 * POST a /messages. Único punto de salida HTTP del canal: texto libre y plantilla
 * comparten URL, headers y política de error, así que un cambio (base url, auth,
 * reintentos) no puede aplicarse a la mitad de los envíos.
 */
async function post360(cfg, payload) {
    const res = await fetch(`${cfg.baseUrl}/messages`, {
        method: 'POST',
        headers: {
            'D360-API-KEY': cfg.apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        // Lanzar deja que waSendMessage reintente ante errores transitorios.
        const errText = await res.text().catch(() => '');
        throw new Error(`360dialog send ${res.status}: ${errText}`);
    }
    return res.json().catch(() => ({}));
}

/**
 * Limpia un parámetro de plantilla. Meta RECHAZA el mensaje entero (132000/131008) si
 * un parámetro lleva salto de línea, tabulador o 4+ espacios seguidos — y {{1}} es el
 * nombre, que viene de texto que escribió la clienta. Sin esto, un nombre pegado con
 * un salto de línea tumba el recordatorio y el worker lo da por enviado.
 */
function sanitizeTemplateParam(value) {
    return String(value ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/ {4,}/g, ' ')
        .trim();
}

/**
 * Cliente saliente que imita la superficie mínima de whatsapp-web.js que usa
 * bot.js (`sendMessage`, `getChatById().sendStateTyping`). Enviar por aquí hace
 * que flushBuffer / waSendMessage / sendWithDelay funcionen SIN cambios.
 *
 * `sendTemplate` no tiene equivalente en wwebjs a propósito: es la vía para hablar
 * FUERA de la ventana de 24 h de Cloud API, algo que solo existe en este canal.
 */
function build360Client(orgId) {
    return {
        async sendMessage(jid, text) {
            const cfg = get360Config(orgId);
            if (!cfg) throw new Error(`360dialog no configurado para org ${orgId}`);
            return post360(cfg, {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: digitsFromJid(jid),
                type: 'text',
                text: { body: text },
            });
        },
        /**
         * Envía una plantilla aprobada por Meta. `params` es POSICIONAL: params[0] es
         * {{1}}, params[1] es {{2}}. El orden lo fija quien llama y debe coincidir con
         * el aprobado en el Manager — Meta no valida el significado, solo la cantidad.
         *
         * @param {string} jid
         * @param {{ name: string, language?: string, params?: Array<string|number> }} opts
         */
        async sendTemplate(jid, { name, language = 'es', params = [] } = {}) {
            const cfg = get360Config(orgId);
            if (!cfg) throw new Error(`360dialog no configurado para org ${orgId}`);
            if (!name) throw new Error('360dialog sendTemplate sin nombre de plantilla');
            const parameters = (params || []).map(p => ({ type: 'text', text: sanitizeTemplateParam(p) }));
            return post360(cfg, {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: digitsFromJid(jid),
                type: 'template',
                template: {
                    name,
                    // El código debe ser EXACTAMENTE el de la plantilla aprobada ('es' ≠ 'es_ES'):
                    // si no casa, Cloud API devuelve 132001 y no se entrega nada.
                    language: { code: language },
                    ...(parameters.length ? { components: [{ type: 'body', parameters }] } : {}),
                },
            });
        },
        // Cloud API no tiene "escribiendo…" por chat; no-op (bot.js lo trata como best-effort).
        getChatById(_jid) {
            return { sendStateTyping: async () => {} };
        },
    };
}

/**
 * Descarga un media de 360dialog (audio) y lo devuelve en el shape que espera
 * transcribeAudio(media.data, media.mimetype): { data: base64, mimetype }.
 */
async function download360Media(orgId, mediaId, mimetype) {
    const cfg = get360Config(orgId);
    if (!cfg) throw new Error(`360dialog no configurado para org ${orgId}`);
    const res = await fetch(`${cfg.baseUrl}/${mediaId}`, {
        method: 'GET',
        headers: { 'D360-API-KEY': cfg.apiKey },
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`360dialog media ${res.status}: ${errText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf.toString('base64'), mimetype: mimetype || 'audio/ogg' };
}

// Tipos de Cloud API que traen un binario adjunto. wwebjs marca hasMedia en todos ellos,
// así que el adaptador debe hacer lo mismo: si mentimos con hasMedia:false, bot.js trata el
// mensaje como texto vacío y se calla (silencio total ante una foto).
const CLOUD_MEDIA_TYPES = new Set(['image', 'video', 'sticker', 'document', 'audio', 'voice']);

/**
 * Adapta un mensaje entrante de Cloud API (un elemento de value.messages[]) a la
 * superficie { message, client } que consume handleIncomingMessage(client, message, orgId).
 *
 * @param {object} valueMessage  Un elemento de value.messages[]
 * @param {object} valueMeta     value.metadata (display_phone_number, phone_number_id)
 * @param {string} orgId
 */
function buildInboundAdapters(valueMessage, valueMeta, orgId) {
    const digits = String(valueMessage?.from || '').replace(/\D/g, '');
    const wamid = valueMessage?.id || null;
    const cloudType = valueMessage?.type || 'text';
    const isAudio = cloudType === 'audio' || cloudType === 'voice';

    // El caption de una foto/vídeo/documento ES el mensaje de la clienta ("quiero esto" con la
    // foto del corte). Si lo tiramos, el turno entero se pierde: recuperarlo hace que el mensaje
    // entre al pipeline normal en vez de quedarse en la rama de media no soportada.
    const caption = valueMessage?.image?.caption
        || valueMessage?.video?.caption
        || valueMessage?.document?.caption
        || '';

    const message = {
        // JID clásico → isLidJid() false → resolvePhoneFromMessage extrae el número sin path LID.
        from: `${digits}@c.us`,
        // getMessageKey() lee id._serialized || key.id || id.id → dedupe por wamid.
        id: { _serialized: wamid, id: wamid },
        body: valueMessage?.text?.body || caption || '',
        // bot.js detecta audio con type 'ptt'/'audio'; texto normal es 'chat' en wwebjs. Para el
        // resto conservamos el tipo real de Cloud API, que coincide con el de wwebjs (image,
        // sticker, video, document, location, contacts) → classifyIncomingMedia lo entiende igual
        // venga de donde venga.
        type: isAudio ? 'ptt' : (cloudType === 'text' ? 'chat' : cloudType),
        hasMedia: CLOUD_MEDIA_TYPES.has(cloudType),
        fromMe: false,
        isStatus: false,
        isBroadcast: false,
        // Solo se usa para resolver JIDs @lid; aquí no aplica, pero mantenemos la interfaz.
        async getContact() {
            return { number: digits };
        },
        // Descarga perezosa del audio (solo se invoca si hasMedia && isAudio).
        async downloadMedia() {
            if (!isAudio || !valueMessage?.audio?.id) return null;
            return download360Media(orgId, valueMessage.audio.id, valueMessage.audio.mime_type);
        },
        // Metadatos crudos por si hicieran falta (no los consume bot.js hoy).
        _cloud: { valueMessage, valueMeta },
    };

    return { message, client: build360Client(orgId) };
}

/**
 * Procesa el body completo de un webhook de 360dialog: recorre
 * entry[].changes[].value, ignora statuses, y para cada messages[] resuelve la
 * org por el número receptor, aplica el gate isBotActivo y delega en
 * handleIncomingMessage — el MISMO pipeline exacto que usa whatsapp-web.js.
 *
 * Recibe deps inyectadas (resolveOrgByPhone, isBotActivo, handleIncomingMessage)
 * para evitar el ciclo de require con bot.js y facilitar el test.
 */
async function process360Webhook(body, { resolveOrgByPhone, isBotActivo, handleIncomingMessage }) {
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of changes) {
            const value = change?.value;
            if (!value) continue;
            if (Array.isArray(value.statuses) && value.statuses.length) {
                // Estados de entrega (sent/delivered/read/failed): fase 2. No es un mensaje.
                logger.info('360d_status_ignorado', { count: value.statuses.length });
                continue;
            }
            const messages = Array.isArray(value.messages) ? value.messages : [];
            for (const msg of messages) {
                try {
                    const receiver = value?.metadata?.display_phone_number;
                    const org = resolveOrgByPhone(receiver);
                    const orgId = org?.orgId;
                    if (!orgId || !get360Config(orgId)) {
                        logger.info('360d_msg_org_sin_config', { receiver, orgId: orgId || null });
                        continue;
                    }
                    if (!isBotActivo(orgId)) {
                        logger.info('360d_msg_ignorado_bot_pausado', { orgId });
                        continue;
                    }
                    const { message, client } = buildInboundAdapters(msg, value.metadata, orgId);
                    await handleIncomingMessage(client, message, orgId);
                } catch (e) {
                    logger.error('360d_error_procesando_mensaje', { error: e.message });
                }
            }
        }
    }
}

module.exports = {
    get360Config,
    build360Client,
    sanitizeTemplateParam,
    buildInboundAdapters,
    download360Media,
    process360Webhook,
};
