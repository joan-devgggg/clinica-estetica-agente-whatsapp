// La ESCALERA de la clase AGENDA (contrato, punto 4): cuando una red de agenda condena
// la respuesta del LLM, el 3º peldaño la devuelve al modelo con el veredicto de la
// máquina (UNA vez) y el 4º sustituye con el mensaje de SU causa. Este es el GEMELO
// determinista: LLM por cola, Supabase/Telegram inertes, cero red. El rescate (bloque
// 10) usa el saliente REAL de Ludmila Zarahovich (03/08/2026, turno 1) como material
// sintético con estado sembrado — el mismo reparto que tests/fechas-inventadas.test.js,
// porque el estado de agenda de aquel instante no se conserva y un veredicto anclado no
// sería honesto (ver la exclusión en tests/fixtures/corpus/ludmila-zarahovich.json).
//
// Visto fallar sin lo que protege (sabotajes con cp previo, rojos MEDIDOS el 15/08):
//   · quitar filtraVeredictoRegen de la compuerta → rojos «el ECO del veredicto» y «la
//     fuga TRADUCIDA» (la jerga sale enviada);
//   · quitar los tres detectores de la compuerta → rojo «4º tras rechazo» (la reescritura
//     que sigue inventando fechas se envía tal cual);
//   · reintentar la regeneración tras un rechazo (quitar el tope de UNA vez) → CUATRO
//     rojos («4º tras rechazo» por la tercera llamada, y ECO / fuga / afirma-reserva
//     porque el reintento consume la cola y descuadra los contadores);
//   · quitar la guarda de pendientes → rojo «con texto APARCADO» (se regenera con la
//     clienta ya por delante).
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
// Presupuesto de regeneración en ms de test: SOLO cambia cuánto espera el bloque del
// timeout, no la conducta (el race y su unref son los mismos).
process.env.ESCALERA_REGEN_TIMEOUT_MS = '120';
delete process.env.ESCALERA_REGENERAR;

const assert = require('assert');
const { test } = require('node:test');

