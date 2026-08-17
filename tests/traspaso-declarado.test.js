// El ANILLO 2 de C7: el modelo DECLARA la oferta (`ofrezco_traspaso`) y la máquina la arma,
// en vez de adivinarla de su prosa. Gemelo determinista: LLM por cola, Supabase/Telegram
// inertes, cero red (patrón de puerta-nombre-no-come-turno + el recorder de oferta-traspaso).
//
// Medido el 17/08/2026 sobre los 337 salientes del bot de Sante: de los CUATRO casos reales
// del caso 7, UNO llegó a tener fila. Y el que la tuvo (Mafe, 12/08) fue porque el modelo
// DESOBEDECIÓ la regla crítica del prompt y puso accion:escalar_humano en el turno de la
// pregunta, cayendo en la red de bot.js. Obedeciendo, armar dependía de que su prosa casara
// con detectaOfertaTraspaso — y la frase que el propio prompt le sugería NO casaba.
//
// Las TRES frases reales van congeladas byte a byte, de `messages`:
//   · Esther Cediloo   08/08 20:05  en  — «I'm not sure I have that information…», sin oferta
//   · Gisvell G·Perez  12/08 14:12  es  — «…en contacto CON EL EQUIPO…», que no armaba
//   · 34699866837      17/08 16:36  es  — «…¿Reservamos tu cita primero?», media frase del
//                                          caso 7 y, en lugar de la oferta, un empujón a vender
//
// Afirma ESTADO y no redacción: pendingEscalation, pendingEscalationService, el ARRAY de
// escrituras en su orden canónico, payload.motivo y llmCalls. Los textos solo se comparan
// contra plantillas exportadas (CONFIRM_YES) o contra el coda, que sale de su constante.
//
// Visto fallar sin lo que protege (sabotajes con cp previo, rojos MEDIDOS el 18/08/2026):
//   · quitar el pegado del CODA → 2 rojos («AYER» y «ESTHER»): la espera se arma pero la
//     clienta no ve ninguna pregunta, así que su «sí» no llega nunca. Es el caso de ayer;
//   · quitar el guard `!isAffirmative` del trinquete → 1 rojo («TRINQUETE»): el «sí» del
//     turno N+1 se convierte en OTRA espera y la fila no se escribe jamás;
//   · quitar la validación de conjunto cerrado → 1 rojo («motivo inventado»): arma con un
//     motivo cualquiera y la ficha queda con un `consulta_<basura>` sin etiqueta;
//   · quitar `con el equipo` de HANDOVER_DESTINO → 1 rojo («GISVELL»): la frase real del
//     12/08 vuelve a no armar nada;
//   · quitar el borrado de turno de `_ofertaDeclarada` → 1 rojo («no se hereda»).
//
// Ese último tuvo que ganarse: en la primera medición dio CERO rojos porque el bloque de
// armado borraba la bandera él mismo y el barrido de banderas de turno no llegaba a hacer
// nada en el camino normal. Un test que pasa con y sin la guarda no protege esa guarda
// (regla 2), así que la vida de la bandera se dejó en UN solo dueño —el barrido— y entonces
// el sabotaje sí muerde. La guarda ya existía; lo que no existía era poder verla fallar.

process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const assert = require('assert');

const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/supabase', {});

const SERVICIO = { nombre: 'Mujer y secado', categoria: 'Cortes', precio: 40, duracion_min: 45 };
const CATALOGO = [SERVICIO];

stub('../services/calendar-sante', {
    getAvailableSlots: async () => [],
    bookAppointment: async () => ({ success: true, appointmentId: 'apt-1' }),
    rescheduleAppointment: async () => ({ success: true, appointmentId: 'apt-r' }),
    cancelAppointment: async () => ({ success: true }),
    formatSlotForMessage: s => `${s.fecha} ${s.hora}`,
});

