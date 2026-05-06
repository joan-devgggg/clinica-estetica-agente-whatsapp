require('dotenv').config();
const { getChatbotResponse } = require('./services/ai');
const { guardarLeadEnAirtable, updateLeadInAirtable, findByPhone } = require('./services/db');
const { getAvailableSlots, bookAppointment, cancelAppointment, formatSlotForMessage } = require('./services/calendar');
const { detectIntent, getMissingFields, extractQuickData } = require('./services/helpers');
const { incrementMetric } = require('./services/metrics');
const { transcribeAudio } = require('./services/transcription');
const { loadClient, saveClient, saveSummary } = require('./services/memory');
const { summarizeHistory } = require('./services/providers/openai');
const config = require('./config.json');

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
const SUMMARY_THRESHOLD = 20; // Mensajes antes de comprimir historial

let _botGlobalActivo = true;
function isBotGlobalActivo() {
    const { getConfigValue } = require('./services/db');
    const dbVal = getConfigValue('bot_activo');
    if (dbVal !== null) return dbVal !== false;
    return _botGlobalActivo;
}
function setBotGlobalActivo(v) {
    _botGlobalActivo = v;
    const { setConfigValue } = require('./services/db');
    setConfigValue('bot_activo', v);
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
function createEmptySession(userId) {
    const telefono = userId.replace('@c.us', '').replace(/\D/g, '');
    return {
        history: [],
        summary: null,
        lastUpdate: Date.now(),
        lastMessageTime: 0,
        messageCount: 0,
        botActivo: true,
        partialData: { telefono },
        followUps: [],
        seenMessages: new TTLMessageDedupe(DEDUPE_TTL_MS),
        citaConfirmada: false,
        appointmentId: null,
        availableSlots: [],
        currentSlotIndex: 0,
        leadGuardado: false,
        airtableRecordId: null,
        leadStatus: 'in_progress',
        modoReagendamiento: false,
        clienteRecurrente: false,
        ultimaVisita: null,
        startTime: Date.now(),
        _summarizing: false,
        pendingNewBooking: null, // null | { nombre, tratamiento, fecha_cita, hora_cita, esMismaPersona }
    };
}

function isLeadComplete(session) {
    if (!session?.partialData) return false;
    const d = session.partialData;
    return !!(d.nombre && d.telefono && d.tratamiento && session.citaConfirmada);
}

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

async function sendWithDelay(client, phone, text) {
    if (!text?.trim()) return;
    const delay = Math.min(text.length * MESSAGE_DELAY_MS_PER_CHAR, MESSAGE_DELAY_MAX_MS);
    try {
        await (await client.getChatById(phone)).sendStateTyping();
        if (delay > 100) await new Promise(r => setTimeout(r, delay));
        await client.sendMessage(phone, text);
    } catch {
        await client.sendMessage(phone, text);
    }
}

function clearFollowUps(session) {
    if (session?.followUps) { session.followUps.forEach(id => clearTimeout(id)); session.followUps = []; }
}

// ─── Slots de calendario ──────────────────────────────────────────────────────
async function loadAvailableSlots(session) {
    const pref = session.partialData.preferencia_horaria || {};
    const servicios = config.servicios || [];
    const svc = servicios.find(s => s.nombre?.toLowerCase() === session.partialData.tratamiento?.toLowerCase());
    const duracion = svc?.duracion || 60;
    try {
        const slots = await getAvailableSlots(pref, duracion);
        session.availableSlots = slots;
        session.currentSlotIndex = 0;
    } catch (e) {
        console.error('Error cargando slots:', e.message);
        session.availableSlots = [];
    }
}

function buildConfirmationMessage(session) {
    const { nombre, tratamiento, fecha_cita, hora_cita } = session.partialData;
    const dir = config.direccion ? `\n📍 ${config.direccion}` : '';
    return `¡Perfecto${nombre ? `, ${nombre}` : ''}! 🎉 Cita confirmada:\n` +
        `• ${tratamiento}\n• ${fecha_cita} a las ${hora_cita}${dir}\n\n` +
        `Si necesitas cambiarla escríbenos aquí 😊`;
}

// ─── Persistencia SQLite ──────────────────────────────────────────────────────
function persistSession(userPhone, session) {
    try { saveClient(userPhone, session); } catch (e) { console.error('SQLite save error:', e.message); }
}

function triggerAsyncSummary(userPhone, session) {
    if (session._summarizing || session.history.length <= SUMMARY_THRESHOLD) return;
    session._summarizing = true;
    const toSummarize = session.history.slice(0, -10);
    summarizeHistory(toSummarize, session.partialData)
        .then(summary => {
            if (summary) {
                session.summary = summary;
                session.history = session.history.slice(-10);
                saveSummary(userPhone, summary);
                persistSession(userPhone, session);
                console.log(`📝 Historial comprimido para ${userPhone}`);
            }
        })
        .catch(e => console.error('Error generando resumen:', e.message))
        .finally(() => { session._summarizing = false; });
}

// ─── Acciones de cita ─────────────────────────────────────────────────────────
async function handleAppointmentAction(client, session, userPhone, accion) {
    if (accion === 'cancelar') {
        if (session.appointmentId) await cancelAppointment(session.appointmentId);
        session.citaConfirmada = false;
        session.appointmentId = null;
        await updateLeadInAirtable({ ...session.partialData, estado_cita: 'cancelado', airtableRecordId: session.airtableRecordId });
        await sendWithDelay(client, userPhone, 'Tu cita ha sido cancelada ✅ Si quieres reservar otra, dímelo cuando quieras 😊');
        return true;
    }
    if (accion === 'cambiar') {
        session.citaConfirmada = false;
        session.appointmentId = null;
        session.availableSlots = [];
        session.currentSlotIndex = 0;
        session.modoReagendamiento = true;
        delete session.partialData.preferencia_horaria;
        delete session.partialData.fecha_cita;
        delete session.partialData.hora_cita;
        await sendWithDelay(client, userPhone, 'Sin problema 😊 ¿Qué horario te vendría mejor? (mañana o tarde, esta semana o la siguiente)');
        return true;
    }
    return false;
}

// ─── Core ─────────────────────────────────────────────────────────────────────
async function processMessageCore(client, message, userPhone, userText, messageKey) {
    try {
        if (!isBotGlobalActivo()) return;

        const existingSession = userSessions.get(userPhone);
        let isNewSession = false;
        let loadedFromSQLite = false;

        if (!existingSession) {
            const persisted = loadClient(userPhone);
            const newSession = createEmptySession(userPhone);

            if (persisted) {
                loadedFromSQLite = true;
                newSession.history = persisted.history || [];
                newSession.summary = persisted.summary || null;
                newSession.botActivo = persisted.botActivo;

                if (persisted.leadGuardado) {
                    const estadoCita = persisted.partialData?.estado_cita;
                    if (estadoCita === 'confirmado') {
                        // Tiene cita activa → restaurar modo post-cita
                        const { telefono } = newSession.partialData;
                        newSession.partialData = { telefono, ...persisted.partialData };
                        newSession.leadGuardado = true;
                        newSession.citaConfirmada = true;
                        newSession.appointmentId = persisted.partialData?.appointment_id || null;
                        newSession.leadStatus = 'completed';
                    } else {
                        // Cita completada/cancelada → cliente recurrente que vuelve
                        newSession.clienteRecurrente = true;
                        newSession.ultimaVisita = persisted.partialData?.fecha_cita || null;
                        if (persisted.partialData?.nombre) newSession.partialData.nombre = persisted.partialData.nombre;
                        if (persisted.partialData?.tratamiento) newSession.partialData.ultimoTratamiento = persisted.partialData.tratamiento;
                    }
                } else {
                    // Sesión en curso interrumpida (reinicio del bot) → restaurar estado completo
                    const { telefono } = newSession.partialData;
                    newSession.partialData = { telefono, ...persisted.partialData };
                    newSession.leadGuardado = persisted.leadGuardado;
                    newSession.messageCount = persisted.messageCount;
                    newSession.citaConfirmada = persisted.partialData?.estado_cita === 'confirmado';
                    newSession.appointmentId = persisted.partialData?.appointment_id || null;
                    if (newSession.citaConfirmada) newSession.leadStatus = 'completed';
                }
            }

            userSessions.set(userPhone, newSession);
            incrementMetric('conversationStarted');
            isNewSession = true;
        } else if (Date.now() - existingSession.lastUpdate > SESSION_TIMEOUT) {
            persistSession(userPhone, existingSession);
            const prev = existingSession;
            userSessions.set(userPhone, createEmptySession(userPhone));
            userSessions.get(userPhone).botActivo = prev.botActivo;
            isNewSession = true;
        }

        // Consulta Airtable solo si el cliente NO está en SQLite (primera vez absoluta)
        const returningCustomerPromise = (isNewSession && !loadedFromSQLite)
            ? findByPhone(userSessions.get(userPhone).partialData.telefono).catch(e => {
                console.error('Error comprobando cliente recurrente:', e.message);
                return null;
            })
            : null;

        const session = userSessions.get(userPhone);
        if (!session) return;

        if (messageKey && session.seenMessages.has(messageKey)) return;
        if (messageKey) session.seenMessages.add(messageKey);

        const textLower = userText.toLowerCase().trim();
        if (textLower === 'stop') {
            session.botActivo = false;
            await sendWithDelay(client, userPhone, config.conversation?.deactivatedMessage || 'Asistente desactivado.');
            return;
        }
        if (textLower === 'start') {
            session.botActivo = true;
            await sendWithDelay(client, userPhone, config.conversation?.reactivatedMessage || 'Asistente activado.');
            return;
        }
        if (!session.botActivo) return;

        const now = Date.now();
        if (session.lastMessageTime && (now - session.lastMessageTime) < (config.conversation?.duplicateMessageWindowMs || 1500)) return;

        session.messageCount++;
        const maxMsg = config.conversation?.maxMessagesPerSession || 30;
        if (session.messageCount > maxMsg) {
            if (session.messageCount === maxMsg + 1) {
                await sendWithDelay(client, userPhone, config.conversation?.limitMessage);
                session.botActivo = false;
            }
            return;
        }

        session.lastMessageTime = now;
        session.lastUpdate = now;
        const sanitized = sanitizeUserMessage(userText);
        if (!sanitized) return;

        clearFollowUps(session);
        session.history.push({ role: 'user', content: sanitized });
        incrementMetric('userReplied');

        try { await (await client.getChatById(userPhone)).sendStateTyping(); } catch {}

        const prevData = { ...session.partialData };
        session.partialData = extractQuickData(sanitized, session.partialData);
        const intent = detectIntent(sanitized);

        // Detectar inicio de nueva cita cuando ya hay una confirmada
        if (session.citaConfirmada && session.pendingNewBooking === null) {
            const paraOtraPersona = /\b(para\s+(mi\s+)?(hermana|hermano|padre|madre|mamá|papá|mama|papa|amigo|amiga|novia|novio|marido|mujer|pareja|hijo|hija)|para\s+(él|ella|el\s+))\b/i.test(sanitized);
            const quiereOtraCita = /\b(otra\s+cita|nueva\s+cita|quiero\s+otra|también\s+quiero|tambi[eé]n\s+quiero|otra\s+para\s+m[íi])\b/i.test(sanitized);
            if (paraOtraPersona || quiereOtraCita) {
                const esMismaPersona = !paraOtraPersona;
                session.pendingNewBooking = {
                    nombre: esMismaPersona ? (session.partialData.nombre || null) : null,
                    tratamiento: null,
                    fecha_cita: null,
                    hora_cita: null,
                    esMismaPersona
                };
                console.log(`🔄 Nueva cita iniciada para ${esMismaPersona ? 'misma persona' : 'otra persona'}`);
            }
        }

        const missingFields = getMissingFields(session.partialData);
        const tieneBase = !missingFields.includes('tratamiento') && session.partialData.telefono;
        const nuevaPref = !prevData.preferencia_horaria && session.partialData.preferencia_horaria;
        const prefCambiada = JSON.stringify(prevData.preferencia_horaria) !== JSON.stringify(session.partialData.preferencia_horaria);
        if (tieneBase && (nuevaPref || prefCambiada || (session.partialData.preferencia_horaria && session.availableSlots.length === 0))) {
            await loadAvailableSlots(session);
        }

        // Resolver cliente recurrente vía Airtable (solo si no está en SQLite)
        if (returningCustomerPromise) {
            const record = await returningCustomerPromise;
            if (record) {
                const f = record.fields;
                session.clienteRecurrente = true;
                session.ultimaVisita = f['📅 Fecha de cita'] || null;
                if (f['👤 Nombre']) session.partialData.nombre = f['👤 Nombre'];
                if (f['✨ Tratamiento']) session.partialData.ultimoTratamiento = f['✨ Tratamiento'];
            }
        }

        const slotsParaLLM = session.availableSlots.slice(session.currentSlotIndex).map(s => ({
            ...s, texto: formatSlotForMessage(s)
        }));

        const pendingNewBookingMissing = session.pendingNewBooking
            ? ['nombre', 'tratamiento', 'fecha_cita', 'hora_cita'].filter(f => !session.pendingNewBooking[f])
            : null;

        const partialDataWithCtx = {
            ...session.partialData,
            __missingFields: getMissingFields(session.partialData),
            __availableSlots: slotsParaLLM,
            __citaConfirmada: session.citaConfirmada,
            __reagendando: session.modoReagendamiento,
            __clienteRecurrente: session.clienteRecurrente,
            __ultimaVisita: session.ultimaVisita,
            __pendingNewBooking: session.pendingNewBooking,
            __pendingNewBookingMissing: pendingNewBookingMissing
        };

        let aiResponse;
        try {
            const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 9000));
            aiResponse = await Promise.race([
                getChatbotResponse(session.history.slice(-12), partialDataWithCtx, intent, session.citaConfirmada, session.summary),
                timeout
            ]);
        } catch (e) {
            console.error('LLM error:', e.message);
        }

        if (!aiResponse?.respuesta) {
            aiResponse = { respuesta: 'Se me ha ido la conexión 😅 ¿me repites?', cita_confirmada: false, slot_rechazado: false, accion: null, datos: {} };
        }

        if (aiResponse.accion && !(aiResponse.accion === 'cambiar' && session.modoReagendamiento)) {
            const handled = await handleAppointmentAction(client, session, userPhone, aiResponse.accion);
            if (handled) {
                session.history.push({ role: 'assistant', content: aiResponse.respuesta });
                persistSession(userPhone, session);
                return;
            }
        }

        if (aiResponse.slot_rechazado && !aiResponse.cita_confirmada && session.availableSlots.length > 0) {
            session.currentSlotIndex = Math.min(session.currentSlotIndex + 1, session.availableSlots.length - 1);
        }

        // Acumular datos del LLM en pendingNewBooking
        if (session.pendingNewBooking !== null && aiResponse.datos) {
            const d = aiResponse.datos;
            if (d.nombre && d.nombre !== 'desconocido') session.pendingNewBooking.nombre = d.nombre;
            if (d.tratamiento && d.tratamiento !== 'desconocido') session.pendingNewBooking.tratamiento = d.tratamiento;
            if (d.fecha_cita) session.pendingNewBooking.fecha_cita = d.fecha_cita;
            if (d.hora_cita) session.pendingNewBooking.hora_cita = d.hora_cita;
            // Si el LLM confirmó pero no incluyó fecha/hora en datos, tomarlas del slot seleccionado
            if (aiResponse.cita_confirmada && (!session.pendingNewBooking.fecha_cita || !session.pendingNewBooking.hora_cita)) {
                const slot = session.availableSlots[session.currentSlotIndex];
                if (slot) {
                    session.pendingNewBooking.fecha_cita = session.pendingNewBooking.fecha_cita || slot.fecha;
                    session.pendingNewBooking.hora_cita = session.pendingNewBooking.hora_cita || slot.hora;
                }
            }
        }

        // Validar campos obligatorios antes de confirmar — lógica separada para primera vs nueva cita
        if (aiResponse.cita_confirmada) {
            if (session.pendingNewBooking !== null) {
                // Nueva cita: los 4 campos son obligatorios
                const nb = session.pendingNewBooking;
                const faltaNombre = !nb.nombre;
                if (!nb.nombre || !nb.tratamiento || !nb.fecha_cita || !nb.hora_cita) {
                    aiResponse.cita_confirmada = false;
                    console.log(`⚠️ Nueva cita bloqueada: nombre=${nb.nombre}, tratamiento=${nb.tratamiento}, fecha=${nb.fecha_cita}, hora=${nb.hora_cita}`);
                    if (faltaNombre) aiResponse.respuesta = 'Sin el nombre no puedo reservar la cita, lo necesito para guardar el hueco 😊';
                }
            } else {
                // Primera cita: nombre y tratamiento obligatorios
                const efectiveNombre = aiResponse.datos?.nombre || session.partialData.nombre;
                const efectiveTratamiento = aiResponse.datos?.tratamiento || session.partialData.tratamiento;
                if (!efectiveNombre || !efectiveTratamiento) {
                    aiResponse.cita_confirmada = false;
                    console.log(`⚠️ Confirmación bloqueada: nombre=${efectiveNombre}, tratamiento=${efectiveTratamiento}`);
                    if (!efectiveNombre) aiResponse.respuesta = '¿Cómo te llamas? Lo necesito para reservar la cita 😊';
                }
            }
        }

        if (aiResponse.cita_confirmada && !session.citaConfirmada) {
            // Primera cita
            const slot = session.availableSlots[session.currentSlotIndex];
            if (slot) {
                try {
                    const booking = await bookAppointment(slot, session.partialData);
                    if (booking.success) {
                        session.citaConfirmada = true;
                        session.modoReagendamiento = false;
                        session.appointmentId = booking.appointmentId;
                        session.partialData.fecha_cita = slot.fecha;
                        session.partialData.hora_cita = slot.hora;
                        session.partialData.estado_cita = 'confirmado';
                        session.leadStatus = 'completed';
                        const rid1 = await guardarLeadEnAirtable({ ...session.partialData, appointment_id: booking.appointmentId, airtableRecordId: session.airtableRecordId });
                        if (rid1) session.airtableRecordId = rid1;
                        session.leadGuardado = true;
                        incrementMetric('leadsSaved');
                        aiResponse.respuesta = buildConfirmationMessage(session);
                        console.log(`✅ Cita confirmada: ${userPhone} → ${slot.fecha} ${slot.hora}`);
                    }
                } catch (e) { console.error('Error bookAppointment:', e.message); }
            } else {
                session.citaConfirmada = true;
                session.partialData.estado_cita = 'confirmado';
                session.leadStatus = 'completed';
                if (aiResponse.datos?.fecha_cita) session.partialData.fecha_cita = aiResponse.datos.fecha_cita;
                if (aiResponse.datos?.hora_cita) session.partialData.hora_cita = aiResponse.datos.hora_cita;
                try {
                    const rid2 = await guardarLeadEnAirtable({ ...session.partialData, airtableRecordId: session.airtableRecordId });
                    if (rid2) session.airtableRecordId = rid2;
                    session.leadGuardado = true;
                    incrementMetric('leadsSaved');
                    console.log(`✅ Cita confirmada (sin slot): ${userPhone}`);
                } catch (e) { console.error('Error guardando cita confirmada:', e.message); }
                aiResponse.respuesta = buildConfirmationMessage(session);
            }
        } else if (aiResponse.cita_confirmada && session.citaConfirmada && session.pendingNewBooking !== null) {
            // Nueva cita (misma o distinta persona) — todos los campos ya validados arriba
            const nb = session.pendingNewBooking;
            try {
                await guardarLeadEnAirtable({
                    telefono: session.partialData.telefono,
                    nombre: nb.nombre,
                    tratamiento: nb.tratamiento,
                    fecha_cita: nb.fecha_cita,
                    hora_cita: nb.hora_cita,
                    estado_cita: 'confirmado',
                    origen: nb.esMismaPersona ? 'nueva_cita_mismo_cliente' : 'nueva_cita_otra_persona'
                });
                session.pendingNewBooking = null;
                incrementMetric('leadsSaved');
                console.log(`✅ Nueva cita guardada: ${session.partialData.telefono} → ${nb.nombre} ${nb.fecha_cita} ${nb.hora_cita}`);
            } catch (e) { console.error('Error guardando nueva cita:', e.message); }
        }

        // Actualizar partialData — nunca sobreescribir nombre cuando hay pendingNewBooking activo
        if (aiResponse.datos) {
            for (const [k, v] of Object.entries(aiResponse.datos)) {
                if (v && v !== '' && v !== 'desconocido') {
                    if (k === 'nombre' && session.pendingNewBooking !== null) continue;
                    const canOverwrite = k === 'tratamiento' || k === 'nombre' || !session.partialData[k] || session.partialData[k] === 'desconocido';
                    if (canOverwrite) session.partialData[k] = v;
                }
            }
        }

        session.history.push({ role: 'assistant', content: aiResponse.respuesta });

        if (aiResponse.respuesta.length > 300) {
            const mid = aiResponse.respuesta.lastIndexOf(' ', Math.floor(aiResponse.respuesta.length / 2));
            const p1 = aiResponse.respuesta.substring(0, mid).trim();
            const p2 = aiResponse.respuesta.substring(mid).trim();
            if (p1) await sendWithDelay(client, userPhone, p1);
            if (p2) { await new Promise(r => setTimeout(r, 80)); await sendWithDelay(client, userPhone, p2); }
        } else {
            await sendWithDelay(client, userPhone, aiResponse.respuesta);
        }

        if (!session.leadGuardado && session.partialData.telefono && session.partialData.tratamiento) {
            guardarLeadEnAirtable({ ...session.partialData, estado_cita: 'pendiente', airtableRecordId: session.airtableRecordId })
                .then(rid => { if (rid) session.airtableRecordId = rid; })
                .catch(() => {});
        }

        // Persistir sesión en SQLite
        persistSession(userPhone, session);

        // Comprimir historial si es muy largo
        triggerAsyncSummary(userPhone, session);

        if (!session.citaConfirmada && session.messageCount >= 3 && session.botActivo) {
            const delays = config.conversation?.followUps || [];
            delays.forEach(({ delayMs, message }) => {
                const t = setTimeout(async () => {
                    const s = userSessions.get(userPhone);
                    if (!s || s.citaConfirmada || !s.botActivo) return;
                    if (Date.now() - s.lastUpdate < delayMs * 0.8) return;
                    await sendWithDelay(client, userPhone, message);
                }, delayMs);
                session.followUps.push(t);
            });
        }

    } catch (err) {
        console.error('❌ processMessageCore error:', userPhone, err.message);
        incrementMetric('fallbacksUsed');
        try { await sendWithDelay(client, userPhone, config.conversation?.technicalErrorMessage || 'Lo siento, ha habido un error. Inténtalo de nuevo.'); } catch {}
    }
}

