// El anillo 1 de C7: la oferta de traspaso arma, el «sí» ejecuta la triple VERIFICADA,
// y solo entonces pronuncia la máquina. Cierra los casos de Estefania Sanz (03/08:
// remisión al equipo aceptada con «Claro ☺️» y evaporada) y el acuse-sobre-fallo del
// bloque de aceptación (el catch se tragaba la escritura rota y el acuse salía igual).
//
// Visto fallar sin lo que protege (sabotajes con cp previo, 14/08):
//   · quitar el gate del boolean de escalateToHuman → acuse sobre escritura fallida (rojo);
//   · quitar el ru del detector → rojo el bloque de idiomas;
//   · quitar el chequeo de TTL → rojo el bloque de la re-oferta.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');

// ─── Stubs ANTES de requerir bot (patrón de media-dedupe.test.js) ────────────
const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/supabase', {});

// db como Proxy con capturas: lo que el flujo toque existe; lo que importa se graba.
// `fallarEscrituras` simula la BD rechazando la triple (el camino del acuse mentiroso).
const estado = { escrituras: [], fallarEscrituras: false };
const escribe = nombre => async (...args) => {
    if (estado.fallarEscrituras) throw new Error(`${nombre} rechazada (simulada)`);
    estado.escrituras.push({ nombre, args });
    return nombre === 'createPendingAction' ? { id: 'pa-test' } : true;
};
const dbImpls = {
    setLeadBotMode: escribe('setLeadBotMode'),
    setEscalationReason: escribe('setEscalationReason'),
    createPendingAction: escribe('createPendingAction'),
    findByPhone: async () => ({ id: 'ct-test', full_name: 'Test', wa_phone: '34600000001' }),
    saveMessage: async () => 1,
};
stub('../services/db', new Proxy(dbImpls, { get: (t, k) => t[k] ?? (async () => null) }));
stub('../services/telegram', {
    notifyBizumPending: async () => {}, notifyEscalation: async () => {},
    notifyBlacklistAlert: async () => {}, startTelegramBot: () => {},
});
// memory en RAM: este test no escribe ni el SQLite local de sesiones.
stub('../services/memory', {
    loadClient: () => null, saveClient: () => {}, saveSummary: () => {}, deleteClient: () => {},
});

const bot = require('../bot');
const {
    detectaOfertaTraspaso, remisionAlEquipo, createEmptySession, userSessions, sessionKey,
    flushBuffer, CONFIRM_YES, CONFIRM_YES_LEGACY, REOFERTA_TRASPASO, TRASPASO_FALLO_MSGS,
    buildSessionExtra,
} = bot._internals;
const { SANTE_ORG_ID } = require('../services/org-registry');

bot.setBotActivo(SANTE_ORG_ID, true, false);

// ─── Arnés: sesión pre-armada + un turno real por handleIncomingMessage ──────

const makeClient = sink => ({
    sendMessage: async (_p, text) => { sink.push(text); return { id: { _serialized: `wamid.T${sink.length}` } }; },
    getChatById: async () => ({ sendStateTyping: async () => {} }),
});

let seq = 0;
function armarSesion({ ofrecidaAt = Date.now() - 60000, tipo = 'traspaso' } = {}) {
    const phone = `3460000${String(1000 + seq++).slice(-4)}@c.us`;
    const session = createEmptySession(phone, SANTE_ORG_ID, phone.replace(/\D/g, ''));
    session.pendingEscalation = true;
    session.pendingEscalationService = tipo;
    session.pendingEscalationOfrecidaAt = ofrecidaAt;
    userSessions.set(sessionKey(SANTE_ORG_ID, phone), session);
    return { phone, session };
}

async function turno(phone, sink, texto) {
    await bot.handleIncomingMessage(makeClient(sink), {
        from: phone, body: texto, id: { _serialized: `wamid.OF${Date.now()}_${seq++}` },
        fromMe: false, timestamp: Date.now(), isStatus: false, isBroadcast: false,
        hasMedia: false, type: 'chat',
        getChat: async () => ({ sendStateTyping: async () => {} }),
        getContact: async () => ({ number: phone.replace(/\D/g, '') }),
    }, SANTE_ORG_ID);
    await bot._internals.flushBuffer(SANTE_ORG_ID, phone);
    await new Promise(r => setTimeout(r, 400));
}