// El recorder de escrituras (patrón de oferta-traspaso): lo que el flujo toque existe, lo que
// importa se graba. La TRIPLE de escalateToHuman son tres llamadas seguidas y su ORDEN es
// parte del contrato — si una se cae, el acuse no debe salir.
const estado = { escrituras: [], fallarEscrituras: false };
const escribe = nombre => async (...args) => {
    if (estado.fallarEscrituras) throw new Error(`${nombre} rechazada (simulada)`);
    estado.escrituras.push({ nombre, args });
    return nombre === 'createPendingAction' ? { id: 'pa-test' } : true;
};
const dbImpls = {
    findByPhone: async () => ({ id: 'ct-test', full_name: 'Clienta', wa_phone: '34600000000', bot_mode: 'auto' }),
    saveMessage: async () => 1,
    saveLead: async () => 'ct-test',
    updateLead: async () => true,
    getUpcomingAppointments: async () => [],
    hasActiveAppointmentForSlot: async () => false,
    getAppointmentsByLead: async () => [],
    getStylistsByOrg: async () => [],
    getAllStylistSchedules: async () => [],
    getScheduleBlocks: async () => [],
    getBlockedDays: async () => [],
    findContactIdsByPhone: async () => [],
    setLeadBotMode: escribe('setLeadBotMode'),
    setEscalationReason: escribe('setEscalationReason'),
    createPendingAction: escribe('createPendingAction'),
    getAgentConfig: async () => ({
        services: CATALOGO,
        business_hours: {
            lunes: { apertura: '10:00', cierre: '19:00' }, martes: { apertura: '10:00', cierre: '19:00' },
            miercoles: { apertura: '10:00', cierre: '19:00' }, jueves: { apertura: '10:00', cierre: '19:00' },
            viernes: { apertura: '10:00', cierre: '19:00' }, sabado: { apertura: '10:00', cierre: '19:00' },
        },
        business_info: {},
    }),
};
stub('../services/db', new Proxy(dbImpls, { get: (t, k) => t[k] ?? (async () => null) }));
stub('../services/telegram', {
    notifyBizumPending: async () => {}, notifyEscalation: async () => {},
    notifyBlacklistAlert: async () => {}, startTelegramBot: () => {},
});
stub('../services/memory', { loadClient: () => null, saveClient: () => {}, saveSummary: () => {}, deleteClient: () => {} });
const contadores = {};
stub('../services/metrics', { incrementMetric: (k, n = 1) => { contadores[k] = (contadores[k] || 0) + n; } });

const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

const openai = require('../services/providers/openai');
let llmCalls = 0;
const llmQueue = [];
openai.getChatbotResponse = async () => {
    llmCalls++;
    const item = llmQueue.length ? llmQueue.shift() : 'Ok 😊';
    const val = (typeof item === 'function') ? await item() : item;
    const base = {
        respuesta: null, reserva_confirmada: false, cita_confirmada: false,
        slot_rechazado: false, accion: null, motivo_escalado: null,
        ofrezco_traspaso: null, idioma_detectado: null,
        datos: { nombre: null, servicio: null, fecha_cita: null, hora_cita: null },
    };
    return (typeof val === 'string') ? { ...base, respuesta: val } : { ...base, ...val };
};
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const I = bot._internals;
const { createEmptySession, userSessions, sessionKey, CONFIRM_YES, detectaOfertaTraspaso } = I;
const { SANTE_ORG_ID } = require('../services/org-registry');
const ORG = SANTE_ORG_ID;
bot.setBotActivo(ORG, true, false);

// Las TRES frases reales, congeladas de `messages`.
const ESTHER = "I'm not sure I have that information, Esther 😊 But I'd love to help you leave that review! Could you describe what service she did for you? That way I can make sure we credit the right person.";
const GISVELL = 'No me consta cuál fue la última que te hiciste 😊 ¿Quieres que te ponga en contacto con el equipo para que lo confirmen, o me dices ahora qué tipo prefieres?';
const AYER = 'Eso no lo tengo yo, pero el equipo te lo confirma en el salón 😊 ¿Reservamos tu cita primero?';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const makeClient = sink => ({
    sendMessage: async (_p, text) => { sink.push(text); return { id: { _serialized: `wamid.T${sink.length}` } }; },
    getChatById: async () => ({ sendStateTyping: async () => {} }),
});

let seq = 0;
function armarSesion(over = {}) {
    const phone = `346000${String(1000 + seq++).slice(-4)}@c.us`;
    const session = createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    session.orgType = 'salon';
    session.leadId = 'ct-test';
    session.language = 'es';
    session.nombreGuardado = true;
    session.partialData = { ...session.partialData, nombre: 'Clienta', telefono: phone.replace(/\D/g, '') };
    session.spaPromoOffered = true;
    Object.assign(session, over);
    userSessions.set(sessionKey(ORG, phone), session);
    return { phone, session };
}

