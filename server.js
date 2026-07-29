process.env.TZ = 'Europe/Madrid';
console.log(`[TZ] timezone=${process.env.TZ} now=${new Date().toString()}`);
/**
 * server.js — Punto de entrada único (multi-tenant)
 * Arranca: WhatsApp clients (uno por org), webhook/API, workers, bot Telegram
 */
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { handleIncomingMessage, isBotActivo, setBotActivo, setConversationBotMode, setWAClient: setBotWAClient } = require('./bot');
const { getConfigValue } = require('./services/db');
const { startWebhookServer, setWAClient } = require('./webhook');
const { startReminderWorker } = require('./services/reminder');
const { startReviewWorker } = require('./services/review');
const { startTelegramBot } = require('./services/telegram');
const { getAllOrgs, CHANNEL_WWEBJS } = require('./services/org-registry');
const { build360Client } = require('./services/providers/threesixty-dialog');
const logger = require('./lib/logger');

const required = ['OPENROUTER_API_KEY'];
for (const key of required) {
    if (!process.env[key]) {
        logger.error('env_faltante', { variable: key });
        process.exit(1);
    }
}

// ─── Clientes WhatsApp (uno por organización) ────────────────────────────────

const waClients = new Map(); // orgId → { client, orgId, sessionId }
const orgs = getAllOrgs();

for (const org of orgs) {
    // Org migrada a Cloud API: su ENTRANTE llega por el webhook (webhook.js →
    // process360Webhook), nunca por whatsapp-web.js. Crear aquí un Client sería una
    // SEGUNDA entrada sobre el mismo número, y el dedupe no puede detectarla: los ids
    // viven en espacios distintos (`wamid.…` vs `false_…@c.us_…`) y además es un Map en
    // RAM por proceso, así que no cruza dos procesos.
    //
    // Sigue en waClients con el cliente 360 —no fuera del Map— a propósito: reminder.js
    // y review.js iteran sus CLAVES para saber qué orgs procesar, y sendDirectMessage
    // resuelve el cliente por ahí. Sacarla la borraría en silencio de los dos workers.
    if (org.channel !== CHANNEL_WWEBJS) {
        logger.info('org_sin_cliente_wwebjs', { org: org.slug, channel: org.channel });
        console.log(`☁️  ${org.slug}: canal ${org.channel} — sin cliente whatsapp-web.js`);
        waClients.set(org.orgId, { client: build360Client(org.orgId), ...org });
        continue;
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: org.sessionId }),
        puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] }
    });

    client.on('qr', (qr) => {
        logger.info('qr_generado', { org: org.slug });
        console.log(`\n📱 QR para ${org.slug}:`);
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        logger.info('whatsapp_conectado', { org: org.slug });
        console.log(`✅ WhatsApp conectado: ${org.slug}`);
    });

    client.on('disconnected', (reason) => {
        logger.warn('whatsapp_desconectado', { org: org.slug, reason });
        console.log(`⚠️  WhatsApp desconectado: ${org.slug} (${reason}) — reconectando en 10s...`);
        setTimeout(() => {
            logger.info('whatsapp_reconectando', { org: org.slug });
            console.log(`🔄 Reconectando WhatsApp: ${org.slug}...`);
            client.initialize().catch((err) => {
                logger.error('whatsapp_reconexion_fallida', { org: org.slug, error: err.message });
            });
        }, 10000);
    });

    client.on('message_create', async (message) => {
        if (message.fromMe) return;
        if (!isBotActivo(org.orgId)) {
            logger.info('mensaje_ignorado_bot_pausado', { org: org.slug });
            return;
        }
        await handleIncomingMessage(client, message, org.orgId);
    });

    waClients.set(org.orgId, { client, ...org });
}

// ─── Estado del bot por organización (cargado desde config) ──────────────────
// Cada org arranca con su propio bot_activo. Pausar una NO afecta a las demás.
// Refrescamos desde config.bot_activo periódicamente para que el toggle global del panel
// surta efecto en vivo (el panel escribe en Supabase; si el webhook corre en otro proceso,
// la memoria de ESTE proceso no se enteraría sin este refresco). Solo memoria (persist=false).
async function refreshBotActivoFromConfig({ logOnPause = false } = {}) {
    for (const org of orgs) {
        try {
            const v = await getConfigValue(org.orgId, 'bot_activo');
            if (v !== null && v !== undefined) {
                const activo = v === true || v === 'true' || v === 1;
                const previo = isBotActivo(org.orgId);
                setBotActivo(org.orgId, activo, false); // solo memoria; ya está en config
                if (!activo && (logOnPause || previo)) logger.info('bot_pausado_desde_config', { org: org.slug });
            }
        } catch (e) {
            logger.error('error_cargar_bot_activo', { org: org.slug, error: e.message });
        }
    }
}
refreshBotActivoFromConfig({ logOnPause: true });
setInterval(refreshBotActivoFromConfig, 15 * 1000);

// ─── Webhook / API REST ──────────────────────────────────────────────────────
setWAClient(waClients, setConversationBotMode, setBotActivo);
setBotWAClient(waClients);
startWebhookServer(process.env.PORT || 3000);

// ─── Bot de Telegram (panel de administración multi-org) ─────────────────────
startTelegramBot({
    getBotActivo: isBotActivo,
    setBotActivo: setBotActivo,
    waClients,
});

// ─── Arrancar todos los clientes WA ──────────────────────────────────────────
for (const { client, slug, channel } of waClients.values()) {
    if (channel !== CHANNEL_WWEBJS) continue; // el cliente 360 no tiene sesión que iniciar
    console.log(`🔄 Iniciando WhatsApp para ${slug}...`);
    client.initialize();
}

// ─── Workers (arrancan cuando el primer client esté ready) ───────────────────
let workersStarted = false;
function tryStartWorkers() {
    if (workersStarted) return;
    workersStarted = true;
    startReminderWorker(waClients);
    startReviewWorker(waClients);
}

for (const { client, channel } of waClients.values()) {
    if (channel === CHANNEL_WWEBJS) client.on('ready', tryStartWorkers);
}

// Una org en Cloud API no emite 'ready' nunca: esperando solo a ese evento, sus
// recordatorios y reseñas no arrancarían jamás si ninguna sesión wwebjs llega a
// conectar. Arrancar ya es seguro para San Remo: sendReminderMessage/sendReviewMessage
// devuelven false si su cliente aún no está listo y NO marcan como enviado, así que el
// ciclo de 5 min reintenta.
if (orgs.some(o => o.channel !== CHANNEL_WWEBJS)) tryStartWorkers();

// ─── Graceful shutdown ───────────────────────────────────────────────────────
process.on('SIGINT', async () => {
    logger.info('bot_cerrando');
    for (const { client, channel } of waClients.values()) {
        if (channel !== CHANNEL_WWEBJS) continue; // el cliente 360 no tiene navegador que cerrar
        await client.destroy().catch(() => {});
    }
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    logger.error('excepcion_no_capturada', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
    logger.error('rechazo_no_manejado', { reason: String(reason) });
});