// ─── Handler principal ────────────────────────────────────────────────────────
async function handleIncomingMessage(client, message) {
    try {
        if (!message) return;
        const messageKey = getMessageKey(message);
        if (!message.from || message.from.includes('@g.us') || message.isStatus || message.isBroadcast) return;

        const userPhone = message.from;
        if (messageKey) {
            const s = userSessions.get(userPhone);
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
                console.log(`🎙️ Audio transcrito [${userPhone}]: "${userText}"`);
            } catch (e) {
                console.error('Error transcribiendo audio:', e.message);
                await sendWithDelay(client, userPhone, 'No pude escuchar el audio 😅 ¿Puedes escribirme lo que necesitas?');
                return;
            }
        }

        if (!userText) {
            if (message.hasMedia) {
                await sendWithDelay(client, userPhone, 'Gracias por tu mensaje 😊 Solo proceso texto y audios. Si tienes alguna duda, escríbeme.');
            }
            return;
        }

        const messageId = messageKey || Date.now().toString();
        latestMessages.set(userPhone, { message, userText, messageId, timestamp: Date.now() });

        const currentQueue = userQueues.get(userPhone) || Promise.resolve();
        const newQueue = currentQueue.then(async () => {
            const latest = latestMessages.get(userPhone);
            if (!latest || latest.messageId !== messageId) return;
            try { await processMessageCore(client, message, userPhone, userText, messageKey); } catch (e) { console.error('Error cola:', e.message); }
        }).catch(e => console.error('Error cola catch:', e.message));

        userQueues.set(userPhone, newQueue);
        newQueue.finally(() => {
            setTimeout(() => {
                if (userQueues.get(userPhone) === newQueue) {
                    userQueues.delete(userPhone);
                    latestMessages.delete(userPhone);
                }
            }, QUEUE_TTL_MS);
        });
    } catch (err) {
        console.error('❌ handleIncomingMessage error:', err.message);
    }
}

