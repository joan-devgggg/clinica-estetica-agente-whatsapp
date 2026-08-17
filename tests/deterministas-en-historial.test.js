// Los mensajes DETERMINISTAS del salón entran en session.history: el modelo del turno
// siguiente sabe lo que el propio bot acaba de decir. GEMELO del caso Ihab (16/08/2026,
// tests/fixtures/corpus/ihab.json, turnos 3-4): el ✅ de confirmación salió por
// finalizarReservaPendiente → _send SIN push, y en el turno siguiente el modelo reabrió
// la cita cerrada con otro servicio y otro precio («Lavar y peinar, 25€ ¿te va bien?»)
// porque para él ese ✅ nunca existió. LLM por cola CAPTURANDO el history que recibe,
// calendar-sante y Supabase stubeados, cero red (patrón de escalera-agenda.test.js).
//
// Visto fallar sin lo que protege (sabotajes con cp previo, rojos MEDIDOS el 17/08):
//   · bot.js sin el arreglo (sin _sendHist) → rojos «el ✅ queda en history» y «el turno
//     siguiente VE el ✅» — la ceguera exacta de Ihab;
//   · push ANTES del await del envío → rojo «un envío que revienta no se anota»;
//   · sin el bump de _snapshot en _sendHist → rojo «el rollback no borra lo entregado»;
//   · quitar la exención `m.det === true` de los 3 filtros (rehidratación + las dos
//     ramas pre-LLM) → rojo «det sobrevive a FALLBACK_PATTERNS», y SOLO ese;
//   · devolver la capa de citas (handleCitasExistentes / cancelarConConfirmacion) a
//     _send → rojo «cancelar: la pregunta enviada y el acuse quedan en history»;
//   · devolver el push del dispatch (bot.js, handled del LLM) al universal de antes →
//     rojo «cambiar: se anota el texto ENVIADO» (la divergencia vuelve).
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
// Holder mutable y DELEGADO: bot.js desestructura las funciones de db en el require,
// así que reasignar la propiedad después no le cambia la referencia — la delegación sí.
// Los bloques lo mueven para que la agenda diga lo que Supabase diría en ese momento.
let upcomingImpl = async () => [];
const dbImpls = {
    findByPhone: async () => ({ id: 'ct-ihab', full_name: 'Ihab', wa_phone: '34790768781' }),
    saveMessage: async () => 1,
    saveLead: async () => 'ct-ihab',
    getUpcomingAppointments: async (...a) => upcomingImpl(...a),
    getStylistsByOrg: async () => [],
    getAllStylistSchedules: async () => [],
    getScheduleBlocks: async () => [],
    getBlockedDays: async () => [],
    getAppointmentsByLead: async () => [],
    findContactIdsByPhone: async () => [],
    getAgentConfig: async () => ({ services: [], business_hours: null, business_info: {} }),
};
stub('../services/db', new Proxy(dbImpls, { get: (t, k) => t[k] ?? (async () => null) }));
// El motor de huecos se sintetiza en su frontera de módulo (como hace el arnés LLM con
// db): este gemelo prueba el HISTORIAL, no la disponibilidad.
const SLOT = (() => {
    const d = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const fecha = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { fecha, hora: '15:00', stylistId: 'st-natalia', stylistName: 'Natalia', diaNombre: 'jueves' };
})();
stub('../services/calendar-sante', {
    getAvailableSlots: async () => [SLOT],
    bookAppointment: async () => ({ success: true, appointmentId: 'apt-ihab-1' }),
    rescheduleAppointment: async () => ({ success: true, appointmentId: 'apt-ihab-1' }),
    cancelAppointment: async () => ({ success: true }),
    formatSlotForMessage: s => `${s.fecha} ${s.hora}`,
});
// Captura lo que le llegaría al admin: el aviso de escalada debe llevar el texto de la
// CLIENTA, nunca el del bot (un push mal ordenado lo cambiaría en silencio).
const escaladas = [];
stub('../services/telegram', {
    notifyBizumPending: async () => {},
    notifyEscalation: async (_orgId, contacto, mensaje, motivo) => { escaladas.push({ contacto, mensaje, motivo }); },
    notifyBlacklistAlert: async () => {}, startTelegramBot: () => {},
});
// Mutable: el bloque de rehidratación siembra aquí lo que "SQLite" devolvería.
let memoriaPersistida = null;
stub('../services/memory', {
    loadClient: () => memoriaPersistida, saveClient: () => {}, saveSummary: () => {}, deleteClient: () => {},
});
stub('../services/metrics', { incrementMetric: () => {} });
const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};
// LLM por cola que CAPTURA el history recibido: la afirmación central de este fichero
// es sobre lo que el modelo VE, no sobre lo que redacta.
const openai = require('../services/providers/openai');
let llmCalls = 0;
const llmQueue = [];
const llmHistories = [];
openai.getChatbotResponse = async (_orgId, history) => {
    llmCalls++;
    llmHistories.push((history || []).map(m => ({ ...m })));
    const item = llmQueue.length ? llmQueue.shift() : 'Ok 😊';
    const val = (typeof item === 'function') ? await item() : item;
    const base = {
        respuesta: null, reserva_confirmada: false, cita_confirmada: false,
        slot_rechazado: false, accion: null, idioma_detectado: null,
        datos: { nombre: null, servicio: null, fecha_cita: null, hora_cita: null },
    };
    return (typeof val === 'string') ? { ...base, respuesta: val } : { ...base, ...val };
};
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const I = bot._internals;
const { createEmptySession, userSessions, sessionKey } = I;
const { SANTE_ORG_ID } = require('../services/org-registry');
const ORG = SANTE_ORG_ID;

