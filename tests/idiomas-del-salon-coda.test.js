// La frase de los idiomas del salón: el modelo la TRADUCE, la máquina la PEGA.
//
// Gemelo determinista del arreglo del 19/08/2026. El fichero hermano
// (`idiomas-del-salon.test.js`) afirma el PROMPT; éste afirma la maquinaria, que es donde
// está la decisión cara.
//
// POR QUÉ HAY MAQUINARIA Y NO SOLO PROMPT — medido con el arnés, cuatro corridas:
// el mismo encargo escrito como REGLA DE PROSA se colocó en tres sitios distintos (sección
// IDIOMA, cola de ESCALADA, cabecera de ESCALADA ya sin condición dentro) y las cuatro veces
// salió la MISMA respuesta byte por byte — «Bien sûr 😊 Tu veux que je te mette en contact
// avec notre équipe ?», sin una palabra sobre el idioma. Lo que el modelo SÍ obedece son los
// campos del JSON. Así que:
//
//   · el modelo DECLARA el idioma («fr») y TRADUCE la frase → `frase_idiomas_salon`;
//   · la MÁQUINA decide si esta conversación lo necesita y si ya se dijo.
//
// Y no había alternativa a que la frase la escriba él: `HANDOVER_TRASPASO` y
// `HANDOVER_DESTINO` son castellano normalizado y no ven «je te mette en contact avec notre
// équipe», así que la máquina no puede detectar sola la oferta; y no hay ninguna constante
// en francés que pegar.
//
// Visto fallar sin lo que protege (cp previo, rojos MEDIDOS el 19/08/2026, uno por sabotaje):
//   · quitar el guard `!idiomasSalonAvisado`      → 1 rojo: la frase se repite cada turno;
//   · quitar el gate `idiomaSinCodigo`            → 1 rojo: se cuela en la conversación rusa;
//   · quitar la exclusión del fallback            → 1 rojo: se pega detrás de «no he podido
//     procesar tu mensaje», y encima gasta el único aviso;
//   · quitar el saneado de la frase               → 1 rojo: saltos de línea y 400 caracteres
//     del modelo saliendo tal cual a la clienta;
//   · leer el campo AUSENTE como idioma de fuera  → 1 rojo: el 27 % de turnos en que el
//     modelo no declara idioma marcarían a media Sante como clienta de fuera.
//
// Hermético: sin red, sin LLM real, sin Supabase.
process.env.TZ = 'Europe/Madrid';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-no-se-usa';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');

const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

// ─── SDK de OpenRouter: `new OpenAI(...)` corre al cargar openai.js ─────────────────
let respuestaCruda = '{"respuesta":"hola"}';
const openaiSdkPath = require.resolve('openai');
require.cache[openaiSdkPath] = {
    id: openaiSdkPath, filename: openaiSdkPath, loaded: true,
    exports: class FakeOpenAI {
        constructor() {
            this.chat = { completions: { create: async () => ({ choices: [{ message: { content: respuestaCruda } }] }) } };
        }
    },
};

stub('../services/supabase', {});

const IDIOMAS_SALON = ['klingon', 'sindarin'];   // inventados a propósito (regla 5)
const CATALOGO = [{ nombre: 'Mujer y secado', categoria: 'Cortes', precio: 40, duracion: 45 }];
const dbImpls = {
    findByPhone: async () => ({ id: 'ct-test', full_name: 'Clienta', wa_phone: '34600000000', bot_mode: 'auto' }),
    saveMessage: async () => 1,
    saveLead: async () => 'ct-test',
    updateLead: async () => true,
    getUpcomingAppointments: async () => [],
    getAppointmentsByLead: async () => [],
    getStylistsByOrg: async () => [],
    getAllStylistSchedules: async () => [],
    getScheduleBlocks: async () => [],
    getBlockedDays: async () => [],
    findContactIdsByPhone: async () => [],
    getAgentConfig: async () => ({
        services: CATALOGO, business_hours: null,
        business_info: { companyName: 'Salón de prueba', idiomas: IDIOMAS_SALON },
    }),
};
stub('../services/db', new Proxy(dbImpls, { get: (t, k) => t[k] ?? (async () => null) }));
stub('../services/calendar-sante', {
    getAvailableSlots: async () => [],
    bookAppointment: async () => ({ success: true, appointmentId: 'apt-1' }),
    cancelAppointment: async () => ({ success: true }),
    formatSlotForMessage: s => `${s.fecha} ${s.hora}`,
});
stub('../services/telegram', {
    notifyBizumPending: async () => {}, notifyEscalation: async () => {},
    notifyBlacklistAlert: async () => {}, startTelegramBot: () => {},
});
stub('../services/memory', { loadClient: () => null, saveClient: () => {}, saveSummary: () => {}, deleteClient: () => {} });
stub('../services/metrics', { incrementMetric: () => {} });

