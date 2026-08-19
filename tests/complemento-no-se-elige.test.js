// CONDUCTA: un servicio `solo_complemento` no llega a ser NUNCA `session.selectedService`.
//
// Gemelo determinista del filtro `botOfferableCatalog`. El fichero hermano
// (`servicio-solo-complemento.test.js`) afirma las piezas —el prompt, los dos catálogos, la
// facturación, el panel—; éste conduce turnos de verdad por `handleIncomingMessage` y mira
// el ESTADO, que es lo único que decide qué se reserva y qué se cobra.
//
// POR QUÉ NO ESTÁ EN EL ARNÉS. Se intentó primero allí y NO se pudo medir, por dos motivos
// que conviene no redescubrir:
//   1. `bot.js` DESESTRUCTURA `require('./services/db')` en la línea 10, así que parchear
//      `db.getAgentConfig` después de requerir el bot no le llega al bot: la entrada
//      inyectada la veía el arnés y no el sistema. Dos corridas A/B salieron idénticas
//      porque no estaban midiendo nada.
//   2. Y aunque llegara, el arnés habla con el catálogo REAL, donde esta entrada todavía no
//      existe (el cambio está escrito y sin aplicar en data/peinado-con-tratamientos.json).
// El escenario 32 del arnés se queda como VIGÍA sobre la conversación real; la PRUEBA es
// ésta.
//
// LA FORMA DEL FIXTURE ES PARTE DE LA PRUEBA. La categoría de tratamientos tiene que llevar
// VARIAS entradas, como el catálogo real (10 en «Tratamiento Orgánico»). Con una sola, la
// pasada 1b de `extractServiceFromText` resuelve «quiero tratamientos» contra esa entrada
// única y el turno no llega nunca a la pasada 2 — el fixture salía verde sin el filtro y no
// probaba nada. Medido el 19/08/2026.
//
// Y LA SONDA ES EL PLURAL SUELTO, no «un peinado». «un peinado» da null con y sin filtro; el
// que llega al complemento es «tratamientos», porque la contención veta los tokens que son
// identidad de otra categoría y la categoría es «Tratamiento ORGÁNICO» —singular—, así que
// el plural no queda vetado. Por eso la categoría ancla de este fixture se llama
// «Tratamiento de prueba» y NO «Tratamientos de prueba»: con el plural en el nombre de la
// categoría, la contención veta la sonda y el fixture sale verde sin el filtro. Una letra.
//
// VISTO FALLAR SIN LO QUE PROTEGE (cp previo, medido el 19/08/2026): quitando el filtro de
// `botOfferableCatalog` caen 3 de los 4 bloques, y el rojo enseña el daño entero:
//
//     "hola, soy Nuria"          → —
//     "quiero tratamientos"      → Retoque con tratamientos
//     "mejor quiero un peinado"  → Retoque con tratamientos
//     "el de ondas"              → Retoque con tratamientos
//
// El complemento no solo se elige: SE QUEDA. El bloque de detección libre está gateado por
// `if (!session.selectedService)`, así que ningún turno posterior lo deshace — la clienta
// que preguntaba por tratamientos se va con 15 minutos de peinado. El CONTROL sigue verde
// en la mutación, que es lo que demuestra que el filtro no está de más.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key';

const assert = require('assert');
const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/supabase', {});

// El NOMBRE del complemento lleva «tratamientos» a propósito: es la mitad del caso real.
// «Peinado con tratamientos» contiene el plural, y el plural NO es identidad de la
// categoría ancla («Tratamiento Orgánico», singular), así que la contención no lo veta y
// la pasada 2 lo resuelve. Con un nombre que no lleve ese token —la primera versión de
// este fixture se llamaba «Retoque sin lavado»— la sonda no llega y el fichero sale verde
// sin el filtro: probaría el sabotaje obvio y no el que se cuela.
const COMPLEMENTO = 'Retoque con tratamientos';
// Nombres inventados (regla 5), pero la FORMA es la del catálogo real: la categoría ancla
// con varias entradas, y el complemento dentro de la categoría de peinados.
const CATALOGO = [
    { nombre: 'Lavar y secar',      precio: 25, duracion: 60, categoria: 'Peinados de prueba' },
    { nombre: 'Peinado de ondas',   precio: 40, duracion: 60, categoria: 'Peinados de prueba' },
    { nombre: 'Peinado de gala',    precio: 45, duracion: 90, categoria: 'Peinados de prueba' },
    { nombre: COMPLEMENTO,          precio: 15, duracion: 15, categoria: 'Peinados de prueba', solo_complemento: true },
    { nombre: 'Elixir de prueba',   precio: 60, duracion: 90, categoria: 'Tratamiento de prueba' },
    { nombre: 'Bálsamo de prueba',  precio: 35, duracion: 40, categoria: 'Tratamiento de prueba' },
    { nombre: 'Néctar de prueba',   precio: 45, duracion: 40, categoria: 'Tratamiento de prueba' },
];

stub('../services/db', new Proxy({
    findByPhone: async () => ({ id: 'ct', full_name: 'Nuria', wa_phone: '34600000000', bot_mode: 'auto' }),
    saveMessage: async () => 1,
    saveLead: async () => 'ct',
    updateLead: async () => true,
    getUpcomingAppointments: async () => [],
    getAppointmentsByLead: async () => [],
    getStylistsByOrg: async () => [{ id: 's1', name: 'Irina', skills: ['Peinados de prueba', 'Tratamiento de prueba'] }],
    getAllStylistSchedules: async () => [],
    getScheduleBlocks: async () => [],
    getBlockedDays: async () => [],
    findContactIdsByPhone: async () => [],
    getAgentConfig: async () => ({ services: CATALOGO, business_hours: null, business_info: {} }),
}, { get: (t, k) => t[k] ?? (async () => null) }));

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

