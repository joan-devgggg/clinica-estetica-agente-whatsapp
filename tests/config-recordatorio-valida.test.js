// Un `horas_recordatorio` que no es un número no manda nada (06/08/2026).
//
// Hallazgo 🟠 3 de docs/auditoria-defaults-silenciosos-2.md. `getConfigValue` hace `JSON.parse`
// y, si falla, devuelve la cadena tal cual: un «24 horas» escrito a mano —o desde el panel, que
// desde el 05/08/2026 deja editar el campo— pasaba entero hasta aquí:
//
//     const minutosAntes = Number('24 horas');           // NaN
//     if (minutosRestantes > minutosAntes) continue;     // NaN → false → NO descarta nada
//
// No es que la ventana se quedara corta: es que la guarda se DESARMABA. Un solo tic mandaba el
// recordatorio de TODAS las citas futuras de la org, las marcaba como enviadas, y el día de
// antes ya no salía ninguna. `getLeadsPendientesRecordatorio` no acota por fecha: esa
// comparación era el único límite que había.
//
// Tres bloques:
//   A · el validador puro (helpers) — es la fuente única, la usan panel y worker.
//   B · escribir: PUT /api/config/:clave rechaza con 400 y NO escribe.
//   C · leer: el worker no manda NADA con una ventana que no entiende, y avisa.
//
// Hermético: sin red, sin LLM, sin Supabase.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const http = require('http');

const SANTE_ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// ─── Stubs, antes de requerir nada ──────────────────────────────────────────────────────

let avisos = [];
let notificar = async (orgId, mensaje) => { avisos.push({ orgId, mensaje }); return true; };
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        notifyOrgAdmin: (o, m) => notificar(o, m),
        notifyBlacklistAlert: async () => {},
        startTelegramBot: () => {},
        notifyEscalation: async () => {},
    },
};

// Supabase falso: registra los upsert de `config` para poder afirmar que un valor rechazado
// no llega a escribirse.
const upserts = [];
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: {
        from(tabla) {
            const b = {
                select: () => b, eq: () => b, is: () => b, in: () => b, order: () => b, limit: () => b,
                update: () => b, insert: () => b,
                upsert: (payload) => { upserts.push({ tabla, payload }); return b; },
                single: async () => ({ data: null, error: null }),
                maybeSingle: async () => ({ data: null, error: null }),
                then: (f, r) => Promise.resolve({ data: [], error: null }).then(f, r),
            };
            return b;
        },
    },
};

const { validateConfigValue, resolveReminderWindowMin } = require('../services/helpers');
const { _resetThrottle } = require('../services/admin-alerts');
const db = require('../services/db');

// ⚠️ Los stubs de db van ANTES de requerir reminder.js: ese módulo DESESTRUCTURA sus funciones
// al cargarse, así que una asignación posterior sobre `db.*` no le llegaría. Se descubrió
// porque C1 pasaba en vacío — el worker no mandaba nada, pero porque no veía ninguna cita.
let configFalsa = {};
let pendientes = [];
let enviados = [];
let marcados = [];

db.getConfigValue = async (_o, clave) => (clave in configFalsa ? configFalsa[clave] : null);
db.getAgentConfig = async () => ({ business_info: { companyName: 'Sante Healthy Hair Salon' } });
db.getAppointmentsPendientesRecordatorio = async () => pendientes;
db.marcarRecordatorioSent = async (_o, id) => { marcados.push(id); return true; };
db.autoCompleteAppointments = async () => [];
db.authenticateToken = async (t) => (t === 'sante-token' ? { userId: 'u1', orgId: SANTE_ORG } : null);

// outbound: Sante va por Cloud API, así que sin plantilla configurada `resolveAutomatedSend`
// devolvería 'sin_plantilla' y no saldría nada — por el motivo correcto, pero por otro motivo.
// Este test va de la VENTANA, no de las plantillas: se fija en texto libre. (Mismo require.cache
// y por la misma razón que arriba: reminder.js también desestructura estas dos.)
const outboundPath = require.resolve('../services/outbound');
const realOutbound = require(outboundPath);
require.cache[outboundPath].exports = {
    ...realOutbound,
    resolveOutboundClient: (_o, fallback) => fallback,
    resolveAutomatedSend: async () => ({ mode: 'free_text' }),
};

const reminder = require('../services/reminder');
const { app } = require('../webhook');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── A · El validador ───────────────────────────────────────────────────────────────────