async function turno(phone, sink, texto) {
    const s = userSessions.get(sessionKey(ORG, phone));
    if (s && s.lastMessageTime) s.lastMessageTime -= 5000;
    await bot.handleIncomingMessage(makeClient(sink), {
        from: phone, body: texto, id: { _serialized: `wamid.TD${Date.now()}_${seq++}` },
        fromMe: false, timestamp: Date.now(), isStatus: false, isBroadcast: false,
        hasMedia: false, type: 'chat',
        getChat: async () => ({ sendStateTyping: async () => {} }),
        getContact: async () => ({ number: phone.replace(/\D/g, '') }),
    }, ORG);
    await I.flushBuffer(ORG, phone);
    await new Promise(r => setTimeout(r, 400));
}

function reset() {
    logs.length = 0; llmQueue.length = 0; estado.escrituras.length = 0;
    estado.fallarEscrituras = false;
    for (const k of Object.keys(contadores)) delete contadores[k];
}
const trazas = evento => logs.filter(l => l.evento === evento);
const ultimo = sink => sink[sink.length - 1] || '';
const nombresEscritos = () => estado.escrituras.map(e => e.nombre);

// ─── 1 · Declara y su prosa NO ofrece: se arma Y se le pega la pregunta ──────────────────

test('AYER (17/08) · «¿Reservamos tu cita primero?» declara → arma y PEGA la oferta', async () => {
    reset();
    const { phone, session } = armarSesion();
    const sink = [];
    llmQueue.push({ respuesta: AYER, ofrezco_traspaso: 'dato_no_disponible' });
    await turno(phone, sink, 'Pero infórmame del producto o marca que utilizáis');

    assert.strictEqual(session.pendingEscalation, true, 'la declaración no armó la espera');
    assert.strictEqual(session.pendingEscalationService, 'dato_no_disponible');
    assert.ok(session.pendingEscalationOfrecidaAt, 'sin sello de tiempo el TTL no puede medirse');
    assert.strictEqual(estado.escrituras.length, 0, 'una OFERTA no escribe nada todavía');
    assert.strictEqual(trazas('traspaso_declarado_sin_oferta_en_prosa').length, 1);
    assert.strictEqual(trazas('traspaso_declarado_sin_oferta_en_prosa')[0].respuestaOriginal, AYER,
        'la traza debe llevar la respuesta ORIGINAL, que es la prueba de la divergencia');
    assert.ok(ultimo(sink).startsWith(AYER), 'el texto del modelo se conserva entero');
    assert.ok(detectaOfertaTraspaso(ultimo(sink)),
        'tras el coda el saliente TIENE que ser una oferta reconocible: es lo que lo hace '
        + 'contable en messages y visible para el barrido de promesas');
    assert.strictEqual(contadores.traspasoDeclarado, 1);
    assert.strictEqual(contadores.traspasoDeclaradoSinOfertaEnProsa, 1);
});

test('AYER · y el «sí» del turno siguiente ESCRIBE la fila, con la triple en orden', async () => {
    reset();
    const { phone, session } = armarSesion();
    const sink = [];
    llmQueue.push({ respuesta: AYER, ofrezco_traspaso: 'dato_no_disponible' });
    await turno(phone, sink, 'Pero infórmame del producto');
    const llmTrasOferta = llmCalls;

    await turno(phone, sink, 'sí, por favor');

    assert.deepStrictEqual(nombresEscritos(),
        ['setLeadBotMode', 'setEscalationReason', 'createPendingAction'],
        'la triple entera, en el orden canónico de escalateToHuman');
    assert.strictEqual(estado.escrituras[2].args[1].payload.motivo, 'consulta_dato_no_disponible');
    assert.strictEqual(estado.escrituras[1].args[2], 'consulta_dato_no_disponible',
        'la ficha queda con la MISMA razón que la fila');
    assert.strictEqual(ultimo(sink), CONFIRM_YES.es, 'pronuncia la máquina, con plantilla');
    assert.strictEqual(session.pendingEscalation, false, 'la espera se cierra al resolverse');
    assert.strictEqual(session.botActivo, false, 'tras escalar el bot calla');
    assert.strictEqual(llmCalls, llmTrasOferta,
        'el «sí» pasó por el LLM: el gate determinista de pendingEscalation no lo interceptó');
});

