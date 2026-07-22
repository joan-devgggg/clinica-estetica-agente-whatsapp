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
 * Cliente saliente que imita la superficie mínima de whatsapp-web.js que usa
 * bot.js (`sendMessage`, `getChatById().sendStateTyping`). Enviar por aquí hace
 * que flushBuffer / waSendMessage / sendWithDelay funcionen SIN cambios.
 */
function build360Client(orgId) {
    return {
        async sendMessage(jid, text) {
            const cfg = get360Config(orgId);
            if (!cfg) throw new Error(`360dialog no configurado para org ${orgId}`);
            const to = digitsFromJid(jid);
            const res = await fetch(`${cfg.baseUrl}/messages`, {
                method: 'POST',
                headers: {
                    'D360-API-KEY': cfg.apiKey,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to,
                    type: 'text',
                    text: { body: text },
                }),
            });
            if (!res.ok) {
                // Lanzar deja que waSendMessage reintente ante errores transitorios.
                const errText = await res.text().catch(() => '');
                throw new Error(`360dialog send ${res.status}: ${errText}`);
            }
            return res.json().catch(() => ({}));
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

    const message = {
        // JID clásico → isLidJid() false → resolvePhoneFromMessage extrae el número sin path LID.
        from: `${digits}@c.us`,
        // getMessageKey() lee id._serialized || key.id || id.id → dedupe por wamid.
        id: { _serialized: wamid, id: wamid },
        body: valueMessage?.text?.body || '',
        // bot.js detecta audio con type 'ptt'/'audio'; texto normal es 'chat' en wwebjs.
        type: isAudio ? 'ptt' : 'chat',
        hasMedia: isAudio,
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
    buildInboundAdapters,
    download360Media,
    process360Webhook,
};
