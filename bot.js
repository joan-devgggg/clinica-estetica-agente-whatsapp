require('dotenv').config();
const { getChatbotResponse } = require('./services/ai');
const {
    saveLead, updateLead, findByPhone, saveMessage, saveAppointment,
    updateAppointment, setLeadBotMode, setBlacklist, createPendingAction,
    getAgentConfig, updateContactLanguage, updateContactPreferredStylist,
    getStylistsByOrg, getAllStylistSchedules, getLastCompletedAppointment,
} = require('./services/db');
const calendar = require('./services/calendar');
const calendarSante = require('./services/calendar-sante');
const { detectIntent, getMissingFields, extractQuickData, extractQuickDataSante, extractServiceFromText, extractStylistFromText, isAffirmative, normalizeText, wantsAnotherBooking, detectGuestBooking, extractGuestName, isValidName, detectLanguage } = require('./services/helpers');
const { incrementMetric } = require('./services/metrics');
const { transcribeAudio } = require('./services/transcription');
const { loadClient, saveClient, saveSummary } = require('./services/memory');
const { summarizeHistory } = require('./services/providers/openai');
const { notifyBizumPending, notifyEscalation, notifyBlacklistAlert } = require('./services/telegram');
const { getOrgType } = require('./services/org-registry');
const config = require('./config.json');
const logger = require('./lib/logger');

// ─── Constantes ───────────────────────────────────────────────────────────────
const userSessions = new Map();
const userQueues = new Map();
const latestMessages = new Map();

const SESSION_TIMEOUT = config.conversation?.sessionTimeoutMs || 3600000;
const ABANDON_THRESHOLD_MS = config.conversation?.abandonThresholdMs || 1800000;
const DEDUPE_TTL_MS = 60000;
const QUEUE_TTL_MS = 60000;
const GC_INTERVAL_MS = 3600000;
const MESSAGE_DELAY_MS_PER_CHAR = 2;
const MESSAGE_DELAY_MAX_MS = 120;
const MAX_USER_MESSAGE_LENGTH = 500;
const SUMMARY_THRESHOLD = 20;

let _botGlobalActivo = true;
function isBotGlobalActivo() { return _botGlobalActivo; }
function setBotGlobalActivo(v) {
    _botGlobalActivo = v;
    const { setConfigValue } = require('./services/db');
    setConfigValue(null, 'bot_activo', v);
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

// ─── Sesión ───────────────────────────────────────────────────────────────────
function createEmptySession(userId, orgId) {
    const telefono = userId.replace('@c.us', '').replace(/\D/g, '');
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
        language: null,
        selectedService: null,
        selectedStylist: null,
        slotsProposed: false,
        proposedSlots: [],
        askDatePreferenceFirst: false,
        datePreferenceAsked: false,
        upsellingSuggested: false,
        upsellingAccepted: [],
        preferredStylistId: null,
        ultimoServicio: null,
        ultimaEstilista: null,
        // Segunda reserva en la misma conversación (para un acompañante)
        guestBooking: false,
        guestName: null,
    };
}

// ─── Session key includes orgId ──────────────────────────────────────────────
function sessionKey(orgId, userPhone) { return `${orgId}:${userPhone}`; }

