// La GUARDA DE CITA VIVA: una SEGUNDA cita solo se escribe pedida o preguntada.
//
// Gemelo determinista del caso Ihab (16/08/2026): reservó a las 13:38, y a las 16:26 —tras
// 2 h 45 min de silencio, o sea con la sesión rehidratada y reservaConfirmada de vuelta a
// false (no se persiste, y NO debe persistirse: restaurarlo desarma cinco de las seis
// redes del salón)— un "❤️🥰" entró por el camino de confirmación y nació una cita real
// para 11 días después que nadie pidió. Aquí se congela ese estado post-rehidratación con
// sus mensajes reales y se afirma que la guarda de finalizarCitaSante RETIENE la reserva,
// pregunta, y solo un «sí» la escribe.
//
// Visto fallar sin lo que protege (sabotajes con cp previo a scratchpad, rojos MEDIDOS
// el 17/08/2026):
//   · S1 quitar la llamada a la guarda en finalizarCitaSante → los CUATRO bloques e2e en
//     rojo (caso Ihab, «no», «ni sí ni no», «lectura fallida»): la cita se escribe;
//   · S2 invertir el default del fallo de lectura (reservar en el catch) → rojo «lectura
//     fallida» (bookAppointment=1 con la BD rota);
//   · S3 marker siempre true (autorizar sin petición) → los cuatro e2e en rojo (la
//     guarda queda exenta para todo el mundo);
//   · S4 no manejar el sentinel en el call site del reload dirigido → los cuatro e2e en
//     rojo (a la clienta le llega salonRetryMsg — «no he podido fijar ese hueco» — en
//     vez de la pregunta, y la reserva retenida muere sin pregunta que responder).
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');

// ─── Stubs ANTES de requerir bot (patrón de escalera-agenda.test.js) ─────────
const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/supabase', {});

// Estado controlable por caso. OJO: bot.js DESESTRUCTURA las funciones de db al cargar,
// así que reemplazar dbImpls.X después no le llega — todo lo variable lee de `state`.
const state = {
    upcoming: [],           // lo que devuelve getUpcomingAppointments (citas vivas)
    upcomingThrows: false,  // lectura rota
    bookCalls: 0,           // INSERTs reales en la agenda
    contact: undefined,     // se fija abajo (la ficha que devuelve findByPhone; null = sin ficha)
};
const CITA_IHAB = {
    id: 'apt-1', service: 'Reconstrucción K18 + lavar y peinar',
    starts_at: '2026-08-17T13:00:00.000Z', ends_at: '2026-08-17T14:00:00.000Z',
    status: 'confirmed', stylist_id: 'sty-nat', stylists: { name: 'Natalia' },
};
const SERVICIO = { nombre: 'Reconstrucción K18 + lavar y peinar', precio: 60, duracion_min: 60, categoria: 'Reconstrucción' };
const SLOT_27 = { fecha: '2026-08-27', hora: '15:00', stylistId: 'sty-nat', stylistName: 'Natalia', texto: 'a las 15:00 el jueves 27 de agosto con Natalia' };

state.contact = { id: 'ct-ihab', full_name: 'Ihab', wa_phone: '4790768781' };
const dbImpls = {
    findByPhone: async () => state.contact,
    saveLead: async () => 'ct-ihab',
    saveMessage: async () => 1,
    getUpcomingAppointments: async () => {
        if (state.upcomingThrows) throw new Error('lectura rota (test)');
        return state.upcoming;
    },
    getAppointmentsByLead: async () => [],
    getStylistsByOrg: async () => [],
    getAllStylistSchedules: async () => [],
    getScheduleBlocks: async () => [],
    getBlockedDays: async () => [],
    findContactIdsByPhone: async () => [],
    getAgentConfig: async () => ({ services: [SERVICIO], business_hours: null, business_info: {} }),
};
stub('../services/db', new Proxy(dbImpls, { get: (t, k) => t[k] ?? (async () => null) }));