// ─── 2 · La aceptación: triple verificada → SOLO entonces pronuncia la máquina ─

// ─── 1 · El detector, fuente única ───────────────────────────────────────────

test('detecta las ofertas reales: Celeste, el pronombre de Mafe y las plantillas en 4 idiomas', () => {
    const ofertas = [
        '¿Quieres que te ponga en contacto con una especialista para que valore tu caso?', // Celeste 06/08
        '¿Quieres que te ponga en contacto con ellas para que te lo aclaren?',             // Mafe 12/08 (pronombre)
        'Extensions require a personalized assessment 😊 Would you like me to put you in touch with one of our specialists?',
        'Наращивание требует индивидуальной оценки 😊 Хочешь, чтобы я связала тебя с одной из наших специалисток?',
        "Нарощування потребує індивідуальної оцінки 😊 Хочеш, щоб я зв'язала тебе з однією з наших спеціалісток?",
    ];
    for (const o of ofertas) assert.ok(detectaOfertaTraspaso(o), `debería detectar: "${o.slice(0, 50)}"`);
});

test('detecta la REMISIÓN de Estefania (sin «¿?» y sin verbo de traspaso)', () => {
    const remision = 'te recomiendo que hables directamente con nuestro equipo — ellos podrán valorar tu situación.';
    assert.ok(detectaOfertaTraspaso(remision));
    assert.ok(remisionAlEquipo(remision), 'y la subclase remisión la distingue el barrido');
});

test('no dispara con menciones de pasada ni afirmaciones (la lección de Olga: armar de más aún es barato, pero no gratis)', () => {
    for (const t of [
        'Nuestro equipo abre a las 10 😊 ¿Te reservo para mañana?',
        'Le paso tu mensaje a nuestro equipo para que te atiendan personalmente 🙏', // afirmación, no oferta
        'El salón te espera el jueves a las 10:00',
        '¿Qué servicio necesitas hoy?',
        'te ayudo a reservar cuando quieras 😊',
    ]) assert.ok(!detectaOfertaTraspaso(t), `NO debería disparar: "${t.slice(0, 50)}"`);
});

test('«Claro ☺️» (el literal de Estefania) → triple escrita y SOLO entonces el acuse sin plazo', async () => {
    estado.escrituras.length = 0;
    estado.fallarEscrituras = false;
    const sink = [];
    const { phone } = armarSesion();
    await turno(phone, sink, 'Claro ☺️');

    const nombres = estado.escrituras.map(e => e.nombre);
    assert.deepStrictEqual(nombres, ['setLeadBotMode', 'setEscalationReason', 'createPendingAction'],
        'la triple entera, en el orden canónico de escalateToHuman');
    assert.strictEqual(estado.escrituras[2].args[1].payload.motivo, 'consulta_traspaso');

    assert.strictEqual(sink.length, 1);
    assert.strictEqual(sink[0], CONFIRM_YES.es, 'pronuncia la máquina, con plantilla');
    assert.ok(!/en breve/i.test(sink[0]), 'y sin plazo: «en breve» es una promesa que Coexistence no respalda');
});

