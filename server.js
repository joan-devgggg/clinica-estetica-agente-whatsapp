/**
 * server.js — Punto de entrada único
 * Arranca: WhatsApp client, webhook Meta, review worker, bot Telegram
 */
require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { handleIncomingMessage, initiateLeadConversation, isBotGlobalActivo, setBotGlobalActivo } = require('./bot');
const { startWebhookServer } = require('./webhook');
const { startReviewWorker } = require('./services/review');
const { startReminderWorker } = require('./services/reminder');
const { startTelegramBot } = require('./services/telegram');

const required = ['OPENAI_API_KEY'];
for (const key of required) {
    if (!process.env[key]) {
        console.error(`❌ Variable de entorno requerida no configurada: ${key}`);
        process.exit(1);
    }
}
if (!process.env.AIRTABLE_API_KEY) {
    console.log('ℹ️  Airtable no configurado — usando SQLite local (dashboard en /dashboard)');
}

// ─── Cliente WhatsApp ─────────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', (qr) => {
    console.log('\n📱 Escanea este QR con WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Bot WhatsApp conectado');
    startReviewWorker(client);
    startReminderWorker(client);
});

client.on('disconnected', (reason) => {
    console.warn('⚠️ WhatsApp desconectado:', reason);
});

client.on('message', async (message) => {
    if (message.fromMe) return;
    if (!isBotGlobalActivo()) return;
    await handleIncomingMessage(client, message);
});

// ─── Webhook Meta (Instagram Lead Ads) ───────────────────────────────────────
const webhookEmitter = startWebhookServer(process.env.PORT || 3000);

webhookEmitter.on('lead:new', async (leadData) => {
    console.log('🎯 Lead nuevo recibido:', leadData.telefono);
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
    console.log('\n🛑 Cerrando bot...');
    await client.destroy();
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled rejection:', reason);
});