// ─── Utilidades ───────────────────────────────────────────────────────────────
function getMessageKey(msg) {
    return msg?.id?._serialized || msg?.key?.id || msg?.id?.id || null;
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

async function sendWithDelay(client, phone, text, orgId) {
    if (!text?.trim()) return;
    const delay = Math.min(text.length * MESSAGE_DELAY_MS_PER_CHAR, MESSAGE_DELAY_MAX_MS);
    try {
        await (await client.getChatById(phone)).sendStateTyping();
        if (delay > 100) await new Promise(r => setTimeout(r, delay));
        await client.sendMessage(phone, text);
    } catch {
        await client.sendMessage(phone, text);
    }
    saveMessage(orgId, { telefono: phone.replace('@c.us', '').replace(/\D/g, ''), contenido: text, direccion: 'saliente' }).catch(() => {});
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
    try {
        if (session.orgType === 'salon') {
            const service = session.selectedService;
            const slots = await calendarSante.getAvailableSlots(orgId, {
                serviceDuration: service?.duracion || 60,
                serviceCategory: service?.categoria,
                preferredStylistId: session.selectedStylist?.id || session.preferredStylistId,
                preferencia: session.partialData.preferencia_horaria || {},
            });
            session.availableSlots = slots;
            // Si el día concreto pedido no tenía disponibilidad real, calendar-sante
            // devuelve los huecos más cercanos y marca esta bandera para que el LLM
            // avise a la clienta en vez de afirmar que el día pedido está libre.
            session.slotsRequestedDayUnavailable = !!slots.requestedDayUnavailable;

            // Si solo hay una estilista posible para el servicio (p.ej. masajes → Larisa),
            // asígnala automáticamente y sáltate la pregunta de preferencia. Así el flujo
            // avanza directo a proponer huecos en vez de quedarse atascado pidiendo estilista.
            if (!session.selectedStylist && slots.length > 0) {
                const distinctStylists = [...new Set(slots.map(s => s.stylistId))];
                if (distinctStylists.length === 1) {
                    session.selectedStylist = { id: slots[0].stylistId, nombre: slots[0].stylistName };
                }
            }
        } else {
            const pref = session.partialData.preferencia_horaria || {};
            const slots = await calendar.getAvailableSlots(pref);
            session.availableSlots = slots.map(s => ({ ...s, texto: calendar.formatSlotForMessage(s) }));
        }
        session.currentSlotIndex = 0;
    } catch (e) {
        logger.error('error_slots', { orgId, error: e.message });
        session.availableSlots = [];
    }
}

// ─── Persistencia SQLite ──────────────────────────────────────────────────────
// El estado del salón (servicio/estilista elegidos, idioma, upselling) no cabe en
// partialData y se pierde al recargar la sesión tras un reinicio/timeout. Lo volcamos
// en session.extra para que memory.js lo persista; los huecos se recalculan al volver.
function buildSessionExtra(session) {
    if (session.orgType !== 'salon') return null;
    return {
        selectedService:   session.selectedService || null,
        selectedStylist:   session.selectedStylist || null,
        language:          session.language || null,
        upsellingAccepted: session.upsellingAccepted || [],
        upsellingSuggested: !!session.upsellingSuggested,
        preferredStylistId: session.preferredStylistId || null,
        currentSlotIndex:  session.currentSlotIndex || 0,
        slotsProposed:     !!session.slotsProposed,
        guestBooking:      !!session.guestBooking,
        guestName:         session.guestName || null,
        bookedSlots:       Array.isArray(session.bookedSlots) ? session.bookedSlots : [],
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

// ─── Acciones de reserva/cita ────────────────────────────────────────────────
async function handleAppointmentAction(client, session, userPhone, accion, respuesta) {
    const orgId = session.orgId;
    if (accion === 'cancelar') {
        if (session.appointmentId) {
            if (session.orgType === 'salon') await calendarSante.cancelAppointment(orgId, session.appointmentId);
            else await calendar.cancelAppointment(session.appointmentId);
            await updateAppointment(orgId, session.appointmentId, { estado: 'cancelled' });
        }
        session.reservaConfirmada = false;
        session.bizumAsked = false;
        session.bizumPendiente = false;
        session.appointmentId = null;
        session.selectedService = null;
        session.selectedStylist = null;
        await updateLead(orgId, { telefono: session.partialData.telefono, estado_cita: 'cancelado', leadId: session.leadId });
        const cancelMsgs = { en: "Your appointment has been cancelled ✅ If you'd like to book another, just let me know 😊", ru: 'Запись отменена ✅ Если захочешь записаться снова, напиши мне 😊', uk: 'Запис скасовано ✅ Якщо захочеш записатися знову, напиши мені 😊' };
        const msg = session.orgType === 'salon'
            ? (session.language && cancelMsgs[session.language]) || 'Tu cita ha sido cancelada ✅ Si quieres reservar otra, dímelo cuando quieras 😊'
            : 'Tu reserva ha sido cancelada ✅ Si quieres reservar otro día, dímelo cuando quieras 😊';
        await sendWithDelay(client, userPhone, msg, orgId);
        return true;
    }
    if (accion === 'cambiar') {
        session.reservaConfirmada = false;
        session.bizumAsked = false;
        session.bizumPendiente = false;
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
        await sendWithDelay(client, userPhone, msg, orgId);
        return true;
    }
    if (accion === 'escalar_humano') {
        session.botActivo = false;
        try {
            await setLeadBotMode(orgId, session.partialData.telefono, 'manual');
            const contact = await findByPhone(orgId, session.partialData.telefono);
            const ultimoMensaje = session.history[session.history.length - 1]?.content || '';
            await createPendingAction(orgId, {
                type: 'escalation',
                contactId: contact?.id || session.leadId,
                payload: { motivo: 'escalado_bot', mensaje: ultimoMensaje },
            });
            notifyEscalation(orgId, { nombre: session.partialData.nombre, telefono: session.partialData.telefono }, ultimoMensaje).catch(() => {});
        } catch (e) { logger.error('error_escalar', { telefono: userPhone, error: e.message }); }
        if (respuesta) await sendWithDelay(client, userPhone, respuesta, orgId);
        return true;
    }
    return false;
}

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
            notifyBizumPending(orgId, {
                nombre: session.partialData.nombre,
                telefono: session.partialData.telefono,
                fecha, hora,
                personas: session.partialData.personas,
                ocasion: session.partialData.ocasion,
            }).catch(() => {});
        }
    } catch (e) {
        logger.error('error_finalizar_bizum', { telefono: userPhone, error: e.message });
    }

    session.reservaConfirmada = true;
    session.bizumPendiente = true;
    session.leadStatus = 'completed';

    const respuesta = '¡Gracias! 🙏 En cuanto verifiquemos el Bizum te confirmamos la reserva por aquí.';
    session.history.push({ role: 'assistant', content: respuesta });
    await sendWithDelay(client, userPhone, respuesta, orgId);
}

