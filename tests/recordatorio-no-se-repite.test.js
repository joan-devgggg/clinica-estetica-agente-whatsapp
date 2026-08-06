// Un recordatorio ENTREGADO y sin apuntar no se vuelve a mandar (06/08/2026).
//
// Gemelo del 🟠 3 de docs/auditoria-afirmar-sin-verificar.md, que se arregló en las reseñas y
// quedó apuntado aquí. Con una diferencia que lo hacía MÁS silencioso: `marcarRecordatorioSent`
// no lanzaba — hacía el UPDATE y devolvía `true` sin mirar el error ni cuántas filas tocó. O
// sea que un marcado perdido no abortaba nada, parecía ir bien, y el tic siguiente (5 min)
// volvía a encontrar la ficha pendiente y le mandaba OTRO recordatorio. Y otro. Sin un log.
//
// Lo que se congela aquí:
//   A · db.marcarRecordatorioSent verifica la escritura (antes decía que sí siempre).
//   B · el worker reintenta el MARCADO, nunca el envío, y avisa si no puede.
//   C · un fallo en una ficha no se lleva por delante a las siguientes.
//
// Hermético: sin red, sin LLM, sin Supabase real.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');

const SANTE_ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// ─── Stubs, antes de requerir nada ──────────────────────────────────────────────────────

let avisos = [];
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        notifyOrgAdmin: async (orgId, mensaje) => { avisos.push({ orgId, mensaje }); return true; },
        notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {},
    },
};

// Supabase falso para el bloque A: se controla qué devuelve el UPDATE de `contacts`.
let respuestaUpdate = { data: [{ id: 'c1' }], error: null };
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: {
        from() {
            const q = { op: null };
            const b = {
                select: () => b, eq: () => b, is: () => b, in: () => b, order: () => b, limit: () => b,
                update: () => { q.op = 'update'; return b; },
                insert: () => b, upsert: () => b,
                single: async () => ({ data: null, error: null }),
                maybeSingle: async () => ({ data: null, error: null }),
                then: (f, r) => Promise.resolve(
                    q.op === 'update' ? respuestaUpdate : { data: [], error: null }).then(f, r),
            };
            return b;
        },
    },
};

const db = require('../services/db');
const { _resetThrottle } = require('../services/admin-alerts');

// La función REAL, guardada antes de que el bloque B la sustituya por su doble. El bloque A
// afirma su contrato (que verifica la escritura); el B necesita controlar cuándo falla.
const marcarReal = db.marcarRecordatorioSent;

// El worker: stubs de db ANTES de requerirlo (desestructura al cargarse).
let pendientes = [];
let enviados = [];
let marcados = [];
let idsQueFallan = new Set();
let intentosMarcado = 0;

db.getConfigValue = async (_o, clave) => (clave === 'horas_recordatorio' ? 24 : null);
db.getAgentConfig = async () => ({ business_info: { companyName: 'Sante Healthy Hair Salon' } });
db.getAppointmentsPendientesRecordatorio = async () => pendientes;
db.autoCompleteAppointments = async () => [];
db.marcarRecordatorioSent = async (_o, id) => {
    intentosMarcado++;
    if (idsQueFallan.has(id)) throw new Error('contacts: no encontró la fila: nada guardado');
    marcados.push(id);
    // La fila SÍ se escribió: deja de estar pendiente, como en producción.
    pendientes = pendientes.filter(r => r.id !== id);
    return true;
};

const outboundPath = require.resolve('../services/outbound');
const realOutbound = require(outboundPath);
require.cache[outboundPath].exports = {
    ...realOutbound,
    resolveOutboundClient: (_o, fallback) => fallback,
    resolveAutomatedSend: async () => ({ mode: 'free_text' }),
};

const reminder = require('../services/reminder');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function cita(id, nombre) {
    const d = new Date(Date.now() + 20 * 60 * 60 * 1000);   // dentro de la ventana de 24 h
    return {
        id, nombre, telefono: `3460000000${id.slice(-1)}`, language: 'es', wa_jid: null,
        fecha_cita: d.toISOString().slice(0, 10),
        hora_cita: String(d.getHours()).padStart(2, '0') + ':00',
    };
}

function arrancar() {
    avisos = []; enviados = []; marcados = []; intentosMarcado = 0;
    idsQueFallan = new Set();
    pendientes = [cita('c1', 'Ana')];
    _resetThrottle();
    reminder._resetPendientesDeMarcar();
    reminder.setClients(new Map([[SANTE_ORG, {
        client: {
            sendMessage: async (chatId, texto) => { enviados.push({ chatId, texto }); },
            sendTemplate: async (chatId) => { enviados.push({ chatId, plantilla: true }); },
        },
        orgId: SANTE_ORG,
    }]]));
}

// ─── A · db.marcarRecordatorioSent deja de decir que sí siempre ─────────────────────────