const logs = [];
const loggerPath = require.resolve('../lib/logger');
const realLogger = require(loggerPath);
require.cache[loggerPath].exports = {
    ...realLogger,
    info: (evento, meta) => logs.push({ evento, meta }),
    warn: (evento, meta) => logs.push({ evento, meta }),
    error: (evento, meta) => logs.push({ evento, meta }),
    debug: () => {},
};

const openai = require('../services/providers/openai');
const getChatbotResponseReal = openai.getChatbotResponse;

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function normaliza(json) {
    respuestaCruda = json;
    logs.length = 0;
    return getChatbotResponseReal(ORG, [{ role: 'user', content: 'bonjour' }], {}, 'general', false, null);
}

// ═══ A · El normalizador: la señal se conserva, la frase se sanea ═══════════════════

test('un idioma fuera de la lista de códigos deja SEÑAL, no solo un warn', async () => {
    const r = await normaliza('{"respuesta":"Bonjour","idioma_detectado":"fr"}');
    assert.strictEqual(r.idioma_fuera_de_lista, true, 'se perdió la señal: sin ella no se entera nadie');
    assert.strictEqual(r.idioma_detectado, null, 'el campo cerrado tiene que seguir cerrado');
    assert.ok(logs.some(l => l.evento === 'idioma_detectado_no_soportado'), 'y sigue avisando');
});

test('un idioma de la casa NO levanta la señal', async () => {
    for (const l of ['es', 'en', 'ru', 'uk']) {
        const r = await normaliza(`{"respuesta":"hola","idioma_detectado":"${l}"}`);
        assert.strictEqual(r.idioma_fuera_de_lista, false, `'${l}' levantó la señal`);
        assert.strictEqual(r.idioma_detectado, l);
    }
});

test('el campo ausente o vacío NO es una declaración', async () => {
    for (const json of ['{"respuesta":"hola"}', '{"respuesta":"hola","idioma_detectado":null}',
        '{"respuesta":"hola","idioma_detectado":"  "}', '{"respuesta":"hola","idioma_detectado":123}']) {
        const r = await normaliza(json);
        assert.strictEqual(r.idioma_fuera_de_lista, false, `${json} se leyó como declaración`);
    }
});

test('la frase se sanea antes de salir: una línea, con tope, y vacía = null', async () => {
    const r = await normaliza('{"respuesta":"Bonjour","frase_idiomas_salon":"  Au salon\\n\\tnous parlons   klingon.  "}');
    assert.strictEqual(r.frase_idiomas_salon, 'Au salon nous parlons klingon.',
        'los saltos y tabuladores tienen que colapsar: el texto sale TAL CUAL a la clienta');

    const largo = await normaliza(`{"respuesta":"Bonjour","frase_idiomas_salon":"${'x'.repeat(400)}"}`);
    assert.strictEqual(largo.frase_idiomas_salon.length, 220, 'sin tope, el modelo puede colar un párrafo');

    for (const v of ['""', 'null', '"   "', '42', '{"a":1}']) {
        const vacio = await normaliza(`{"respuesta":"Bonjour","frase_idiomas_salon":${v}}`);
        assert.strictEqual(vacio.frase_idiomas_salon, null, `${v} tenía que dar null`);
    }
});

// ═══ B · La máquina: cuándo se pega y cuándo no ═════════════════════════════════════

