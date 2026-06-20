require('dotenv').config();
const { handleIncomingMessage } = require('./bot');
const { deleteClient } = require('./services/memory');
const { getAllOrgs } = require('./services/org-registry');

const orgSlug = process.argv[2] || 'sanremo';
const orgs = getAllOrgs();
const scriptKey = orgSlug === 'blacklist' ? 'blacklist' : orgSlug;
const resolvedSlug = orgSlug === 'blacklist' ? 'sanremo' : orgSlug;
const org = orgs.find(o => o.sessionId === resolvedSlug || o.slug.includes(resolvedSlug));
if (!org) { console.error(`Org "${orgSlug}" no encontrada`); process.exit(1); }

const orgId = org.orgId;
const TEST_PHONE = '34600999999@c.us';
let counter = 0;
const responses = [];

const mockClient = {
    sendMessage: async (phone, text) => {
        responses.push(text);
        console.log(`\n📤 BOT: ${text}\n`);
    },
    getChatById: async () => ({
        sendStateTyping: async () => {}
    })
};

function makeMessage(text) {
    return {
        from: TEST_PHONE,
        body: text,
        id: { _serialized: `E2E${counter++}@s.whatsapp.net` },
        fromMe: false,
        timestamp: Date.now(),
        isStatus: false,
        isBroadcast: false,
        hasMedia: false,
        getChat: async () => ({ sendStateTyping: async () => {} })
    };
}

async function send(text) {
    responses.length = 0;
    console.log(`\n👤 TÚ: ${text}`);
    await handleIncomingMessage(mockClient, makeMessage(text), orgId);
    // handleIncomingMessage enqueues work — poll until bot responds or timeout
    const deadline = Date.now() + 30000;
    while (responses.length === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
    }
    if (responses.length === 0) console.log('⚠️  Sin respuesta (timeout 30s)');
    return responses.join('\n');
}

const scripts = {
    sanremo: [
        'Hola',
        'Me llamo Juan',
        '4 personas',
        'Este viernes por la noche',
        'Perfecto',
        'Ya he hecho el Bizum',
    ],
    sante: [
        'Hello',
        'My name is Sarah',
        'I want a balayage',
        'No thanks, just the balayage',
        'No preference',
        'The first option works',
    ],
    blacklist: [
        'Hola quiero reservar',
        'Hola de nuevo',
    ],
};

const messages = scripts[scriptKey] || scripts.sanremo;

(async () => {
    console.log('='.repeat(60));
    console.log(`🧪 TEST E2E — ${org.slug} (${org.type})`);
    console.log('='.repeat(60));

    deleteClient(orgId, TEST_PHONE);
    console.log('\n🔄 Sesión limpia\n');

    for (let i = 0; i < messages.length; i++) {
        console.log(`--- Paso ${i + 1}/${messages.length} ---`);
        await send(messages[i]);
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Test E2E completado');
    console.log('='.repeat(60));
    process.exit(0);
})();