// El motor de huecos: solo existe el hueco del 27/08 y solo si se pregunta POR ese día
// (así la recarga genérica de la rehidratación vuelve vacía y el turno cae en el reload
// DIRIGIDO — el camino exacto del caso real).
stub('../services/calendar-sante', {
    getAvailableSlots: async (_orgId, opts) =>
        (opts?.preferencia?.fecha === '2026-08-27' ? [{ ...SLOT_27 }] : []),
    bookAppointment: async () => { state.bookCalls++; return { success: true, appointmentId: 'apt-nueva' }; },
    rescheduleAppointment: async () => ({ success: true, appointmentId: 'apt-1' }),
    cancelAppointment: async () => ({ success: true }),
});

stub('../services/telegram', {
    notifyBizumPending: async () => {}, notifyEscalation: async () => {},
    notifyBlacklistAlert: async () => {}, startTelegramBot: () => {},
});

// SQLite en RAM con la MISMA forma que services/memory.js: la rehidratación del test es
// la de producción (persistSession → loadClient), no una imitación.
const sqlite = new Map();
stub('../services/memory', {
    loadClient: (orgId, phone) => sqlite.get(`${orgId}:${phone}`) || null,
    saveClient: (orgId, phone, session) => {
        sqlite.set(`${orgId}:${phone}`, {
            partialData: JSON.parse(JSON.stringify(session.partialData || {})),
            history: (session.history || []).slice(),
            summary: session.summary || null,
            extra: session.extra ? JSON.parse(JSON.stringify(session.extra)) : null,
            leadGuardado: !!session.leadGuardado,
            leadStatus: session.leadStatus || 'in_progress',
            botActivo: session.botActivo !== false,
            messageCount: session.messageCount || 0,
            variant: null, firstSeen: Date.now(), lastSeen: Date.now(),
            totalMessages: (session.history || []).length,
        });
    },
    saveSummary: () => {}, deleteClient: () => {}, isReturningClient: () => false,
});

const contadores = {};
stub('../services/metrics', {
    incrementMetric: (k, n = 1) => { contadores[k] = (contadores[k] || 0) + n; },
});

const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

// LLM por cola (mismo contrato que escalera-agenda).
const openai = require('../services/providers/openai');
let llmCalls = 0;
const llmQueue = [];
openai.getChatbotResponse = async () => {
    llmCalls++;
    const item = llmQueue.length ? llmQueue.shift() : 'Ok 😊';
    const base = {
        respuesta: null, reserva_confirmada: false, cita_confirmada: false,
        slot_rechazado: false, accion: null, idioma_detectado: null,
        datos: { nombre: null, servicio: null, fecha_cita: null, hora_cita: null },
    };
    return (typeof item === 'string') ? { ...base, respuesta: item } : { ...base, ...item };
};
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const I = bot._internals;
const helpers = require('../services/helpers');
const { SANTE_ORG_ID } = require('../services/org-registry');
const ORG = SANTE_ORG_ID;
bot.setBotActivo(ORG, true, false);

const makeClient = sink => ({
    sendMessage: async (_p, text) => { sink.push(text); return { id: { _serialized: `wamid.T${sink.length}` } }; },
    getChatById: async () => ({ sendStateTyping: async () => {} }),
});

let seq = 0;
async function turno(phone, sink, texto) {
    // La guarda anti-duplicado de process core (1,5 s) descartaría el segundo turno de un
    // mismo test: aquí los turnos son deliberados, así que se le quita el reloj de encima.
    const viva = I.getSession(ORG, phone);
    if (viva) viva.lastMessageTime = 0;
    await bot.handleIncomingMessage(makeClient(sink), {
        from: phone, body: texto, id: { _serialized: `wamid.SEG${Date.now()}_${seq++}` },
        fromMe: false, timestamp: Date.now(), isStatus: false, isBroadcast: false,
        hasMedia: false, type: 'chat',
        getChat: async () => ({ sendStateTyping: async () => {} }),
        getContact: async () => ({ number: phone.replace(/\D/g, '') }),
    }, ORG);
    await I.flushBuffer(ORG, phone);
    await new Promise(r => setTimeout(r, 400));
}

