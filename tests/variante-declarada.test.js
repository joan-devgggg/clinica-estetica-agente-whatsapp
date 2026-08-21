/**
 * tests/variante-declarada.test.js — el modelo DECLARA que está preguntando la variante.
 *
 * 20/08/2026, 19:01:14 → 19:02:57, en ruso y de principio a fin (byte por byte en `messages`):
 *
 *   19:01:14  ella   «Здравствуйте можно записаться 7.09 на покраску?»
 *   19:01:24  bot    «…Какой вид покраски тебе нужен — окрашивание корней, полное
 *                     окрашивание или матирование?»
 *   19:01:28  ella   «На 15.00?»
 *   19:01:38  bot    «Сначала уточню — какой вид покраски тебе нужен?…»
 *   19:01:54  ella   «Корни и матирование»
 *   19:02:04  bot    «…Какой длины у тебя волосы — короткие, средние или длинные?»   ← PREGUNTA
 *   19:02:13  ella   «Короткие»
 *   19:02:23  bot    «Окрашивание корней (75€) и матирование (40€). У тебя есть стилист…?»
 *   19:02:47  ella   «Вероника»
 *   19:02:57  bot    «Чтобы посмотреть свободное время, мне нужно знать, какая услуга тебя
 *                     интересует 😊»                                                ← EL EMBUDO
 *
 * Cinco turnos, DOS PRECIOS DICHOS, y el sistema preguntándole lo que ella ya había dicho.
 *
 * LA CAUSA: ninguno de sus cinco mensajes resolvió nada por el camino determinista. La
 * conversación entera la condujo el modelo, así que `selectedService` seguía a null y ninguna
 * de las cuatro banderas de variante estaba puesta. `proposesTimingWithoutService` mira esas
 * banderas para saber si la premisa «sin servicio, hablar del cuándo es humo» es falsa, y no
 * tenía ninguna que mirar.
 *
 * EL ARREGLO es la doctrina del caso 7: el modelo DECLARA (`variante_preguntada` con el
 * nombre de la categoría) y la MÁQUINA DECIDE (¿existe esa categoría en el catálogo vivo?,
 * ¿sus variantes son de largo?). Un booleano de su JSON es independiente del idioma; su prosa
 * no. Y solo cuando PREGUNTA: nombrarla de pasada no siembra nada.
 *
 * TRES cosas que NO se pueden desmontar sin releer esto:
 *
 *   · La validación va contra `agent_configs.services`, NUNCA contra una lista escrita en el
 *     código: la dueña renombra categorías desde el panel (regla 5). `resolveCategoriaDeLargo`
 *     comparte lista con `detectLargoCategory` — con dos copias, cambiar el criterio dejaría
 *     una vieja en silencio.
 *   · Una categoría que no resuelve NO siembra nada y se registra (regla 3). El modelo puede
 *     escribir «Coloración total» y eso no existe.
 *   · La bandera determinista MANDA. Si ya hay una puesta, la puso lo que dijo la CLIENTA, y
 *     una declaración del modelo no la pisa.
 *
 * LO QUE SE ACEPTA A CAMBIO, y hay que decirlo: la bandera no solo exime al embudo, también
 * pone en marcha la resolución por largo del turno siguiente. Si contesta «cortos», la
 * máquina elige la variante corta y con ella su precio. En la conversación de arriba eso
 * habría resuelto «Color completo largo 1» — que es EXACTAMENTE la cita que el salón acabó
 * creando a mano.
 *
 * Sabotajes MEDIDOS (cp previo, 21/08/2026):
 *   · quitar el bloque que siembra (el estado exacto de antes) ................. 3 rojos
 *   · sembrar sin validar contra el catálogo (aceptar la cadena tal cual) ...... 3 rojos
 *   · quitar la guarda de `!session.selectedService` ........................... 1 rojo
 *   · dejar que la declaración pise una bandera determinista ya puesta ......... 1 rojo
 *
 * Corrida del arnés con el prompt cambiado (21/08/2026): **OK 33 · DEGRADADO 0 · SILENCIO 0 ·
 * BUCLE 0 · ERROR 0 · BUG 0**, la línea base entera. El modelo rellenó el campo en CUATRO
 * turnos de los 33 escenarios y los cuatro eran preguntas de largo de verdad («Perfecto, un
 * Balayage. ¿Qué largo tienes el cabello?» → «Mechas Balayage»); cero declaraciones de
 * pasada. Ninguna de las cuatro sembró, y eso también es lo correcto: en las cuatro la
 * clienta había nombrado el servicio, así que la bandera determinista ya estaba puesta.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');

// Catálogo con las dos formas que importan: una categoría con variantes de LARGO y otra con
// variantes que no lo son. Entrada de funciones puras; nada aquí verifica el catálogo real.
const CATALOGO = [
    { nombre: 'Color raíz', categoria: 'Color Premium' },
    { nombre: 'Color completo largo 1', categoria: 'Color Premium' },
    { nombre: 'Color completo largo 2', categoria: 'Color Premium' },
    { nombre: 'Color completo largo 3', categoria: 'Color Premium' },
    { nombre: 'Mujer y secado', categoria: 'Cortes' },
    { nombre: 'Hombre', categoria: 'Cortes' },
    { nombre: 'Matiz', categoria: 'Matiz mujer' },
];

const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/supabase', {});
const dbImpls = {
    findByPhone: async () => ({ id: 'ct-ru', full_name: null, wa_phone: '380509321253' }),
    saveMessage: async () => 1,
    getAgentConfig: async () => ({ services: CATALOGO, business_hours: null, business_info: {} }),
    getStylistsByOrg: async () => [],
    getAllStylistSchedules: async () => [],
    getScheduleBlocks: async () => [],
    getBlockedDays: async () => [],
    getUpcomingAppointments: async () => [],
    getAppointmentsByLead: async () => [],
    findContactIdsByPhone: async () => [],
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
        info: (evento, campos = {}) => { logs.push({ evento, ...campos }); },
        warn: () => {}, debug: () => {}, error: () => {},
    },
};

const openai = require('../services/providers/openai');
const cola = [];
openai.getChatbotResponse = async () => ({
    respuesta: 'Ok', reserva_confirmada: false, cita_confirmada: false,
    slot_rechazado: false, accion: null, idioma_detectado: null, variante_preguntada: null,
    datos: { nombre: null, servicio: null, fecha_cita: null, hora_cita: null },
    ...(cola.length ? cola.shift() : {}),
});
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const I = bot._internals;
const { SANTE_ORG_ID: ORG } = require('../services/org-registry');
bot.setBotActivo(ORG, true, false);

let seq = 0;
async function turno(entrante, respuestaDelModelo, extraSesion = {}) {
    const phone = `38050932${String(1000 + seq++)}@c.us`;
    const sink = [];
    cola.push(respuestaDelModelo);
    const session = I.createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    session.leadId = 'ct-ru';
    session.language = 'ru';
    Object.assign(session, extraSesion);
    I.userSessions.set(I.sessionKey(ORG, phone), session);
    await bot.handleIncomingMessage({
        sendMessage: async (_p, t) => { sink.push(t); return { id: { _serialized: `wamid.V${seq++}` } }; },
        getChatById: async () => ({ sendStateTyping: async () => {} }),
    }, {
        from: phone, body: entrante, id: { _serialized: `wamid.VAR${Date.now()}_${seq++}` },
        fromMe: false, timestamp: Date.now(), isStatus: false, isBroadcast: false,
        hasMedia: false, type: 'chat',
        getChat: async () => ({ sendStateTyping: async () => {} }),
        getContact: async () => ({ number: phone.replace(/\D/g, '') }),
    }, ORG);
    await I.flushBuffer(ORG, phone);
    await new Promise(r => setTimeout(r, 300));
    return { enviado: sink[sink.length - 1], session };
}

// La pregunta REAL del turno de las 19:02:04.
const PREGUNTA_LARGO = 'Отлично! Тогда это будет окрашивание корней и матирование. '
    + 'Какой длины у тебя волосы — короткие, средние или длинные?';

// ─── 1 · El turno que siembra ────────────────────────────────────────────────

test('REGRESIÓN · declarando la categoría, la bandera queda puesta', async () => {
    logs.length = 0;
    const { session } = await turno('Корни и матирование', {
        respuesta: PREGUNTA_LARGO, variante_preguntada: 'Color Premium',
    });
    assert.strictEqual(session.pendingLargoCategory, 'Color Premium',
        'sin esto, el turno siguiente vuelve a caer en «¿qué servicio quieres?»');
    assert.ok(logs.some(l => l.evento === 'variante_declarada_sembrada'));
});

test('el nombre que se guarda es el CANÓNICO del catálogo, venga como venga', async () => {
    // Lo que se siembra tiene que casar luego con `svc.categoria`: una grafía distinta no
    // casaría y la resolución del turno siguiente encontraría cero candidatas.
    const { session } = await turno('корни', {
        respuesta: PREGUNTA_LARGO, variante_preguntada: 'color premium',
    });
    assert.strictEqual(session.pendingLargoCategory, 'Color Premium');
});

// ─── 2 · Y con la bandera puesta, el embudo ya no dispara ────────────────────

test('REGRESIÓN · el turno del embudo: con la bandera, la red deja pasar el mensaje', () => {
    const { proposesTimingWithoutService } = I;
    const HORARIO = ['10:00', '19:00'];
    const respuestaDeHuecos = 'Смотрю свободное время на 7 сентября. Какое время тебе удобнее?';
    const sinBandera = { language: 'ru', partialData: {}, selectedService: null };
    assert.strictEqual(proposesTimingWithoutService(respuestaDeHuecos, sinBandera, HORARIO), true,
        'sin bandera la red dispara: es el estado del 20/08');
    assert.strictEqual(
        proposesTimingWithoutService(respuestaDeHuecos, { ...sinBandera, pendingLargoCategory: 'Color Premium' }, HORARIO),
        false, 'con la bandera puesta, la premisa de la red es falsa');
});

// ─── 3 · Lo que NO puede sembrar ─────────────────────────────────────────────

test('una categoría que NO existe en el catálogo no siembra nada', async () => {
    logs.length = 0;
    const { session } = await turno('квери', {
        respuesta: PREGUNTA_LARGO, variante_preguntada: 'Coloración Total',
    });
    assert.strictEqual(session.pendingLargoCategory, null, 'el modelo se la inventó');
    assert.ok(logs.some(l => l.evento === 'variante_declarada_no_resuelta'),
        'y no se pierde en silencio: queda con el valor crudo dentro');
});

test('una categoría real cuyas variantes NO son el largo tampoco siembra', async () => {
    // «Cortes» tiene variantes (Mujer y secado / Hombre) pero no son longitudes: tiene su
    // propia bandera y su propio camino.
    const { session } = await turno('корни', {
        respuesta: PREGUNTA_LARGO, variante_preguntada: 'Cortes',
    });
    assert.strictEqual(session.pendingLargoCategory, null);
});

test('sin declaración no se siembra, aunque el texto pregunte el largo', async () => {
    // Es la propiedad entera: aquí NO se lee prosa. La misma pregunta, sin el campo, no
    // siembra — y por eso el idioma número seis no necesita que nadie añada nada.
    const { session } = await turno('корни', { respuesta: PREGUNTA_LARGO });
    assert.strictEqual(session.pendingLargoCategory, null);
});

test('con servicio YA elegido, la declaración no reabre nada', async () => {
    const { session } = await turno('корни', {
        respuesta: PREGUNTA_LARGO, variante_preguntada: 'Color Premium',
    }, { selectedService: { nombre: 'Matiz', categoria: 'Matiz mujer' } });
    assert.strictEqual(session.pendingLargoCategory, null,
        'sembrar con servicio elegido reabriría una elección que ya está hecha');
});

test('la bandera DETERMINISTA manda: una declaración no la pisa', async () => {
    // La puso lo que dijo la CLIENTA. El modelo no la corrige.
    const { session } = await turno('корни', {
        respuesta: PREGUNTA_LARGO, variante_preguntada: 'Color Premium',
    }, { pendingLargoCategory: 'Mechas Airtouch' });
    assert.strictEqual(session.pendingLargoCategory, 'Mechas Airtouch');
});

// ─── 4 · Las piezas puras ────────────────────────────────────────────────────

test('resolveCategoriaDeLargo sale del catálogo VIVO, nunca de una lista del código', () => {
    const { resolveCategoriaDeLargo, categoriasConVariantesDeLargo } = require('../services/helpers');
    assert.strictEqual(resolveCategoriaDeLargo('Color Premium', CATALOGO), 'Color Premium');
    assert.strictEqual(resolveCategoriaDeLargo('Cortes', CATALOGO), null);
    assert.strictEqual(resolveCategoriaDeLargo('', CATALOGO), null);
    assert.strictEqual(resolveCategoriaDeLargo('Color Premium', []), null);
    assert.strictEqual(resolveCategoriaDeLargo(null, CATALOGO), null);
    // Y renombrar la categoría en el catálogo la sigue: es lo que un `Set` en el código no
    // haría (regla 5).
    const renombrado = CATALOGO.map(s => (s.categoria === 'Color Premium'
        ? { ...s, categoria: 'Coloración Premium' } : s));
    assert.strictEqual(resolveCategoriaDeLargo('Coloración Premium', renombrado), 'Coloración Premium');
    assert.strictEqual(resolveCategoriaDeLargo('Color Premium', renombrado), null);
    assert.deepStrictEqual(categoriasConVariantesDeLargo(CATALOGO).map(c => c.name), ['Color Premium']);
});

test('el campo va TAMBIÉN en el objeto de ejemplo del prompt, no solo en el contrato', () => {
    // Medido con `frase_idiomas_salon` el 19/08/2026: sin la clave dentro del JSON de
    // ejemplo, el modelo la rellenó en 1 de 2 corridas. El contrato de abajo describe el
    // campo; el ejemplo es lo que copia.
    const prompt = openai.buildSystemPrompt(ORG, {}, null, false, null, {
        services: CATALOGO, business_hours: null, business_info: {}, system_prompt: null, tone: null,
    });
    const ejemplo = prompt.slice(prompt.indexOf('"respuesta": "mensaje para la clienta"'));
    assert.ok(/"variante_preguntada": null/.test(ejemplo.slice(0, 600)),
        'el campo tiene que estar en el objeto de ejemplo');
    assert.ok(/variante_preguntada: cuando en ESTE mensaje le PREGUNTAS/.test(prompt),
        'y su línea de contrato tiene que decir que es SOLO cuando pregunta');
});