test('ESTHER (08/08, en) · sin una sola palabra de oferta → coda en SU idioma', async () => {
    reset();
    const { phone, session } = armarSesion({ language: 'en' });
    const sink = [];
    llmQueue.push({ respuesta: ESTHER, ofrezco_traspaso: 'dato_no_disponible', idioma_detectado: 'en' });
    await turno(phone, sink, 'who was the other lady that washed my hair last time?');

    assert.strictEqual(session.pendingEscalation, true);
    assert.ok(ultimo(sink).includes('put you in touch'),
        `el coda debe ir en inglés, salió: "${ultimo(sink)}"`);
    assert.ok(detectaOfertaTraspaso(ultimo(sink)), 'el saliente con coda debe ser una oferta reconocible');
    assert.strictEqual(estado.escrituras.length, 0);
});

// ─── 2 · Declara y su prosa YA ofrece: se arma y NO se toca el texto ─────────────────────

test('declara Y ofrece en prosa → arma sin pegar nada (no se duplica la pregunta)', async () => {
    reset();
    const { phone, session } = armarSesion();
    const sink = [];
    const buena = 'Eso no lo tengo yo, pero lo saben en el salón 😊 ¿Quieres que te ponga en contacto con una de nuestras especialistas?';
    llmQueue.push({ respuesta: buena, ofrezco_traspaso: 'dato_no_disponible' });
    await turno(phone, sink, '¿qué producto usáis?');

    assert.strictEqual(session.pendingEscalation, true);
    assert.strictEqual(ultimo(sink), buena, 'el texto tenía que salir intacto');
    assert.strictEqual(trazas('traspaso_declarado_sin_oferta_en_prosa').length, 0);
    assert.strictEqual(contadores.traspasoDeclaradoSinOfertaEnProsa, undefined);
});

// ─── 3 · El anillo 3 sigue vivo: prosa sin declaración ───────────────────────────────────

test('GISVELL (12/08) · «con el equipo» SIN declarar → lo arma el detector de prosa', async () => {
    reset();
    const { phone, session } = armarSesion();
    const sink = [];
    llmQueue.push({ respuesta: GISVELL });   // sin ofrezco_traspaso: el modelo obediente de hoy
    await turno(phone, sink, 'La última que me hice');

    assert.strictEqual(session.pendingEscalation, true,
        '«con el equipo» tiene que armar: es la frase que costó la escalada de Gisvell');
    assert.strictEqual(session.pendingEscalationService, 'traspaso');
    assert.strictEqual(ultimo(sink), GISVELL, 'sin declaración no se pega coda');
    assert.strictEqual(contadores.traspasoProsaSinDeclaracion, 1);
    assert.strictEqual(contadores.traspasoDeclarado, undefined);
});

// ─── 4 · La desobediencia de Mafe: declara Y pone la acción ──────────────────────────────

test('declara Y accion:escalar_humano a la vez → gana la OFERTA, no se escala aún', async () => {
    reset();
    const { phone, session } = armarSesion();
    const sink = [];
    llmQueue.push({
        respuesta: AYER, ofrezco_traspaso: 'dato_no_disponible',
        accion: 'escalar_humano', motivo_escalado: 'dato_no_disponible',
    });
    await turno(phone, sink, '¿qué producto usáis?');

    assert.strictEqual(estado.escrituras.length, 0,
        'escalar en el turno de la OFERTA deja bot_mode=manual y el bot mudo ante el «sí»');
    assert.strictEqual(session.botActivo, true, 'el bot sigue vivo para poder oír el «sí»');
    assert.strictEqual(session.pendingEscalation, true);
    assert.strictEqual(trazas('traspaso_declarado_y_accion_a_la_vez').length, 1);
});

// ─── 5 · El TRINQUETE del turno N+1 ──────────────────────────────────────────────────────

test('TRINQUETE · oferta que no armó + «sí» + el modelo escala → SE ESCRIBE la fila', async () => {
    reset();
    // El turno de la oferta no armó nada (ni declaración ni prosa reconocible): es el estado
    // exacto en que quedaban Esther y la de ayer antes de este cambio.
    const { phone, session } = armarSesion();
    const sink = [];
    llmQueue.push({ respuesta: ESTHER });          // ofrece de boquilla, no arma
    await turno(phone, sink, 'who washed my hair?');
    assert.strictEqual(session.pendingEscalation, false, 'premisa: la oferta NO armó');

    // Turno N+1: ella acepta y el modelo hace lo que el prompt le manda para el turno 2.
    llmQueue.push({
        respuesta: 'Perfecto 🙏 Le paso tu mensaje al equipo.',
        accion: 'escalar_humano', motivo_escalado: 'dato_no_disponible',
    });
    await turno(phone, sink, 'yes please');

    assert.deepStrictEqual(nombresEscritos(),
        ['setLeadBotMode', 'setEscalationReason', 'createPendingAction'],
        'el «sí» tras una oferta que no armó tiene que ESCALAR, no volver a esperar');
    assert.strictEqual(estado.escrituras[2].args[1].payload.motivo, 'dato_no_disponible');
    assert.strictEqual(trazas('escalada_dato_no_disponible_tras_afirmativo_no_convertida').length, 1);
    assert.strictEqual(trazas('escalada_dato_no_disponible_a_pendiente').length, 0,
        'no puede rearmar otra espera: sería el segundo «sí» que nadie sabe que hay que dar');
});