// ─── Inicio proactivo desde lead de Instagram ────────────────────────────────
async function initiateLeadConversation(client, leadData) {
    const { telefono, nombre, tratamiento } = leadData;
    if (!telefono) return;

    const userPhone = `${telefono}@c.us`;
    const session = createEmptySession(userPhone);
    session.partialData = { ...session.partialData, telefono, nombre: nombre || null, tratamiento: tratamiento || null };
    userSessions.set(userPhone, session);

    const clinica = config.companyName || 'la clínica';
    const bot = config.botName || 'el asistente';

    let saludo;
    if (nombre && tratamiento) {
        saludo = `Hola ${nombre} 👋 Soy ${bot} de ${clinica}.\n\nHemos visto que te interesa ${tratamiento} ✨\n¿Tienes alguna duda o te buscamos una cita directamente?`;
    } else if (nombre) {
        saludo = `Hola ${nombre} 👋 Soy ${bot} de ${clinica}.\n\n¿En qué tratamiento estás interesado/a?`;
    } else {
        saludo = `Hola 👋 Soy ${bot} de ${clinica}.\n\n¿En qué tratamiento estás interesado/a?`;
    }

    try {
        await new Promise(r => setTimeout(r, 800));
        await sendWithDelay(client, userPhone, saludo);
        session.history.push({ role: 'assistant', content: saludo });
        incrementMetric('conversationStarted');
        console.log(`📱 Conversación iniciada con ${telefono}`);
    } catch (e) {
        console.error('Error iniciando conversación lead:', e.message);
    }
}

// ─── GC ───────────────────────────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [phone, session] of userSessions.entries()) {
        if (now - session.lastUpdate > GC_INTERVAL_MS * 2) {
            persistSession(phone, session);
            clearFollowUps(session);
            userSessions.delete(phone);
        }
    }
}, GC_INTERVAL_MS);

setInterval(() => {
    for (const session of userSessions.values()) session.seenMessages?.cleanup?.();
}, GC_INTERVAL_MS / 2);

setInterval(() => {
    const now = Date.now();
    for (const [phone, session] of userSessions.entries()) {
        if (session.citaConfirmada || session.leadGuardado || !session.botActivo) continue;
        if (now - session.lastUpdate > ABANDON_THRESHOLD_MS && session.history.filter(m => m.role === 'user').length >= 2) {
            incrementMetric('conversationDropped');
            if (session.partialData.telefono) {
                guardarLeadEnAirtable({ ...session.partialData, estado_cita: 'abandonado', airtableRecordId: session.airtableRecordId }).catch(() => {});
                session.leadStatus = 'abandoned';
                persistSession(phone, session);
            }
        }
    }
}, 60000);

module.exports = { handleIncomingMessage, initiateLeadConversation, isBotGlobalActivo, setBotGlobalActivo };