// El estado post-reserva de Ihab, CONGELADO tal y como quedó a las 13:40 del 16/08 — con
// lastUpdate envejecido más allá del SESSION_TIMEOUT de 1 h para que el siguiente turno
// pase por la rehidratación REAL (persistSession → loadClient → restore → reconciliar).
function armarSesionIhabPostReserva() {
    const phone = `479076${String(1000 + seq++).slice(-4)}@c.us`;
    const session = I.createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    session.leadId = 'ct-ihab';
    session.language = 'es';
    session.languageSource = 'observed';
    session.selectedService = { ...SERVICIO };
    session.reservaConfirmada = true;                       // NO viaja a SQLite: se perderá
    session.appointmentId = 'apt-1';
    session.bookedSlots = ['2026-08-17|15:00|sty-nat'];     // SÍ viaja: otro hueco no lo pisa
    session.slotsProposed = true;
    session.partialData.nombre = 'Ihab';
    session.partialData.telefono = phone.replace(/\D/g, '');
    // ≥2 turnos de asistente: sin ellos, el restore descarta el extra por incoherente.
    session.history = [
        { role: 'user', content: 'Tienes cita libre mañana a las 14-15 h? Para lavar.' },
        { role: 'assistant', content: 'Perfecto, te apunto lavar y peinar. ¿Te va bien a las 15:00?' },
        { role: 'user', content: 'Si, perfecto. Muchas gracias. Nos vemos mañana.' },
        { role: 'assistant', content: '¡Nos vemos! 😊' },
    ];
    session.lastUpdate = Date.now() - 3700000;              // > SESSION_TIMEOUT (1 h)
    I.userSessions.set(I.sessionKey(ORG, phone), session);
    return { phone, session };
}

const PREGUNTA_ES = helpers.buildPreguntaSegundaCitaMsg({
    citaExistente: { servicio: CITA_IHAB.service, fecha: '2026-08-17', hora: '15:00', estilista: 'Natalia' },
    language: 'es',
});
const PREGUNTA_FALLO_ES = helpers.buildPreguntaSegundaCitaMsg({ citaExistente: null, language: 'es' });

// El aiResponse del turno "❤️🥰": el modelo da la reserva por confirmada con una fecha
// que nadie propuso — la lectura real del 16/08.
const LLM_CONFIRMA_27 = {
    respuesta: '¡Genial! 😊',
    reserva_confirmada: true,
    datos: { nombre: null, servicio: null, fecha_cita: '2026-08-27', hora_cita: '15:00' },
};

// ─── 1 · El caso Ihab, congelado ─────────────────────────────────────────────

test('caso Ihab: "❤️🥰" tras rehidratación NO escribe una segunda cita — la retiene y pregunta', async () => {
    state.upcoming = [CITA_IHAB]; state.upcomingThrows = false; state.bookCalls = 0; llmQueue.length = 0;
    const { phone } = armarSesionIhabPostReserva();
    const sink = [];
    llmQueue.push(LLM_CONFIRMA_27);
    await turno(phone, sink, '❤️🥰');

    assert.strictEqual(state.bookCalls, 0, `se escribió una cita que nadie pidió: ${state.bookCalls} INSERT(s)`);
    assert.strictEqual(sink[sink.length - 1], PREGUNTA_ES,
        `lo enviado no es la pregunta de la guarda: ${sink[sink.length - 1]}`);
    const s = I.getSession(ORG, phone);
    assert.ok(s.pendingSegundaCita, 'la reserva retenida tiene que quedar en pendingSegundaCita');
    assert.strictEqual(s.pendingSegundaCita.slot.fecha, '2026-08-27');
    assert.strictEqual(s.pendingSegundaCita.citaExistente.servicio, CITA_IHAB.service);
    assert.strictEqual(s.reservaConfirmada, false, 'retener no puede afirmar reserva');
    const ev = logs.filter(l => l.evento === 'cita_sante_segunda_retenida').pop();
    assert.strictEqual(ev?.motivo, 'cita_viva');
    assert.ok(contadores.segundaCitaRetenida >= 1, 'el contador de metrics tiene que subir');

    // ── 2 · Un «sí» autoriza y ESA reserva sí se escribe (la vía legítima no se bloquea) ──
    llmQueue.length = 0;
    await turno(phone, sink, 'sí');
    assert.strictEqual(state.bookCalls, 1, 'el «sí» tiene que escribir exactamente UNA cita');
    assert.ok(/✅/.test(sink[sink.length - 1]),
        `tras el «sí» tiene que salir la confirmación real: ${sink[sink.length - 1]}`);
    const s2 = I.getSession(ORG, phone);
    assert.strictEqual(s2.pendingSegundaCita, null);
    assert.strictEqual(s2.segundaReservaAutorizada, false, 'la autorización se gasta al usarse');
});