bot.setBotActivo(ORG, true, false);

const makeClient = sink => ({
    sendMessage: async (_p, text) => {
        if (sink.explota) throw new Error(`rechazo definitivo del canal (${sink.explota})`);
        sink.push(text);
        return { id: { _serialized: `wamid.T${sink.length}` } };
    },
    getChatById: async () => ({ sendStateTyping: async () => {} }),
});

let seq = 0;
const K18 = { nombre: 'Reconstrucción K18 + lavar y peinar', precio: 60, duracion_min: 60, categoria: 'Tratamientos' };
// La sesión del instante del ✅ de Ihab: servicio resuelto, reserva RETENIDA esperando
// el nombre (pendingNameForBooking) y las 2 preguntas de cierre ya gastadas — así el
// turno del nombre va directo a finalizarReservaPendiente, como fue en producción.
function armarSesionIhab() {
    const phone = `347907${String(1000 + seq++).slice(-4)}@c.us`;
    const session = createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    session.leadId = 'ct-ihab';
    session.language = 'es';
    session.selectedService = { ...K18 };
    session.pendingNameForBooking = { slot: { ...SLOT }, intentos: 1, fase: 'nombre', agotado: false };
    session.preguntasCierre = 2;
    session.spaPromoOffered = true;   // la promo no es lo que se prueba: fuera del mensaje
    userSessions.set(sessionKey(ORG, phone), session);
    return { phone, session };
}

async function turno(phone, sink, texto, org = ORG) {
    // Dos turnos del gemelo van a milisegundos; en producción van a minutos. Sin esto, la
    // guarda de duplicado rápido (bot.js:4720, ventana 1500 ms) tiraría el segundo turno.
    const s = userSessions.get(sessionKey(org, phone));
    if (s && s.lastMessageTime) s.lastMessageTime -= 5000;
    await bot.handleIncomingMessage(makeClient(sink), {
        from: phone, body: texto, id: { _serialized: `wamid.DET${Date.now()}_${seq++}` },
        fromMe: false, timestamp: Date.now(), isStatus: false, isBroadcast: false,
        hasMedia: false, type: 'chat',
        getChat: async () => ({ sendStateTyping: async () => {} }),
        getContact: async () => ({ number: phone.replace(/\D/g, '') }),
    }, org);
    await I.flushBuffer(org, phone);
    await new Promise(r => setTimeout(r, 400));
}

const ultimoAssistant = session => [...session.history].reverse().find(m => m.role === 'assistant');

// ─── 1 · El turno de Ihab: el ✅ determinista queda en history ────────────────

