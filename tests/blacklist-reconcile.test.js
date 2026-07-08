/**
 * blacklist-reconcile.test.js — Regresión del "cuelgue silencioso" tras reactivar
 * un contacto desde Telegram.
 *
 * Bug: la reactivación ("Sí, continuar") sólo limpia is_blacklisted en la DB, no la
 * sesión viva en memoria. La reconciliación de bot.js era unidireccional (sólo
 * false→true), así que la sesión conservaba isBlacklisted=true y, con blacklistNotified
 * ya en true, cada mensaje caía en un `return` silencioso sin log ni respuesta.
 *
 * Este test reproduce el escenario: DB dice is_blacklisted=false pero la sesión viva
 * la marca true → tras un mensaje, la reconciliación debe LIMPIAR el flag y el bot debe
 * responder (no quedar mudo).
 *
 * Uso: node tests/blacklist-reconcile.test.js
 */
require('dotenv').config();
const assert = require('assert');
const { SANTE_ORG_ID } = require('../services/org-registry');
const db = require('../services/db');
const { deleteClient } = require('../services/memory');

// ── Stub del LLM ANTES de requerir bot.js. services/llm llama a
// openai.getChatbotResponse por referencia dinámica, así que el patch surte efecto.
const openai = require('../services/providers/openai');
const _realGetChatbot = openai.getChatbotResponse;
openai.getChatbotResponse = async () => ({
    respuesta: 'Hola 😊 ¿en qué puedo ayudarte?',
    reserva_confirmada: false,
    slot_rechazado: false,
    accion: null,
    datos: {},
});

const {
    handleIncomingMessage,
    _internals: { getSession },
} = require('../bot');

const ORG = SANTE_ORG_ID;
const TEST_PHONE = '34600000088@c.us';
const PHONE_DIGITS = '34600000088';

let pass = 0, fail = 0;
const failures = [];
async function test(name, fn) {
    try { await fn(); pass++; console.log(`  ✅ ${name}`); }
    catch (e) { fail++; failures.push({ name, err: e.message }); console.log(`  ❌ ${name}\n       ${e.message}`); }
}

function createMockClient() {
    const sent = [];
    return {
        sent,
        getChatById: async () => ({ sendStateTyping: async () => {} }),
        sendMessage: async (_to, text) => { sent.push(text); },
    };
}

async function simulateMessage(client, text) {
    const msg = {
        from: TEST_PHONE,
        body: text,
        id: { _serialized: `msg_${Date.now()}_${Math.random()}` },
        hasMedia: false,
        getContact: async () => ({ number: PHONE_DIGITS }),
    };
    await handleIncomingMessage(client, msg, ORG, PHONE_DIGITS);
    // El buffer agrupa mensajes durante BUFFER_DELAY_MS (5s). Esperamos al flush.
    await new Promise(r => setTimeout(r, 7000));
}

async function cleanup() {
    deleteClient(ORG, PHONE_DIGITS);
    try { await db.setLeadBotMode(ORG, PHONE_DIGITS, 'auto'); } catch {}
    try {
        const contact = await db.findByPhone(ORG, PHONE_DIGITS);
        if (contact) {
            await require('../services/supabase')
                .from('contacts').delete()
                .eq('id', contact.id).eq('organization_id', ORG);
        }
    } catch {}
}

(async () => {
    console.log('\n═══ RECONCILIACIÓN BLACKLIST (reactivación → no queda mudo) ═══\n');

    await cleanup();
    const client = createMockClient();

    // ─── Setup: contacto existe en DB, NO en lista negra, bot_mode auto ──────
    // (equivale a un contacto ya reactivado desde Telegram: removeBlacklist + auto).
    await db.saveLead(ORG, { telefono: PHONE_DIGITS, nombre: 'Test Reactivado' });
    const created = await db.findByPhone(ORG, PHONE_DIGITS);
    if (created) await db.removeBlacklist(ORG, created.id);
    await db.setLeadBotMode(ORG, PHONE_DIGITS, 'auto');

    // ─── Paso 1: primer mensaje → crea la sesión viva ───────────────────────
    await test('1. Primer mensaje crea la sesión viva y el bot responde', async () => {
        await simulateMessage(client, 'hola');
        const session = getSession(ORG, TEST_PHONE);
        assert(session, 'sesión debe existir');
        assert(client.sent.length > 0, 'el bot debe haber respondido');
    });

    // ─── Paso 2: simular que la sesión viva quedó marcada como blacklist ────
    // (el contacto fue baneado y notificado ANTES de reactivarlo en la DB; la
    // reactivación de Telegram no tocó esta sesión en memoria).
    await test('2. Marcamos la sesión viva como blacklist notificada (estado obsoleto)', async () => {
        const session = getSession(ORG, TEST_PHONE);
        session.isBlacklisted = true;
        session.blacklistNotified = true;
        assert.strictEqual(session.isBlacklisted, true, 'precondición: sesión marcada blacklist');
    });

    // ─── Paso 3: nuevo mensaje → reconciliación limpia el flag y el bot responde ─
    await test('3. Nuevo mensaje: reconciliación limpia isBlacklisted y el bot NO queda mudo', async () => {
        client.sent.length = 0;
        await simulateMessage(client, 'hola de nuevo');

        const session = getSession(ORG, TEST_PHONE);
        assert(session, 'sesión debe existir');
        assert.strictEqual(session.isBlacklisted, false, 'isBlacklisted debe haberse limpiado por reconciliación con la DB');
        assert.strictEqual(session.blacklistNotified, false, 'blacklistNotified debe resetearse');
        assert(client.sent.length > 0, 'el bot debe responder (NO caer en el return silencioso)');
    });

    await cleanup();

    console.log(`\n═══ RESULTADO: ${pass} pasaron, ${fail} fallaron ═══`);
    openai.getChatbotResponse = _realGetChatbot;
    if (failures.length > 0) {
        console.log('\nFallos:');
        for (const f of failures) console.log(`  ❌ ${f.name}: ${f.err}`);
        process.exit(1);
    }
    process.exit(0);
})();