test('A1 · acepta el número y la cadena que SOLO contiene un número (lo que manda un input)', () => {
    for (const [valor, esperado] of [[1440, 1440], ['1440', 1440], [24, 24], ['24', 24], [0, 0], ['0', 0]]) {
        const r = validateConfigValue('minutos_recordatorio', valor);
        assert.strictEqual(r.ok, true, `rechazó ${JSON.stringify(valor)}`);
        assert.strictEqual(r.valor, esperado, 'y lo normaliza a número');
        assert.strictEqual(typeof r.valor, 'number');
    }
});

test('A2 · REGRESIÓN · rechaza lo que daba NaN, que es lo que desarmaba la guarda', () => {
    for (const valor of ['24 horas', 'veinticuatro', '24h', 'sí', true, false, {}, [], '', '   ', null, undefined]) {
        const r = validateConfigValue('horas_recordatorio', valor);
        assert.strictEqual(r.ok, false, `aceptó ${JSON.stringify(valor)}`);
        assert.ok(r.mensaje && /número/i.test(r.mensaje), 'el mensaje tiene que servirle a quien lo edita');
    }
});

test('A3 · rechaza negativos y valores absurdos (un mes de ventana es el mismo daño)', () => {
    assert.strictEqual(validateConfigValue('horas_recordatorio', -1).motivo, 'negativo');
    assert.strictEqual(validateConfigValue('minutos_recordatorio', 100000).motivo, 'fuera_de_rango');
    assert.strictEqual(validateConfigValue('dias_retorno_auto', 5000).motivo, 'fuera_de_rango');
});

test('A4 · las claves que NO son numéricas pasan sin tocar', () => {
    for (const [clave, valor] of [['bot_activo', true], ['telegram_admins', [1, 2]], ['plantilla_resena', { es: 'x' }]]) {
        const r = validateConfigValue(clave, valor);
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(r.valor, valor, 'no se normaliza lo que no es un número');
    }
});

test('A5 · ausente NO es lo mismo que inválido: sin las dos claves sigue el default de 1440', () => {
    assert.deepStrictEqual(resolveReminderWindowMin({}), { ok: true, minutos: 1440, via: 'default' });
    assert.deepStrictEqual(resolveReminderWindowMin({ minutos: null, horas: null }),
        { ok: true, minutos: 1440, via: 'default' });
});

