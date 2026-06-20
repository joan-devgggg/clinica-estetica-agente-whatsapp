/**
 * org-registry.js — Mapeo número WhatsApp → organización
 * Fuente de verdad para identificar qué org recibe cada mensaje.
 */

const SANREMO_ORG_ID = process.env.SANREMO_ORG_ID || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SANTE_ORG_ID   = process.env.SANTE_ORG_ID   || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

const SANREMO_WA_PHONE = process.env.SANREMO_WA_PHONE || '34667474233';
const SANTE_WA_PHONE   = process.env.SANTE_WA_PHONE   || '34641029104';

const orgs = [
    {
        orgId: SANREMO_ORG_ID,
        waPhone: SANREMO_WA_PHONE,
        sessionId: 'sanremo',
        slug: 'restaurante-san-remo',
        type: 'restaurant',
    },
    {
        orgId: SANTE_ORG_ID,
        waPhone: SANTE_WA_PHONE,
        sessionId: 'sante',
        slug: 'sante-healthy-hair-salon',
        type: 'salon',
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

module.exports = {
    SANREMO_ORG_ID,
    SANTE_ORG_ID,
    resolveOrgByPhone,
    getOrgConfig,
    getAllOrgs,
    getOrgType,
};
