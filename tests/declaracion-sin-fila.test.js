/**
 * tests/declaracion-sin-fila.test.js — el anillo que NO lee prosa.
 *
 * 19/08/2026, conversación entera en francés. A las 15:51:25 el bot escribió:
 *
 *   «Super! Ta consultation est confirmée pour demain, jeudi 20 août à 11h 😊»
 *
 * y en `appointments` no había NINGUNA fila. Ninguna de las tres redes de agenda dijo nada,
 * y no por descuido: las tres reconocen la mentira LEYÉNDOLA. Medido con la misma frase en
 * seis idiomas, con la agenda sin consultar:
 *
 *   idioma   horas leídas   fechas leídas   ¿afirma reserva?
 *   fr       []             []              no      ← «11h» no lleva dos puntos, «août» no está
 *   es       ["11:00"]      ["2026-08-20"]  SÍ
 *   en       ["11:00"]      ["2026-08-20"]  no      ← «your consultation is confirmed» tampoco casa
 *   de       ["11:00"]      []              no
 *   it       ["11:00"]      ["2026-08-20"]  no
 *   ar       ["11:00"]      []              no
 *
 * Las dos lecturas que importan de esa tabla:
 *   1. el problema NO era «falta el francés»: el INGLÉS, idioma soportado, tampoco cazó su
 *      propia afirmación, porque el patrón espera «appointment» y ella dijo «consultation»;
 *   2. reconocer una mentira leyendo prosa no escala a ningún idioma, y menos al sexto.
 *
 * Este anillo no lee nada. Mira un BOOLEANO que el modelo emite en su JSON
 * (`reserva_confirmada`) y lo contrasta con si hay fila. Las dos cosas son independientes
 * del idioma, así que el idioma número seis no necesita que nadie añada nada. Es la doctrina
 * del caso 7: el modelo DECLARA, la máquina DECIDE.
 *
 * DECISIONES TOMADAS (21/08/2026), y son las que hay que releer antes de tocarlo:
 *
 *   · TEXTO NUEVO, no `salonRetryMsg`. Aquel dice «no he podido fijar ese hueco» y da por
 *     hecho que había un hueco en juego: es la fila de Candela del 09/08. Aquí no lo hay.
 *   · CUATRO IDIOMAS y castellano de respaldo. Una francesa lo recibe en castellano: no
 *     miente, y es el trato que ya tienen las plantillas fijas. Que lo traduzca el modelo se
 *     deja para cuando se sepa que hace falta.
 *   · NO se exime una PREGUNTA. `asksForBookingApproval` exime en la red de PROSA, que se
 *     dispara por lo que el texto dice; ésta se dispara por lo que el modelo DECLARA, que es
 *     otro disparador. Sin fila, callar es mejor que afirmar.
 *
 * Sabotajes MEDIDOS (cp previo, 21/08/2026):
 *   · quitar el cierre de turno entero ....................................... 5 rojos
 *   · dejarlo pero volver a `salonRetryMsg` como sustituto ................... 5 rojos
 *       («no he podido fijar ese hueco» habla de un hueco que aquí no existe, y además
 *        lleva la palabra dentro: el bloque del texto lo caza igual que los de conducta)
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');

const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/supabase', {});
let citasDeLaBD = [];
const dbImpls = {
    findByPhone: async () => ({ id: 'ct-fr', full_name: 'Lynda', wa_phone: '213770091512' }),
    saveMessage: async () => 1,
    getUpcomingAppointments: async () => citasDeLaBD,
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
stub('../services/metrics', { incrementMetric: () => {} });
const logs = [];
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: {
        info: () => {}, warn: () => {}, debug: () => {},
        error: (evento, campos = {}) => { logs.push({ evento, ...campos }); },
    },
};

// El LLM por cola: cada entrada es el aiResponse parcial que devuelve.
const openai = require('../services/providers/openai');
const cola = [];
openai.getChatbotResponse = async () => ({
    respuesta: 'Ok', reserva_confirmada: false, cita_confirmada: false,
    slot_rechazado: false, accion: null, idioma_detectado: null,
    datos: { nombre: null, servicio: null, fecha_cita: null, hora_cita: null },
    ...(cola.length ? cola.shift() : {}),
});
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const I = bot._internals;
const { SANTE_ORG_ID: ORG } = require('../services/org-registry');
bot.setBotActivo(ORG, true, false);

let seq = 0;
async function turno(respuestaDelModelo, { language = null } = {}) {
    const phone = `21377009${String(1000 + seq++)}@c.us`;
    const sink = [];
    cola.push(respuestaDelModelo);
    const session = I.createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    session.leadId = 'ct-fr';
    session.language = language;
    I.userSessions.set(I.sessionKey(ORG, phone), session);
    await bot.handleIncomingMessage({
        sendMessage: async (_p, t) => { sink.push(t); return { id: { _serialized: `wamid.O${seq++}` } }; },
        getChatById: async () => ({ sendStateTyping: async () => {} }),
    }, {
        from: phone, body: 'oui', id: { _serialized: `wamid.FR${Date.now()}_${seq++}` },
        fromMe: false, timestamp: Date.now(), isStatus: false, isBroadcast: false,
        hasMedia: false, type: 'chat',
        getChat: async () => ({ sendStateTyping: async () => {} }),
        getContact: async () => ({ number: phone.replace(/\D/g, '') }),
    }, ORG);
    await I.flushBuffer(ORG, phone);
    await new Promise(r => setTimeout(r, 300));
    return { enviado: sink[sink.length - 1], session };
}

// La frase REAL, byte por byte.
const FRASE_FR = 'Super! Ta consultation est confirmée pour demain, jeudi 20 août à 11h 😊 '
    + 'Le prix se confirmera directement au salon après l\'évaluation. À demain!';
const esElTextoNuevo = m => /no tengo nada apuntado|anything booked under your name|ничего не записано|нічого не записано/i.test(m);

// ─── 1 · El caso real ────────────────────────────────────────────────────────

test('REGRESIÓN · la frase francesa NO sale si el modelo declara reserva y no hay fila', async () => {
    logs.length = 0;
    citasDeLaBD = [];
    const { enviado } = await turno({ respuesta: FRASE_FR, reserva_confirmada: true });
    assert.ok(!/confirmée/.test(enviado),
        `salió la confirmación de una cita que no existe:\n${enviado}`);
    assert.ok(esElTextoNuevo(enviado), `esperaba el texto nuevo, salió:\n${enviado}`);
    assert.ok(logs.some(l => l.evento === 'cita_declarada_sin_fila'),
        'y queda registrado con la respuesta bloqueada dentro');
});

test('el anillo no lee la prosa: la MISMA frase en un idioma inventado también se para', async () => {
    // Es la propiedad entera. Si esto pasara, sería que en algún sitio se está leyendo texto.
    citasDeLaBD = [];
    const { enviado } = await turno({
        respuesta: 'Kwa heri! Miadi yako imethibitishwa kesho saa 11 asubuhi 😊',
        reserva_confirmada: true,
    });
    assert.ok(esElTextoNuevo(enviado), `no lo paró: ${enviado}`);
});

// ─── 2 · Lo que NO puede pasar ───────────────────────────────────────────────

test('CONTROL sin declaración, el mensaje del modelo sale tal cual', async () => {
    // El anillo se dispara por el BOOLEANO. Sin él no pinta nada, aunque el texto hable de
    // citas: para eso están las otras dos redes, que sí leen.
    citasDeLaBD = [];
    const { enviado } = await turno({ respuesta: 'Bonjour! Comment tu t\'appelles?', reserva_confirmada: false });
    assert.strictEqual(enviado, 'Bonjour! Comment tu t\'appelles?');
});

test('CONTROL con la reserva ya hecha en la sesión, no se rectifica nada', async () => {
    // `session.reservaConfirmada` es la fila. Si está, la declaración es verdad y el mensaje
    // es suyo. Sin este control, el anillo se comería TODAS las confirmaciones buenas.
    citasDeLaBD = [];
    const phone = `21377009${String(2000 + seq++)}@c.us`;
    const sink = [];
    cola.push({ respuesta: 'Ta consultation est confirmée 😊', reserva_confirmada: true });
    const session = I.createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    session.leadId = 'ct-fr';
    session.reservaConfirmada = true;          // ← la fila existe
    I.userSessions.set(I.sessionKey(ORG, phone), session);
    await bot.handleIncomingMessage({
        sendMessage: async (_p, t) => { sink.push(t); return { id: { _serialized: 'wamid.X' } }; },
        getChatById: async () => ({ sendStateTyping: async () => {} }),
    }, {
        from: phone, body: 'merci', id: { _serialized: `wamid.OK${Date.now()}` },
        fromMe: false, timestamp: Date.now(), isStatus: false, isBroadcast: false,
        hasMedia: false, type: 'chat',
        getChat: async () => ({ sendStateTyping: async () => {} }),
        getContact: async () => ({ number: phone.replace(/\D/g, '') }),
    }, ORG);
    await I.flushBuffer(ORG, phone);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(/confirmée/.test(sink[sink.length - 1]), 'una confirmación con fila detrás tiene que salir');
});

// ─── 3 · El texto ────────────────────────────────────────────────────────────

test('el texto dice lo cierto y NADA más: ni hora, ni fecha, ni promesa de escribir luego', async () => {
    const { buildSinReservaAunMsg, extractMentionedHours, extractMentionedDates } = require('../services/helpers');
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        const m = buildSinReservaAunMsg({ language: lang });
        assert.deepStrictEqual(extractMentionedHours(m), [], `${lang}: lleva una hora dentro`);
        assert.deepStrictEqual(extractMentionedDates(m), [], `${lang}: lleva una fecha dentro`);
        assert.ok(!/aviso|avisar|te escribo|i'll let you know|напишу тебе|напишу тобі/i.test(m),
            `${lang}: promete un aviso posterior, y no existe quien lo mande`);
        assert.ok(!/hueco|slot|fijar/i.test(m),
            `${lang}: habla de un hueco, y en este caso no hay ninguno en juego (la fila de Candela)`);
    }
});

test('un idioma fuera de los cuatro lo recibe en CASTELLANO, no en blanco', async () => {
    const { buildSinReservaAunMsg } = require('../services/helpers');
    const es = buildSinReservaAunMsg({ language: 'es' });
    for (const lang of ['fr', 'de', 'ar', null, undefined]) {
        assert.strictEqual(buildSinReservaAunMsg({ language: lang }), es, `${lang} debería caer a castellano`);
    }
});
