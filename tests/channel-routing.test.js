/**
 * tests/channel-routing.test.js — Sante entra SOLO por 360dialog; San Remo sigue en wwebjs.
 *
 * Bug arreglado: la migración de Sante a Cloud API conectó el webhook de 360dialog pero
 * nadie apagó su cliente de whatsapp-web.js (server.js iteraba getAllOrgs() sin condición
 * alguna). Los dos canales escuchaban el mismo número +34641029104 a la vez, y el dedupe
 * no podía detectarlo por dos razones independientes: los ids viven en espacios distintos
 * (`wamid.…` vs `false_…@c.us_…`) y TTLMessageDedupe es un Map en RAM de 60 s POR PROCESO,
 * así que jamás cruza dos procesos. Resultado: cada mensaje de una clienta se procesaba —y
 * se respondía— dos veces.
 *
 * Se afirma sobre el efecto real (¿el mensaje llega al buffer del motor?), no sobre el
 * texto de un log. No se fuerza el flush, así que no interviene el LLM.
 *
 * Hermético: se interceptan solo los bordes (db, telegram, transcripción). No toca red.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

// A PROPÓSITO sin SANTE_360_API_KEY ni SANTE_CHANNEL: el canal debe salir del registry,
// no de una env var. Si dependiera de la key, una máquina que no la tenga (el portátil de
// desarrollo, que es justo donde vivía el proceso wwebjs culpable) volvería a crear el
// cliente de Sante y reabriría la doble entrada.
delete process.env.SANTE_360_API_KEY;
delete process.env.SANTE_CHANNEL;

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const SANTE_ORG   = process.env.SANTE_ORG_ID   || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const SANREMO_ORG = process.env.SANREMO_ORG_ID || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── Stubs de borde ──────────────────────────────────────────────────────────────────
// db: cualquier función devuelve null. El camino que se ejercita (guard → buffer) solo
// dispara saveMessage/setContactJid, ambas fire-and-forget con .catch().
const dbPath = require.resolve('../services/db');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: new Proxy({}, { get: () => async () => null }),
};

const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: { notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {} },
};

const transcriptionPath = require.resolve('../services/transcription');
require.cache[transcriptionPath] = {
    id: transcriptionPath, filename: transcriptionPath, loaded: true,
    exports: { transcribeAudio: async () => '' },
};

const { getOrgChannel, CHANNEL_WWEBJS, CHANNEL_360, getAllOrgs } = require('../services/org-registry');
const bot = require('../bot');

const fails = [];
function check(label, fn) {
    try { fn(); console.log(`  ✅ ${label}`); }
    catch (e) { fails.push(`${label}: ${e.message}`); console.log(`  ❌ ${label}\n     ${e.message}`); }
}

function makeClient(sink) {
    return {
        sendMessage: async (_jid, text) => { sink.push(text); },
        getChatById: async () => ({ sendStateTyping: async () => {} }),
    };
}

function makeMsg(from, text, serializedId) {
    return {
        from, body: text,
        id: { _serialized: serializedId },
        fromMe: false, timestamp: Date.now(),
        isStatus: false, isBroadcast: false, hasMedia: false, type: 'chat',
        getContact: async () => ({ number: from.replace(/\D/g, '') }),
        getChat: async () => ({ sendStateTyping: async () => {} }),
    };
}

// Entrega un mensaje y contesta si llegó al motor. El buffer es el primer efecto
// observable tras el guard, y esperar a él no requiere LLM ni BD.
async function entraAlMotor(orgId, phone, text, serializedId) {
    const jid = `${phone}@c.us`;
    const sink = [];
    await bot.handleIncomingMessage(makeClient(sink), makeMsg(jid, text, serializedId), orgId);
    const buffer = bot._internals.getBuffer(orgId, jid);
    // Limpieza: sin esto el timer de 5 s dispararía flushBuffer contra el LLM.
    if (buffer?.timer) clearTimeout(buffer.timer);
    bot._internals.messageBuffers.delete(`${orgId}:${jid}`);
    return { entro: !!buffer, respuestas: sink };
}

const ID_WWEBJS = 'false_34641029104@c.us_3A1B2C3D4E5F';
const ID_WAMID  = 'wamid.HBgLMzQ2NDEwMjkxMDQVAgASGCA1RjZBN0I4QzlEMEUxRjJBAA==';

(async () => {
    console.log('\n🔌 Enrutado de canal por organización\n');

    // ─── 1. El canal sale del registry, no de las env vars ───────────────────────────
    console.log('1) Registry');
    // El canal NO depende de la key: se comprueba con ella y sin ella, en procesos aparte.
    //
    // Antes esto se afirmaba mirando el entorno del propio test (`SANTE_360_API_KEY ===
    // undefined`), y era una medida de la MÁQUINA, no del sistema: el `delete` de la
    // cabecera lo deshace el `require('dotenv').config()` de bot.js, que se carga después.
    // Mientras el portátil no tuvo la key, pasaba; el 05/08/2026 se añadió al .env para
    // poder enviar una campaña de prueba y `npm test` se cayó entero por un fichero que no
    // tiene nada que ver con las campañas. Un check que caduca en cuanto la máquina se
    // parece a producción no protege nada: mide antigüedad.
    const canalEnSubproceso = (envExtra) => {
        const script = `const r=require(${JSON.stringify(path.join(__dirname, '..', 'services', 'org-registry.js'))});`
            + `process.stdout.write(r.getOrgChannel(${JSON.stringify(SANTE_ORG)}));`;
        const env = { ...process.env, SANTE_CHANNEL: '', ...envExtra };
        for (const [k, v] of Object.entries(envExtra)) if (v === undefined) delete env[k];
        return execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }).trim();
    };

    check('Sante está en 360dialog CON la key en el entorno', () => {
        assert.strictEqual(canalEnSubproceso({ SANTE_360_API_KEY: 'clave-de-prueba' }), CHANNEL_360);
    });
    check('…y SIN la key también: el canal sale del registry, no de la env var', () => {
        // Es la mitad que de verdad importa: si el canal dependiera de la key, una máquina
        // sin ella volvería a levantar el cliente wwebjs de Sante y reabriría la doble
        // entrada sobre el mismo número — el proceso que causó el incidente.
        assert.strictEqual(canalEnSubproceso({ SANTE_360_API_KEY: undefined }), CHANNEL_360);
    });
    check('el registry cargado en este proceso dice lo mismo', () => {
        assert.strictEqual(getOrgChannel(SANTE_ORG), CHANNEL_360);
    });
    check('San Remo sigue en wwebjs', () => {
        assert.strictEqual(getOrgChannel(SANREMO_ORG), CHANNEL_WWEBJS);
    });
    check('toda org del registry declara canal explícito', () => {
        for (const org of getAllOrgs()) {
            assert.ok([CHANNEL_WWEBJS, CHANNEL_360].includes(org.channel), `${org.slug} → canal "${org.channel}"`);
        }
    });
    check('una org desconocida cae en wwebjs (por defecto seguro: no silencia nada)', () => {
        assert.strictEqual(getOrgChannel('00000000-0000-0000-0000-000000000000'), CHANNEL_WWEBJS);
    });

    // ─── 2. El guard descarta la entrada por el canal apagado ────────────────────────
    console.log('\n2) Guard de canal en handleIncomingMessage');
    {
        const r = await entraAlMotor(SANTE_ORG, '34600111222', 'hola quiero cita', ID_WWEBJS);
        check('Sante + id de whatsapp-web.js → DESCARTADO (esta era la 2ª entrada)', () => {
            assert.strictEqual(r.entro, false, 'el mensaje llegó al buffer: la doble entrada sigue abierta');
            assert.strictEqual(r.respuestas.length, 0, `el bot respondió: ${JSON.stringify(r.respuestas)}`);
        });
    }
    {
        const r = await entraAlMotor(SANTE_ORG, '34600111333', 'hola quiero cita', ID_WAMID);
        check('Sante + wamid (webhook 360dialog) → SE PROCESA', () => {
            assert.strictEqual(r.entro, true, 'el canal bueno quedó bloqueado: Sante se quedaría muda');
        });
    }

    // ─── 3. No regresión de San Remo ─────────────────────────────────────────────────
    console.log('\n3) San Remo intacto');
    {
        const r = await entraAlMotor(SANREMO_ORG, '34600111444', 'hola quiero mesa', ID_WWEBJS);
        check('San Remo + id de whatsapp-web.js → SE PROCESA como siempre', () => {
            assert.strictEqual(r.entro, true, 'el guard ha tocado a San Remo: regresión de la regla de oro');
        });
    }

    // ─── 4. Escape hatch de rollback ─────────────────────────────────────────────────
    // En proceso aparte: bot.js captura getOrgChannel al requerirse, así que recargar el
    // registry aquí no probaría nada. Esto verifica el interruptor de vuelta atrás sin deploy.
    console.log('\n4) Escape hatch SANTE_CHANNEL=wwebjs');
    check('SANTE_CHANNEL=wwebjs devuelve Sante a whatsapp-web.js', () => {
        const script = `const r=require(${JSON.stringify(path.join(__dirname, '..', 'services', 'org-registry.js'))});` +
            `process.stdout.write(r.getOrgChannel(${JSON.stringify(SANTE_ORG)}));`;
        const out = execFileSync(process.execPath, ['-e', script], {
            env: { ...process.env, SANTE_CHANNEL: 'wwebjs' }, encoding: 'utf8',
        });
        assert.strictEqual(out.trim(), CHANNEL_WWEBJS);
    });
    check('un valor basura en SANTE_CHANNEL no apaga el canal (cae en 360dialog)', () => {
        const script = `const r=require(${JSON.stringify(path.join(__dirname, '..', 'services', 'org-registry.js'))});` +
            `process.stdout.write(r.getOrgChannel(${JSON.stringify(SANTE_ORG)}));`;
        const out = execFileSync(process.execPath, ['-e', script], {
            env: { ...process.env, SANTE_CHANNEL: 'siii' }, encoding: 'utf8',
        });
        assert.strictEqual(out.trim(), CHANNEL_360);
    });

    console.log('');
    if (fails.length) {
        console.error(`❌ ${fails.length} fallo(s):`);
        for (const f of fails) console.error(`   - ${f}`);
        process.exit(1);
    }
    console.log('✅ Enrutado de canal correcto: Sante solo por 360dialog, San Remo sin cambios.\n');
    process.exit(0);
})();