let llmCalls = 0;
const llmQueue = [];
openai.getChatbotResponse = async () => {
    llmCalls++;
    const item = llmQueue.length ? llmQueue.shift() : 'Ok 😊';
    const base = {
        respuesta: null, reserva_confirmada: false, cita_confirmada: false,
        slot_rechazado: false, accion: null, motivo_escalado: null,
        ofrezco_traspaso: null, idioma_detectado: null, idioma_fuera_de_lista: false,
        frase_idiomas_salon: null,
        datos: { nombre: null, servicio: null, fecha_cita: null, hora_cita: null },
    };
    return (typeof item === 'string') ? { ...base, respuesta: item } : { ...base, ...item };
};
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const I = bot._internals;
const { createEmptySession, userSessions, sessionKey } = I;
bot.setBotActivo(ORG, true, false);

const FRASE_FR = 'Au salon, nous parlons klingon et sindarin ; avec les autres langues, nous nous débrouillons avec un traducteur.';
const OFERTA_FR = 'Bien sûr 😊 Tu veux que je te mette en contact avec notre équipe ?';

const makeClient = sink => ({
    sendMessage: async (_p, text) => { sink.push(text); return { id: { _serialized: `wamid.C${sink.length}` } }; },
    getChatById: async () => ({ sendStateTyping: async () => {} }),
});

let seq = 0;
function armarSesion(over = {}) {
    const phone = `346001${String(1000 + seq++).slice(-4)}@c.us`;
    const session = createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    session.orgType = 'salon';
    session.leadId = 'ct-test';
    session.nombreGuardado = true;
    session.partialData = { ...session.partialData, nombre: 'Camille', telefono: phone.replace(/\D/g, '') };
    session.spaPromoOffered = true;
    Object.assign(session, over);
    userSessions.set(sessionKey(ORG, phone), session);
    return { phone, session };
}

async function turno(phone, sink, texto) {
    const s = userSessions.get(sessionKey(ORG, phone));
    if (s && s.lastMessageTime) s.lastMessageTime -= 5000;
    await bot.handleIncomingMessage(makeClient(sink), {
        from: phone, body: texto, id: { _serialized: `wamid.IC${Date.now()}_${seq++}` },
        fromMe: false, timestamp: Date.now(), isStatus: false, isBroadcast: false,
        hasMedia: false, type: 'chat',
        getChat: async () => ({ sendStateTyping: async () => {} }),
        getContact: async () => ({ number: phone.replace(/\D/g, '') }),
    }, ORG);
    await I.flushBuffer(ORG, phone);
    await new Promise(r => setTimeout(r, 400));
}

const ultimo = sink => sink[sink.length - 1] || '';
function reset() { logs.length = 0; llmQueue.length = 0; llmCalls = 0; }

test('la señal del modelo levanta la marca, y la marca es PEGAJOSA', async () => {
    reset();
    const { phone, session } = armarSesion();
    const sink = [];
    llmQueue.push({ respuesta: 'Bonjour Camille 😊', idioma_fuera_de_lista: true });
    await turno(phone, sink, 'Bonjour, je voudrais un rendez-vous');
    assert.strictEqual(session.idiomaSinCodigo, true, 'no se marcó el idioma de fuera');

    // El campo se omite en el 27 % de los turnos: un turno mudo NO puede apagarla.
    llmQueue.push({ respuesta: 'Très bien 😊' });
    await turno(phone, sink, 'une coupe');
    assert.strictEqual(session.idiomaSinCodigo, true, 'un turno sin declaración la apagó');
});

test('vuelve a un idioma de la casa → la marca se apaga', async () => {
    reset();
    const { phone, session } = armarSesion({ idiomaSinCodigo: true });
    const sink = [];
    llmQueue.push({ respuesta: 'Claro 😊', idioma_detectado: 'es' });
    await turno(phone, sink, 'hola, mejor en español');
    assert.strictEqual(session.idiomaSinCodigo, false, 'declarar un idioma de la casa tiene que apagarla');
});