test('A6 · un valor inválido NO cae al de al lado ni al default', () => {
    // Enterrar el error justo cuando hay que enseñarlo sería repetir el problema con otra cara.
    const r = resolveReminderWindowMin({ minutos: '24 horas', horas: 24 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.clave, 'minutos_recordatorio');
});

test('A7 · minutos manda sobre horas, y horas se convierte (no se ha roto lo de antes)', () => {
    assert.deepStrictEqual(resolveReminderWindowMin({ minutos: 30, horas: 24 }), { ok: true, minutos: 30, via: 'minutos' });
    assert.deepStrictEqual(resolveReminderWindowMin({ horas: 24 }), { ok: true, minutos: 1440, via: 'horas' });
});

// ─── B · Escribir · PUT /api/config/:clave ──────────────────────────────────────────────

function request(server, { clave, valor, token = 'sante-token' }) {
    const { port } = server.address();
    const payload = JSON.stringify({ valor });
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, method: 'PUT', path: `/api/config/${clave}`,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

async function conServidor(fn) {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    try { await fn(server); } finally { server.close(); }
}

test('B1 · REGRESIÓN · "24 horas" se rechaza con 400 y NO se escribe nada', async () => {
    await conServidor(async (server) => {
        upserts.length = 0;
        const r = await request(server, { clave: 'horas_recordatorio', valor: '24 horas' });
        assert.strictEqual(r.status, 400);
        assert.ok(/número/i.test(r.body.error), `mensaje poco útil: ${r.body.error}`);
        assert.strictEqual(r.body.motivo, 'no_numerico');
        assert.strictEqual(upserts.filter(u => u.tabla === 'config').length, 0,
            'un valor que desarma la guarda no puede llegar a la tabla');
    });
});

test('B2 · CONTROL · un número válido sí se guarda, y normalizado', async () => {
    await conServidor(async (server) => {
        upserts.length = 0;
        const r = await request(server, { clave: 'horas_recordatorio', valor: '24' });
        assert.strictEqual(r.status, 200);
        const fila = upserts.find(u => u.tabla === 'config');
        assert.ok(fila, 'sin esto, B1 no demuestra nada');
        assert.strictEqual(fila.payload.valor, '24', 'se guarda el número, no la cadena del formulario');
        assert.strictEqual(fila.payload.clave, 'horas_recordatorio');
    });
});

test('B3 · una clave no numérica sigue pasando como siempre', async () => {
    await conServidor(async (server) => {
        upserts.length = 0;
        const r = await request(server, { clave: 'horas_resena', valor: 2 });
        assert.strictEqual(r.status, 200);
        const r2 = await request(server, { clave: 'plantilla_resena', valor: { es: 'sante_solicitud_resena' } });
        assert.strictEqual(r2.status, 200, 'las plantillas no son números y no se tocan');
    });
});

// ─── C · Leer · el worker no manda nada con una ventana que no entiende ─────────────────

function citaManana(over = {}) {
    const d = new Date(Date.now() + 20 * 60 * 60 * 1000); // dentro de 20 h → cae en la ventana de 24
    return {
        id: 'c1', nombre: 'Ana', telefono: '34600000001', language: 'es', wa_jid: null,
        fecha_cita: d.toISOString().slice(0, 10),
        hora_cita: String(d.getHours()).padStart(2, '0') + ':00',
        ...over,
    };
}

// Una cita MUY lejana: con la guarda sana se descarta; con NaN se mandaba igual.
function citaDentroDeUnMes() {
    const d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    return citaManana({
        id: 'c2', nombre: 'Berta', telefono: '34600000002',
        fecha_cita: d.toISOString().slice(0, 10), hora_cita: '12:00',
    });
}

function arrancarWorker() {
    avisos = []; enviados = []; marcados = []; configFalsa = {};
    _resetThrottle();
    reminder.setClients(new Map([[SANTE_ORG, {
        client: {
            sendMessage: async (chatId, texto) => { enviados.push({ chatId, texto }); },
            sendTemplate: async (chatId) => { enviados.push({ chatId, plantilla: true }); },
        },
        orgId: SANTE_ORG,
    }]]));
}

test('C1 · REGRESIÓN · con "24 horas" no sale NI UN recordatorio (antes salían todos)', async () => {
    arrancarWorker();
    configFalsa = { horas_recordatorio: '24 horas' };
    pendientes = [citaManana(), citaDentroDeUnMes()];

    await reminder.checkAndSendReminders();

    assert.strictEqual(enviados.length, 0,
        'la de dentro de un mes es la que delata el NaN: con la guarda desarmada también salía');
    assert.strictEqual(marcados.length, 0, 'y nada queda marcado como enviado');
});

test('C2 · y se entera una persona, con qué campo y qué poner', async () => {
    arrancarWorker();
    configFalsa = { horas_recordatorio: 'veinticuatro' };
    pendientes = [citaManana()];

    await reminder.checkAndSendReminders();

    assert.strictEqual(avisos.length, 1, 'esto no puede quedarse en un log');
    assert.ok(/horas_recordatorio/.test(avisos[0].mensaje), 'dice QUÉ campo');
    assert.ok(/veinticuatro/.test(avisos[0].mensaje), 'y con qué valor está');
    assert.ok(/no se ha perdido ninguna/i.test(avisos[0].mensaje),
        'y que las citas siguen pendientes: si no, se entiende como pérdida de datos');

    // Throttle: el tic siguiente (5 min) no repite el aviso.
    await reminder.checkAndSendReminders();
    assert.strictEqual(avisos.length, 1);
});

test('C3 · si lo corrige a otro valor malo, el aviso VUELVE a salir', async () => {
    arrancarWorker();
    configFalsa = { horas_recordatorio: 'veinticuatro' };
    pendientes = [citaManana()];
    await reminder.checkAndSendReminders();
    assert.strictEqual(avisos.length, 1);

    configFalsa = { horas_recordatorio: '24h' };   // lo intenta de nuevo y falla de otra forma
    await reminder.checkAndSendReminders();
    assert.strictEqual(avisos.length, 2, 'el throttle es por clave Y valor, no solo por clave');
});

test('C4 · CONTROL · con un número válido sale el recordatorio de la cita cercana y solo esa', async () => {
    arrancarWorker();
    configFalsa = { horas_recordatorio: 24 };
    pendientes = [citaManana(), citaDentroDeUnMes()];

    await reminder.checkAndSendReminders();

    assert.strictEqual(enviados.length, 1, 'sin esto, C1 pasaría con el worker roto');
    assert.ok(enviados[0].texto.includes('Ana'), 'la de dentro de 20 h');
    assert.deepStrictEqual(marcados, ['c1']);
    assert.strictEqual(avisos.length, 0);
});

test('C5 · sin ninguna de las dos claves sigue funcionando con el default de 24 h', async () => {
    arrancarWorker();
    configFalsa = {};                     // ni minutos_recordatorio ni horas_recordatorio
    pendientes = [citaManana(), citaDentroDeUnMes()];

    await reminder.checkAndSendReminders();

    assert.strictEqual(enviados.length, 1, 'ausente no es inválido: el default declarado sigue');
    assert.strictEqual(avisos.length, 0, 'y no se molesta a nadie por no haber configurado nada');
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