test('el ✅ de la puerta del nombre se envía SIN LLM y queda en history con det, ts y el orden real', async () => {
    const { phone, session } = armarSesionIhab();
    const sink = [];
    const antes = llmCalls;
    await turno(phone, sink, 'Claro, me llamo Ihab.');

    assert.strictEqual(llmCalls - antes, 0, 'el cierre de reserva es determinista puro: cero llamadas al modelo');
    const enviado = sink[sink.length - 1];
    assert.ok(/✅/.test(enviado) && /60/.test(enviado), `el ✅ con su precio no salió: ${enviado}`);
    assert.strictEqual(session.reservaConfirmada, true);

    const last = session.history[session.history.length - 1];
    assert.ok(last, 'history vacío tras el turno');
    assert.strictEqual(last.role, 'assistant', `el ✅ no quedó en history (último: ${JSON.stringify(last)})`);
    assert.strictEqual(last.content, enviado, 'lo anotado tiene que ser BYTE A BYTE lo enviado');
    assert.strictEqual(last.det, true, 'sin la marca det, isFallbackText podría comérselo al rehidratar');
    assert.ok(last.ts > 0, 'sin ts, el filtro de conversationStartedAt lo descarta del prompt');
    const previo = session.history[session.history.length - 2];
    assert.strictEqual(previo.role, 'user', 'el orden real es user → ✅');
    assert.ok(/me llamo Ihab/.test(previo.content));
});

// ─── 2 · El corazón: el turno siguiente VE el ✅ (la ceguera de Ihab) ─────────

test('el turno siguiente al ✅ llega al modelo CON el ✅ en su history, terminado en user', async () => {
    const { phone, session } = armarSesionIhab();
    const sink = [];
    await turno(phone, sink, 'Claro, me llamo Ihab.');
    const mensajeConfirmacion = sink[sink.length - 1];
    assert.ok(/✅/.test(mensajeConfirmacion), 'precondición: el ✅ salió');

    // La agenda ahora DICE que la cita existe (es lo que leería Supabase de verdad).
    const upcomingAntes = upcomingImpl;
    upcomingImpl = async () => [{
        id: 'apt-ihab-1', service: K18.nombre, status: 'confirmed',
        starts_at: `${SLOT.fecha}T13:00:00Z`, stylists: { name: 'Natalia' },
    }];
    try {
        const antes = llmCalls;
        llmQueue.push('¡Gracias a ti! 😊 Te esperamos');
        await turno(phone, sink, '❤️🥰');
        assert.strictEqual(llmCalls - antes, 1, 'el emoji es un turno normal de LLM');

        const visto = llmHistories[llmHistories.length - 1];
        assert.ok(visto.some(m => m.role === 'assistant' && m.content === mensajeConfirmacion),
            'LA CEGUERA DE IHAB: el ✅ no está en el history que recibió el modelo — puede reabrir la cita con otro precio');
        assert.strictEqual(visto[visto.length - 1].role, 'user',
            'el history del modelo no puede terminar en assistant: prefill cerrado (bot.js:2500, commit 6eb0fbc)');
        assert.strictEqual(session.reservaConfirmada, true, 'el turno del emoji no toca la reserva');
    } finally {
        upcomingImpl = upcomingAntes;
    }
});

// ─── 3 · Honestidad: lo que no salió no se anota ─────────────────────────────

test('un envío que revienta NO se anota: escribir en history algo que no salió es inventarse una conversación', async () => {
    const { phone, session } = armarSesionIhab();
    const sink = [];
    sink.explota = 'canal caído en test';   // error NO transitorio: waSendMessage lanza a la primera
    await turno(phone, sink, 'Claro, me llamo Ihab.');

    assert.ok(!session.history.some(m => m.role === 'assistant' && /✅/.test(m.content || '')),
        'el ✅ nunca llegó a la clienta y aun así quedó anotado en history');
});

// ─── 4 · El rollback del snapshot no borra lo ENTREGADO ──────────────────────

test('tras un fallo del LLM, el rollback conserva el ✅ ya entregado y descarta el turno fallido', async () => {
    const { phone, session } = armarSesionIhab();
    const sink = [];
    await turno(phone, sink, 'Claro, me llamo Ihab.');
    const mensajeConfirmacion = sink[sink.length - 1];
    assert.ok(/✅/.test(mensajeConfirmacion), 'precondición: el ✅ salió');

    llmQueue.push(() => null);   // el modelo no responde → snapshot restaurado + fallback
    await turno(phone, sink, 'cuéntame más sobre eso');

    assert.ok(logs.some(l => l.evento === 'snapshot_restaurado'), 'precondición: el rollback corrió');
    assert.ok(session.history.some(m => m.role === 'assistant' && m.content === mensajeConfirmacion),
        'el rollback se llevó por delante un mensaje que la clienta YA leyó');
    assert.ok(!session.history.some(m => /cuéntame más sobre eso/.test(m.content || '')),
        'el turno fallido se descarta entero: esa semántica no cambia');
    assert.ok(!session.history.some(m => /no he podido procesar/.test(m.content || '')),
        'el fallback sigue SIN entrar en history (exclusión deliberada, bot.js:5931)');
});