test('y sin afirmativo la red de siempre SIGUE bajando la escalada a espera', async () => {
    reset();
    const { phone, session } = armarSesion();
    const sink = [];
    llmQueue.push({
        respuesta: 'Eso lo sabe el equipo 😊',
        accion: 'escalar_humano', motivo_escalado: 'dato_no_disponible',
    });
    await turno(phone, sink, '¿quién me atendió la última vez?');

    assert.strictEqual(estado.escrituras.length, 0, 'sin «sí» previo no se escala de golpe');
    assert.strictEqual(session.pendingEscalation, true);
    assert.strictEqual(session.pendingEscalationService, 'dato_no_disponible');
    assert.strictEqual(trazas('escalada_dato_no_disponible_a_pendiente').length, 1);
});

// ─── 6 · Conjunto cerrado ────────────────────────────────────────────────────────────────

test('un motivo inventado NO arma nada (y no escribe consulta_<basura> en la ficha)', async () => {
    reset();
    const { phone, session } = armarSesion();
    const sink = [];
    llmQueue.push({ respuesta: 'Eso lo mira el equipo 😊', ofrezco_traspaso: 'lo_que_sea' });
    await turno(phone, sink, 'una pregunta rara');

    assert.strictEqual(session.pendingEscalation, false,
        'armar con un motivo desconocido dejaría una razón que ningún mapa de etiquetas conoce');
    assert.strictEqual(trazas('traspaso_declarado_no_ofrecible').length, 1);
    assert.strictEqual(contadores.traspasoDeclarado, undefined);
});

// ─── 7 · La declaración es de TURNO ──────────────────────────────────────────────────────

test('una declaración no se hereda al turno siguiente', async () => {
    reset();
    const { phone, session } = armarSesion();
    const sink = [];
    llmQueue.push({ respuesta: AYER, ofrezco_traspaso: 'dato_no_disponible' });
    await turno(phone, sink, '¿qué producto usáis?');
    // Se resuelve con un «no», que limpia la espera.
    llmQueue.push({ respuesta: 'Sin problema 😊 ¿Qué te apetece hacerte?' });
    await turno(phone, sink, 'no, gracias');
    assert.strictEqual(session.pendingEscalation, false, 'un no cierra la espera');

    llmQueue.push({ respuesta: 'El corte con secado son 40€ 😊' });
    await turno(phone, sink, '¿cuánto vale el corte?');
    assert.strictEqual(session.pendingEscalation, false,
        'la declaración de hace dos turnos no puede rearmar sobre una respuesta que no ofrece');
    assert.strictEqual(ultimo(sink), 'El corte con secado son 40€ 😊', 'ni pegarle un coda');
});

// ─── 8 · El acuse no sale si la escritura falla ──────────────────────────────────────────

test('escritura rota tras el «sí» → ni acuse ni bandera consumida', async () => {
    reset();
    const { phone, session } = armarSesion();
    const sink = [];
    llmQueue.push({ respuesta: AYER, ofrezco_traspaso: 'dato_no_disponible' });
    await turno(phone, sink, '¿qué producto usáis?');

    estado.fallarEscrituras = true;
    await turno(phone, sink, 'sí');

    assert.notStrictEqual(ultimo(sink), CONFIRM_YES.es,
        'el acuse sobre una escritura fallida es la mentira exacta del contrato');
    assert.strictEqual(session.pendingEscalation, true,
        'la bandera SIGUE viva: el siguiente afirmativo reintenta');
    assert.strictEqual(session.botActivo, true, 'sin escalada registrada no hay motivo para callarse');
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { console.error(`fail - ${name}`); console.error('  ' + e.message); fallos++; }
    }
    if (fallos) { console.error(`\n${fallos} test(s) fallidos`); process.exit(1); }
    console.log('\nTests del anillo 2 de C7 (traspaso declarado) OK');
    process.exit(0);
})();
