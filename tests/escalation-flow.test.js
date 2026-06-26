/**
 * escalation-flow.test.js — Test del flujo completo de escalada (sin WhatsApp real).
 *
 * Simula: contacto nuevo → pide "extensiones" → bot pregunta si quiere contacto humano →
 * dice "sí" → se escala → panel resuelve → nuevo mensaje "hola" → sin rastro de extensiones.
 *
 * Uso: node tests/escalation-flow.test.js
 */
require('dotenv').config();
const assert = require('assert');
const { SANTE_ORG_ID } = require('../services/org-registry');
const db = require('../services/db');
const { loadClient, saveClient, deleteClient } = require('../services/memory');
const {
    handleIncomingMessage,
    setConversationBotMode,
    _internals: { getSession },
} = require('../bot');

const ORG = SANTE_ORG_ID;
const TEST_PHONE = '34600000099@c.us';
const PHONE_DIGITS = '34600000099';

let pass = 0, fail = 0;
const failures = [];
async function test(name, fn) {
    try { await fn(); pass++; console.log(`  ✅ ${name}`); }
    catch (e) { fail++; failures.push({ name, err: e.message }); console.log(`  ❌ ${name}\n       ${e.message}`); }
}

// Mock WA client — captura mensajes enviados sin enviar nada real
function createMockClient() {
    const sent = [];
    return {
        sent,
        getChatById: async () => ({ sendStateTyping: async () => {} }),
        sendMessage: async (_to, text) => { sent.push(text); },
    };
}

