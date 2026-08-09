require('dotenv').config();
const { getChatbotResponse } = require('./services/ai');
const {
    saveLead, updateLead, findByPhone, saveMessage, saveAppointment, setContactJid,
    updateAppointment, setLeadBotMode, setEscalationReason, setBlacklist, createPendingAction, setContactTratamiento,
    getAgentConfig, updateContactLanguage, updateContactPreferredStylist, updateContactLastStylist,
    getStylistsByOrg, getAllStylistSchedules, getLastCompletedAppointment, hasActiveAppointmentForSlot,
    getScheduleBlocks, getBlockedDays, getAppointmentsByLead, getAppointmentById, getUpcomingAppointments,
    findContactIdsByPhone, getAppointmentsByStylistAndRange, getRecentBroadcastSendAt,
} = require('./services/db');
const { toLocalDateStr, toLocalTimeStr } = require('./services/date-utils');
const { applyDatePreference } = require('./services/date-preference');
const calendar = require('./services/calendar');
const calendarSante = require('./services/calendar-sante');
const { detectIntent, getMissingFields, extractQuickData, extractQuickDataSante, hasApellido, extractServiceFromText, extractServiceCategoriesFromText, extractAnchorConstraint, buildFullServiceName, humanizeLargoLabel, extractStylistFromText, resolveStylistMention, isAffirmative, normalizeText, wantsAnotherBooking, wantsRestart, detectGuestBooking, extractGuestName, isValidName, isServiceName, extractNameAfterIntro, detectLanguage, IDIOMAS_SOPORTADOS, matchUpsellRule, resolveServiceDurationMin, resolveAppointmentDurationMin, computeAmpliacionEndsAt, DURACION_CITA_FALLBACK_MIN, resolveK18ComplementIfNeeded, resolveK18ServiceFromText, resolveServiceCatalogEntry, shouldDiscardUpsellForClosing, buildSanteConfirmationMessage, buildCitaFantasmaMsg, isSpaPromoCategory, hasPreviousSpaOrMassage, buildSpaPromoNote, detectLargoCategory, extractLargoPelo, classifyLargoVariant, extractMechasClasicasTipo, detectCorteGenerico, detectCorteGenero, detectCorteMujerTipo, detectCorteNinoTipo, detectConsultaService, detectConsultaValoracion, detectHairProblemDescription, namesConcreteService, isReactiveOnlyService, isServiceActive, offerableCatalog, detectNoPreferenceSignal, detectNoStylistPreference, HORA_HHMM_SRC, extractMentionedHours, detectHoraFueraDeHorario, detectTratamiento, classifyIncomingMedia, unsupportedMediaMsg, buildCyrillicRe, isNegative, detectAppointmentQuery, detectExistingAppointmentReference, extractCitaPistas, detectCancelRequest, detectRescheduleRequest, buildCitasVivasMsg, buildCancelConfirmMsg, buildElegirCitaMsg, buildCancelFalloMsg, buildAmpliacionSolapaMsg } = require('./services/helpers');
const { incrementMetric } = require('./services/metrics');
const { transcribeAudio } = require('./services/transcription');
const { loadClient, saveClient, saveSummary, deleteClient } = require('./services/memory');
const { notePausedDrop, resetPauseAlert } = require('./services/bot-pause-alert');
const { noteSendResult } = require('./services/channel-health');
const { summarizeHistory } = require('./services/providers/openai');
const { notifyBizumPending, notifyEscalation, notifyBlacklistAlert } = require('./services/telegram');
const { getOrgType, getOrgChannel, CHANNEL_WWEBJS } = require('./services/org-registry');
const config = require('./config.json');
const logger = require('./lib/logger');

// ─── Detección de mensajes fallback que nunca debieron entrar en history ──────
// Patrones conocidos de respuestas de error del LLM (pre-fix) que contaminaban
// el contexto del LLM y causaban bucles de "Perdona". Se usan para limpiar
// sesiones viejas al cargar de SQLite y para filtrar antes de enviar al LLM.
const FALLBACK_PATTERNS = [
    'perdona, no he podido procesar',
    'se me ha ido la conexión',
    'se me ha ido la conexion',
    "sorry, i couldn't process",
    "i couldn't process that",
    'извини, не удалось обработать',
    'вибач, не вдалося обробити',
    'lo siento, ha ocurrido un error técnico',
    'lo siento, ha ocurrido un error tecnico',
    'lo siento, ha habido un error',
    'un momento, por favor',
    'las extensiones se presupuestan según el caso',
    'las extensiones se presupuestan segun el caso',
    'te pongo en contacto con el salón',
    'te pongo en contacto con el salon',
    'en breve una de nuestras especialistas se pondrá en contacto',
    'en breve una de nuestras especialistas se pondra en contacto',
    '¿quieres que te ponga en contacto con una de nuestras especialistas?',
    'quieres que te ponga en contacto con una de nuestras especialistas',
];
function isFallbackText(text) {
    if (!text || typeof text !== 'string') return false;
    const lower = text.toLowerCase();
    return FALLBACK_PATTERNS.some(p => lower.includes(p));
}

// ─── Constantes ───────────────────────────────────────────────────────────────
const userSessions = new Map();
const messageBuffers = new Map(); // sKey → { texts, messageKeys, timer, state, ... }
const BUFFER_DELAY_MS = 5000;

const SESSION_TIMEOUT = config.conversation?.sessionTimeoutMs || 3600000;
const ABANDON_THRESHOLD_MS = config.conversation?.abandonThresholdMs || 1800000;
const DEDUPE_TTL_MS = 60000;
const BUFFER_CLEANUP_TTL_MS = 60000;
const GC_INTERVAL_MS = 3600000;
const MESSAGE_DELAY_MS_PER_CHAR = 2;
const MESSAGE_DELAY_MAX_MS = 120;
const MAX_USER_MESSAGE_LENGTH = 500;
const SUMMARY_THRESHOLD = 20;

// Estado del bot POR organización. Multi-tenant: pausar Sante no debe afectar a San
// Remo (cada org es independiente). Por defecto activo cuando no hay valor cargado.
const _botActivoByOrg = new Map(); // orgId → bool
function isBotActivo(orgId) {
    return _botActivoByOrg.has(orgId) ? _botActivoByOrg.get(orgId) : true;
}
// persist=false → solo actualiza el estado en memoria (p.ej. al cargar config al
// arrancar, o cuando el panel ya escribió en config antes de avisar al proceso).
//
// DEVUELVE una promesa que **resuelve a un booleano y NUNCA rechaza**: `true` si el estado
// quedó también guardado en `config`, `false` si solo está en memoria. Esa forma rara tiene
// dos motivos, y los dos son call sites reales:
//
//   · Quien PUEDE esperar (el handler de Telegram) necesita saber si se guardó, para no
//     decirle al admin "Bot pausado" sobre una escritura que no ocurrió.
//   · Quien NO puede (server.js al arrancar, webhook.js tras escribir el panel) la ignora, y
//     una promesa que rechazara sin manejar tumbaría el proceso — o sea el bot de las dos
//     orgs. Por eso el error se convierte aquí en `false` y no se propaga.
//
// El estado en MEMORIA se aplica SIEMPRE, guarde o no: que no se pueda apuntar no puede
// impedir que el bot se calle ya, que es lo que se le ha pedido.
function setBotActivo(orgId, v, persist = true) {
    _botActivoByOrg.set(orgId, !!v);
    // Al REACTIVAR limpiamos el throttle del aviso: si se vuelve a pausar, el siguiente
    // mensaje descartado debe avisar ya, no esperar a que caduque la ventana anterior.
    if (v) resetPauseAlert(orgId);
    if (!persist) return Promise.resolve(true);   // no había nada que guardar: nada divergió

    const { setConfigValue } = require('./services/db');
    return setConfigValue(orgId, 'bot_activo', !!v)
        .then(() => true)
        .catch(e => {
            // Nivel ERROR porque el fallo no es cosmético: el estado en memoria queda como se
            // pidió (el bot calla ahora mismo), pero el de BD no, y `server.js` recarga
            // `bot_activo` de `config` al arrancar — el primer reinicio o despliegue **revive
            // el bot que alguien había pausado** y vuelve a contestar a clientas silenciadas.
            logger.error('bot_activo_no_persistido', {
                orgId, valor: !!v, error: e.message,
                nota: 'queda aplicado en memoria; un reinicio lo revierte',
            });
            return false;
        });
}

// ── Compatibilidad con la API "global" anterior (callers sin orgId). NO usar en
// código nuevo: pasar siempre orgId para mantener el aislamiento por organización.
function isBotGlobalActivo(orgId) {
    if (orgId !== undefined) return isBotActivo(orgId);
    if (_botActivoByOrg.size === 0) return true; // por defecto activo
    for (const v of _botActivoByOrg.values()) if (v) return true;
    return false;
}
function setBotGlobalActivo(v, orgId) {
    if (orgId !== undefined) return setBotActivo(orgId, v);
    const { getAllOrgs } = require('./services/org-registry');
    for (const o of getAllOrgs()) setBotActivo(o.orgId, v);
}

let _waClients = null; // Map<orgId, { client, ... }>
function setWAClient(clients) { _waClients = clients; }

function getClientForOrg(orgId) {
    if (!_waClients) return null;
    if (_waClients instanceof Map) return _waClients.get(orgId)?.client || null;
    return _waClients; // backward compat: single client
}

// ─── TTL Dedupe ───────────────────────────────────────────────────────────────
class TTLMessageDedupe {
    constructor(ttlMs = 60000) { this.seen = new Map(); this.ttlMs = ttlMs; }
    has(key) {
        if (!key) return false;
        const ts = this.seen.get(key);
        if (!ts) return false;
        if (Date.now() - ts > this.ttlMs) { this.seen.delete(key); return false; }
        return true;
    }
    add(key) {
        if (!key) return;
        this.seen.set(key, Date.now());
        setTimeout(() => this.seen.delete(key), this.ttlMs);
    }
    cleanup() {
        const now = Date.now();
        for (const [k, ts] of this.seen) if (now - ts > this.ttlMs) this.seen.delete(k);
    }
}

// ─── LID resolution ─────────────────────────────────────────────────────────
function isLidJid(jid) {
    return typeof jid === 'string' && jid.endsWith('@lid');
}

function extractPhoneFromJid(jid) {
    if (!jid) return '';
    if (isLidJid(jid)) return '';
    return jid.replace('@c.us', '').replace(/\D/g, '');
}

async function resolvePhoneFromMessage(message) {
    const from = message.from;
    if (!from) return { phone: '', jid: from, isLid: false };

    if (!isLidJid(from)) {
        return {
            phone: from.replace('@c.us', '').replace(/\D/g, ''),
            jid: from,
            isLid: false,
        };
    }

    try {
        const contact = await message.getContact();
        if (contact?.number) {
            const phone = String(contact.number).replace(/\D/g, '');
            if (phone) return { phone, jid: from, isLid: true };
        }
    } catch (e) {
        logger.warn('lid_contact_resolve_failed', { from, error: e.message });
    }

    return {
        phone: from.replace('@lid', '').replace(/\D/g, ''),
        jid: from,
        isLid: true,
    };
}

// ─── Sesión ───────────────────────────────────────────────────────────────────
function createEmptySession(userId, orgId, resolvedPhone) {
    const telefono = resolvedPhone || userId.replace('@c.us', '').replace(/\D/g, '');
    const orgType = getOrgType(orgId);
    return {
        orgId,
        orgType,
        history: [],
        summary: null,
        lastUpdate: Date.now(),
        lastMessageTime: 0,
        messageCount: 0,
        botActivo: true,
        originalJid: userId,
        partialData: { telefono },
        seenMessages: new TTLMessageDedupe(DEDUPE_TTL_MS),
        reservaConfirmada: false,
        appointmentId: null,
        availableSlots: [],
        currentSlotIndex: 0,
        leadGuardado: false,
        leadId: null,
        leadStatus: 'in_progress',
        modoReagendamiento: false,
        reagendarAppointmentId: null,
        clienteRecurrente: false,
        ultimaVisita: null,
        startTime: Date.now(),
        _summarizing: false,
        isBlacklisted: false,
        blacklistNotified: false,
        // San Remo specific
        bizumAsked: false,
        bizumPendiente: false,
        // Sante specific
        lastStylist: null,
        language: null,
        selectedService: null,
        selectedStylist: null,
        selectedCategory: null,
        anyStylists: false,
        prefiereMasCercano: false,
        slotsProposed: false,
        proposedSlots: [],
        askDatePreferenceFirst: false,
        datePreferenceAsked: false,
        stylistQuestionAsked: false,
        stylistQuestionPending: false,
        upsellingSuggested: false,
        upsellingAccepted: [],
        _lastUpsellSuggestion: null,
        preferredStylistId: null,
        ultimoServicio: null,
        ultimaEstilista: null,
        // Hair-length variant flow
        pendingLargoCategory: null,
        largoPelo: null,
        // Corte gender/type sub-flow (deterministic resolution across turns)
        pendingCorteGenero: false,
        pendingCorteMujerTipo: false,
        pendingCorteNinoTipo: false,
        // Escalation confirmation (extensiones / permanente / eliminación del pigmento)
        pendingEscalation: false,
        pendingEscalationService: null,
        // Trato que ha pedido la clienta ('formal' | 'informal'). null = no consta, y el bot
        // sigue con su registro por defecto: null NO significa "de tú".
        tratamiento: null,
        // Segunda reserva en la misma conversación (para un acompañante)
        guestBooking: false,
        guestName: null,
        // Segunda reserva: categoría pedida sin resolver aún y ancla temporal respecto a
        // la cita ya reservada ("un masaje ANTES de la pedicura").
        pendingServiceCategory: null,
        anchorAppointment: null,
        anchorFilterVacio: false,
        // Consulta de valoración: categoría reactiva y rescate del bucle "no sé qué
        // servicio quieres" (ver SERVICE_STATE_DEFAULTS).
        consultaValoracionDetectada: false,
        sinServicioStreak: 0,
        consultaOfrecida: false,
        rangoTratamientosOfrecido: false,
        // Avisos de mención de estilista (ver SERVICE_STATE_DEFAULTS)
        stylistMentionUnknown: null,
        stylistMentionCorrected: null,
        stylistMentionNoSkill: null,
        stylistMentionRejected: null,
        // Citas que ya existen (ver SERVICE_STATE_DEFAULTS)
        citaEnCurso: null,
        pendingCitaAccion: null,
        // Nombre antes de reservar (ver SERVICE_STATE_DEFAULTS)
        pendingNameForBooking: null,
        preguntasCierre: 0,
        // Promo 10% 1ª visita Spa Hair / Masajes: se menciona una sola vez por
        // conversación (no se limpia en clearServiceState a propósito).
        spaPromoOffered: false,
        spaPromoNote: null,
        // Marca el inicio de la conversación activa — el LLM solo ve mensajes posteriores
        conversationStartedAt: Date.now(),
    };
}

// ─── Session key includes orgId ──────────────────────────────────────────────
function sessionKey(orgId, userPhone) { return `${orgId}:${userPhone}`; }

// ─── Utilidades ───────────────────────────────────────────────────────────────
function getMessageKey(msg) {
    return msg?.id?._serialized || msg?.key?.id || msg?.id?.id || null;
}

/**
 * Id que devuelve el proveedor al ENVIAR, para guardarlo en `messages.wa_message_id`.
 *
 * Las dos formas son distintas y las dos son válidas: whatsapp-web.js devuelve el objeto
 * Message (`id._serialized`), y Cloud API el JSON de la respuesta
 * (`{ messages: [{ id: 'wamid…' }] }`). Sin id, la fila se guarda igual: es un dato para
 * poder correlacionar después, no un requisito para registrar el mensaje.
 */
function extractSentMessageId(result) {
    if (!result || typeof result !== 'object') return null;
    return result.id?._serialized
        || result.id?.id
        || (Array.isArray(result.messages) ? (result.messages[0]?.id || null) : null)
        || null;
}

/** Payload crudo del proveedor, si lo hay. Hoy solo lo trae el adapter de Cloud API. */
function rawFromProvider(msg) {
    return msg?._cloud?.valueMessage || null;
}

function sanitizeUserMessage(text) {
    if (!text || typeof text !== 'string') return '';
    let s = text.slice(0, MAX_USER_MESSAGE_LENGTH);
    [/ignore\s+(all\s+)?previous\s+instructions?/gi,
     /ignora\s+(todas?\s+las?\s+)?instrucciones?\s+anteriores?/gi,
     /olvida\s+(todo\s+lo\s+)?anterior/gi,
     /\[SYSTEM\]/gi, /\[INST\]/gi].forEach(p => s = s.replace(p, '[filtrado]'));
    return s.trim();
}

function stripMarkdown(text) {
    if (!text) return text;
    return text
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/_(.+?)_/g, '$1')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/`(.+?)`/g, '$1');
}

// "Додай" (uk, «añádelo») aceptando un upsell. Va por buildCyrillicRe porque la й se
// descompone al normalizar: escrito a mano no casaba nunca y el K18 o la manicura ofrecidos
// a una clienta ucraniana no se añadían a la cita aunque dijera que sí.
const UK_ANADE_RE = buildCyrillicRe(['додай']);

function isUpsellingAcceptance(text) {
    if (!text || typeof text !== 'string') return false;
    const t = normalizeText(text).trim();
    const patterns = [
        /^s[ií]$/i, /^vale$/i, /^dale$/i, /^ok$/i, /^okey$/i, /^genial$/i, /^perfecto$/i,
        /^bueno$/i, /^claro$/i, /^por supuesto$/i, /^venga$/i,
        /a[nñ][aá]d(e|elo|emelo)/i, /me lo (a[nñ]ades|pones)/i, /me apunto/i,
        /s[ií].*por favor/i, /s[ií].*a[nñ]ade/i,
        /^yes$/i, /^yeah$/i, /^yep$/i, /^sure$/i, /^please$/i, /^go ahead$/i, /add it/i,
        /^[дД][аА]$/i, /^[кК]онечно$/i, /[дД]обавь/i, /^[хХ]орошо$/i,
        /^[тТ]ак$/i, UK_ANADE_RE,
    ];
    return patterns.some(p => p.test(t));
}

// Compara dos nombres de servicio de forma tolerante (normaliza acentos/caso/guiones y admite
// que uno sea prefijo/subcadena del otro, p.ej. "K18" vs "Tratamiento K18"). También hace
// matching por token: si cualquier palabra distintiva (≥5 chars) de un lado aparece en el
// otro, se considera match. Esto cubre "Pro Miracle Repair TEMPTING" vs sugerencia config
// "reconstrucción molecular k18 o pro-miracle" donde el guion impedía el match exacto.
function matchesServiceName(a, b) {
    const na = normalizeText(a || '').replace(/-/g, ' ');
    const nb = normalizeText(b || '').replace(/-/g, ' ');
    if (!na || !nb) return false;
    if (na === nb || na.includes(nb) || nb.includes(na)) return true;
    // Comparación SIN separadores internos (guion o espacio): "k-18"/"k 18" ≡ "k18". Cubre
    // los códigos cortos del catálogo (K18) que la clienta escribe con guion/espacio y que
    // normalizeText no unifica. Se exige nombre de referencia ≥3 chars sin separadores para
    // no casar por fragmentos triviales.
    const sa = na.replace(/[\s-]/g, '');
    const sb = nb.replace(/[\s-]/g, '');
    if (sb.length >= 3 && (sa === sb || sa.includes(sb) || sb.includes(sa))) return true;
    // Token-level: any distinctive word (≥5 chars) from one side found in the other
    const tokensB = nb.split(/\s+/).filter(w => w.length >= 5);
    if (tokensB.some(w => na.includes(w))) return true;
    const tokensA = na.split(/\s+/).filter(w => w.length >= 5);
    return tokensA.some(w => nb.includes(w));
}

// Errores transitorios de Puppeteer/whatsapp-web.js: el frame del navegador de WhatsApp Web
// se "desadjunta" momentáneamente (re-render de la sesión) y el siguiente intento suele
// funcionar. NO incluimos "protocol error" / "not connected" aquí: esos indican desconexión
// real y se tratan aparte (no tiene sentido reintentar).
const TRANSIENT_WA_ERRORS = ['detached frame', 'execution context was destroyed', 'target closed', 'session closed', 'most likely the page has been closed'];
function isTransientWAError(err) {
    const m = String(err?.message || err || '').toLowerCase();
    return TRANSIENT_WA_ERRORS.some(p => m.includes(p));
}

// Envía un mensaje reintentando ante errores transitorios de frame (bug 7). El frame de
// puppeteer puede tardar varios SEGUNDOS en re-adjuntarse (recarga/reconexión de WA Web),
// así que usamos backoff creciente (0.8s, 1.6s, 2.4s) y, antes de cada reintento, "calentamos"
// el chat con getChatById para forzar que el frame del chat esté cargado (igual que el path
// del bot, que no sufre este error porque envía justo tras recibir un mensaje de ese chat).
// `orgId` es opcional y solo alimenta la salud del canal (services/channel-health.js): el
// resultado se reporta UNA vez por envío lógico, fuera del bucle, no una por reintento —
// si no, un solo envío fallido contaría como tres y dispararía el aviso de canal caído él
// solo. Quien no lo pase sigue funcionando igual, sin observación.
async function waSendMessage(client, jid, text, { retries = 3, baseDelayMs = 800, orgId = null } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            if (i > 0) { try { await client.getChatById(jid); } catch { /* warm-up best-effort */ } }
            const enviado = await client.sendMessage(jid, text);
            // Se espera: noteSendResult manda el aviso de canal caído/recuperado por Telegram.
            if (orgId) await noteSendResult(orgId, { ok: true });
            return enviado;
        } catch (e) {
            lastErr = e;
            if (!isTransientWAError(e) || i === retries) {
                if (orgId) await noteSendResult(orgId, { ok: false, error: e, contexto: `envío a ${jid}` });
                throw e;
            }
            await new Promise(r => setTimeout(r, baseDelayMs * (i + 1)));
        }
    }
    if (orgId) await noteSendResult(orgId, { ok: false, error: lastErr, contexto: `envío a ${jid}` });
    throw lastErr;
}

async function sendWithDelay(client, phone, text, orgId, dbPhone) {
    if (!text?.trim()) return;
    const delay = Math.min(text.length * MESSAGE_DELAY_MS_PER_CHAR, MESSAGE_DELAY_MAX_MS);
    try {
        await (await client.getChatById(phone)).sendStateTyping();
        if (delay > 100) await new Promise(r => setTimeout(r, delay));
    } catch { /* sendStateTyping es best-effort: si el frame falla, seguimos al envío */ }
    // orgId: las respuestas del bot son el grueso de lo que sale, así que son la señal más
    // temprana de que el canal está caído. Los bloqueos de 360dialog del 1-2/08/2026 se
    // manifestaron exactamente aquí — entrando mensajes y sin salir ninguno.
    const enviado = await waSendMessage(client, phone, text, { orgId });
    const phoneForDb = dbPhone || extractPhoneFromJid(phone);
    if (phoneForDb) saveMessage(orgId, {
        telefono: phoneForDb, contenido: text, direccion: 'saliente',
        waMessageId: extractSentMessageId(enviado),
    }).catch(() => {});
}

async function sendDirectMessage(orgId, userPhone, text) {
    const client = getClientForOrg(orgId);
    if (!client) {
        logger.warn('wa_client_no_disponible', { orgId, telefono: userPhone });
        return;
    }
    try { await sendWithDelay(client, userPhone, text, orgId); } catch (e) { logger.error('error_send_direct', { error: e.message }); }
}

// ─── Slots ───────────────────────────────────────────────────────────────────
// Una estilista solo es válida para un servicio si tiene la skill de su categoría.
// Evita asignar, p.ej., a Veronika para un masaje (que solo hace Larisa): si la
// clienta la nombra pero no es elegible, la ignoramos y el motor elige una válida.
function stylistCanDoService(stylist, service) {
    if (!service?.categoria) return true; // sin servicio aún → no podemos filtrar
    const skills = Array.isArray(stylist?.skills) ? stylist.skills : [];
    return skills.some(s => String(s).toLowerCase() === String(service.categoria).toLowerCase());
}

async function loadAvailableSlots(session) {
    const orgId = session.orgId;
    // Marca de que el motor de huecos SÍ se ha consultado en este turno. La red
    // anti-escalada-falsa la exige antes de dejar escalar por "error_tecnico": un
    // availableSlots vacío porque nunca preguntamos no es un fallo del sistema.
    session._slotsQueriedThisTurn = true;
    // Cada consulta parte de cero: un fallo de BD del turno anterior no debe seguir
    // marcando la sesión cuando la lectura vuelve a funcionar.
    session.slotsDbError = false;
    session.slotsCausaCero = null;
    try {
        if (session.orgType === 'salon') {
            // INVARIANTE A (defensivo): garantizar que selectedService es el objeto
            // COMPLETO del catálogo (con categoria + duracion) antes de calcular huecos.
            // En la práctica ya lo es, pero si alguna ruta futura asigna un objeto parcial
            // (p.ej. solo { nombre }), lo re-resolvemos para no perder categoria/duracion,
            // que son las que filtran estilistas y dimensionan la ventana libre.
            if (session.selectedService && (!session.selectedService.categoria || !session.selectedService.duracion)) {
                const cfgFull = await getAgentConfig(orgId);
                const catFull = cfgFull?.services || [];
                const nombreSel = normalizeText(session.selectedService.nombre || '');
                const catSel = normalizeText(session.selectedService.categoria || '');
                // Desambiguar: cuando hay varios servicios con el mismo nombre (p.ej.
                // "Largo 3" en Alisado/Anti-encrespamiento/Deco/Mechas Airtouch) NO coger
                // el primero a ciegas. Intentamos, en orden:
                //   1. Nombre + categoría ya conocida (catSel del objeto parcial)
                //   2. Nombre + categoría de la sesión (partialData.categoria_servicio)
                //   3. Solo si hay UN único match por nombre → coge ese
                //   4. Fallback: extractServiceFromText (que desambigua por contexto)
                const matches = catFull.filter(s => normalizeText(s.nombre) === nombreSel);
                const catSesion = normalizeText(session.partialData?.categoria_servicio || '');
                let full = null;
                if (matches.length === 1) {
                    full = matches[0];
                } else if (matches.length > 1) {
                    full = (catSel && matches.find(s => normalizeText(s.categoria) === catSel))
                        || (catSesion && matches.find(s => normalizeText(s.categoria) === catSesion))
                        || null;
                }
                if (!full && session.selectedService.nombre) {
                    full = extractServiceFromText(session.selectedService.nombre, catFull);
                }
                if (full) {
                    logger.info('selectedService_completado', { orgId, antes: session.selectedService.nombre, categoria: full.categoria, duracion: full.duracion });
                    session.selectedService = full;
                } else {
                    logger.warn('selectedService_incompleto_sin_match', { orgId, servicio: session.selectedService.nombre || null });
                }
            }
            const service = session.selectedService;
            const cfgSlots = await getAgentConfig(orgId);
            const catalogSlots = cfgSlots?.services || [];
            let upsellingDuration = 0;
            if (session.upsellingAccepted?.length) {
                upsellingDuration = session.upsellingAccepted.reduce(
                    (sum, name) => sum + resolveServiceDurationMin(name, catalogSlots), 0);
            }
            // La duración con la que se BUSCA el hueco y la que se ESCRIBE en ends_at
            // (finalizarCitaSante) tienen que salir del MISMO sitio. Cuando divergían, el
            // bot buscaba sitio para una hora y guardaba seis: el hueco encajaba en la
            // propuesta y pisaba la cita siguiente al escribirse. Por eso las dos pasan
            // ahora por resolveAppointmentDurationMin.
            const durBusqueda = resolveAppointmentDurationMin(service, catalogSlots);
            const serviceDuration = durBusqueda.minutos + upsellingDuration;
            // Buscar con una duración adivinada ofrece huecos que quizá no existen. No
            // bloquea la búsqueda —sin propuesta no hay conversación— pero deja de ser mudo.
            if (service && !durBusqueda.resuelto) {
                logger.warn('duracion_busqueda_no_resuelta', {
                    orgId, servicio: service.nombre || null, categoria: service.categoria || null,
                    minutosAsumidos: durBusqueda.minutos,
                });
            }
            const slots = await calendarSante.getAvailableSlots(orgId, {
                serviceDuration,
                serviceCategory: service?.categoria,
                preferredStylistId: session.anyStylists ? null : (session.selectedStylist?.id || session.preferredStylistId),
                preferencia: session.partialData.preferencia_horaria || {},
            });
            session.availableSlots = slots;

            // Diagnóstico: 0 huecos con servicio ya resuelto. El motor de huecos es correcto
            // y TZ-independiente, así que un 0 aquí casi siempre viene de los PARÁMETROS
            // (categoría/duración/estilista/preferencia extraída por el LLM), no del cálculo.
            // Registramos las entradas exactas para poder cerrar el disparador si reaparece.
            if (slots.length === 0 && service) {
                logger.warn('sante_cero_huecos', {
                    orgId,
                    causa: slots.causa || null,
                    servicio: service.nombre || null,
                    serviceCategory: service.categoria || null,
                    serviceDuration,
                    duracionResuelta: durBusqueda.resuelto,
                    preferredStylistId: session.anyStylists ? null : (session.selectedStylist?.id || session.preferredStylistId || null),
                    anyStylists: !!session.anyStylists,
                    preferencia: session.partialData.preferencia_horaria || {},
                });
            }
            // Por qué el motor devolvió cero (agenda_llena / no_cabe_antes_del_cierre /
            // sin_horario / sin_skill / sin_estilistas), o null si sí hay huecos. Permite
            // decirle la verdad a la clienta en vez del genérico que el LLM lee como avería.
            session.slotsCausaCero = slots.causa || null;
            // Si el día concreto pedido no tenía disponibilidad real, calendar-sante
            // devuelve los huecos más cercanos y marca esta bandera para que el LLM
            // avise a la clienta en vez de afirmar que el día pedido está libre.
            session.slotsRequestedDayUnavailable = !!slots.requestedDayUnavailable;
            // Ídem con la SEMANA: si la ventana pedida se agotó (un viernes/sábado "esta
            // semana" deja 1-2 días) o no tenía huecos, estos caen fuera de ella y hay que
            // decirlo, no proponer otra semana en silencio.
            session.slotsWeekPreferenceRelaxed = !!slots.weekPreferenceRelaxed;

            // Si solo hay una estilista posible para el servicio (p.ej. masajes → Larisa),
            // asígnala automáticamente y sáltate la pregunta de preferencia. Así el flujo
            // avanza directo a proponer huecos en vez de quedarse atascado pidiendo estilista.
            // La asignación pasa por la única autoridad (assignStylistIfAppropriate): con
            // anyStylists activo no colapsamos a una, respetando la búsqueda combinada.
            if (!session.selectedStylist && !session.anyStylists && slots.length > 0) {
                const distinctStylists = [...new Set(slots.map(s => s.stylistId))];
                if (distinctStylists.length === 1) {
                    assignStylistIfAppropriate(session, [{ id: slots[0].stylistId, name: slots[0].stylistName }]);
                }
            }
            // "Un masaje ANTES de la pedicura de las 16:00": único punto donde se recortan
            // los huecos a la ventana pedida. No inventa nada — filtra huecos ya reales.
            applyAnchorFilter(session, serviceDuration);
        } else {
            const pref = session.partialData.preferencia_horaria || {};
            const slots = await calendar.getAvailableSlots(pref);
            session.availableSlots = slots.map(s => ({ ...s, texto: calendar.formatSlotForMessage(s) }));
        }
        session.currentSlotIndex = 0;
    } catch (e) {
        // Desde el arreglo de db.js (assertRead), un fallo de Supabase LLEGA aquí como
        // excepción en vez de disfrazarse de "[] huecos". Se marca para que la escalada por
        // error_tecnico sea verdad cuando la haya, y mentira nunca.
        logger.error('error_slots', { orgId, error: e.message });
        session.availableSlots = [];
        session.slotsCausaCero = null;
        session.slotsDbError = true;
    }
}

// ─── Reload DIRIGIDO para verificar un hueco al confirmar (salon) ────────────
// Consulta los huecos REALES de un día + estilista concretos, IGNORANDO la
// preferencia previa (periodo/semana) que estrecha la búsqueda. Sirve para
// verificar, al confirmar, que el hueco que la clienta eligió sigue libre en el
// calendario real — sin que un `availableSlots=0` provocado por un filtro estrecho
// (p.ej. "esta semana por la mañana") lo bloquee falsamente. No muta la sesión.
async function reloadSlotsForConfirmation(session, { fecha, stylistId }) {
    const orgId = session.orgId;
    try {
        const service = session.selectedService;
        const cfgSlots = await getAgentConfig(orgId);
        const catalogSlots = cfgSlots?.services || [];
        let upsellingDuration = 0;
        if (session.upsellingAccepted?.length) {
            upsellingDuration = session.upsellingAccepted.reduce(
                (sum, name) => sum + resolveServiceDurationMin(name, catalogSlots), 0);
        }
        // MISMA duración que en la propuesta y que en la escritura: esta recarga decide si
        // el hueco elegido "sigue libre", así que medir distinto aquí es contestar a otra
        // pregunta — y la respuesta se usa para reservar.
        const durBusqueda = resolveAppointmentDurationMin(service, catalogSlots);
        // Preservamos `asap` (reserva mismo día): sin él, getAvailableSlots arranca
        // mañana y no encontraría un hueco de hoy, dando un falso "ocupado".
        const asap = !!session.partialData?.preferencia_horaria?.asap;
        const pref = {};
        if (fecha) pref.fecha = fecha;
        if (asap) pref.asap = true;
        const slots = await calendarSante.getAvailableSlots(orgId, {
            serviceDuration: durBusqueda.minutos + upsellingDuration,
            serviceCategory: service?.categoria,
            preferredStylistId: stylistId || session.selectedStylist?.id || session.preferredStylistId,
            preferencia: pref,
        });
        return Array.isArray(slots) ? slots : [];
    } catch (e) {
        logger.error('error_reload_confirmacion', { orgId, error: e.message });
        return [];
    }
}

// ─── Persistencia SQLite ──────────────────────────────────────────────────────
// El estado del salón (servicio/estilista elegidos, idioma, upselling) no cabe en
// partialData y se pierde al recargar la sesión tras un reinicio/timeout. Lo volcamos
// en session.extra para que memory.js lo persista; los huecos se recalculan al volver.
function buildSessionExtra(session) {
    const base = { conversationStartedAt: session.conversationStartedAt || null };
    if (session.orgType !== 'salon') return base;
    return {
        ...base,
        selectedService:   session.selectedService || null,
        selectedStylist:   session.selectedStylist || null,
        language:          session.language || null,
        // Viaja junto al idioma, no puede quedarse atrás: un idioma rehidratado sin su fuente
        // se lee como 'default' y el bot deja de fiarse de algo que sí se había observado.
        languageSource:    session.languageSource || null,
        // Igual que el idioma: si no viaja a SQLite, una sesión rehidratada vuelve a tutear
        // a quien pidió que la trataran de usted. Es la lección de session.leadId.
        tratamiento:       session.tratamiento || null,
        upsellingAccepted: session.upsellingAccepted || [],
        upsellingSuggested: !!session.upsellingSuggested,
        preferredStylistId: session.preferredStylistId || null,
        currentSlotIndex:  session.currentSlotIndex || 0,
        slotsProposed:     !!session.slotsProposed,
        guestBooking:      !!session.guestBooking,
        guestName:         session.guestName || null,
        bookedSlots:       Array.isArray(session.bookedSlots) ? session.bookedSlots : [],
        pendingLargoCategory: session.pendingLargoCategory || null,
        largoPelo:         session.largoPelo || null,
        pendingCorteGenero: !!session.pendingCorteGenero,
        pendingCorteMujerTipo: !!session.pendingCorteMujerTipo,
        pendingCorteNinoTipo: !!session.pendingCorteNinoTipo,
        lastUpsellSuggestion: session._lastUpsellSuggestion || null,
        pendingEscalation: !!session.pendingEscalation,
        pendingEscalationService: session.pendingEscalationService || null,
        proposedSlots: Array.isArray(session.proposedSlots) ? session.proposedSlots : [],
        spaPromoOffered:   !!session.spaPromoOffered,
        spaPromoNote:      session.spaPromoNote || null,
        // Segunda reserva encadenada: la desambiguación de categoría y el ancla ocupan
        // varios turnos, así que tienen que sobrevivir a una recarga desde SQLite.
        pendingServiceCategory: session.pendingServiceCategory || null,
        anchorAppointment: session.anchorAppointment || null,
        // Cita existente en juego y acción a la espera de respuesta: ambas cruzan turnos y
        // tienen que sobrevivir a un timeout de sesión. Con pendingCitaAccion perdido, el "sí"
        // del turno siguiente caería en el flujo de reserva.
        citaEnCurso: session.citaEnCurso || null,
        pendingCitaAccion: session.pendingCitaAccion || null,
        // La reserva en espera del nombre cruza turnos por definición: si no sobrevive a una
        // recarga, la clienta contesta su nombre al vacío y la cita no se guarda jamás.
        pendingNameForBooking: session.pendingNameForBooking || null,
        preguntasCierre: session.preguntasCierre || 0,
    };
}

function persistSession(orgId, userPhone, session) {
    try {
        session.extra = buildSessionExtra(session);
        saveClient(orgId, userPhone, session);
    } catch (e) { logger.error('sqlite_save_error', { error: e.message }); }
}

function triggerAsyncSummary(orgId, userPhone, session) {
    if (session._summarizing || session.history.length <= SUMMARY_THRESHOLD) return;
    session._summarizing = true;
    const toSummarize = session.history.slice(0, -10);
    summarizeHistory(toSummarize, session.partialData)
        .then(summary => {
            if (summary) {
                session.summary = summary;
                session.history = session.history.slice(-10);
                saveSummary(orgId, userPhone, summary);
                persistSession(orgId, userPhone, session);
                logger.info('historial_comprimido', { orgId, telefono: userPhone });
            }
        })
        .catch(e => logger.error('error_resumen', { telefono: userPhone, error: e.message }))
        .finally(() => { session._summarizing = false; });
}

// ─── Escalada real: fila en pending_actions + aviso Telegram ─────────────────
// Extraído del patrón canónico de handleAppointmentAction/'escalar_humano'. NO envía
// mensaje al cliente (el llamante ya lo ha hecho) y nunca lanza: fallar la escalada no
// puede tumbar el turno. Devuelve true solo si quedó registrada — un false es una
// promesa incumplida y tiene que verse en los logs.
async function escalateToHuman(session, userPhone, reason, ultimoMensaje) {
    const orgId = session.orgId;
    const telefono = session.partialData.telefono;
    try {
        let contact = await findByPhone(orgId, telefono);
        if (!contact && !session.leadId) {
            const newId = await saveLead(orgId, { ...session.partialData, leadId: session.leadId });
            if (newId) { session.leadId = newId; session.leadGuardado = true; }
            contact = await findByPhone(orgId, telefono);
        }
        const contactId = contact?.id || session.leadId;
        await setLeadBotMode(orgId, telefono, 'manual');
        await setEscalationReason(orgId, telefono, reason);
        // El aviso al humano va ANTES del INSERT y es fire-and-forget: si la escritura falla
        // y lanza, el salón se entera igual por Telegram en vez de quedarse a ciegas. En el
        // camino feliz el orden no cambia nada (no se awaitea ninguna de las dos).
        notifyEscalation(orgId, { nombre: session.partialData.nombre, telefono }, ultimoMensaje, reason).catch(() => {});
        await createPendingAction(orgId, {
            type: 'escalation',
            contactId,
            payload: { motivo: reason, mensaje: ultimoMensaje || '' },
        });
        logger.info('escalada_ejecutada', { orgId, telefono: userPhone, reason });
        return true;
    } catch (e) {
        logger.error('error_escalar', { orgId, telefono: userPhone, reason, error: e.message });
        return false;
    }
}

// ─── Acciones de reserva/cita ────────────────────────────────────────────────
async function handleAppointmentAction(client, session, userPhone, accion, respuesta, motivoEscalado) {
    const orgId = session.orgId;
    if (accion === 'cancelar') {
        // Sin cita que cancelar, el salón NO anuncia una cancelación: el `if` de abajo se
        // saltaba entero y el mensaje "cancelada ✅" salía igual, con la cita viva en la
        // agenda y la clienta sin aparecer el día de su cita. La ruta buena para el salón es
        // handleCitasExistentes, que resuelve la cita contra Supabase y verifica la escritura.
        // San Remo queda intacto: rehidrata appointment_id desde partialData en las dos ramas
        // de carga de sesión, así que no llega aquí en blanco.
        if (session.orgType === 'salon' && !session.appointmentId) {
            logger.warn('cancelacion_sin_cita_descartada', { orgId, telefono: userPhone });
            return false;
        }
        if (session.appointmentId) {
            if (session.orgType === 'salon') await calendarSante.cancelAppointment(orgId, session.appointmentId);
            else await calendar.cancelAppointment(session.appointmentId);
            await updateAppointment(orgId, session.appointmentId, { estado: 'cancelled', actor: 'bot' });
        }
        session.reservaConfirmada = false;
        session.bizumAsked = false;
        session.bizumPendiente = false;
        session.appointmentId = null;
        clearServiceState(session);
        await updateLead(orgId, { telefono: session.partialData.telefono, estado_cita: 'cancelado', leadId: session.leadId });
        const cancelMsgs = { en: "Your appointment has been cancelled ✅ If you'd like to book another, just let me know 😊", ru: 'Запись отменена ✅ Если захочешь записаться снова, напиши мне 😊', uk: 'Запис скасовано ✅ Якщо захочеш записатися знову, напиши мені 😊' };
        const msg = session.orgType === 'salon'
            ? (session.language && cancelMsgs[session.language]) || 'Tu cita ha sido cancelada ✅ Si quieres reservar otra, dímelo cuando quieras 😊'
            : 'Tu reserva ha sido cancelada ✅ Si quieres reservar otro día, dímelo cuando quieras 😊';
        await sendWithDelay(client, userPhone, msg, orgId, session.partialData.telefono);
        return true;
    }
    if (accion === 'cambiar') {
        session.reservaConfirmada = false;
        session.bizumAsked = false;
        session.bizumPendiente = false;
        // Guardamos el id de la cita existente ANTES de anular appointmentId. Así, al confirmar
        // el nuevo hueco, finalizarCitaSante la MUEVE (UPDATE in-place) en vez de crear otra
        // dejando la vieja huérfana. Se anula appointmentId para que los guards de "cita
        // confirmada" (2ª reserva, etc.) no se disparen durante el reagendado.
        session.reagendarAppointmentId = session.appointmentId || null;
        session.appointmentId = null;
        session.availableSlots = [];
        session.proposedSlots = [];
        session.currentSlotIndex = 0;
        session.slotsProposed = false;
        // 'cambiar' ya pregunta día/hora en su propio mensaje: no re-preguntamos preferencia.
        session.datePreferenceAsked = true;
        session.modoReagendamiento = true;
        delete session.partialData.preferencia_horaria;
        delete session.partialData.fecha_cita;
        delete session.partialData.hora_cita;
        const rescheduleMsgs = { en: 'What day and time would work best for your new appointment?', ru: 'Какой день и время тебе подойдут для новой записи?', uk: 'Який день і час тобі підійдуть для нового запису?' };
        const msg = session.orgType === 'salon'
            ? (session.language && rescheduleMsgs[session.language]) || '¿Qué día y hora te vendría mejor para la nueva cita?'
            : 'Sin problema 😊 ¿Qué día y para comida o cena te vendría mejor?';
        await sendWithDelay(client, userPhone, msg, orgId, session.partialData.telefono);
        return true;
    }
    if (accion === 'escalar_humano') {
        session.botActivo = false;
        const reason = motivoEscalado || 'escalado_bot';
        clearServiceState(session);
        try {
            let contact = await findByPhone(orgId, session.partialData.telefono);
            if (!contact && !session.leadId) {
                const newId = await saveLead(orgId, { ...session.partialData, leadId: session.leadId });
                if (newId) { session.leadId = newId; session.leadGuardado = true; }
                contact = await findByPhone(orgId, session.partialData.telefono);
            }
            const contactId = contact?.id || session.leadId;
            await setLeadBotMode(orgId, session.partialData.telefono, 'manual');
            await setEscalationReason(orgId, session.partialData.telefono, reason);
            const ultimoMensaje = session.history[session.history.length - 1]?.content || '';
            // Notify antes del INSERT: ver escalateToHuman.
            notifyEscalation(orgId, { nombre: session.partialData.nombre, telefono: session.partialData.telefono }, ultimoMensaje, reason).catch(() => {});
            await createPendingAction(orgId, {
                type: 'escalation',
                contactId,
                payload: { motivo: reason, mensaje: ultimoMensaje },
            });
        } catch (e) { logger.error('error_escalar', { telefono: userPhone, error: e.message }); }
        if (respuesta) await sendWithDelay(client, userPhone, respuesta, orgId, session.partialData.telefono);
        return true;
    }
    return false;
}

// Cuánto ocupa una mesa reservada. El número no es nuevo: es el que llevaba aplicándose
// desde siempre, pero como valor por defecto DENTRO de db.saveAppointment, donde no se veía
// y donde parecía una red para todas las orgs cuando en realidad solo lo usaba esto. Al
// exigir db.js una duración explícita, la mesa declara la suya aquí. Si alguna vez hay que
// cambiarla, este es el sitio; y si San Remo llega a tener duraciones por servicio, sale de
// agent_configs como el importe del Bizum.
const DURACION_MESA_MIN = 120;

// ─── Finalización de reserva con Bizum (San Remo only) ──────────────────────
async function finalizarReservaConBizum(client, session, userPhone) {
    const orgId = session.orgId;
    const slot = session.availableSlots[session.currentSlotIndex];
    const fecha = slot?.fecha || session.partialData.fecha_cita;
    const hora = slot?.hora || session.partialData.hora_cita;

    session.partialData.fecha_cita = fecha;
    session.partialData.hora_cita = hora;
    session.partialData.estado_cita = 'pendiente_bizum';

    const agentCfg = await getAgentConfig(orgId);
    const bizumAmount = agentCfg?.business_info?.bizum?.importe ?? config.bizum?.importe ?? null;

    try {
        const rid = await saveLead(orgId, { ...session.partialData, leadId: session.leadId });
        if (rid) session.leadId = rid;
        session.leadGuardado = true;
        incrementMetric('leadsSaved');

        const apt = await saveAppointment(orgId, session.leadId, {
            servicio: 'Reserva de mesa',
            fecha, hora,
            duracionMin: DURACION_MESA_MIN,
            estado: 'pending',
            notas: session.partialData.notas || null,
            personas: session.partialData.personas,
            ocasion: session.partialData.ocasion,
            bizumStatus: 'pending',
            bizumAmount,
        });

        if (apt) {
            session.appointmentId = apt.id;
            await updateLead(orgId, { leadId: session.leadId, appointment_id: apt.id });
            // Telegram ANTES del INSERT (fire-and-forget, sin cambio en el camino feliz): si
            // la fila de verificación no se puede escribir, Alberto tiene que enterarse igual
            // del Bizum pendiente en vez de quedarse sin aviso.
            notifyBizumPending(orgId, {
                nombre: session.partialData.nombre,
                telefono: session.partialData.telefono,
                fecha, hora,
                personas: session.partialData.personas,
                ocasion: session.partialData.ocasion,
            }).catch(() => {});
            await createPendingAction(orgId, {
                type: 'bizum_review',
                contactId: session.leadId,
                appointmentId: apt.id,
                payload: {
                    nombre: session.partialData.nombre,
                    telefono: session.partialData.telefono,
                    fecha, hora,
                    personas: session.partialData.personas,
                    ocasion: session.partialData.ocasion,
                },
            });
        }
    } catch (e) {
        logger.error('error_finalizar_bizum', { telefono: userPhone, error: e.message });
    }

    session.reservaConfirmada = true;
    session.bizumPendiente = true;
    session.leadStatus = 'completed';

    const respuesta = '¡Gracias! 🙏 En cuanto verifiquemos el Bizum te confirmamos la reserva por aquí.';
    session.history.push({ role: 'assistant', content: respuesta, ts: Date.now() });
    await sendWithDelay(client, userPhone, respuesta, orgId, session.partialData.telefono);
}

// ─── Selección del hueco elegido por la clienta (Sante) ─────────────────────
// El LLM nos devuelve la hora que la clienta acepta; buscamos ese hueco exacto
// en la lista para no reservar siempre el primero. Fallback: el hueco actual.
function normalizeHora(h) {
    if (!h) return null;
    const s = String(h).toLowerCase().trim();

    if (/mediodia|mediodía/.test(s)) return '13:00';

    const esTarde = /tarde|noche|pm/.test(s);
    const esMañana = /ma[ñn]ana|morning|am/.test(s);

    const m = s.match(/(\d{1,2})(?:[:.h](\d{2}))?/);
    if (!m) return null;

    let hh = parseInt(m[1], 10);
    let mm = m[2] ? parseInt(m[2], 10) : (/y\s*media/.test(s) ? 30 : 0);

    // Convertir 12h/coloquial a 24h
    if (esTarde && hh < 12) hh += 12;
    else if (!esMañana && hh >= 1 && hh <= 8) hh += 12; // "las 4" → 16:00, "las 7" → 19:00

    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// Bug 1: detecta que el mensaje expresa una FECHA (mes explícito, "1 de julio") sin
// una hora concreta. En ese caso NO es una selección de hueco: es preferencia de día.
// Sin esta guarda, normalizeHora convierte el día ("1") en hora ("13:00") y la
// confirmación reserva un hueco que la clienta no eligió (solo pidió ver ese día).
// "a la 1", "el 1 de julio a las 14h" → false (hay hora explícita → sí es selección).
const _FECHA_CON_MES_RE = /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/;
function messageHasDateWithoutTime(text) {
    const t = normalizeText(text);
    if (!t || !_FECHA_CON_MES_RE.test(t)) return false;
    const hasExplicitTime = /\b\d{1,2}[:.h]\d{2}\b/.test(t)          // 14:30, 14h30, 14.30
        || /\b\d{1,2}\s*h\b/.test(t)                                // 14h
        || /\ba\s+las?\s+\d{1,2}\b/.test(t)                         // "a las 14", "a la 1"
        || /\b(y\s*media|y\s*cuarto|menos\s*cuarto|mediod[ií]a)\b/.test(t);
    return !hasExplicitTime;
}

// Busca un servicio de la categoría "Cortes" cuyo nombre normalizado contenga TODAS
// las palabras de includeAll y NINGUNA de excludeAny. Robusto ante el nombre exacto
// del catálogo (matchea por palabras clave, no por igualdad literal).
function findCorteService(catalog, includeAll, excludeAny = []) {
    if (!Array.isArray(catalog)) return null;
    const cortes = catalog.filter(s => {
        const cat = normalizeText(s.categoria || '');
        const nom = normalizeText(s.nombre || '');
        return cat === 'cortes' || nom.startsWith('corte');
    });
    return cortes.find(s => {
        const n = normalizeText(s.nombre || '');
        return includeAll.every(w => n.includes(w)) && !excludeAny.some(w => n.includes(w));
    }) || null;
}

// Resuelve el hueco que la clienta acepta contra la lista EXACTA que se le propuso
// (session.proposedSlots = lo numerado que vio el LLM). Nunca adivina con slots[0]:
// si la selección es ambigua devuelve null y el bot vuelve a preguntar, en vez de
// guardar el hueco más temprano (que causaba BUG 2 estilista y BUG 3 fecha/hora).
function pickChosenSlot(session, datos, overrideSlots) {
    const slots = overrideSlots
        || ((session.proposedSlots && session.proposedSlots.length)
            ? session.proposedSlots
            : (session.availableSlots || []));
    if (!slots.length) return null;

    const horaSel = normalizeHora(datos?.hora_cita);
    const fechaSel = datos?.fecha_cita || null;

    logger.info('pickChosenSlot_entrada', {
        horaSel, fechaSel,
        numSlots: slots.length,
        slots: slots.slice(0, 5).map(s => ({ fecha: s.fecha, hora: s.hora, stylist: s.stylistName })),
    });

    // (a) fecha + hora exactas → match inequívoco.
    if (horaSel && fechaSel) {
        const exact = slots.find(s => normalizeHora(s.hora) === horaSel && s.fecha === fechaSel);
        if (exact) {
            logger.info('pickChosenSlot_match', { branch: 'fecha+hora', fecha: exact.fecha, hora: exact.hora, stylist: exact.stylistName });
            return exact;
        }
    }
    // (b) solo hora, pero únicamente si NO es ambigua (un solo día propuesto con esa hora).
    if (horaSel) {
        const byHora = slots.filter(s => normalizeHora(s.hora) === horaSel);
        if (byHora.length === 1) {
            logger.info('pickChosenSlot_match', { branch: 'hora_unica', fecha: byHora[0].fecha, hora: byHora[0].hora, stylist: byHora[0].stylistName });
            return byHora[0];
        }
        if (byHora.length > 1) {
            logger.info('pickChosenSlot_ambiguo', { branch: 'hora_multiple', count: byHora.length, matches: byHora.map(s => ({ fecha: s.fecha, hora: s.hora })) });
        }
    }
    // (b.5) hora exacta no en el grid de 30 min (p.ej. "10:15", "10:45"):
    // si AMBOS huecos contiguos de 30 min existen en el día pedido, la franja
    // entre ellos es libre con seguridad → sintetizamos el hueco a la hora exacta.
    if (horaSel) {
        const [rh, rm] = horaSel.split(':').map(Number);
        if (!isNaN(rh) && !isNaN(rm) && rm % 30 !== 0) {
            const reqMin = rh * 60 + rm;
            const prevMin = reqMin - (reqMin % 30);
            const nextMin = prevMin + 30;
            const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
            const daySlots = fechaSel ? slots.filter(s => s.fecha === fechaSel) : slots;
            const prevSlot = daySlots.find(s => normalizeHora(s.hora) === fmt(prevMin));
            const nextSlot = daySlots.find(s => normalizeHora(s.hora) === fmt(nextMin));
            if (prevSlot && nextSlot) {
                const synth = { ...prevSlot, hora: horaSel };
                logger.info('pickChosenSlot_match', { branch: 'hora_sintetizada', horaOriginal: prevSlot.hora, horaSolicitada: horaSel, fecha: prevSlot.fecha });
                return synth;
            }
        }
    }

    // (c) un único hueco propuesto → no hay nada que confundir.
    if (slots.length === 1) {
        logger.info('pickChosenSlot_match', { branch: 'slot_unico', fecha: slots[0].fecha, hora: slots[0].hora, stylist: slots[0].stylistName });
        return slots[0];
    }

    // Ambiguo: no elegimos por la clienta.
    logger.info('pickChosenSlot_sin_match', { horaSel, fechaSel, numSlots: slots.length });
    return null;
}

// Mapea una selección posicional/ordinal de la clienta a un hueco concreto.
// "el primero", "la 2ª", "el de las 14", "el último", o un número suelto → slot.
// Tolerante a erratas (usa includes, no \b) porque el LLM no siempre extrae la hora
// cuando la clienta elige por posición. Solo debe usarse cuando ya hay huecos propuestos.
function parseSlotSelection(text, slots) {
    if (!slots || !slots.length) return null;
    const t = normalizeText(text);
    if (!t) return null;

    // Bug 1: si el texto es una FECHA con mes y sin hora ("el 1 de julio"), el número es
    // el día, NO una opción ni una hora → no es selección de hueco. Sin esta guarda, la
    // extracción de hora de abajo leería "1" como las 13:00 y elegiría un hueco erróneo.
    if (messageHasDateWithoutTime(text)) return null;

    // 1) Por hora explícita ("el de las 14", "a las 15:30", "14h"). Extracción
    //    permisiva + match estricto contra los huecos reales evita falsos positivos.
    //    Prioriza SIEMPRE la lectura de hora sobre la posicional: "a las 2" es las 14:00,
    //    no "la opción 2". Como el salón trabaja por la tarde, probamos la hora literal
    //    y su variante de tarde (+12); solo gana si coincide con un hueco real.
    const horaMatch = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*h?\b/);
    if (horaMatch) {
        const h = parseInt(horaMatch[1], 10);
        const mm = horaMatch[2] || '00';
        const candidatos = [normalizeHora(`${h}:${mm}`)];
        if (h >= 1 && h <= 11) candidatos.push(normalizeHora(`${h + 12}:${mm}`)); // "a las 2" → 14:00
        for (const target of candidatos) {
            const byHora = slots.find(s => normalizeHora(s.hora) === target);
            if (byHora) return byHora;
        }
    }

    // 2) Por ordinal en palabras (con tolerancia a erratas vía includes).
    const ordinalGroups = [
        { idx: 0, words: ['primero', 'primera', 'primer', '1o', '1a', '1º', '1ª'] },
        { idx: 1, words: ['segundo', 'segunda', '2o', '2a', '2º', '2ª'] },
        { idx: 2, words: ['tercero', 'tercera', 'tercer', '3o', '3a', '3º', '3ª'] },
        { idx: 3, words: ['cuarto', 'cuarta', '4o', '4a', '4º', '4ª'] },
        { idx: 4, words: ['quinto', 'quinta', '5o', '5a', '5º', '5ª'] },
    ];
    for (const g of ordinalGroups) {
        if (g.idx < slots.length && g.words.some(w => t.includes(w))) return slots[g.idx];
    }
    if (['ultimo', 'ultima', 'el final', 'la final'].some(w => t.includes(w))) {
        return slots[slots.length - 1];
    }

    // 3) Número de opción: suelto ("2") o con marcador ("el 2", "opción 2", "el hueco 2").
    const bare = t.match(/^\s*(\d{1,2})\s*$/);
    if (bare) {
        const n = parseInt(bare[1], 10);
        if (n >= 1 && n <= slots.length) return slots[n - 1];
    }
    const conMarcador = t.match(/\b(?:el|la|los|las|opcion|numero|num|hueco|hora|cita)\s+(\d{1,2})\b/);
    if (conMarcador) {
        const n = parseInt(conMarcador[1], 10);
        if (n >= 1 && n <= slots.length) return slots[n - 1];
    }

    return null;
}

// Detecta que el LLM AFIRMA en su texto que la cita queda reservada/confirmada.
// Sirve de red de seguridad: el LLM a menudo escribe "te he reservado" sin poner el
// flag reserva_confirmada → si no lo cazamos, el bot miente y no persiste nada.
// normalizeText quita acentos, así que comparamos sin tildes ("esta" por "está").
//
// Son REGEX, no subcadenas literales, por el bug del 30/07/2026: el mensaje real que
// anunció una cita fantasma empezaba con "Citas reservadas para el jueves 6 de agosto"
// y la lista solo tenía el singular 'cita reservada' → devolvía false y la mentira salió
// entera. Cualquier afirmación de reserva en PLURAL es además la más peligrosa: significa
// que el LLM está anunciando varias citas y el sistema solo guarda una por turno.
const BOOKING_CLAIM_PATTERNS = [
    // ES — verbo en 1ª persona
    /\bte (?:la |lo |las |los )?(?:he )?(?:reservad[oa]s?|apuntad[oa]s?|anotad[oa]s?|agendad[oa]s?)\b/,
    /\bte (?:la |lo |las |los )?(?:reservo|apunto|anoto|agendo)\b/,
    // ES — "queda(n) confirmada(s)" / "está(n) reservada(s)"
    /\bqueda(?:n)? (?:confirmad|reservad|agendad|fijad|apuntad|anotad)[oa]s?\b/,
    /\bestan? (?:confirmad|reservad|agendad|apuntad|anotad)[oa]s?\b/,
    // ES — "cita(s) reservada(s)" en cualquier orden
    /\bcitas? (?:confirmad|reservad|agendad|apuntad|anotad)[oa]s?\b/,
    /\breservas? confirmadas?\b/,
    /\breservad[oa]s? para\b/,
    /\bconfirmad[oa]s? (?:tu|la|las|tus) citas?\b/,
    // EN — el apóstrofo puede venir recto o tipográfico; normalizeText no lo unifica.
    /\byou['’]?re booked\b/, /\bi['’]?ve booked\b/, /\bbooked you\b/, /\bi have booked\b/, /\bi booked you\b/,
    /\bappointments? (?:is|are) confirmed\b/, /\byou (?:are |['’]?re )?all set\b/, /\bsee you on\b/,
    // RU/UK — sin \b: en JS el límite de palabra es ASCII y no funciona con cirílico.
    /записал[аи]?/, /вы записаны/, /брон[ья] подтверждена/, /запись подтверждена/,
    /записано/, /бронювання підтверджено/, /запис підтверджено/,
];
function llmClaimsBooked(text) {
    if (!text) return false;
    const t = normalizeText(text);
    return BOOKING_CLAIM_PATTERNS.some(re => re.test(t));
}

// Mensaje de reintento (multiidioma) cuando no se pudo fijar el hueco. Se reutiliza en
// las tres ramas de confirmación de Sante para no triplicar el literal.
function salonRetryMsg(language) {
    const retryMsgs = {
        en: "Sorry, I couldn't lock that slot 😕 Which of the available times works best for you?",
        ru: 'Извините, не удалось закрепить это время 😕 Какое из свободных окошек тебе удобнее?',
        uk: 'Вибач, не вдалося зафіксувати цей час 😕 Яке з вільних віконець тобі зручніше?',
    };
    return (language && retryMsgs[language]) || 'Uy, no he podido fijar ese hueco 😕 ¿Cuál de los horarios disponibles te viene mejor?';
}

// Returns true when `respuesta` contains concrete times (HH:MM) that have NO backing in
// `availableSlots` — i.e. the LLM invented them. Returns false if no times appear, if
// every mentioned time matches a real slot, or if a mentioned time falls within the range
// of real slots (covers the ±30 min intermediate-slot exception: 10:15 between 10:00/10:30).
//
// `horasHorario` (opcional) son las puntas de `business_hours`: DECIR EL HORARIO DEL SALÓN
// no es ofrecer un hueco. Sin esta exención, «cerramos a las 19:00» son dos HH:MM sin
// respaldo y la respuesta se sustituía por el menú genérico — el bug del 07/08/2026, en el
// que Olga Yarmak pidió tres veces las 23:00 y jamás se le dijo el horario. Es la misma
// clase de fallo que ya estaba anotada en unbackedBookingClaim, pero allí el coste es un
// mensaje honesto de más y aquí era perder el único mensaje correcto.
//
// La exención EXIGE las cuatro cosas, y ninguna sobra:
//   1. Toda hora mencionada es una punta del horario O cae fuera de él. Lo segundo hace
//      falta porque la respuesta correcta REPITE la hora imposible que pidió la clienta
//      («a las 23:00 no abrimos, nuestro horario es de 10:00 a 19:00»), y una hora fuera
//      del horario no puede ser un hueco inventado: no es reservable por definición.
//   2. Se mencionan DOS puntas distintas. Un mensaje que nombra UNA sola hora no está
//      diciendo un horario, está proponiendo un hueco — «te apunto a las 19:00» y «¿te va
//      bien a las 11:00?» caen aquí, que es justo lo que no puede colarse.
//   3. El texto DICE que es un horario ("abrimos", "мы работаем", "our hours"…). Sin esto,
//      «tengo libre a las 11:00 y a las 15:00» sin un solo hueco pasaría por horario.
//   4. No da la reserva por hecha (llmClaimsBooked).
//
// (2) y (3) ocupan el sitio de asksForBookingApproval y son MÁS estrictas que ella: bloquean
// también las propuestas que no preguntan nada. Se cambió por eso y por un falso positivo
// real: «Мы работаем с 11:00 до 15:00. Какое время тебе подойдёт?» es la respuesta correcta
// en ruso y `подойдёт` está en BOOKING_APPROVAL_QUESTIONS, así que la habría bloqueado.
const HORARIO_MARKERS = [
    /\bhorario\b/, /\babrimos\b/, /\babierto\b/, /\babiertos\b/, /\bcerramos\b/, /\bde lunes a\b/,
    /\bwe(?:'|’)?re open\b/, /\bwe are open\b/, /\bwe open\b/, /\bour hours\b/, /\bopening hours\b/,
    buildCyrillicRe(['работаем', 'график', 'открыты', 'закрываемся', 'працюємо', 'розклад', 'графік', 'відчинені']),
];
function statesOpeningHours(text) {
    const t = normalizeText(text);
    return HORARIO_MARKERS.some(re => re.test(t));
}
// ¿El texto DECLARA el horario del salón, en vez de ofrecer huecos? Las cuatro condiciones
// y el porqué de cada una, en el comentario de arriba.
//
// Extraída de respondsWithInventedSlots para que la comparta el gate de «sin servicio no se
// propone día ni hora»: allí «¿abrís los domingos?» → «abrimos de 10:00 a 19:00» es una
// respuesta legítima SIN servicio seleccionado, y sin esta exención sería el caso de Olga
// otra vez —la red comiéndose el único mensaje correcto—. Copiarla habría sido la tercera
// copia del mismo patrón, que es justo el bug que arregla este commit.
function soloDeclaraHorarioDelSalon(respuesta, horasMencionadas, horasHorario) {
    if (!Array.isArray(horasHorario) || !horasHorario.length) return false;
    if (!Array.isArray(horasMencionadas) || !horasMencionadas.length) return false;
    const limites = new Set(horasHorario.map(normalizeHora).filter(Boolean));
    if (!limites.size) return false;
    const toMinutos = hhmm => { const [H, M] = hhmm.split(':').map(Number); return H * 60 + M; };
    const limMins = [...limites].map(toMinutos);
    const primera = Math.min(...limMins);
    const ultima = Math.max(...limMins);
    // Fuera del sobre [primera apertura, último cierre) no hay hueco posible.
    const noReservable = h => toMinutos(h) < primera || toMinutos(h) >= ultima;
    const soloHorario = horasMencionadas.every(h => h && (limites.has(h) || noReservable(h)));
    const puntasDistintas = new Set(horasMencionadas.filter(h => h && limites.has(h))).size;
    return soloHorario && puntasDistintas >= 2 && statesOpeningHours(respuesta) && !llmClaimsBooked(respuesta);
}
function respondsWithInventedSlots(respuesta, availableSlots, horasHorario = null) {
    // Las HH:MM y las sueltas con marcador ("around 10, 11, or 12"). El normalizeHora de
    // encima se mantiene: es el que convierte "5:30" en 17:30 y hace que case con un hueco
    // real de la tarde. Sin él, quitarlo sería marcar como inventado un hueco que existe.
    const mentioned = extractMentionedHours(respuesta).map(normalizeHora).filter(Boolean);
    if (mentioned.length === 0) return false;
    if (soloDeclaraHorarioDelSalon(respuesta, mentioned, horasHorario)) return false;
    const realSlots = Array.isArray(availableSlots) ? availableSlots : [];
    const realHoras = new Set(realSlots.map(s => normalizeHora(s.hora)).filter(Boolean));
    const toMin = hhmm => { const [H, M] = hhmm.split(':').map(Number); return H * 60 + M; };
    const realMins = [...realHoras].map(toMin);
    const minR = realMins.length ? Math.min(...realMins) : null;
    const maxR = realMins.length ? Math.max(...realMins) : null;
    const anyValid = realHoras.size > 0 && mentioned.some(h => {
        if (!h) return false;
        if (realHoras.has(h)) return true;
        const m = toMin(h);
        return m >= minR && m <= maxR;
    });
    return !anyValid;
}

// ─── Sin servicio no se propone día ni hora ──────────────────────────────────
// Michal Gradziel (07/08/2026), con selectedService a null de principio a fin: el bot le
// preguntó el día ("Monday August 10 works! What time suits you best — morning or
// afternoon?") y un turno después le ofreció "around 10, 11, or 12" sin un solo hueco
// cargado. Dos turnos gastados sobre humo, y solo entonces admitió que no sabía el servicio.
//
// Las guardas de CÓDIGO estaban bien y ninguna falló: loadAvailableSlots y
// askDatePreferenceFirst exigen las dos selectedService, así que no se cargó ni un hueco ni
// salió la pregunta determinista del día. Lo que no existía era una guarda sobre lo que el
// modelo DICE. Y el prompt empujaba justo en la dirección contraria: la rama
// __servicioMencionado le ordenaba «mapéalo al catálogo … y continúa el flujo», dando por
// hecho que puede mapearlo. Cuando no puede —«platinum blonde» contra un catálogo en
// castellano— cumple la segunda mitad igual, y el flujo es día → franja → horas.
//
// Es la recomendación 2 de docs/escenario-3-servicio-sin-resolver.md, abierta desde el
// 05/08/2026. Solo prompt no basta: el modelo ya ignoró una vez su SIGUIENTE PASO.
const TIMING_MARKERS = [
    /\bque (dia|semana)\b/, /\bque dias\b/, /\bcuando (te|le) (viene|va|vendria|iria)\b/,
    /\b(por la )?manana o (por la )?tarde\b/, /\bla semana que viene\b/, /\besta semana\b/,
    /\bwhat day\b/, /\bwhich day\b/, /\bwhat time\b/, /\bwhich time\b/, /\bwhat date\b/,
    /\bwhen would\b/, /\bwhen are you\b/, /\bwhen do you\b/, /\bmorning or afternoon\b/,
    /\bthis week\b/, /\bnext week\b/,
    buildCyrillicRe(['какой день', 'какое время', 'когда тебе', 'когда вам', 'во сколько',
        'утром или', 'на этой неделе', 'на следующей неделе',
        'який день', 'яка година', 'коли тобі', 'коли вам', 'вранці чи',
        'цього тижня', 'наступного тижня']),
];
function proposesTimingWithoutService(respuesta, session, horasHorario) {
    if (!respuesta || !session) return false;
    if (session.selectedService || session.reservaConfirmada) return false;
    // Una conversación que gira sobre una cita YA existente habla de días y horas con toda
    // la razón y sin servicio seleccionado: consultarla, cancelarla, reagendarla, ampliarla.
    if (session.citaEnCurso || session.pendingCitaAccion || session.modoReagendamiento
        || session.anchorAppointment) return false;
    const t = normalizeText(respuesta);
    const horas = extractMentionedHours(respuesta).map(normalizeHora).filter(Boolean);
    if (!horas.length && !TIMING_MARKERS.some(re => re.test(t))) return false;
    // Decir el horario del salón NO es proponer un hueco, y es una respuesta legítima sin
    // servicio: "¿a qué hora abrís?" no exige saber a qué viene. Misma exención que la red
    // de huecos inventados, compartida a propósito — es el mensaje que se comió a Olga.
    if (soloDeclaraHorarioDelSalon(respuesta, horas, horasHorario)) return false;
    return true;
}

// Horas HH:MM que el mensaje MENCIONA y que NO tienen una cita real detrás.
// Complemento de respondsWithInventedSlots: aquella contrasta contra los huecos OFRECIDOS
// (¿existe ese hueco?), esta contrasta contra las citas GUARDADAS (¿está escrito?).
//
// Bug del 30/07/2026: con una cita ya confirmada, el bot anunció "Citas reservadas: 15:00
// masaje, 16:00 pedicura" y en Supabase solo existía la de las 16:00. `horasReales` viene
// de db.getUpcomingAppointments, no de la sesión.
//
// Límite conocido y asumido: un mensaje que afirme reserva y además cite un horario
// comercial ("abrimos de 10:00 a 19:00") marcará esas horas como no respaldadas. El coste
// es un mensaje honesto de más; el coste de no mirar es una cita perdida en silencio.
function unbackedBookingClaim(respuesta, horasReales) {
    const mencionadas = extractMentionedHours(respuesta).map(normalizeHora).filter(Boolean);
    if (!mencionadas.length) return [];
    const reales = new Set((Array.isArray(horasReales) ? horasReales : []).map(normalizeHora).filter(Boolean));
    return [...new Set(mencionadas.filter(h => h && !reales.has(h)))];
}

// ¿El mensaje PIDE aprobación para reservar, en vez de dar la reserva por hecha?
// "Perfecto, te apunto el jueves a las 10:00. ¿Te va bien?" contiene una frase de
// llmClaimsBooked ("te apunto") pero es una PROPUESTA: no promete nada, espera un sí.
// Distinguirlo importa porque la red anti-cita-fantasma rectifica y reinicia el flujo, y
// hacerlo sobre una propuesta legítima descarrila la conversación (se vio en s6: el bot
// contestaba "todavía no tengo ninguna cita apuntada" a mitad de su propia propuesta).
// El cierre falso de verdad no pregunta si te va bien: lo da por cerrado y sigue.
const BOOKING_APPROVAL_QUESTIONS = [
    /¿\s*te (va|viene|parece) bien/, /¿\s*(lo|la|te lo|te la) (confirmo|reservo|apunto)/,
    /¿\s*confirmo\b/, /¿\s*reservo\b/, /¿\s*quieres que (lo|la|te lo|te la) (confirme|reserve|apunte)/,
    /\bshall i book\b/, /\bdoes that work\b/, /\bis that ok(ay)?\b/, /\bwould that work\b/,
    // RU/UK por buildCyrillicRe: 'подойдёт' y 'підійде' llevan й y escritos a mano no casaban
    // NUNCA. Consecuencia: para una clienta rusa o ucraniana, una PROPUESTA legítima del bot
    // ("Записал тебя на четверг в 10:00. Тебе подойдёт?") la leía la red anti-cita-fantasma
    // como una reserva dada por hecha —llmClaimsBooked sí reconoce el cirílico— y rectificaba
    // y reiniciaba el flujo en mitad de su propia propuesta.
    buildCyrillicRe(['подойдет', 'подойдёт', 'підійде']),
    /подтверждаю\?/,
];
function asksForBookingApproval(text) {
    const t = normalizeText(text);
    return BOOKING_APPROVAL_QUESTIONS.some(re => re.test(t));
}

// ─── Red anti-CITA FANTASMA (Sante) ─────────────────────────────────────────
// El invariante duro: NINGÚN mensaje que afirme una reserva sale sin que esa reserva esté
// escrita en Supabase. A diferencia de las otras cinco redes del salón, esta NO se apaga
// con `reservaConfirmada` — apagarla ahí es exactamente el bug del 30/07/2026: con la
// pedicura de las 16:00 ya confirmada, todas las demás barreras quedaron inactivas y el
// LLM anunció "Citas reservadas: 15:00 masaje, 16:00 pedicura" habiendo escrito solo una.
//
// Se contrasta contra la BD, nunca contra la sesión. Si salta: se registra, se reabre el
// flujo (con reservaConfirmada=false las otras redes vuelven a estar vivas y el turno
// siguiente carga huecos REALES) y se sustituye el texto por uno que solo enumera las citas
// que existen. Nunca toca las citas ya guardadas.
//
// Se llama DOS veces por turno: antes del despacho de acciones (que tiene rutas de salida
// propias, p.ej. escalar_humano envía el texto del LLM y hace return) y al final, sobre el
// mensaje ya definitivo. El coste extra es una lectura, y solo cuando el texto afirma
// reservar. Devuelve true si bloqueó algo.
// ─── Recarga de sesión: ¿clienta recurrente o clienta CON cita viva? ─────────
//
// La pregunta se responde contra Supabase, nunca contra `partialData.estado_cita`. Esa era
// la causa raíz: el estado que la sesión creía tener decidía si se le borraba el servicio.
//
// Lo que NO hace, a propósito: tocar `reservaConfirmada`. Ponerlo a true aquí apagaría de
// golpe cinco de las seis redes del salón (llmClaimsBooked en el turno, las dos anti-fantasma
// secundarias y los dos guards de "sin servicio"), y encima en muchas más sesiones que antes.
// Es exactamente el bug del 30/07/2026. Para que la sesión "sepa" que hay una cita basta con
// appointmentId + citaEnCurso, que es para lo que existe citaEnCurso.
/**
 * El contact_id de esta conversación, resolviéndolo contra la BD si aún no lo tenemos.
 *
 * `session.leadId` es un dato que PUEDE venir vacío, y durante mucho tiempo se leyó como si
 * siempre estuviera. Se queda a null en dos situaciones nada exóticas:
 *
 *   · Primer mensaje de una desconocida. Solo se asigna en la rama de sesión NUEVA, y ahí
 *     `findByPhone` todavía devuelve null — la fila la crea `saveMessage` un instante
 *     después. Nada la rellenaba en el resto de esa sesión.
 *   · Sesión rehidratada. `leadId` no viaja a SQLite (no está en buildSessionExtra), así que
 *     tras un reinicio o un timeout vuelve vacío… mientras que `bookedSlots` SÍ se persiste.
 *
 * Todo lo que colgaba de `if (session.leadId)` se saltaba en silencio en esos dos casos: el
 * idioma no se escribía, la estilista habitual tampoco, y el barrido de abandono marcaba
 * 'abandonado' sin llegar a comprobar si había cita —que es el incidente del 04/08/2026,
 * cuyo arreglo estaba gateado justo por el campo que estaba nulo—. Auditoría 05/08/2026.
 *
 * Resolver AQUÍ y no en cada call site es el punto de la función: ninguno tiene que
 * acordarse. Cachea en la propia sesión, que es donde el resto del código mira después.
 *
 * Devuelve null solo si de verdad no hay contacto para ese teléfono, o si la lectura falló
 * (y entonces avisa). El fallo no se cachea a propósito: son casos raros, la siguiente
 * llamada puede acertar y ninguno de los llamadores está en un bucle caliente.
 */
async function ensureLeadId(orgId, session) {
    if (session.leadId) return session.leadId;
    const telefono = session.partialData?.telefono;
    if (!telefono) return null;
    try {
        const contact = await findByPhone(orgId, telefono);
        if (!contact?.id) return null;
        session.leadId = contact.id;
        logger.info('session_leadid_resuelto', { orgId, telefono, leadId: contact.id });
        return contact.id;
    } catch (e) {
        logger.warn('session_leadid_resolucion_fallida', { orgId, telefono, error: e.message });
        return null;
    }
}

/**
 * Persiste en la FICHA un idioma leído en un mensaje — salvo que ese mensaje sea, casi con
 * seguridad, la centralita automática de un negocio.
 *
 * Es el ÚNICO sitio por el que se escribe el idioma observado. Hay dos detectores que lo
 * producen (el determinista de `detectLanguage` y el `idioma_detectado` del LLM) y los dos
 * pasan por aquí: si uno se saltara la guarda, la guarda no serviría de nada.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * La tanda 1 de la campaña de verano (07/08/2026, 250 envíos) despertó a tres
 * autocontestadores de otros negocios. Contestaron en 7-10 s, el bot les leyó el idioma y
 * escribió `language_source: 'observed'` sobre la ficha de la supuesta clienta. `'observed'`
 * es la etiqueta que significa "se lo hemos leído a ELLA" y la única que apaga todas las
 * cautelas río abajo — el prompt deja de anunciarlo como probable y la campaña la usa para
 * elegir plantilla de Meta. Dos fichas acabaron en el idioma equivocado a partir del texto de
 * una centralita ajena; una tercera se quedó con el valor bueno por casualidad y la etiqueta
 * inventada igual.
 *
 * ── Qué hace cuando salta ───────────────────────────────────────────────────
 * NO escribe nada en la ficha: ni el idioma ni la marca. El turno sí puede usar el idioma
 * (contestarle en el suyo es gratis y reversible); lo que no se hace es dejarlo por escrito
 * sobre alguien a quien no hemos leído. Devuelve false para que quien llama sepa que la
 * sesión tampoco puede ascender a 'observed'.
 *
 * Devuelve true si el idioma quedó persistido (o en camino de estarlo).
 */
async function persistirIdiomaObservado(orgId, session, lang, { dbPhone, userPhone, origen = 'detector' }) {
    const envioReciente = await getRecentBroadcastSendAt(orgId, dbPhone);
    if (envioReciente) {
        logger.warn('idioma_no_persistido_respuesta_automatica', {
            orgId, telefono: userPhone, lang, origen, envioReciente,
            segundos: Math.round((Date.now() - new Date(envioReciente).getTime()) / 1000),
        });
        return false;
    }
    // ensureLeadId cierra el único hueco que quedaba, el PRIMER turno de una desconocida (la
    // fila la acaba de crear saveMessage y el relleno de la reconciliación aún no ha pasado).
    // Cuando ya hay leadId esto no consulta nada.
    const leadId = await ensureLeadId(orgId, session);
    if (!leadId) return false;
    // Fire-and-forget (el turno no espera), pero con traza: sin ella, una ficha que se queda
    // en el idioma que no es no deja rastro que distinga "no se intentó" de "falló".
    updateContactLanguage(orgId, leadId, lang)
        .catch(e => logger.warn('idioma_no_persistido', {
            orgId, telefono: userPhone, leadId, lang, origen, error: e.message,
        }));
    return true;
}

async function reconciliarCitaViva(orgId, session, userPhone) {
    if (!session._decidirCitaVivaAlRecargar) return;
    delete session._decidirCitaVivaAlRecargar;

    const leadId = await ensureLeadId(orgId, session);
    if (!leadId) {
        // Sin contacto no hay nada que consultar: se conserva el comportamiento anterior.
        session.clienteRecurrente = true;
        clearServiceState(session);
        return;
    }

    let citas;
    try {
        citas = await getUpcomingAppointments(orgId, leadId);
    } catch (e) {
        // Conservador y deliberado: ante un fallo de lectura NO se destruye estado (no se
        // limpia el servicio) y NO se afirma que hay cita (no se fija appointmentId ni
        // citaEnCurso). Lo contrario sería elegir entre dos mentiras con la BD caída.
        logger.warn('recarga_cita_viva_lectura_fallida', {
            orgId, telefono: userPhone, contactId: leadId, error: e.message,
        });
        return;
    }

    if (!citas.length) {
        // No hay cita por delante → es una clienta que vuelve. Comportamiento de siempre.
        session.clienteRecurrente = true;
        clearServiceState(session);
        return;
    }

    const cita = citas[0];
    const inicio = new Date(cita.starts_at);
    session.appointmentId = cita.id;
    session.citaEnCurso = {
        appointmentId: cita.id,
        servicio: cita.service,
        fecha: toLocalDateStr(inicio),
        hora: toLocalTimeStr(inicio),
        horaFin: cita.ends_at ? toLocalTimeStr(new Date(cita.ends_at)) : null,
        estilista: cita.stylists?.name || null,
        stylistId: cita.stylist_id || null,
    };
    // El servicio restaurado desde SQLite se CONSERVA: es el de esta misma cita.
    logger.info('recarga_con_cita_viva', {
        orgId, telefono: userPhone, appointmentId: cita.id,
        servicio: cita.service, fecha: session.citaEnCurso.fecha, hora: session.citaEnCurso.hora,
        citasVivas: citas.length,
    });
}

async function blockPhantomBookingClaim(orgId, session, userPhone, aiResponse, sanitized) {
    if (!llmClaimsBooked(aiResponse.respuesta)) return false;
    // Una propuesta pendiente de aprobación no es una promesa incumplida: no hay nada que
    // rectificar, y el turno siguiente (el "sí") sí pasa por aquí ya como afirmación.
    if (asksForBookingApproval(aiResponse.respuesta)) return false;
    try {
        // Va por ensureLeadId como los cuatro anteriores, y aquí importa en la dirección
        // contraria: con el contacto sin resolver esta lectura devolvía SIEMPRE cero citas,
        // así que la red daba por fantasma una confirmación legítima y la desmontaba.
        const citasReales = await getUpcomingAppointments(orgId, await ensureLeadId(orgId, session));
        const citasFmt = citasReales.map(c => ({
            servicio: c.service,
            fecha: toLocalDateStr(new Date(c.starts_at)),
            hora: toLocalTimeStr(new Date(c.starts_at)),
        }));
        const sinRespaldo = unbackedBookingClaim(aiResponse.respuesta, citasFmt.map(c => c.hora));
        if (!sinRespaldo.length) return false;
        logger.error('cita_sante_confirmacion_fantasma', {
            orgId, telefono: userPhone,
            horasAnunciadasSinCita: sinRespaldo,
            citasReales: citasFmt.map(c => `${c.fecha} ${c.hora} ${c.servicio}`),
            respuestaBloqueada: aiResponse.respuesta,
            reservaConfirmada: session.reservaConfirmada,
        });
        resetForSecondBooking(session, sanitized);
        aiResponse.reserva_confirmada = false;
        aiResponse.respuesta = buildCitaFantasmaMsg({ citasReales: citasFmt, language: session.language });
        // El reset deja availableSlots vacío, así que el mensaje de rectificación —que cita
        // la hora REAL de la cita guardada— dispararía respondsWithInventedSlots y acabaría
        // sustituido por un genérico. La marca protege el texto ya verificado contra BD.
        aiResponse._rectificadoPorRedFantasma = true;
        return true;
    } catch (e) {
        // La lectura de citas lanzó (assertRead). No podemos verificar la promesa, así que
        // no la dejamos salir: es preferible pedir que repita a mentirle a la clienta.
        logger.error('cita_fantasma_verificacion_fallida', { orgId, telefono: userPhone, error: e.message });
        aiResponse.reserva_confirmada = false;
        aiResponse.respuesta = salonRetryMsg(session.language);
        aiResponse._rectificadoPorRedFantasma = true;
        return true;
    }
}

// El salón SOLO cierra los domingos (services/providers/openai.js, sección FECHA ACTUAL).
// Cualquier "el salón está cerrado" para lunes-sábado es FALSO por definición — casi
// siempre el LLM confunde "esta estilista no trabaja ese día" con "el negocio no abre"
// (bug real 30/07: pedicura con Olgha un sábado → "el salón está cerrado", cuando Olgha
// solo trabaja martes/jueves/viernes y el salón sí abre los sábados). El prompt ya lo
// prohíbe explícitamente, pero un modelo pequeño no lo respeta siempre — esta es la
// última barrera antes de enviar, igual que respondsWithInventedSlots de arriba.
// Las tres listas se comparan con .includes contra texto YA normalizado, así que los
// literales tienen que estar normalizados también. 'выходной' y 'вихідний' ("día libre")
// llevan й y no casaban nunca: la red dejaba pasar el cierre falso justo cuando el LLM lo
// decía con la palabra más natural en ruso o ucraniano. Se mapean las tres —no solo la que
// falla hoy— para que añadir mañana un día con й no vuelva a romperlas en silencio.
const CLOSURE_CLAIM_WORDS = [
    'cerrado', 'cerrada', 'cerramos', 'no abrimos', 'no abre',
    'closed', 'dont open', "don't open", 'were closed', "we're closed",
    'закрыт', 'закрыто', 'не работаем', 'выходной',
    'закрито', 'не працюємо', 'вихідний',
].map(normalizeText);
const SUNDAY_WORDS = ['domingo', 'sunday', 'воскресенье', 'неділя'].map(normalizeText);
const NON_SUNDAY_DAY_WORDS = [
    'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
    'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота',
    'понеділок', 'вівторок', 'середа', 'четвер', "п'ятниця", 'субота',
].map(normalizeText);
function respondsWithFalseClosureClaim(respuesta) {
    const t = normalizeText(respuesta);
    if (!t) return false;
    if (!CLOSURE_CLAIM_WORDS.some(w => t.includes(w))) return false;
    if (SUNDAY_WORDS.some(w => t.includes(w))) return false; // domingo sí cierra: legítimo
    return NON_SUNDAY_DAY_WORDS.some(w => t.includes(w));
}

// Mensaje de fallback cuando la red anti-invención bloquea una respuesta del LLM que
// ofrecía fecha/hora sin huecos reales cargados. Pide el dato que falta en vez de
// dejar salir horarios inventados. Es sensible al contexto: si aún no hay servicio,
// pregunta por el servicio; si ya lo hay, pregunta por el día.
// Nivel 2 del "no sé qué servicio quieres": en vez de repetir la pregunta abierta, cerrar
// el abanico a las categorías grandes y poner la consulta de valoración sobre la mesa —que
// es justo lo que la clienta estaba pidiendo cuando el bot no la entendía—. Deja
// consultaOfrecida armado para que un "sí" en el turno siguiente la seleccione.
// Elige la variante de un texto fijo según el trato pedido. `formal` puede no tener entrada
// para un idioma (el inglés no distingue tú/usted): entonces cae en la informal, que es
// correcta, en vez de dejar el mensaje vacío.
//
// COBERTURA PARCIAL Y DELIBERADA: solo tienen variante formal los textos del camino que
// recorrió Olga Yarmak (pregunta de servicio, menú de rescate, fuera de horario, oferta de
// persona y acuse de escalada). El resto de literales del salón siguen tuteando. Está
// anotado como deuda en CLAUDE.md: convertirlos todos son cuatro idiomas por dos registros
// y no cabía aquí sin tocar medio fichero.
function porTrato(session, msgs, msgsFormal) {
    const lang = session.language || 'es';
    if (session.tratamiento === 'formal' && msgsFormal) {
        return msgsFormal[lang] || msgs[lang] || msgsFormal.es || msgs.es;
    }
    return msgs[lang] || msgs.es;
}

function salonPickServiceMenuMsg(session) {
    session.consultaOfrecida = true;
    const msgs = {
        es: 'Perdona, no te he entendido bien 😊 Te lo pongo fácil, ¿qué buscas?\n'
            + '• Color o mechas\n• Corte o peinado\n• Tratamiento para el cabello\n'
            + '• Manicura o pedicura\n• Masaje o spa\n\n'
            + 'Y si lo que prefieres es que te lo veamos en persona y te recomendemos, te reservo '
            + 'una consulta de valoración de 20 minutos. ¿Te la reservo?',
        en: 'Sorry, I didn\'t quite get that 😊 Let me make it easy — what are you after?\n'
            + '• Colour or highlights\n• Cut or styling\n• Hair treatment\n'
            + '• Manicure or pedicure\n• Massage or spa\n\n'
            + 'And if you\'d rather we take a look in person and advise you, I can book you a '
            + '20-minute consultation. Shall I?',
        ru: 'Извини, я тебя не совсем поняла 😊 Давай проще — что тебя интересует?\n'
            + '• Окрашивание или мелирование\n• Стрижка или укладка\n• Уход за волосами\n'
            + '• Маникюр или педикюр\n• Массаж или спа\n\n'
            + 'А если хочешь, чтобы мы посмотрели вживую и посоветовали, запишу тебя на '
            + 'консультацию на 20 минут. Записать?',
        uk: 'Вибач, я тебе не зовсім зрозуміла 😊 Давай простіше — що тебе цікавить?\n'
            + '• Фарбування або мелірування\n• Стрижка або укладка\n• Догляд за волоссям\n'
            + '• Манікюр або педикюр\n• Масаж або спа\n\n'
            + 'А якщо хочеш, щоб ми подивилися наживо і порадили, запишу тебе на '
            + 'консультацію на 20 хвилин. Записати?',
    };
    const msgsFormal = {
        es: 'Perdone, no le he entendido bien 😊 Se lo pongo fácil, ¿qué busca?\n'
            + '• Color o mechas\n• Corte o peinado\n• Tratamiento para el cabello\n'
            + '• Manicura o pedicura\n• Masaje o spa\n\n'
            + 'Y si lo que prefiere es que se lo veamos en persona y le recomendemos, le reservo '
            + 'una consulta de valoración de 20 minutos. ¿Se la reservo?',
        ru: 'Извините, я Вас не совсем поняла 😊 Давайте проще — что Вас интересует?\n'
            + '• Окрашивание или мелирование\n• Стрижка или укладка\n• Уход за волосами\n'
            + '• Маникюр или педикюр\n• Массаж или спа\n\n'
            + 'А если хотите, чтобы мы посмотрели вживую и посоветовали, запишу Вас на '
            + 'консультацию на 20 минут. Записать?',
        uk: 'Вибачте, я Вас не зовсім зрозуміла 😊 Давайте простіше — що Вас цікавить?\n'
            + '• Фарбування або мелірування\n• Стрижка або укладка\n• Догляд за волоссям\n'
            + '• Манікюр або педикюр\n• Масаж або спа\n\n'
            + 'А якщо хочете, щоб ми подивилися наживо і порадили, запишу Вас на '
            + 'консультацію на 20 хвилин. Записати?',
    };
    return porTrato(session, msgs, msgsFormal);
}

// ─── Descripción del estado del cabello → rango + consulta (Yulia, 03/08/2026) ────
// Rango pedido por Yulia. NO se deriva del catálogo a propósito: es su cifra comercial,
// no el min/max real (los tratamientos van de 35 € —Green Purity Detox, Reconstrucción
// K18— a 120 € —Brillo intensivo—, y Anti-encrespamiento llega a 180 €). Cambiarlo es
// editar estas dos constantes.
const TRATAMIENTOS_PRECIO_MIN = 45;
const TRATAMIENTOS_PRECIO_MAX = 115;

// Los tratamientos se nombran por FAMILIA, nunca con el nombre exacto de una entrada del
// catálogo: esos nombres cambian (K18 → "Reconstrucción K18" en la migración 026,
// "Hidratación 60min" → "Spa Hidratación 60min" en la 028) y un texto acoplado a ellos se
// queda obsoleto sin que nadie lo note.
function salonHairTreatmentRangeMsg(session) {
    // Deja armada la oferta de consulta: un "sí" en el turno siguiente la selecciona por
    // la vía legítima (mismo gate que consume salonPickServiceMenuMsg).
    session.consultaOfrecida = true;
    const min = TRATAMIENTOS_PRECIO_MIN;
    const max = TRATAMIENTOS_PRECIO_MAX;
    const msgs = {
        es: `Tenemos muchos tratamientos para el cabello 😊 reconstrucción, hidratación, detox `
            + `del cuero cabelludo, tratamientos orgánicos… Van de ${min}€ a ${max}€ según lo que `
            + `necesite tu pelo.\n\nPara acertar, lo mejor es que te lo veamos en persona: en la `
            + `consulta te hacemos un diagnóstico y elegimos juntas el tratamiento adecuado para `
            + `tu caso. ¿Te la reservo?`,
        en: `We have lots of hair treatments 😊 reconstruction, hydration, scalp detox, organic `
            + `treatments… They range from ${min}€ to ${max}€ depending on what your hair needs.\n\n`
            + `To get it right it's best if we see it in person: at the consultation we do a proper `
            + `diagnosis and choose the right treatment for your case together. Shall I book you one?`,
        ru: `У нас много уходов для волос 😊 реконструкция, увлажнение, детокс кожи головы, `
            + `органические уходы… Они стоят от ${min}€ до ${max}€ — зависит от того, что нужно `
            + `твоим волосам.\n\nЧтобы не ошибиться, лучше посмотреть вживую: на консультации мы `
            + `делаем диагностику и вместе подбираем подходящий уход. Записать тебя?`,
        uk: `У нас багато доглядів для волосся 😊 реконструкція, зволоження, детокс шкіри голови, `
            + `органічні догляди… Вони коштують від ${min}€ до ${max}€ — залежить від того, що `
            + `потрібно твоєму волоссю.\n\nЩоб не помилитися, краще подивитися наживо: на `
            + `консультації ми робимо діагностику і разом добираємо відповідний догляд. Записати тебе?`,
    };
    return msgs[session.language] || msgs.es;
}

// Puntas de business_hours (aperturas y cierres, sin repetir) para la exención de
// respondsWithInventedSlots. Devuelve [] cuando no hay horario utilizable, y con [] la
// exención no se aplica: sin saber cuál es el horario no se puede afirmar que una hora lo sea.
function horasLimiteHorario(businessHours) {
    if (!businessHours || typeof businessHours !== 'object') return [];
    const out = new Set();
    for (const dia of Object.values(businessHours)) {
        if (!dia || typeof dia !== 'object') continue;
        for (const h of [dia.apertura, dia.cierre]) {
            const n = normalizeHora(h);
            if (n) out.add(n);
        }
    }
    return [...out];
}

// La clienta ha pedido una hora a la que el salón no está abierto. El mensaje dice el
// horario ENTERO —apertura Y cierre—, no solo que a esa hora esté cerrado: "a las 23:00 ya
// hemos cerrado" la obliga a preguntar otra vez hasta cuándo abren, que es justo el turno
// que estamos intentando ahorrar.
//
// Las tres horas salen de `business_hours` (agent_configs), nunca de una constante: el
// horario lo edita la dueña y un 19:00 escrito aquí mediría antigüedad (regla 5).
// La redacción es NEUTRA respecto a la dirección ("no estamos abiertos", no "ya hemos
// cerrado") porque el mismo mensaje cubre las 08:00 y las 23:00.
function salonFueraDeHorarioMsg(session, { hora, apertura, cierre }) {
    const msgs = {
        es: `A las ${hora} no estamos abiertos 😊 Nuestro horario es de ${apertura} a ${cierre}. `
            + '¿Qué hora dentro de ese horario te viene bien?',
        en: `We're not open at ${hora} 😊 Our hours are ${apertura} to ${cierre}. `
            + 'What time within those works for you?',
        ru: `В ${hora} мы не работаем 😊 Наш график — с ${apertura} до ${cierre}. `
            + 'Какое время в этом промежутке тебе удобно?',
        uk: `О ${hora} ми не працюємо 😊 Наш графік — з ${apertura} до ${cierre}. `
            + 'Який час у цьому проміжку тобі зручний?',
    };
    const msgsFormal = {
        es: `A las ${hora} no estamos abiertos 😊 Nuestro horario es de ${apertura} a ${cierre}. `
            + '¿Qué hora dentro de ese horario le viene bien?',
        ru: `В ${hora} мы не работаем 😊 Наш график — с ${apertura} до ${cierre}. `
            + 'Какое время в этом промежутке Вам удобно?',
        uk: `О ${hora} ми не працюємо 😊 Наш графік — з ${apertura} до ${cierre}. `
            + 'Який час у цьому проміжку Вам зручний?',
    };
    return porTrato(session, msgs, msgsFormal);
}

// Nivel 3 y ÚLTIMO del "no sé qué servicio quieres": ofrecer una persona.
// El menú de rescate no tenía techo — `streak >= 2` es un suelo, no un tope — así que a
// partir del segundo turno sin servicio devolvía el MISMO párrafo indefinidamente. Olga
// Yarmak lo recibió tres veces palabra por palabra (07/08/2026), una de ellas contestando a
// "¿me puedes mandar una foto?". La lección estaba escrita cuatro líneas más arriba desde el
// 02/08 y solo se había aplicado una vez.
//
// OFRECE y espera el "sí": los casos 1-6 del prompt no escalan sin confirmación explícita.
// `pendingEscalation` se arma aquí a mano y no se deja en manos de `offersHumanHandover`,
// que solo reconoce el castellano — para una clienta rusa la oferta se habría quedado
// colgando, que es exactamente el bug que esa red existe para tapar.
function salonOfferHumanMsg(session) {
    session.pendingEscalation = true;
    session.pendingEscalationService = 'traspaso';
    const msgs = {
        es: 'Perdona, no consigo entenderte bien y no quiero hacerte perder más tiempo 🙏 '
            + '¿Quieres que te ponga en contacto con una de nuestras especialistas?',
        en: "Sorry, I'm not managing to understand you and I don't want to waste your time 🙏 "
            + 'Would you like me to put you in touch with one of our specialists?',
        ru: 'Извини, я никак не могу тебя понять и не хочу отнимать у тебя время 🙏 '
            + 'Хочешь, я свяжу тебя с одной из наших специалисток?',
        uk: 'Вибач, я ніяк не можу тебе зрозуміти і не хочу забирати твій час 🙏 '
            + 'Хочеш, я з\'єднаю тебе з однією з наших спеціалісток?',
    };
    const msgsFormal = {
        es: 'Perdone, no consigo entenderle bien y no quiero hacerle perder más tiempo 🙏 '
            + '¿Quiere que le ponga en contacto con una de nuestras especialistas?',
        ru: 'Извините, я никак не могу Вас понять и не хочу отнимать у Вас время 🙏 '
            + 'Хотите, я свяжу Вас с одной из наших специалисток?',
        uk: 'Вибачте, я ніяк не можу Вас зрозуміти і не хочу забирати Ваш час 🙏 '
            + 'Хочете, я з\'єднаю Вас з однією з наших спеціалісток?',
    };
    return porTrato(session, msgs, msgsFormal);
}

function salonNoSlotsMsg(session) {
    const language = session.language;
    if (!session.selectedService) {
        // Segunda vez seguida con el mismo mensaje = bucle. El 02/08/2026 una clienta
        // contestó DOS veces en lenguaje natural ("me tienen que evaluar") y recibió la
        // misma frase las dos; acabó pidiendo un servicio que no quería. Repetir una
        // pregunta que la clienta ya ha respondido no es una respuesta.
        session.sinServicioStreak = (session.sinServicioStreak || 0) + 1;
        // Y el menú tampoco se repite indefinidamente: dos veces y se ofrece una persona.
        if (session.sinServicioStreak >= 4) return salonOfferHumanMsg(session);
        if (session.sinServicioStreak >= 2) return salonPickServiceMenuMsg(session);
        const askService = {
            es: 'Para mirarte los huecos primero necesito saber qué servicio quieres 😊 ¿Qué te apetece hacerte?',
            en: 'To check availability I first need to know which service you\'d like 😊 What are you after?',
            ru: 'Чтобы посмотреть свободное время, мне нужно знать, какая услуга тебя интересует 😊 Что бы ты хотела?',
            uk: 'Щоб подивитися вільний час, мені треба знати, яка послуга тебе цікавить 😊 Що б ти хотіла?',
        };
        const askServiceFormal = {
            es: 'Para mirarle los huecos primero necesito saber qué servicio quiere 😊 ¿Qué le apetece hacerse?',
            ru: 'Чтобы посмотреть свободное время, мне нужно знать, какая услуга Вас интересует 😊 Что бы Вы хотели?',
            uk: 'Щоб подивитися вільний час, мені треба знати, яка послуга Вас цікавить 😊 Що б Ви хотіли?',
        };
        return porTrato(session, askService, askServiceFormal);
    }
    session.sinServicioStreak = 0;

    // El día/fecha que pidió la clienta no tenía hueco real, pero calendar-sante ya
    // buscó y devolvió (en session.availableSlots) los huecos reales más cercanos —
    // ofrecerlos aquí en vez de repreguntar "¿qué día?", que la clienta ya contestó.
    if (session.slotsRequestedDayUnavailable && session.availableSlots?.length) {
        const alternativas = session.availableSlots.slice(0, 3).map(s => calendarSante.formatSlotForMessage(s));
        const lista = alternativas.join(', ');
        const noDayMsg = {
            en: `I don't have anything free that day, but I do have ${lista}. Would any of those work for you?`,
            ru: `На этот день свободного времени нет, но есть ${lista}. Подойдёт что-нибудь из этого?`,
            uk: `На цей день вільного часу немає, але є ${lista}. Підійде щось із цього?`,
        };
        return (language && noDayMsg[language]) || `Ese día no tengo hueco libre, pero sí tengo ${lista}. ¿Te viene bien alguno?`;
    }

    // Cero REAL con el servicio ya conocido: el motor buscó y no hay nada. Antes se caía
    // al "¿qué día te viene mejor?" de abajo —repreguntando lo que la clienta ya había
    // contestado— y el LLM, al ver la lista vacía, anunciaba una avería técnica. Decir la
    // verdad según la causa evita las dos cosas.
    const causa = session.slotsCausaCero;
    if (causa) {
        const msgs = {
            no_cabe_antes_del_cierre: {
                es: 'Ese servicio necesita más tiempo del que queda en la jornada 😅 Lo reservamos mejor a primera hora: ¿qué día te vendría bien?',
                en: "That service needs more time than we have left in the day 😅 It's best first thing in the morning: which day suits you?",
                ru: 'Эта услуга занимает больше времени, чем остаётся в рабочем дне 😅 Лучше записать тебя с утра: какой день подойдёт?',
                uk: 'Ця послуга займає більше часу, ніж лишається в робочому дні 😅 Краще записати тебе зранку: який день підійде?',
            },
            sin_horario: {
                es: 'Justo esos días no tenemos a nadie en agenda 😕 ¿Miramos otra fecha?',
                en: "We don't have anyone scheduled those days 😕 Shall we look at another date?",
                ru: 'В эти дни у нас никого нет в графике 😕 Посмотрим другую дату?',
                uk: 'Саме ці дні у нас нікого немає в графіку 😕 Подивимось іншу дату?',
            },
            // sin_skill / sin_estilistas / agenda_llena comparten el mensaje de "completo":
            // para la clienta el resultado es el mismo y no le interesa el detalle interno.
            _default: {
                es: 'Uy, para esas fechas lo tenemos completo 😕 ¿Quieres que mire la semana siguiente o prefieres otra estilista?',
                en: "We're fully booked for those dates 😕 Shall I check the following week, or would you prefer another stylist?",
                ru: 'На эти даты у нас всё занято 😕 Посмотреть следующую неделю или предпочитаешь другого мастера?',
                uk: 'На ці дати у нас все зайнято 😕 Подивитися наступний тиждень чи волієш іншу майстриню?',
            },
        };
        const set = msgs[causa] || msgs._default;
        return set[language] || set.es;
    }

    const askDay = {
        en: 'What day or week works best for you? I\'ll check the real availability for that 😊',
        ru: 'Какой день или неделя тебе удобнее? Посмотрю реальные свободные окошки 😊',
        uk: 'Який день чи тиждень тобі зручніший? Подивлюся реальні вільні віконця 😊',
    };
    return (language && askDay[language]) || '¿Qué día o semana te viene mejor? Así te miro los huecos reales 😊';
}

// ¿El texto PROMETE a la clienta que el equipo humano toma el relevo? Se exige la pareja
// verbo-de-traspaso + destinatario ("paso/derivo/aviso… a nuestro equipo / a mis compañeras"),
// no solo mencionar al equipo: "el equipo abre a las 10" no es una escalada. Sirve de red
// para que jamás se anuncie un traspaso sin crear la acción pendiente ni avisar por Telegram.
// Verbos de traspaso. "poner en contacto" es la fórmula EXACTA de las preguntas escritas
// en el prompt ("¿Quieres que te ponga en contacto con…"), así que sin ella no se
// reconocían ni la pregunta ni su versión afirmativa.
const HANDOVER_TRASPASO = /\b(paso|pasar|pasare|derivo|derivar|derivare|traslado|trasladar|aviso|avisar|avisare|comento|comentar|escalo|escalar)\b|\b(pongo|ponga|poner|ponerte|pondre|pondria)\s+(te\s+)?en\s+contacto\b/;
// A QUIÉN se traspasa. El prompt manda a "una especialista" en tres de sus cuatro
// preguntas y solo una menciona al "equipo": con el destino limitado al equipo, la
// mayoría de los traspasos de Sante no se reconocían.
// Los destinos nuevos exigen preposición ("con una especialista", "al salón") para no
// confundir al receptor con una mención cualquiera: "los precios del salón" no es un
// traspaso aunque la frase lleve el verbo "paso".
const HANDOVER_DESTINO = new RegExp([
    'nuestro equipo', 'al equipo', 'del equipo', 'el equipo se',
    'mis companer', 'nuestras companer', 'una companer',
    'el salon te', 'te contactara', 'se pondran en contacto', 'se pondra en contacto',
    'atiendan directamente', 'atiendan personalmente',
    '(con|a|al)\\s+(el\\s+)?salon',
    '(con|a)\\s+(una|la|las|nuestra|nuestras|alguna|el)\\s+(especialista|especialistas|tricologa|profesional|profesionales|chicas)',
    'una de nuestras (especialistas|chicas|companeras)',
    '(con|a)\\s+(alguien|una persona|una compañera)',
].join('|'));

// Frase a frase, y SOLO afirmaciones: los casos 1-6 del prompt PIDEN permiso antes de
// escalar ("¿Quieres que te paso con el equipo?"), y esa pregunta no debe disparar nada
// — la escalada llega en el turno siguiente, cuando la clienta dice que sí. Una frase con
// interrogación (de apertura o de cierre) se descarta siempre.
function announcesHumanHandover(respuesta) {
    const t = normalizeText(respuesta);
    if (!t) return false;
    return t.split(/(?<=[.!?])\s+|\n+/)
        .some(frase => !/[?¿]/.test(frase) && HANDOVER_TRASPASO.test(frase) && HANDOVER_DESTINO.test(frase));
}

// La otra mitad del mismo problema: el bot OFRECE el traspaso ("¿quieres que te ponga en
// contacto con una especialista?") y la promesa queda colgando. La regla del prompt le
// prohíbe escalar en ese mismo mensaje y le manda esperar un "sí", pero nadie apuntaba que
// la pregunta se hizo: el "sí" del turno siguiente volvía al LLM, que podía no ponerle
// accion:escalar_humano — y entonces la clienta que dijo que sí no llegaba a nadie.
// Detectar la pregunta permite armar la misma espera que ya usan extensiones/permanente
// (session.pendingEscalation), que sí resuelve el "sí" de forma determinista.
function offersHumanHandover(respuesta) {
    const t = normalizeText(respuesta);
    if (!t) return false;
    return t.split(/(?<=[.!?])\s+|\n+/)
        .some(frase => /[?¿]/.test(frase) && HANDOVER_TRASPASO.test(frase) && HANDOVER_DESTINO.test(frase));
}

// Si se ESCALA, se dice. Es la mitad que le faltaba a announcesHumanHandover, que solo
// miraba el sentido contrario ("lo promete y no lo hace").
//
// Olga Yarmak, 07/08/2026: a las 15:42:10 el LLM puso accion:escalar_humano con motivo
// 'pedir_persona' —fila en pending_actions, bot_mode a manual, aviso por Telegram— y el
// texto que le llegó a ella fue «Прости, я реально запуталась 😅 Объясни мне ещё раз…»,
// pidiéndole que se explicara otra vez justo cuando el bot acababa de dejar de hablarle.
// 44 s después escribió «me niego a hablar con un robot, solo con personas» y recibió
// SILENCIO: correcto con bot_mode en manual, e indistinguible de que la ignorasen.
//
// Se AÑADE, no se sustituye: el texto del modelo suele llevar algo aprovechable (una
// disculpa, una respuesta a medias) y lo que le falta es el acuse, no todo lo demás.
//
// Límite conocido: HANDOVER_TRASPASO/DESTINO son castellano, así que un traspaso ya
// anunciado en ruso no se reconoce y el acuse se añade igual — sale una frase redundante,
// las dos ciertas. Se prefiere a la alternativa (ampliar esos patrones a cuatro idiomas),
// que cambiaría también a quién auto-escala la red del 28/07 y es otro alcance.
const HANDOVER_ACUSE = {
    es: 'Le paso tu mensaje a nuestro equipo para que te atiendan personalmente 🙏',
    en: "I'm passing your message to our team so they can help you personally 🙏",
    ru: 'Передаю твоё сообщение нашей команде, чтобы с тобой связались лично 🙏',
    uk: 'Передаю твоє повідомлення нашій команді, щоб з тобою зв\'язалися особисто 🙏',
};
const HANDOVER_ACUSE_FORMAL = {
    es: 'Le paso su mensaje a nuestro equipo para que le atiendan personalmente 🙏',
    ru: 'Передаю Ваше сообщение нашей команде, чтобы с Вами связались лично 🙏',
    uk: 'Передаю Ваше повідомлення нашій команді, щоб з Вами зв\'язалися особисто 🙏',
};
function ensureHandoverAcknowledged(respuesta, language, tratamiento = null) {
    if (announcesHumanHandover(respuesta)) return respuesta;
    const acuse = porTrato({ language, tratamiento }, HANDOVER_ACUSE, HANDOVER_ACUSE_FORMAL);
    const previo = String(respuesta || '').trim();
    return previo ? `${previo}\n\n${acuse}` : acuse;
}

// Mensaje DETERMINISTA que ofrece los primeros huecos REALES ya cargados. Lo usa la red
// anti-escalada-falsa: cuando el LLM iba a decir "problema técnico" y resulta que sí hay
// calendario, sustituimos su texto por una propuesta verídica en vez de por una disculpa.
// Nunca inventa: sale de session.availableSlots vía formatSlotForMessage.
function salonOfferSlotsMsg(session) {
    const lista = session.availableSlots.slice(0, 3)
        .map(s => calendarSante.formatSlotForMessage(s)).join(', ');
    const msgs = {
        en: `I've got ${lista}. Would any of those work for you?`,
        ru: `Есть ${lista}. Подойдёт что-нибудь из этого?`,
        uk: `Є ${lista}. Підійде щось із цього?`,
    };
    return (session.language && msgs[session.language]) || `Tengo ${lista}. ¿Te viene bien alguno?`;
}

// ─── Estado de servicio: fuente de verdad única ─────────────────────────────
// Cualquier campo de sesión relacionado con la SELECCIÓN DE SERVICIO va aquí.
// clearServiceState() y el test de regresión lo consumen. Añadir un campo nuevo
// de servicio SIN registrarlo aquí hace fallar tests/service-state.test.js.
const SERVICE_STATE_DEFAULTS = {
    selectedService: null,
    selectedStylist: null,
    selectedCategory: null,
    // Búsqueda combinada entre todas las elegibles (no fijar estilista concreta).
    anyStylists: false,
    // Intención sticky "me da igual / el más cercano": sobrevive al recorrido
    // multi-turno del árbol de cortes para no perderse cuando el servicio se
    // resuelve turnos después de que la clienta pidiera el hueco más cercano.
    prefiereMasCercano: false,
    availableSlots: () => [],
    proposedSlots: () => [],
    currentSlotIndex: 0,
    slotsProposed: false,
    datePreferenceAsked: false,
    // La pregunta de estilista se hace UNA vez por servicio; si la respuesta no resuelve
    // nada, el gating cae a búsqueda combinada en vez de repreguntar para siempre.
    stylistQuestionAsked: false,
    // ¿Quedó la pregunta de estilista abierta al cerrar el turno? El turno siguiente lo usa
    // para leer "el más cercano" como respuesta de QUIÉN y no contaminar la fecha con asap.
    stylistQuestionPending: false,
    upsellingSuggested: false,
    upsellingAccepted: () => [],
    _lastUpsellSuggestion: null,
    pendingLargoCategory: null,
    largoPelo: null,
    pendingCorteGenero: false,
    pendingCorteMujerTipo: false,
    pendingCorteNinoTipo: false,
    modoReagendamiento: false,
    // Id de la cita que se está reagendando (UPDATE in-place al confirmar el nuevo hueco).
    // Se limpia con el estado de servicio para no arrastrar un reagendado abandonado.
    reagendarAppointmentId: null,
    guestBooking: false,
    guestName: null,
    // ─── Avisos de mención de estilista (se consumen al construir el prompt) ───
    // Nombre que la clienta pidió y NO existe en el equipo ("Carmen"). Antes esto
    // se descartaba en silencio y el bot seguía proponiendo huecos de otra.
    stylistMentionUnknown: null,
    // Casi-acierto ya corregido: { mencion: 'Iryna', nombre: 'Irina' }. Se asigna la
    // estilista Y se le dice, para que una corrección equivocada sea visible.
    stylistMentionCorrected: null,
    // Estilista real pero sin la skill del servicio: { nombre, rol }.
    stylistMentionNoSkill: null,
    // Mención desconocida sobre la que YA avisamos (normalizada). Evita repetir
    // "no tengo a ninguna Carmen" turno tras turno si el LLM la sigue devolviendo.
    stylistMentionRejected: null,
    // Categoría pedida que aún no resuelve a un servicio concreto ("un masaje" → 9
    // variantes). El turno siguiente resuelve DENTRO de ella: "completo" → "Relajante
    // completo", que contra el catálogo entero empata con "Color completo largo N" y da null.
    pendingServiceCategory: null,
    // Cita ya reservada contra la que se ancla el nuevo servicio: { fecha, horaInicio,
    // horaFin, rel: 'before'|'after' }. Filtra los huecos que se ofrecen.
    anchorAppointment: null,
    // El filtro por ancla dejó la lista vacía: hay huecos, pero no en la ventana pedida.
    anchorFilterVacio: false,
    // ─── Consulta de valoración (categoría REACTIVA) ───────────────────────────
    // La pone a true SÓLO el detector determinista (detectConsultaValoracion). Sin ella,
    // un servicio reactivo que llegue por la vía del LLM se descarta: el 02/08/2026 el
    // modelo ofreció la Consulta por su cuenta —fusionada con la tricológica— y ninguna
    // capa lo impedía porque "reactivo" era prosa del prompt, no un dato.
    consultaValoracionDetectada: false,
    // Veces seguidas que hemos tenido que responder "no sé qué servicio quieres". A la
    // segunda dejamos de repetir la misma frase (ver salonNoSlotsMsg).
    //
    // HALLAZGO ANOTADO, NO ARREGLADO (09/08/2026) — NO viaja en buildSessionExtra, así que se
    // resetea a 0 en cada rehidratación de sesión (timeout de 1 h, GC de 2 h, reinicio del
    // proceso). El nivel 3 del menú de rescate —`>= 4`, ofrecer una persona— es por tanto
    // inalcanzable en cuanto la conversación cruza cualquiera de esas tres cosas. Lo justo es
    // decir que la tapa del bucle solo protege dentro de una misma sesión viva.
    sinServicioStreak: 0,
    // El menú de rescate ya ofreció explícitamente la consulta de valoración: un "sí" en
    // el turno siguiente la selecciona.
    consultaOfrecida: false,
    // Ya le hemos dado el rango de tratamientos (45-115 €) por describir el estado de su
    // cabello. Si vuelve a describirlo sin nombrar servicio NO se repite el párrafo: se
    // selecciona la consulta y se sigue (misma lección que sinServicioStreak).
    rangoTratamientosOfrecido: false,
    // ─── Citas que YA existen ──────────────────────────────────────────────────
    // Cita real de Supabase a la que la clienta se está refiriendo ("es para mi cita de
    // las 6"): { appointmentId, servicio, fecha, hora, horaFin, estilista, stylistId }.
    // Mientras esté puesta, el turno habla de ESA cita y no de una reserva nueva.
    citaEnCurso: null,
    // ─── Nombre antes de reservar ──────────────────────────────────────────────
    // Cuando llega el momento de escribir la cita y no tenemos nombre, se pregunta y la
    // reserva queda EN ESPERA aquí: { slot, intentos, fase: 'nombre'|'apellido' }.
    //
    // Tiene que sobrevivir a una recarga de sesión (va en buildSessionExtra). Si se pierde,
    // la clienta contesta su nombre al vacío y la cita no se guarda nunca — que es
    // exactamente el fallo de session.appointmentId que dio el reagendado duplicado.
    pendingNameForBooking: null,
    // Tope duro: como máximo 2 preguntas entre que elige hueco y la cita queda confirmada.
    // Si el nombre se las gasta, el apellido ya no se pide. Repreguntar en el cierre es la
    // forma más rápida de perder una reserva que ya estaba hecha.
    preguntasCierre: 0,
    // Acción sobre una cita existente que espera respuesta de la clienta:
    //   { estado: 'elegir',    accion, opciones: [citas] }  → "¿cuál de las dos?"
    //   { estado: 'confirmar', accion: 'cancelar', cita }   → "¿la cancelo?"
    // Nada se cancela sobre una intención inferida: un "no puedo ir el miércoles" dicho de
    // otra cosa liberaría un hueco facturable sin vuelta atrás, así que la cita se recita
    // y se espera un sí. Y con dos citas vivas nunca se adivina: adivinar mal cancela la
    // cita equivocada, el peor resultado posible de toda esta funcionalidad.
    pendingCitaAccion: null,
};
// Campos de servicio anidados en partialData (se borran con delete).
const SERVICE_PARTIAL_FIELDS = [
    'servicio', 'categoria_servicio', 'estilista_preferida',
    'preferencia_horaria', 'fecha_cita', 'hora_cita', 'estado_cita', 'notas',
];

// Limpia EXHAUSTIVAMENTE todo el estado de selección de servicio, dejando intactos
// identidad/contacto/idioma/historial y el ciclo de vida de reserva
// (reservaConfirmada/appointmentId los gestiona el caller).
function clearServiceState(session) {
    for (const [k, v] of Object.entries(SERVICE_STATE_DEFAULTS)) {
        session[k] = typeof v === 'function' ? v() : v;
    }
    if (session.partialData) {
        for (const f of SERVICE_PARTIAL_FIELDS) delete session.partialData[f];
    }
}

// La preferencia de semana ya NO vive en un sticky paralelo (session.weekPreference +
// resolveStickyWeek, eliminados). El ÚNICO store es preferencia_horaria y el reducer
// idempotente applyDatePreference (services/date-preference.js) resuelve herencia, correcciones
// y limpiezas: un contexto de semana + un día se colapsa a una `fecha` absoluta, así que no
// queda un `semana` suelto que un turno posterior (o un typo) vuelva a aplicar y desplace.

// ─── Asignación de estilista: ÚNICA autoridad ───────────────────────────────
// Todos los flujos de resolución de servicio (árbol de cortes, mechas/largo y
// cualquiera futuro) resuelven session.selectedService y llaman AQUÍ para decidir
// la estilista. Ningún flujo debe escribir session.selectedStylist a mano (salvo
// los dos puntos de preferencia EXPLÍCITA: nombre en el mensaje / sugerencia LLM).
// Así garantizamos que la señal "el más cercano / me da igual" nunca se salte:
// con varias elegibles NUNCA fijamos una — se deja null para búsqueda combinada.
//   - selectedStylist ya elegida y sigue elegible → se conserva
//   - dejó de ser elegible (cambió el servicio)   → se limpia
//   - exactamente una elegible                     → se asigna
//   - varias sin preferencia clara                 → null (preguntar o combinada)
function assignStylistIfAppropriate(session, eligibleStylists) {
    const eligibles = Array.isArray(eligibleStylists) ? eligibleStylists : [];
    if (session.selectedStylist) {
        if (eligibles.some(s => s.id === session.selectedStylist.id)) return;
        session.selectedStylist = null; // ya no válida → seguir evaluando
    }
    if (eligibles.length === 1) {
        session.selectedStylist = { id: eligibles[0].id, nombre: eligibles[0].name };
        return;
    }
    session.selectedStylist = null;
}

// Decide, según el nº de estilistas elegibles, si toca PREGUNTAR la estilista o
// buscar en modo combinado. Con varias elegibles y ninguna fijada:
//   - la clienta pidió "el más cercano" (prefiereMasCercano) → búsqueda combinada
//     (anyStylists): huecos de todas ordenados por fecha.
//   - si no                                                  → askStylistFirst:
//     preguntar la preferencia ANTES de proponer huecos.
// Con una sola elegible (o una ya fijada) → ninguna de las dos: el flujo avanza.
// Pura y sin efectos: la fuente de verdad del gating vive aquí para poder testearla.
//
// FAIL-SAFE anti-bloqueo (bug de producción del 28/07): la pregunta se hace UNA vez
// (stylistQuestionAsked, sticky igual que datePreferenceAsked). Si la respuesta de la clienta
// no fija estilista ni activa prefiereMasCercano — porque la escribió de una forma que ningún
// detector cubre —, el turno siguiente NO vuelve a preguntar: cae a búsqueda combinada. Antes,
// askStylistFirst se quedaba activo para siempre, loadAvailableSlots no se llamaba nunca,
// availableSlots seguía vacío y el LLM acababa diciendo "problema técnico" y escalando con el
// calendario lleno de huecos. Con esto, el motor SIEMPRE se ejecuta tras un round-trip.
function computeStylistGating(session, eligibleCount) {
    const varias = !!session.selectedService && !session.selectedStylist && eligibleCount > 1;
    const askStylistFirst = varias && !session.prefiereMasCercano && !session.stylistQuestionAsked;
    return { anyStylists: varias && !askStylistFirst, askStylistFirst };
}

// ¿Aceptamos la estilista que INFIRIÓ el LLM (datos.estilista_preferida)?
// NO si en este mismo turno seguimos preguntando la elección (askStylistFirst):
// ahí la clienta todavía no ha respondido, así que una estilista devuelta por el
// LLM proviene del historial (su habitual / última visita), no de una respuesta
// real. Fijarla se saltaría la pregunta — el bug de clienta recurrente + varias
// elegibles. (Si la clienta SÍ nombró una estilista en su mensaje, la resolución
// determinista previa ya la fijó y askStylistFirst habría quedado en false.)
function shouldFixStylistFromLlm(session) {
    return !session.selectedStylist && !session.askStylistFirst;
}

// ─── Mención de estilista: veredicto → estado de sesión ─────────────────────
// Punto ÚNICO donde una mención de la clienta se convierte en estado. Los dos
// sitios que la resuelven (texto directo pre-LLM y datos.estilista_preferida
// post-LLM) comparten estas reglas para que no puedan divergir:
//   exact / fuzzy elegible → se fija la estilista (fuzzy deja además el aviso de
//                            corrección: se asigna Y se le dice, para que una
//                            corrección equivocada sea visible en el acto)
//   exact / fuzzy sin skill→ NO se fija, pero se deja constancia para explicarlo
//   unknown                → no se fija nada, y se deja constancia para ofrecerle
//                            el equipo que sí puede atenderla
// Antes, los tres casos que no eran "exact elegible" caían en un `if` sin `else`:
// la petición se descartaba en silencio y el flujo seguía como si nada.
// Devuelve true si cambió selectedStylist.
function applyStylistMention(session, verdict, { orgId, telefono } = {}) {
    if (!verdict || verdict.status === 'none') return false;

    if (verdict.status === 'unknown') {
        // Sin repetir: si ya avisamos por esta misma mención, no reabrimos el tema
        // cada turno (el LLM tiende a devolver el nombre inventado una y otra vez).
        if (normalizeText(verdict.mencion) !== session.stylistMentionRejected) {
            session.stylistMentionUnknown = verdict.mencion;
        }
        logger.info('stylist_mention_unknown', { orgId, telefono, mencion: verdict.mencion });
        return false;
    }

    const sty = verdict.stylist;
    if (!sty) return false;

    if (!stylistCanDoService(sty, session.selectedService)) {
        session.stylistMentionNoSkill = { nombre: sty.name, rol: sty.role || null };
        logger.info('stylist_mention_sin_skill', {
            orgId, telefono, estilista: sty.name, servicio: session.selectedService?.nombre || null,
        });
        return false;
    }

    if (verdict.status === 'fuzzy' && normalizeText(verdict.mencion) !== normalizeText(sty.name)) {
        session.stylistMentionCorrected = { mencion: verdict.mencion, nombre: sty.name };
        logger.info('stylist_mention_corregida', {
            orgId, telefono, mencion: verdict.mencion, estilista: sty.name,
        });
    }

    if (sty.id === session.selectedStylist?.id) return false;
    // Cambio de estilista en pleno flujo (tenía Veronika y ahora pide Irina):
    // invalidamos los huecos de la anterior para no proponer disponibilidad ajena.
    if (session.selectedStylist) {
        session.availableSlots = [];
        session.currentSlotIndex = 0;
    }
    session.selectedStylist = { id: sty.id, nombre: sty.name };
    session.anyStylists = false;
    session.prefiereMasCercano = false; // preferencia explícita anula "el más cercano"
    return true;
}

// ─── Segunda reserva en la misma conversación (Sante) ───────────────────────
// Tras confirmar una cita, la clienta puede pedir otra (para ella o un acompañante).
// Reiniciamos SOLO el estado de reserva, conservando idioma, contacto e historial,
// para que el flujo arranque limpio y guarde también esta segunda cita.
function resetForSecondBooking(session, sanitized) {
    session.reservaConfirmada = false;
    session.appointmentId = null;
    clearServiceState(session);
    session.leadStatus = 'in_progress';

    // ¿Es para otra persona? Pedimos su nombre; si ya viene en el mensaje, lo capturamos.
    const esInvitado = detectGuestBooking(sanitized);
    session.guestBooking = esInvitado;
    session.guestName = esInvitado ? extractGuestName(sanitized) : null;

    logger.info('segunda_reserva_iniciada', {
        orgId: session.orgId, guestBooking: session.guestBooking, guestName: session.guestName || null,
    });
}

// ─── Citas REALES de la clienta: resolución única por turno ──────────────────
// La ÚNICA fuente de verdad sobre "qué citas tiene esta persona". De aquí salen tanto las
// respuestas deterministas (consultar / referirse / cambiar / cancelar) como el bloque
// __citasVivas que ve el LLM: si el dato saliera de dos sitios distintos, volveríamos a
// tener un modelo capaz de contradecir a la agenda.
//
// Dos decisiones que son el arreglo, no un detalle:
//
// 1. Se resuelve el CONJUNTO de contact_ids que comparten teléfono, no session.leadId a
//    secas. Con contactos duplicados (mismo número en dos formatos) la cita cuelga de la
//    fila que no es y buscar por un solo id devuelve vacío: el bot le dice a la clienta
//    que no tiene ninguna cita teniéndola. Incidente Valeria, 01/08/2026.
//
// 2. Devuelve null —no []— si la lectura falla. "No tienes ninguna cita" y "no he podido
//    mirarlo" son cosas distintas, y confundirlas es la versión de lectura de la cita
//    fantasma: afirmar con seguridad algo que no se ha verificado.
//
// Memoizada por turno en session._citasVivasTurno (no se persiste: no está en
// buildSessionExtra). La red anti-cita-fantasma NO la usa a propósito — necesita releer
// después del LLM, porque finalizarCitaSante puede haber escrito en medio del turno.
async function resolveCitasVivas(orgId, session) {
    if (session._citasVivasTurno !== undefined) return session._citasVivasTurno;
    let citas = null;
    try {
        const ids = new Set();
        if (session.leadId) ids.add(session.leadId);
        for (const id of await findContactIdsByPhone(orgId, session.partialData?.telefono)) {
            ids.add(id);
        }
        const filas = ids.size ? await getUpcomingAppointments(orgId, [...ids]) : [];
        citas = filas.map(c => ({
            id: c.id,
            servicio: c.service,
            fecha: toLocalDateStr(new Date(c.starts_at)),
            hora: toLocalTimeStr(new Date(c.starts_at)),
            horaFin: c.ends_at ? toLocalTimeStr(new Date(c.ends_at)) : null,
            estilista: c.stylists?.name || null,
            stylistId: c.stylist_id || null,
            status: c.status,
        }));
        if (citas.length) {
            logger.info('citas_vivas_resueltas', {
                orgId, contactos: ids.size, citas: citas.length,
                duplicados: ids.size > 1,
            });
        }
    } catch (e) {
        logger.error('error_resolver_citas_vivas', { orgId, error: e.message });
        citas = null;
    }
    session._citasVivasTurno = citas;
    return citas;
}

// Día de la semana de un 'YYYY-MM-DD' con la convención del proyecto (0=Lunes…6=Domingo,
// la misma de stylist_schedules y DIA_SEMANA_MAP). Mediodía para no bailar con la TZ.
function dowLunes0(fecha) {
    const d = new Date(`${fecha}T12:00:00`);
    return isNaN(d) ? null : (d.getDay() + 6) % 7;
}

// Localiza la cita de la que habla la clienta entre las que TIENE de verdad. Devuelve:
//   { cita }                    → una sola candidata: sabemos de cuál habla
//   { candidatas: [...] }       → varias: hay que preguntar, nunca elegir por ella
//   { contradice: true }        → dijo una hora/día que no casa con ninguna cita suya
// La última es la importante: "mi cita de las 6" cuando su cita es a las 17:00 significa que
// una de las dos partes está equivocada, y responder sobre otra cita distinta sería peor que
// admitir que no cuadra.
function matchCitaByPistas(citas, pistas) {
    const lista = citas || [];
    if (!lista.length) return { contradice: false, candidatas: [] };
    let cands = lista;
    if (pistas?.horas?.length) {
        const porHora = cands.filter(c => pistas.horas.includes(c.hora));
        if (!porHora.length) return { contradice: true, candidatas: [] };
        cands = porHora;
    }
    if (pistas?.diaSemana !== null && pistas?.diaSemana !== undefined) {
        const porDia = cands.filter(c => dowLunes0(c.fecha) === pistas.diaSemana);
        if (!porDia.length) return { contradice: true, candidatas: [] };
        cands = porDia;
    }
    if (pistas?.servicio) {
        const porSvc = cands.filter(c => matchesServiceName(c.servicio, pistas.servicio));
        if (porSvc.length) cands = porSvc;
    }
    return cands.length === 1 ? { cita: cands[0], candidatas: cands } : { contradice: false, candidatas: cands };
}

// Carga en la sesión la cita REAL sobre la que se está hablando. Es lo que apaga el camino
// de "reserva nueva" y, de paso, devuelve la vida a la maquinaria que ya existía: con
// appointmentId y selectedService puestos, el upselling y el multi-servicio vuelven a
// operar sobre la cita correcta aunque se reservara días atrás en otra sesión.
async function hidratarCitaEnSesion(orgId, session, cita) {
    session.citaEnCurso = {
        appointmentId: cita.id, servicio: cita.servicio, fecha: cita.fecha,
        hora: cita.hora, horaFin: cita.horaFin, estilista: cita.estilista, stylistId: cita.stylistId,
    };
    session.appointmentId = cita.id;
    session.reservaConfirmada = true;
    session.partialData.fecha_cita = cita.fecha;
    session.partialData.hora_cita = cita.hora;
    session.partialData.estado_cita = 'confirmado';
    try {
        if (!session.selectedService && cita.servicio) {
            // Una cita multi-servicio guarda "A + B" en una sola fila (ver saveAppointment):
            // no resuelve a una entrada del catálogo y forzarlo elegiría media cita.
            if (!/\s\+\s/.test(cita.servicio)) {
                const catalogo = (await getAgentConfig(orgId))?.services || [];
                const svc = catalogo.find(s => matchesServiceName(s.nombre, cita.servicio));
                if (svc) session.selectedService = svc;
            }
        }
        if (cita.stylistId && !session.selectedStylist) {
            const st = (await getStylistsByOrg(orgId) || []).find(s => s.id === cita.stylistId);
            if (st) session.selectedStylist = st;
        }
    } catch (e) {
        // El contexto es un extra: sin él la cita sigue identificada y las acciones funcionan.
        logger.error('cita_existente_contexto_no_resuelto', { orgId, appointmentId: cita.id, error: e.message });
    }
}

const CANCEL_OK_MSGS = {
    es: 'Tu cita ha sido cancelada ✅ Si quieres reservar otra, dímelo cuando quieras 😊',
    en: "Your appointment has been cancelled ✅ If you'd like to book another, just let me know 😊",
    ru: 'Запись отменена ✅ Если захочешь записаться снова, напиши мне 😊',
    uk: 'Запис скасовано ✅ Якщо захочеш записатися знову, напиши мені 😊',
};
const CANCEL_NO_MSGS = {
    es: 'Perfecto, la dejo como está 😊',
    en: 'Perfect, I\'ll leave it as it is 😊',
    ru: 'Хорошо, оставляю запись без изменений 😊',
    uk: 'Добре, залишаю запис без змін 😊',
};

// Ejecuta la cancelación YA confirmada. El invariante, gemelo del de la red anti-cita-fantasma
// pero en la otra dirección: ningún mensaje que afirme una cancelación sale sin que la
// escritura haya ocurrido. Antes, con appointmentId perdido tras un timeout, el bot decía
// "cancelada ✅" sin tocar la base de datos y la clienta no aparecía el día de su cita.
async function ejecutarCancelacion(orgId, session, cita, _send, userPhone) {
    try {
        const r = await calendarSante.cancelAppointment(orgId, cita.id);
        if (!r?.success) throw new Error('cancelAppointment sin efecto');
    } catch (e) {
        // updateAppointment usa .single(): PGRST116 = la cita ya no existe. Cualquier otro
        // código es un fallo de escritura con la cita AÚN VIVA. En los dos casos se dice la
        // verdad y lo recoge una persona.
        logger.error('cita_cancelacion_fallida', {
            orgId, telefono: userPhone, appointmentId: cita.id, code: e.code || null, error: e.message,
        });
        await _send(buildCancelFalloMsg(session.language));
        await escalateToHuman(session, userPhone, 'cancelacion_fallida', `Cancelar ${cita.fecha} ${cita.hora} ${cita.servicio || ''}`);
        return true;
    }
    logger.info('cita_cancelada', {
        orgId, telefono: userPhone, appointmentId: cita.id, fecha: cita.fecha, hora: cita.hora,
    });
    session.reservaConfirmada = false;
    session.appointmentId = null;
    clearServiceState(session);   // limpia también citaEnCurso y pendingCitaAccion
    try {
        await updateLead(orgId, { telefono: session.partialData.telefono, estado_cita: 'cancelado', leadId: session.leadId });
    } catch (e) {
        // La cita YA está cancelada en la agenda; sincronizar la ficha es contabilidad
        // posterior y no puede convertir un éxito en un mensaje de error.
        logger.error('cita_cancelada_lead_no_sincronizado', { orgId, appointmentId: cita.id, error: e.message });
    }
    await _send(CANCEL_OK_MSGS[session.language] || CANCEL_OK_MSGS.es);
    return true;
}

// Arranca la acción sobre una cita ya identificada. Cancelar pide confirmación recitándola;
// cambiar entra en modo reagendado con el id REAL de Supabase — que es justo lo que faltaba:
// handleAppointmentAction dependía de session.appointmentId, que el salón no persiste, así
// que tras un timeout el reagendado creaba una cita nueva y dejaba viva la vieja.
async function iniciarAccionSobreCita(client, orgId, session, cita, accion, _send, userPhone) {
    await hidratarCitaEnSesion(orgId, session, cita);
    if (accion === 'referir') return false;   // solo identificarla: el turno sigue su curso
    if (accion === 'cancelar') {
        session.pendingCitaAccion = { estado: 'confirmar', accion: 'cancelar', cita };
        await _send(buildCancelConfirmMsg({ cita, language: session.language }));
        return true;
    }
    logger.info('cita_reagendado_iniciado', { orgId, telefono: userPhone, appointmentId: cita.id });
    return handleAppointmentAction(client, session, userPhone, 'cambiar');
}

// ¿Ampliar la cita hasta `endsAt` pisaría la siguiente cita de esa estilista? Se mira la
// agenda REAL del día, no la sesión. Importa sobre todo al añadir un servicio a una cita
// reservada en otra sesión: entonces la duración original ya está encajada entre otras dos
// citas y alargarla por detrás crea un solape que nadie ve hasta el día de la cita.
async function ampliacionSolapa(orgId, apt, endsAt) {
    if (!apt?.stylist_id || !apt?.starts_at) return false;   // sin estilista no hay agenda que pisar
    const desde = new Date(apt.starts_at);
    const finDia = new Date(desde);
    finDia.setHours(23, 59, 59, 999);
    const citas = await getAppointmentsByStylistAndRange(orgId, apt.stylist_id, desde.toISOString(), finDia.toISOString());
    return (citas || []).some(c => c.id !== apt.id && new Date(c.starts_at) < endsAt);
}

// ─── Turno que habla de una cita que YA existe (Sante) ───────────────────────
// El agujero de fondo del incidente de Valeria: el bot no tenía forma de mirar una cita ya
// reservada, así que "es para mi cita de las 6" caía en el flujo de reserva y abría una cita
// nueva. Este bloque corre ANTES que el de segunda reserva justamente porque es ese el que
// hacía la conversión.
//
// Devuelve true si el turno queda resuelto aquí (el llamador persiste y sale) y false para
// dejarlo seguir. Los dos "false" importantes: cuando la clienta NO tiene ninguna cita —el
// flujo de reserva de siempre no se toca— y cuando solo se ha identificado la cita a la que
// se refiere, que se deja cargada en sesión para que el resto del pipeline opere sobre ella.
async function handleCitasExistentes(client, orgId, session, sanitized, _send, userPhone) {
    const lang = session.language;

    // ── 0. Respuesta a lo que preguntamos el turno anterior ──────────────────
    // La escalada pendiente tiene prioridad: también consume un "sí" y ya estaba antes.
    if (session.pendingCitaAccion && !session.pendingEscalation) {
        const pend = session.pendingCitaAccion;
        session.pendingCitaAccion = null;

        if (pend.estado === 'confirmar') {
            if (isAffirmative(sanitized)) return ejecutarCancelacion(orgId, session, pend.cita, _send, userPhone);
            if (isNegative(sanitized)) {
                logger.info('cita_cancelacion_rechazada', { orgId, telefono: userPhone, appointmentId: pend.cita.id });
                await _send(CANCEL_NO_MSGS[lang] || CANCEL_NO_MSGS.es);
                return true;
            }
        } else if (pend.estado === 'elegir') {
            const m = matchCitaByPistas(pend.opciones, { ...extractCitaPistas(sanitized), servicio: sanitized });
            if (m.cita) return iniciarAccionSobreCita(client, orgId, session, m.cita, pend.accion, _send, userPhone);
        }

        // Ni sí/no ni una elección reconocible. Se repite la pregunta UNA vez y a la segunda
        // se suelta el turno: insistir con la misma frase es cómo se construye un bucle.
        if (!pend.repetida) {
            session.pendingCitaAccion = { ...pend, repetida: true };
            await _send(pend.estado === 'confirmar'
                ? buildCancelConfirmMsg({ cita: pend.cita, language: lang })
                : buildElegirCitaMsg({ citas: pend.opciones, accion: pend.accion, language: lang }));
            return true;
        }
        logger.info('cita_accion_abandonada', { orgId, telefono: userPhone, estado: pend.estado });
    }

    // ── 1. ¿Habla este mensaje de una cita que ya existe? ────────────────────
    const query   = detectAppointmentQuery(sanitized);
    const ref     = detectExistingAppointmentReference(sanitized);
    const cancel  = detectCancelRequest(sanitized);
    const resched = detectRescheduleRequest(sanitized);
    if (!query && !ref && !cancel && !resched) return false;

    // Con huecos propuestos sobre la mesa, "no puedo ir el miércoles" es el RECHAZO del
    // hueco que acabamos de ofrecer, no una cancelación. Y una referencia a secas no debe
    // secuestrar la aceptación de un hueco. Las señales explícitas sí pasan.
    if (session.slotsProposed && !query) {
        if (cancel?.fuerza === 'implicita' && !ref) return false;
        if (ref && !cancel && !resched) return false;
    }

    // ── 2. La verdad: qué citas tiene realmente ──────────────────────────────
    const citas = await resolveCitasVivas(orgId, session);
    if (citas === null) {
        // No se ha podido mirar. "No tienes ninguna cita" y "no he podido comprobarlo" no son
        // lo mismo: afirmar lo primero sin haber leído es la cita fantasma en versión lectura.
        await _send(salonRetryMsg(lang));
        return true;
    }
    if (!citas.length) {
        // Sin citas NO se toca el flujo de quien viene a reservar por primera vez. Solo se
        // contesta si preguntaba explícitamente por una cita suya — y así un "cancélamela"
        // sin nada que cancelar tampoco puede acabar en un "cancelada ✅".
        if (query || cancel?.fuerza === 'explicita' || resched) {
            logger.info('cita_consultada_sin_citas', { orgId, telefono: userPhone });
            await _send(buildCitasVivasMsg({ citas: [], language: lang }));
            return true;
        }
        return false;
    }

    const pistas = ref || extractCitaPistas(sanitized);
    const noCasa = async () => {
        logger.info('cita_referida_no_casa', { orgId, telefono: userPhone, pistas });
        await _send(buildCitasVivasMsg({ citas, campo: 'no_casa', language: lang }));
        return true;
    };

    // ── 3. Cancelar / cambiar ────────────────────────────────────────────────
    if (cancel || resched) {
        const accion = cancel ? 'cancelar' : 'cambiar';
        const m = matchCitaByPistas(citas, pistas);
        if (m.contradice) return noCasa();
        if (m.cita) return iniciarAccionSobreCita(client, orgId, session, m.cita, accion, _send, userPhone);
        session.pendingCitaAccion = { estado: 'elegir', accion, opciones: m.candidatas };
        logger.info('cita_accion_ambigua', { orgId, telefono: userPhone, accion, opciones: m.candidatas.length });
        await _send(buildElegirCitaMsg({ citas: m.candidatas, accion, language: lang }));
        return true;
    }

    // ── 4. Consultar ─────────────────────────────────────────────────────────
    if (query) {
        const m = matchCitaByPistas(citas, pistas);
        if (m.contradice) return noCasa();
        logger.info('cita_consultada', { orgId, telefono: userPhone, campo: query.campo, citas: citas.length });
        await _send(buildCitasVivasMsg({
            citas: m.cita ? [m.cita] : m.candidatas, campo: query.campo, language: lang,
        }));
        return true;
    }

    // ── 5. Referirse a la cita ("es para mi cita de las 6") ──────────────────
    const m = matchCitaByPistas(citas, pistas);
    if (m.contradice) return noCasa();
    if (!m.cita) {
        session.pendingCitaAccion = { estado: 'elegir', accion: 'referir', opciones: m.candidatas };
        await _send(buildElegirCitaMsg({ citas: m.candidatas, accion: 'referir', language: lang }));
        return true;
    }
    await hidratarCitaEnSesion(orgId, session, m.cita);
    logger.info('cita_existente_referida', {
        orgId, telefono: userPhone, appointmentId: m.cita.id, fecha: m.cita.fecha, hora: m.cita.hora,
    });
    return false;   // el turno sigue, ya con la cita correcta cargada
}

// Cita REAL contra la que ancla un "antes de …" / "después de …": la próxima cita viva de
// la clienta, leída de Supabase (no de la sesión: appointmentId no se persiste para salón).
// Devuelve { fecha, horaInicio, horaFin } en hora local de negocio, o null.
async function resolveAnchorAppointment(orgId, session) {
    const citas = await resolveCitasVivas(orgId, session);
    if (!citas || !citas.length) return null;
    const c = citas[0]; // ordenadas por starts_at ascendente
    return { fecha: c.fecha, horaInicio: c.hora, horaFin: c.horaFin };
}

// Deja en `availableSlots` solo los huecos que encajan con el ancla ("un masaje ANTES de la
// pedicura de las 16:00"): mismo día y sin solaparse con la cita que ya tiene.
// Si el filtro se queda sin huecos NO devolvemos "no hay disponibilidad" —eso sería
// mentira, los huecos existen fuera de la ventana pedida—: se conserva la lista completa y
// se marca `anchorFilterVacio` para que el mensaje lo diga.
// `duracionServicioMin` la calcula quien carga los huecos (la MISMA con la que se buscó y
// con la que se escribirá ends_at). No se vuelve a deducir aquí: este filtro decide si un
// masaje cabe ANTES de la pedicura, y medirlo con un 60 inventado sobre un servicio de
// 360 deja pasar huecos que se comen la cita que la clienta ya tiene.
function applyAnchorFilter(session, duracionServicioMin) {
    const anchor = session.anchorAppointment;
    if (!anchor || !anchor.rel || !Array.isArray(session.availableSlots) || !session.availableSlots.length) return;
    const toMin = hhmm => { const [H, M] = String(hhmm).split(':').map(Number); return H * 60 + M; };
    const durArg = Number(duracionServicioMin);
    let dur = durArg;
    if (!Number.isFinite(durArg) || durArg <= 0) {
        // Sin duración de quien llama: se resuelve con lo que haya en sesión y se avisa.
        const r = resolveAppointmentDurationMin(session.selectedService, []);
        dur = r.minutos;
        logger.warn('ancla_duracion_no_recibida', {
            orgId: session.orgId, servicio: session.selectedService?.nombre || null,
            resuelto: r.resuelto, minutosUsados: dur,
        });
    }
    const inicioAncla = toMin(anchor.horaInicio);
    // Sin `horaFin` no sabemos cuándo acaba la cita ancla, así que "después de" se mide
    // contra un final supuesto. Pasa solo si la cita no tiene ends_at, que no debería
    // ocurrir: si aparece en los logs, el dato de origen está roto.
    if (!anchor.horaFin) {
        logger.warn('ancla_sin_hora_fin', {
            orgId: session.orgId, fecha: anchor.fecha, horaInicio: anchor.horaInicio,
            minutosAsumidos: DURACION_CITA_FALLBACK_MIN,
        });
    }
    const finAncla = anchor.horaFin ? toMin(anchor.horaFin) : inicioAncla + DURACION_CITA_FALLBACK_MIN;
    const encajan = session.availableSlots.filter(s => {
        if (s.fecha !== anchor.fecha) return false;
        const ini = toMin(s.hora);
        return anchor.rel === 'before' ? (ini + dur <= inicioAncla) : (ini >= finAncla);
    });
    session.anchorFilterVacio = !encajan.length;
    if (encajan.length) {
        session.availableSlots = encajan;
        session.currentSlotIndex = 0;
    }
    logger.info('ancla_filtro_huecos', {
        orgId: session.orgId, rel: anchor.rel, fecha: anchor.fecha,
        huecosAntes: session.availableSlots.length, huecosQueEncajan: encajan.length,
    });
}

// Decide si la clienta ha aceptado un hueco y devuelve { slot, motivo } o null.
// No nos fiamos solo del flag del LLM (lo omite a menudo y dice "te he reservado" sin
// disparar el guardado → fallo silencioso). Reservamos cuando: (1) el LLM pone el flag,
// (2) el LLM devuelve una hora que coincide con un hueco real, (3) la clienta responde
// afirmativamente DESPUÉS de que ya le hayamos propuesto huecos, o (4) el propio texto del
// LLM afirma que la cita queda reservada. Guardas: tiene que haber servicio y huecos
// cargados, para no reservar prematuramente.
function resolveSalonConfirmation(session, aiResponse, sanitized, frozenProposed) {
    if (session.reservaConfirmada) return null;
    if (!session.selectedService) return null;
    // Basta con tener bien la lista de huecos que la clienta VIO (frozenProposed) O
    // los huecos reales actuales. No abortamos solo porque una recarga pre-LLM haya
    // vaciado availableSlots (típico en servicios largos con pref estrecha): el hueco
    // elegido se identifica desde frozenProposed y se re-verifica antes de guardar.
    if (!(session.availableSlots || []).length && !(frozenProposed || []).length) return null;

    // Bug 3: si la clienta no ha visto huecos propuestos en un turno anterior,
    // no confirmar — esperar a que los vea y responda explícitamente.
    if (!frozenProposed || !frozenProposed.length) {
        // Excepción (slot directo): la clienta pidió un hueco concreto ("mañana a las 11
        // con Irina") sin pasar por la lista de huecos propuestos. Si el LLM confirma la
        // cita Y ese hueco EXACTO (fecha + hora + estilista) existe en los huecos reales
        // disponibles, permitimos la confirmación aunque no haya propuesta previa.
        if (aiResponse.reserva_confirmada) {
            const horaReq = normalizeHora(aiResponse.datos?.hora_cita);
            const fechaReq = aiResponse.datos?.fecha_cita || null;
            if (horaReq && fechaReq) {
                let matches = (session.availableSlots || []).filter(
                    s => s.fecha === fechaReq && normalizeHora(s.hora) === horaReq
                );
                // Desambiguar por estilista si la clienta indicó una (o ya está fijada).
                if (session.selectedStylist?.id) {
                    matches = matches.filter(s => s.stylistId === session.selectedStylist.id);
                } else if (aiResponse.datos?.estilista_preferida) {
                    const wanted = normalizeText(aiResponse.datos.estilista_preferida);
                    matches = matches.filter(s => {
                        const sn = normalizeText(s.stylistName || '');
                        return sn && (sn.includes(wanted) || wanted.includes(sn));
                    });
                }
                if (matches.length === 1) {
                    logger.info('resolveSalonConfirmation_slot_directo', {
                        fecha: matches[0].fecha, hora: matches[0].hora, stylist: matches[0].stylistName,
                    });
                    return { slot: matches[0], motivo: 'slot_directo_sin_propuesta' };
                }
            }
        }
        logger.info('resolveSalonConfirmation_skip', { reason: 'clienta_no_ha_visto_huecos' });
        return null;
    }

    // Bug 1: la clienta expresó una FECHA ("1 de julio") sin hora concreta → es
    // preferencia de día, no selección de hueco. No confirmamos: los slots ya se
    // recargan filtrados por esa fecha en la lógica pre-LLM y se le re-proponen.
    if (messageHasDateWithoutTime(sanitized)) {
        logger.info('resolveSalonConfirmation_skip', { reason: 'fecha_sin_hora' });
        return null;
    }

    // Usamos los huecos que la clienta VIO (frozenProposed, capturados antes de cualquier
    // recarga de huecos en este turno).
    const proposed = frozenProposed;

    if (aiResponse.reserva_confirmada) {
        const slot = pickChosenSlot(session, aiResponse.datos, proposed);
        if (slot) return { slot, motivo: 'llm_flag' };
    }

    // Match por hora: exige fecha si varios huecos comparten esa hora (evita coger el día
    // más temprano por error). pickChosenSlot ya aplica esta regla de no-ambigüedad.
    const horaSel = normalizeHora(aiResponse.datos?.hora_cita);
    if (horaSel) {
        const slot = pickChosenSlot(session, aiResponse.datos, proposed);
        if (slot) return { slot, motivo: 'match_hora' };
    }

    if (session.slotsProposed && isAffirmative(sanitized)) {
        const slot = pickChosenSlot(session, aiResponse.datos, proposed);
        if (slot) return { slot, motivo: 'afirmativo_tras_propuesta' };
    }

    if (session.slotsProposed && llmClaimsBooked(aiResponse.respuesta)) {
        const slot = pickChosenSlot(session, aiResponse.datos, proposed);
        if (slot) return { slot, motivo: 'texto_llm_confirma' };
    }

    return null;
}

// ─── Finalización directa de cita (Sante) ───────────────────────────────────
// Devuelve true SOLO si la cita se guardó en Supabase. Marca la sesión como
// confirmada únicamente en ese caso, para no decirle a la clienta que está
// confirmada cuando en realidad no se ha persistido nada.
// ─── Nombre antes de reservar ────────────────────────────────────────────────
//
// Ninguna de estas frases puede sonar a cita hecha: se emiten en un turno en el que NO se ha
// escrito nada en Supabase. Sin ✅, sin "reservada", sin fecha ni hora. Si alguna sonara a
// confirmación, la red anti-cita-fantasma tendría razón en bloquearla — y la clienta se
// creería que ya tiene cita. Hay test que lo comprueba contra llmClaimsBooked.
//
// El segundo intento NO repite la primera frase. Repetir literalmente la misma pregunta es
// lo que hace pensar que el bot se ha colgado (misma lección que sinServicioStreak).
const PREGUNTA_NOMBRE = {
    1: {
        es: '¿A nombre de quién la pongo? 😊',
        en: "What name should I put it under? 😊",
        ru: 'На чьё имя записать? 😊',
        uk: 'На чиє ім\'я записати? 😊',
    },
    2: {
        es: 'Perdona, ¿me dices tu nombre para la cita? 😊',
        en: "Sorry, could you tell me your name for the appointment? 😊",
        ru: 'Извини, подскажи, пожалуйста, своё имя для записи 😊',
        uk: 'Вибач, підкажи, будь ласка, своє ім\'я для запису 😊',
    },
};

const PREGUNTA_APELLIDO = {
    es: '¿Y tu apellido? 😊',
    en: 'And your surname? 😊',
    ru: 'А фамилию? 😊',
    uk: 'А прізвище? 😊',
};

function preguntaNombreMsg(session, intento) {
    const set = PREGUNTA_NOMBRE[intento] || PREGUNTA_NOMBRE[1];
    return set[session.language] || set.es;
}

function preguntaApellidoMsg(session) {
    return PREGUNTA_APELLIDO[session.language] || PREGUNTA_APELLIDO.es;
}

// Mensaje de confirmación de Sante a partir del estado de la sesión.
//
// Extraído del camino del LLM para que la reserva que se completa tras preguntar el nombre
// produzca EXACTAMENTE el mismo mensaje, en vez de una copia que se desincronice con el
// tiempo (el precio y la duración salen de sumar el servicio y los upsells aceptados: dos
// sitios calculándolo por separado acaban dando cifras distintas en la factura y en el chat).
async function mensajeConfirmacionSante(orgId, session, { upsellSug = null, upsellTono = null } = {}) {
    const cfg = await getAgentConfig(orgId).catch(() => null);
    const catalogo = cfg?.services || [];
    const info = cfg?.business_info || {};
    const svc = session.selectedService || {};
    const upsellingDur = (session.upsellingAccepted || []).reduce(
        (sum, name) => sum + resolveServiceDurationMin(name, catalogo), 0);
    // El precio de este mensaje es lo que la clienta se cree que va a pagar. Un upsell
    // cuyo precio no está en el catálogo valía 0 y desaparecía de la suma: el mensaje
    // cobraba de menos y la diferencia aparecía en el salón. Sin todos los sumandos no
    // hay total — decir "te lo confirmamos en el salón" es la respuesta correcta.
    // `Number(null)` es 0, no NaN: leer el precio con Number() a secas convierte
    // "no tiene precio" en "es gratis" y lo suma sin protestar. Es el mismo cambiazo
    // silencioso que estamos quitando, así que se distingue a mano.
    const precioNum = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
    let precioUpsellsDesconocido = false;
    const upsellingPrice = (session.upsellingAccepted || []).reduce((sum, name) => {
        const s = catalogo.find(x => normalizeText(x.nombre) === normalizeText(name));
        const p = precioNum(s?.precio);
        if (!Number.isFinite(p)) { precioUpsellsDesconocido = true; return sum; }
        return sum + p;
    }, 0);
    // `precio: null` en el catálogo es intencionado (la Consulta se confirma en salón),
    // así que un total nulo no es un fallo: es la única cifra honesta.
    const precioMain = precioNum(svc.precio);
    const precioTotal = (Number.isFinite(precioMain) && !precioUpsellsDesconocido)
        ? precioMain + upsellingPrice
        : null;
    // La duración anunciada es una promesa de cuánto va a estar en el salón. Si no se
    // resuelve, se calla en vez de prometer una hora sobre un servicio de seis.
    const durMain = resolveAppointmentDurationMin(svc, catalogo);
    if (!durMain.resuelto || precioTotal === null) {
        logger.info('confirmacion_sin_cifra_completa', {
            orgId, servicio: svc.nombre || null,
            duracionResuelta: durMain.resuelto, precioConocido: precioTotal !== null,
            precioUpsellsDesconocido,
        });
    }
    const mainServiceName = buildFullServiceName(svc, catalogo);
    const allServices = [mainServiceName, ...(session.upsellingAccepted || [])].filter(Boolean).join(' + ');
    return buildSanteConfirmationMessage({
        nombre: session.partialData.nombre,
        fecha: session.partialData.fecha_cita,
        hora: session.partialData.hora_cita,
        servicio: humanizeLargoLabel(allServices) || svc.nombre || 'Cita',
        stylistNombre: session.selectedStylist?.nombre,
        precio: precioTotal,
        duracion: durMain.resuelto ? durMain.minutos + upsellingDur : null,
        categoria: svc.categoria,
        direccion: info.direccion,
        language: session.language,
        upsellSuggestion: upsellSug,
        upsellTono,
        spaPromo: !!session._spaPromoEnEsteMensaje,
    });
}

// Lee un nombre de la respuesta de la clienta con validación ESTRICTA.
//
// isValidName / isNameToken, nunca isUsableName: aquí un falso positivo guarda basura en
// contacts.full_name para siempre ("хочу", "da igual", "sí", el nombre de un servicio). Es la
// dirección contraria a la puerta del recordatorio, y por eso son dos funciones distintas.
// Formas de decir "no te lo voy a decir" a la pregunta del nombre. Se comparan contra el
// TEXTO COMPLETO normalizado, no token a token, porque son frases: aquí una entrada con
// espacios sí tiene sentido (al revés que en NAME_STOPWORDS).
//
// Van aquí y NO en NAME_STOPWORDS a propósito: meter 'da' e 'igual' como tokens globales
// haría que "Ana Da Silva" dejara de ser un nombre válido en todo el repo.
const RESPUESTA_NO_ES_NOMBRE = new Set([
    'da igual', 'me da igual', 'lo que sea', 'el que sea', 'cualquiera', 'cualquier',
    'ni idea', 'no se', 'no lo se', 'como quieras', 'tu decides', 'nada',
    'whatever', 'any', 'anything', 'does not matter', 'dont care', 'i dont know',
    'не важно', 'неважно', 'все равно', 'как хочешь', 'не знаю',
    'байдуже', 'все одно', 'як хочеш', 'не знаю',
].map(s => normalizeText(s)));

function leerNombreDeRespuesta(texto, catalogoServicios) {
    if (!texto) return null;
    const limpio = String(texto).trim();
    if (RESPUESTA_NO_ES_NOMBRE.has(normalizeText(limpio))) return null;
    // "me da igual", "как хочешь"… el detector que ya usa el flujo de estilista/fecha.
    if (detectNoPreferenceSignal(limpio)?.sinPreferencia) return null;
    // "Me llamo Marina Petrova" / "Меня зовут Наталья" y también el nombre a secas.
    const cand = extractNameAfterIntro(limpio)
        || (limpio.split(/\s+/).length <= 3 && isValidName(limpio) ? limpio : null);
    if (!cand) return null;
    if (isServiceName(cand, catalogoServicios || [])) return null;
    return cand;
}

// Retoma la reserva que quedó esperando el nombre. Devuelve true si ha resuelto el turno.
//
// Invariante: cada reintento vuelve a pasar por confirmSlotConReverificacion, que recarga los
// huecos y comprueba que el elegido sigue libre. Entre la pregunta y la respuesta pasan turnos
// (y puede pasar una recarga de sesión, o una noche entera), así que el hueco puede haberse
// ocupado. Reservar a ciegas sobre el slot guardado sería crear una cita encima de otra.
async function handleNombreParaCita(client, orgId, session, sanitized, _send, userPhone) {
    const pending = session.pendingNameForBooking;
    if (!pending || pending.fase !== 'nombre') return false;

    const cfg = await getAgentConfig(orgId).catch(() => null);
    const nombre = leerNombreDeRespuesta(sanitized, cfg?.services || []);

    if (nombre) {
        session.partialData.nombre = nombre;
        logger.info('cita_sante_nombre_capturado', {
            orgId, telefono: userPhone, intento: pending.intentos, tieneApellido: hasApellido(nombre),
        });
    } else if (pending.intentos < 2 && session.preguntasCierre < 2) {
        // Segundo intento, con OTRA frase. Repetir la misma parece que el bot se ha colgado.
        session.pendingNameForBooking = { ...pending, intentos: pending.intentos + 1 };
        session.preguntasCierre = (session.preguntasCierre || 0) + 1;
        logger.info('cita_sante_pide_nombre', {
            orgId, telefono: userPhone, intento: pending.intentos + 1,
            fecha: pending.slot?.fecha, hora: pending.slot?.hora,
        });
        await _send(preguntaNombreMsg(session, 2));
        return true;
    } else {
        // Dos intentos gastados: la cita vale más que el dato. Se reserva sin nombre.
        session.pendingNameForBooking = { ...pending, agotado: true };
    }

    // ¿Pedimos el apellido? Como MÁXIMO una vez, nunca bloquea, y solo si queda cupo dentro
    // del tope de 2 preguntas del cierre.
    if (nombre && !hasApellido(nombre) && session.preguntasCierre < 2) {
        session.pendingNameForBooking = { ...pending, fase: 'apellido' };
        session.preguntasCierre = (session.preguntasCierre || 0) + 1;
        await _send(preguntaApellidoMsg(session));
        return true;
    }

    return finalizarReservaPendiente(client, orgId, session, _send, userPhone);
}

// El apellido es opcional por definición: llegue o no llegue, la cita se reserva en este turno.
async function handleApellidoParaCita(client, orgId, session, sanitized, _send, userPhone) {
    const pending = session.pendingNameForBooking;
    if (!pending || pending.fase !== 'apellido') return false;

    const cfg = await getAgentConfig(orgId).catch(() => null);
    // MISMA validación que el nombre, no una copia: si no, "da igual" pasaba aquí aunque el
    // nombre ya lo rechazara, y acababa en la ficha como "Marta da igual".
    const apellido = leerNombreDeRespuesta(sanitized, cfg?.services || []);
    if (apellido && apellido.split(/\s+/).length <= 2) {
        session.partialData.nombre = `${session.partialData.nombre} ${apellido}`;
        logger.info('cita_sante_apellido_capturado', { orgId, telefono: userPhone });
    } else {
        logger.info('cita_sante_apellido_no_llego', { orgId, telefono: userPhone });
    }
    return finalizarReservaPendiente(client, orgId, session, _send, userPhone);
}

// Escribe la cita que estaba en espera, revalidando el hueco, y responde.
async function finalizarReservaPendiente(client, orgId, session, _send, userPhone) {
    const pending = session.pendingNameForBooking;
    const slot = pending?.slot;
    if (!slot) { session.pendingNameForBooking = null; return false; }

    const res = await confirmSlotConReverificacion(client, session, userPhone, slot);
    if (res.ok) {
        session.reservaConfirmada = true;
        await _send(await mensajeConfirmacionSante(orgId, session));
        return true;
    }
    if (res.reason === 'ocupado') {
        // El hueco se ocupó mientras preguntábamos. No se reserva y se le dice, ofreciendo
        // los huecos REALES del reload — nunca un error vacío.
        logger.warn('cita_sante_hueco_ocupado_tras_nombre', {
            orgId, telefono: userPhone, fecha: slot.fecha, hora: slot.hora,
            alternativas: res.freshSlots?.length || 0,
        });
        session.pendingNameForBooking = null;
        ofrecerAlternativas(session, res.freshSlots || []);
        await _send(buildHuecoOcupadoMsg(session, res.freshSlots || []));
        return true;
    }
    // Estaba libre pero falló el guardado: no se confirma nada para no mentirle.
    session.pendingNameForBooking = null;
    await _send(salonRetryMsg(session.language));
    return true;
}

// Sentinela de finalizarCitaSante: "he preguntado el nombre, NO he escrito nada". No es
// `false` (eso significa "falló el guardado" y dispara salonRetryMsg, que aquí sería mentira)
// ni `true` (eso haría que el llamante anunciara una cita que no existe).
const PENDIENTE_NOMBRE = 'pendiente_nombre';

// ¿Podemos escribir ya, o hay que preguntar el nombre antes?
// Devuelve PENDIENTE_NOMBRE si hay que preguntar; null si se puede reservar.
function evaluarNombreAntesDeReservar(session, slot, userPhone) {
    if (session.orgType !== 'salon') return null;              // San Remo no pasa por aquí
    if (isValidName(session.partialData.nombre)) return null;  // ya lo tenemos
    if (session.pendingNameForBooking?.agotado) return null;   // 2 intentos gastados → se reserva sin nombre
    if (session.preguntasCierre >= 2) return null;             // tope duro

    const intentos = (session.pendingNameForBooking?.intentos || 0) + 1;
    session.pendingNameForBooking = { slot, intentos, fase: 'nombre', agotado: false };
    session.preguntasCierre = (session.preguntasCierre || 0) + 1;
    logger.info('cita_sante_pide_nombre', {
        orgId: session.orgId, telefono: userPhone, intento: intentos,
        fecha: slot?.fecha, hora: slot?.hora,
    });
    return PENDIENTE_NOMBRE;
}

async function finalizarCitaSante(client, session, userPhone, slot) {
    const orgId = session.orgId;
    if (!slot) return false;

    const fecha = slot.fecha;
    const hora = slot.hora;
    const stylistId = slot.stylistId;

    // DIAG: log completo de entrada para slot_directo_sin_propuesta
    logger.info('DIAG_finalizarCitaSante_entrada', {
        orgId, telefono: userPhone,
        slot: JSON.stringify(slot),
        leadId: session.leadId,
        selectedService: session.selectedService?.nombre || null,
        partialData: JSON.stringify(session.partialData),
        reservaConfirmada: session.reservaConfirmada,
        bookedSlots: session.bookedSlots,
    });

    // Guarda de idempotencia por sesión: no reservar dos veces el MISMO hueco
    // (fecha+hora+estilista) en una conversación. Evita que la resolución de confirmación
    // y la red de seguridad (o un reset/segunda reserva mal disparado) creen citas
    // duplicadas. Una segunda cita REAL será otro hueco distinto y sí pasará esta guarda.
    const slotSig = `${fecha}|${hora}|${stylistId || ''}`;
    if (!Array.isArray(session.bookedSlots)) session.bookedSlots = [];
    if (session.bookedSlots.includes(slotSig)) {
        // Llegar aquí significa que ESTA sesión ya registró haber reservado este hueco
        // exacto (slotSig solo se añade tras un guardado correcto). La consulta a Supabase
        // es una RE-verificación, para cazar el caso de que aquel guardado fallara.
        //
        // Cuando no se puede verificar, el default es "sí existe". Antes era `false` —"no
        // existe, adelante"— y eso es la dirección insegura: un guardado de menos se
        // recupera, una cita duplicada la ve la clienta. Y el estado sin verificar es
        // alcanzable de verdad: `bookedSlots` se persiste en SQLite y `leadId` no, así que
        // una sesión rehidratada vuelve con la marca puesta y el contacto sin resolver.
        const leadIdGuarda = await ensureLeadId(orgId, session);
        if (!leadIdGuarda) {
            logger.warn('cita_sante_duplicada_sin_verificar', {
                orgId, telefono: userPhone, slotSig,
                motivo: 'sin contacto resoluble: se asume que la cita existe y no se crea otra',
            });
            // NO se toca `reservaConfirmada`: ponerlo a true apaga cinco de las seis redes
            // del salón, y aquí no se ha leído nada que lo justifique. Se evita el duplicado
            // sin afirmar de más; si la suposición fuera falsa, la red anti-cita-fantasma
            // vuelve a leer Supabase después y lo corrige.
            return true;
        }
        const alreadySaved = await hasActiveAppointmentForSlot(orgId, leadIdGuarda, fecha, hora);
        if (alreadySaved) {
            logger.warn('cita_sante_duplicada_evitada', { orgId, telefono: userPhone, slotSig });
            session.reservaConfirmada = true;
            return true; // cita confirmada en Supabase — no creamos otra
        }
        // slotSig en bookedSlots pero sin cita activa en Supabase: turno anterior falló.
        // Eliminamos la marca obsoleta y procedemos con el guardado real.
        logger.warn('cita_sante_bookedSlot_sin_cita_activa', { orgId, telefono: userPhone, slotSig });
        session.bookedSlots = session.bookedSlots.filter(s => s !== slotSig);
    }

    // Puerta del nombre: ANTES de saveLead/saveAppointment, o sea antes de tocar Supabase.
    // Si hay que preguntarlo, no se escribe nada y la reserva queda en espera en
    // session.pendingNameForBooking; el turno siguiente la retoma en handleNombreParaCita.
    const puerta = evaluarNombreAntesDeReservar(session, slot, userPhone);
    if (puerta) return puerta;

    session.partialData.fecha_cita = fecha;
    session.partialData.hora_cita = hora;

    // Se reserva de verdad: la espera del nombre ha terminado (con nombre o sin él).
    if (!session.partialData.nombre) {
        logger.warn('cita_sante_sin_nombre', { orgId, telefono: userPhone, fecha, hora });
    }
    session.pendingNameForBooking = null;

    logger.info('cita_sante_intento', {
        orgId, telefono: userPhone, fecha, hora, stylistId,
        servicio: session.selectedService?.nombre || null, contactId: session.leadId,
    });

    try {
        logger.info('DIAG_finalizarCitaSante_saveLead_antes', {
            orgId, telefono: userPhone,
            partialData: JSON.stringify({ ...session.partialData, leadId: session.leadId, language: session.language }),
        });
        const rid = await saveLead(orgId, { ...session.partialData, leadId: session.leadId, language: session.language });
        logger.info('DIAG_finalizarCitaSante_saveLead_despues', { orgId, telefono: userPhone, rid, leadIdAntes: session.leadId });
        if (rid) session.leadId = rid;
        session.leadGuardado = true;
        incrementMetric('leadsSaved');

        if (!session.leadId) {
            logger.error('cita_sante_sin_contacto', { orgId, telefono: userPhone, fecha, hora });
            return false;
        }

        const agentCfgDur = await getAgentConfig(orgId);
        const catalogDur = agentCfgDur?.services || [];
        // Nombre completo del servicio (categoría + variante) para no guardar el
        // nombre suelto de la variante ("Largo 1") en appointments.service.
        const mainServiceName = buildFullServiceName(session.selectedService, catalogDur);
        const allServices = [mainServiceName, ...(session.upsellingAccepted || [])].filter(Boolean).join(' + ');
        // [DIAG-VARIANTE] String EXACTO que se escribirá en appointments.service.
        const upsellingDuration = (session.upsellingAccepted || []).reduce(
            (sum, name) => sum + resolveServiceDurationMin(name, catalogDur), 0);
        // La duración que sale de aquí es la que ocupa la agenda. Si no se ha podido
        // resolver, la cita se guarda igual —la clienta no puede quedarse sin hueco por
        // esto— pero deja de ser un dato silencioso: se registra y se anota en la ficha,
        // porque un ends_at corto publica horas libres encima de esta misma clienta.
        const durPrincipal = resolveAppointmentDurationMin(session.selectedService, catalogDur);
        const totalDuration = durPrincipal.minutos + upsellingDuration;
        if (!durPrincipal.resuelto) {
            logger.error('duracion_cita_no_resuelta', {
                orgId, telefono: userPhone, fecha, hora, stylistId,
                servicio: session.selectedService?.nombre || null,
                categoria: session.selectedService?.categoria || null,
                minutosAsumidos: durPrincipal.minutos, totalDuration,
            });
        }

        // Si la cita es para un acompañante, lo dejamos anotado en la cita (el contacto
        // sigue siendo el titular del WhatsApp, pero la cita es para otra persona).
        const guestNote = session.guestBooking && session.guestName ? `Cita para: ${session.guestName}` : null;

        // ── Promo 10% primera visita a Spa Hair / Masajes ────────────────────────
        // Se ofrece tras confirmar cualquier cita, salvo cuando el descuento no podría
        // aplicarse: la cita reservada YA es de esas categorías, la clienta ya estuvo
        // antes (no sería su primera visita) o esto es un reagendado (no se re-ofrece).
        // Se calcula ANTES del INSERT para que la cita nueva no se cuente a sí misma.
        // La nota queda en appointments.notes → visible en la ficha de reserva del panel.
        let ofrecerPromoAhora = false;
        if (!session.spaPromoOffered) {
            let elegible = !session.modoReagendamiento
                && !isSpaPromoCategory(session.selectedService?.categoria);
            if (elegible) {
                try {
                    const previas = await getAppointmentsByLead(orgId, session.leadId);
                    const serviciosPrevios = (previas || [])
                        .filter(a => a.status !== 'cancelled')
                        .map(a => a.service);
                    elegible = !hasPreviousSpaOrMassage(serviciosPrevios, catalogDur);
                } catch (e) {
                    // Sin historial fiable no prometemos un descuento que quizá no aplique.
                    logger.error('error_check_spa_promo', { orgId, telefono: userPhone, error: e.message });
                    elegible = false;
                }
            }
            if (elegible) {
                ofrecerPromoAhora = true;
                session.spaPromoOffered = true;
                session.spaPromoNote = buildSpaPromoNote();
            }
        }
        // La nota va en la cita que llevó la promo. Un reagendado reescribe notes, así que
        // en ese caso la re-estampamos idéntica para no perder la constancia.
        const promoNote = ofrecerPromoAhora || (session.modoReagendamiento && session.spaPromoNote)
            ? session.spaPromoNote
            : null;
        // Solo el mensaje de confirmación de ESTA cita menciona la promo.
        session._spaPromoEnEsteMensaje = ofrecerPromoAhora;

        // Duración adivinada → que se vea en la ficha del panel, no solo en los logs: es la
        // única forma de que alguien del salón corrija el hueco antes de que el motor
        // ofrezca a otra clienta las horas que esta cita ocupa de verdad.
        const durNote = durPrincipal.resuelto
            ? null
            : `⚠ Duración sin confirmar (${durPrincipal.minutos} min asumidos)`;
        const notasCita = [guestNote, promoNote, durNote, session.partialData.notas].filter(Boolean).join(' · ') || null;

        logger.info('DIAG_finalizarCitaSante_bookAppointment_antes', {
            orgId, telefono: userPhone, leadId: session.leadId,
            allServices, totalDuration, stylistId, notasCita,
            slot: JSON.stringify(slot),
        });

        const bookOpts = {
            servicio: allServices || session.selectedService?.nombre || 'Cita',
            duracionMin: totalDuration,
            stylistId,
            notas: notasCita,
        };
        // Reagendado: MOVER la cita existente (UPDATE in-place) en vez de crear una nueva y
        // dejar la vieja huérfana. El fallback a INSERT es SOLO para 'not_found' (la cita ya no
        // existe): con 'db_error' la cita vieja sigue viva y crear otra dejaría dos reservas
        // para la misma clienta, ambas facturables. Ahí es mejor fallar y que se escale.
        const reagendando = session.modoReagendamiento && session.reagendarAppointmentId;
        let result = reagendando
            ? await calendarSante.rescheduleAppointment(orgId, session.reagendarAppointmentId, slot, bookOpts)
            : await calendarSante.bookAppointment(orgId, slot, session.leadId, bookOpts);
        if (reagendando && !result.success) {
            if (result.reason === 'not_found') {
                logger.warn('reagendar_cita_inexistente_fallback_insert', { orgId, telefono: userPhone, reagendarAppointmentId: session.reagendarAppointmentId });
                result = await calendarSante.bookAppointment(orgId, slot, session.leadId, bookOpts);
            } else {
                logger.error('reagendar_fallido_sin_fallback', {
                    orgId, telefono: userPhone, reagendarAppointmentId: session.reagendarAppointmentId,
                    reason: result.reason || null, error: result.error || null,
                });
            }
        }

        logger.info('DIAG_finalizarCitaSante_bookAppointment_resultado', {
            orgId, telefono: userPhone, result: JSON.stringify(result), reagendando: !!reagendando,
        });

        if (!result.success) {
            logger.error('cita_sante_no_guardada', {
                orgId, telefono: userPhone, fecha, hora, stylistId, contactId: session.leadId,
                reason: result.reason || null, error: result.error || null,
            });
            return false;
        }

        logger.info('cita_sante_guardada', { orgId, telefono: userPhone, appointmentId: result.appointmentId, fecha, hora, stylistId, contactId: session.leadId, reagendada: !!reagendando });
        session.appointmentId = result.appointmentId;
        // Reagendado completado: limpiar el estado para que no se re-mueva ni afecte a flujos siguientes.
        session.modoReagendamiento = false;
        session.reagendarAppointmentId = null;
        session.partialData.estado_cita = 'confirmado';
        // La cita YA está en Supabase. Sincronizar la ficha del contacto es contabilidad
        // posterior: si falla (updateLead lanza vía assertRowsAffected cuando el leadId no
        // casa ninguna fila), no puede tumbar el `return true` — antes caía al catch de abajo
        // y el bot decía "no he podido fijar ese hueco" con la cita creada y cobrable.
        try {
            await updateLead(orgId, { leadId: session.leadId, appointment_id: result.appointmentId, estado_cita: 'confirmado' });
        } catch (e) {
            logger.error('cita_guardada_lead_no_sincronizado', {
                orgId, telefono: userPhone, appointmentId: result.appointmentId,
                leadId: session.leadId, error: e.message,
            });
        }
        // Update preferred stylist for returning visits
        //
        // Sigue siendo fire-and-forget (la reserva no espera a esto), pero ya no es mudo:
        // esto es la memoria del salón —"¿con Veronika, como siempre?"— y cuando se perdía,
        // el síntoma era que el bot dejaba de reconocer a una clienta habitual, sin una
        // sola línea que lo relacionara con una escritura fallida.
        const leadIdEstilista = stylistId ? await ensureLeadId(orgId, session) : null;
        if (leadIdEstilista) {
            updateContactPreferredStylist(orgId, leadIdEstilista, stylistId)
                .catch(e => logger.warn('estilista_preferida_no_persistida', {
                    orgId, telefono: userPhone, leadId: leadIdEstilista, stylistId, error: e.message,
                }));
            const stylistName = session.selectedStylist?.nombre || slot.stylistName || null;
            if (stylistName) {
                session.lastStylist = stylistName;
                updateContactLastStylist(orgId, leadIdEstilista, stylistName)
                    .catch(e => logger.warn('ultima_estilista_no_persistida', {
                        orgId, telefono: userPhone, leadId: leadIdEstilista, stylistName, error: e.message,
                    }));
            }
        }

        session.reservaConfirmada = true;
        session.anyStylists = false;
        session.prefiereMasCercano = false;
        session.leadStatus = 'completed';
        // Registramos el hueco reservado para que la guarda de idempotencia bloquee
        // cualquier intento de volver a crear esta misma cita en la conversación.
        session.bookedSlots.push(slotSig);
        // Cita guardada: limpiamos el estado de "reserva para acompañante" para que una
        // eventual tercera reserva arranque limpia.
        session.guestBooking = false;
        session.guestName = null;
        return true;
    } catch (e) {
        logger.error('error_finalizar_cita_sante', { telefono: userPhone, error: e.message, stack: e.stack });
        return false;
    }
}

// ─── Confirmación con RE-VERIFICACIÓN dirigida (salon) ───────────────────────
// Antes de guardar la cita, recargamos los huecos REALES del día+estilista del
// hueco elegido (ignorando la preferencia estrecha que pudo vaciar availableSlots)
// y comprobamos que ese hueco sigue libre. Solo entonces persistimos. Así nunca
// mostramos "no he podido fijar ese hueco" por un artefacto de la recarga, pero
// tampoco reservamos a ciegas un hueco que otra clienta acabe de ocupar.
// Devuelve { ok, reason, freshSlots }:
//   reason='guardado' → cita persistida | 'ocupado' → el hueco ya no está libre
//   'error_guardado' → estaba libre pero falló el guardado (reintentar).
async function confirmSlotConReverificacion(client, session, userPhone, slot) {
    const orgId = session.orgId;
    const freshSlots = await reloadSlotsForConfirmation(session, { fecha: slot.fecha, stylistId: slot.stylistId });
    // Reutilizamos pickChosenSlot para localizar el hueco en la recarga fresca:
    // maneja el match exacto, la hora única y la síntesis de horas fuera de la
    // rejilla de 30 min (p.ej. 10:15) igual que en la propuesta original.
    const verified = pickChosenSlot(session, { fecha_cita: slot.fecha, hora_cita: slot.hora }, freshSlots);
    const stillFree = !!verified && (!slot.stylistId || verified.stylistId === slot.stylistId);
    logger.info('confirmacion_reload_dirigido', {
        orgId, telefono: userPhone, fecha: slot.fecha, hora: slot.hora,
        stylistId: slot.stylistId || null, huecosRealesTrasReload: freshSlots.length, encontrado: stillFree,
    });
    if (!stillFree) return { ok: false, reason: 'ocupado', freshSlots };
    const res = await finalizarCitaSante(client, session, userPhone, verified || slot);
    // PENDIENTE_NOMBRE no es ni éxito ni fallo: se ha preguntado el nombre y no se ha escrito
    // nada. Se propaga como razón propia para que el llamante no anuncie una cita inexistente
    // ni suelte el "no he podido fijar ese hueco", que aquí sería falso.
    if (res === PENDIENTE_NOMBRE) return { ok: false, reason: PENDIENTE_NOMBRE, freshSlots };
    return { ok: res === true, reason: res === true ? 'guardado' : 'error_guardado', freshSlots };
}

// Mensaje de "ese hueco ya no está disponible" que OFRECE los huecos reales
// (alternativas verídicas del reload dirigido), nunca un error vacío. Deja la
// sesión lista para que la clienta pueda elegir uno de ellos en el turno siguiente.
function buildHuecoOcupadoMsg(session, freshSlots) {
    const lang = session.language || 'es';
    const slots = Array.isArray(freshSlots) ? freshSlots : [];
    if (!slots.length) {
        const noneMsgs = {
            es: 'Uy, ese hueco se acaba de ocupar y no me quedan huecos cercanos con esa profesional 😕 ¿Quieres que mire otra fecha u otra estilista?',
            en: "Oh, that slot was just taken and I have no nearby openings with that stylist 😕 Want me to check another date or stylist?",
            ru: 'Ой, это время только что заняли, и близких окон у этого мастера нет 😕 Посмотреть другую дату или мастера?',
            uk: 'Ой, цей час щойно зайняли, і близьких вікон у цього майстра немає 😕 Подивитися іншу дату чи майстра?',
        };
        return noneMsgs[lang] || noneMsgs.es;
    }
    const grouped = {};
    for (const s of slots.slice(0, 12)) {
        const dayLabel = `${s.diaNombre ? s.diaNombre.charAt(0).toUpperCase() + s.diaNombre.slice(1) : ''} ${s.fecha ? new Date(s.fecha + 'T12:00:00').getDate() : ''}`.trim();
        const key = dayLabel || s.fecha || 'Día';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(s.hora);
    }
    const slotsTexto = Object.entries(grouped).map(([day, horas]) => `${day}: ${horas.join(' · ')}`).join('\n');
    const msgs = {
        es: `Uy, ese hueco se acaba de ocupar 😕 Pero tengo estos disponibles:\n\n${slotsTexto}\n\n¿Cuál te viene mejor?`,
        en: `Oh, that slot was just taken 😕 But I have these available:\n\n${slotsTexto}\n\nWhich one works best for you?`,
        ru: `Ой, это время только что заняли 😕 Но есть свободные:\n\n${slotsTexto}\n\nКакое тебе подходит?`,
        uk: `Ой, цей час щойно зайняли 😕 Але є вільні:\n\n${slotsTexto}\n\nЯкий тобі підходить?`,
    };
    return msgs[lang] || msgs.es;
}

// Deja los huecos alternativos disponibles en la sesión para que la clienta pueda
// elegir uno en el próximo turno (proposedSlots es lo que ve el resolver de
// confirmación como frozenProposed).
function ofrecerAlternativas(session, freshSlots) {
    const slots = (Array.isArray(freshSlots) ? freshSlots : []).slice(0, 12);
    session.availableSlots = slots;
    session.currentSlotIndex = 0;
    session.proposedSlots = slots;
    session.slotsProposed = slots.length > 0;
}

// ─── Resolución desde Telegram (Bizum confirm/reject) ───────────────────────
// `actor` solo alimenta la auditoría de la cita (migración 033): quien resuelve un Bizum es
// una persona, por Telegram o por el panel, y esa es justo la firma que hace falta.
async function resolveBizumResult(pendingAction, confirmed, { actor = null } = {}) {
    const orgId = pendingAction.organization_id;
    const contact = pendingAction.contacts;
    const appointment = pendingAction.appointments;
    const telefono = contact?.wa_phone;
    if (!telefono) return;
    // Try to find the original JID from an active session (handles LID contacts)
    let userPhone = null;
    for (const [key, s] of userSessions.entries()) {
        if (key.startsWith(orgId + ':') && s.partialData?.telefono === telefono.replace(/\D/g, '')) {
            userPhone = s.originalJid || key.split(':')[1];
            break;
        }
    }
    if (!userPhone) userPhone = `${telefono.replace(/\D/g, '')}@c.us`;

    if (confirmed) {
        await updateLead(orgId, { leadId: contact.id, estado_cita: 'confirmado' });
        if (appointment?.id) await updateAppointment(orgId, appointment.id, { bizumStatus: 'confirmed', estado: 'confirmed', actor });

        const agentCfg = await getAgentConfig(orgId);
        const info = agentCfg?.business_info || {};
        const dir = info.direccion && !String(info.direccion).startsWith('PENDIENTE') ? `\n📍 ${info.direccion}` : '';
        const companyName = info.companyName || config.companyName || '';
        let fechaStr = '', horaStr = '';
        if (appointment?.starts_at) {
            const fecha = new Date(appointment.starts_at);
            fechaStr = fecha.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Madrid' });
            horaStr = fecha.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
        }
        await sendDirectMessage(orgId, userPhone,
            `¡Reserva confirmada! ✅\n\n📅 ${fechaStr} a las ${horaStr}\n👥 ${appointment?.party_size || ''} personas${dir}\n\n¡Te esperamos en ${companyName}!`
        );
    } else {
        await updateLead(orgId, { leadId: contact.id, estado_cita: 'cancelado' });
        if (appointment?.id) await updateAppointment(orgId, appointment.id, { bizumStatus: 'rejected', estado: 'cancelled', actor });
        await setBlacklist(orgId, contact.id, 'Bizum no recibido');
        await sendDirectMessage(orgId, userPhone, 'No hemos recibido el Bizum, así que no podemos confirmar la reserva 😕 Si crees que es un error, contesta a este mensaje.');
    }

    const sKey = sessionKey(orgId, userPhone);
    const session = userSessions.get(sKey);
    if (session) {
        session.bizumPendiente = false;
        session.reservaConfirmada = confirmed;
        session.partialData.estado_cita = confirmed ? 'confirmado' : 'cancelado';
        if (!confirmed) {
            session.botActivo = false;
            session.isBlacklisted = true;
        }
        persistSession(orgId, userPhone, session);
    }
}

// ─── Core ─────────────────────────────────────────────────────────────────────
async function processMessageCore(client, message, userPhone, userText, messageKey, orgId, dbPhone) {
    let _snapshot;
    // Resolved phone for DB operations; falls back to JID extraction for @c.us
    const _dbPhone = dbPhone || extractPhoneFromJid(userPhone);
    const _send = (text) => sendWithDelay(client, userPhone, text, orgId, _dbPhone);
    logger.info('process_core_inicio', { orgId, telefono: userPhone, textoLength: userText?.length || 0 });
    try {
        if (!isBotActivo(orgId)) {
            // Pausa de ORGANIZACIÓN: se tira el mensaje de TODAS las clientas, no solo de
            // esta. Era un info silencioso y así pasaron 4 h sin que nadie lo viera (01/08).
            logger.warn('process_core_bot_inactivo', { orgId, telefono: _dbPhone || userPhone });
            notePausedDrop(orgId, _dbPhone || userPhone, 'process_core');
            return;
        }

        const sKey = sessionKey(orgId, userPhone);
        const orgType = getOrgType(orgId);
        let existingSession = userSessions.get(sKey);
        let isNewSession = false;
        let loadedFromSQLite = false;

        // Una sesión caducada se persiste y se DESALOJA del Map, para que caiga por el mismo
        // camino de rehidratación que una que ya no estaba.
        //
        // Antes este caso tenía su propia rama que hacía createEmptySession() sin leer SQLite.
        // Resultado: entre 1 h (SESSION_TIMEOUT) y 2 h (cuando el GC la desaloja) el servicio
        // se perdía sin ni siquiera intentar recuperarlo, mientras que pasadas esas 2 h sí se
        // rehidrataba. Dos reglas distintas para el mismo problema, y la peor de las dos era
        // la del hueco corto. Ahora hay un solo camino.
        if (existingSession && Date.now() - existingSession.lastUpdate > SESSION_TIMEOUT) {
            persistSession(orgId, userPhone, existingSession);
            userSessions.delete(sKey);
            existingSession = null;
            logger.info('session_timeout_rehidrata', { orgId, telefono: userPhone });
        }

        if (!existingSession) {
            const persisted = loadClient(orgId, userPhone);
            const newSession = createEmptySession(userPhone, orgId, dbPhone);

            if (persisted) {
                loadedFromSQLite = true;
                const rawHistory = persisted.history || [];
                const cleanLen = rawHistory.length;
                newSession.history = rawHistory.filter(m =>
                    m.role !== 'assistant' || !isFallbackText(m.content)
                );
                if (newSession.history.length < cleanLen) {
                    logger.info('history_fallbacks_limpiados', { orgId, telefono: userPhone, eliminados: cleanLen - newSession.history.length });
                }
                newSession.summary = persisted.summary || null;
                newSession.botActivo = persisted.botActivo;
                if (!persisted.botActivo) {
                    logger.info('session_botActivo_from_sqlite', { orgId, telefono: userPhone, botActivo: false, source: 'sqlite' });
                }

                // Restaurar conversationStartedAt; si han pasado >24h desde el
                // último mensaje, tratar como conversación nueva (el LLM no verá
                // el historial antiguo).
                const CONVERSATION_GAP_MS = 24 * 60 * 60 * 1000;
                if (persisted.extra?.conversationStartedAt) {
                    const lastSeen = persisted.lastSeen || 0;
                    if (Date.now() - lastSeen > CONVERSATION_GAP_MS) {
                        newSession.conversationStartedAt = Date.now();
                        logger.info('conversation_gap_new_session', { orgId, telefono: userPhone, lastSeen: new Date(lastSeen).toISOString(), gapHours: ((Date.now() - lastSeen) / 3600000).toFixed(1) });
                    } else {
                        newSession.conversationStartedAt = persisted.extra.conversationStartedAt;
                    }
                }

                // Restaurar estado del salón (servicio/estilista/idioma...) para no perder
                // el flujo tras un reinicio o timeout. Los huecos se recalculan más abajo
                // (loadAvailableSlots) en cuanto haya selectedService.
                if (newSession.orgType === 'salon' && persisted.extra) {
                    const ex = persisted.extra;
                    newSession.selectedService    = ex.selectedService || null;
                    newSession.selectedStylist    = ex.selectedStylist || null;
                    newSession.language           = ex.language || null;
                    newSession.upsellingAccepted  = ex.upsellingAccepted || [];
                    newSession.upsellingSuggested = !!ex.upsellingSuggested;
                    newSession.preferredStylistId = ex.preferredStylistId || null;
                    newSession.currentSlotIndex   = ex.currentSlotIndex || 0;
                    newSession.slotsProposed      = !!ex.slotsProposed;
                    newSession.guestBooking       = !!ex.guestBooking;
                    newSession.guestName          = ex.guestName || null;
                    newSession.bookedSlots        = Array.isArray(ex.bookedSlots) ? ex.bookedSlots : [];
                    newSession.pendingLargoCategory = ex.pendingLargoCategory || null;
                    newSession.largoPelo          = ex.largoPelo || null;
                    newSession.pendingCorteGenero = !!ex.pendingCorteGenero;
                    newSession.pendingCorteMujerTipo = !!ex.pendingCorteMujerTipo;
                    newSession.pendingCorteNinoTipo = !!ex.pendingCorteNinoTipo;
                    newSession._lastUpsellSuggestion = ex.lastUpsellSuggestion || null;
                    newSession.pendingEscalation     = !!ex.pendingEscalation;
                    newSession.pendingEscalationService = ex.pendingEscalationService || null;
                    newSession.tratamiento           = ex.tratamiento || null;
                    newSession.proposedSlots         = Array.isArray(ex.proposedSlots) ? ex.proposedSlots : [];
                    newSession.spaPromoOffered       = !!ex.spaPromoOffered;
                    newSession.spaPromoNote          = ex.spaPromoNote || null;
                    newSession.pendingServiceCategory = ex.pendingServiceCategory || null;
                    newSession.anchorAppointment     = ex.anchorAppointment || null;
                    newSession.citaEnCurso           = ex.citaEnCurso || null;
                    newSession.pendingCitaAccion         = ex.pendingCitaAccion || null;
                    newSession.pendingNameForBooking = ex.pendingNameForBooking || null;
                    newSession.preguntasCierre       = ex.preguntasCierre || 0;

                    const assistantTurns = newSession.history.filter(m => m.role === 'assistant').length;
                    const extraIncoherente =
                        (newSession.selectedService && assistantTurns === 0) ||
                        (newSession.slotsProposed && assistantTurns < 2);
                    if (extraIncoherente) {
                        logger.info('extra_sqlite_incoherente_reset', {
                            orgId, telefono: userPhone,
                            selectedService: newSession.selectedService?.nombre || null,
                            slotsProposed: newSession.slotsProposed,
                            assistantTurns,
                            historyLen: newSession.history.length,
                        });
                        clearServiceState(newSession);
                    }
                }

                if (persisted.leadGuardado) {
                    const estadoCita = persisted.partialData?.estado_cita;
                    if (estadoCita === 'pendiente_bizum') {
                        const { telefono } = newSession.partialData;
                        newSession.partialData = { telefono, ...persisted.partialData };
                        newSession.leadGuardado = true;
                        newSession.reservaConfirmada = true;
                        newSession.bizumAsked = true;
                        newSession.bizumPendiente = true;
                        newSession.appointmentId = persisted.partialData?.appointment_id || null;
                        newSession.leadStatus = 'completed';
                    } else {
                        // AQUÍ NO SE DECIDE NADA. Esta rama daba por hecho "cita anterior
                        // completada → clienta recurrente" y llamaba a clearServiceState,
                        // porque el único estado que reconocía arriba es 'pendiente_bizum'
                        // (el flujo Bizum de San Remo). Sante escribe 'confirmado', así que
                        // TODA recarga suya caía aquí: se le borraba el servicio y
                        // reservaConfirmada se quedaba en false. Consecuencias medidas el
                        // 04/08/2026: el bot le preguntaba "¿qué servicio quieres?" a una
                        // clienta que ya tenía cita, y el barrido de abandono marcaba
                        // 'abandonado' a 3 clientas con cita confirmada viva — que por eso
                        // se quedaron fuera del recordatorio de 24 h (db.js:475 filtra por
                        // estado='confirmado').
                        //
                        // La decisión se aplaza a reconciliarCitaViva(), que la toma contra
                        // Supabase y no contra partialData.estado_cita. Aquí todavía no se
                        // puede: session.leadId se resuelve más abajo, con findByPhone.
                        // Los DATOS sí se restauran; lo que no se decide es qué significan.
                        // Antes solo se rescataba el nombre y el resto de partialData se
                        // perdía (fecha_cita, hora_cita, estado_cita, personas, notas…),
                        // con dos consecuencias:
                        //   · `leadGuardado` se quedaba en false pese a que el contacto SÍ
                        //     estaba guardado, y el bloque de guardado oportunista de abajo
                        //     volvía a llamar a saveLead con estado_cita:'pendiente' en cada
                        //     turno. Eso pisa contacts.estado='confirmado' → y
                        //     getLeadsPendientesRecordatorio exige 'confirmado', o sea que
                        //     la clienta se quedaba otra vez sin recordatorio de 24 h. Es la
                        //     MISMA pérdida del incidente de arriba, por otro camino.
                        //   · sin hora_cita/fecha_cita, el guard anti-cierre del upselling
                        //     ni siquiera llega a evaluarse (su puerta las exige).
                        // Restaurarlo no reintroduce la decisión: nada aguas abajo ramifica
                        // sobre partialData.estado_cita — la cita se resuelve contra
                        // Supabase en reconciliarCitaViva(), que es quien fija appointmentId
                        // y citaEnCurso. reservaConfirmada sigue SIN tocarse.
                        const { telefono } = newSession.partialData;
                        newSession.partialData = { telefono, ...persisted.partialData };
                        newSession.leadGuardado = true;
                        newSession.ultimaVisita = persisted.partialData?.fecha_cita || null;
                        newSession._decidirCitaVivaAlRecargar = true;
                    }
                } else {
                    const { telefono } = newSession.partialData;
                    newSession.partialData = { telefono, ...persisted.partialData };
                    newSession.leadGuardado = persisted.leadGuardado;
                    newSession.messageCount = persisted.messageCount;
                    const estadoCita = persisted.partialData?.estado_cita;
                    newSession.reservaConfirmada = estadoCita === 'pendiente_bizum';
                    newSession.bizumAsked = newSession.reservaConfirmada;
                    newSession.bizumPendiente = estadoCita === 'pendiente_bizum';
                    newSession.appointmentId = persisted.partialData?.appointment_id || null;
                    if (newSession.reservaConfirmada) newSession.leadStatus = 'completed';
                }
            }

            userSessions.set(sKey, newSession);
            incrementMetric('conversationStarted');
            isNewSession = true;
        }

        const session = userSessions.get(sKey);
        if (!session) return;

        // Check contact in DB
        if (isNewSession) {
            try {
                const contact = await findByPhone(orgId, session.partialData.telefono);
                if (contact) {
                    if (contact.bot_mode === 'manual') {
                        session.botActivo = false;
                        logger.info('process_core_bot_mode_manual', { orgId, telefono: userPhone, source: 'supabase_contact' });
                    } else if (!session.botActivo) {
                        // Estado sucio: SQLite o sesión anterior tenía botActivo=false pero Supabase dice auto → limpiar
                        session.botActivo = true;
                        session.escalationJustResolved = true;
                        session.conversationStartedAt = Date.now();
                        if (session.pendingEscalation) {
                            session.pendingEscalation = false;
                            session.pendingEscalationService = null;
                            logger.info('session_escalation_reset', { orgId, telefono: userPhone, source: 'supabase_auto_reconcile' });
                        }
                        clearServiceState(session);
                        logger.info('session_botActivo_reset_to_auto', { orgId, telefono: userPhone, contactBotMode: contact.bot_mode || 'auto', previousSource: loadedFromSQLite ? 'sqlite' : 'session_timeout' });
                    }
                    // Solo limpiar el servicio restaurado si hay evidencia de una ESCALADA real
                    // (recién resuelta este turno o pendiente restaurada de SQLite). Sin este guard
                    // la condición disparaba en CUALQUIER carga desde SQLite (reinicio/timeout normal),
                    // borrando el servicio en curso y dejando al LLM sin huecos → fecha inventada.
                    if (contact.bot_mode !== 'manual' && !contact.escalation_reason && loadedFromSQLite
                        && (session.escalationJustResolved || session.pendingEscalation)
                        && (session.selectedService || session.selectedCategory)) {
                        clearServiceState(session);
                        logger.info('session_service_reset_post_escalada', { orgId, telefono: userPhone, source: 'sqlite_load_supabase_auto' });
                    }
                    if (contact.is_blacklisted) { session.isBlacklisted = true; logger.info('process_core_blacklisted', { orgId, telefono: userPhone }); }
                    else if (session.isBlacklisted) { session.isBlacklisted = false; session.blacklistNotified = false; logger.info('process_core_blacklist_cleared', { orgId, telefono: userPhone, source: 'db_no_blacklist' }); }
                    session.leadId = session.leadId || contact.id;
                    // Un 'es' que no ha elegido nadie NO es una observación: es el default del
                    // INSERT, y son 516 de las 720 fichas de Sante. Sembrar la sesión con él
                    // tiene una consecuencia muy concreta aguas abajo: se le pasa al LLM como
                    // «último idioma detectado» (__clientLanguage → openai.js) y, ante un
                    // mensaje corto, el modelo se queda en ese idioma en vez de leer el del
                    // mensaje. Caso real 05/08/2026: 19542240982, teléfono de EEUU, escribe
                    // "Thursday" y recibe el saludo en castellano.
                    // Con null, el prompt entra por su rama de «aún no se conoce el idioma» y
                    // decide leyendo. La ficha conserva su 'es' —las plantillas de campaña
                    // siguen saliendo igual—: lo único que cambia es de qué se fía el bot.
                    session.languageSource = contact.language_source || 'default';
                    session.language = session.languageSource === 'default' ? null : (contact.language || null);
                    if (contact.language && !session.language) {
                        logger.info('idioma_ficha_por_defecto_ignorado', {
                            orgId, telefono: userPhone, language: contact.language,
                        });
                    }
                    // La ficha manda sobre la sesión solo cuando la sesión no sabe nada: lo
                    // que la clienta pida en ESTE turno se escribe después y gana.
                    if (!session.tratamiento) session.tratamiento = contact.tratamiento || null;
                    session.preferredStylistId = contact.preferred_stylist_id || null;
                    session.lastStylist = contact.last_stylist || null;
                    if (!loadedFromSQLite) {
                        session.clienteRecurrente = (contact.visit_count || 0) > 0;
                        session.ultimaVisita = contact.fecha_cita || null;
                        if (!session.partialData.nombre && contact.nombre) session.partialData.nombre = contact.nombre;
                    }

                    // Ya hay leadId: aquí sí se puede preguntar a Supabase si tiene una cita
                    // por delante. Es la decisión que la rama de recarga dejó aplazada.
                    await reconciliarCitaViva(orgId, session, userPhone);

                    if (session.clienteRecurrente && contact.id && orgType === 'salon') {
                        try {
                            const lastAppt = await getLastCompletedAppointment(orgId, contact.id);
                            if (lastAppt) {
                                session.ultimoServicio = lastAppt.service;
                                session.ultimaEstilista = lastAppt.stylist_name;
                            }
                        } catch (e) { logger.error('error_load_last_appt', { orgId, error: e.message }); }
                    }
                } else if (!session.botActivo && loadedFromSQLite) {
                    // Contacto no existe en DB pero SQLite tenía botActivo=false → estado huérfano, limpiar
                    session.botActivo = true;
                    if (session.pendingEscalation) {
                        session.pendingEscalation = false;
                        session.pendingEscalationService = null;
                        logger.info('session_escalation_reset', { orgId, telefono: userPhone, source: 'orphan_no_contact' });
                    }
                    clearServiceState(session);
                    logger.info('session_botActivo_reset_orphan', { orgId, telefono: userPhone, source: 'sqlite_no_contact' });
                }
            } catch (e) { logger.error('error_check_contact', { orgId, telefono: userPhone, error: e.message }); }

            // Red de seguridad: si no hubo contacto en la DB, o findByPhone falló, la decisión
            // aplazada seguiría pendiente y el estado de servicio se quedaría a medias. Es
            // idempotente (borra su propia marca), así que si ya corrió arriba no hace nada.
            await reconciliarCitaViva(orgId, session, userPhone);
        }

        // Reconciliación con la DB para sesiones EXISTENTES, en AMBAS direcciones. El panel
        // ("tomar control") escribe bot_mode en Supabase, pero no puede tocar la sesión viva
        // de este proceso (puede correr en un proceso separado del webhook). Así que en cada
        // mensaje honramos el bot_mode de la DB — igual que hace la escalada, pero vía DB:
        //   • bot_mode='manual' + sesión activa → pausar SOLO esta conversación (bug 10, caso 2).
        //   • bot_mode!='manual' + sesión pausada → reactivar (soltar control / resolver escalada).
        if (!isNewSession) {
            try {
                const _reconContact = await findByPhone(orgId, session.partialData.telefono);
                if (_reconContact) {
                    // El leadId se asignaba SOLO en la rama de sesión nueva, y ahí puede no
                    // haber contacto todavía: en el primer mensaje de una desconocida,
                    // findByPhone devuelve null y es saveMessage quien crea la fila un
                    // instante después. La sesión seguía entonces con leadId a null para
                    // siempre, y todo lo que cuelga de él quedaba mudo —updateContactLanguage
                    // el primero, que es fire-and-forget bajo `if (session.leadId)`—. Efecto
                    // observado: el bot detecta el ruso y responde en ruso, pero la ficha se
                    // queda en 'es' y la campaña le manda la plantilla española.
                    // Aquí ya tenemos la fila releída, así que se rellena el hueco. Nunca
                    // pisa un leadId existente.
                    if (!session.leadId && _reconContact.id) {
                        session.leadId = _reconContact.id;
                        logger.info('session_leadid_backfill', { orgId, telefono: userPhone, leadId: _reconContact.id });
                    }
                    if (_reconContact.bot_mode === 'manual' && session.botActivo) {
                        session.botActivo = false;
                        logger.info('session_botActivo_pause_from_db', { orgId, telefono: userPhone, source: 'panel_manual_reconcile' });
                    } else if (_reconContact.bot_mode !== 'manual' && !session.botActivo) {
                        session.botActivo = true;
                        session.escalationJustResolved = true;
                        session.conversationStartedAt = Date.now();
                        if (session.pendingEscalation) {
                            session.pendingEscalation = false;
                            session.pendingEscalationService = null;
                        }
                        clearServiceState(session);
                        logger.info('session_botActivo_reconcile_memory', { orgId, telefono: userPhone, db_bot_mode: _reconContact.bot_mode || 'auto', source: 'existing_session_supabase_reconcile' });
                    }
                    if (_reconContact.is_blacklisted && !session.isBlacklisted) {
                        session.isBlacklisted = true;
                        logger.info('session_blacklisted_reconcile', { orgId, telefono: userPhone });
                    } else if (!_reconContact.is_blacklisted && session.isBlacklisted) {
                        // Reconciliación INVERSA: un admin sacó al contacto de la lista negra en la
                        // DB (p.ej. "Sí, continuar" en Telegram → removeBlacklist), pero la sesión
                        // viva conservaba isBlacklisted=true. Sin limpiarla aquí, cada mensaje caía
                        // en el return silencioso de la rama blacklist (blacklistNotified ya era true)
                        // → el contacto quedaba mudo para siempre en esta sesión.
                        session.isBlacklisted = false;
                        session.blacklistNotified = false;
                        logger.info('session_blacklist_cleared_reconcile', { orgId, telefono: userPhone, source: 'db_no_blacklist' });
                    }
                }
            } catch (e) { logger.error('error_reconcile_existing_session', { orgId, telefono: userPhone, error: e.message }); }
        }

        if (messageKey && session.seenMessages.has(messageKey)) { logger.info('process_core_msg_duplicado', { orgId, telefono: userPhone, messageKey }); return; }
        if (messageKey) session.seenMessages.add(messageKey);

        // Blacklist check
        if (session.isBlacklisted) {
            if (!session.blacklistNotified) {
                session.blacklistNotified = true;
                session.botActivo = false;
                try {
                    await setLeadBotMode(orgId, session.partialData.telefono, 'manual');
                    await setEscalationReason(orgId, session.partialData.telefono, 'lista_negra');
                    const contact = await findByPhone(orgId, session.partialData.telefono);
                    // Notify antes del INSERT: ver escalateToHuman.
                    notifyBlacklistAlert(orgId, { nombre: contact?.nombre || session.partialData.nombre, telefono: session.partialData.telefono, blacklist_reason: contact?.blacklist_reason }).catch(() => {});
                    await createPendingAction(orgId, {
                        type: 'escalation',
                        contactId: contact?.id || session.leadId,
                        payload: { motivo: 'lista_negra', mensaje: userText },
                    });
                } catch (e) { logger.error('error_blacklist_notify', { telefono: userPhone, error: e.message }); }
                await _send('Gracias por tu mensaje 🙏 En breve te atenderá nuestro equipo.');
                persistSession(orgId, userPhone, session);
            }
            // Log explícito ANTES del return: un contacto silenciado por lista negra
            // debe ser visible en logs. Sin esto, la ejecución terminaba tras
            // process_core_inicio sin rastro y parecía un "cuelgue silencioso".
            logger.info('process_core_blacklist_return', { orgId, telefono: userPhone, blacklistNotified: session.blacklistNotified });
            return;
        }

        const textLower = userText.toLowerCase().trim();
        if (textLower === 'stop') {
            session.botActivo = false;
            await _send(config.conversation?.deactivatedMessage || 'Asistente desactivado.');
            return;
        }
        if (textLower === 'start') {
            session.botActivo = true;
            await _send(config.conversation?.reactivatedMessage || 'Asistente activado.');
            return;
        }
        if (!session.botActivo) { logger.info('process_core_sesion_bot_inactivo', { orgId, telefono: userPhone }); return; }

        const now = Date.now();
        if (session.lastMessageTime && (now - session.lastMessageTime) < (config.conversation?.duplicateMessageWindowMs || 1500)) { logger.info('process_core_msg_rapido_duplicado', { orgId, telefono: userPhone, deltaMs: now - session.lastMessageTime }); return; }

        session.messageCount++;
        // BUG 5: el salón tiene conversaciones más largas (idioma, servicio, estilista,
        // upselling, segunda cita) → límite más alto para no cortar reservas normales.
        // Y el mensaje de límite de San Remo ("Alberto te contactará") NO debe filtrarse
        // a Sante: usamos uno neutral y multiidioma.
        const maxMsg = orgType === 'salon'
            ? (config.conversation?.maxMessagesPerSessionSalon || 60)
            : (config.conversation?.maxMessagesPerSession || 30);
        if (session.messageCount > maxMsg) {
            if (session.messageCount === maxMsg + 1) {
                let limitMsg;
                if (orgType === 'salon') {
                    const limitMsgs = {
                        en: 'For anything else, our team will get back to you shortly 😊',
                        ru: 'По любым другим вопросам наша команда скоро свяжется с тобой 😊',
                        uk: 'З будь-яких інших питань наша команда незабаром зв’яжеться з тобою 😊',
                    };
                    limitMsg = (session.language && limitMsgs[session.language]) ||
                        'Para cualquier otra cosa, nuestro equipo te atenderá enseguida 😊';
                } else {
                    limitMsg = config.conversation?.limitMessage || 'Hemos llegado al límite de mensajes.';
                }
                await _send(limitMsg);
                session.botActivo = false;
                // La promesa del mensaje ("nuestro equipo te atenderá") tiene que ser real.
                // Hasta ahora solo se silenciaba la sesión EN MEMORIA: cero fila en
                // pending_actions, cero Telegram, y contacts.bot_mode seguía en 'auto', así
                // que la reconciliación de arriba (L1820/L1889) revivía el bot en el mensaje
                // siguiente. Mismo patrón de bug que "el más cercano": escalada anunciada y no
                // ejecutada. Solo Sante: San Remo mantiene el comportamiento actual.
                if (orgType === 'salon') {
                    const escalada = await escalateToHuman(session, userPhone, 'limite_mensajes', userText);
                    if (!escalada) logger.warn('limite_escalada_fallida', { orgId, telefono: userPhone });
                    persistSession(orgId, userPhone, session);
                }
            }
            return;
        }

        session.lastMessageTime = now;
        session.lastUpdate = now;
        const sanitized = sanitizeUserMessage(userText);
        if (!sanitized) return;

        // Cada turno arranca sin haber consultado el motor de huecos (lo marca
        // loadAvailableSlots). Lo usa la red anti-escalada-falsa más abajo.
        session._slotsQueriedThisTurn = false;

        // ─── Snapshot del estado ANTES de modificar la sesión ────────────
        // Si el LLM falla/timeout, restauramos para no dejar la sesión en un
        // estado parcial que confunde al LLM en el siguiente turno.
        _snapshot = {
            historyLen:          session.history.length,
            selectedService:     session.selectedService ? { ...session.selectedService } : null,
            selectedStylist:     session.selectedStylist ? { ...session.selectedStylist } : null,
            availableSlots:      session.availableSlots.slice(),
            proposedSlots:       (session.proposedSlots || []).slice(),
            currentSlotIndex:    session.currentSlotIndex,
            slotsProposed:       session.slotsProposed,
            datePreferenceAsked: session.datePreferenceAsked,
            upsellingSuggested:  session.upsellingSuggested,
            pendingLargoCategory: session.pendingLargoCategory,
            largoPelo:           session.largoPelo,
            pendingCorteGenero:  session.pendingCorteGenero,
            pendingCorteMujerTipo: session.pendingCorteMujerTipo,
            pendingCorteNinoTipo: session.pendingCorteNinoTipo,
            partialData:         JSON.parse(JSON.stringify(session.partialData)),
        };

        session.history.push({ role: 'user', content: sanitized, ts: Date.now() });
        // Las fotos que llegaron mientras esto se cocía van DESPUÉS de su texto, que es el
        // orden real en el que ocurrieron (Michal: texto 11:04:54.230, foto 11:04:54.938).
        const mediaDrenados = drainPendingMediaTurns(sKey, session);
        if (mediaDrenados) logger.info('media_turnos_al_historial', { orgId, telefono: userPhone, turnos: mediaDrenados });
        incrementMetric('userReplied');

        try { await (await client.getChatById(userPhone)).sendStateTyping(); } catch {}

        // ─── Extract data based on org type ───────────────────────────────
        const prevData = { ...session.partialData };

        if (orgType === 'salon') {
            // Salon: extract name, preference, detect service/stylist from LLM.
            // extractQuickDataSante fusiona la señal de fecha del turno en el ÚNICO store
            // (preferencia_horaria) vía el reducer idempotente — ya no hay sticky paralelo.
            // stylistQuestionPending: si el turno anterior dejó abierta la pregunta de
            // estilista, "el más cercano" contesta a QUIÉN y no debe tocar la fecha.
            session.partialData = extractQuickDataSante(sanitized, session.partialData, [], [],
                {
                    stylistQuestionPending: !!session.stylistQuestionPending,
                    // Para descartar "августа"/"марта" como nombre cuando son la respuesta a
                    // "¿qué día te viene bien?" (son mes en genitivo Y nombre de mujer real).
                    datePreferenceAsked: !!session.datePreferenceAsked,
                });
            // Bug 1: si el nombre extraído coincide con un servicio del catálogo, descartarlo
            if (session.partialData.nombre && session.partialData.nombre !== prevData.nombre) {
                const agentCfgNameCheck = await getAgentConfig(orgId);
                if (isServiceName(session.partialData.nombre, agentCfgNameCheck?.services || [])) {
                    logger.info('nombre_es_servicio_descartado', { orgId, telefono: userPhone, nombre: session.partialData.nombre });
                    session.partialData.nombre = prevData.nombre || null;
                }
            }
            // Detectar idioma en CADA mensaje para que el bot responda en el
            // idioma actual del cliente, no en el de una sesión anterior.
            const lang = detectLanguage(sanitized);
            if (lang) {
                session.language = lang;

                // La marca de OBSERVADO solo sube si el idioma ha quedado persistido. Si la
                // respuesta venía de una centralita (ver persistirIdiomaObservado), la sesión
                // se queda con el idioma para contestar pero SIN ascender la fuente: no se ha
                // leído a nadie.
                const persistido = await persistirIdiomaObservado(orgId, session, lang, {
                    dbPhone: _dbPhone, userPhone, origen: 'detector',
                });
                if (persistido) session.languageSource = 'observed';
            }

            // ─── Trato de usted / de tú ─────────────────────────────────
            // Olga Yarmak pidió «Тогда давай на вы 🧐» (07/08/2026): el bot dijo que sí y
            // volvió a tutearla al turno siguiente. El trato no existía como dato, así que
            // el "sí" duraba lo que el LLM lo arrastrase del historial — y en cuanto
            // contestaba un texto FIJO (están escritos en `ты`) se perdía sin más.
            // Se guarda en la ficha porque no es de esta conversación: quien pide que la
            // traten de usted lo pide para siempre, no para los cinco minutos siguientes.
            const tratoPedido = detectTratamiento(sanitized);
            if (tratoPedido && tratoPedido !== session.tratamiento) {
                session.tratamiento = tratoPedido;
                const leadId = await ensureLeadId(orgId, session);
                if (leadId) {
                    // Falla hacia el lado recuperable: si la escritura no va, la sesión ya
                    // lleva el trato y este turno sale bien; lo que se pierde es el recuerdo.
                    try {
                        await setContactTratamiento(orgId, leadId, tratoPedido);
                    } catch (e) {
                        logger.error('tratamiento_no_guardado', { orgId, telefono: userPhone, error: e.message });
                    }
                } else {
                    logger.warn('tratamiento_sin_leadid', { orgId, telefono: userPhone, tratamiento: tratoPedido });
                }
                logger.info('tratamiento_detectado', { orgId, telefono: userPhone, tratamiento: tratoPedido });
            }
        } else {
            // Restaurant: extract name, personas, preference
            session.partialData = extractQuickData(sanitized, session.partialData);
        }

        const intent = detectIntent(sanitized);

        // ─── Salon: citas que YA existen ─────────────────────────────────
        // Va ANTES de la segunda reserva a propósito: era ese bloque el que convertía
        // "es para mi cita de las 6" en una cita nueva. Si devuelve false, o bien el
        // mensaje no hablaba de ninguna cita existente (flujo normal intacto) o bien la
        // cita ya ha quedado cargada en sesión y el turno continúa sobre ELLA.
        if (orgType === 'salon') {
            delete session._citasVivasTurno;   // caché de turno: se relee en cada mensaje
            // Se resuelve SIEMPRE, no solo cuando un detector se dispara: el bloque
            // __citasVivas del prompt es el refuerzo que cubre las frases que los detectores
            // no ven, y sin leer no puede afirmar nada (decirle al modelo "no tiene ninguna
            // cita" porque no hemos mirado es la misma mentira, con otro emisor).
            // Es una lectura indexada por (organization_id, contact_id) y sustituye a la que
            // ya hacía el ancla, así que el coste neto por turno es prácticamente el mismo.
            // Hay una reserva esperando el nombre (o el apellido): este turno ES la respuesta
            // a esa pregunta. Va ANTES que nada, incluido el LLM: si dejáramos que el modelo
            // interpretara "Marta" por su cuenta, la reserva en espera se quedaría colgada.
            if (await handleNombreParaCita(client, orgId, session, sanitized, _send, userPhone)
                || await handleApellidoParaCita(client, orgId, session, sanitized, _send, userPhone)) {
                persistSession(orgId, userPhone, session);
                triggerAsyncSummary(orgId, userPhone, session);
                return;
            }

            await resolveCitasVivas(orgId, session);
            if (await handleCitasExistentes(client, orgId, session, sanitized, _send, userPhone)) {
                persistSession(orgId, userPhone, session);
                triggerAsyncSummary(orgId, userPhone, session);
                return;
            }
        }

        // ─── Salon: segunda reserva en la misma conversación ─────────────
        // Si ya hay una cita confirmada y la clienta pide otra (para ella o un
        // acompañante), reiniciamos el flujo para gestionar y guardar la nueva cita.
        if (orgType === 'salon') {
            // ─── Reinicio del flujo ("empecemos desde 0", "empezar de nuevo") ──
            // Sin cita confirmada, la clienta pide arrancar de cero. Todos los bloques de
            // resolución de servicio están gateados por !selectedService, así que si no
            // limpiamos aquí, el servicio anterior (y su árbol de corte a medias) persiste
            // y el siguiente servicio nombrado ("corte para niño") no lo sobreescribe:
            // slots_para_llm seguía mostrando el servicio viejo. (Con cita confirmada NO
            // tocamos nada: eso lo gestiona la segunda reserva más abajo.)
            if (!session.reservaConfirmada && wantsRestart(sanitized)) {
                clearServiceState(session);
                logger.info('session_restart_flujo', { orgId, telefono: userPhone });
            }
            // Segunda reserva: además de las frases explícitas ("otra cita", "reservar otra"),
            // detectamos cuando la clienta —con una cita YA confirmada— pide un SERVICIO o una
            // ESTILISTA distintos del reservado (ej. "quiero matiz con Irina" tras una manicura
            // con Olgha). Sin esto, el flujo NO se reiniciaba: reservaConfirmada seguía en true,
            // el estado quedaba obsoleto (servicio/estilista de la 1ª cita), no se cargaban los
            // huecos reales de la nueva petición y el LLM improvisaba disponibilidad inventada
            // (p.ej. "Irina el viernes", cuando no trabaja ese día) y decía "confirmada" mientras
            // la guarda de reservaConfirmada impedía guardar → cita perdida en silencio.
            if (session.reservaConfirmada) {
                let nuevaReserva = wantsAnotherBooking(sanitized);
                // Categoría pedida que NO resuelve a un servicio concreto: se recuerda para
                // resolverla en el turno siguiente ("¿qué tipo de masaje?" → "completo").
                let categoriaNueva = null;
                if (!nuevaReserva) {
                    try {
                        const cfgSecond = await getAgentConfig(orgId);
                        // OFERTA: esto abre una SEGUNDA reserva, así que un servicio dado
                        // de baja no puede dispararla.
                        const catalogSecond = offerableCatalog(cfgSecond?.services);
                        const svcNuevo = extractServiceFromText(sanitized, catalogSecond);
                        // Guard: si el servicio detectado es el upselling que el bot ACABA de
                        // ofrecer (o uno ya aceptado en esta cita), la clienta lo está aceptando
                        // ("sí k18"), NO pidiendo una segunda reserva. Sin esto, extractServiceFromText
                        // encuentra el upsell como "servicio distinto" y dispara un reset que borra la
                        // cita confirmada y termina creando una cita basura duplicada.
                        const esUpsellDetectado = svcNuevo && (
                            (session.upsellingSuggested && session._lastUpsellSuggestion &&
                                matchesServiceName(svcNuevo.nombre, session._lastUpsellSuggestion)) ||
                            (session.upsellingAccepted || []).some(u => matchesServiceName(svcNuevo.nombre, u))
                        );
                        if (!esUpsellDetectado) {
                            if (svcNuevo && svcNuevo.nombre !== session.selectedService?.nombre) {
                                nuevaReserva = true;
                            } else {
                                const stylistsSecond = await getStylistsByOrg(orgId);
                                const styNuevo = extractStylistFromText(sanitized, stylistsSecond);
                                if (styNuevo && styNuevo.id !== session.selectedStylist?.id) nuevaReserva = true;
                            }
                        }
                        // Nivel CATEGORÍA: extractServiceFromText devuelve null a propósito
                        // cuando la categoría es ambigua ("masaje" → 9 variantes), y sin esto
                        // el detector no veía nada. Bug 30/07/2026: "quiero un masaje antes de
                        // la pedicura" no disparaba el reset, la cita anterior seguía marcada
                        // como confirmada, las redes anti-mentira quedaban apagadas y el LLM
                        // anunció una cita que nunca se escribió.
                        if (!nuevaReserva && !svcNuevo) {
                            const catActual = normalizeText(session.selectedService?.categoria || '');
                            const upsellPend = session._lastUpsellSuggestion || '';
                            const catsPedidas = extractServiceCategoriesFromText(sanitized, catalogSecond)
                                .filter(c => normalizeText(c) !== catActual)
                                // No confundir con el upsell ofrecido: "sí, ponme el K18" nombra
                                // la categoría Reconstrucción y no es una segunda reserva.
                                .filter(c => !(upsellPend && matchesServiceName(c, upsellPend)))
                                .filter(c => !(session.upsellingAccepted || []).some(u => matchesServiceName(c, u)));
                            if (catsPedidas.length) {
                                nuevaReserva = true;
                                categoriaNueva = catsPedidas[0];
                            }
                        }
                    } catch (e) { logger.error('error_deteccion_segunda_reserva', { orgId, error: e.message }); }
                }
                // Refuerzo: una aceptación pura ("sí", "vale", "dale") con un upsell pendiente
                // nunca es una segunda reserva.
                if (session.upsellingSuggested && session._lastUpsellSuggestion && isUpsellingAcceptance(sanitized)) {
                    nuevaReserva = false;
                }
                // Cancelar y reagendar operan sobre la cita EXISTENTE: reiniciar el flujo aquí
                // borraría appointmentId y el reagendado acabaría creando una cita nueva
                // dejando viva la vieja (dos reservas facturables).
                if (intent === 'cancelar' || intent === 'cambiar') nuevaReserva = false;
                // Referirse a una cita existente tampoco es pedir otra. "Quiero añadir K18 a
                // mi cita" nombra un servicio distinto del reservado, y la inferencia de
                // arriba lo leería como segunda reserva: acabaría creando una cita aparte en
                // vez de ampliar la que ya tiene. Solo lo salva una petición EXPLÍCITA.
                if (session.citaEnCurso && !wantsAnotherBooking(sanitized)) nuevaReserva = false;
                if (nuevaReserva) {
                    // El ancla se calcula ANTES del reset: clearServiceState lo limpiaría.
                    const anchorRel = extractAnchorConstraint(sanitized);
                    const citaAncla = anchorRel ? await resolveAnchorAppointment(orgId, session) : null;
                    resetForSecondBooking(session, sanitized);
                    session.pendingServiceCategory = categoriaNueva;
                    session.anchorAppointment = citaAncla ? { ...citaAncla, rel: anchorRel } : null;
                    if (session.anchorAppointment) {
                        // El ancla fija también el DÍA. Sin esto el motor escanea desde
                        // mañana, no encuentra nada del día de la cita ancla y el filtro se
                        // queda vacío: el bot acaba ofreciendo otro día y la clienta pierde
                        // el "antes de la pedicura" que había pedido.
                        session.partialData.preferencia_horaria = applyDatePreference(
                            session.partialData.preferencia_horaria,
                            { fecha: session.anchorAppointment.fecha },
                        );
                    }
                    if (categoriaNueva || citaAncla) {
                        logger.info('segunda_reserva_contexto', {
                            orgId, telefono: userPhone,
                            categoria: categoriaNueva, ancla: session.anchorAppointment,
                        });
                    }
                }
            }
            // Mientras esperamos el nombre del acompañante, intentamos capturarlo de
            // la respuesta (nombre suelto o "se llama X") sin pisar el nombre del titular.
            if (session.guestBooking && !session.guestName) {
                const g = extractGuestName(sanitized) ||
                    (sanitized.trim().split(/\s+/).length <= 2 && isValidName(sanitized.trim()) ? sanitized.trim() : null);
                if (g) session.guestName = g.charAt(0).toUpperCase() + g.slice(1).toLowerCase();
            }
        }

        // San Remo: Bizum confirmation
        if (orgType === 'restaurant' && session.bizumAsked && !session.bizumPendiente && intent === 'bizum_hecho') {
            await finalizarReservaConBizum(client, session, userPhone);
            persistSession(orgId, userPhone, session);
            triggerAsyncSummary(orgId, userPhone, session);
            return;
        }

        // ─── Salon: respuesta a confirmación de escalada pendiente ─────
        if (orgType === 'salon' && session.pendingEscalation) {
            const pendingType = session.pendingEscalationService;
            if (isAffirmative(sanitized)) {
                session.botActivo = false;
                session.pendingEscalation = false;
                session.pendingEscalationService = null;
                const consultaReason = `consulta_${pendingType}`;
                try {
                    await setLeadBotMode(orgId, session.partialData.telefono, 'manual');
                    await setEscalationReason(orgId, session.partialData.telefono, consultaReason);
                    const contact = await findByPhone(orgId, session.partialData.telefono);
                    // Notify antes del INSERT: ver escalateToHuman.
                    notifyEscalation(orgId, { nombre: session.partialData.nombre, telefono: session.partialData.telefono }, sanitized, consultaReason).catch(() => {});
                    await createPendingAction(orgId, {
                        type: 'escalation',
                        contactId: contact?.id || session.leadId,
                        payload: { motivo: consultaReason, mensaje: sanitized },
                    });
                } catch (e) { logger.error('error_consulta_escalar', { orgId, telefono: userPhone, type: pendingType, error: e.message }); }
                const CONFIRM_YES = {
                    es: 'Perfecto 🙏 En breve una de nuestras especialistas se pondrá en contacto contigo.',
                    en: 'Perfect 🙏 One of our specialists will contact you shortly.',
                    ru: 'Отлично 🙏 Скоро одна из наших специалисток свяжется с тобой.',
                    uk: 'Чудово 🙏 Незабаром одна з наших спеціалісток зв\'яжеться з тобою.',
                };
                const lang = session.language || 'es';
                await _send(CONFIRM_YES[lang] || CONFIRM_YES.es);
                persistSession(orgId, userPhone, session);
                return;
            }
            session.pendingEscalation = false;
            session.pendingEscalationService = null;
            persistSession(orgId, userPhone, session);
        }

        // ─── Salon: servicios bajo consulta → preguntar antes de escalar ─
        if (orgType === 'salon' && !session.selectedService && !session.reservaConfirmada) {
            const consulta = detectConsultaService(sanitized);
            if (consulta) {
                const CONSULTA_ASK = {
                    extensiones: {
                        es: 'Las extensiones requieren una valoración personalizada 😊 ¿Quieres que te ponga en contacto con una de nuestras especialistas?',
                        en: 'Extensions require a personalized assessment 😊 Would you like me to put you in touch with one of our specialists?',
                        ru: 'Наращивание требует индивидуальной оценки 😊 Хочешь, чтобы я связала тебя с одной из наших специалисток?',
                        uk: 'Нарощування потребує індивідуальної оцінки 😊 Хочеш, щоб я зв\'язала тебе з однією з наших спеціалісток?',
                    },
                    permanente: {
                        es: 'La permanente requiere una valoración personalizada 😊 ¿Quieres que te ponga en contacto con una de nuestras especialistas?',
                        en: 'Perms require a personalized assessment 😊 Would you like me to put you in touch with one of our specialists?',
                        ru: 'Химическая завивка требует индивидуальной оценки 😊 Хочешь, чтобы я связала тебя с одной из наших специалисток?',
                        uk: 'Хімічна завивка потребує індивідуальної оцінки 😊 Хочеш, щоб я зв\'язала тебе з однією з наших спеціалісток?',
                    },
                    // Clave interna 'salida_negro' (y el motivo 'consulta_salida_negro' que
                    // deriva de ella) intactas: el nombre cara a la clienta es el nuevo.
                    salida_negro: {
                        es: 'La eliminación del pigmento requiere una valoración personalizada 😊 ¿Quieres que te ponga en contacto con una de nuestras especialistas?',
                        en: 'Pigment removal requires a personalized assessment 😊 Would you like me to put you in touch with one of our specialists?',
                        ru: 'Удаление пигмента требует индивидуальной оценки 😊 Хочешь, чтобы я связала тебя с одной из наших специалисток?',
                        uk: 'Видалення пігменту потребує індивідуальної оцінки 😊 Хочеш, щоб я зв\'язала тебе з однією з наших спеціалісток?',
                    },
                };
                const lang = session.language || 'es';
                const msg = CONSULTA_ASK[consulta.type]?.[lang] || CONSULTA_ASK[consulta.type]?.es;
                session.pendingEscalation = true;
                session.pendingEscalationService = consulta.type;
                await _send(msg);
                persistSession(orgId, userPhone, session);
                return;
            }
        }

        // ─── Salon: pide una hora a la que el salón no abre ──────────────
        // El caso de Olga Yarmak (07/08/2026): dijo TRES veces «после 23:00» y las tres
        // recibió "no te entiendo". La hora de reloj no la miraba nadie —
        // extractDateSignalSante saca día, fecha, semana y franja, pero no la hora — y la
        // única vía que quedaba (que lo dijera el LLM, que sí tiene el horario en el prompt)
        // la cortaba la red anti-invención, para la que "cerramos a las 19:00" son dos horas
        // sin respaldo.
        //
        // Determinista y ANTES del LLM: es un hecho del negocio, no una opinión del modelo.
        // No toca selectedService ni sinServicioStreak — la clienta no ha dejado de saber lo
        // que quiere por pedir una hora imposible, y contarlo como turno perdido la acercaría
        // al menú de rescate por algo que sí hemos sabido contestar.
        if (orgType === 'salon' && !session.reservaConfirmada) {
            const cfgHorario = (await getAgentConfig(orgId))?.business_hours;
            const fuera = detectHoraFueraDeHorario(sanitized, cfgHorario);
            // Si esa hora está entre los huecos ya ofrecidos, la clienta está ELIGIENDO, no
            // pidiendo un imposible: manda el motor, que es quien sabe la disponibilidad real.
            const esHuecoOfrecido = fuera && (session.availableSlots || [])
                .some(s => normalizeHora(s.hora) === fuera.hora);
            if (fuera && !esHuecoOfrecido) {
                const msg = salonFueraDeHorarioMsg(session, fuera);
                logger.info('hora_fuera_de_horario_detectada', {
                    orgId, telefono: userPhone, hora: fuera.hora,
                    apertura: fuera.apertura, cierre: fuera.cierre,
                });
                session.history.push({ role: 'assistant', content: msg, ts: Date.now() });
                await _send(msg);
                persistSession(orgId, userPhone, session);
                return;
            }
        }

        // ─── Salon: describe el ESTADO de su cabello → rango + consulta ──
        // Petición de Yulia (03/08/2026) tras el fallo de la noche anterior: si la clienta
        // describe su problema ("tengo el pelo seco y sin brillo") sin nombrar un servicio,
        // el bot NO adivina el tratamiento. Dice que hay muchos, da el rango y recomienda
        // la consulta, que es donde se hace el diagnóstico.
        //
        // Va ANTES del bloque de detección de servicio a propósito: corriendo después,
        // extractServiceFromText ya habría fijado "Brillo intensivo" (120 €) para un
        // "tengo el pelo sin brillo", porque 'brillo' es palabra de categoría. Y va DESPUÉS
        // del bloque de servicios bajo consulta, para que extensiones / permanente /
        // eliminación de pigmento sigan ganando: esos escalan a una especialista.
        if (orgType === 'salon' && !session.selectedService && !session.reservaConfirmada
                && !session.pendingLargoCategory && !session.pendingCorteGenero
                && !session.pendingCorteMujerTipo && !session.pendingCorteNinoTipo) {
            const problema = detectHairProblemDescription(sanitized);
            // getAgentConfig está cacheado 60 s: leerlo aquí no añade una consulta por turno.
            // OFERTA: decide si la clienta ya nombró lo que quiere o si le ofrecemos el
            // rango de tratamientos. Nombrar un servicio de baja no cuenta como haberlo
            // elegido — si contara, el flujo seguiría hacia un servicio que no se puede
            // seleccionar y se quedaría sin salida.
            const catalogoPre = problema ? offerableCatalog((await getAgentConfig(orgId))?.services) : [];
            // El residual es el mensaje sin los tramos de síntoma: si ahí queda un servicio
            // o categoría del catálogo, la clienta SÍ nombró lo que quiere ("tengo el pelo
            // seco, quiero una hidratación") y sigue el flujo normal de reserva.
            if (problema && !namesConcreteService(problema.residual, catalogoPre)) {
                if (!session.rangoTratamientosOfrecido) {
                    session.rangoTratamientosOfrecido = true;
                    const msg = salonHairTreatmentRangeMsg(session);
                    logger.info('tratamiento_generico_rango_ofrecido', {
                        orgId, telefono: userPhone, intento: 1,
                    });
                    session.history.push({ role: 'assistant', content: msg, ts: Date.now() });
                    await _send(msg);
                    persistSession(orgId, userPhone, session);
                    return;
                }
                // Segunda descripción sin nombrar servicio: repetir el mismo párrafo sería
                // el bucle del 02/08. Se selecciona la Consulta por la vía legítima (igual
                // que el gate de detectConsultaValoracion) y el turno sigue: huecos + LLM.
                const consultaSvc = catalogoPre.find(isReactiveOnlyService);
                if (consultaSvc) {
                    session.selectedService = consultaSvc;
                    session.consultaValoracionDetectada = true;
                    session.consultaOfrecida = false;
                    logger.info('tratamiento_generico_rango_ofrecido', {
                        orgId, telefono: userPhone, intento: 2, accion: 'consulta_seleccionada',
                    });
                }
            }
        }

        // ─── Salon: detectar servicio/estilista ANTES del LLM ────────────
        // Así los huecos se calculan en el MISMO turno en que la clienta nombra
        // el servicio (ej. "un masaje relajante") y el LLM los propone directamente,
        // sin un turno de espera ni mensajes de "un momento".
        if (orgType === 'salon') {
            const agentCfgPre = await getAgentConfig(orgId);
            const stylistsPre = await getStylistsByOrg(orgId);
            // Este bloque es el que ELIGE servicio a partir de lo que ha escrito la clienta:
            // cortes, detección libre, K18, categoría por largo, consulta. Todo eso es
            // OFERTA y va contra el catálogo ofertable. Las dos excepciones se marcan donde
            // están: las variantes indexadas por posición (arriba) y las guardas que solo
            // usan el catálogo para descartar un nombre propio (abajo).
            const catalogoOfertable = offerableCatalog(agentCfgPre?.services);

            // ── Segunda reserva: resolver el servicio DENTRO de la categoría pedida ──
            // La clienta pidió "un masaje" (categoría ambigua), el bot preguntó el tipo y
            // ahora responde "completo". Contra el catálogo entero eso da null (empata con
            // "Color completo largo N") y el flujo se quedaba sin servicio: sin servicio no
            // hay huecos, y sin huecos el LLM improvisa. Restringido a la categoría resuelve.
            if (session.pendingServiceCategory && !session.selectedService) {
                const catNorm = normalizeText(session.pendingServiceCategory);
                // OFERTA: selecciona el servicio dentro de la categoría pedida.
                const enCategoria = catalogoOfertable.filter(s => normalizeText(s.categoria) === catNorm);
                const svcEnCat = extractServiceFromText(sanitized, enCategoria);
                if (svcEnCat) {
                    logger.info('servicio_resuelto_en_categoria', {
                        orgId, telefono: userPhone,
                        categoria: session.pendingServiceCategory, servicio: svcEnCat.nombre,
                    });
                    session.selectedService = svcEnCat;
                    session.pendingServiceCategory = null;
                }
            }

            // ── Mechas clásicas resolution: coverage type, not hair length
            if (session.pendingLargoCategory && normalizeText(session.pendingLargoCategory) === 'mechas clasicas' && !session.selectedService) {
                const tipo = extractMechasClasicasTipo(sanitized);
                if (tipo != null) {
                    // Catálogo COMPLETO a propósito: la elección es POSICIONAL
                    // (`candidates[tipo - 1]`), así que filtrar aquí los servicios de baja
                    // correría los índices y "media cabeza" resolvería a la cobertura de al
                    // lado — otro precio, y sin que nada lo delate. Es la misma familia de
                    // fallo que el "Largo 2" ambiguo de la auditoría de facturación. El
                    // servicio de baja se descarta DESPUÉS, ya elegido.
                    const catalog = agentCfgPre?.services || [];
                    const catNorm = normalizeText(session.pendingLargoCategory);
                    const candidates = catalog.filter(s =>
                        normalizeText(s.categoria) === catNorm && /\d+\s*$/.test(normalizeText(s.nombre))
                    ).sort((a, b) => {
                        const na = parseInt(normalizeText(a.nombre).match(/(\d+)\s*$/)?.[1] || '0', 10);
                        const nb = parseInt(normalizeText(b.nombre).match(/(\d+)\s*$/)?.[1] || '0', 10);
                        return na - nb;
                    });
                    const idx = Math.min(tipo - 1, candidates.length - 1);
                    if (idx >= 0 && candidates[idx]) {
                        if (isServiceActive(candidates[idx])) {
                            session.selectedService = candidates[idx];
                            session.pendingLargoCategory = null;
                        } else {
                            // Ni se selecciona ni se limpia `pendingLargoCategory`: la
                            // pregunta sigue viva y el turno siguiente vuelve a intentarlo.
                            logger.info('servicio_inactivo_no_seleccionado', {
                                orgId, telefono: userPhone, via: 'mechas_clasicas_tipo',
                                servicio: candidates[idx].nombre, categoria: candidates[idx].categoria,
                            });
                        }
                    }
                }
            }
            // ── Largo resolution: if we're waiting for hair length, try to extract it
            else if (session.pendingLargoCategory && !session.selectedService) {
                const largo = extractLargoPelo(sanitized);
                const noSabe = /\b(no se|no lo se|ni idea|no tengo idea|no estoy segur|i don.?t know|i.?m not sure|не знаю|не впевнен)\b/.test(normalizeText(sanitized));
                // "Largo 1/2/3/4" as direct variant name: extractLargoPelo returns null for these
                // (intentional guard), so we detect the number directly.
                const variantNum = parseInt(normalizeText(sanitized).match(/\blargo\s+(\d)\b/)?.[1] || '0', 10);
                if (largo != null || noSabe || variantNum > 0) {
                    // Catálogo COMPLETO: misma razón que en Mechas clásicas, la elección es
                    // posicional sobre las variantes ordenadas por largo. Filtrar aquí haría
                    // que "cabello largo" cayera en la variante de al lado.
                    const catalog = agentCfgPre?.services || [];
                    const catNorm = normalizeText(session.pendingLargoCategory);
                    const candidates = catalog.filter(s =>
                        normalizeText(s.categoria) === catNorm && classifyLargoVariant(s.nombre) != null
                    ).sort((a, b) => classifyLargoVariant(a.nombre) - classifyLargoVariant(b.nombre));
                    const idx = variantNum > 0
                        ? Math.min(variantNum - 1, candidates.length - 1)
                        : largo != null
                            ? Math.min(largo - 1, candidates.length - 1)
                            : Math.min(1, candidates.length - 1); // default to Largo 2 (medium)
                    if (idx >= 0 && candidates[idx]) {
                        if (isServiceActive(candidates[idx])) {
                            session.selectedService = candidates[idx];
                            session.largoPelo = largo;
                            session.pendingLargoCategory = null;
                        } else {
                            logger.info('servicio_inactivo_no_seleccionado', {
                                orgId, telefono: userPhone, via: 'largo_variante',
                                servicio: candidates[idx].nombre, categoria: candidates[idx].categoria,
                            });
                        }
                    }
                }
            }
            // ── Largo CORRECTION: la clienta ya tiene un servicio de largo asignado
            // (turno anterior) pero menciona explícitamente un largo DISTINTO antes de
            // pasar a fecha/estilista (ej. "me equivoqué, cabello corto" → luego "perdón,
            // muy largo"). Solo se activa dentro de la MISMA categoría ya elegida — nunca
            // reabre selección de servicio libre (eso sigue bloqueado en los bloques de
            // abajo, gateados por !session.selectedService). Excluimos "Mechas clásicas":
            // sus variantes numeradas (Mechas 1/2/3) codifican TIPO DE COBERTURA
            // (delante/media cabeza/completa), no longitud de pelo — esa categoría ya
            // tiene su propia resolución arriba con extractMechasClasicasTipo.
            else if (session.selectedService && !session.pendingLargoCategory
                && normalizeText(session.selectedService.categoria || '') !== 'mechas clasicas') {
                // Catálogo COMPLETO: elección posicional, igual que los dos bloques de
                // arriba. El descarte del servicio de baja va en la condición de abajo.
                const catalog = agentCfgPre?.services || [];
                const catNorm = normalizeText(session.selectedService.categoria || '');
                const sorted = catalog
                    .filter(s => normalizeText(s.categoria) === catNorm && classifyLargoVariant(s.nombre) != null)
                    .sort((a, b) => classifyLargoVariant(a.nombre) - classifyLargoVariant(b.nombre));
                if (sorted.length >= 2) {
                    const largo = extractLargoPelo(sanitized);
                    const variantNum = parseInt(normalizeText(sanitized).match(/\blargo\s+(\d)\b/)?.[1] || '0', 10);
                    const newLevel = variantNum > 0 ? variantNum : largo;
                    const currentLevel = classifyLargoVariant(session.selectedService.nombre);
                    if (newLevel != null && newLevel !== currentLevel) {
                        const idx = Math.min(newLevel - 1, sorted.length - 1);
                        if (idx >= 0 && sorted[idx] && !isServiceActive(sorted[idx])) {
                            // La corrección apuntaba a una variante de baja: se deja el
                            // servicio que ya tenía, que sigue siendo reservable.
                            logger.info('servicio_inactivo_no_seleccionado', {
                                orgId, telefono: userPhone, via: 'largo_correccion',
                                servicio: sorted[idx].nombre, categoria: sorted[idx].categoria,
                            });
                        } else if (idx >= 0 && sorted[idx] && sorted[idx].nombre !== session.selectedService.nombre) {
                            logger.info('largo_correccion_aplicada', {
                                orgId, telefono: userPhone, categoria: session.selectedService.categoria,
                                antes: session.selectedService.nombre, despues: sorted[idx].nombre,
                            });
                            session.selectedService = sorted[idx];
                            session.largoPelo = largo;
                            if (session.selectedStylist) {
                                const styRec = stylistsPre.find(s => s.id === session.selectedStylist.id);
                                if (styRec && !stylistCanDoService(styRec, sorted[idx])) {
                                    session.selectedStylist = null;
                                }
                            }
                        }
                    }
                }
            }

            // ── Corte gender/type sub-flow resolution (deterministic) ────────
            // El árbol de cortes reparte el servicio en varios turnos (género → tipo),
            // y cada respuesta suelta ("mujer", "con Dyson") no casa contra el catálogo.
            // Guardamos el punto del árbol en session.pendingCorte* y resolvemos aquí, en
            // el MISMO turno, para que loadAvailableSlots corra ya con el servicio correcto
            // (sin el desfase de esperar a que el LLM devuelva datos.servicio).
            if (session.pendingCorteMujerTipo && !session.selectedService) {
                const tipo = detectCorteMujerTipo(sanitized);
                if (tipo) {
                    const svc = findCorteService(catalogoOfertable, ['mujer', tipo === 'dyson' ? 'dyson' : 'secado']);
                    if (svc) {
                        session.selectedService = svc;
                        session.pendingCorteMujerTipo = false;
                        session.pendingCorteGenero = false;
                        logger.info('corte_resuelto_mujer', { orgId, telefono: userPhone, tipo, servicio: svc.nombre });
                    }
                }
            } else if (session.pendingCorteNinoTipo && !session.selectedService) {
                const tipo = detectCorteNinoTipo(sanitized);
                if (tipo) {
                    const svc = tipo === 'infantil'
                        ? findCorteService(catalogoOfertable, ['infantil'])
                        : findCorteService(catalogoOfertable, ['nino'], ['infantil']);
                    if (svc) {
                        session.selectedService = svc;
                        session.pendingCorteNinoTipo = false;
                        session.pendingCorteGenero = false;
                        logger.info('corte_resuelto_nino', { orgId, telefono: userPhone, tipo, servicio: svc.nombre });
                    }
                }
            } else if (session.pendingCorteGenero && !session.selectedService) {
                const genero = detectCorteGenero(sanitized);
                if (genero === 'hombre') {
                    const svc = findCorteService(catalogoOfertable, ['hombre']);
                    if (svc) {
                        session.selectedService = svc;
                        session.pendingCorteGenero = false;
                        logger.info('corte_resuelto_hombre', { orgId, telefono: userPhone, servicio: svc.nombre });
                    }
                } else if (genero === 'mujer') {
                    session.pendingCorteGenero = false;
                    session.pendingCorteMujerTipo = true;
                } else if (genero === 'nino') {
                    session.pendingCorteGenero = false;
                    session.pendingCorteNinoTipo = true;
                }
            }

            if (!session.selectedService) {
                let matchedSvc = extractServiceFromText(sanitized, catalogoOfertable);
                // Mención genérica de K18 ("k18", "reconstrucción k18"). Tras la migración 026
                // no existe una entrada llamada exactamente "K18": extractServiceFromText cae a
                // null para "k18" y al complemento de 15 min para "reconstrucción k18". Aquí no
                // hay servicio principal aún, así que no hay color donde engancharlo → resuelve
                // al suelto de 60 min. Solo se pisa un match de la propia categoría Reconstrucción:
                // en "balayage y k18" el principal es el balayage y el K18 llega luego por upsell.
                const k18Svc = resolveK18ServiceFromText(sanitized, session.selectedService?.categoria, catalogoOfertable);
                if (k18Svc && (!matchedSvc || normalizeText(matchedSvc.categoria || '') === 'reconstruccion')) {
                    matchedSvc = k18Svc;
                }
                if (matchedSvc) {
                    session.selectedService = matchedSvc;
                    // Cliente cambió de servicio (nombró otro por keyword): descartamos
                    // cualquier árbol de corte pendiente para no arrastrar estado obsoleto.
                    session.pendingCorteGenero = false;
                    session.pendingCorteMujerTipo = false;
                    session.pendingCorteNinoTipo = false;
                    // Re-validate: stylist set in a prior turn may not have the skill
                    // for the newly selected service (e.g. Larisa set before manicura).
                    if (session.selectedStylist) {
                        const styRec = stylistsPre.find(s => s.id === session.selectedStylist.id);
                        if (styRec && !stylistCanDoService(styRec, matchedSvc)) {
                            session.selectedStylist = null;
                        }
                    }
                } else if (!session.pendingLargoCategory && !session.pendingCorteGenero && !session.pendingCorteMujerTipo && !session.pendingCorteNinoTipo) {
                    const largoCat = detectLargoCategory(sanitized, catalogoOfertable);
                    if (largoCat) session.pendingLargoCategory = largoCat;
                    else if (detectCorteGenerico(sanitized)) session.pendingCorteGenero = true;
                }
            }
            // Consulta de valoración (REACTIVA): la clienta pide asesoramiento sin nombrar
            // un servicio concreto. Solo si no hay servicio ya resuelto ni flujo de
            // largo/corte pendiente — así "no sé si prefiero corto o largo" dentro de otro
            // servicio nunca cae aquí. Se agenda como bloque "Consulta" (300 min).
            if (!session.selectedService && !session.pendingLargoCategory &&
                !session.pendingCorteGenero && !session.pendingCorteMujerTipo &&
                !session.pendingCorteNinoTipo
                && (detectConsultaValoracion(sanitized)
                    || (session.consultaOfrecida && isAffirmative(sanitized)))) {
                const consultaSvc = catalogoOfertable.find(isReactiveOnlyService);
                if (consultaSvc) {
                    session.selectedService = consultaSvc;
                    // Única vía legítima. Marca que el servicio reactivo viene del detector
                    // y no de una ocurrencia del LLM (ver el descarte en la vía LLM).
                    session.consultaValoracionDetectada = true;
                    session.consultaOfrecida = false;
                }
            }
            // Recuperar el servicio desde partialData.servicio (capturado por el LLM en
            // un turno previo) ANTES del filtro de estilistas, para que la asignación de
            // la estilista correcta y el descarte de una obsoleta ocurran en ESTE turno.
            if (!session.selectedService && session.partialData.servicio) {
                // Desambiguar usando categoria_servicio de partialData cuando el nombre
                // del servicio es compartido entre varias categorías (ej. "Largo 3").
                // OFERTA: recupera un servicio para una reserva que aún no existe. Un
                // servicio de baja arrastrado en partialData desde antes de la baja no
                // puede reactivarse por esta vía.
                const catalog = catalogoOfertable;
                const partialNorm = normalizeText(session.partialData.servicio);
                const partialCatNorm = normalizeText(session.partialData.categoria_servicio || '');
                const matchesPartial = catalog.filter(s => normalizeText(s.nombre) === partialNorm);
                let recovered = null;
                if (matchesPartial.length === 1) {
                    recovered = matchesPartial[0];
                } else if (matchesPartial.length > 1 && partialCatNorm) {
                    recovered = matchesPartial.find(s => normalizeText(s.categoria) === partialCatNorm) || null;
                }
                if (!recovered) recovered = extractServiceFromText(session.partialData.servicio, catalog);
                // partialData.servicio lo rellena el LLM: un servicio reactivo por esta vía
                // sigue siendo una oferta suya, no una petición de la clienta.
                if (recovered && isReactiveOnlyService(recovered) && !session.consultaValoracionDetectada) {
                    logger.info('servicio_reactivo_llm_descartado', {
                        orgId, telefono: userPhone, servicio: recovered.nombre, via: 'partialData',
                    });
                    recovered = null;
                }
                if (recovered) {
                    session.selectedService = recovered;
                    logger.info('selectedService_recovered_from_partialData', { orgId, telefono: userPhone, servicio: recovered.nombre });
                }
            }
            // Estilista nombrada en el mensaje actual. Si aún no hay ninguna
            // seleccionada, la asignamos. Si el cliente CAMBIA a otra estilista en
            // pleno flujo (ej. tenía Veronika y ahora pide Irina), actualizamos
            // selectedStylist ANTES de loadAvailableSlots e invalidamos los huecos
            // de la estilista anterior para no proponer disponibilidad equivocada.
            {
                // El veredicto distingue acierto, casi-acierto, nombre inexistente y
                // "no nombró a nadie". El catálogo y el nombre de la clienta se pasan
                // como filtro anti-falso-positivo: "con mechas" o "con Ana" (ella misma)
                // NO pueden interpretarse como una estilista que no existe.
                const verdict = resolveStylistMention(sanitized, stylistsPre, {
                    // GUARDA, no oferta: el catálogo se usa aquí para que "con mechas" no
                    // se lea como el nombre de una estilista inexistente. Va COMPLETO a
                    // propósito — dar de baja un servicio no puede convertir su nombre en
                    // un nombre de persona plausible.
                    servicesCatalog: agentCfgPre?.services || [],
                    excludeNames: [session.partialData?.nombre, session.guestName].filter(Boolean),
                    guestBooking: !!session.guestBooking,
                    expectingStylist: !!session.stylistQuestionPending,
                });
                applyStylistMention(session, verdict, { orgId, telefono: userPhone });
            }

            // Backup de recuperación: si ya tenemos servicio elegido, reflejarlo en
            // partialData (servicio + categoria). Así, si selectedService se pierde en
            // un turno posterior (reinicio/timeout con mensaje corto tipo "12" que no
            // permite re-detectar), la ruta de recuperación (partialData.servicio) puede
            // restaurarlo en vez de dejar los huecos vacíos.
            if (session.selectedService?.nombre) {
                session.partialData.servicio = session.selectedService.nombre;
                if (session.selectedService.categoria) {
                    session.partialData.categoria_servicio = session.selectedService.categoria;
                }
            }
        }

        // Capturamos los huecos ANTES de cualquier recarga para que, si la
        // recarga se dispara por un falso cambio de preferencia en el texto de
        // confirmación ("vale, mañana" → semana: 'esta'), la resolución de
        // confirmación siga usando los huecos que la clienta realmente vio.
        const frozenProposed = (session.proposedSlots || []).slice();

        // ─── Load slots when ready ───────────────────────────────────────
        if (orgType === 'salon') {
            // "Me da igual / el más cercano / lo antes posible": UNA sola lectura, la de
            // helpers (siempre sobre texto normalizado). Antes había aquí una regex paralela
            // con tildes ("el más cercano") evaluada sobre el texto CRUDO: una clienta que
            // escribía "el mas cercano" sin tilde no la activaba, la pregunta de estilista no
            // se cerraba nunca y el flujo se quedaba sin cargar huecos (28/07).
            const noPref = detectNoPreferenceSignal(sanitized);
            // La respuesta LITERAL a la pregunta de estilista ("No tengo estilista") no la
            // reconocía nadie: SIN_PREFERENCIA_RE cubre "no tengo preferencia" pero no esa.
            // El 01/08/2026 una clienta contestó exactamente eso y el flujo se quedó sin
            // saber qué hacer con su respuesta.
            //
            // Solo se consulta si el turno ANTERIOR dejó la pregunta abierta: aquí
            // session.stylistQuestionPending todavía tiene el valor del turno previo (se
            // reescribe más abajo, al calcular el gating). Fuera de ese contexto "ninguna"
            // o "es mi primera vez" pueden estar contestando a otra cosa.
            const respondeQueNoTieneEstilista =
                !!session.stylistQuestionPending && detectNoStylistPreference(sanitized);
            const meDaIgual = noPref.asapTemporal || noPref.sinPreferencia || respondeQueNoTieneEstilista;

            // Estilistas que pueden hacer el servicio (por skills). La decisión de FIJAR
            // (o no) una estilista está centralizada en assignStylistIfAppropriate: si solo
            // hay una elegible la asigna; si hay varias deja null (preguntar o combinada).
            let eligibleStylists = [];
            if (session.selectedService) {
                const allStylists = await getStylistsByOrg(orgId);
                eligibleStylists = allStylists.filter(s => stylistCanDoService(s, session.selectedService));
                assignStylistIfAppropriate(session, eligibleStylists);
            }
            session._eligibleStylistNames = eligibleStylists.map(s => s.name);

            // Intención sticky "me da igual / el más cercano": la recordamos en cuanto
            // aparece, aunque el servicio aún no esté resuelto, para que sobreviva al
            // recorrido multi-turno del árbol de cortes (root cause del bug de Irina fija).
            if (meDaIgual) session.prefiereMasCercano = true;

            // anyStylists (búsqueda combinada, sin fijar estilista) se DERIVA de la intención
            // sticky, no del mensaje actual: así "el más cercano" dicho un turno antes de que
            // el servicio se resuelva no se pierde. loadAvailableSlots ignora preferredStylistId
            // cuando es true → propone huecos de TODAS las elegibles ordenados por fecha.
            const gating = computeStylistGating(session, eligibleStylists.length);
            session.anyStylists = gating.anyStylists;
            session.askStylistFirst = gating.askStylistFirst;
            // La pregunta de estilista se marca como YA hecha en el turno en que se hace: si
            // la respuesta no resuelve nada, el turno siguiente busca en combinado en vez de
            // repreguntar eternamente sin cargar huecos (ver computeStylistGating).
            if (gating.askStylistFirst) session.stylistQuestionAsked = true;
            // Y se recuerda como PENDIENTE para el turno siguiente, que es quien tiene que
            // saber que "el más cercano" contesta a QUIÉN, no a CUÁNDO.
            session.stylistQuestionPending = gating.askStylistFirst;

            // Si es una reserva para un acompañante y aún no sabemos su nombre, lo pedimos primero.
            const esperandoNombreInvitado = session.guestBooking && !session.guestName;

            // Coherencia: si no hay huecos cargados, slotsProposed y datePreferenceAsked
            // pueden ser residuos de una interacción anterior en la misma sesión en memoria.
            // Resetearlos para que la puerta de fecha funcione limpiamente.
            if (session.availableSlots.length === 0 && !session.reservaConfirmada) {
                session.slotsProposed = false;
            }

            const prefFecha = session.partialData.preferencia_horaria || {};
            const tienePistaFecha = !!(prefFecha.semana || prefFecha.periodo || prefFecha.fecha ||
                Number.isInteger(prefFecha.diaSemana)) || session.prefiereMasCercano;
            session.askDatePreferenceFirst =
                !!session.selectedService && !session.askStylistFirst && !esperandoNombreInvitado &&
                !tienePistaFecha && !session.datePreferenceAsked && !session.reservaConfirmada &&
                session.availableSlots.length === 0;
            if (session.askDatePreferenceFirst) session.datePreferenceAsked = true;

            // Cargar huecos solo cuando ya no haya que preguntar estilista NI fecha.
            if (session.selectedService && !session.askStylistFirst && !session.askDatePreferenceFirst && !esperandoNombreInvitado) {
                const prefCambiada = JSON.stringify(prevData.preferencia_horaria) !== JSON.stringify(session.partialData.preferencia_horaria);
                if (session.availableSlots.length === 0 || prefCambiada) {
                    await loadAvailableSlots(session);
                }
            }
        } else {
            const missingFields = getMissingFields(session.partialData);
            const tieneBase = !missingFields.includes('nombre') && !missingFields.includes('personas') && session.partialData.telefono;
            const nuevaPref = !prevData.preferencia_horaria && session.partialData.preferencia_horaria;
            const prefCambiada = JSON.stringify(prevData.preferencia_horaria) !== JSON.stringify(session.partialData.preferencia_horaria);
            if (tieneBase && (nuevaPref || prefCambiada || (session.partialData.preferencia_horaria && session.availableSlots.length === 0))) {
                await loadAvailableSlots(session);
            }
        }

        // ─── Build context for LLM ───────────────────────────────────────
        const slotsParaLLM = session.availableSlots.slice(session.currentSlotIndex);

        if (orgType === 'salon') {
            logger.info('slots_para_llm', {
                orgId,
                servicio: session.selectedService?.nombre || null,
                estilista: session.selectedStylist?.nombre || null,
                preferencia: session.partialData.preferencia_horaria || null,
                totalSlots: slotsParaLLM.length,
                slots: slotsParaLLM.map(s => ({ fecha: s.fecha, hora: s.hora, estilista: s.stylistName, texto: s.texto })),
            });
        }

        // Rastreamos los huecos EXACTOS que ve el LLM (numerados) para que, cuando la
        // clienta acepte uno ("el 2", "el de las 14", "sí"), persistamos ESE hueco con su
        // estilista y fecha — no un re-match difuso contra availableSlots (BUG 2/3).
        if (orgType === 'salon') session.proposedSlots = slotsParaLLM;

        const partialDataWithCtx = {
            ...session.partialData,
            __missingFields: orgType === 'salon' ? [] : getMissingFields(session.partialData),
            __availableSlots: slotsParaLLM,
            __reservaConfirmada: session.reservaConfirmada,
            __reagendando: session.modoReagendamiento,
            __clienteRecurrente: session.clienteRecurrente,
            __ultimaVisita: session.ultimaVisita,
        };

        if (orgType === 'restaurant') {
            partialDataWithCtx.__bizumAsked = session.bizumAsked;
            partialDataWithCtx.__bizumPendiente = session.bizumPendiente;
        }

        if (orgType === 'salon') {
            // Citas REALES de la clienta. Es refuerzo, no la garantía —consultar, cancelar y
            // reagendar los resuelve la capa determinista antes de llegar aquí—, pero sin
            // este dato el modelo no tenía forma de saber que ya tenía cita y lo único que
            // sabía hacer era abrir una reserva nueva: el fallo de fondo del 01/08/2026.
            // null = la lectura falló. Se pasa tal cual para que el prompt OMITA el bloque en
            // vez de afirmar "ninguna": no haber podido mirar no es no tener citas.
            partialDataWithCtx.__citasVivas = session._citasVivasTurno ?? null;
            partialDataWithCtx.__citaEnCurso = session.citaEnCurso || null;
            partialDataWithCtx.__selectedService = session.selectedService;
            // Bug 4: si el match contra el catálogo falló pero la clienta ya mencionó un
            // servicio (capturado por el LLM en partialData.servicio), pasamos el texto crudo
            // como hint para que el LLM lo confirme en vez de volver a preguntarlo.
            partialDataWithCtx.__servicioMencionado = (!session.selectedService && session.partialData.servicio)
                ? session.partialData.servicio : null;
            partialDataWithCtx.__selectedStylist = session.selectedStylist;
            partialDataWithCtx.__upsellingSuggested = session.upsellingSuggested;
            partialDataWithCtx.__stylistAutoAssigned = !!session.selectedStylist;
            partialDataWithCtx.__askStylistFirst = !!session.askStylistFirst;
            partialDataWithCtx.__askDatePreferenceFirst = !!session.askDatePreferenceFirst;
            partialDataWithCtx.__askLargoFirst = !!session.pendingLargoCategory && !session.selectedService;
            partialDataWithCtx.__pendingLargoCategory = session.pendingLargoCategory || null;
            // Segunda reserva en curso: la clienta nombró una CATEGORÍA que aún no resuelve a
            // un servicio ("un masaje"). El modelo debe preguntar cuál de esa categoría, no
            // dar la conversación por cerrada porque ya haya una cita confirmada.
            partialDataWithCtx.__pendingServiceCategory = session.pendingServiceCategory || null;
            // Ancla temporal respecto a la cita ya reservada, y si esa ventana se quedó sin
            // huecos (los que se ofrecen son de fuera de ella y hay que decirlo).
            partialDataWithCtx.__citaAncla = session.anchorAppointment || null;
            partialDataWithCtx.__anclaSinHuecos = !!session.anchorFilterVacio;
            partialDataWithCtx.__eligibleStylistNames = session._eligibleStylistNames || [];
            // ─── Avisos de mención de estilista (one-shot) ───────────────────
            // Se consumen aquí y se limpian: el aviso se da UNA vez, en el turno
            // siguiente al que lo detectó. Las alternativas que se le ofrecen son las
            // elegibles para su servicio; si aún no hay servicio elegido, el equipo
            // entero (con lista vacía el modelo se inventaría nombres).
            partialDataWithCtx.__estilistaNoReconocida = session.stylistMentionUnknown || null;
            partialDataWithCtx.__estilistaCorregida = session.stylistMentionCorrected || null;
            partialDataWithCtx.__estilistaSinSkill = session.stylistMentionNoSkill || null;
            if (session.stylistMentionUnknown || session.stylistMentionNoSkill) {
                let alternativas = session._eligibleStylistNames || [];
                if (!alternativas.length) {
                    alternativas = (await getStylistsByOrg(orgId)).map(s => s.name);
                }
                partialDataWithCtx.__estilistaAlternativas = alternativas;
            }
            // Recordamos la mención ya avisada para no repetirla turno tras turno.
            if (session.stylistMentionUnknown) {
                session.stylistMentionRejected = normalizeText(session.stylistMentionUnknown);
            }
            session.stylistMentionUnknown = null;
            session.stylistMentionCorrected = null;
            session.stylistMentionNoSkill = null;
            partialDataWithCtx.__clientLanguage = session.language;
            // Con qué autoridad se le da ese idioma. Un idioma deducido del nombre no puede
            // pesar lo mismo que uno que la clienta ha demostrado escribiendo: la heurística
            // por nombre no separa ruso de ucraniano y falla con los nombres neutros.
            partialDataWithCtx.__clientLanguageSource = session.languageSource || null;
            partialDataWithCtx.__tratamiento = session.tratamiento || null;
            if (session.preferredStylistId) {
                const stylists = await getStylistsByOrg(orgId);
                const pref = stylists.find(s => s.id === session.preferredStylistId);
                partialDataWithCtx.__preferredStylistName = (pref && stylistCanDoService(pref, session.selectedService)) ? pref.name : null;
            }
            partialDataWithCtx.__ultimoServicio = session.ultimoServicio || null;
            partialDataWithCtx.__ultimaEstilista = session.ultimaEstilista || null;
            partialDataWithCtx.__lastStylist = session.lastStylist || null;
            partialDataWithCtx.__guestBooking = !!session.guestBooking;
            partialDataWithCtx.__guestName = session.guestName || null;
            partialDataWithCtx.__requestedDayUnavailable = !!session.slotsRequestedDayUnavailable;
            partialDataWithCtx.__semanaRelajada = !!session.slotsWeekPreferenceRelaxed;
            // Por qué la lista de huecos viene vacía. Sin esto el modelo asume "fallo del
            // sistema" y anuncia una avería que no existe (caso 7 del prompt).
            partialDataWithCtx.__causaCero = session.slotsCausaCero || null;

            // Inyectar días de trabajo de cada estilista para que el LLM sepa cuándo libran
            const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
            try {
                const allStylists = await getStylistsByOrg(orgId);
                const allSchedules = await getAllStylistSchedules(orgId);
                partialDataWithCtx.__stylistScheduleInfo = allStylists.map(st => {
                    const dias = allSchedules
                        .filter(sc => sc.stylist_id === st.id)
                        .sort((a, b) => a.day_of_week - b.day_of_week)
                        .map(sc => DIAS[sc.day_of_week]);
                    return { nombre: st.name, rol: st.role, dias: dias.join(', ') || 'Sin horario' };
                });
            } catch (e) {
                logger.error('error_loading_stylist_schedules', { orgId, error: e.message });
            }
        }

        // ─── LLM call ────────────────────────────────────────────────────
        // Esperamos la respuesta del LLM hasta 30s. Si responde, la usamos; si
        // falla o tarda más, aiResponse queda null y cae al fallback de abajo
        // ("Perdona, ¿me lo repites?"). Sin mensajes de espera intermedios.
        logger.info('process_core_pre_llm', { orgId, telefono: userPhone, historyLen: session.history.length, servicio: session.selectedService?.nombre || null });
        let aiResponse;
        const t0 = Date.now();
        const LLM_TIMEOUT_MS = 45000;

        let llmHistory;
        if (session.conversationStartedAt) {
            llmHistory = session.history.filter(m =>
                m.ts >= session.conversationStartedAt &&
                (m.role !== 'assistant' || !isFallbackText(m.content))
            );
            if (llmHistory.length === 0) {
                llmHistory = [];
            }
            logger.info('conversation_history_filtered', { orgId, telefono: userPhone, totalMessages: session.history.length, filteredMessages: llmHistory.length, conversationStartedAt: new Date(session.conversationStartedAt).toISOString() });
        } else {
            llmHistory = session.history.slice(-10).filter(m =>
                m.role !== 'assistant' || !isFallbackText(m.content)
            );
        }
        if (session.escalationJustResolved) {
            session.escalationJustResolved = false;
            llmHistory = [
                { role: 'system', content: 'La escalada anterior ha sido resuelta por el equipo. El cliente empieza una conversación nueva. Saluda normalmente y pregunta en qué puedes ayudar. NO vuelvas a escalar a no ser que el cliente lo pida explícitamente.' },
                ...llmHistory
            ];
            logger.info('escalation_resolved_context_injected', { orgId, telefono: userPhone, llmMsgs: llmHistory.length });
        }
        const llmPromise = getChatbotResponse(orgId, llmHistory, partialDataWithCtx, intent, session.reservaConfirmada, session.summary)
            .catch(e => {
                logger.error('llm_error', { orgId, telefono: userPhone, error: e.message, stack: e.stack?.split('\n').slice(0, 3).join(' | '), latencia_ms: Date.now() - t0 });
                return null;
            });

        const TIMED_OUT = {};
        const timeout = new Promise(resolve => setTimeout(() => resolve(TIMED_OUT), LLM_TIMEOUT_MS));
        const result = await Promise.race([llmPromise, timeout]);

        if (result === TIMED_OUT) {
            logger.error('llm_timeout', { orgId, telefono: userPhone, latencia_ms: Date.now() - t0 });
        } else {
            aiResponse = result;
            if (aiResponse) logger.info('llm_response', { orgId, telefono: userPhone, latencia_ms: Date.now() - t0, isFallback: !!aiResponse._isFallback, fallbackReason: aiResponse._fallbackReason || null, hasRespuesta: !!aiResponse.respuesta });
        }

        if (!aiResponse?.respuesta || aiResponse._isFallback) {
            logger.warn('fallback_diagnostico', {
                orgId, telefono: userPhone, textoRecibido: userText?.slice(0, 80),
                motivo: result === TIMED_OUT ? 'timeout' : !aiResponse ? 'llm_returned_null' : aiResponse._isFallback ? `llm_fallback:${aiResponse._fallbackReason || 'unknown'}` : 'no_respuesta_field',
                latencia_ms: Date.now() - t0,
                aiResponseKeys: aiResponse ? Object.keys(aiResponse).join(',') : 'null',
                historyLen: session.history.length,
            });
            // ── Restaurar snapshot: el LLM no pudo responder (timeout, error API,
            // o getFallbackResponse), así que deshacemos
            // todos los cambios de estado (servicio, estilista, slots, historial)
            // para que el siguiente mensaje arranque limpio sin estado corrupto.
            session.history.length        = _snapshot.historyLen;
            session.selectedService       = _snapshot.selectedService;
            session.selectedStylist       = _snapshot.selectedStylist;
            session.availableSlots        = _snapshot.availableSlots;
            session.proposedSlots         = _snapshot.proposedSlots;
            session.currentSlotIndex      = _snapshot.currentSlotIndex;
            session.slotsProposed         = _snapshot.slotsProposed;
            session.datePreferenceAsked   = _snapshot.datePreferenceAsked;
            session.upsellingSuggested    = _snapshot.upsellingSuggested;
            session.pendingLargoCategory  = _snapshot.pendingLargoCategory;
            session.largoPelo             = _snapshot.largoPelo;
            session.pendingCorteGenero    = _snapshot.pendingCorteGenero;
            session.pendingCorteMujerTipo = _snapshot.pendingCorteMujerTipo;
            session.pendingCorteNinoTipo  = _snapshot.pendingCorteNinoTipo;
            session.partialData           = _snapshot.partialData;
            const _motivo = result === TIMED_OUT ? 'timeout' : aiResponse?._isFallback ? 'llm_fallback' : 'llm_null';
            logger.info('snapshot_restaurado', { orgId, telefono: userPhone, motivo: _motivo });

            // Fallback: si ya teníamos slots cargados ANTES del fallo, los proponemos
            // directamente (la detección de servicio fue en un turno anterior válido).
            const preSlots = _snapshot.availableSlots.slice(_snapshot.currentSlotIndex);
            if (orgType === 'salon' && preSlots.length > 0 && _snapshot.selectedService) {
                const svcName = humanizeLargoLabel(buildFullServiceName(_snapshot.selectedService, [])) || 'tu servicio';
                const svcPrecio = _snapshot.selectedService.precio;
                const svcDur = _snapshot.selectedService.duracion;
                const grouped = {};
                for (const s of preSlots) {
                    const dayLabel = `${s.diaNombre ? s.diaNombre.charAt(0).toUpperCase() + s.diaNombre.slice(1) : ''} ${s.fecha ? new Date(s.fecha + 'T12:00:00').getDate() : ''}`.trim();
                    const key = dayLabel || s.fecha || 'Dia';
                    if (!grouped[key]) grouped[key] = [];
                    grouped[key].push(s.hora);
                }
                const slotsTexto = Object.entries(grouped).map(([day, horas]) => `${day}: ${horas.join(' · ')}`).join('\n');
                const fbSlotMsgs = {
                    es: `${svcName} (${svcPrecio}€, ${svcDur} min). Estos son los huecos disponibles:\n\n${slotsTexto}\n\n¿Cuál te viene mejor?`,
                    en: `${svcName} (${svcPrecio}€, ${svcDur} min). Here are the available slots:\n\n${slotsTexto}\n\nWhich one works best for you?`,
                    ru: `${svcName} (${svcPrecio}€, ${svcDur} мин). Вот доступные слоты:\n\n${slotsTexto}\n\nКакой тебе подходит?`,
                    uk: `${svcName} (${svcPrecio}€, ${svcDur} хв). Ось доступні слоти:\n\n${slotsTexto}\n\nЯкий тобі підходить?`,
                };
                const lang = session.language || 'es';
                const fbText = fbSlotMsgs[lang] || fbSlotMsgs.es;
                aiResponse = { respuesta: fbText, reserva_confirmada: false, slot_rechazado: false, accion: null, datos: {} };
                logger.info('llm_fallback_slots_preexistentes', { orgId, telefono: userPhone, numSlots: preSlots.length });
            } else if (orgType === 'salon') {
                const retryMsgs = {
                    en: "Sorry, I couldn't process that. Could you repeat? 😊",
                    ru: 'Извини, не удалось обработать. Можешь повторить? 😊',
                    uk: 'Вибач, не вдалося обробити. Можеш повторити? 😊',
                };
                const fbText = (session.language && retryMsgs[session.language]) || 'Perdona, no he podido procesar tu mensaje. ¿Me lo repites? 😊';
                aiResponse = { respuesta: fbText, reserva_confirmada: false, slot_rechazado: false, accion: null, datos: {} };
            } else {
                const fbText = 'Se me ha ido la conexión 😅 ¿me repites?';
                aiResponse = { respuesta: fbText, reserva_confirmada: false, slot_rechazado: false, accion: null, datos: {} };
            }

            // Enviar fallback SIN guardarlo en history ni procesar más lógica
            await _send(aiResponse.respuesta);
            incrementMetric('fallbacksUsed');
            persistSession(orgId, userPhone, session);
            return;
        }

        // ─── Process LLM response ────────────────────────────────────────

        // Red anti-escalada-falsa (salón). El caso 7 del prompt ("la lista de huecos no
        // carga") es lo que el LLM aplica cuando ve __availableSlots vacío — pero vacío NO
        // significa fallo: puede ser que nunca hayamos consultado el motor porque faltaba
        // preguntar servicio/estilista/fecha. Ese fue el bug del 28/07: dos clientas oyeron
        // "problema técnico" con 8 y 51 huecos libres.
        //
        // Desde la auditoría del 28/07 el criterio es más estricto: "el motor volvió vacío"
        // TAMPOCO es una avería. Un salón lleno, un servicio que no cabe en la jornada o
        // una categoría sin estilista son respuestas legítimas con su propio mensaje
        // (salonNoSlotsMsg según session.slotsCausaCero). La ÚNICA avería real es que la
        // lectura de BD haya fallado — y eso ahora llega como excepción (slotsDbError),
        // no como un [] indistinguible.
        if (orgType === 'salon' && aiResponse.accion === 'escalar_humano'
                && aiResponse.motivo_escalado === 'error_tecnico'
                && !session.slotsDbError) {
            logger.warn('sante_escalada_tecnica_falsa_bloqueada', {
                orgId, telefono: userPhone,
                slotsConsultados: !!session._slotsQueriedThisTurn,
                huecosCargados: (session.availableSlots || []).length,
                causaCero: session.slotsCausaCero || null,
                askStylistFirst: !!session.askStylistFirst,
                askDatePreferenceFirst: !!session.askDatePreferenceFirst,
                preferencia: session.partialData.preferencia_horaria || null,
            });
            aiResponse.accion = null;
            aiResponse.motivo_escalado = null;
            // Si nunca llegamos a mirar el calendario, míralo AHORA: casi siempre hay huecos.
            // Sin estilista fijada buscamos en combinado, que es justo lo que la clienta pedía
            // al decir "el más cercano".
            if (!session._slotsQueriedThisTurn && session.selectedService) {
                if (!session.selectedStylist) session.anyStylists = true;
                await loadAvailableSlots(session);
                session.proposedSlots = session.availableSlots.slice(session.currentSlotIndex);
            }
            aiResponse.respuesta = session.availableSlots.length
                ? salonOfferSlotsMsg(session)
                : salonNoSlotsMsg(session);
        }

        // Backstop de escalada ANUNCIADA pero no ejecutada (bug real del 28/07): el LLM
        // escribió "voy a pasar tu solicitud a nuestro equipo" y NO puso accion:escalar_humano
        // (la regla del prompt le hace esperar un "sí" que la clienta puede no dar nunca). El
        // resultado era una promesa vacía: cero pending_actions, cero Telegram, bot en
        // automático. Si el texto promete el traspaso, lo ejecutamos igual.
        if (orgType === 'salon' && aiResponse.accion !== 'escalar_humano'
                && announcesHumanHandover(aiResponse.respuesta)) {
            logger.warn('sante_escalada_anunciada_sin_accion', { orgId, telefono: userPhone });
            aiResponse.accion = 'escalar_humano';
            aiResponse.motivo_escalado = aiResponse.motivo_escalado || 'escalado_bot';
        }

        // La MITAD QUE FALTABA de la red de arriba. Aquella cubre "lo promete y no lo hace";
        // esta cubre "lo hace y no lo dice", que hasta el 07/08/2026 no la miraba nadie.
        //
        // Olga Yarmak: a las 15:42:10 el LLM puso accion:escalar_humano con motivo
        // 'pedir_persona' —fila en pending_actions, bot_mode a manual, Telegram al salón— y
        // el texto que le llegó a ella fue «Прости, я реально запуталась 😅 Объясни мне ещё
        // раз…»: le pedía que se explicara otra vez, justo cuando el bot acababa de dejar de
        // hablar. 44 s después escribió «me niego a hablar con un robot, solo con personas» y
        // recibió SILENCIO — correcto con bot_mode en manual, e indistinguible de que la
        // estuvieran ignorando.
        //
        // Se AÑADE, no se sustituye: el texto del modelo puede llevar información útil
        // (una disculpa, una respuesta a medias) y lo que le falta es el acuse, no el resto.
        // ─── "Dato que no tenemos": la confirmación NO se le deja al modelo ────────────
        // El escenario 23 lo cazó a la primera: el LLM contestó «I don't have that
        // information, but our team does 😊 Would you like me to connect you with them?» y en
        // el MISMO turno puso accion:"escalar_humano". O sea que preguntó y escaló a la vez.
        // Resultado: bot_mode a manual en el turno de la oferta, y el «yes please» siguiente
        // se encontró el bot ya callado. Es exactamente el fallo de Olga Yarmak —escalada
        // real seguida de silencio, indistinguible de que la ignoren— por otra puerta.
        //
        // La REGLA CRÍTICA del prompt ya lo prohíbe, y aun así pasó: un protocolo de dos
        // turnos no se sostiene sobre una instrucción. Se baja a pendingEscalation, que es la
        // maquinaria que YA resuelve el "sí" de forma determinista y en los cuatro idiomas.
        // Solo para este motivo: los otros seis los sigue gobernando el prompt, que lleva
        // meses funcionando, y tocarlos aquí sería cambiar conducta que nadie ha pedido.
        if (orgType === 'salon' && aiResponse.accion === 'escalar_humano'
            && aiResponse.motivo_escalado === 'dato_no_disponible' && !session.pendingEscalation) {
            logger.info('escalada_dato_no_disponible_a_pendiente', { orgId, telefono: userPhone });
            aiResponse.accion = null;
            aiResponse.motivo_escalado = null;
            session.pendingEscalation = true;
            session.pendingEscalationService = 'dato_no_disponible';
        }

        if (orgType === 'salon' && aiResponse.accion === 'escalar_humano') {
            const conAcuse = ensureHandoverAcknowledged(aiResponse.respuesta, session.language, session.tratamiento);
            if (conAcuse !== aiResponse.respuesta) {
                logger.warn('sante_escalada_sin_anuncio_corregida', {
                    orgId, telefono: userPhone, motivo: aiResponse.motivo_escalado || null,
                });
                aiResponse.respuesta = conAcuse;
            }
        }

        // Primera pasada anti-cita-fantasma: el despacho de acciones de abajo tiene rutas
        // que envían el texto del LLM y hacen `return` (escalar_humano), saltándose todas
        // las redes finales. Un "te he reservado… y te paso con una persona" saldría entero.
        if (orgType === 'salon') await blockPhantomBookingClaim(orgId, session, userPhone, aiResponse, sanitized);

        // Para el salón, cancelar y cambiar ya no los dispara el modelo: los resuelve la capa
        // determinista de arriba, que identifica la cita contra Supabase y —en el caso de
        // cancelar— la recita y espera un sí. Un `accion` del LLM sin cita resuelta ejecutaba
        // sobre session.appointmentId, que el salón no persiste: en la práctica cancelaba sin
        // tocar la base de datos y anunciaba "cancelada ✅", o reagendaba creando una segunda
        // cita y dejando viva la vieja. Se conserva como señal secundaria, nunca como orden.
        if (orgType === 'salon' && (aiResponse.accion === 'cancelar' || aiResponse.accion === 'cambiar')
            && !session.appointmentId) {
            logger.info('accion_llm_descartada_sin_cita', { orgId, telefono: userPhone, accion: aiResponse.accion });
            aiResponse.accion = null;
        }

        // Handle actions (cancel, reschedule, escalate)
        if (aiResponse.accion && !(aiResponse.accion === 'cambiar' && session.modoReagendamiento)) {
            const handled = await handleAppointmentAction(client, session, userPhone, aiResponse.accion, aiResponse.respuesta, aiResponse.motivo_escalado);
            if (handled) {
                if (aiResponse.accion !== 'escalar_humano') session.history.push({ role: 'assistant', content: aiResponse.respuesta, ts: Date.now() });
                persistSession(orgId, userPhone, session);
                return;
            }
        }

        // Slot rejected
        if (aiResponse.slot_rechazado && !aiResponse.reserva_confirmada && session.availableSlots.length > 0) {
            session.currentSlotIndex = Math.min(session.currentSlotIndex + 1, session.availableSlots.length - 1);
        }

        // ─── Salon-specific: process LLM datos ──────────────────────────
        if (orgType === 'salon') {
            // Language detection.
            //
            // `IDIOMAS_SOPORTADOS.includes(...)` y no solo un truthy: este es EL sitio que
            // pone `languageSource = 'observed'`, o sea el que decide de qué se puede uno
            // fiar después. Lo que no sea uno de los cuatro idiomas no es una observación
            // utilizable — se usaría como clave contra `config.plantilla_*` y contra los
            // diccionarios de texto — y marcarlo como sabido es peor que no saberlo.
            // `updateContactLanguage` ya lo rechaza, pero eso solo protege la FICHA: sin esta
            // comprobación la sesión se quedaba con el valor raro y con la marca de fiable,
            // y las dos cosas divergían sin que nada lo dijera.
            //
            // El campo llega a null cuando el modelo no lo declara (27 % de los turnos), y
            // entonces aquí no se entra: la ficha se queda como estaba, que es lo correcto.
            if (IDIOMAS_SOPORTADOS.includes(aiResponse.idioma_detectado)
                && aiResponse.idioma_detectado !== session.language) {
                session.language = aiResponse.idioma_detectado;
                // Misma guarda que la vía determinista, y por el mismo motivo: el modelo lee
                // igual de bien el texto de una centralita que el de una clienta, así que
                // dejarla solo en el otro detector no protegería nada.
                const persistidoLlm = await persistirIdiomaObservado(orgId, session, session.language, {
                    dbPhone: _dbPhone, userPhone, origen: 'llm',
                });
                if (persistidoLlm) session.languageSource = 'observed';   // el modelo lo ha leído del mensaje
            }

            // Service selection from LLM — don't load slots here; let the next
            // turn's pre-LLM logic check if we need to ask date preference first.
            // El LLM a veces devuelve el servicio en el campo de contexto __selectedService
            // (el hint que le pasamos) en lugar de en datos.servicio. Aceptamos ambos y,
            // como __selectedService puede venir como string o como objeto, extraemos el nombre.
            const servicioLLM = aiResponse.datos?.servicio
                || (typeof aiResponse.datos?.__selectedService === 'string'
                    ? aiResponse.datos.__selectedService
                    : aiResponse.datos?.__selectedService?.nombre)
                || null;
            if (servicioLLM) {
                const agentCfg = await getAgentConfig(orgId);
                // OFERTA: el modelo ya no ve los servicios de baja en el catálogo del
                // prompt, pero puede repetir uno leyéndolo del historial de la conversación
                // (o del resumen). Este filtro es el que impide que eso lo reactive.
                const servicesCatalog = offerableCatalog(agentCfg?.services);
                // Desambiguar usando categoria_servicio que el LLM puede haber devuelto,
                // o la categoría guardada en partialData. Evita coger la primera entrada
                // cuando el nombre (ej. "Largo 3") existe en varias categorías.
                const llmCatNorm = normalizeText(aiResponse.datos?.categoria_servicio || session.partialData?.categoria_servicio || '');
                const llmNomNorm = normalizeText(servicioLLM);
                const matchesLLM = servicesCatalog.filter(s => normalizeText(s.nombre) === llmNomNorm);
                let matched = null;
                if (matchesLLM.length === 1) {
                    matched = matchesLLM[0];
                } else if (matchesLLM.length > 1 && llmCatNorm) {
                    matched = matchesLLM.find(s => normalizeText(s.categoria) === llmCatNorm) || null;
                }
                if (!matched) matched = extractServiceFromText(servicioLLM, servicesCatalog);
                // Un servicio REACTIVO sólo se fija por la vía determinista. Si el modelo lo
                // devuelve sin que detectConsultaValoracion haya disparado en esta conversación,
                // es una ocurrencia suya: se descarta. Es la mitad ejecutable de "el bot no
                // ofrece la Consulta"; la otra mitad es no enseñársela en el catálogo.
                if (matched && isReactiveOnlyService(matched) && !session.consultaValoracionDetectada) {
                    logger.info('servicio_reactivo_llm_descartado', {
                        orgId, telefono: userPhone, servicio: matched.nombre, via: 'llm',
                    });
                    matched = null;
                }
                // Nueva selección (aún sin servicio) O corrección de largo dentro de la
                // MISMA categoría ya elegida — nunca un salto libre a otra categoría.
                // "Mechas clásicas" excluida: sus variantes numeradas son tipo de
                // cobertura, no longitud (ver misma exclusión en la resolución pre-LLM).
                const isNewSelection = matched && !session.selectedService;
                const isSameCategoryLargoCorrection = matched && session.selectedService
                    && normalizeText(matched.categoria || '') === normalizeText(session.selectedService.categoria || '')
                    && normalizeText(session.selectedService.categoria || '') !== 'mechas clasicas'
                    && classifyLargoVariant(matched.nombre) != null
                    && classifyLargoVariant(matched.nombre) !== classifyLargoVariant(session.selectedService.nombre);
                if (isNewSelection || isSameCategoryLargoCorrection) {
                    session.selectedService = matched;
                    if (session.selectedStylist) {
                        const stylistsPost = await getStylistsByOrg(orgId);
                        const styRec = stylistsPost.find(s => s.id === session.selectedStylist.id);
                        if (styRec && !stylistCanDoService(styRec, matched)) {
                            session.selectedStylist = null;
                        }
                    }
                }
            }

            // Stylist from LLM. shouldFixStylistFromLlm rechaza fijarla si en este
            // turno seguimos preguntando la elección (askStylistFirst): ahí la estilista
            // que devuelve el LLM es inferida del historial (habitual/última visita), no
            // una respuesta real de la clienta → fijarla se saltaría la pregunta.
            if (aiResponse.datos?.estilista_preferida && shouldFixStylistFromLlm(session)) {
                const stylists = await getStylistsByOrg(orgId);
                // assumePersonName: si el modelo rellenó este campo es porque cree que la
                // clienta nombró a alguien, así que un valor que no resuelve contra el
                // equipo ES una estilista inexistente — no hace falta heurística de
                // marcador. Es la señal de mayor precisión que tenemos para el caso
                // "Carmen". El aviso se consumirá al construir el prompt del turno
                // siguiente (igual que __servicioMencionado).
                const verdict = resolveStylistMention(aiResponse.datos.estilista_preferida, stylists, {
                    // GUARDA (ver arriba): catálogo completo, no ofertable.
                    servicesCatalog: (await getAgentConfig(orgId))?.services || [],
                    excludeNames: [session.partialData?.nombre, session.guestName].filter(Boolean),
                    guestBooking: !!session.guestBooking,
                    assumePersonName: true,
                });
                applyStylistMention(session, verdict, { orgId, telefono: userPhone });
            }

            // Deterministic upselling acceptance: if the bot suggested an upselling
            // and the client replied affirmatively but the LLM didn't set the field.
            // Cubre tanto una afirmación pura ("sí", "vale") como una respuesta que NOMBRA
            // el upsell ofrecido ("sí k18"), que no casa con isUpsellingAcceptance por sus
            // patrones anclados. Sin esto, "sí k18" no dispararía el UPDATE de la cita.
            if (session._lastUpsellSuggestion
                && session.upsellingSuggested
                && !(session.upsellingAccepted || []).includes(session._lastUpsellSuggestion)
                && (!aiResponse.datos?.upselling_aceptado?.length)) {
                const cfgDet = await getAgentConfig(orgId);
                const svcNombrado = extractServiceFromText(sanitized, cfgDet?.services || [])?.nombre;
                // Tercer brazo: casar el TEXTO CRUDO contra el upsell pendiente. Cubre "k-18"/
                // "k 18" (con separador), que extractServiceFromText no resuelve pero que
                // matchesServiceName sí reconoce al ignorar separadores internos.
                if (isUpsellingAcceptance(sanitized)
                    || matchesServiceName(svcNombrado, session._lastUpsellSuggestion)
                    || matchesServiceName(sanitized, session._lastUpsellSuggestion)) {
                    aiResponse.datos = aiResponse.datos || {};
                    aiResponse.datos.upselling_aceptado = [session._lastUpsellSuggestion];
                    logger.info('upselling_detectado_deterministico', { orgId, telefono: userPhone, servicio: session._lastUpsellSuggestion });
                }
            }

            // Upselling tracking
            if (aiResponse.datos?.upselling_aceptado?.length > 0) {
                // K18 suelto vs complemento: si el servicio PRINCIPAL ya es una técnica de
                // color, un "K18" a secas nombrado como upselling es el complemento
                // (35€/15min), no el suelto (60€/60min) — el LLM y extractServiceFromText no
                // tienen ese contexto de sesión, así que se corrige aquí antes de persistir.
                const cfgK18 = await getAgentConfig(orgId);
                aiResponse.datos.upselling_aceptado = aiResponse.datos.upselling_aceptado.map(nombre =>
                    resolveK18ComplementIfNeeded(nombre, session.selectedService?.categoria, cfgK18?.services || []));

                // Qué es NUEVO en este turno: la cita ya guardada dura lo que dura CON los
                // upsells anteriores ya dentro, así que alargarla es sumarle solo estos.
                const yaAceptados = new Set(session.upsellingAccepted || []);
                session.upsellingAccepted = [...new Set([...(session.upsellingAccepted || []), ...aiResponse.datos.upselling_aceptado])];
                const upsellsNuevos = session.upsellingAccepted.filter(n => !yaAceptados.has(n));

                if (session.reservaConfirmada && session.appointmentId && session.selectedService) {
                    const catUp = cfgK18?.services || [];
                    // Nombre COMPLETO, igual que en la creación de la cita: el nombre crudo
                    // ("Largo 2") casa con 4 entradas de catálogo de precios distintos y la
                    // facturación no puede saber cuál era. buildFullServiceName lo desambigua
                    // con la categoría ("Mechas Airtouch Largo 2").
                    const updServices = [
                        buildFullServiceName(session.selectedService, catUp),
                        ...session.upsellingAccepted,
                    ].filter(Boolean).join(' + ');
                    const upDurNuevos = upsellsNuevos.reduce(
                        (sum, name) => sum + resolveServiceDurationMin(name, catUp), 0);
                    const upDurTotal = session.upsellingAccepted.reduce(
                        (sum, name) => sum + resolveServiceDurationMin(name, catUp), 0);
                    const durPrincipal = resolveAppointmentDurationMin(session.selectedService, catUp);
                    const totalDur = durPrincipal.minutos + upDurTotal;
                    // El nuevo fin se mide sobre la cita REAL de la BD —su starts_at y su
                    // ends_at—, no sobre la fecha/hora/duración de la sesión: si la cita se
                    // movió o se alargó desde el panel, esos valores ya no coinciden y el
                    // recálculo la reescribía en otro día o, peor, MÁS CORTA (aceptar un K18
                    // de 15 min sobre unas mechas cuya duración no estaba en sesión valía
                    // 60+15: 165 minutos de agenda ocupada declarados libres).
                    // Y se hace con await: sin él, este UPDATE competía con la escritura de
                    // cierre de la misma cita y ganaba cualquiera de los dos.
                    try {
                        const apt = await getAppointmentById(orgId, session.appointmentId);
                        const { endsAt, via } = computeAmpliacionEndsAt({
                            startsAt: apt?.starts_at
                                || `${session.partialData.fecha_cita}T${session.partialData.hora_cita}:00`,
                            endsAt: apt?.ends_at,
                            extraMin: upDurNuevos,
                            totalMin: totalDur,
                        });
                        // Sin ends_at guardado hay que recalcular, y entonces sí depende de la
                        // duración del servicio: si esa tampoco se ha resuelto, el fin es una
                        // estimación sobre otra. Se registra antes de escribirlo.
                        if (via !== 'ends_at_real') {
                            logger.warn('ampliacion_fin_recalculado', {
                                orgId, telefono: userPhone, appointmentId: session.appointmentId,
                                via, duracionResuelta: durPrincipal.resuelto, via_duracion: durPrincipal.via,
                                totalDur,
                            });
                        }
                        if (!endsAt) {
                            // No hay base horaria fiable. El servicio SÍ se anota (la
                            // facturación lo necesita); el horario se deja como está en vez
                            // de escribir un fin inventado.
                            logger.error('ampliacion_sin_base_horaria', {
                                orgId, telefono: userPhone, appointmentId: session.appointmentId, servicios: updServices,
                            });
                            await updateAppointment(orgId, session.appointmentId, { servicio: updServices, actor: 'bot' });
                        } else if (await ampliacionSolapa(orgId, apt, endsAt)) {
                            // Añadir alarga la cita. Si la nueva duración se come la cita
                            // siguiente de esa estilista NO se escribe: un solape invisible en
                            // la agenda no se descubre hasta que las dos clientas coinciden.
                            logger.warn('ampliacion_cita_solapa', {
                                orgId, telefono: userPhone, appointmentId: session.appointmentId,
                                nuevoFin: endsAt.toISOString(), servicios: updServices,
                            });
                            session.upsellingAccepted = session.upsellingAccepted
                                .filter(u => !(aiResponse.datos.upselling_aceptado || []).includes(u));
                            aiResponse.respuesta = buildAmpliacionSolapaMsg(session.language);
                            session.botActivo = false;
                            await escalateToHuman(session, userPhone, 'ampliacion_cita_solapa', sanitized);
                        } else {
                            await updateAppointment(orgId, session.appointmentId, {
                                servicio: updServices,
                                endsAt: endsAt.toISOString(),
                                actor: 'bot',
                            });
                        }
                    } catch (e) {
                        logger.error('error_update_upselling', { orgId, error: e.message });
                    }
                }
            }
            // upsellingSuggested se setea en la transición de confirmación (más abajo),
            // NO aquí al seleccionar servicio — hacerlo aquí mataba el proximoPaso del LLM.

            // Appointment confirmation (Sante: no Bizum). No dependemos solo del flag del
            // LLM: resolveSalonConfirmation también reserva si la clienta acepta un hueco
            // propuesto (hora que coincide o "sí/vale" tras la propuesta).
            // BUG2/BUG3: recordamos si la cita YA estaba confirmada antes de este turno para
            // detectar la transición y añadir upselling + dirección + política 48h una sola vez.
            const yaEstabaConfirmada = session.reservaConfirmada;
            const confirm = resolveSalonConfirmation(session, aiResponse, sanitized, frozenProposed);
            if (confirm) {
                // El hueco se IDENTIFICA desde lo que la clienta vio (frozenProposed);
                // se RE-VERIFICA contra el calendario real (día+estilista) antes de guardar.
                const res = await confirmSlotConReverificacion(client, session, userPhone, confirm.slot);
                if (res.ok) {
                    logger.info('cita_sante_confirmacion', { orgId, telefono: userPhone, motivo: confirm.motivo, fecha: confirm.slot.fecha, hora: confirm.slot.hora });
                    aiResponse.reserva_confirmada = true;
                } else if (res.reason === PENDIENTE_NOMBRE) {
                    // Falta el nombre: se pregunta y NO se reserva. El texto sustituye al del
                    // LLM, así que este turno no puede contener ni un ✅ ni una hora — que es
                    // justo lo que la red anti-cita-fantasma vigila.
                    aiResponse.reserva_confirmada = false;
                    aiResponse.respuesta = preguntaNombreMsg(session, session.pendingNameForBooking?.intentos || 1);
                } else if (res.reason === 'ocupado') {
                    // El hueco que eligió ya no está libre: ofrecemos alternativas REALES.
                    logger.warn('cita_sante_hueco_ocupado', { orgId, telefono: userPhone, fecha: confirm.slot.fecha, hora: confirm.slot.hora, alternativas: res.freshSlots.length });
                    ofrecerAlternativas(session, res.freshSlots);
                    aiResponse.reserva_confirmada = false;
                    aiResponse.respuesta = buildHuecoOcupadoMsg(session, res.freshSlots);
                } else {
                    // Estaba libre pero falló el guardado: NO confirmamos para no mentirle.
                    aiResponse.reserva_confirmada = false;
                    aiResponse.respuesta = salonRetryMsg(session.language);
                }
            } else if (aiResponse.reserva_confirmada && !session.reservaConfirmada && session.selectedService) {
                // El LLM dijo confirmada pero resolveSalonConfirmation no identificó hueco
                // (típico slot directo cuya recarga pre-LLM vació availableSlots). Antes de
                // rendirnos: reload DIRIGIDO al día+estilista pedidos y verificación real.
                const fechaReq = aiResponse.datos?.fecha_cita || null;
                const horaReq = normalizeHora(aiResponse.datos?.hora_cita);
                const styId = session.selectedStylist?.id || null;
                let hecho = false;
                if (fechaReq && horaReq) {
                    const freshSlots = await reloadSlotsForConfirmation(session, { fecha: fechaReq, stylistId: styId });
                    const verified = pickChosenSlot(session, { fecha_cita: fechaReq, hora_cita: horaReq }, freshSlots);
                    const cand = verified && (!styId || verified.stylistId === styId) ? verified : null;
                    logger.info('confirmacion_reload_dirigido', {
                        orgId, telefono: userPhone, fecha: fechaReq, hora: horaReq,
                        stylistId: styId, huecosRealesTrasReload: freshSlots.length, encontrado: !!cand,
                    });
                    if (cand) {
                        const res = await finalizarCitaSante(client, session, userPhone, cand);
                        if (res === PENDIENTE_NOMBRE) {
                            // Ni éxito ni fallo: falta el nombre. Se pregunta, no se reserva.
                            aiResponse.reserva_confirmada = false;
                            aiResponse.respuesta = preguntaNombreMsg(session, session.pendingNameForBooking?.intentos || 1);
                            hecho = true;
                        } else if (res === true) {
                            logger.info('cita_sante_confirmacion_tras_reload', { orgId, telefono: userPhone, fecha: cand.fecha, hora: cand.hora });
                            aiResponse.reserva_confirmada = true;
                            hecho = true;
                        }
                    } else if (freshSlots.length) {
                        // La hora pedida no existe pero hay huecos reales ese día/estilista.
                        ofrecerAlternativas(session, freshSlots);
                        aiResponse.reserva_confirmada = false;
                        aiResponse.respuesta = buildHuecoOcupadoMsg(session, freshSlots);
                        hecho = true;
                    }
                }
                if (!hecho) {
                    logger.warn('cita_sante_flag_sin_slot', {
                        orgId, telefono: userPhone, tieneServicio: !!session.selectedService,
                        frozenLen: (frozenProposed || []).length, numHuecos: (session.availableSlots || []).length,
                    });
                    aiResponse.reserva_confirmada = false;
                    aiResponse.respuesta = salonRetryMsg(session.language);
                }
            }

            // ─── Red de seguridad final anti-mentira ─────────────────────────
            // Invariante: nunca enviar un mensaje que AFIRME que la cita queda reservada
            // sin haberla persistido. Si ninguna rama anterior guardó la cita pero el texto
            // del LLM dice que reservó, intentamos guardar con el mejor hueco; si no se puede,
            // reemplazamos el mensaje para no mentirle a la clienta.
            if (!session.reservaConfirmada && session.slotsProposed && llmClaimsBooked(aiResponse.respuesta)
                && !messageHasDateWithoutTime(sanitized)) {
                // Identificamos el hueco desde lo que la clienta vio (frozenProposed) y, si no,
                // desde los huecos reales actuales; luego re-verificamos antes de guardar.
                const safetySlots = (frozenProposed && frozenProposed.length) ? frozenProposed : (session.availableSlots || []);
                const slot = (session.selectedService && safetySlots.length)
                    ? pickChosenSlot(session, aiResponse.datos, safetySlots) : null;
                if (slot) {
                    logger.warn('cita_sante_red_seguridad', { orgId, telefono: userPhone, fecha: slot.fecha, hora: slot.hora });
                    const res = await confirmSlotConReverificacion(client, session, userPhone, slot);
                    if (res.ok) {
                        aiResponse.reserva_confirmada = true;
                    } else if (res.reason === 'ocupado') {
                        logger.warn('cita_sante_hueco_ocupado', { orgId, telefono: userPhone, fecha: slot.fecha, hora: slot.hora, alternativas: res.freshSlots.length });
                        ofrecerAlternativas(session, res.freshSlots);
                        aiResponse.reserva_confirmada = false;
                        aiResponse.respuesta = buildHuecoOcupadoMsg(session, res.freshSlots);
                    } else {
                        aiResponse.reserva_confirmada = false;
                        aiResponse.respuesta = salonRetryMsg(session.language);
                    }
                } else {
                    logger.warn('cita_sante_texto_sin_guardar', { orgId, telefono: userPhone, tieneServicio: !!session.selectedService, numHuecos: (session.availableSlots || []).length });
                    aiResponse.reserva_confirmada = false;
                    aiResponse.respuesta = salonRetryMsg(session.language);
                }
            }

            if (!yaEstabaConfirmada && session.reservaConfirmada && aiResponse.reserva_confirmada) {
                const cfgConf = await getAgentConfig(orgId);
                const infoConf = cfgConf?.business_info || {};
                const svc = session.selectedService || {};
                const upsellRule = (session.upsellingAccepted || []).length
                    ? null
                    : matchUpsellRule(session.selectedService, infoConf.upselling || []);
                let upsellSug = upsellRule ? (upsellRule.sugerencias || [])[0] || null : null;
                // Las reglas de upselling viven en `business_info.upselling`, que es una
                // lista APARTE del catálogo: dar de baja un servicio no la toca, así que sin
                // esto el bot seguiría ofreciendo por upsell justo lo que ha dejado de
                // hacer. Solo se descarta cuando la etiqueta RESUELVE contra una entrada de
                // baja: las etiquetas son frases de marketing y muchas no resuelven contra
                // nada (ver resolveServiceDurationMin), y de una que no resuelve no se puede
                // afirmar que esté dada de baja. Esa es la parte que la Fase 1 no cubre y
                // que se cerraría de verdad ligando cada regla a su entrada de catálogo.
                if (upsellSug) {
                    const upsellEntry = resolveServiceCatalogEntry(upsellSug, cfgConf?.services || []);
                    if (upsellEntry && !isServiceActive(upsellEntry)) {
                        logger.info('upsell_descartado_servicio_inactivo', {
                            orgId, telefono: userPhone, upsell: upsellSug, servicio: upsellEntry.nombre,
                        });
                        upsellSug = null;
                    }
                }
                // `tono` de la regla: las de decoloración se ofrecen como consejo de
                // cuidado, no como venta (ver plantilla upsellCuidado en helpers.js).
                const upsellTono = upsellRule?.tono || null;

                // Comprobar que el upselling CABE en el tiempo disponible antes de ofrecerlo.
                // La cita ampliada [inicio, inicio+servicio+upsell] debe respetar, con la MISMA
                // prioridad: (1) tope duro del salón a las 19:00; (2) el cierre de la estilista
                // ese día; (3) los bloqueos reales de agenda del panel — día completo
                // (blocked_days) o franja concreta (schedule_blocks). Si viola cualquiera → no
                // ofrecer el upselling.
                if (upsellSug && session.partialData.hora_cita && session.partialData.fecha_cita) {
                    // Parte determinista (tope 19:00 + cierre estilista) delegada al helper
                    // puro: resuelve la duración REAL del upsell desde su etiqueta de marketing
                    // (p.ej. "…K18…" → 60 min) en vez de caer a un fallback de 30 que
                    // infra-estimaba y dejaba pasar upsells por encima del cierre.
                    const fecha = session.partialData.fecha_cita;
                    // Mismo cálculo de dayOfWeek que calendar-sante.js (0=Lunes … 6=Domingo)
                    const apptDate = new Date(`${fecha}T12:00:00`);
                    const jsDay = apptDate.getDay();
                    const dayOfWeek = jsDay === 0 ? 6 : jsDay - 1;
                    let stylistCloseMin = null;
                    if (session.selectedStylist?.id) {
                        try {
                            const allSched = await getAllStylistSchedules(orgId);
                            const stylistSched = allSched.find(sc => sc.stylist_id === session.selectedStylist.id && sc.day_of_week === dayOfWeek);
                            if (stylistSched) {
                                const [closeH, closeM] = stylistSched.end_time.split(':').map(Number);
                                stylistCloseMin = closeH * 60 + closeM;
                            }
                        } catch (e) {
                            logger.error('error_check_upselling_cierre', { orgId, error: e.message });
                        }
                    }
                    // La duración del servicio PRINCIPAL decide dónde termina la cita, o
                    // sea si el upsell cabe antes del cierre. Infra-estimarla a 60 sobre un
                    // servicio de 360 hace que el guard mida desde un final que no existe y
                    // deje pasar justo lo que está para frenar. Misma resolución que en la
                    // búsqueda y en la escritura.
                    const durGuard = resolveAppointmentDurationMin(svc, cfgConf?.services || []);
                    if (!durGuard.resuelto) {
                        logger.warn('duracion_guard_cierre_no_resuelta', {
                            orgId, telefono: userPhone, servicio: svc.nombre || null,
                            minutosAsumidos: durGuard.minutos, upsell: upsellSug,
                        });
                    }
                    const guard = shouldDiscardUpsellForClosing({
                        horaCita: session.partialData.hora_cita,
                        serviceDurMin: durGuard.minutos,
                        upsellLabel: upsellSug,
                        catalog: cfgConf?.services || [],
                        stylistCloseMin,
                    });
                    let noCabe = guard.discard;
                    let motivo = guard.motivo;
                    const apptEnd = guard.apptEnd;
                    const [startH, startM] = session.partialData.hora_cita.split(':').map(Number);
                    const apptStart = startH * 60 + (startM || 0);
                    if (!noCabe && session.selectedStylist?.id) {
                        try {
                            // (2) Bloqueos de agenda reales guardados desde el panel — misma
                            // prioridad que el cierre. Día completo (blocked_days) o franja
                            // concreta (schedule_blocks) que solape la cita ampliada con upsell.
                            if (!noCabe) {
                                const blockedDays = await getBlockedDays(orgId, { from: fecha, to: fecha, stylistId: session.selectedStylist.id });
                                if (blockedDays.some(b => b.fecha === fecha && (!b.stylist_id || b.stylist_id === session.selectedStylist.id))) {
                                    noCabe = true; motivo = 'dia_bloqueado';
                                }
                            }
                            if (!noCabe) {
                                const dayStart = new Date(`${fecha}T00:00:00`).toISOString();
                                const dayEnd = new Date(`${fecha}T23:59:59`).toISOString();
                                const blocks = await getScheduleBlocks(orgId, session.selectedStylist.id, dayStart, dayEnd);
                                const toMin = (iso) => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };
                                const toDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
                                // Un bloqueo invade la cita ampliada si [apptStart, apptEnd] solapa [bStart, bEnd].
                                const invadido = blocks.some(b => {
                                    if (toDay(b.starts_at) > fecha || toDay(b.ends_at) < fecha) return false;
                                    return apptStart < toMin(b.ends_at) && toMin(b.starts_at) < apptEnd;
                                });
                                if (invadido) { noCabe = true; motivo = 'bloqueo_agenda'; }
                            }
                        } catch (e) {
                            logger.error('error_check_upselling_cierre', { orgId, error: e.message });
                        }
                    }
                    if (noCabe) {
                        logger.info('upselling_descartado_horario_cierre', { orgId, telefono: userPhone, apptEnd, motivo, upsellSug });
                        upsellSug = null;
                    }
                }

                aiResponse.respuesta = await mensajeConfirmacionSante(orgId, session, { upsellSug, upsellTono });
                session.upsellingSuggested = true;
                if (upsellSug) session._lastUpsellSuggestion = upsellSug;
            }
        }

        // ─── Restaurant-specific: Bizum flow ─────────────────────────────
        if (orgType === 'restaurant') {
            // Validate required fields
            if (aiResponse.reserva_confirmada && !session.reservaConfirmada) {
                const efectiveNombre = aiResponse.datos?.nombre || session.partialData.nombre;
                const efectivasPersonas = aiResponse.datos?.personas || session.partialData.personas;
                const efectivaFecha = session.availableSlots[session.currentSlotIndex]?.fecha || aiResponse.datos?.fecha_cita || session.partialData.fecha_cita;
                const efectivaHora = session.availableSlots[session.currentSlotIndex]?.hora || aiResponse.datos?.hora_cita || session.partialData.hora_cita;
                if (!efectiveNombre || !efectivasPersonas || !efectivaFecha || !efectivaHora) {
                    aiResponse.reserva_confirmada = false;
                    if (!efectiveNombre) aiResponse.respuesta = '¿A nombre de quién hacemos la reserva?';
                    else if (!efectivasPersonas) aiResponse.respuesta = '¿Para cuántas personas sería la mesa?';
                    else aiResponse.respuesta = '¿Qué día y hora os vendría bien?';
                }
            }

            // Bizum gate
            if (aiResponse.reserva_confirmada && !session.reservaConfirmada && !session.bizumAsked) {
                const agentCfg = await getAgentConfig(orgId);
                const bizum = agentCfg?.business_info?.bizum || config.bizum || {};
                const slot = session.availableSlots[session.currentSlotIndex];
                if (slot) {
                    session.partialData.fecha_cita = slot.fecha;
                    session.partialData.hora_cita = slot.hora;
                } else if (aiResponse.datos?.fecha_cita && aiResponse.datos?.hora_cita) {
                    session.partialData.fecha_cita = aiResponse.datos.fecha_cita;
                    session.partialData.hora_cita = aiResponse.datos.hora_cita;
                }
                session.bizumAsked = true;
                aiResponse.reserva_confirmada = false;
                aiResponse.respuesta = `¡Perfecto! Para confirmar la mesa necesitamos una señal de ${bizum.importe}€ por Bizum al ${bizum.numero}. Cuando lo hayas hecho, dime "hecho" y te confirmo la reserva 😊`;
            }
        }

        // Update partialData from LLM datos
        if (aiResponse.datos) {
            let svcCatalogForNameCheck;
            const loadSvcCatalog = async () => {
                if (!svcCatalogForNameCheck) {
                    const cfgNc = await getAgentConfig(orgId);
                    svcCatalogForNameCheck = cfgNc?.services || [];
                }
                return svcCatalogForNameCheck;
            };
            for (const [k, v] of Object.entries(aiResponse.datos)) {
                if (v && v !== '' && v !== 'desconocido' && !k.startsWith('upselling')) {
                    if (k === 'nombre' && orgType === 'salon') {
                        if (isServiceName(v, await loadSvcCatalog())) {
                            logger.info('nombre_llm_es_servicio_descartado', { orgId, nombre: v });
                            continue;
                        }
                    }
                    // `estilista_preferida` solo entra si resuelve contra el equipo real.
                    // Sin esta guarda, un nombre inventado ("Carmen") se guardaba en
                    // partialData y se reinyectaba en TODOS los prompts siguientes vía
                    // "Datos recogidos": el modelo seguía viendo para siempre una
                    // estilista que no existe. Solo salón; San Remo no tiene el campo.
                    if (k === 'estilista_preferida' && orgType === 'salon') {
                        const rosterNc = await getStylistsByOrg(orgId);
                        if (!resolveStylistMention(v, rosterNc, { assumePersonName: true }).stylist) {
                            logger.info('estilista_llm_no_resoluble_descartada', { orgId, telefono: userPhone, valor: v });
                            continue;
                        }
                    }
                    let canOverwrite = k === 'nombre' || !session.partialData[k] || session.partialData[k] === 'desconocido';
                    // No dejar que el LLM sustituya un nombre+apellido ya completado
                    // (por el merge determinista de extractQuickDataSante) por una
                    // extracción más corta suya (ej. solo el apellido que acaba de oír).
                    if (k === 'nombre' && orgType === 'salon'
                            && hasApellido(session.partialData.nombre) && !hasApellido(v)) {
                        canOverwrite = false;
                    }
                    // `servicio` es sticky para no pisar la elección de la clienta con
                    // una mención de pasada del LLM. Pero si el valor guardado NO resuelve
                    // contra el catálogo es basura que atasca el flujo: la ruta de
                    // recuperación lo reintenta cada turno y siempre falla, mientras el
                    // prompt le dice al LLM que no vuelva a preguntar el servicio → bucle
                    // infinito. Ahí sí dejamos que lo corrija ("Aromaterapia" →
                    // "Aromaterapia relax"). Solo salón; San Remo intacto.
                    if (!canOverwrite && k === 'servicio' && orgType === 'salon'
                            && !extractServiceFromText(session.partialData.servicio, await loadSvcCatalog())) {
                        canOverwrite = true;
                        logger.info('partialData_servicio_no_resoluble_sobreescrito', {
                            orgId, telefono: userPhone, previo: session.partialData.servicio, nuevo: v,
                        });
                    }
                    if (canOverwrite) session.partialData[k] = v;
                }
            }
        }

        // ─── Red anti-invención de disponibilidad (Sante) ────────────────────
        // Última barrera antes de enviar: si el mensaje del LLM ofrece una hora
        // concreta pero NO hay huecos reales que la respalden, bloqueamos el envío y
        // pedimos el dato que falta. Cubre el caso crítico (availableSlots vacío →
        // totalSlots:0 → el LLM alucina "el viernes 17 tengo 10:00, 10:30…") y el caso
        // en que la hora ofrecida cae fuera del rango real de huecos. NO aplica cuando
        // la cita ya está confirmada (ahí el mensaje lleva la hora legítima) ni al
        // restaurante (San Remo intacto).
        // Las puntas del horario quedan EXENTAS: decir "abrimos de 10:00 a 19:00" no es
        // ofrecer un hueco, y bloquearlo dejaba a la clienta sin la única respuesta útil.
        const horasHorario = orgType === 'salon'
            ? horasLimiteHorario((await getAgentConfig(orgId))?.business_hours)
            : [];
        // Va ANTES de la red de huecos inventados: si aún no hay servicio, el mensaje
        // correcto es pedirlo, y sustituirlo aquí ahorra el turno que Michal perdió
        // eligiendo entre tres horas que no existían.
        let _timingSinServicio = false;
        if (orgType === 'salon' && !aiResponse._rectificadoPorRedFantasma
                && proposesTimingWithoutService(aiResponse.respuesta, session, horasHorario)) {
            logger.warn('cita_sante_timing_sin_servicio_bloqueado', {
                orgId, telefono: userPhone,
                servicioMencionado: session.partialData?.servicio || null,
                streak: session.sinServicioStreak || 0,
            });
            aiResponse.respuesta = salonNoSlotsMsg(session);
            aiResponse.reserva_confirmada = false;
            _timingSinServicio = true;
        }

        if (orgType === 'salon' && !_timingSinServicio && !session.reservaConfirmada && !aiResponse._rectificadoPorRedFantasma
                && respondsWithInventedSlots(aiResponse.respuesta, session.availableSlots, horasHorario)) {
            logger.warn('cita_sante_disponibilidad_inventada_bloqueada', {
                orgId, telefono: userPhone,
                huecosReales: (session.availableSlots || []).length,
                tieneServicio: !!session.selectedService,
            });
            aiResponse.respuesta = salonNoSlotsMsg(session);
            aiResponse.reserva_confirmada = false;
        }

        // ─── Red anti-cierre-falso (Sante) ────────────────────────────────────
        // Solo se comprueba cuando calendar-sante ya marcó que el día/semana pedidos no
        // tenían hueco real (requestedDayUnavailable/weekPreferenceRelaxed): es la ventana
        // exacta en la que el LLM tiende a decir "el salón está cerrado" en vez de "esa
        // estilista no trabaja ese día". Se sustituye por el mensaje determinista que ya
        // ofrece los huecos reales más cercanos, en vez de dejar salir la mentira.
        if (orgType === 'salon' && !session.reservaConfirmada && !aiResponse._rectificadoPorRedFantasma
                && (session.slotsRequestedDayUnavailable || session.slotsWeekPreferenceRelaxed)
                && respondsWithFalseClosureClaim(aiResponse.respuesta)) {
            logger.warn('cita_sante_cierre_falso_bloqueado', {
                orgId, telefono: userPhone,
                respuestaOriginal: aiResponse.respuesta,
                huecosReales: (session.availableSlots || []).length,
            });
            aiResponse.respuesta = session.availableSlots?.length
                ? salonOfferSlotsMsg(session)
                : salonNoSlotsMsg(session);
            aiResponse.reserva_confirmada = false;
        }

        // Segunda pasada de la red anti-cita-fantasma: cubre el mensaje FINAL, incluido el
        // determinista de buildSanteConfirmationMessage y todo lo que las redes anteriores
        // hayan reescrito. La primera pasada corre antes del despacho de acciones (ver
        // blockPhantomBookingClaim), que tiene rutas de salida propias.
        if (orgType === 'salon') await blockPhantomBookingClaim(orgId, session, userPhone, aiResponse, sanitized);

        if (orgType === 'salon') {
            aiResponse.respuesta = stripMarkdown(aiResponse.respuesta);
            if (aiResponse.respuesta.length > 1000) {
                aiResponse.respuesta = aiResponse.respuesta.slice(0, 997) + '...';
            }
        }

        // Traspaso OFRECIDO: se apunta la espera para que el "sí" del turno siguiente lo
        // resuelva la capa determinista (el bloque de pendingEscalation, el mismo que usan
        // extensiones y permanente) en vez de depender de que el LLM se acuerde de poner
        // accion:escalar_humano. Se mira aquí, sobre el texto YA definitivo: las redes de
        // más arriba pueden haber sustituido la respuesta entera.
        // Si ya se está escalando en este turno no hay nada que esperar.
        if (orgType === 'salon' && aiResponse.accion !== 'escalar_humano'
                && !session.pendingEscalation && offersHumanHandover(aiResponse.respuesta)) {
            session.pendingEscalation = true;
            session.pendingEscalationService = 'traspaso';
            logger.info('sante_traspaso_ofrecido_espera_confirmacion', { orgId, telefono: userPhone });
        }

        session.history.push({ role: 'assistant', content: aiResponse.respuesta, ts: Date.now() });

        // Send response: salon sends as a single message, restaurant splits if long
        if (orgType === 'restaurant' && aiResponse.respuesta.length > 300) {
            const mid = aiResponse.respuesta.lastIndexOf(' ', Math.floor(aiResponse.respuesta.length / 2));
            const p1 = aiResponse.respuesta.substring(0, mid).trim();
            const p2 = aiResponse.respuesta.substring(mid).trim();
            if (p1) await _send(p1);
            if (p2) { await new Promise(r => setTimeout(r, 80)); await _send(p2); }
        } else {
            await _send(aiResponse.respuesta);
        }

        // Marca que ya hemos propuesto huecos a la clienta: a partir de aquí un "sí/vale"
        // se interpreta como aceptación del hueco (match exacto de fecha+hora, nunca por
        // posición en la lista). Usamos availableSlots (no slotsParaLLM, que se calcula ANTES de la llamada al
        // LLM): en el turno en que se identifica el servicio los huecos se cargan DESPUÉS,
        // así que slotsParaLLM iba vacío y slotsProposed se quedaba un turno por detrás.
        if (orgType === 'salon' && session.availableSlots.length > 0 && !session.reservaConfirmada) {
            session.slotsProposed = true;
        }

        // Save lead if we have enough data
        if (!session.leadGuardado && session.partialData.telefono && session.partialData.nombre) {
            saveLead(orgId, { ...session.partialData, estado_cita: 'pendiente', leadId: session.leadId, language: session.language })
                .then(rid => { if (rid) session.leadId = rid; })
                .catch(() => {});
        }

        persistSession(orgId, userPhone, session);
        triggerAsyncSummary(orgId, userPhone, session);

    } catch (err) {
        logger.error('process_message_error', { orgId, telefono: userPhone, error: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
        incrementMetric('fallbacksUsed');
        const _sKey = sessionKey(orgId, userPhone);
        const _session = userSessions.get(_sKey);
        if (_snapshot && _session) {
            try {
                _session.history.length      = _snapshot.historyLen;
                _session.selectedService     = _snapshot.selectedService;
                _session.selectedStylist     = _snapshot.selectedStylist;
                _session.availableSlots      = _snapshot.availableSlots;
                _session.proposedSlots       = _snapshot.proposedSlots;
                _session.currentSlotIndex    = _snapshot.currentSlotIndex;
                _session.slotsProposed       = _snapshot.slotsProposed;
                _session.datePreferenceAsked = _snapshot.datePreferenceAsked;
                _session.upsellingSuggested  = _snapshot.upsellingSuggested;
                _session.pendingLargoCategory = _snapshot.pendingLargoCategory;
                _session.largoPelo           = _snapshot.largoPelo;
                _session.pendingCorteGenero    = _snapshot.pendingCorteGenero;
                _session.pendingCorteMujerTipo = _snapshot.pendingCorteMujerTipo;
                _session.pendingCorteNinoTipo  = _snapshot.pendingCorteNinoTipo;
                _session.partialData         = _snapshot.partialData;
                logger.info('snapshot_restaurado_en_catch', { orgId, telefono: userPhone });
            } catch {}
        }
        try { await _send(config.conversation?.technicalErrorMessage || 'Lo siento, ha habido un error. Inténtalo de nuevo.'); } catch {}
        try { if (_session) persistSession(orgId, userPhone, _session); } catch {}
    }
}

// ─── Buffer flush: combina mensajes acumulados y los procesa ────────────────
// ─── El turno de la foto tiene que llegarle al LLM ───────────────────────────
// La rama de media contesta y hace `return` antes del buffer, así que el modelo no se entera
// de nada: el placeholder `[image]` se escribe con saveMessage —que va a la tabla `messages`,
// o sea AL PANEL— y la respuesta fija sale por sendWithDelay, que tampoco toca el historial.
// El historial que consume el prompt es session.history, otro array.
//
// Resultado el 07/08/2026: a las 11:04:54.939 le dijimos «No puedo ver fotos ni vídeos» y a
// las 11:05:02.443 el LLM contestó a su texto con «Hi! Your hair looks beautiful 😊». Para el
// modelo la foto no existía y nuestro aviso tampoco, así que dio por hecho que la había
// visto. Dos mensajes seguidos, y el segundo desmintiendo al primero.
//
// Los turnos se guardan aquí y los drena processMessageCore en cuanto la sesión existe —en el
// primer mensaje de una conversación la rama de media corre ANTES de que haya sesión, que es
// justo el caso de Michal. Se anotan DESPUÉS de que el envío no haya lanzado: escribir en el
// historial que dijimos algo que no salió sería inventarse una conversación.
const pendingMediaHistory = new Map();
const MAX_PENDING_MEDIA_TURNS = 6;

function notePendingMediaTurn(sKey, kind, avisoEnviado) {
    if (!sKey) return;
    const turnos = pendingMediaHistory.get(sKey) || [];
    const ts = Date.now();
    // El marcador es para el modelo, no para la clienta: dice qué llegó y qué no podemos
    // hacer con ello, para que no dé por visto lo que nadie ha visto.
    //
    // Cuando NO salió aviso fijo —porque ya había texto suyo esperando y contesta el LLM—,
    // el marcador lleva además qué hacer: si no, nadie le dice que no vemos la foto.
    const qué = kind === 'image' ? 'una foto' : `un ${kind}`;
    const instruccion = avisoEnviado
        ? ''
        : ' — dile que no puedes ver fotos ni vídeos y pídele que te lo describa con palabras';
    turnos.push({ role: 'user', content: `[la clienta ha enviado ${qué}; no puedes verlo${instruccion}]`, ts });
    if (avisoEnviado) turnos.push({ role: 'assistant', content: avisoEnviado, ts });
    pendingMediaHistory.set(sKey, turnos.slice(-MAX_PENDING_MEDIA_TURNS));
}

function drainPendingMediaTurns(sKey, session) {
    const turnos = pendingMediaHistory.get(sKey);
    if (!turnos?.length) return 0;
    pendingMediaHistory.delete(sKey);
    // Una foto de hace hora y media no explica el turno de ahora, y meterla desordenaría un
    // historial que el modelo lee como una conversación seguida.
    const frescos = turnos.filter(t => Date.now() - t.ts < SESSION_TIMEOUT);
    for (const t of frescos) session.history.push(t);
    return frescos.length;
}

// ─── ¿En qué idioma le contestamos a una foto? ───────────────────────────────
// El aviso de "no puedo ver fotos" salía SIEMPRE en castellano cuando no había sesión en
// RAM — y en el primer mensaje de una conversación NUNCA la hay: la sesión se crea dentro de
// processMessageCore, que corre cuando el buffer hace flush, 5 s más tarde. Michal Gradziel
// (07/08/2026) mandó su foto 0,7 s después de su primer texto en inglés y recibió el aviso
// en castellano; 7,5 s después le llegó la respuesta del LLM, en inglés.
//
// El texto inglés EXISTE (helpers.unsupportedMediaMsg): no faltaba traducción, fallaba la
// resolución. Y su `|| set.es` final es un default silencioso de manual (regla 3).
//
// Es la familia del caso de Tammy (CLAUDE.md, "el idioma de una clienta"), que ya dejó
// anotado «a ella y a la foto que mandó 36 s después, que coge el idioma de la misma
// session.language» — pero por una puerta peor: allí el valor era erróneo, aquí no hay
// sesión de la que sacarlo, así que este camino no podía acertar nunca.
//
// Cascada, de la señal más fuerte a la más débil:
//   1. la sesión, que ya aplicó todas las reglas de idioma;
//   2. lo que la clienta acaba de escribir y espera en el buffer — evidencia DIRECTA de este
//      mismo turno, y es lo que salva el caso de Michal;
//   3. la ficha, y SOLO si su fuente es 'observed'. Un 'default' es el 'es' del INSERT que
//      nadie tocó, y un 'inferred' es una conjetura por el nombre de pila: ninguno de los dos
//      puede decidir en qué idioma le hablamos. La ficha de Michal era 'default' en ese
//      instante (se había creado 1,5 s antes), así que aquí tampoco habría salvado nada.
// Si nada resuelve devuelve null y se dice: unsupportedMediaMsg cae a castellano, pero
// queda la traza de que fue un fallback y no una lectura.
async function resolveMediaLanguage(orgId, sKey, dbPhone) {
    const valido = l => (l && IDIOMAS_SOPORTADOS.includes(l)) ? l : null;

    const enSesion = valido(userSessions.get(sKey)?.language);
    if (enSesion) return enSesion;

    const enBuffer = (messageBuffers.get(sKey)?.texts || []).join('\n').trim();
    if (enBuffer) {
        const detectado = valido(detectLanguage(enBuffer));
        if (detectado) {
            logger.info('media_idioma_del_buffer', { orgId, telefono: dbPhone, idioma: detectado });
            return detectado;
        }
    }

    try {
        const contact = await findByPhone(orgId, dbPhone);
        if (contact?.language_source === 'observed') {
            const deFicha = valido(contact.language);
            if (deFicha) {
                logger.info('media_idioma_de_ficha', { orgId, telefono: dbPhone, idioma: deFicha });
                return deFicha;
            }
        }
    } catch (e) {
        logger.warn('media_idioma_ficha_error', { orgId, telefono: dbPhone, error: e.message });
    }

    logger.info('media_idioma_sin_resolver', { orgId, telefono: dbPhone });
    return null;
}

async function flushBuffer(sKey) {
    const buffer = messageBuffers.get(sKey);
    if (!buffer || buffer.texts.length === 0) return;

    buffer.state = 'processing';
    if (buffer.timer) { clearTimeout(buffer.timer); buffer.timer = null; }

    const combinedText = buffer.texts.join('\n');
    const { client, message, userPhone, orgId, dbPhone } = buffer;
    const msgCount = buffer.texts.length;

    buffer.texts = [];
    buffer.seenKeys = new Set();

    logger.info('buffer_flush', { orgId, telefono: userPhone, mensajesCombinados: msgCount, textoLength: combinedText.length, textoCombinado: combinedText.slice(0, 200) });

    try {
        // HALLAZGO ANOTADO, NO ARREGLADO (09/08/2026) — este `null` es el messageKey, y por
        // eso el dedupe de SESIÓN está muerto en la ruta real: session.seenMessages no se
        // rellena nunca (solo lo haría processMessageCore, con la clave que no le llega), así
        // que la guarda de handleIncomingMessage que lo consulta no puede saltar jamás. Toda
        // la protección contra la doble respuesta recae en buffer.seenKeys, que se vacía en
        // cada flush y se destruye a los 60 s de inactividad: un reenvío tardío del mismo
        // wamid se contestaría dos veces. No es la causa de ninguno de los seis síntomas de
        // Michal/Esther —se comprobó—, es un agujero latente. Se deja fuera a propósito.
        await processMessageCore(client, message, userPhone, combinedText, null, orgId, dbPhone);
    } catch (e) {
        logger.error('error_buffer_process', { orgId, telefono: userPhone, error: e.message });
    }

    if (buffer.pendingTexts && buffer.pendingTexts.length > 0) {
        buffer.texts = buffer.pendingTexts;
        buffer.seenKeys = buffer.pendingSeenKeys || new Set();
        buffer.pendingTexts = null;
        buffer.pendingSeenKeys = null;
        buffer.state = 'buffering';
        logger.info('buffer_post_flush_restart', { orgId, telefono: userPhone, mensajesPendientes: buffer.texts.length });
        buffer.timer = setTimeout(() => flushBuffer(sKey), BUFFER_DELAY_MS);
    } else {
        buffer.state = 'idle';
        setTimeout(() => {
            const b = messageBuffers.get(sKey);
            if (b && b.state === 'idle' && b.texts.length === 0) {
                messageBuffers.delete(sKey);
            }
        }, BUFFER_CLEANUP_TTL_MS);
    }
}

// ¿Está el contacto en lista negra AHORA MISMO? El guard de lista negra vive dentro de
// processMessageCore, pero handleIncomingMessage responde por su cuenta antes de llegar allí
// (audio que no se puede transcribir, foto/sticker/documento sin texto): un contacto
// bloqueado seguía recibiendo esas respuestas automáticas, en los dos canales, sin escalada
// ni alerta. La BD es la fuente de verdad; la sesión viva solo se usa como atajo cuando ya
// sabe que está bloqueado. Si la lectura falla no se bloquea a nadie por sospecha: se
// registra y se sigue, que es el comportamiento que ya tenía este camino.
async function isBlacklistedNow(orgId, dbPhone, sKey) {
    if (userSessions.get(sKey)?.isBlacklisted) return true;
    if (!dbPhone) return false;
    try {
        const contact = await findByPhone(orgId, dbPhone);
        return !!contact?.is_blacklisted;
    } catch (e) {
        logger.error('error_check_blacklist_media', { orgId, telefono: dbPhone, error: e.message });
        return false;
    }
}

// ─── Handler principal (con buffer de 5s) ────────────────────────────────────
async function handleIncomingMessage(client, message, orgId) {
    try {
        if (!message) return;
        const messageKey = getMessageKey(message);

        // Guard de canal. Una org migrada a Cloud API solo debe entrar por el webhook de
        // 360dialog, cuyos ids son `wamid.…` (threesixty-dialog.js → buildInboundAdapters).
        // Un id con forma de whatsapp-web.js (`false_34…@c.us_ABC`) significa que en algún
        // proceso sobrevive un cliente wwebjs de esa org: sería una SEGUNDA entrada del
        // mismo mensaje y el dedupe NO puede verla — los ids viven en espacios distintos y
        // TTLMessageDedupe es un Map en RAM por proceso. Para San Remo (canal 'wwebjs') la
        // condición es falsa siempre: cero impacto.
        if (getOrgChannel(orgId) !== CHANNEL_WWEBJS && !String(messageKey || '').startsWith('wamid.')) {
            logger.info('mensaje_ignorado_canal_inactivo', { orgId, messageKey: messageKey || null });
            return;
        }

        if (!message.from || message.from.includes('@g.us') || message.isStatus || message.isBroadcast) return;

        const userPhone = message.from;
        const sKey = sessionKey(orgId, userPhone);

        // Resolve real phone number (handles @lid JIDs)
        const resolved = await resolvePhoneFromMessage(message);
        const dbPhone = resolved.phone;
        if (resolved.isLid) {
            logger.info('lid_jid_detectado', { orgId, jid: userPhone, resolvedPhone: dbPhone });
        }

        if (messageKey) {
            const s = userSessions.get(sKey);
            if (s?.seenMessages?.has(messageKey)) {
                logger.info('buffer_msg_duplicado_session', { orgId, telefono: userPhone, messageKey });
                return;
            }
        }

        let userText = message.body?.trim() || '';
        if (!userText) {
            userText = message.message?.conversation?.trim() ||
                message.message?.extendedTextMessage?.text?.trim() || '';
        }

        const isAudio = message.type === 'ptt' || message.type === 'audio';
        if (isAudio && message.hasMedia) {
            try {
                const media = await message.downloadMedia();
                if (!media?.data) throw new Error('media vacía');
                userText = await transcribeAudio(media.data, media.mimetype);
                if (!userText) throw new Error('transcripción vacía');
            } catch (e) {
                logger.error('error_transcripcion', { telefono: userPhone, error: e.message });
                // Solo salón: este camino es código compartido y la regla de oro exige que el
                // comportamiento observable de San Remo no cambie ni para un contacto bloqueado.
                if (getOrgType(orgId) === 'salon' && await isBlacklistedNow(orgId, dbPhone, sKey)) {
                    logger.info('media_ignorada_lista_negra', { orgId, telefono: userPhone, kind: 'audio' });
                    return;
                }
                await sendWithDelay(client, userPhone, 'No pude escuchar el audio 😅 ¿Puedes escribirme lo que necesitas?', orgId, dbPhone);
                return;
            }
        }

        // Mensaje sin texto utilizable (foto, sticker, ubicación, documento, contacto…). Antes
        // se salía en silencio cuando hasMedia era falso —el caso de TODO el media que entra por
        // Cloud API—, así que la clienta se quedaba sin respuesta. Ahora siempre contestamos algo.
        if (!userText) {
            // 'system' = aviso de cifrado, registro de llamada, mensaje sin descifrar… No lo ha
            // escrito la clienta: responderlo sería spam, ahí el silencio es lo correcto.
            const kind = classifyIncomingMedia(message);
            if (getOrgType(orgId) === 'salon' && kind !== 'system') {
                const language = await resolveMediaLanguage(orgId, sKey, dbPhone);
                logger.info('media_no_soportada', { orgId, telefono: userPhone, kind });
                // Dejamos rastro en el panel: antes estos mensajes no existían en el historial.
                saveMessage(orgId, {
                    telefono: dbPhone, contenido: `[${kind}]`, direccion: 'entrante',
                    waMessageId: getMessageKey(message), raw: rawFromProvider(message),
                }).catch(() => {});
                // El rastro en el panel sí se guarda, la respuesta no sale: un contacto
                // bloqueado no vuelve a hablar con el bot con normalidad.
                if (await isBlacklistedNow(orgId, dbPhone, sKey)) {
                    logger.info('media_ignorada_lista_negra', { orgId, telefono: userPhone, kind });
                    return;
                }
                // Si ya hay texto suyo esperando en el buffer, la foto NO se contesta aparte:
                // esa respuesta ya está garantizada y la va a dar el LLM con las dos cosas
                // delante. Es la mitad de Michal del "responde dos veces" — la rama de media
                // hace `return` antes del buffer, así que contestaba al instante mientras el
                // texto esperaba sus 5 s: 11:04:54.939 el aviso fijo (en castellano) y
                // 11:05:02.443 el LLM (en inglés). Un solo acto de la clienta, dos motores.
                const bufferEnVuelo = messageBuffers.get(sKey);
                const hayTextoEnVuelo = !!(bufferEnVuelo
                    && ((bufferEnVuelo.texts?.length || 0) + (bufferEnVuelo.pendingTexts?.length || 0)) > 0);
                if (hayTextoEnVuelo) {
                    logger.info('media_sin_respuesta_hay_texto_en_vuelo', { orgId, telefono: userPhone, kind });
                    notePendingMediaTurn(sKey, kind, null);
                    return;
                }
                const aviso = unsupportedMediaMsg(kind, language);
                await sendWithDelay(client, userPhone, aviso, orgId, dbPhone);
                // Que el LLM se entere: sin esto contesta al texto de al lado como si hubiera
                // visto la foto ("Your hair looks beautiful", 11:05:02 del 07/08/2026).
                notePendingMediaTurn(sKey, kind, aviso);
            } else if (message.hasMedia) {
                // San Remo: literal exacto de siempre (regla de oro, comportamiento sin cambios).
                await sendWithDelay(client, userPhone, 'Gracias por tu mensaje 😊 Solo proceso texto y audios. Si tienes alguna duda, escríbeme.', orgId, dbPhone);
            }
            return;
        }

        saveMessage(orgId, {
            telefono: dbPhone, contenido: userText, direccion: 'entrante',
            waMessageId: getMessageKey(message), raw: rawFromProvider(message),
        }).catch(() => {});
        // Persistimos el JID canónico del chat (message.from, p.ej. "<lid>@lid") para poder
        // enviar mensajes manuales desde el panel al chat correcto, sin construir "<lid>@c.us"
        // (chat inexistente que desadjunta el frame de puppeteer). Best-effort, no bloquea.
        if (message.from) setContactJid(orgId, dbPhone, message.from).catch(() => {});

        let buffer = messageBuffers.get(sKey);
        if (!buffer) {
            buffer = {
                texts: [], seenKeys: new Set(), timer: null, state: 'idle',
                pendingTexts: null, pendingSeenKeys: null,
                client, userPhone, orgId, message, dbPhone,
            };
            messageBuffers.set(sKey, buffer);
        }

        if (messageKey) {
            const keysSet = buffer.state === 'processing' ? (buffer.pendingSeenKeys || (buffer.pendingSeenKeys = new Set())) : buffer.seenKeys;
            if (keysSet.has(messageKey)) {
                logger.info('buffer_msg_duplicado', { orgId, telefono: userPhone, messageKey });
                return;
            }
            keysSet.add(messageKey);
        }

        if (buffer.state === 'processing') {
            if (!buffer.pendingTexts) buffer.pendingTexts = [];
            buffer.pendingTexts.push(userText);
            logger.info('buffer_msg_durante_procesamiento', { orgId, telefono: userPhone, textoLength: userText.length, pendientes: buffer.pendingTexts.length });
            return;
        }

        buffer.texts.push(userText);
        buffer.client = client;
        buffer.message = message;
        buffer.state = 'buffering';

        if (buffer.timer) {
            clearTimeout(buffer.timer);
            logger.info('buffer_timer_reiniciado', { orgId, telefono: userPhone, mensajesAcumulados: buffer.texts.length });
        } else {
            logger.info('buffer_msg_entrante', { orgId, telefono: userPhone, textoLength: userText.length });
        }

        buffer.timer = setTimeout(() => flushBuffer(sKey), BUFFER_DELAY_MS);
    } catch (err) {
        logger.error('error_incoming_message', { error: err.message });
    }
}

// ─── GC ───────────────────────────────────────────────────────────────────────
//
// Los tres timers de este fichero van con .unref() — ver unrefTimer() abajo.
//
// Un timer con unref sigue disparándose EXACTAMENTE igual mientras el proceso siga vivo por
// cualquier otra razón. Lo único que cambia es que deja de ser una razón por sí mismo. En
// producción el proceso lo mantienen vivo el servidor Express de server.js y los clientes de
// WhatsApp, así que el GC, la limpieza de dedupe y el barrido de abandono corren igual.
//
// Lo que arregla: `require('./bot.js')` registraba estos tres intervalos y el proceso ya no
// terminaba nunca. verify:robustez importa bot.js, así que hacía todo su trabajo, imprimía el
// resumen y se quedaba colgado indefinidamente — 48 minutos en una ocasión, con ~0,5 s de CPU
// acumulada. Eso obligaba a lanzarlo con `script -q` y matarlo a mano al ver la línea TOTAL, y
// hacía imposible engancharlo a un hook de pre-push.
function unrefTimer(t) {
    // En Node devuelve un Timeout con .unref(); el guard es por si algún entorno de test
    // sustituye setInterval por algo que devuelve un id numérico.
    if (t && typeof t.unref === 'function') t.unref();
    return t;
}

unrefTimer(setInterval(() => {
    const now = Date.now();
    for (const [key, session] of userSessions.entries()) {
        if (now - session.lastUpdate > GC_INTERVAL_MS * 2) {
            const [orgId, phone] = key.includes(':') ? key.split(':') : [null, key];
            persistSession(orgId, phone || key, session);
            userSessions.delete(key);
        }
    }
}, GC_INTERVAL_MS));

unrefTimer(setInterval(() => {
    for (const session of userSessions.values()) session.seenMessages?.cleanup?.();
}, GC_INTERVAL_MS / 2));

// Marca 'abandonado' SOLO tras comprobar contra Supabase que no hay cita por delante.
//
// Verificar contra la BD y no contra la sesión es la misma disciplina que la red
// anti-cita-fantasma, y aquí hace falta por lo mismo: la sesión recargada puede estar
// equivocada. El 04/08/2026 tres clientas con cita confirmada acabaron en 'abandonado', y eso
// las sacó del filtro de getLeadsPendientesRecordatorio (db.js:475, exige estado='confirmado')
// → se quedaron sin el recordatorio de 24 h. Una tenía la cita ese mismo día.
async function marcarAbandonadaSiNoTieneCita(orgId, key, session) {
    // El `if (session.leadId)` de antes convertía esta comprobación en opcional justo para
    // las conversaciones que más la necesitan: sin contacto resuelto no se consultaba nada y
    // se marcaba 'abandonado' a ciegas. La red escrita para el incidente del 04/08 estaba
    // gateada por el campo que estaba vacío. Ahora se resuelve antes de decidir.
    const leadId = await ensureLeadId(orgId, session);
    if (leadId) {
        try {
            const citas = await getUpcomingAppointments(orgId, leadId);
            if (citas.length) {
                // Que la sesión lo sepa: así el barrido ni siquiera vuelve a preguntarlo.
                session.appointmentId = citas[0].id;
                logger.info('abandono_evitado_cita_viva', {
                    orgId, telefono: session.partialData.telefono,
                    appointmentId: citas[0].id, starts_at: citas[0].starts_at,
                });
                return;
            }
        } catch (e) {
            // Sin lectura fiable no se marca nada: el lado seguro es NO afirmar que abandonó.
            logger.warn('abandono_lectura_citas_fallida', {
                orgId, telefono: session.partialData.telefono, error: e.message,
            });
            return;
        }
    }
    incrementMetric('conversationDropped');
    await saveLead(orgId, { ...session.partialData, estado_cita: 'abandonado', leadId: session.leadId })
        .catch(() => {});
    session.leadStatus = 'abandoned';
    const phone = key.includes(':') ? key.split(':')[1] : key;
    persistSession(orgId, phone, session);
}

unrefTimer(setInterval(() => {
    const now = Date.now();
    for (const [key, session] of userSessions.entries()) {
        // `leadStatus === 'abandoned'` es la guarda de idempotencia que faltaba: se asignaba
        // pero no se comprobaba, así que este barrido reescribía la MISMA fila cada 60 s
        // durante ~90 min (de los 30 min del umbral a las 2 h del GC). Efecto colateral: el
        // updated_at de contacts acababa 2-3 h después del último mensaje, y "Actividad
        // reciente" —que ordena por updated_at— mostraba el orden en que un worker tocó las
        // filas, no la actividad real.
        // `appointmentId` la salta de entrada: ya sabemos que tiene cita.
        if (session.reservaConfirmada || session.leadGuardado || session.appointmentId
            || session.leadStatus === 'abandoned' || !session.botActivo) continue;
        if (now - session.lastUpdate > ABANDON_THRESHOLD_MS && session.history.filter(m => m.role === 'user').length >= 2) {
            const [orgId] = key.includes(':') ? key.split(':') : [null];
            if (session.partialData.telefono) {
                marcarAbandonadaSiNoTieneCita(orgId, key, session).catch(e =>
                    logger.error('abandono_error', { orgId, error: e.message }));
            }
        }
    }
}, 60000));

function setConversationBotMode(phone, active, isEscalationResolve = false) {
    const digits = phone.replace(/@c\.us$|@lid$/g, '').replace(/\D/g, '');
    let found = 0;
    for (const [key, session] of userSessions.entries()) {
        const keyPhone = key.includes(':') ? key.split(':')[1] : key;
        const keyDigits = keyPhone.replace(/@c\.us$|@lid$/g, '').replace(/\D/g, '');
        if (keyDigits === digits || session.partialData?.telefono === digits) {
            if (active && isEscalationResolve) {
                const orgId = session.orgId;
                const sessionPhone = session.partialData?.telefono || digits;
                userSessions.delete(key);
                deleteClient(orgId, sessionPhone);
                logger.info('session_full_reset_post_escalada', { telefono: digits, orgId, matchedKey: key, source: 'setConversationBotMode_memory' });
            } else if (active) {
                session.botActivo = true;
                persistSession(session.orgId, session.partialData?.telefono || digits, session);
            } else {
                session.botActivo = false;
                persistSession(session.orgId, session.partialData?.telefono || digits, session);
            }
            found++;
        }
    }
    logger.info('setConversationBotMode_result', { telefono: digits, active, isEscalationResolve, sessionsFound: found });
    if (found === 0 && isEscalationResolve) {
        const { getAllOrgs } = require('./services/org-registry');
        for (const org of getAllOrgs()) {
            const persisted = loadClient(org.orgId, digits);
            if (persisted) {
                deleteClient(org.orgId, digits);
                logger.info('session_full_reset_post_escalada', { orgId: org.orgId, telefono: digits, source: 'setConversationBotMode_sqlite_direct' });
            }
        }
    }
}

function findOriginalJid(orgId, phoneDigits) {
    const digits = phoneDigits.replace(/\D/g, '');
    for (const [key, s] of userSessions.entries()) {
        if (key.startsWith(orgId + ':') && s.partialData?.telefono === digits) {
            return s.originalJid || null;
        }
    }
    return null;
}

module.exports = {
    handleIncomingMessage,
    isBotActivo,
    setBotActivo,
    // Alias de compatibilidad (API global anterior):
    isBotGlobalActivo,
    setBotGlobalActivo,
    setConversationBotMode,
    setWAClient,
    resolveBizumResult,
    findOriginalJid,
    waSendMessage,
    isTransientWAError,
    extractSentMessageId,
    // Exportados para tests unitarios (lógica pura de selección/confirmación de huecos):
    _internals: { parseSlotSelection, normalizeHora, resolveSalonConfirmation, llmClaimsBooked,
        respondsWithInventedSlots, proposesTimingWithoutService, soloDeclaraHorarioDelSalon, unbackedBookingClaim, asksForBookingApproval, respondsWithFalseClosureClaim, applyAnchorFilter, salonNoSlotsMsg, salonOfferSlotsMsg, salonPickServiceMenuMsg, salonHairTreatmentRangeMsg, salonOfferHumanMsg, salonFueraDeHorarioMsg, horasLimiteHorario, TRATAMIENTOS_PRECIO_MIN, TRATAMIENTOS_PRECIO_MAX,
        // Red de escalada: traspaso anunciado en el texto del LLM (backstop determinista):
        announcesHumanHandover, offersHumanHandover, ensureHandoverAcknowledged, HANDOVER_ACUSE, HANDOVER_ACUSE_FORMAL, porTrato,
        // Escalada real (fila en pending_actions + Telegram), sin enviar mensaje al cliente:
        escalateToHuman,
        // Estado de servicio centralizado (fuente de verdad + limpieza):
        buildSessionExtra,
        clearServiceState, assignStylistIfAppropriate, applyStylistMention, computeStylistGating, shouldFixStylistFromLlm, SERVICE_STATE_DEFAULTS, SERVICE_PARTIAL_FIELDS, createEmptySession,
        // Flujos de reserva (aceptación de upsell, 2ª reserva, skill de estilista):
        isUpsellingAcceptance, matchesServiceName, resetForSecondBooking, stylistCanDoService,
        // Recarga de sesión con cita viva y barrido de abandono (deciden contra Supabase):
        reconciliarCitaViva, marcarAbandonadaSiNoTieneCita,
        // Resolución del contact_id: ningún call site debe leer session.leadId a pelo.
        ensureLeadId,
        // Escritura del idioma OBSERVADO: paso único de los dos detectores, con la guarda
        // que impide que la centralita de un negocio fije el idioma de una ficha.
        persistirIdiomaObservado,
        // Nombre antes de reservar:
        evaluarNombreAntesDeReservar, handleNombreParaCita, handleApellidoParaCita,
        leerNombreDeRespuesta, preguntaNombreMsg, preguntaApellidoMsg, PENDIENTE_NOMBRE,
        mensajeConfirmacionSante,
        // Huecos: exportados para poder comprobar que la duración con la que se BUSCA es la
        // misma con la que se ESCRIBE ends_at (si divergen, la cita pisa a la siguiente).
        loadAvailableSlots, reloadSlotsForConfirmation,
        // Citas que ya existen: resolución contra BD, localización y acciones.
        resolveCitasVivas, matchCitaByPistas, handleCitasExistentes, hidratarCitaEnSesion,
        ejecutarCancelacion, ampliacionSolapa, dowLunes0,
        // Solo para introspección en tests (no usar en producción):
        getSession: (orgId, userPhone) => userSessions.get(sessionKey(orgId, userPhone)),
        getBuffer: (orgId, userPhone) => messageBuffers.get(sessionKey(orgId, userPhone)),
        userSessions, sessionKey,
        notePendingMediaTurn, drainPendingMediaTurns, pendingMediaHistory,
        resolveMediaLanguage: (orgId, userPhone, dbPhone) => resolveMediaLanguage(orgId, sessionKey(orgId, userPhone), dbPhone),
        messageBuffers, BUFFER_DELAY_MS, flushBuffer: (orgId, userPhone) => flushBuffer(sessionKey(orgId, userPhone)) },
};
