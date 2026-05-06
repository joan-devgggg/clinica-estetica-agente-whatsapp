require('dotenv').config();

const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { handleIncomingMessage } = require('./bot');

const required = ['OPENAI_API_KEY', 'AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID'];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
}

const client = new Client();

client.on('qr', (qr) => {
    console.log('Escanea este QR:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Bot conectado a WhatsApp');
});

client.on('message', async (message) => {
    // CRITICAL: Ignore messages from the bot itself to prevent loops
    if (message.fromMe) {
        console.log("🔄 Mensaje propio del bot ignorado");
        return;
    }
    await handleIncomingMessage(client, message);
});

client.initialize();