test('con la marca y con frase: se PEGA, y la respuesta del modelo sale ENTERA', async () => {
    reset();
    const { phone, session } = armarSesion({ idiomaSinCodigo: true });
    const sink = [];
    llmQueue.push({ respuesta: OFERTA_FR, frase_idiomas_salon: FRASE_FR });
    await turno(phone, sink, "Est-ce que je peux parler à quelqu'un ?");

    const txt = ultimo(sink);
    assert.ok(txt.includes(OFERTA_FR), 'AÑADE, no sustituye: el mensaje del modelo tiene que salir entero');
    assert.ok(txt.includes(FRASE_FR), 'la frase no se pegó');
    assert.strictEqual(session.idiomasSalonAvisado, true);
    assert.ok(logs.some(l => l.evento === 'idiomas_salon_avisado'), 'sin traza no se puede auditar');
});

test('no se repite: una sola vez en toda la conversación', async () => {
    reset();
    const { phone } = armarSesion({ idiomaSinCodigo: true });
    const sink = [];
    llmQueue.push({ respuesta: OFERTA_FR, frase_idiomas_salon: FRASE_FR });
    await turno(phone, sink, "je peux parler à quelqu'un ?");
    llmQueue.push({ respuesta: 'Je te mets en contact avec le salon 😊', frase_idiomas_salon: FRASE_FR });
    await turno(phone, sink, 'oui merci');

    assert.ok(!ultimo(sink).includes(FRASE_FR), 'se repitió en el turno siguiente');
});

test('SIN la marca no se pega NADA, aunque el modelo mande la frase', async () => {
    // El control de la regla 12: en una conversación de las cuatro de la casa el campo ni
    // siquiera se le pide, pero si un día llegara, la máquina no lo usa.
    reset();
    const { phone, session } = armarSesion({ language: 'ru' });
    const sink = [];
    llmQueue.push({ respuesta: 'Конечно 😊', frase_idiomas_salon: FRASE_FR });
    await turno(phone, sink, 'а можно поговорить с кем-то?');
    assert.ok(!ultimo(sink).includes(FRASE_FR), 'se coló en una conversación en ruso');
    assert.ok(!session.idiomasSalonAvisado);
});

test('sin frase no se inventa nada (regla 3)', async () => {
    reset();
    const { phone, session } = armarSesion({ idiomaSinCodigo: true });
    const sink = [];
    llmQueue.push({ respuesta: OFERTA_FR });
    await turno(phone, sink, "je peux parler à quelqu'un ?");
    assert.strictEqual(ultimo(sink).trim(), OFERTA_FR, 'sin frase el mensaje sale tal cual');
    assert.ok(!session.idiomasSalonAvisado,
        'no haberla dicho no puede contar como dicha: el turno siguiente tiene que poder');
});

test('sobre un FALLBACK no se pega: no es una respuesta', async () => {
    reset();
    const { phone, session } = armarSesion({ idiomaSinCodigo: true });
    const sink = [];
    const fb = openai.getFallbackResponse(ORG, 'es');
    llmQueue.push({ respuesta: fb.respuesta, frase_idiomas_salon: FRASE_FR });
    await turno(phone, sink, "je peux parler à quelqu'un ?");
    assert.ok(!ultimo(sink).includes(FRASE_FR), 'se pegó detrás de «no he podido procesar»');
    assert.ok(!session.idiomasSalonAvisado, 'y encima habría gastado el aviso');
});

test('las dos marcas viajan a SQLite', async () => {
    const { session } = armarSesion({ idiomaSinCodigo: true, idiomasSalonAvisado: true });
    const extra = I.buildSessionExtra(session);
    assert.strictEqual(extra.idiomaSinCodigo, true,
        'sin viajar, una conversación en francés que cruce un timeout deja de avisar');
    assert.strictEqual(extra.idiomasSalonAvisado, true,
        'sin viajar, el aviso se repite tras el timeout');
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { fallos++; console.error(`FALLO - ${name}\n   ${e.message}`); }
    }
    console.log(fallos ? `\n❌ ${fallos} fallo(s)` : `\n✅ ${tests.length} en verde`);
    process.exit(fallos ? 1 : 0);
})();
