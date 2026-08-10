// Fase 2 de la migración a 360dialog: recordatorio y reseña por PLANTILLA aprobada
// cuando el contacto está fuera de la ventana de 24 h de Cloud API.
//
// Esto NO reconstruye el mensaje a mano: ejecuta el MOTOR REAL de los workers
// (checkAndSendReminders / checkAndSendReviews) con `services/db` stubeado y
// `global.fetch` capturado, y verifica el payload HTTP EXACTO que viajaría a
// 360dialog — nombre de plantilla y parámetros en el orden aprobado por Meta.
// Nada sale a WhatsApp real. Mismo patrón que threesixty-dialog.test.js ("Fase 1").
process.env.TZ = 'Europe/Madrid';
process.env.SANTE_360_API_KEY = 'test-key-360';
process.env.SANTE_360_PHONE_NUMBER_ID = '111222333';
process.env.WHATSAPP_360_BASE_URL = 'https://waba-v2.360dialog.io';

const assert = require('assert');
const { SANTE_ORG_ID, SANREMO_ORG_ID } = require('../services/org-registry');
const { build360Client } = require('../services/providers/threesixty-dialog');
const { formatReminderWhen } = require('../services/helpers');

// db.js requiere el cliente Supabase real. Se stubea services/supabase ANTES de
// requerir db para poder cargar db de verdad y quedarnos con isWithin24hWindow (que
// es lógica bajo prueba, no un doble), y luego se sustituye el módulo db entero por
// un stub con estado controlable. Mismo truco de require.cache que db-contracts.test.js.
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };

const dbPath = require.resolve('../services/db');
const { isWithin24hWindow } = require(dbPath);

const REVIEW_LINK = 'https://maps.app.goo.gl/PGdw5KeetLKbbdk18';
const HORA_CITA = '17:30';

// Estado del stub, reseteado en cada escenario.
let state;

function resetState() {
    state = {
        config: {
            [SANTE_ORG_ID]: {
                horas_recordatorio: 24,
                horas_resena: 2,
                plantilla_recordatorio: { es: { name: 'sante_recordatorio_cita', language: 'es' } },
                plantilla_resena: { es: { name: 'sante_solicitud_resena', language: 'es' } },
            },
            [SANREMO_ORG_ID]: { minutos_recordatorio: 1440, horas_resena: 2 },
        },
        lastInbound: {},          // telefono → ISO | null
        pendientesRecordatorio: {},
        pendientesResena: {},
        marcados: [],             // llamadas a marcarRecordatorioSent
        resenasMarcadas: [],      // llamadas a updateAppointment({resenaEnviada})
        warns: [],
    };
}

const dbStub = {
    isWithin24hWindow,            // implementación REAL
    async getLastInboundAt(_orgId, telefono) { return state.lastInbound[telefono] ?? null; },
    async getConfigValue(orgId, clave) {
        const v = state.config[orgId]?.[clave];
        return v === undefined ? null : v;
    },
    async getAgentConfig(orgId) {
        return {
            business_info: {
                companyName: orgId === SANTE_ORG_ID ? 'Sante Healthy Hair Salon' : 'Restaurante San Remo',
                googleReviewLink: REVIEW_LINK,
            },
        };
    },
    async autoCompleteAppointments() { return 0; },
    async getAppointmentsPendientesRecordatorio(orgId) { return state.pendientesRecordatorio[orgId] || []; },
    async marcarRecordatorioSent(orgId, id) { state.marcados.push({ orgId, id }); return true; },
    async getCompletedAppointmentsForReview(orgId) { return state.pendientesResena[orgId] || []; },
    async updateAppointment(orgId, id, patch) { state.resenasMarcadas.push({ orgId, id, patch }); return true; },
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };

// El logger real escribe a stdout; capturamos los warn para poder afirmar que el caso
// "sin plantilla" avisa en vez de fallar en silencio.
const loggerPath = require.resolve('../lib/logger');
const realLogger = require(loggerPath);
require.cache[loggerPath].exports = {
    ...realLogger,
    warn: (evento, meta) => { state.warns.push({ evento, meta }); },
    info: () => {},
    error: () => {},
};

const reminder = require('../services/reminder');
const review = require('../services/review');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── Helpers ─────────────────────────────────────────────────────────────────

const horasAtras = h => new Date(Date.now() - h * 3600 * 1000).toISOString();