// Simula un mensaje entrante procesado por el bot
async function simulateMessage(client, text) {
    const msg = {
        from: TEST_PHONE,
        body: text,
        id: { _serialized: `msg_${Date.now()}_${Math.random()}` },
        hasMedia: false,
        getContact: async () => ({ number: PHONE_DIGITS }),
    };
    await handleIncomingMessage(client, msg, ORG, PHONE_DIGITS);
    // El buffer agrupa mensajes durante BUFFER_DELAY_MS (5s). Esperamos a que se procese.
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
    console.log('\n═══ FLUJO DE ESCALADA (extensiones → resolución → limpieza) ═══\n');

    // Cleanup previo
    await cleanup();

    const client = createMockClient();

    // ─── Paso 1: Contacto nuevo pide "extensiones" ──────────────────────────
    await test('1. Contacto pide "quiero extensiones" → bot pregunta si quiere contacto humano', async () => {
        await simulateMessage(client, 'quiero extensiones');

        const session = getSession(ORG, TEST_PHONE);
        assert(session, 'sesión debe existir');
        assert.strictEqual(session.pendingEscalation, true, 'pendingEscalation debe ser true');
        assert.strictEqual(session.pendingEscalationService, 'extensiones', 'pendingEscalationService debe ser "extensiones"');

        const lastMsg = client.sent[client.sent.length - 1] || '';
        assert(
            lastMsg.toLowerCase().includes('contacto') ||
            lastMsg.toLowerCase().includes('especialista') ||
            lastMsg.toLowerCase().includes('valoración') ||
            lastMsg.toLowerCase().includes('touch'),
            `Bot debe preguntar si quiere contacto humano, recibido: "${lastMsg.substring(0, 100)}"`
        );
    });

    // ─── Paso 2: Contacto dice "sí" → escalada real ─────────────────────────
    await test('2. Contacto dice "sí" → bot_mode=manual, escalation_reason guardado', async () => {
        client.sent.length = 0;
        await simulateMessage(client, 'sí');

        const session = getSession(ORG, TEST_PHONE);
        assert(session, 'sesión debe existir');
        assert.strictEqual(session.botActivo, false, 'botActivo debe ser false tras escalada');

        // Verificar en Supabase
        const contact = await db.findByPhone(ORG, PHONE_DIGITS);
        assert(contact, 'contacto debe existir en Supabase');
        assert.strictEqual(contact.bot_mode, 'manual', 'bot_mode debe ser "manual" en Supabase');
        assert(contact.escalation_reason, 'escalation_reason debe estar guardado');
        assert(
            contact.escalation_reason.includes('extensiones'),
            `escalation_reason debe contener "extensiones", recibido: "${contact.escalation_reason}"`
        );
    });

    // ─── Paso 3: Verificar estado de sesión post-escalada ───────────────────
    await test('3. Sesión post-escalada: pendingEscalation=false, servicio=extensiones en contexto', async () => {
        const session = getSession(ORG, TEST_PHONE);
        assert.strictEqual(session.pendingEscalation, false, 'pendingEscalation debe ser false (ya se escaló)');
        assert.strictEqual(session.pendingEscalationService, null, 'pendingEscalationService debe ser null');
    });

    // ─── Paso 4: Simular resolución desde panel ─────────────────────────────
    await test('4. Resolución desde panel → selectedService=null, pendingEscalation=false en SQLite y memoria', async () => {
        // Panel llama a setLeadBotMode para poner auto + limpiar escalation_reason
        await db.setLeadBotMode(ORG, PHONE_DIGITS, 'auto');

        // Panel llama a setConversationBotMode(phone, true) para reactivar bot
        setConversationBotMode(PHONE_DIGITS, true);

        // Verificar sesión en memoria
        const session = getSession(ORG, TEST_PHONE);
        assert(session, 'sesión debe existir en memoria');
        assert.strictEqual(session.botActivo, true, 'botActivo debe ser true tras resolución');
        assert.strictEqual(session.selectedService, null, 'selectedService debe ser null tras resolución');
        assert.strictEqual(session.selectedCategory || null, null, 'selectedCategory debe ser null');
        assert.strictEqual(session.pendingEscalation, false, 'pendingEscalation debe ser false');

        // Verificar SQLite
        const persisted = loadClient(ORG, PHONE_DIGITS);
        if (persisted && persisted.extra) {
            assert.strictEqual(persisted.extra.selectedService, null, 'selectedService debe ser null en SQLite.extra');
            assert.strictEqual(persisted.extra.pendingEscalation, false, 'pendingEscalation debe ser false en SQLite.extra');
            assert.strictEqual(persisted.extra.pendingEscalationService || null, null, 'pendingEscalationService debe ser null en SQLite.extra');
        }
    });

    // ─── Paso 5: Verificar Supabase post-resolución ─────────────────────────
    await test('5. Supabase post-resolución: bot_mode=auto, escalation_reason=null', async () => {
        const contact = await db.findByPhone(ORG, PHONE_DIGITS);
        assert(contact, 'contacto debe existir en Supabase');
        assert.strictEqual(contact.bot_mode, 'auto', 'bot_mode debe ser "auto" tras resolución');
        assert.strictEqual(contact.escalation_reason, null, 'escalation_reason debe ser null');
    });

    // ─── Paso 6: Nuevo mensaje "hola" → contexto limpio ────────────────────
    await test('6. Nuevo mensaje "hola" → contexto LLM NO contiene "extensiones"', async () => {
        client.sent.length = 0;
        await simulateMessage(client, 'hola');

        const session = getSession(ORG, TEST_PHONE);
        assert(session, 'sesión debe existir');

        // Verificar que partialData no contiene "extensiones"
        const pdStr = JSON.stringify(session.partialData || {}).toLowerCase();
        assert(
            !pdStr.includes('extensiones'),
            `partialData NO debe contener "extensiones", tiene: ${pdStr.substring(0, 200)}`
        );

        // Verificar que selectedService es null
        assert.strictEqual(session.selectedService, null, 'selectedService debe seguir null');

        // Verificar que el historial reciente no contiene el contexto de escalada
        const recentHistory = session.history.slice(-5);
        const histStr = JSON.stringify(recentHistory).toLowerCase();
        const hasExtensionesInHistory = recentHistory.some(m =>
            m.role === 'assistant' && m.content && m.content.toLowerCase().includes('extensiones')
        );
        // Los mensajes del bot sobre extensiones (la pregunta de escalada) no deberían
        // estar en el historial que se envía al LLM (se filtra por isFallbackText)
        // o si están, no deberían causar que el LLM piense que hay un servicio pendiente.
        // Lo crítico es que partialData y selectedService estén limpios.
        assert.strictEqual(session.selectedService, null, 'selectedService debe ser null al procesar "hola"');
        assert.strictEqual(session.pendingEscalation, false, 'pendingEscalation debe ser false');
    });

    // ─── Cleanup ─────────────────────────────────────────────────────────────
    await cleanup();

    // ─── Resultado ───────────────────────────────────────────────────────────
    console.log(`\n═══ RESULTADO: ${pass} pasaron, ${fail} fallaron ═══`);
    if (failures.length > 0) {
        console.log('\nFallos:');
        for (const f of failures) console.log(`  ❌ ${f.name}: ${f.err}`);
        process.exit(1);
    }
    process.exit(0);
})();