// ─── 5 · Rehidratación: det sobrevive a FALLBACK_PATTERNS; sin det se limpia ─

test('una entrada det que casa FALLBACK_PATTERNS sobrevive a la rehidratación y llega al prompt; sin det se limpia (CONTROL)', async () => {
    // Texto determinista REAL cuya cola casa un patrón (bot.js:50): sin la exención, la
    // rehidratación lo borraba de SQLite para siempre y el filtro pre-LLM lo tiraba.
    const OFERTA = 'Puedo avisar a nuestro equipo 😊 ¿Quieres que te ponga en contacto con una de nuestras especialistas?';
    const FALLBACK = 'Perdona, no he podido procesar tu mensaje. ¿Me lo repites? 😊';
    const phone = `347907${String(1000 + seq++).slice(-4)}@c.us`;   // sin sesión viva: fuerza loadClient
    const ahora = Date.now();
    memoriaPersistida = {
        history: [
            { role: 'user', content: 'hola', ts: ahora - 50000 },
            { role: 'assistant', content: OFERTA, ts: ahora - 49000, det: true },
            { role: 'assistant', content: FALLBACK, ts: ahora - 48000 },
        ],
        partialData: { telefono: phone.replace(/\D/g, '') },
        summary: null, botActivo: true, lastSeen: ahora - 30000,
        extra: { conversationStartedAt: ahora - 60000 },
    };
    try {
        const sink = [];
        llmQueue.push('Claro, dime 😊');
        await turno(phone, sink, 'sigo aquí');
        const session = userSessions.get(sessionKey(ORG, phone));

        assert.ok(session.history.some(m => m.det === true && m.content === OFERTA),
            'la entrada det se borró al rehidratar (bot.js, filtro isFallbackText de la carga)');
        assert.ok(!session.history.some(m => m.content === FALLBACK),
            'CONTROL: el fallback real SIN det tiene que seguir limpiándose — la exención no puede ensancharse');
        const visto = llmHistories[llmHistories.length - 1];
        assert.ok(visto.some(m => m.role === 'assistant' && m.content === OFERTA),
            'la entrada det no llegó al prompt: el filtro pre-LLM se la comió');
    } finally {
        memoriaPersistida = null;
    }
});

// ─── 6 · La capa de citas: pregunta y acuse de cancelación en history ────────
// La pregunta REALMENTE enviada entra (matiz del 17/08 sobre la decisión del 14/08:
// lo que sigue fuera es la respuesta del LLM, que anuncia una cancelación no ocurrida);
// el «sí» limpio lo sigue interceptando pendingCitaAccion antes del LLM.

test('cancelar: la pregunta enviada y el acuse quedan en history, todo determinista (0 llamadas LLM)', async () => {
    const phone = `347907${String(1000 + seq++).slice(-4)}@c.us`;
    const session = createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    session.leadId = 'ct-ihab';
    session.language = 'es';
    userSessions.set(sessionKey(ORG, phone), session);

    const upcomingAntes = upcomingImpl;
    upcomingImpl = async () => [{
        id: 'apt-c1', service: 'Manicura', status: 'confirmed',
        starts_at: `${SLOT.fecha}T08:00:00Z`, stylists: { name: 'Olga' },
    }];
    try {
        const sink = [];
        const antes = llmCalls;
        await turno(phone, sink, 'Quiero cancelar mi cita');
        const pregunta = sink[sink.length - 1];
        assert.ok(session.pendingCitaAccion?.estado === 'confirmar', `la capa determinista no recitó la cita: ${pregunta}`);
        let last = session.history[session.history.length - 1];
        assert.strictEqual(last.content, pregunta, 'la PREGUNTA de cancelación enviada no quedó en history');
        assert.strictEqual(last.det, true);

        await turno(phone, sink, 'sí');
        const acuse = sink[sink.length - 1];
        assert.ok(/cancelada ✅/.test(acuse), `el «sí» no ejecutó la cancelación: ${acuse}`);
        last = session.history[session.history.length - 1];
        assert.strictEqual(last.content, acuse, 'el ACUSE de cancelación no quedó en history');
        assert.strictEqual(session.history[session.history.length - 2].role, 'user', 'el orden real es sí → acuse');
        assert.strictEqual(llmCalls - antes, 0, 'cancelar es determinista puro: cero llamadas al modelo');
    } finally {
        upcomingImpl = upcomingAntes;
    }
});