// Fecha/hora local de una cita dentro de la ventana de disparo del recordatorio.
function citaEnHoras(h) {
    const d = new Date(Date.now() + h * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    return {
        fecha_cita: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
        hora_cita: `${p(d.getHours())}:${p(d.getMinutes())}`,
    };
}

function contactoPendiente({ telefono = '34600111222', nombre = 'María López', language = 'es' } = {}) {
    return { id: 'contact-1', telefono, nombre, language, wa_jid: null, ...citaEnHoras(2) };
}

function citaCompletada({ telefono = '34600111222', nombre = 'María López', language = 'es' } = {}) {
    return {
        id: 'apt-1',
        contacts: { id: 'contact-1', wa_phone: telefono, full_name: nombre, language, metadata: {} },
    };
}

// Fake de whatsapp-web.js para San Remo: registra envíos, ningún Puppeteer real.
function fakeWwebjsClient(sink) {
    return {
        async sendMessage(jid, text) { sink.push({ jid, text }); return { id: 'wweb-1' }; },
        getChatById() { return { sendStateTyping: async () => {} }; },
    };
}

// Ejecuta un worker con fetch capturado. Devuelve todas las peticiones HTTP salientes.
async function runWorker(fn, clients) {
    const original = global.fetch;
    const requests = [];
    global.fetch = async (url, opts) => {
        requests.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) };
    };
    try { await fn(clients); }
    finally { global.fetch = original; }
    return requests;
}

function santeClients(extra = null) {
    const map = new Map([[SANTE_ORG_ID, { client: build360Client(SANTE_ORG_ID), orgId: SANTE_ORG_ID }]]);
    if (extra) map.set(extra.orgId, extra);
    return map;
}

async function correrRecordatorio(clients) {
    return runWorker(async c => { reminder.setClients(c); await reminder.checkAndSendReminders(); }, clients);
}
async function correrResena(clients) {
    return runWorker(async c => { review.setClients(c); await review.checkAndSendReviews(); }, clients);
}

// ─── Recordatorio ────────────────────────────────────────────────────────────

test('recordatorio DENTRO de la ventana de 24h: sigue en texto libre', async () => {
    resetState();
    state.lastInbound['34600111222'] = horasAtras(1);
    state.pendientesRecordatorio[SANTE_ORG_ID] = [contactoPendiente()];

    const reqs = await correrRecordatorio(santeClients());

    assert.strictEqual(reqs.length, 1);
    assert.strictEqual(reqs[0].body.type, 'text');
    assert.ok(reqs[0].body.text.body.includes('María López'));
    assert.ok(reqs[0].body.text.body.includes('Sante Healthy Hair Salon'));
    assert.strictEqual(state.marcados.length, 1, 'marca recordatorio_enviado');
});

test('recordatorio FUERA de la ventana: plantilla sante_recordatorio_cita con {{1}}=nombre {{2}}=cuándo', async () => {
    resetState();
    state.lastInbound['34600111222'] = horasAtras(30);
    const pendiente = contactoPendiente();
    state.pendientesRecordatorio[SANTE_ORG_ID] = [pendiente];

    const reqs = await correrRecordatorio(santeClients());

    assert.strictEqual(reqs.length, 1, 'una sola petición');
    assert.strictEqual(reqs[0].url, 'https://waba-v2.360dialog.io/messages');
    assert.strictEqual(reqs[0].headers['D360-API-KEY'], 'test-key-360');
    const body = reqs[0].body;
    assert.strictEqual(body.to, '34600111222');
    assert.strictEqual(body.type, 'template');
    assert.strictEqual(body.text, undefined, 'no debe llevar texto libre');
    assert.strictEqual(body.template.name, 'sante_recordatorio_cita');
    assert.deepStrictEqual(body.template.language, { code: 'es' });
    // {{2}} lleva la hora Y su fecha desde el 10/08/2026. La forma exacta de esa frase, en los
    // cuatro idiomas, la fija tests/recordatorio-con-fecha.test.js; lo que se comprueba aquí es
    // que viaja en el parámetro que Meta aprobó, sin plantilla nueva.
    assert.deepStrictEqual(body.template.components[0].parameters, [
        { type: 'text', text: 'María López' },
        { type: 'text', text: formatReminderWhen(pendiente.fecha_cita, pendiente.hora_cita, 'es') },
    ]);
    assert.strictEqual(state.marcados.length, 1, 'marca recordatorio_enviado');
});

