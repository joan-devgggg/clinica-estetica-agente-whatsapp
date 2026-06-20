require('dotenv').config();
const readline = require('readline');
const { handleIncomingMessage } = require('./bot');
const { deleteClient } = require('./services/memory');
const { getAllOrgs } = require('./services/org-registry');

// Mock client que simula las funciones de WhatsApp
const mockClient = {
    sendMessage: async (phone, text) => {
        console.log(`\n📤 BOT RESPONDE: ${text}\n`);
    },
    getChatById: async (phone) => {
        return {
            sendStateTyping: async () => {}
        };
    }
};

let messageCounter = 0;
const TEST_PHONE = '34600123456@c.us';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

let selectedOrgId = null;

function showOrgMenu() {
    const orgs = getAllOrgs();
    console.log('\nSelecciona la organización para simular:\n');
    orgs.forEach((o, i) => {
        console.log(`  ${i + 1}. ${o.slug} (${o.type}) — ${o.waPhone}`);
    });
    console.log();
}

async function selectOrg() {
    const orgs = getAllOrgs();
    const cliArg = process.argv[2]?.toLowerCase();

    if (cliArg) {
        const match = orgs.find(o => o.sessionId === cliArg || o.slug.includes(cliArg) || o.type === cliArg);
        if (match) {
            selectedOrgId = match.orgId;
            console.log(`\n✅ ORG: ${match.slug} (${match.type}) — ${match.orgId}\n`);
            return;
        }
        console.log(`\n⚠️  No se encontró org "${cliArg}". Usa: sanremo, sante, restaurant, salon\n`);
    }

    showOrgMenu();
    return new Promise((resolve) => {
        rl.question('Elige (1/2): ', (answer) => {
            const idx = parseInt(answer, 10) - 1;
            if (idx >= 0 && idx < orgs.length) {
                selectedOrgId = orgs[idx].orgId;
                console.log(`\n✅ ORG: ${orgs[idx].slug} (${orgs[idx].type}) — ${selectedOrgId}\n`);
            } else {
                selectedOrgId = orgs[0].orgId;
                console.log(`\n✅ ORG (default): ${orgs[0].slug} — ${selectedOrgId}\n`);
            }
            resolve();
        });
    });
}

function showBanner() {
    const org = getAllOrgs().find(o => o.orgId === selectedOrgId);
    console.log('='.repeat(60));
    console.log('🤖 ENTORNO DE PRUEBAS LOCAL - CHATBOT WHATSAPP');
    console.log(`📍 ${org?.slug || '?'} (${org?.type || '?'})`);
    console.log('='.repeat(60));
    console.log('\nEscribe tus mensajes para interactuar con el bot.');
    console.log('Comandos especiales:');
    console.log('  "reset"  → borra la sesión (nuevo lead)');
    console.log('  "switch" → cambiar de organización');
    console.log('  "exit"   → salir\n');
    console.log('='.repeat(60) + '\n');
}

async function processInput() {
    rl.question('Tú: ', async (input) => {
        if (input.toLowerCase() === 'exit') {
            console.log('\n👋 Saliendo del entorno de pruebas...');
            rl.close();
            process.exit(0);
        }

        if (input.toLowerCase() === 'reset') {
            deleteClient(selectedOrgId, TEST_PHONE);
            console.log('\n🔄 Sesión borrada. El próximo mensaje empieza como nuevo lead.\n');
            processInput();
            return;
        }

        if (input.toLowerCase() === 'switch') {
            deleteClient(selectedOrgId, TEST_PHONE);
            await selectOrg();
            showBanner();
            processInput();
            return;
        }

        if (!input.trim()) {
            processInput();
            return;
        }

        const message = {
            from: TEST_PHONE,
            body: input,
            id: {
                _serialized: `3EB0${messageCounter++}@s.whatsapp.net`
            },
            fromMe: false,
            timestamp: Date.now(),
            isStatus: false,
            isBroadcast: false,
            hasMedia: false,
            getChat: async () => {
                return {
                    sendStateTyping: async () => {}
                };
            }
        };

        console.log('\n⏳ Procesando mensaje...\n');

        await handleIncomingMessage(mockClient, message, selectedOrgId);

        setTimeout(() => {
            processInput();
        }, 500);
    });
}

(async () => {
    await selectOrg();
    showBanner();
    processInput();
})();
