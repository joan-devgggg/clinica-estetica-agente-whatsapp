/**
 * server.js — Punto de entrada único
 * Arranca: WhatsApp client, webhook Meta, review worker, bot Telegram
 */
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { handleIncomingMessage, initiateLeadConversation, isBotGlobalActivo, setBotGlobalActivo, setConversationBotMode } = require('./bot');
const { startWebhookServer, setWAClient } = require('./webhook');
const { startReviewWorker } = require('./services/review');
const { startReminderWorker } = require('./services/reminder');
const { startTelegramBot } = require('./services/telegram');
const logger = require('./lib/logger');

const required = ['OPENAI_API_KEY'];
for (const key of required) {
    if (!process.env[key]) {
        logger.error('env_faltante', { variable: key });
        process.exit(1);
    }
}

// ─── Cliente WhatsApp ─────────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', (qr) => {
    logger.info('qr_generado');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    logger.info('whatsapp_conectado');
    setWAClient(client, setConversationBotMode);
    startReviewWorker(client);
    startReminderWorker(client);
});

client.on('disconnected', (reason) => {
    logger.warn('whatsapp_desconectado', { reason });
});

client.on('message', async (message) => {
    if (message.fromMe) return;
    if (!isBotGlobalActivo()) return;
    await handleIncomingMessage(client, message);
});

// ─── Webhook Meta (Instagram Lead Ads) ───────────────────────────────────────
const webhookEmitter = startWebhookServer(process.env.PORT || 3000);

webhookEmitter.on('lead:new', async (leadData) => {
    logger.info('lead_nuevo_recibido', { telefono: leadData.telefono });
    await initiateLeadConversation(client, leadData);
});

// ─── Bot de Telegram (panel de administración) ────────────────────────────────
startTelegramBot({
    getBotActivo: isBotGlobalActivo,
    setBotActivo: setBotGlobalActivo
});

// ─── Arrancar WhatsApp ────────────────────────────────────────────────────────
client.initialize();

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
    logger.info('bot_cerrando');
    await client.destroy();
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    logger.error('excepcion_no_capturada', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
    logger.error('rechazo_no_manejado', { reason: String(reason) });
});