test('un «no» a la pregunta suelta la reserva con acuse que nombra la cita existente', async () => {
    state.upcoming = [CITA_IHAB]; state.upcomingThrows = false; state.bookCalls = 0; llmQueue.length = 0;
    const { phone } = armarSesionIhabPostReserva();
    const sink = [];
    llmQueue.push(LLM_CONFIRMA_27);
    await turno(phone, sink, '❤️🥰');
    assert.strictEqual(sink[sink.length - 1], PREGUNTA_ES);

    await turno(phone, sink, 'no');
    assert.strictEqual(state.bookCalls, 0);
    const acuse = helpers.buildSegundaCitaNoMsg({
        citaExistente: { servicio: CITA_IHAB.service, fecha: '2026-08-17', hora: '15:00', estilista: 'Natalia' },
        language: 'es',
    });
    assert.strictEqual(sink[sink.length - 1], acuse);
    assert.ok(/jueves|lunes|martes|miercoles|miércoles|viernes|sabado|sábado|domingo/i.test(acuse),
        'el acuse SÍ nombra el día (sale por _send, sin redes por medio)');
    assert.strictEqual(I.getSession(ORG, phone).pendingSegundaCita, null);
});

test('ni sí ni no: la pregunta muere en silencio, sin bucle y sin reservar', async () => {
    state.upcoming = [CITA_IHAB]; state.upcomingThrows = false; state.bookCalls = 0; llmQueue.length = 0;
    const { phone } = armarSesionIhabPostReserva();
    const sink = [];
    llmQueue.push(LLM_CONFIRMA_27);
    await turno(phone, sink, '❤️🥰');
    assert.strictEqual(sink[sink.length - 1], PREGUNTA_ES);

    llmQueue.push('Claro, cuéntame 😊');
    await turno(phone, sink, '¿a qué hora cerráis?');
    assert.strictEqual(state.bookCalls, 0);
    assert.strictEqual(I.getSession(ORG, phone).pendingSegundaCita, null, 'la pregunta no se rearma');
    assert.notStrictEqual(sink[sink.length - 1], PREGUNTA_ES, 'no se repite la pregunta');
});

// ─── 3 · Lectura de Supabase rota: ante la duda NO se reserva, se pregunta ───

test('lectura fallida: el default es retener y preguntar, nunca reservar a ciegas', async () => {
    state.upcoming = []; state.upcomingThrows = true; state.bookCalls = 0; llmQueue.length = 0;
    const { phone } = armarSesionIhabPostReserva();
    const sink = [];
    llmQueue.push(LLM_CONFIRMA_27);
    await turno(phone, sink, '❤️🥰');

    assert.strictEqual(state.bookCalls, 0, 'con la BD rota no se escribe NADA');
    assert.strictEqual(sink[sink.length - 1], PREGUNTA_FALLO_ES,
        `la variante honesta de «no he podido comprobarlo»: ${sink[sink.length - 1]}`);
    const ev = logs.filter(l => l.evento === 'cita_sante_segunda_retenida').pop();
    assert.strictEqual(ev?.motivo, 'lectura_fallida');
    state.upcomingThrows = false;
});

// ─── 4 · Exenciones: lo pedido explícitamente y el reagendado no preguntan ───

test('resetForSecondBooking es quien autoriza: el camino explícito no paga pregunta', async () => {
    const { session } = (() => {
        const phone = `346000${String(1000 + seq++).slice(-4)}@c.us`;
        const s = I.createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
        return { session: s };
    })();
    assert.strictEqual(session.segundaReservaAutorizada, false);
    I.resetForSecondBooking(session, 'quiero otra cita, un masaje');
    assert.strictEqual(session.segundaReservaAutorizada, true,
        'resetForSecondBooking (la puerta ÚNICA de la 2ª explícita) tiene que autorizar');

    // Autorizada, la guarda ni siquiera lee la BD (upcomingThrows la tumbaría).
    state.upcomingThrows = true;
    session.orgType = 'salon'; session.leadId = 'ct-ihab';
    const res = await I.evaluarSegundaCitaAntesDeReservar(ORG, session, { ...SLOT_27 }, 'test');
    assert.strictEqual(res, null, 'con autorización explícita se reserva sin pregunta ni lectura');
    state.upcomingThrows = false;
});