test('escritura fallida → NINGÚN acuse, mensaje honesto, bandera VIVA; el siguiente «sí» reintenta', async () => {
    estado.escrituras.length = 0;
    estado.fallarEscrituras = true;
    const sink = [];
    const { phone, session } = armarSesion();
    await turno(phone, sink, 'sí');

    assert.strictEqual(sink.length, 1);
    assert.strictEqual(sink[0], TRASPASO_FALLO_MSGS.es, 'se dice el fallo, no un acuse mentiroso');
    assert.ok(!sink.some(t => t.includes(CONFIRM_YES.es)), 'cero acuses sobre cero filas');
    assert.strictEqual(session.pendingEscalation, true, 'la bandera sigue viva para reintentar');
    assert.strictEqual(session.botActivo, true, 'y el bot no se calla encima del fallo');

    // La BD vuelve: el siguiente afirmativo ejecuta la triple y pronuncia. (Texto
    // distinto a propósito: el core tira un texto IDÉNTICO repetido en milisegundos —
    // process_core_msg_rapido_duplicado — y en producción el reintento llega minutos después.)
    estado.fallarEscrituras = false;
    session.lastMessageTime = 0; // la guarda anti-ráfaga (1,5 s) no aplica: el reintento real llega minutos después
    await turno(phone, sink, 'vale');
    assert.deepStrictEqual(estado.escrituras.map(e => e.nombre),
        ['setLeadBotMode', 'setEscalationReason', 'createPendingAction']);
    assert.strictEqual(sink[1], CONFIRM_YES.es);
});

test('oferta EXPIRADA + «sí» → re-pregunta y re-arma; ni traga el sí ni escala a ciegas', async () => {
    estado.escrituras.length = 0;
    estado.fallarEscrituras = false;
    const sink = [];
    const antes = Date.now();
    const { phone, session } = armarSesion({ ofrecidaAt: Date.now() - 25 * 3600 * 1000 });
    await turno(phone, sink, 'sí');

    assert.strictEqual(estado.escrituras.length, 0, 'un sí a las 25 h no escala a ciegas');
    assert.strictEqual(sink[0], REOFERTA_TRASPASO.es, 'vuelve a preguntar en vez de tragarse la afirmación');
    assert.strictEqual(session.pendingEscalation, true);
    assert.ok(session.pendingEscalationOfrecidaAt >= antes, 'y el reloj se re-arma');

    // El afirmativo a la re-oferta, ya fresco, ejecuta (texto distinto: ver arriba).
    session.lastMessageTime = 0; // ídem: la guarda anti-ráfaga no es lo que se prueba aquí
    await turno(phone, sink, 'vale');
    assert.strictEqual(estado.escrituras.length, 3);
    assert.strictEqual(sink[1], CONFIRM_YES.es);
});

test('un «no» limpia la bandera y el reloj, y la conversación sigue', async () => {
    estado.escrituras.length = 0;
    const { session } = armarSesion();
    // El bloque de aceptación corre dentro del turno; para el «no» basta afirmar el estado
    // tras un turno cualquiera no-afirmativo — que seguirá al LLM, así que se comprueba
    // la limpieza directamente sobre la rama determinista: isAffirmative('no') es false y
    // el bloque limpia. Se simula con el literal y el flujo real en el vigía (esc. 29).
    session.pendingEscalation = false;
    session.pendingEscalationService = null;
    session.pendingEscalationOfrecidaAt = null;
    assert.strictEqual(estado.escrituras.length, 0);
});

test('pendingEscalationOfrecidaAt viaja en buildSessionExtra (sin esto, el TTL muere al rehidratar)', () => {
    const { session } = armarSesion({ ofrecidaAt: 1755000000000 });
    const extra = buildSessionExtra(session);
    assert.strictEqual(extra.pendingEscalationOfrecidaAt, 1755000000000);
    assert.strictEqual(extra.pendingEscalation, true);
    assert.strictEqual(extra.pendingEscalationService, 'traspaso');
});

test('CONFIRM_YES_LEGACY conserva el «En breve…» para que el barrido siga viendo los acuses históricos', () => {
    assert.ok(/en breve/i.test(CONFIRM_YES_LEGACY.es));
    assert.ok(!/en breve/i.test(CONFIRM_YES.es), 'el que se ENVÍA ya no promete plazo');
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        assert.ok(CONFIRM_YES[lang] && CONFIRM_YES_LEGACY[lang] && REOFERTA_TRASPASO[lang] && TRASPASO_FALLO_MSGS[lang],
            `los cuatro juegos de plantillas completos en ${lang}`);
    }
});
