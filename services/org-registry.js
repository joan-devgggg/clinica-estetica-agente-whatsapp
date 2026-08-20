/**
 * org-registry.js — Mapeo número WhatsApp → organización
 * Fuente de verdad para identificar qué org recibe cada mensaje.
 */

const SANREMO_ORG_ID = process.env.SANREMO_ORG_ID || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SANTE_ORG_ID   = process.env.SANTE_ORG_ID   || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

const SANREMO_WA_PHONE = process.env.SANREMO_WA_PHONE || '34667474233';
const SANTE_WA_PHONE   = process.env.SANTE_WA_PHONE   || '34641029104';

// ─── Canal de WhatsApp por organización ──────────────────────────────────────
// Por dónde ENTRAN y SALEN los mensajes de cada org:
//   'wwebjs'    → whatsapp-web.js (sesión enlazada a un móvil). San Remo.
//   '360dialog' → WhatsApp Cloud API vía webhook. Sante.
//
// Es un dato del registry, NO una env var derivada de SANTE_360_API_KEY, y eso es
// deliberado: si el interruptor dependiera de esa key, una máquina que no la tenga
// (p.ej. el portátil de desarrollo) volvería a crear el cliente wwebjs de Sante y
// reabriría la doble entrada sobre el mismo número — justo el proceso que la causó.
// El canal es una verdad del sistema; el número de Sante está registrado en Cloud API
// y por tanto ya no puede tener sesión de WhatsApp Web.
//
// Escape hatch de rollback sin deploy: SANTE_CHANNEL=wwebjs.
const CHANNEL_WWEBJS = 'wwebjs';
const CHANNEL_360 = '360dialog';

function normalizeChannel(value, fallback) {
    const v = String(value || '').trim().toLowerCase();
    return (v === CHANNEL_WWEBJS || v === CHANNEL_360) ? v : fallback;
}

const SANTE_CHANNEL = normalizeChannel(process.env.SANTE_CHANNEL, CHANNEL_360);

const orgs = [
    {
        orgId: SANREMO_ORG_ID,
        waPhone: SANREMO_WA_PHONE,
        sessionId: 'sanremo',
        slug: 'restaurante-san-remo',
        type: 'restaurant',
        channel: CHANNEL_WWEBJS,
    },
    {
        orgId: SANTE_ORG_ID,
        waPhone: SANTE_WA_PHONE,
        sessionId: 'sante',
        slug: 'sante-healthy-hair-salon',
        type: 'salon',
        channel: SANTE_CHANNEL,
    },
];

const byPhone = new Map(orgs.map(o => [o.waPhone, o]));
const byOrgId = new Map(orgs.map(o => [o.orgId, o]));

function resolveOrgByPhone(waNumber) {
    const digits = String(waNumber).replace(/\D/g, '');
    for (const [phone, org] of byPhone) {
        if (digits.endsWith(phone) || phone.endsWith(digits)) return org;
    }
    return null;
}

function getOrgConfig(orgId) {
    return byOrgId.get(orgId) || null;
}

function getAllOrgs() {
    return orgs;
}

function getOrgType(orgId) {
    return byOrgId.get(orgId)?.type || 'restaurant';
}

const bySlug = new Map(orgs.map(o => [o.slug, o]));

/**
 * Resuelve el slug de la URL pública (`/reservar/:slug`) a su organización, y SOLO si esa
 * org puede tener enlace de reserva. Devuelve null en cualquier otro caso.
 *
 * Las tres formas de «no» devuelven EL MISMO null a propósito, y esto es la mitad del
 * requisito de no filtrar nada:
 *
 *   · el slug no existe            → null
 *   · el slug existe pero es San Remo (restaurante) → null
 *   · el slug viene vacío o con basura → null
 *
 * Si distinguiéramos «no existe» de «existe pero no tiene enlace», cualquiera podría
 * enumerar qué negocios hay dados de alta en el sistema probando slugs. Quien llama tiene
 * que responder lo mismo a los tres — un 404 idéntico — y no mirar por qué fue null.
 *
 * San Remo queda fuera POR TIPO, no por una config vacía: aunque alguien le escribiera
 * mañana un `reservas_web_activo` a true, este `!== 'salon'` sigue devolviendo null. Es la
 * misma puerta estructural que usa el resto del sistema para no tocar el restaurante.
 */
function resolveOrgBySlug(slug) {
    if (!slug || typeof slug !== 'string') return null;
    const org = bySlug.get(slug.trim().toLowerCase());
    if (!org) return null;
    if (org.type !== 'salon') return null;
    return org;
}

// Una org desconocida cae en 'wwebjs': es el comportamiento histórico y el único
// seguro por defecto (no silencia mensajes de una org que no esté en el registry).
function getOrgChannel(orgId) {
    return byOrgId.get(orgId)?.channel || CHANNEL_WWEBJS;
}

/**
 * Resuelve el argumento de org de un script de informe («sante», el slug o el UUID) a la
 * lista de orgs sobre las que correr; sin argumento, todas. Vivía duplicada palabra por
 * palabra en scripts/informe-contactos-sin-nombre.js e informe-seguimientos.js; el tercer
 * script (barrido-promesas) ya no la copia — los dos primeros se quedan como están hasta
 * que se toquen. Con un argumento no reconocido devuelve null: quien llama imprime el uso
 * y sale, en vez de correr «todas» en silencio por un typo.
 */
function resolverOrgArg(arg) {
    if (!arg) return orgs;
    const q = String(arg).toLowerCase();
    const encontrada = orgs.find(o => o.orgId === arg || o.slug === q || o.sessionId === q);
    return encontrada ? [encontrada] : null;
}

module.exports = {
    SANREMO_ORG_ID,
    SANTE_ORG_ID,
    CHANNEL_WWEBJS,
    CHANNEL_360,
    resolveOrgByPhone,
    getOrgConfig,
    getAllOrgs,
    getOrgType,
    getOrgChannel,
    resolveOrgBySlug,
    resolverOrgArg,
};