const loggerPath = require.resolve('../lib/logger');
const realLogger = require(loggerPath);
require.cache[loggerPath].exports = { ...realLogger, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// El LLM no decide nada aquí: la selección de servicio que se mide es DETERMINISTA y
// pre-LLM. Contesta algo neutro para que el turno acabe.
const openai = require('../services/providers/openai');
openai.getChatbotResponse = async () => ({
    respuesta: 'Ok 😊', reserva_confirmada: false, cita_confirmada: false, slot_rechazado: false,
    accion: null, motivo_escalado: null, ofrezco_traspaso: null, idioma_detectado: 'es',
    datos: { nombre: null, servicio: null, fecha_cita: null, hora_cita: null },
});
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const I = bot._internals;
const { createEmptySession, userSessions, sessionKey } = I;
const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
bot.setBotActivo(ORG, true, false);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let seq = 0;
// Conduce un hilo y devuelve, turno a turno, el `selectedService` que quedó en la sesión.
async function hilo(turnos, { conNombre = false } = {}) {
    const phone = `346007${String(1000 + seq++).slice(-4)}@c.us`;
    const s = createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    s.orgType = 'salon';
    s.leadId = 'ct';
    s.language = 'es';
    s.spaPromoOffered = true;
    if (conNombre) {
        s.nombreGuardado = true;
        s.partialData = { ...s.partialData, nombre: 'Nuria Pons', telefono: phone.replace(/\D/g, '') };
    }
    userSessions.set(sessionKey(ORG, phone), s);

    const elegidos = [];
    for (const texto of turnos) {
        const viva = userSessions.get(sessionKey(ORG, phone));
        if (viva?.lastMessageTime) viva.lastMessageTime -= 5000;
        await bot.handleIncomingMessage({
            sendMessage: async () => ({ id: { _serialized: `wamid.X${seq}` } }),
            getChatById: async () => ({ sendStateTyping: async () => {} }),
        }, {
            from: phone, body: texto, id: { _serialized: `wamid.CN${Date.now()}_${seq++}` },
            fromMe: false, timestamp: Date.now(), isStatus: false, isBroadcast: false,
            hasMedia: false, type: 'chat',
            getChat: async () => ({ sendStateTyping: async () => {} }),
            getContact: async () => ({ number: phone.replace(/\D/g, '') }),
        }, ORG);
        await I.flushBuffer(ORG, phone);
        await new Promise(r => setTimeout(r, 250));
        const svc = userSessions.get(sessionKey(ORG, phone))?.selectedService;
        elegidos.push({ texto, servicio: svc ? svc.nombre : null });
    }
    return elegidos;
}

const pinta = pasos => pasos.map(p => `"${p.texto}" → ${p.servicio || '—'}`).join('\n     ');

// ─── 1 · La sonda que llega: el plural suelto ───────────────────────────────────────

test('«tratamientos» NO puede acabar eligiendo el complemento', async () => {
    for (const sonda of ['quiero tratamientos', 'tratamientos', `quiero un ${COMPLEMENTO.toLowerCase()}`]) {
        const pasos = await hilo(['hola, soy Nuria', sonda]);
        const malo = pasos.find(p => p.servicio === COMPLEMENTO);
        assert.ok(!malo, `el complemento quedó elegido:\n     ${pinta(pasos)}`);
    }
});

test('tampoco con el nombre ya guardado (el otro estado de sesión)', async () => {
    const pasos = await hilo(['quiero tratamientos'], { conNombre: true });
    assert.ok(!pasos.some(p => p.servicio === COMPLEMENTO), `\n     ${pinta(pasos)}`);
});

// ─── 2 · Y no se queda pegado: el turno siguiente sigue pudiendo elegir ──────────────

test('el hilo entero: ni un turno cae en el complemento, y el peinado real SÍ se elige', async () => {
    // Sin el filtro, el complemento se elige en el 2º turno y SE QUEDA: el bloque de
    // detección libre está gateado por `if (!session.selectedService)`, así que «el de
    // ondas» ya no rescata nada. Por eso se mira el hilo entero y no solo el último turno.
    const pasos = await hilo(['hola, soy Nuria', 'quiero tratamientos', 'mejor quiero un peinado', 'el de ondas']);
    assert.ok(!pasos.some(p => p.servicio === COMPLEMENTO),
        `algún turno cayó en el complemento:\n     ${pinta(pasos)}`);
    assert.strictEqual(pasos[pasos.length - 1].servicio, 'Peinado de ondas',
        `el filtro se ha comido la categoría: no queda peinado que elegir\n     ${pinta(pasos)}`);
});

// ─── 3 · CONTROL · lo que NO puede romperse al filtrar ──────────────────────────────

test('CONTROL · los servicios normales se siguen eligiendo igual', async () => {
    const casos = [
        ['quiero el elixir de prueba', 'Elixir de prueba'],
        ['quiero un peinado de gala', 'Peinado de gala'],
        ['lavar y secar', 'Lavar y secar'],
    ];
    for (const [texto, esperado] of casos) {
        const pasos = await hilo(['hola, soy Nuria', texto]);
        assert.strictEqual(pasos[1].servicio, esperado,
            `el filtro rompió una selección normal:\n     ${pinta(pasos)}`);
    }
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
