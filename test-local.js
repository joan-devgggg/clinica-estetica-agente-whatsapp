const readline = require('readline');
const { handleIncomingMessage } = require('./bot');
const { deleteClient } = require('./services/memory');

// Mock client que simula las funciones de WhatsApp
const mockClient = {
    sendMessage: async (phone, text) => {
        console.log(`\n📤 BOT RESPONDE: ${text}\n`);
    },
    getChatById: async (phone) => {
        return {
            sendStateTyping: async () => {
                // Simula el estado "typing" sin hacer nada
            }
        };
    }
};

// Contador para generar IDs únicos de mensajes
let messageCounter = 0;

// Número de teléfono simulado para pruebas
const TEST_PHONE = '34600123456@c.us';

// Interfaz readline para la consola
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log('='.repeat(60));
console.log('🤖 ENTORNO DE PRUEBAS LOCAL - CHATBOT WHATSAPP');
console.log('='.repeat(60));
console.log('\nEscribe tus mensajes para interactuar con el bot.');
console.log('Comandos especiales:');
console.log('  "reset" → borra la sesión del teléfono de prueba (nuevo lead)');
console.log('  "exit"  → salir\n');
console.log('='.repeat(60) + '\n');

// Función para procesar el input del usuario
async function processInput() {
    rl.question('Tú: ', async (input) => {
        if (input.toLowerCase() === 'exit') {
            console.log('\n👋 Saliendo del entorno de pruebas...');
            rl.close();
            process.exit(0);
        }

        if (input.toLowerCase() === 'reset') {
            deleteClient(TEST_PHONE);
            console.log('\n🔄 Sesión borrada. El próximo mensaje empieza como nuevo lead.\n');
            processInput();
            return;
        }

        if (!input.trim()) {
            processInput();
            return;
        }

        // Crear objeto message simulado con la estructura necesaria
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
                    sendStateTyping: async () => {
                        // Simula el estado "typing"
                    }
                };
            }
        };

        console.log('\n⏳ Procesando mensaje...\n');

        // Llamar a la función handleIncomingMessage con el mock client
        await handleIncomingMessage(mockClient, message);

        // Esperar un momento antes de pedir el siguiente input
        setTimeout(() => {
            processInput();
        }, 500);
    });
}

// Iniciar el loop de input
processInput();