test('reagendar es un UPDATE in-place: la guarda no dispara ni lee', async () => {
    const phone = `346000${String(1000 + seq++).slice(-4)}@c.us`;
    const session = I.createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    session.orgType = 'salon'; session.leadId = 'ct-ihab';
    session.modoReagendamiento = true;
    state.upcomingThrows = true;
    const res = await I.evaluarSegundaCitaAntesDeReservar(ORG, session, { ...SLOT_27 }, 'test');
    assert.strictEqual(res, null);
    state.upcomingThrows = false;
});

test('San Remo no pasa por aquí, y una clienta sin ficha (leadId irresoluble) tampoco', async () => {
    const phone = `346000${String(1000 + seq++).slice(-4)}@c.us`;
    const restaurante = I.createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    restaurante.orgType = 'restaurant';
    assert.strictEqual(await I.evaluarSegundaCitaAntesDeReservar(ORG, restaurante, { ...SLOT_27 }, 'test'), null);

    // Sin contacto resoluble no hay citas previas posibles: clienta nueva, se reserva.
    const nueva = I.createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    nueva.orgType = 'salon'; nueva.leadId = null;
    state.contact = null;   // findByPhone lee de state: swap efectivo pese al destructure
    state.upcoming = [CITA_IHAB];
    assert.strictEqual(await I.evaluarSegundaCitaAntesDeReservar(ORG, nueva, { ...SLOT_27 }, 'test'), null);
    state.contact = { id: 'ct-ihab', full_name: 'Ihab', wa_phone: '4790768781' };
});

// ─── 5 · Regla 12: la pregunta es INERTE para las redes que corren tras la sustitución ─

test('la pregunta, en los 4 idiomas y las 2 variantes, no la condena ninguna red', () => {
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        for (const citaExistente of [
            { servicio: CITA_IHAB.service, fecha: '2026-08-17', hora: '15:00', estilista: 'Natalia' },
            null,
        ]) {
            const msg = helpers.buildPreguntaSegundaCitaMsg({ citaExistente, language: lang });
            assert.ok(msg && msg.length > 20, `${lang}: variante vacía`);
            assert.ok(/[?？]/.test(msg), `${lang}: tiene que terminar preguntando`);
            // availableSlots VACÍO (lo normal tras rehidratar): cualquier HH:MM la mataría.
            assert.strictEqual(I.respondsWithInventedSlots(msg, [], null), false,
                `${lang}: respondsWithInventedSlots se come la pregunta: ${msg}`);
            // Y sin exención de citasVivas (lecturas rotas): cualquier fecha la mataría.
            assert.strictEqual(I.respondsWithInventedDates(msg, [], { citasVivas: [] }), false,
                `${lang}: respondsWithInventedDates se come la pregunta: ${msg}`);
            // Y si afirmara reserva, la red final intentaría reservar sobre nuestra pregunta.
            assert.strictEqual(I.llmClaimsBooked(msg), false,
                `${lang}: la pregunta afirma una reserva: ${msg}`);
        }
    }
});

test('el acuse del «no» nombra la cita con el cuándo de formatReminderWhen (un solo sitio para el día)', () => {
    const cita = { servicio: 'Manicura', fecha: '2026-08-20', hora: '11:30', estilista: 'Olga' };
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        const acuse = helpers.buildSegundaCitaNoMsg({ citaExistente: cita, language: lang });
        const cuando = helpers.formatSlotTexto(cita.fecha, cita.hora, lang, cita.estilista);
        assert.ok(acuse.includes(cuando),
            `${lang}: el acuse no contiene el texto de formatSlotTexto — dos tablas de días: ${acuse}`);
    }
    // Fecha ilegible: el acuse se degrada al servicio, no revienta ni inventa (regla 3).
    const roto = helpers.buildSegundaCitaNoMsg({
        citaExistente: { servicio: 'Manicura', fecha: 'no-es-fecha', hora: '11:30', estilista: null },
        language: 'es',
    });
    assert.ok(roto.includes('Manicura') && !roto.includes('no-es-fecha'));
});
