#!/usr/bin/env node
/**
 * campana-verano-tanda.js — dispara UNA tanda de la campaña de verano de Sante.
 *
 * Replica exactamente lo que hace POST /api/campaigns/broadcast (webhook.js:1201) pero en
 * proceso, porque requireApiAuth exige un JWT real de Supabase Auth y /api/dev-login está
 * roto por el proxy.
 *
 * LA REGLA QUE NO SE PUEDE SALTAR: el allowlist se RECALCULA aquí, restando las exclusiones
 * de la audiencia del momento. No se guarda ni se lee ninguna lista de destinatarios: una
 * lista congelada es una foto, y deja fuera para siempre —y en silencio— a toda ficha creada
 * después. Lo que se guarda es lo que no cambia: las exclusiones.
 *
 * Y hay que pasarlo en TODAS las tandas. El dedupe de campaignKey impide repetir
 * destinatarios, pero NO recuerda a quién excluiste: no hay fila en broadcast_sends para
 * quien nunca entró en la lista.
 *
 *   node scripts/campana-verano-tanda.js --dry-run   ← recuentos, no construye cliente
 *   node scripts/campana-verano-tanda.js             ← ENVÍA WhatsApps reales
 */

require('dotenv').config();

const db = require('../services/db');
const { resolveOutboundClient } = require('../services/outbound');
const { runBroadcast, MAX_DESTINATARIOS_24H } = require('../services/broadcast');
const exclusiones = require('../data/campana-verano-exclusiones.json');

const ORG_ID = process.env.SANTE_ORG_ID || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const CAMPAIGN_KEY = 'verano_tratamientos';
const PLANTILLA_CLAVE = 'plantilla_campana';
const LIMIT = 250;

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    // ── 1. Exclusiones → Set normalizado con el MISMO sanitizePhone que la audiencia ──
    const EXCLUIDAS = new Set(
        exclusiones.excluidos.map(e => db.sanitizePhone(e.telefono)).filter(Boolean)
    );
    console.log(`Exclusiones: ${exclusiones.excluidos.length} en fichero → ${EXCLUIDAS.size} tras sanitizar`);
    console.log(`revisado_por_duena: ${exclusiones.revisado_por_duena}`);

    // ── 2. Audiencia de AHORA ────────────────────────────────────────────────
    const { destinatarios: audiencia, excluidos } = await db.getBroadcastAudience(ORG_ID, {
        audience: 'todos',
    });
    const porMotivo = {};
    for (const e of excluidos) porMotivo[e.motivo] = (porMotivo[e.motivo] || 0) + 1;
    console.log(`\nAudiencia 'todos' enviable: ${audiencia.length}`);
    console.log(`  fuera por teléfono: ${excluidos.length} ${JSON.stringify(porMotivo)}`);

    // ── 3. Allowlist = audiencia de hoy − exclusiones ─────────────────────────
    const phones = audiencia
        .map(c => db.sanitizePhone(c.telefono))
        .filter(p => p && !EXCLUIDAS.has(p));
    console.log(`Allowlist recalculado: ${phones.length}`);

    // ── 4. Lo que de verdad saldría, para poder pararlo antes de enviar ───────
    const yaEnviados = await db.getBroadcastSentPhones(ORG_ID, CAMPAIGN_KEY);
    const pendientes = phones.filter(p => !yaEnviados.has(p));
    const enviados24h = await db.countBroadcastSendsLast24h(ORG_ID);
    const cupo = Math.max(0, MAX_DESTINATARIOS_24H - enviados24h);
    const saldrian = Math.min(pendientes.length, cupo, LIMIT);

    console.log(`\nYa recibieron esta campaña: ${yaEnviados.size} (de los cuales ${phones.length - pendientes.length} están en el allowlist de hoy)`);
    console.log(`Pendientes reales: ${pendientes.length}`);
    console.log(`Enviados últimas 24 h: ${enviados24h} · tope ${MAX_DESTINATARIOS_24H} · CUPO LIBRE: ${cupo}`);
    console.log(`Saldrían en esta tanda: ${saldrian} · quedarían después: ${pendientes.length - saldrian}`);

    if (DRY_RUN) {
        console.log('\n--dry-run: no se construye cliente ni se envía nada.');
        return;
    }

    // ── 5. Disparo ───────────────────────────────────────────────────────────
    const destinatarios = await db.getBroadcastRecipients(ORG_ID, { audience: 'todos', phones });
    const client = resolveOutboundClient(ORG_ID);
    if (!client) throw new Error('WhatsApp no conectado: resolveOutboundClient devolvió null');

    console.log(`\n▶ Disparando ${CAMPAIGN_KEY} sobre ${destinatarios.length} del allowlist…`);
    // `mensaje` NO se pasa: plantillaClave es lo que fuerza la plantilla, y con mensaje las
    // que estén dentro de la ventana de 24 h recibirían texto libre en castellano.
    const resumen = await runBroadcast(ORG_ID, {
        client,
        destinatarios,
        plantillaClave: PLANTILLA_CLAVE,
        campaignKey: CAMPAIGN_KEY,
        limit: LIMIT,
    });

    console.log('\n── RESUMEN ──');
    console.log(JSON.stringify(resumen, null, 2));
}

main()
    .then(() => process.exit(0))
    .catch(e => { console.error('ERROR:', e.message); process.exit(1); });
