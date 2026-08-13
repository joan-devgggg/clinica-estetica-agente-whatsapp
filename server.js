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
const { startAutoReturnWorker } = require('./services/auto-return');
const { startPauseWatchdog } = require('./services/bot-pause-alert');
const { startEsperaWatchdog } = require('./services/espera-alert');
const { startSeguimientoWorker } = require('./services/seguimiento');
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

// ─── Modo SOLO API ───────────────────────────────────────────────────────────
//
// Este proceso habla con la base de datos de PRODUCCIÓN. Levantarlo para mirar una pantalla
// del panel arrancaba también los clientes de WhatsApp, el bot de Telegram y los cuatro
// workers — y los workers ESCRIBEN solos: autoCompleteAppointments marca citas como
// completadas y sella importes, el de recordatorios manda WhatsApps, el de reseñas también.
// No dependen de `bot_activo`.
//
// El 07/08/2026 se levantó así durante 15 minutos para comprobar que /caja renderizaba. No
// escribió nada —Sante tenía el bot pausado y San Remo se quedó en el QR— pero fue suerte, no
// diseño.
//
// Qué apaga: lo AUTÓNOMO, o sea todo lo que escribe sin que nadie lo pida. La API REST sigue
// en pie, que es justo para lo que se levanta; si alguien la usa, escribe — pero eso ya es
// una acción deliberada, no un worker actuando por su cuenta.
//
// Por qué el flag APAGA en vez de encender: producción arranca con `pm2 start server.js` (ver
// CLAUDE.md) y un flag que hubiera que ACORDARSE de poner allí dejaría el salón sin
// recordatorios en silencio el día que se olvide. Lo que se hace en su lugar es que la ruta
// que uno teclea de memoria —`npm run dev`— ya venga con el flag puesto.
const SOLO_API = /^(1|true|yes|on)$/i.test(String(process.env.API_ONLY || ''));

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

// ─── Qué clase de proceso es este, dicho en voz alta ─────────────────────────
//
// El banner existe para que nadie se confíe: los dos modos hablan con la MISMA base de datos,
// y desde fuera se parecen. Sale por consola (que es lo que se mira al arrancar) y por el log
// (que es lo que se mira después, cuando hay que reconstruir qué pasó).
{
    const host = (process.env.SUPABASE_URL || '(sin SUPABASE_URL)').replace(/^https?:\/\//, '');
    if (SOLO_API) {
        console.log('\n┌──────────────────────────────────────────────────────────┐');
        console.log('│  MODO SOLO API — sin workers, sin WhatsApp, sin Telegram  │');
        console.log('│  Nada escribe por su cuenta. La API sí escribe si la usas.│');
        console.log(`└──  base de datos: ${host}`);
        console.log('');
    } else {
        console.log('\n┌──────────────────────────────────────────────────────────┐');
        console.log('│  ⚠️  WORKERS ACTIVOS — este proceso ESCRIBE por su cuenta  │');
        console.log('│  Recordatorios y reseñas mandan WhatsApps reales.         │');
        console.log('│  Para mirar el panel sin riesgo:  npm run dev             │');
        console.log(`└──  base de datos: ${host}`);
        console.log('');
    }
    logger.info('modo_proceso', {
        modo: SOLO_API ? 'solo_api' : 'workers_activos',
        workers: !SOLO_API, whatsapp: !SOLO_API, telegram: !SOLO_API,
        supabase: host,
    });
}

// ─── Webhook / API REST ──────────────────────────────────────────────────────
setWAClient(waClients, setConversationBotMode, setBotActivo);
setBotWAClient(waClients);
startWebhookServer(process.env.PORT || 3000);

// ─── Bot de Telegram (panel de administración multi-org) ─────────────────────
// También fuera en modo solo API: sus comandos escriben (pausar el bot, confirmar un bizum).
if (!SOLO_API) {
    startTelegramBot({
        getBotActivo: isBotActivo,
        setBotActivo: setBotActivo,
        waClients,
    });
}

// ─── Arrancar todos los clientes WA ──────────────────────────────────────────
// `new Client(...)` ya está hecho arriba y por sí solo no conecta nada: es `initialize()` el
// que abre el navegador y engancha el número. Por eso el Map se construye igual —webhook.js
// lo necesita para resolver el cliente saliente— y lo único que se salta es el arranque.
if (!SOLO_API) {
    for (const { client, slug, channel } of waClients.values()) {
        if (channel !== CHANNEL_WWEBJS) continue; // el cliente 360 no tiene sesión que iniciar
        console.log(`🔄 Iniciando WhatsApp para ${slug}...`);
        client.initialize();
    }
}

// ─── Workers (arrancan cuando el primer client esté ready) ───────────────────
let workersStarted = false;
function tryStartWorkers() {
    if (workersStarted) return;
    // La guarda va DENTRO y no en cada uno de los tres call sites de abajo: si mañana alguien
    // añade un cuarto disparador, hereda la protección sin acordarse de nada.
    if (SOLO_API) return;
    workersStarted = true;
    startReminderWorker(waClients);
    startReviewWorker(waClients);
    // No manda nada a nadie: solo devuelve al bot conversaciones que llevan días muertas en
    // manual. No depende de que ningún cliente de WhatsApp esté listo.
    startAutoReturnWorker(waClients);
    // Vigila que nadie deje el bot pausado media jornada. Mira el ESTADO, no el tráfico:
    // notePausedDrop solo salta cuando ya se ha tirado un mensaje de una clienta.
    startPauseWatchdog([...waClients.keys()]);
    // Y vigila lo contrario: el bot funcionando pero una clienta esperando igual, porque se
    // escaló y nadie la atendió o porque el turno se cayó. Es lo que faltaba para que un
    // fallo se descubra el mismo día y no leyendo conversaciones tres semanas después.
    startEsperaWatchdog([...waClients.keys()]);
    // La propuesta post-visita (hidratación tras unas mechas, matiz al mes). Es el ÚNICO
    // worker que empieza conversaciones en vez de continuarlas, así que nace apagado:
    // arranca, calcula la tanda y la deja en el log sin mandar nada. `SEGUIMIENTOS=on` es lo
    // único que lo enciende, y `npm run informe:seguimientos` enseña antes lo que saldría.
    startSeguimientoWorker(waClients);
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