test('A1 · REGRESIÓN · un UPDATE que no toca ninguna fila ya NO devuelve true', async () => {
    respuestaUpdate = { data: [], error: null };
    await assert.rejects(() => marcarReal(SANTE_ORG, 'c1'), /nada guardado|no encontró/i,
        'devolvía true sin mirar nada: un marcado perdido era indistinguible de uno correcto');
});

test('A2 · un error de Supabase tampoco pasa por bueno', async () => {
    respuestaUpdate = { data: null, error: { message: 'TypeError: fetch failed', code: '' } };
    await assert.rejects(() => marcarReal(SANTE_ORG, 'c1'), /contacts/);
});

test('A3 · CONTROL · el camino bueno sigue devolviendo true', async () => {
    respuestaUpdate = { data: [{ id: 'c1' }], error: null };
    assert.strictEqual(await marcarReal(SANTE_ORG, 'c1'), true);
});

// ─── B · El worker: se reintenta el marcado, nunca el envío ─────────────────────────────

test('B1 · REGRESIÓN · enviado y sin poder marcar: el tic siguiente NO lo reenvía', async () => {
    arrancar();
    idsQueFallan.add('c1');

    await reminder.checkAndSendReminders();
    assert.strictEqual(enviados.length, 1, 'el primer tic sí lo manda');
    assert.strictEqual(marcados.length, 0, 'y el marcado no llegó a escribirse');
    assert.strictEqual(pendientes.length, 1, 'la ficha sigue pendiente en BD: esa es la trampa');

    await reminder.checkAndSendReminders();
    await reminder.checkAndSendReminders();
    assert.strictEqual(enviados.length, 1,
        'antes cada tic de 5 min le mandaba el recordatorio otra vez, indefinidamente');
});

test('B2 · y en cuanto la escritura funciona, queda apuntado sin reenviar', async () => {
    arrancar();
    idsQueFallan.add('c1');
    await reminder.checkAndSendReminders();

    idsQueFallan.clear();
    await reminder.checkAndSendReminders();

    assert.deepStrictEqual(marcados, ['c1']);
    assert.strictEqual(enviados.length, 1, 'un solo mensaje en total');
});

test('B3 · el marcado se reintenta dentro del mismo tic antes de rendirse', async () => {
    arrancar();
    idsQueFallan.add('c1');
    await reminder.checkAndSendReminders();
    assert.ok(intentosMarcado >= 3, `un solo intento no distingue un error transitorio (hubo ${intentosMarcado})`);
});

test('B4 · si no se pudo apuntar, se entera una persona', async () => {
    arrancar();
    idsQueFallan.add('c1');
    await reminder.checkAndSendReminders();

    assert.strictEqual(avisos.length, 1, 'esto no puede quedarse en un log');
    assert.ok(/recordatorio/i.test(avisos[0].mensaje));
    assert.ok(/Ana/.test(avisos[0].mensaje), 'y con el nombre, para poder buscarla');

    await reminder.checkAndSendReminders();
    assert.strictEqual(avisos.length, 1, 'un aviso por ficha, no uno por tic');
});

// ─── C · Un fallo no se lleva por delante a las demás ───────────────────────────────────

// ⚠️ ALCANCE DE ESTE BLOQUE, medido y no supuesto. Lo que afirma es que un marcado fallido no
// deja sin recordatorio a las clientas siguientes — que es la forma exacta del bug de reseñas.
// Lo que NO puede afirmar hoy es el `try/catch` por contacto: con
// `marcarRecordatorioConReintentos` en su sitio, esa función NO lanza nunca (se traga el error
// y devuelve false), así que ningún test distingue si el try está o no. Comprobado quitando la
// memoria y los reintentos: con el `marcarRecordatorioSent` directo, que sí lanza, este test
// vuelve a depender del try y lo caza. O sea que el try es cinturón sobre tirantes: cubre el
// día que alguien vuelva a poner una llamada que lance, no el código de hoy.
test('C1 · REGRESIÓN · el fallo de una ficha no deja sin recordatorio a las siguientes', async () => {
    arrancar();
    pendientes = [cita('c1', 'Ana'), cita('c2', 'Berta'), cita('c3', 'Carla')];
    idsQueFallan.add('c1');

    await reminder.checkAndSendReminders();

    assert.strictEqual(enviados.length, 3, 'las tres reciben su recordatorio');
    assert.deepStrictEqual(marcados, ['c2', 'c3'], 'y solo se apunta lo que se pudo apuntar');
});

test('C2 · camino normal: un envío, un marcado, y desaparece de la cola', async () => {
    arrancar();
    await reminder.checkAndSendReminders();
    assert.strictEqual(enviados.length, 1);
    assert.deepStrictEqual(marcados, ['c1']);
    assert.strictEqual(avisos.length, 0, 'sin fallo no se molesta a nadie');

    await reminder.checkAndSendReminders();
    assert.strictEqual(enviados.length, 1, 'ya no está pendiente');
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