// ─── 7 · Escalada y reagendar: el historial dice lo que SALIÓ ────────────────

test('cambiar (señal del LLM): se anota el texto ENVIADO, no aiResponse.respuesta', async () => {
    const phone = `347907${String(1000 + seq++).slice(-4)}@c.us`;
    const session = createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    session.leadId = 'ct-ihab';
    session.language = 'es';
    session.appointmentId = 'apt-r1';   // sin él, la señal 'cambiar' del LLM se descarta (bot.js:6048)
    userSessions.set(sessionKey(ORG, phone), session);

    const sink = [];
    const DIVERGENTE = 'Este texto del modelo NO sale por el canal';
    llmQueue.push({ respuesta: DIVERGENTE, accion: 'cambiar' });
    await turno(phone, sink, 'cuéntame más sobre eso');

    const enviado = sink[sink.length - 1];
    assert.ok(/nueva cita/.test(enviado), `no salió la pregunta de reagendado: ${enviado}`);
    const last = session.history[session.history.length - 1];
    assert.strictEqual(last.content, enviado, 'el historial tiene que decir lo que SALIÓ');
    assert.strictEqual(last.det, true);
    assert.ok(!session.history.some(m => m.content === DIVERGENTE),
        'aiResponse.respuesta entró en history: el modelo recordaría haber dicho algo que la clienta nunca leyó');
});

test('la oferta de especialista y el acuse del «sí» quedan en history; Telegram recibe el texto de la CLIENTA', async () => {
    const phone = `347907${String(1000 + seq++).slice(-4)}@c.us`;
    const session = createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    session.leadId = 'ct-ihab';
    session.language = 'es';
    userSessions.set(sessionKey(ORG, phone), session);

    const sink = [];
    const antes = llmCalls;
    await turno(phone, sink, '¿Hacéis extensiones de pelo?');
    const oferta = sink[sink.length - 1];
    assert.strictEqual(session.pendingEscalation, true, `la consulta no armó la oferta: ${oferta}`);
    let last = session.history[session.history.length - 1];
    assert.strictEqual(last.content, oferta, 'la oferta de especialista (CONSULTA_ASK) no quedó en history');
    assert.strictEqual(last.det, true, 'sin det, este texto casa FALLBACK_PATTERNS y se borraría al rehidratar');

    await turno(phone, sink, 'sí');
    const acuse = sink[sink.length - 1];
    assert.ok(/Le paso tu mensaje/.test(acuse), `el «sí» no produjo el acuse: ${acuse}`);
    last = session.history[session.history.length - 1];
    assert.strictEqual(last.content, acuse, 'el acuse del traspaso no quedó en history');
    assert.strictEqual(llmCalls - antes, 0, 'consulta → oferta → sí es determinista puro');

    const ultima = escaladas[escaladas.length - 1];
    assert.ok(ultima, 'no llegó ninguna escalada a Telegram');
    assert.strictEqual(ultima.mensaje, 'sí', 'el admin tiene que ver el texto de la CLIENTA, no el del bot');
});

test('GUARDIA San Remo: el dispatch sigue pusheando aiResponse.respuesta, byte a byte como siempre', async () => {
    const { SANREMO_ORG_ID } = require('../services/org-registry');
    bot.setBotActivo(SANREMO_ORG_ID, true, false);
    const phone = `346674${String(1000 + seq++).slice(-4)}@c.us`;
    const session = createEmptySession(phone, SANREMO_ORG_ID, phone.replace(/\D/g, ''));
    session.appointmentId = 'apt-sr1';
    userSessions.set(sessionKey(SANREMO_ORG_ID, phone), session);

    const sink = [];
    const RESPUESTA_MODELO = 'Texto del modelo para el restaurante';
    llmQueue.push({ respuesta: RESPUESTA_MODELO, accion: 'cambiar' });
    await turno(phone, sink, 'cuéntame más sobre eso', SANREMO_ORG_ID);

    assert.ok(/comida o cena/.test(sink[sink.length - 1]), `no salió el mensaje de reagendado de San Remo: ${sink[sink.length - 1]}`);
    const last = session.history[session.history.length - 1];
    assert.strictEqual(last.content, RESPUESTA_MODELO,
        'San Remo tiene que conservar su push de aiResponse.respuesta EXACTO (regla de oro), aunque sea divergente');
    assert.ok(!last.det, 'la marca det es del salón: San Remo no cambia ni un byte');
});