test('recordatorio sin NINGÚN entrante previo: plantilla (lado seguro)', async () => {
    resetState();
    state.pendientesRecordatorio[SANTE_ORG_ID] = [contactoPendiente()];

    const reqs = await correrRecordatorio(santeClients());

    assert.strictEqual(reqs[0].body.type, 'template');
    assert.strictEqual(reqs[0].body.template.name, 'sante_recordatorio_cita');
});

test('contacto RU sin plantilla RU aprobada: cae a la plantilla es y se envía', async () => {
    resetState();
    state.lastInbound['34600111222'] = horasAtras(30);
    state.pendientesRecordatorio[SANTE_ORG_ID] = [contactoPendiente({ nombre: 'Anna', language: 'ru' })];

    const reqs = await correrRecordatorio(santeClients());

    assert.strictEqual(reqs.length, 1);
    assert.strictEqual(reqs[0].body.template.name, 'sante_recordatorio_cita');
    assert.deepStrictEqual(reqs[0].body.template.language, { code: 'es' });
    assert.strictEqual(reqs[0].body.template.components[0].parameters[0].text, 'Anna');
});

test('sin plantilla configurada: NO envía, NO marca enviado, y avisa', async () => {
    resetState();
    delete state.config[SANTE_ORG_ID].plantilla_recordatorio;
    state.lastInbound['34600111222'] = horasAtras(30);
    state.pendientesRecordatorio[SANTE_ORG_ID] = [contactoPendiente()];

    const reqs = await correrRecordatorio(santeClients());

    assert.strictEqual(reqs.length, 0, 'cero peticiones HTTP');
    assert.strictEqual(state.marcados.length, 0, 'la cita sigue pendiente para el próximo ciclo');
    assert.ok(
        state.warns.some(w => w.evento === 'recordatorio_sin_plantilla_configurada'),
        `esperaba el warn; hubo: ${JSON.stringify(state.warns)}`
    );
});

test('horas_recordatorio de Sante manda de verdad (antes era config muerta)', async () => {
    resetState();
    // Con horas_recordatorio=1, una cita a 2 h vista NO entra todavía en la ventana de aviso.
    state.config[SANTE_ORG_ID].horas_recordatorio = 1;
    state.lastInbound['34600111222'] = horasAtras(30);
    state.pendientesRecordatorio[SANTE_ORG_ID] = [contactoPendiente()];

    const reqs = await correrRecordatorio(santeClients());
    assert.strictEqual(reqs.length, 0, 'con 1h de antelación la cita de 2h aún no toca');

    // Y con 24 h (el valor real en config) sí sale.
    resetState();
    state.lastInbound['34600111222'] = horasAtras(30);
    state.pendientesRecordatorio[SANTE_ORG_ID] = [contactoPendiente()];
    const reqs2 = await correrRecordatorio(santeClients());
    assert.strictEqual(reqs2.length, 1);
});

// ─── Reseña ──────────────────────────────────────────────────────────────────

test('reseña DENTRO de la ventana: texto libre con el enlace de Google', async () => {
    resetState();
    state.lastInbound['34600111222'] = horasAtras(3);
    state.pendientesResena[SANTE_ORG_ID] = [citaCompletada()];

    const reqs = await correrResena(santeClients());

    assert.strictEqual(reqs.length, 1);
    assert.strictEqual(reqs[0].body.type, 'text');
    assert.ok(reqs[0].body.text.body.includes(REVIEW_LINK));
    assert.strictEqual(state.resenasMarcadas.length, 1);
    // `actor` firma la escritura en la cita (auditoría, migración 033): sin él, marcar la
    // reseña como enviada sería indistinguible de que lo hiciera una persona en el panel.
    assert.deepStrictEqual(state.resenasMarcadas[0].patch, { resenaEnviada: true, actor: 'worker:review' });
});

test('reseña FUERA de la ventana: plantilla sante_solicitud_resena con {{1}}=nombre {{2}}=enlace', async () => {
    resetState();
    state.lastInbound['34600111222'] = horasAtras(48);
    state.pendientesResena[SANTE_ORG_ID] = [citaCompletada()];

    const reqs = await correrResena(santeClients());

    assert.strictEqual(reqs.length, 1);
    const body = reqs[0].body;
    assert.strictEqual(body.type, 'template');
    assert.strictEqual(body.to, '34600111222');
    assert.strictEqual(body.template.name, 'sante_solicitud_resena');
    assert.deepStrictEqual(body.template.language, { code: 'es' });
    assert.deepStrictEqual(body.template.components[0].parameters, [
        { type: 'text', text: 'María López' },
        { type: 'text', text: REVIEW_LINK },
    ]);
    assert.strictEqual(state.resenasMarcadas.length, 1);
});

