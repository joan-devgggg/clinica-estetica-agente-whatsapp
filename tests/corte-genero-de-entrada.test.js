/**
 * tests/corte-genero-de-entrada.test.js — un corte con el género YA dicho deja rastro.
 *
 * LA GRIETA, medida el 20/08/2026 contra el catálogo real de Sante (Cortes: «Mujer y
 * secado» 40 €, «Mujer y peinado Dyson» 50 €, «Hombre» 25 €, «Niño» 25 €, «Infantil hasta 8
 * años» 15 €):
 *
 *   texto                  extractServiceFromText   detectCorteGenerico   detectCorteGenero
 *   «un corte de mujer»          null                     false                'mujer'
 *
 * No casa el catálogo —las entradas no se llaman «corte de mujer»— y tampoco es «genérico»,
 * porque genérico significaba «no dice el tipo» y ella SÍ lo dice. Así que no se guardaba ni
 * `selectedService` ni ningún paso del árbol: la clienta había nombrado su servicio y para
 * el sistema no había dicho nada. Es el turno 2 del escenario 11 del arnés, y de ahí salía
 * el embudo un turno después («Para mirarte los huecos primero necesito saber qué servicio
 * quieres», contestando a «me viene bien el finde»).
 *
 * Y LO QUE APARECIÓ AL MEDIRLA, que es peor:
 *
 *   «corte femenino»  →  extractServiceFromText devuelve «Niño» (25 €)
 *
 * porque el matcher casa por SUBCADENA y «femeNINO» contiene «nino». Una mujer pidiendo un
 * corte se llevaba un corte de niño apuntado. El género no la salvaba porque los tokens
 * `femenin` y `masculin` de detectCorteGenero llevaban un `\b` de cierre detrás y un PREFIJO
 * no puede casar así: los dos estaban muertos desde que se escribieron.
 *
 * Lo que este fichero NO permite: que el arreglo se lleve por delante los caminos que ya
 * funcionaban. Los cinco CONTROLES de abajo son la mitad del valor — «corte de hombre»,
 * «corte de niño», «corte con secado» y «corte mujer y secado» resuelven hoy, y tienen que
 * seguir resolviendo igual.
 *
 * Sabotajes MEDIDOS (cp previo, 20/08/2026):
 *   · quitar la rama de entrada (mencionaCorte && generoCorte) ................... 3 rojos
 *       la grieta, el corte de niño, y los dos caminos dejando de coincidir
 *   · devolver `femenin`/`masculin` a sus tokens muertos (con el `\\b` de cierre) ... 1 rojo
 *       solo el del corte de niño: la grieta la tapa igual la rama de entrada, que es
 *       lo que demuestra que son DOS arreglos y no uno con dos nombres
 *   · quitar `\\bme\\s+corto\\b` de la mención ..................................... 1 rojo
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');

// ─── Stubs ANTES de requerir bot ─────────────────────────────────────────────
// bot.js desestructura require('./services/db') en su línea 10: parchear getAgentConfig
// DESPUÉS de requerir el bot se lo enseñaría al test y no al sistema (la lección de
// complemento-no-se-elige).
const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/supabase', {});

// El catálogo REAL de Cortes de Sante, tal cual está en agent_configs el 20/08/2026. Los
// nombres importan: la grieta existe precisamente porque no se llaman «corte de X».
const CORTES = [
    { categoria: 'Cortes', nombre: 'Mujer y peinado Dyson', precio: 50, duracion: 60 },
    { categoria: 'Cortes', nombre: 'Mujer y secado', precio: 40, duracion: 45 },
    { categoria: 'Cortes', nombre: 'Hombre', precio: 25, duracion: 30 },
    { categoria: 'Cortes', nombre: 'Niño', precio: 25, duracion: 30 },
    { categoria: 'Cortes', nombre: 'Infantil hasta 8 años', precio: 15, duracion: 30 },
];

const dbImpls = {
    findByPhone: async () => ({ id: 'ct-test', full_name: 'Test', wa_phone: '34600000009' }),
    saveMessage: async () => 1,
    getUpcomingAppointments: async () => [],
    getStylistsByOrg: async () => [],
    getAllStylistSchedules: async () => [],
    getScheduleBlocks: async () => [],
    getBlockedDays: async () => [],
    getAppointmentsByLead: async () => [],
    findContactIdsByPhone: async () => [],
    getAgentConfig: async () => ({ services: CORTES, business_hours: null, business_info: {} }),
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
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
};

// El LLM contesta algo neutro: lo que se mide es el ESTADO que dejan los detectores
// deterministas, no la prosa (regla 2 — la redacción del modelo no puede decidir un test).
const openai = require('../services/providers/openai');
openai.getChatbotResponse = async () => ({
    respuesta: 'Vale 😊', reserva_confirmada: false, cita_confirmada: false,
    slot_rechazado: false, accion: null, idioma_detectado: 'es',
    datos: { nombre: null, servicio: null, fecha_cita: null, hora_cita: null },
});
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const I = bot._internals;
const { userSessions, sessionKey } = I;
const { SANTE_ORG_ID: ORG } = require('../services/org-registry');

bot.setBotActivo(ORG, true, false);

let seq = 0;
const nuevoTelefono = () => `34600${String(20000 + seq++)}@c.us`;

async function turno(phone, texto) {
    await bot.handleIncomingMessage({
        sendMessage: async () => ({ id: { _serialized: `wamid.O${seq++}` } }),
        getChatById: async () => ({ sendStateTyping: async () => {} }),
    }, {
        from: phone, body: texto, id: { _serialized: `wamid.C${Date.now()}_${seq++}` },
        fromMe: false, timestamp: Date.now(), isStatus: false, isBroadcast: false,
        hasMedia: false, type: 'chat',
        getChat: async () => ({ sendStateTyping: async () => {} }),
        getContact: async () => ({ number: phone.replace(/\D/g, '') }),
    }, ORG);
    await I.flushBuffer(ORG, phone);
    await new Promise(r => setTimeout(r, 250));
    const s = userSessions.get(sessionKey(ORG, phone));
    // La guarda de mensaje duplicado (1,5 s) descartaría el turno siguiente de un test que
    // encadena turnos en milisegundos, y lo haría en silencio: `process_core_msg_rapido_
    // duplicado` y a otra cosa. Se rebobina el reloj de la sesión en vez de dormir 1,5 s por
    // turno — esa guarda protege de una reentrega de WhatsApp, que no es lo que se mide aquí.
    if (s) s.lastMessageTime = 0;
    return s;
}

const decir = texto => turno(nuevoTelefono(), texto);
const svcDe = s => s?.selectedService?.nombre || null;

// ─── 1 · La grieta ───────────────────────────────────────────────────────────

test('«un corte de mujer» deja el árbol en el paso 2, no en la nada', async () => {
    const s = await decir('quiero un corte de mujer');
    assert.strictEqual(s.pendingCorteMujerTipo, true,
        'la clienta ha dicho el género: el siguiente paso es secado o Dyson, no volver a preguntárselo');
    assert.strictEqual(s.pendingCorteGenero, false,
        'repetirle «¿para hombre, mujer o niño?» a quien acaba de decir «de mujer» es el bucle');
    assert.strictEqual(svcDe(s), null, 'y no se elige por ella entre 40 € y 50 €');
});

test('«corte femenino» NO acaba en un corte de niño de 25 €', async () => {
    const s = await decir('quería un corte femenino');
    assert.notStrictEqual(svcDe(s), 'Niño',
        'el matcher casa por subcadena y «femeNINO» contiene «nino»: esto es lo que se apuntaba');
    assert.strictEqual(s.pendingCorteMujerTipo, true, 'lo correcto es preguntarle secado o Dyson');
});

test('«me corto el pelo» lo ve alguien: antes no lo veía ningún detector', async () => {
    const s = await decir('hola, me corto el pelo?');
    assert.strictEqual(s.pendingCorteGenero, true,
        'sin género dicho, el árbol empieza por el paso 1 — pero empieza');
});

// ─── 2 · Controles: lo que YA funcionaba sigue igual ─────────────────────────

test('CONTROL «corte de hombre» sigue resolviendo directo (una sola entrada)', async () => {
    assert.strictEqual(svcDe(await decir('un corte de hombre')), 'Hombre');
});

test('CONTROL «corte de niño» sigue resolviendo directo', async () => {
    assert.strictEqual(svcDe(await decir('un corte de niño')), 'Niño');
});

test('CONTROL «corte mujer y secado» resuelve el servicio COMPLETO, no el paso 2', async () => {
    // Es el control que impide que la rama nueva se ponga por delante del catálogo: si lo
    // hiciera, a quien ya ha dicho «y secado» se le preguntaría «¿secado o Dyson?».
    const s = await decir('corte mujer y secado');
    assert.strictEqual(svcDe(s), 'Mujer y secado');
    assert.strictEqual(s.pendingCorteMujerTipo, false);
});

test('CONTROL «corte con dyson» resuelve sin que el género haga falta', async () => {
    assert.strictEqual(svcDe(await decir('un corte con dyson')), 'Mujer y peinado Dyson');
});

test('CONTROL «quiero un corte» a secas sigue abriendo el árbol por el paso 1', async () => {
    const s = await decir('quiero un corte');
    assert.strictEqual(s.pendingCorteGenero, true);
    assert.strictEqual(svcDe(s), null);
});

// ─── 3 · Falso positivo: «corto» es también el LARGO del pelo ────────────────

test('FALSO POSITIVO · «tengo el pelo corto» no es pedir un corte', async () => {
    // El motivo de que «me corto» vaya con su propio patrón en vez de meter `corto` en la
    // lista de verbos: `corto` es el adjetivo que leen detectLargoCategory y extractLargoPelo.
    // Con un `\bcorto\b` suelto, cada descripción de melena corta abriría el árbol de cortes.
    const s = await decir('tengo el pelo corto y muy seco');
    assert.strictEqual(s.pendingCorteGenero, false, 'describir su pelo no es pedir un corte');
    assert.strictEqual(svcDe(s), null);
});

// ─── 4 · El árbol de dos turnos, entero ──────────────────────────────────────

test('el árbol completo sigue andando: «un corte» → «para mujer» → «con secado»', async () => {
    const phone = nuevoTelefono();
    let s = await turno(phone, 'quiero un corte');
    assert.strictEqual(s.pendingCorteGenero, true, 'paso 1');
    s = await turno(phone, 'para mujer');
    assert.strictEqual(s.pendingCorteMujerTipo, true, 'paso 2');
    assert.strictEqual(s.pendingCorteGenero, false);
    s = await turno(phone, 'con secado');
    assert.strictEqual(svcDe(s), 'Mujer y secado', 'y resuelve al mismo sitio que la vía corta');
});

test('la vía corta y la larga acaban en el MISMO sitio', async () => {
    // Las dos ramas comparten `avanzarArbolCorte` justo para esto: si divergieran, decir el
    // género de entrada o decirlo contestando llevarían a estados distintos y solo una de
    // las dos tendría test.
    const corta = await decir('un corte de mujer');
    const phone = nuevoTelefono();
    await turno(phone, 'quiero un corte');
    const larga = await turno(phone, 'para mujer');
    for (const k of ['pendingCorteGenero', 'pendingCorteMujerTipo', 'pendingCorteNinoTipo']) {
        assert.strictEqual(corta[k], larga[k], `los dos caminos discrepan en ${k}`);
    }
});