// ─── Stubs ANTES de requerir bot (patrón de oferta-traspaso.test.js) ─────────
const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/supabase', {});
const dbImpls = {
    findByPhone: async () => ({ id: 'ct-test', full_name: 'Test', wa_phone: '34600000001' }),
    saveMessage: async () => 1,
    getUpcomingAppointments: async () => [],
    getStylistsByOrg: async () => [],
    getAllStylistSchedules: async () => [],
    getScheduleBlocks: async () => [],
    getBlockedDays: async () => [],
    getAppointmentsByLead: async () => [],
    findContactIdsByPhone: async () => [],
    getAgentConfig: async () => ({ services: [], business_hours: null, business_info: {} }),
};
stub('../services/db', new Proxy(dbImpls, { get: (t, k) => t[k] ?? (async () => null) }));
stub('../services/telegram', {
    notifyBizumPending: async () => {}, notifyEscalation: async () => {},
    notifyBlacklistAlert: async () => {}, startTelegramBot: () => {},
});
stub('../services/memory', {
    loadClient: () => null, saveClient: () => {}, saveSummary: () => {}, deleteClient: () => {},
});
// Contadores de la escalera: se capturan para afirmar la telemetría, no el disco.
const contadores = {};
stub('../services/metrics', {
    incrementMetric: (k, n = 1) => { contadores[k] = (contadores[k] || 0) + n; },
});
// Logger que graba (para afirmar escalera_intervencion / escalera_regeneracion_fallida).
const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};
// LLM por cola: cada entrada es un string (la `respuesta`), un objeto parcial del
// aiResponse, o una función (para simular error / cuelgue / efectos durante la llamada).
const openai = require('../services/providers/openai');
let llmCalls = 0;
const llmQueue = [];
openai.getChatbotResponse = async () => {
    llmCalls++;
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

// ─── Arnés: sesión pre-armada + un turno real por handleIncomingMessage ──────
const makeClient = sink => ({
    sendMessage: async (_p, text) => { sink.push(text); return { id: { _serialized: `wamid.T${sink.length}` } }; },
    getChatById: async () => ({ sendStateTyping: async () => {} }),
});

let seq = 0;
const SERVICIO = { nombre: 'Manicura', precio: 25, duracion_min: 30, categoria: 'Uñas' };
function armarSesion({ language = 'es', selectedService = SERVICIO, slots = [] } = {}) {
    const phone = `346111${String(1000 + seq++).slice(-4)}@c.us`;
    const session = createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    session.leadId = 'ct-test';
    session.language = language;
    session.selectedService = selectedService;
    session.availableSlots = slots;
    userSessions.set(sessionKey(ORG, phone), session);
    return { phone, session };
}

async function turno(phone, sink, texto) {
    await bot.handleIncomingMessage(makeClient(sink), {
        from: phone, body: texto, id: { _serialized: `wamid.ESC${Date.now()}_${seq++}` },
        fromMe: false, timestamp: Date.now(), isStatus: false, isBroadcast: false,
        hasMedia: false, type: 'chat',
        getChat: async () => ({ sendStateTyping: async () => {} }),
        getContact: async () => ({ number: phone.replace(/\D/g, '') }),
    }, ORG);
    await I.flushBuffer(ORG, phone);
    await new Promise(r => setTimeout(r, 400));
}

// Texto entrante neutro: no lo intercepta ninguna capa determinista, así que el turno
// llega al LLM stubeado y de ahí al gate de redes, que es lo que se prueba.
const ENTRANTE = 'cuéntame más sobre eso';
const VIOLADORA = 'Puedo ofrecerte el 27, el 29 o el 30 de agosto. ¿Cuál te viene mejor?';
const LIMPIA = '¿Qué día o semana te viene mejor? Te miro la disponibilidad real 😊';

function ultimaIntervencion() {
    return logs.filter(l => l.evento === 'escalera_intervencion').pop();
}

// ─── 1 · Piezas puras ────────────────────────────────────────────────────────

test('el veredicto y sus marcadores salen de la MISMA fuente: cada marcador es subcadena literal del texto', () => {
    for (const red of ['respondsWithInventedSlots', 'respondsWithInventedDates']) {
        const { session } = armarSesion({ slots: [] });
        const v = I.construirVeredictoAgenda(red, session);
        for (const m of v.marcadores) {
            assert.ok(v.paraModelo.includes(m),
                `el marcador "${m}" no aparece en paraModelo — las dos listas han divergido`);
        }
    }
});

test('el veredicto con huecos reales los enumera (son el dato citable); sin huecos, prohíbe proponer', () => {
    const conSlots = armarSesion({ slots: [{ fecha: '2026-08-20', hora: '10:00', stylistName: 'Irina' }] }).session;
    const v1 = I.construirVeredictoAgenda('respondsWithInventedSlots', conSlots);
    assert.ok(/ÚNICOS huecos/.test(v1.paraModelo));
    const v2 = I.construirVeredictoAgenda('respondsWithInventedDates', armarSesion({ slots: [] }).session);
    assert.ok(/no propongas ninguna hora ni fecha/.test(v2.paraModelo));
});

test('filtraVeredictoRegen caza el centinela, la jerga y la frase REAL de Michal; deja en paz el texto limpio', () => {
    const marcadores = Object.values(I.VEREDICTO_PIEZAS);
    assert.ok(I.filtraVeredictoRegen('Vale. CORRECCIÓN INTERNA: no hay huecos', marcadores));
    assert.ok(I.filtraVeredictoRegen("I don't have the available slots loaded for that day yet", marcadores),
        'la frase que le llegó a Michal el 07/08/2026 tiene que estar vetada');
    assert.ok(I.filtraVeredictoRegen('Мне нужно проверить систему записи', marcadores));
    assert.strictEqual(I.filtraVeredictoRegen(LIMPIA, marcadores), null);
    assert.strictEqual(I.filtraVeredictoRegen('Tengo hueco el jueves a las 10:00 con Irina 😊', marcadores), null);
});

// ─── 2 · La escalera conduciendo turnos reales ───────────────────────────────

test('3º REGENERAR: la violación de fechas vuelve al modelo y se envía la reescritura limpia', async () => {
    const { phone } = armarSesion();
    const sink = [];
    const antes = llmCalls;
    llmQueue.push(VIOLADORA, LIMPIA);
    await turno(phone, sink, ENTRANTE);
    assert.strictEqual(llmCalls - antes, 2, 'la regeneración es exactamente UNA llamada más');
    assert.strictEqual(sink[sink.length - 1], LIMPIA, 'lo enviado es la reescritura, no un sustituto');
    const ev = ultimaIntervencion();
    assert.strictEqual(ev.peldano, 'regenerar');
    assert.strictEqual(ev.red, 'respondsWithInventedDates');
    assert.strictEqual(ev.respuestaOriginal, VIOLADORA, 'el evento guarda SIEMPRE la respuesta condenada');
    assert.ok(contadores.escaleraRegeneradaOk >= 1);
});

test('4º tras rechazo: si la reescritura sigue inventando, se sustituye por la causa y NUNCA hay tercera llamada', async () => {
    const { phone, session } = armarSesion();
    const sink = [];
    const antes = llmCalls;
    llmQueue.push(VIOLADORA, VIOLADORA);
    await turno(phone, sink, ENTRANTE);
    assert.strictEqual(llmCalls - antes, 2, 'UNA regeneración como máximo: no se reintenta el rechazo');
    assert.ok(!/27|29|30/.test(sink[sink.length - 1]), `las fechas inventadas llegaron a la clienta: ${sink[sink.length - 1]}`);
    const ev = ultimaIntervencion();
    assert.strictEqual(ev.peldano, 'sustituir');
    assert.strictEqual(ev.motivo, 'regen_sigue_inventando_fechas');
    assert.ok(logs.some(l => l.evento === 'escalera_regeneracion_fallida' && l.motivo === 'regen_sigue_inventando_fechas'));
    assert.strictEqual(session.reservaConfirmada, false);
});

test('el ECO del veredicto no sale jamás: ni el centinela ni ningún marcador llegan al mensaje enviado', async () => {
    const { phone, session } = armarSesion();
    const sink = [];
    llmQueue.push(VIOLADORA, () => ({ respuesta: I.construirVeredictoAgenda('respondsWithInventedDates', session).paraModelo }));
    await turno(phone, sink, ENTRANTE);
    const enviado = sink[sink.length - 1];
    assert.strictEqual(ultimaIntervencion().motivo, 'regen_cita_veredicto');
    assert.strictEqual(I.filtraVeredictoRegen(enviado, Object.values(I.VEREDICTO_PIEZAS)), null,
        `el mensaje enviado contiene jerga del veredicto: ${enviado}`);
});

test('la fuga TRADUCIDA (la frase de Michal) la para la lista de maquinaria', async () => {
    const { phone } = armarSesion();
    const sink = [];
    llmQueue.push(VIOLADORA, "Great! I don't have the available slots loaded for that day yet. What time works?");
    await turno(phone, sink, ENTRANTE);
    assert.strictEqual(ultimaIntervencion().motivo, 'regen_cita_veredicto');
    assert.ok(!/slots loaded/i.test(sink[sink.length - 1]));
});

test('una reescritura que AFIRMA reserva se rechaza: en un turno de violación de agenda no hay nada reservado', async () => {
    const { phone } = armarSesion();
    const sink = [];
    llmQueue.push(VIOLADORA, '¡Perfecto! Te la he reservado para el jueves 😊');
    await turno(phone, sink, ENTRANTE);
    assert.strictEqual(ultimaIntervencion().motivo, 'regen_afirma_reserva');
    assert.ok(!/reservado/.test(sink[sink.length - 1]));
});

test('la regeneración que FALLA cae al 4º y lo dice el log: error, fallback y timeout, sin colgarse', async () => {
    // error del proveedor
    let r = armarSesion(); let sink = [];
    llmQueue.push(VIOLADORA, () => { throw new Error('boom'); });
    await turno(r.phone, sink, ENTRANTE);
    assert.strictEqual(ultimaIntervencion().motivo, 'regen_error_proveedor');
    assert.ok(sink.length >= 1, 'aun con el error, a la clienta le llega el sustituto de la causa');

    // fallback del modelo: el genérico "Perdona…" NO puede salir por aquí
    r = armarSesion(); sink = [];
    llmQueue.push(VIOLADORA, () => ({ respuesta: 'Perdona, no he podido procesar tu mensaje. ¿Me lo repites? 😊', _isFallback: true, _fallbackReason: 'api_error:500' }));
    await turno(r.phone, sink, ENTRANTE);
    assert.strictEqual(ultimaIntervencion().motivo, 'regen_fallback:api_error:500');
    assert.ok(!/no he podido procesar/.test(sink[sink.length - 1]));
    // El contador por motivo va SANEADO: el sufijo variable tras ':' no puede fabricar
    // claves infinitas en metrics.json (Railway: los contadores son la única lectura).
    assert.ok(contadores.escaleraSustituidaPor_regen_fallback >= 1,
        'falta el contador saneado escaleraSustituidaPor_regen_fallback');
    assert.ok(!Object.keys(contadores).some(k => k.includes(':')),
        `una clave de metrics lleva ':' — el saneado del motivo se ha perdido: ${Object.keys(contadores).filter(k => k.includes(':'))}`);

    // timeout (presupuesto de test: 120 ms), el race con unref del que ya hay doctrina
    r = armarSesion(); sink = [];
    llmQueue.push(VIOLADORA, () => new Promise(() => {}));
    await turno(r.phone, sink, ENTRANTE);
    assert.strictEqual(ultimaIntervencion().motivo, 'regen_timeout');
    assert.ok(sink.length >= 1);
});

test('con texto de la clienta APARCADO no se regenera: contestaría a una foto que ella ya dejó atrás', async () => {
    const { phone } = armarSesion();
    const sink = [];
    const antes = llmCalls;
    // La clienta escribe DURANTE la primera llamada al LLM: su línea se aparca en
    // pendingTexts (bot.js), que es exactamente lo que la guarda mira.
    llmQueue.push(() => {
        const b = I.getBuffer(ORG, phone);
        b.pendingTexts = ['y otra cosa más'];
        return VIOLADORA;
    });
    await turno(phone, sink, ENTRANTE);
    assert.strictEqual(llmCalls - antes, 1, 'con pendientes NO hay segunda llamada');
    assert.strictEqual(ultimaIntervencion().motivo, 'pendientes_en_buffer');
    assert.strictEqual(ultimaIntervencion().peldano, 'sustituir');
    assert.ok(contadores.escaleraSustituidaPor_pendientes_en_buffer >= 1,
        'el contador por motivo de pendientes_en_buffer no se escribió — es EL número que se vigila en producción');
    const b = I.getBuffer(ORG, phone);
    if (b && b.timer) { clearTimeout(b.timer); b.timer = null; b.texts = []; b.pendingTexts = null; }
});

test('ESCALERA_REGENERAR=off es el rollback sin deploy: 4º directo, una sola llamada', async () => {
    process.env.ESCALERA_REGENERAR = 'off';
    try {
        const { phone } = armarSesion();
        const sink = [];
        const antes = llmCalls;
        llmQueue.push(VIOLADORA);
        await turno(phone, sink, ENTRANTE);
        assert.strictEqual(llmCalls - antes, 1);
        assert.strictEqual(ultimaIntervencion().motivo, 'regeneracion_desactivada');
    } finally {
        delete process.env.ESCALERA_REGENERAR;
    }
});

test('timing-sin-servicio va DIRECTO al 4º (política): pedir el servicio ya es la respuesta verdadera', async () => {
    const { phone } = armarSesion({ selectedService: null });
    const sink = [];
    const antes = llmCalls;
    llmQueue.push('¿Te viene bien por la mañana o por la tarde? También tengo huecos el jueves');
    await turno(phone, sink, ENTRANTE);
    assert.strictEqual(llmCalls - antes, 1, 'sin regeneración: política directa_4');
    const ev = ultimaIntervencion();
    assert.strictEqual(ev.red, 'proposesTimingWithoutService');
    assert.strictEqual(ev.motivo, 'politica_directa_4');
    assert.ok(logs.some(l => l.evento === 'cita_sante_timing_sin_servicio_bloqueado'),
        'la traza de detección de siempre no puede desaparecer: el corpus la afirma por nombre');
    assert.ok(contadores.escaleraSustituidaPor_politica_directa_4 >= 1,
        'falta el contador por motivo de politica_directa_4');
});

test('CONTROL: un turno limpio no interviene, no regenera y sale tal cual', async () => {
    const { phone } = armarSesion();
    const sink = [];
    const antes = llmCalls;
    const evAntes = logs.filter(l => l.evento === 'escalera_intervencion').length;
    llmQueue.push(LIMPIA);
    await turno(phone, sink, ENTRANTE);
    assert.strictEqual(llmCalls - antes, 1);
    assert.strictEqual(sink[sink.length - 1], LIMPIA);
    assert.strictEqual(logs.filter(l => l.evento === 'escalera_intervencion').length, evAntes,
        'la escalera intervino en un turno limpio: eso es ensanchar la detección');
});

// ─── 3 · El rescate: el caso real que hoy se pierde y el 3º salva ────────────
// Saliente REAL de producción (Ludmila Zarahovich, 03/08/2026 09:29, turno 1): saludo,
// la estilista que ELLA pidió (Veronika) y tres fechas inventadas («27, 29 или 30
// августа») que luego negó una por una. El A/B con el interruptor mide el coste de hoy
// (todo el mensaje al genérico, el hilo de Veronika perdido — el fósil del turno 2 de
// producción ES ese genérico en ruso) contra la escalera (la parte buena sobrevive y el
// humo no). La reescritura del stub es determinista a propósito: que el modelo real
// reescriba bien es estadística y le corresponde a la telemetría de producción.
const LUDMILA_T1 = 'Добрый день! 😊 К сожалению, у меня нет свободных окон на 28 августа. Ближайшие доступные дни с Вероникой — 27, 29 или 30 августа. Какой из этих дней вам подойдёт?';
const LUDMILA_REESCRITA = 'Добрый день! 😊 К сожалению, у Вероники нет свободных окон на 28 августа. Какой другой день или неделя вам подойдёт? Посмотрю реальные свободные окошки';

test('rescate (A, hoy): sin escalera el turno de Ludmila se sustituye entero y el hilo de Veronika desaparece', async () => {
    process.env.ESCALERA_REGENERAR = 'off';
    try {
        const { phone } = armarSesion({ language: 'ru' });
        const sink = [];
        llmQueue.push(LUDMILA_T1);
        await turno(phone, sink, ENTRANTE);
        const enviado = sink[sink.length - 1];
        assert.ok(!/Вероник/.test(enviado), 'A: el genérico no conserva el hilo (esto es lo que se pierde hoy)');
        assert.ok(!/27|29|30/.test(enviado));
        assert.strictEqual(ultimaIntervencion().peldano, 'sustituir');
    } finally {
        delete process.env.ESCALERA_REGENERAR;
    }
});

test('rescate (B, escalera): la reescritura conserva el saludo y a Veronika, y el humo de fechas no sale', async () => {
    const { phone } = armarSesion({ language: 'ru' });
    const sink = [];
    llmQueue.push(LUDMILA_T1, LUDMILA_REESCRITA);
    await turno(phone, sink, ENTRANTE);
    const enviado = sink[sink.length - 1];
    assert.strictEqual(ultimaIntervencion().peldano, 'regenerar');
    assert.ok(/Вероник/.test(enviado), 'B: el hilo de la estilista sobrevive');
    assert.ok(/28 августа/.test(enviado), 'B: la negación honesta de SU fecha se conserva (exención de una fecha + sin disponibilidad)');
    assert.ok(!/27|29|30/.test(enviado), 'B: las fechas inventadas no llegan');
});