test('reseña sin plantilla configurada: NO envía, NO marca resena_enviada, y avisa', async () => {
    resetState();
    delete state.config[SANTE_ORG_ID].plantilla_resena;
    state.lastInbound['34600111222'] = horasAtras(48);
    state.pendientesResena[SANTE_ORG_ID] = [citaCompletada()];

    const reqs = await correrResena(santeClients());

    assert.strictEqual(reqs.length, 0);
    assert.strictEqual(state.resenasMarcadas.length, 0, 'la reseña sigue pendiente');
    assert.ok(state.warns.some(w => w.evento === 'resena_sin_plantilla_configurada'));
});

// ─── Regla de oro: San Remo intacto ──────────────────────────────────────────

test('San Remo (wwebjs): recordatorio en texto libre, sin tocar 360dialog ni plantillas', async () => {
    resetState();
    const enviados = [];
    state.pendientesRecordatorio[SANREMO_ORG_ID] = [contactoPendiente({ telefono: '34600999888', nombre: 'Alberto' })];

    const clients = new Map([[SANREMO_ORG_ID, {
        client: fakeWwebjsClient(enviados), orgId: SANREMO_ORG_ID,
    }]]);
    const reqs = await correrRecordatorio(clients);

    assert.strictEqual(reqs.length, 0, 'San Remo NO debe llamar a 360dialog');
    assert.strictEqual(enviados.length, 1, 'usa su cliente whatsapp-web.js');
    assert.strictEqual(enviados[0].jid, '34600999888@c.us');
    assert.ok(enviados[0].text.includes('Alberto'));
    assert.strictEqual(state.marcados.length, 1);
});

test('San Remo (wwebjs): reseña en texto libre aunque no tenga ninguna plantilla', async () => {
    resetState();
    const enviados = [];
    state.pendientesResena[SANREMO_ORG_ID] = [citaCompletada({ telefono: '34600999888', nombre: 'Alberto' })];

    const clients = new Map([[SANREMO_ORG_ID, {
        client: fakeWwebjsClient(enviados), orgId: SANREMO_ORG_ID,
    }]]);
    const reqs = await correrResena(clients);

    assert.strictEqual(reqs.length, 0);
    assert.strictEqual(enviados.length, 1);
    assert.ok(enviados[0].text.includes(REVIEW_LINK));
    assert.strictEqual(state.resenasMarcadas.length, 1);
});

test('las dos orgs en el mismo ciclo: Sante por plantilla, San Remo por wwebjs', async () => {
    resetState();
    const enviados = [];
    state.lastInbound['34600111222'] = horasAtras(30);
    state.pendientesRecordatorio[SANTE_ORG_ID] = [contactoPendiente()];
    state.pendientesRecordatorio[SANREMO_ORG_ID] = [contactoPendiente({ telefono: '34600999888', nombre: 'Alberto' })];

    const clients = santeClients({ client: fakeWwebjsClient(enviados), orgId: SANREMO_ORG_ID });
    const reqs = await correrRecordatorio(clients);

    assert.strictEqual(reqs.length, 1, 'solo Sante sale por 360dialog');
    assert.strictEqual(reqs[0].body.template.name, 'sante_recordatorio_cita');
    assert.strictEqual(enviados.length, 1, 'San Remo por su cliente wwebjs');
    assert.strictEqual(state.marcados.length, 2, 'ambos marcados como enviados');
});

// ─── isWithin24hWindow (unidad, implementación real) ─────────────────────────

test('isWithin24hWindow: bordes y entradas inválidas', () => {
    const ahora = Date.parse('2026-07-31T12:00:00.000Z');
    assert.strictEqual(isWithin24hWindow('2026-07-31T11:00:00.000Z', ahora), true);
    assert.strictEqual(isWithin24hWindow('2026-07-30T12:00:01.000Z', ahora), true, '23h59m59s: dentro');
    assert.strictEqual(isWithin24hWindow('2026-07-30T12:00:00.000Z', ahora), false, '24h exactas: fuera');
    assert.strictEqual(isWithin24hWindow('2026-07-29T12:00:00.000Z', ahora), false);
    assert.strictEqual(isWithin24hWindow(null, ahora), false, 'sin entrante → fuera');
    assert.strictEqual(isWithin24hWindow('no-es-fecha', ahora), false);
    assert.strictEqual(isWithin24hWindow(new Date(ahora - 1000), ahora), true, 'acepta Date');
});

(async () => {
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
    }
})();