// ─── Selección del hueco elegido por la clienta (Sante) ─────────────────────
// El LLM nos devuelve la hora que la clienta acepta; buscamos ese hueco exacto
// en la lista para no reservar siempre el primero. Fallback: el hueco actual.
function normalizeHora(h) {
    if (!h) return null;
    const m = String(h).match(/(\d{1,2})\s*[:h.]?\s*(\d{2})?/);
    if (!m) return null;
    return `${String(m[1]).padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
}

// Resuelve el hueco que la clienta acepta contra la lista EXACTA que se le propuso
// (session.proposedSlots = lo numerado que vio el LLM). Nunca adivina con slots[0]:
// si la selección es ambigua devuelve null y el bot vuelve a preguntar, en vez de
// guardar el hueco más temprano (que causaba BUG 2 estilista y BUG 3 fecha/hora).
function pickChosenSlot(session, datos) {
    const slots = (session.proposedSlots && session.proposedSlots.length)
        ? session.proposedSlots
        : (session.availableSlots || []);
    if (!slots.length) return null;

    const horaSel = normalizeHora(datos?.hora_cita);
    const fechaSel = datos?.fecha_cita || null;

    // (a) fecha + hora exactas → match inequívoco.
    if (horaSel && fechaSel) {
        const exact = slots.find(s => normalizeHora(s.hora) === horaSel && s.fecha === fechaSel);
        if (exact) return exact;
    }
    // (b) solo hora, pero únicamente si NO es ambigua (un solo día propuesto con esa hora).
    if (horaSel) {
        const byHora = slots.filter(s => normalizeHora(s.hora) === horaSel);
        if (byHora.length === 1) return byHora[0];
    }
    // (c) un único hueco propuesto → no hay nada que confundir.
    if (slots.length === 1) return slots[0];

    // Ambiguo: no elegimos por la clienta.
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
function llmClaimsBooked(text) {
    if (!text) return false;
    const t = normalizeText(text);
    return [
        // ES
        'te he reservado', 'te la he reservado', 'te lo he reservado',
        'te reservo', 'te la reservo', 'te lo reservo',
        'te apunto', 'te anoto', 'te he apuntado', 'te he anotado',
        'queda confirmada', 'queda reservada', 'queda agendada', 'queda fijada', 'queda apuntada', 'queda anotada',
        'esta reservado', 'esta reservada', 'esta confirmada', 'esta confirmado',
        'esta agendada', 'esta apuntada', 'esta anotada',
        'cita confirmada', 'cita reservada', 'cita agendada', 'cita apuntada', 'cita anotada',
        'reserva confirmada', 'reservada para', 'confirmada tu cita', 'confirmada la cita',
        // EN
        "you're booked", 'youre booked', "i've booked", 'ive booked', 'booked you',
        'appointment is confirmed', "you're all set", 'youre all set', 'see you on',
        'i have booked', 'i booked you',
        // RU
        'записала', 'записал', 'вы записаны', 'бронь подтверждена', 'запись подтверждена',
        // UK
        'записала вас', 'записано', 'бронювання підтверджено', 'запис підтверджено',
    ].some(p => t.includes(p));
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

// ─── Segunda reserva en la misma conversación (Sante) ───────────────────────
// Tras confirmar una cita, la clienta puede pedir otra (para ella o un acompañante).
// Reiniciamos SOLO el estado de reserva, conservando idioma, contacto e historial,
// para que el flujo arranque limpio y guarde también esta segunda cita.
function resetForSecondBooking(session, sanitized) {
    session.reservaConfirmada = false;
    session.appointmentId = null;
    session.selectedService = null;
    session.selectedStylist = null;
    session.availableSlots = [];
    session.proposedSlots = [];
    session.currentSlotIndex = 0;
    session.slotsProposed = false;
    session.datePreferenceAsked = false;
    session.upsellingAccepted = [];
    session.upsellingSuggested = false;
    session.modoReagendamiento = false;
    session.leadStatus = 'in_progress';
    delete session.partialData.preferencia_horaria;
    delete session.partialData.fecha_cita;
    delete session.partialData.hora_cita;
    delete session.partialData.estado_cita;
    delete session.partialData.notas;

    // ¿Es para otra persona? Pedimos su nombre; si ya viene en el mensaje, lo capturamos.
    const esInvitado = detectGuestBooking(sanitized);
    session.guestBooking = esInvitado;
    session.guestName = esInvitado ? extractGuestName(sanitized) : null;

    logger.info('segunda_reserva_iniciada', {
        orgId: session.orgId, guestBooking: session.guestBooking, guestName: session.guestName || null,
    });
}

// Decide si la clienta ha aceptado un hueco y devuelve { slot, motivo } o null.
// No nos fiamos solo del flag del LLM (lo omite a menudo y dice "te he reservado" sin
// disparar el guardado → fallo silencioso). Reservamos cuando: (1) el LLM pone el flag,
// (2) el LLM devuelve una hora que coincide con un hueco real, (3) la clienta responde
// afirmativamente DESPUÉS de que ya le hayamos propuesto huecos, o (4) el propio texto del
// LLM afirma que la cita queda reservada. Guardas: tiene que haber servicio y huecos
// cargados, para no reservar prematuramente.
function resolveSalonConfirmation(session, aiResponse, sanitized) {
    if (session.reservaConfirmada) return null;
    if (!session.selectedService) return null;
    if (!(session.availableSlots || []).length) return null;

    // Trabajamos SIEMPRE contra la lista exacta de huecos propuestos (lo que vio el LLM
    // numerado), no contra availableSlots: así un ordinal ("el 2") o un "sí" se resuelven
    // al hueco que realmente se mostró, con su estilista y fecha correctas.
    const proposed = (session.proposedSlots && session.proposedSlots.length)
        ? session.proposedSlots
        : (session.availableSlots || []);

    if (aiResponse.reserva_confirmada) {
        const slot = pickChosenSlot(session, aiResponse.datos);
        if (slot) return { slot, motivo: 'llm_flag' };
    }

    // Match por hora: exige fecha si varios huecos comparten esa hora (evita coger el día
    // más temprano por error). pickChosenSlot ya aplica esta regla de no-ambigüedad.
    const horaSel = normalizeHora(aiResponse.datos?.hora_cita);
    if (horaSel) {
        const slot = pickChosenSlot(session, aiResponse.datos);
        if (slot) return { slot, motivo: 'match_hora' };
    }

    // Selección posicional/ordinal: "el primero", "la segunda", "el de las 14"...
    // El LLM a menudo NO extrae la hora cuando la clienta elige por posición, así
    // que lo resolvemos nosotros contra la lista real de huecos propuestos.
    if (session.slotsProposed) {
        const bySel = parseSlotSelection(sanitized, proposed);
        if (bySel) return { slot: bySel, motivo: 'seleccion_posicional' };
    }

    if (session.slotsProposed && isAffirmative(sanitized)) {
        const slot = pickChosenSlot(session, aiResponse.datos);
        if (slot) return { slot, motivo: 'afirmativo_tras_propuesta' };
    }

    // (4) Red de seguridad anti-fallo-silencioso: el LLM dice en su texto que la cita
    // queda reservada pero no puso el flag y nada encajó arriba. Guardamos el hueco que
    // más encaje (o el último propuesto) para no mentirle a la clienta sin persistir.
    if (session.slotsProposed && llmClaimsBooked(aiResponse.respuesta)) {
        const slot = pickChosenSlot(session, aiResponse.datos);
        if (slot) return { slot, motivo: 'texto_llm_confirma' };
    }

    return null;
}

// ─── Finalización directa de cita (Sante) ───────────────────────────────────
// Devuelve true SOLO si la cita se guardó en Supabase. Marca la sesión como
// confirmada únicamente en ese caso, para no decirle a la clienta que está
// confirmada cuando en realidad no se ha persistido nada.
async function finalizarCitaSante(client, session, userPhone, slot) {
    const orgId = session.orgId;
    if (!slot) return false;

    const fecha = slot.fecha;
    const hora = slot.hora;
    const stylistId = slot.stylistId;

    // Guarda de idempotencia por sesión: no reservar dos veces el MISMO hueco
    // (fecha+hora+estilista) en una conversación. Evita que la resolución de confirmación
    // y la red de seguridad (o un reset/segunda reserva mal disparado) creen citas
    // duplicadas. Una segunda cita REAL será otro hueco distinto y sí pasará esta guarda.
    const slotSig = `${fecha}|${hora}|${stylistId || ''}`;
    if (!Array.isArray(session.bookedSlots)) session.bookedSlots = [];
    if (session.bookedSlots.includes(slotSig)) {
        logger.warn('cita_sante_duplicada_evitada', { orgId, telefono: userPhone, slotSig });
        session.reservaConfirmada = true;
        return true; // ya reservada en esta sesión: no creamos otra
    }

    session.partialData.fecha_cita = fecha;
    session.partialData.hora_cita = hora;

    logger.info('cita_sante_intento', {
        orgId, telefono: userPhone, fecha, hora, stylistId,
        servicio: session.selectedService?.nombre || null, contactId: session.leadId,
    });

    try {
        const rid = await saveLead(orgId, { ...session.partialData, leadId: session.leadId, language: session.language });
        if (rid) session.leadId = rid;
        session.leadGuardado = true;
        incrementMetric('leadsSaved');

        if (!session.leadId) {
            logger.error('cita_sante_sin_contacto', { orgId, telefono: userPhone, fecha, hora });
            return false;
        }

        const allServices = [session.selectedService?.nombre, ...(session.upsellingAccepted || [])].filter(Boolean).join(' + ');
        const totalDuration = (session.selectedService?.duracion || 60) + (session.upsellingAccepted || []).length * 30;

        // Si la cita es para un acompañante, lo dejamos anotado en la cita (el contacto
        // sigue siendo el titular del WhatsApp, pero la cita es para otra persona).
        const guestNote = session.guestBooking && session.guestName ? `Cita para: ${session.guestName}` : null;
        const notasCita = [guestNote, session.partialData.notas].filter(Boolean).join(' · ') || null;

        const result = await calendarSante.bookAppointment(orgId, slot, session.leadId, {
            servicio: allServices || session.selectedService?.nombre || 'Cita',
            duracionMin: totalDuration,
            stylistId,
            notas: notasCita,
        });

        if (!result.success) {
            logger.error('cita_sante_no_guardada', { orgId, telefono: userPhone, fecha, hora, stylistId, contactId: session.leadId });
            return false;
        }

        logger.info('cita_sante_guardada', { orgId, telefono: userPhone, appointmentId: result.appointmentId, fecha, hora, stylistId, contactId: session.leadId });
        session.appointmentId = result.appointmentId;
        session.partialData.estado_cita = 'confirmado';
        await updateLead(orgId, { leadId: session.leadId, appointment_id: result.appointmentId, estado_cita: 'confirmado' });
        // Update preferred stylist for returning visits
        if (stylistId && session.leadId) {
            updateContactPreferredStylist(orgId, session.leadId, stylistId).catch(() => {});
        }

        session.reservaConfirmada = true;
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
        logger.error('error_finalizar_cita_sante', { telefono: userPhone, error: e.message });
        return false;
    }
}

// ─── Resolución desde Telegram (Bizum confirm/reject) ───────────────────────
async function resolveBizumResult(pendingAction, confirmed) {
    const orgId = pendingAction.organization_id;
    const contact = pendingAction.contacts;
    const appointment = pendingAction.appointments;
    const telefono = contact?.wa_phone;
    if (!telefono) return;
    const userPhone = `${telefono.replace(/\D/g, '')}@c.us`;

    if (confirmed) {
        await updateLead(orgId, { leadId: contact.id, estado_cita: 'confirmado' });
        if (appointment?.id) await updateAppointment(orgId, appointment.id, { bizumStatus: 'confirmed', estado: 'confirmed' });

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
        if (appointment?.id) await updateAppointment(orgId, appointment.id, { bizumStatus: 'rejected', estado: 'cancelled' });
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
async function processMessageCore(client, message, userPhone, userText, messageKey, orgId) {
    try {
        if (!isBotGlobalActivo()) return;

        const sKey = sessionKey(orgId, userPhone);
        const orgType = getOrgType(orgId);
        const existingSession = userSessions.get(sKey);
        let isNewSession = false;
        let loadedFromSQLite = false;

        if (!existingSession) {
            const persisted = loadClient(orgId, userPhone);
            const newSession = createEmptySession(userPhone, orgId);

            if (persisted) {
                loadedFromSQLite = true;
                newSession.history = persisted.history || [];
                newSession.summary = persisted.summary || null;
                newSession.botActivo = persisted.botActivo;

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
                        // Cita anterior completada (confirmada/cancelada/etc.) →
                        // cliente recurrente que puede reservar de nuevo.
                        newSession.clienteRecurrente = true;
                        newSession.ultimaVisita = persisted.partialData?.fecha_cita || null;
                        if (persisted.partialData?.nombre) newSession.partialData.nombre = persisted.partialData.nombre;
                        // Limpiar estado de reserva anterior para no bloquear nuevas citas
                        newSession.selectedService = null;
                        newSession.selectedStylist = null;
                        newSession.availableSlots = [];
                        newSession.currentSlotIndex = 0;
                        newSession.slotsProposed = false;
                        newSession.upsellingAccepted = [];
                        newSession.upsellingSuggested = false;
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
        } else if (Date.now() - existingSession.lastUpdate > SESSION_TIMEOUT) {
            persistSession(orgId, userPhone, existingSession);
            const prev = existingSession;
            userSessions.set(sKey, createEmptySession(userPhone, orgId));
            userSessions.get(sKey).botActivo = prev.botActivo;
            isNewSession = true;
        }

        const session = userSessions.get(sKey);
        if (!session) return;

        // Check contact in DB
        if (isNewSession) {
            try {
                const contact = await findByPhone(orgId, session.partialData.telefono);
                if (contact) {
                    if (contact.bot_mode === 'manual') session.botActivo = false;
                    if (contact.is_blacklisted) session.isBlacklisted = true;
                    session.leadId = session.leadId || contact.id;
                    session.language = contact.language || null;
                    session.preferredStylistId = contact.preferred_stylist_id || null;
                    if (!loadedFromSQLite) {
                        session.clienteRecurrente = (contact.visit_count || 0) > 0;
                        session.ultimaVisita = contact.fecha_cita || null;
                        if (!session.partialData.nombre && contact.nombre) session.partialData.nombre = contact.nombre;
                    }

                    if (session.clienteRecurrente && contact.id && orgType === 'salon') {
                        try {
                            const lastAppt = await getLastCompletedAppointment(orgId, contact.id);
                            if (lastAppt) {
                                session.ultimoServicio = lastAppt.service;
                                session.ultimaEstilista = lastAppt.stylist_name;
                            }
                        } catch (e) { logger.error('error_load_last_appt', { orgId, error: e.message }); }
                    }
                }
            } catch (e) { logger.error('error_check_contact', { orgId, telefono: userPhone, error: e.message }); }
        }

        if (messageKey && session.seenMessages.has(messageKey)) return;
        if (messageKey) session.seenMessages.add(messageKey);

        // Blacklist check
        if (session.isBlacklisted) {
            if (!session.blacklistNotified) {
                session.blacklistNotified = true;
                session.botActivo = false;
                try {
                    await setLeadBotMode(orgId, session.partialData.telefono, 'manual');
                    const contact = await findByPhone(orgId, session.partialData.telefono);
                    await createPendingAction(orgId, {
                        type: 'escalation',
                        contactId: contact?.id || session.leadId,
                        payload: { motivo: 'lista_negra', mensaje: userText },
                    });
                    notifyBlacklistAlert(orgId, { nombre: contact?.nombre || session.partialData.nombre, telefono: session.partialData.telefono, blacklist_reason: contact?.blacklist_reason }).catch(() => {});
                } catch (e) { logger.error('error_blacklist_notify', { telefono: userPhone, error: e.message }); }
                await sendWithDelay(client, userPhone, 'Gracias por tu mensaje 🙏 En breve te atenderá nuestro equipo.', orgId);
                persistSession(orgId, userPhone, session);
            }
            return;
        }

        const textLower = userText.toLowerCase().trim();
        if (textLower === 'stop') {
            session.botActivo = false;
            await sendWithDelay(client, userPhone, config.conversation?.deactivatedMessage || 'Asistente desactivado.', orgId);
            return;
        }
        if (textLower === 'start') {
            session.botActivo = true;
            await sendWithDelay(client, userPhone, config.conversation?.reactivatedMessage || 'Asistente activado.', orgId);
            return;
        }
        if (!session.botActivo) return;

        const now = Date.now();
        if (session.lastMessageTime && (now - session.lastMessageTime) < (config.conversation?.duplicateMessageWindowMs || 1500)) return;

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
                await sendWithDelay(client, userPhone, limitMsg, orgId);
                session.botActivo = false;
            }
            return;
        }

        session.lastMessageTime = now;
        session.lastUpdate = now;
        const sanitized = sanitizeUserMessage(userText);
        if (!sanitized) return;

        session.history.push({ role: 'user', content: sanitized });
        incrementMetric('userReplied');

        try { await (await client.getChatById(userPhone)).sendStateTyping(); } catch {}

        // ─── Extract data based on org type ───────────────────────────────
        const prevData = { ...session.partialData };

        if (orgType === 'salon') {
            // Salon: extract name, preference, detect service/stylist from LLM
            session.partialData = extractQuickDataSante(sanitized, session.partialData);
            // Detectar idioma en CADA mensaje para que el bot responda en el
            // idioma actual del cliente, no en el de una sesión anterior.
            const lang = detectLanguage(sanitized);
            if (lang) {
                session.language = lang;
                if (session.leadId) updateContactLanguage(orgId, session.leadId, lang).catch(() => {});
            }
        } else {
            // Restaurant: extract name, personas, preference
            session.partialData = extractQuickData(sanitized, session.partialData);
        }

        const intent = detectIntent(sanitized);

        // ─── Salon: segunda reserva en la misma conversación ─────────────
        // Si ya hay una cita confirmada y la clienta pide otra (para ella o un
        // acompañante), reiniciamos el flujo para gestionar y guardar la nueva cita.
        if (orgType === 'salon') {
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
                if (!nuevaReserva) {
                    try {
                        const cfgSecond = await getAgentConfig(orgId);
                        const svcNuevo = extractServiceFromText(sanitized, cfgSecond?.services || []);
                        if (svcNuevo && svcNuevo.nombre !== session.selectedService?.nombre) {
                            nuevaReserva = true;
                        } else {
                            const stylistsSecond = await getStylistsByOrg(orgId);
                            const styNuevo = extractStylistFromText(sanitized, stylistsSecond);
                            if (styNuevo && styNuevo.id !== session.selectedStylist?.id) nuevaReserva = true;
                        }
                    } catch (e) { logger.error('error_deteccion_segunda_reserva', { orgId, error: e.message }); }
                }
                if (nuevaReserva) resetForSecondBooking(session, sanitized);
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

        // ─── Salon: detectar servicio/estilista ANTES del LLM ────────────
        // Así los huecos se calculan en el MISMO turno en que la clienta nombra
        // el servicio (ej. "un masaje relajante") y el LLM los propone directamente,
        // sin un turno de espera ni mensajes de "un momento".
        if (orgType === 'salon') {
            const agentCfgPre = await getAgentConfig(orgId);
            const stylistsPre = await getStylistsByOrg(orgId);
            if (!session.selectedService) {
                const matchedSvc = extractServiceFromText(sanitized, agentCfgPre?.services || []);
                if (matchedSvc) {
                    session.selectedService = matchedSvc;
                    // Re-validate: stylist set in a prior turn may not have the skill
                    // for the newly selected service (e.g. Larisa set before manicura).
                    if (session.selectedStylist) {
                        const styRec = stylistsPre.find(s => s.id === session.selectedStylist.id);
                        if (styRec && !stylistCanDoService(styRec, matchedSvc)) {
                            session.selectedStylist = null;
                        }
                    }
                }
            }
            if (!session.selectedStylist) {
                const matchedSty = extractStylistFromText(sanitized, stylistsPre);
                if (matchedSty && stylistCanDoService(matchedSty, session.selectedService)) {
                    session.selectedStylist = { id: matchedSty.id, nombre: matchedSty.name };
                }
            }
        }

        // ─── Load slots when ready ───────────────────────────────────────
        if (orgType === 'salon') {
            const meDaIgual = /\b(me da igual|cualquiera|la que sea|el que sea|no tengo preferencia|me es igual|sin preferencia|whoever|anyone|любой|любую)\b/i.test(sanitized);

            // Estilistas que pueden hacer el servicio (por skills). Si solo hay una,
            // la asignamos y no preguntamos. Si hay varias, preguntamos preferencia ANTES
            // de proponer huecos (decisión de producto).
            let eligibleStylists = [];
            if (session.selectedService) {
                const allStylists = await getStylistsByOrg(orgId);
                eligibleStylists = allStylists.filter(s => stylistCanDoService(s, session.selectedService));

                // Validar estilista seleccionada: si fue elegida ANTES de conocer el
                // servicio (ej. "cita con Larisa" → luego "manicura") o viene de una
                // sesión anterior, puede no tener la skill. Limpiarla para asignar bien.
                if (session.selectedStylist) {
                    const sigueElegible = eligibleStylists.some(s => s.id === session.selectedStylist.id);
                    if (!sigueElegible) session.selectedStylist = null;
                }

                if (!session.selectedStylist && eligibleStylists.length === 1) {
                    session.selectedStylist = { id: eligibleStylists[0].id, nombre: eligibleStylists[0].name };
                }
            }
            session._eligibleStylistNames = eligibleStylists.map(s => s.name);

            const variasEstilistas = !!session.selectedService && !session.selectedStylist && eligibleStylists.length > 1;
            // "me da igual" → asignamos la primera elegible y avanzamos.
            if (variasEstilistas && meDaIgual) {
                session.selectedStylist = { id: eligibleStylists[0].id, nombre: eligibleStylists[0].name };
            }
            session.askStylistFirst = !!session.selectedService && !session.selectedStylist && eligibleStylists.length > 1;

            // Si es una reserva para un acompañante y aún no sabemos su nombre, lo pedimos primero.
            const esperandoNombreInvitado = session.guestBooking && !session.guestName;

            // Coherencia: si no hay huecos cargados, slotsProposed y datePreferenceAsked
            // pueden ser residuos de una interacción anterior en la misma sesión en memoria.
            // Resetearlos para que la puerta de fecha funcione limpiamente.
            if (session.availableSlots.length === 0 && !session.reservaConfirmada) {
                session.slotsProposed = false;
                session.datePreferenceAsked = false;
            }

            const prefFecha = session.partialData.preferencia_horaria || {};
            const tienePistaFecha = !!(prefFecha.semana || prefFecha.periodo || prefFecha.fecha ||
                Number.isInteger(prefFecha.diaSemana)) || meDaIgual;
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
                // Si ya hay huecos cargados marcamos slotsProposed YA (no solo al final del
                // turno tras enviar): así un "sí/vale" o una selección posicional en el turno
                // siguiente se interpreta como aceptación aunque el LLM omita el flag — el
                // fallo silencioso de "te he reservado" sin guardar venía del desfase de un turno.
                if (session.availableSlots.length > 0 && !session.reservaConfirmada) {
                    session.slotsProposed = true;
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
            partialDataWithCtx.__selectedService = session.selectedService;
            partialDataWithCtx.__selectedStylist = session.selectedStylist;
            partialDataWithCtx.__upsellingSuggested = session.upsellingSuggested;
            partialDataWithCtx.__stylistAutoAssigned = !!session.selectedStylist;
            partialDataWithCtx.__askStylistFirst = !!session.askStylistFirst;
            partialDataWithCtx.__askDatePreferenceFirst = !!session.askDatePreferenceFirst;
            partialDataWithCtx.__eligibleStylistNames = session._eligibleStylistNames || [];
            partialDataWithCtx.__clientLanguage = session.language;
            if (session.preferredStylistId) {
                const stylists = await getStylistsByOrg(orgId);
                const pref = stylists.find(s => s.id === session.preferredStylistId);
                partialDataWithCtx.__preferredStylistName = pref?.name || null;
            }
            partialDataWithCtx.__ultimoServicio = session.ultimoServicio || null;
            partialDataWithCtx.__ultimaEstilista = session.ultimaEstilista || null;
            partialDataWithCtx.__guestBooking = !!session.guestBooking;
            partialDataWithCtx.__guestName = session.guestName || null;
            partialDataWithCtx.__requestedDayUnavailable = !!session.slotsRequestedDayUnavailable;

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
        let aiResponse;
        const t0 = Date.now();
        const WAIT_MSG_DELAY = 8000;
        let sentWaitingMessage = false;

        const llmPromise = getChatbotResponse(orgId, session.history.slice(-10), partialDataWithCtx, intent, session.reservaConfirmada, session.summary)
            .catch(e => {
                logger.error('llm_error', { orgId, telefono: userPhone, error: e.message, latencia_ms: Date.now() - t0 });
                return null;
            });

        const WAITING = {};
        const waitTimer = new Promise(resolve => setTimeout(() => resolve(WAITING), WAIT_MSG_DELAY));
        const raceResult = await Promise.race([llmPromise, waitTimer]);

        if (raceResult !== WAITING) {
            aiResponse = raceResult;
            if (aiResponse) logger.info('llm_response', { orgId, telefono: userPhone, latencia_ms: Date.now() - t0 });
        } else {
            const waitMsgs = { en: 'One moment, please 😊', ru: 'Минутку, пожалуйста 😊', uk: 'Хвилинку, будь ласка 😊' };
            const waitMsg = (session.language && waitMsgs[session.language]) || 'Un momento, por favor 😊';
            await sendWithDelay(client, userPhone, waitMsg, orgId);
            sentWaitingMessage = true;

            aiResponse = await llmPromise;
            if (aiResponse) {
                logger.info('llm_response_after_wait', { orgId, telefono: userPhone, latencia_ms: Date.now() - t0 });
            } else {
                logger.error('llm_failed_after_wait', { orgId, telefono: userPhone, latencia_ms: Date.now() - t0 });
            }
        }

        if (!aiResponse?.respuesta) {
            const pendingSlots = session.availableSlots?.slice(session.currentSlotIndex) || [];
            if (orgType === 'salon' && pendingSlots.length > 0 && session.selectedService) {
                const svcName = session.selectedService.nombre || 'tu servicio';
                const svcPrecio = session.selectedService.precio;
                const svcDur = session.selectedService.duracion;
                const grouped = {};
                for (const s of pendingSlots) {
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
                logger.info('llm_timeout_slots_fallback', { orgId, telefono: userPhone, numSlots: pendingSlots.length });
            } else if (orgType === 'salon') {
                if (sentWaitingMessage) {
                    const retryMsgs = {
                        en: "Sorry, I couldn't process that. Could you repeat? 😊",
                        ru: 'Извини, не удалось обработать. Можешь повторить? 😊',
                        uk: 'Вибач, не вдалося обробити. Можеш повторити? 😊',
                    };
                    const fbText = (session.language && retryMsgs[session.language]) || 'Perdona, no he podido procesar tu mensaje. ¿Me lo repites? 😊';
                    aiResponse = { respuesta: fbText, reserva_confirmada: false, slot_rechazado: false, accion: null, datos: {} };
                } else {
                    const fbMsgs = {
                        en: 'One moment, please 😊',
                        ru: 'Минутку, пожалуйста 😊',
                        uk: 'Хвилинку, будь ласка 😊',
                    };
                    const fbText = (session.language && fbMsgs[session.language]) || 'Un momento, por favor 😊';
                    aiResponse = { respuesta: fbText, reserva_confirmada: false, slot_rechazado: false, accion: null, datos: {} };
                }
            } else {
                const fbText = 'Se me ha ido la conexión 😅 ¿me repites?';
                aiResponse = { respuesta: fbText, reserva_confirmada: false, slot_rechazado: false, accion: null, datos: {} };
            }
        }

        // ─── Process LLM response ────────────────────────────────────────

        // Handle actions (cancel, reschedule, escalate)
        if (aiResponse.accion && !(aiResponse.accion === 'cambiar' && session.modoReagendamiento)) {
            const handled = await handleAppointmentAction(client, session, userPhone, aiResponse.accion, aiResponse.respuesta);
            if (handled) {
                if (aiResponse.accion !== 'escalar_humano') session.history.push({ role: 'assistant', content: aiResponse.respuesta });
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
            // Language detection
            if (aiResponse.idioma_detectado && aiResponse.idioma_detectado !== session.language) {
                session.language = aiResponse.idioma_detectado;
                if (session.leadId) {
                    updateContactLanguage(orgId, session.leadId, session.language).catch(() => {});
                }
            }

            // Service selection from LLM — don't load slots here; let the next
            // turn's pre-LLM logic check if we need to ask date preference first.
            if (aiResponse.datos?.servicio && !session.selectedService) {
                const agentCfg = await getAgentConfig(orgId);
                const servicesCatalog = agentCfg?.services || [];
                const matched = extractServiceFromText(aiResponse.datos.servicio, servicesCatalog);
                if (matched) {
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

            // Stylist from LLM
            if (aiResponse.datos?.estilista_preferida && !session.selectedStylist) {
                const stylists = await getStylistsByOrg(orgId);
                const matched = extractStylistFromText(aiResponse.datos.estilista_preferida, stylists);
                if (matched && stylistCanDoService(matched, session.selectedService)) session.selectedStylist = { id: matched.id, nombre: matched.name };
            }

            // Upselling tracking
            if (aiResponse.datos?.upselling_aceptado?.length > 0) {
                session.upsellingAccepted = [...new Set([...(session.upsellingAccepted || []), ...aiResponse.datos.upselling_aceptado])];
            }
            if (session.selectedService && !session.upsellingSuggested) {
                session.upsellingSuggested = true;
            }

            // Appointment confirmation (Sante: no Bizum). No dependemos solo del flag del
            // LLM: resolveSalonConfirmation también reserva si la clienta acepta un hueco
            // propuesto (hora que coincide o "sí/vale" tras la propuesta).
            const confirm = resolveSalonConfirmation(session, aiResponse, sanitized);
            if (confirm) {
                logger.info('cita_sante_confirmacion', { orgId, telefono: userPhone, motivo: confirm.motivo, fecha: confirm.slot.fecha, hora: confirm.slot.hora });
                const ok = await finalizarCitaSante(client, session, userPhone, confirm.slot);
                if (ok) {
                    // Garantizamos que la respuesta confirme aunque el LLM no lo hiciera.
                    aiResponse.reserva_confirmada = true;
                } else {
                    // No se pudo reservar (fallo al guardar): NO confirmamos para no mentirle.
                    aiResponse.reserva_confirmada = false;
                    aiResponse.respuesta = salonRetryMsg(session.language);
                }
            } else if (aiResponse.reserva_confirmada && !session.reservaConfirmada) {
                // El LLM dijo confirmada pero no hay servicio/hueco resoluble: no mentimos.
                logger.warn('cita_sante_flag_sin_slot', { orgId, telefono: userPhone, tieneServicio: !!session.selectedService, numHuecos: (session.availableSlots || []).length });
                aiResponse.reserva_confirmada = false;
                aiResponse.respuesta = salonRetryMsg(session.language);
            }

            // ─── Red de seguridad final anti-mentira ─────────────────────────
            // Invariante: nunca enviar un mensaje que AFIRME que la cita queda reservada
            // sin haberla persistido. Si ninguna rama anterior guardó la cita pero el texto
            // del LLM dice que reservó, intentamos guardar con el mejor hueco; si no se puede,
            // reemplazamos el mensaje para no mentirle a la clienta.
            if (!session.reservaConfirmada && session.slotsProposed && llmClaimsBooked(aiResponse.respuesta)) {
                const slot = (session.selectedService && (session.availableSlots || []).length)
                    ? pickChosenSlot(session, aiResponse.datos) : null;
                let ok = false;
                if (slot) {
                    logger.warn('cita_sante_red_seguridad', { orgId, telefono: userPhone, fecha: slot.fecha, hora: slot.hora });
                    ok = await finalizarCitaSante(client, session, userPhone, slot);
                }
                if (ok) {
                    aiResponse.reserva_confirmada = true;
                } else {
                    logger.warn('cita_sante_texto_sin_guardar', { orgId, telefono: userPhone, tieneServicio: !!session.selectedService, numHuecos: (session.availableSlots || []).length });
                    aiResponse.reserva_confirmada = false;
                    aiResponse.respuesta = salonRetryMsg(session.language);
                }
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
            for (const [k, v] of Object.entries(aiResponse.datos)) {
                if (v && v !== '' && v !== 'desconocido' && !k.startsWith('upselling')) {
                    const canOverwrite = k === 'nombre' || !session.partialData[k] || session.partialData[k] === 'desconocido';
                    if (canOverwrite) session.partialData[k] = v;
                }
            }
        }

        if (orgType === 'salon') {
            aiResponse.respuesta = stripMarkdown(aiResponse.respuesta);
            if (aiResponse.respuesta.length > 1000) {
                aiResponse.respuesta = aiResponse.respuesta.slice(0, 997) + '...';
            }
        }

        session.history.push({ role: 'assistant', content: aiResponse.respuesta });

        // Send response: salon sends as a single message, restaurant splits if long
        if (orgType === 'restaurant' && aiResponse.respuesta.length > 300) {
            const mid = aiResponse.respuesta.lastIndexOf(' ', Math.floor(aiResponse.respuesta.length / 2));
            const p1 = aiResponse.respuesta.substring(0, mid).trim();
            const p2 = aiResponse.respuesta.substring(mid).trim();
            if (p1) await sendWithDelay(client, userPhone, p1, orgId);
            if (p2) { await new Promise(r => setTimeout(r, 80)); await sendWithDelay(client, userPhone, p2, orgId); }
        } else {
            await sendWithDelay(client, userPhone, aiResponse.respuesta, orgId);
        }

        // Marca que ya hemos propuesto huecos a la clienta: a partir de aquí un "sí/vale"
        // o una selección posicional se interpreta como aceptación del hueco.
        // Usamos availableSlots (no slotsParaLLM, que se calcula ANTES de la llamada al
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
        logger.error('process_message_error', { orgId, telefono: userPhone, error: err.message });
        incrementMetric('fallbacksUsed');
        try { await sendWithDelay(client, userPhone, config.conversation?.technicalErrorMessage || 'Lo siento, ha habido un error. Inténtalo de nuevo.', orgId); } catch {}
    }
}

// ─── Handler principal ────────────────────────────────────────────────────────
async function handleIncomingMessage(client, message, orgId) {
    try {
        if (!message) return;
        const messageKey = getMessageKey(message);
        if (!message.from || message.from.includes('@g.us') || message.isStatus || message.isBroadcast) return;

        const userPhone = message.from;
        const sKey = sessionKey(orgId, userPhone);
        if (messageKey) {
            const s = userSessions.get(sKey);
            if (s?.seenMessages?.has(messageKey)) return;
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
                await sendWithDelay(client, userPhone, 'No pude escuchar el audio 😅 ¿Puedes escribirme lo que necesitas?', orgId);
                return;
            }
        }

        if (!userText) {
            if (message.hasMedia) {
                await sendWithDelay(client, userPhone, 'Gracias por tu mensaje 😊 Solo proceso texto y audios. Si tienes alguna duda, escríbeme.', orgId);
            }
            return;
        }

        const messageId = messageKey || Date.now().toString();
        latestMessages.set(sKey, { message, userText, messageId, timestamp: Date.now() });

        saveMessage(orgId, { telefono: userPhone.replace('@c.us', '').replace(/\D/g, ''), contenido: userText, direccion: 'entrante' }).catch(() => {});

        const currentQueue = userQueues.get(sKey) || Promise.resolve();
        const newQueue = currentQueue.then(async () => {
            const latest = latestMessages.get(sKey);
            if (!latest || latest.messageId !== messageId) return;
            try { await processMessageCore(client, message, userPhone, userText, messageKey, orgId); } catch (e) { logger.error('error_cola', { telefono: userPhone, error: e.message }); }
        }).catch(e => logger.error('error_cola_catch', { error: e.message }));

        userQueues.set(sKey, newQueue);
        newQueue.finally(() => {
            setTimeout(() => {
                if (userQueues.get(sKey) === newQueue) {
                    userQueues.delete(sKey);
                    latestMessages.delete(sKey);
                }
            }, QUEUE_TTL_MS);
        });
    } catch (err) {
        logger.error('error_incoming_message', { error: err.message });
    }
}

// ─── GC ───────────────────────────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [key, session] of userSessions.entries()) {
        if (now - session.lastUpdate > GC_INTERVAL_MS * 2) {
            const [orgId, phone] = key.includes(':') ? key.split(':') : [null, key];
            persistSession(orgId, phone || key, session);
            userSessions.delete(key);
        }
    }
}, GC_INTERVAL_MS);

setInterval(() => {
    for (const session of userSessions.values()) session.seenMessages?.cleanup?.();
}, GC_INTERVAL_MS / 2);

setInterval(() => {
    const now = Date.now();
    for (const [key, session] of userSessions.entries()) {
        if (session.reservaConfirmada || session.leadGuardado || !session.botActivo) continue;
        if (now - session.lastUpdate > ABANDON_THRESHOLD_MS && session.history.filter(m => m.role === 'user').length >= 2) {
            incrementMetric('conversationDropped');
            const [orgId] = key.includes(':') ? key.split(':') : [null];
            if (session.partialData.telefono) {
                saveLead(orgId, { ...session.partialData, estado_cita: 'abandonado', leadId: session.leadId }).catch(() => {});
                session.leadStatus = 'abandoned';
                const phone = key.includes(':') ? key.split(':')[1] : key;
                persistSession(orgId, phone, session);
            }
        }
    }
}, 60000);

function setConversationBotMode(phone, active) {
    const userPhone = phone.includes('@c.us') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
    // Search across all orgs
    for (const [key, session] of userSessions.entries()) {
        if (key.endsWith(userPhone) || key.endsWith(phone)) {
            session.botActivo = active;
        }
    }
}

module.exports = {
    handleIncomingMessage,
    isBotGlobalActivo,
    setBotGlobalActivo,
    setConversationBotMode,
    setWAClient,
    resolveBizumResult,
    // Exportados para tests unitarios (lógica pura de selección/confirmación de huecos):
    _internals: { parseSlotSelection, normalizeHora, resolveSalonConfirmation, llmClaimsBooked },
};
