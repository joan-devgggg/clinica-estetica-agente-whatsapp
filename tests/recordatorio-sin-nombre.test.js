// Un automatismo sale BIEN o no sale (incidente 04/08/2026).
//
// Con `full_name` null el recordatorio salía de dos formas, las dos malas:
//   · texto libre → "Hola  😊 Te recordamos…" (doble espacio, por `${nombre || ''}`)
//   · plantilla   → {{1}} vacío, que Meta rechaza entera (132000). El envío falla, no se
//                   marca enviado, y el worker reintenta cada 5 minutos para siempre.
// Le tocaba a 34624184532, con cita al día siguiente y sin nombre en la ficha.
//
// Aquí se congela la puerta: sin nombre utilizable (o sin teléfono, o sin hora) NO se manda
// nada, se avisa al admin por Telegram UNA vez por cita, y la cita queda PENDIENTE — en
// cuanto le completen la ficha, el siguiente tic la manda sola.
//
// Ejecuta el MOTOR REAL (checkAndSendReminders) con db, logger y admin-alerts stubeados, y
// captura el fetch saliente: mismo patrón que plantillas-fuera-de-ventana.test.js.
process.env.TZ = 'Europe/Madrid';
process.env.SANTE_360_API_KEY = 'test-key-360';
process.env.SANTE_360_PHONE_NUMBER_ID = '111222333';
process.env.WHATSAPP_360_BASE_URL = 'https://waba-v2.360dialog.io';

const assert = require('assert');
const { SANTE_ORG_ID } = require('../services/org-registry');
const { build360Client } = require('../services/providers/threesixty-dialog');

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };

const dbPath = require.resolve('../services/db');
const { isWithin24hWindow } = require(dbPath);

let state;
function resetState() {
    state = {
        config: {
            [SANTE_ORG_ID]: {
                horas_recordatorio: 24,
                plantilla_recordatorio: { es: { name: 'sante_recordatorio_cita', language: 'es' } },
            },
        },
        lastInbound: {},
        pendientes: {},
        marcados: [],
        warns: [],
        alertas: [],       // { orgId, clave, mensaje }
    };
}

require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        isWithin24hWindow,
        async getLastInboundAt(_o, tel) { return state.lastInbound[tel] ?? null; },
        async getConfigValue(orgId, clave) {
            const v = state.config[orgId]?.[clave];
            return v === undefined ? null : v;
        },
        async getAgentConfig() { return { business_info: { companyName: 'Sante Healthy Hair Salon' } }; },
        async autoCompleteAppointments() { return 0; },
        async getAppointmentsPendientesRecordatorio(orgId) { return state.pendientes[orgId] || []; },
        async marcarRecordatorioSent(orgId, id) { state.marcados.push({ orgId, id }); return true; },
    },
};

// Stub de admin-alerts: evita cargar telegram.js (y node-telegram-bot-api) y deja
// afirmar sobre el aviso. El throttle REAL se prueba aparte, contra el módulo de verdad.
const alertsPath = require.resolve('../services/admin-alerts');
require.cache[alertsPath] = {
    id: alertsPath, filename: alertsPath, loaded: true,
    exports: {
        alertOnce(orgId, clave, mensaje) {
            if (state.alertas.some(a => a.clave === clave)) return false;
            state.alertas.push({ orgId, clave, mensaje });
            return true;
        },
        _resetThrottle() {},
    },
};

const loggerPath = require.resolve('../lib/logger');
const realLogger = require(loggerPath);
require.cache[loggerPath].exports = {
    ...realLogger,
    warn: (evento, meta) => { state.warns.push({ evento, meta }); },
    info: () => {}, error: () => {},
};

const reminder = require('../services/reminder');
const { isUsableName, formatReminderWhen } = require('../services/helpers');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const horasAtras = h => new Date(Date.now() - h * 3600 * 1000).toISOString();

function citaEnHoras(h) {
    const d = new Date(Date.now() + h * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    return {
        fecha_cita: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
        hora_cita: `${p(d.getHours())}:${p(d.getMinutes())}`,
    };
}

function pendiente(over = {}) {
    return {
        id: 'contact-1', telefono: '34624184532', nombre: null, language: 'es',
        wa_jid: null, ...citaEnHoras(2), ...over,
    };
}

async function correr() {
    const original = global.fetch;
    const requests = [];
    global.fetch = async (url, opts) => {
        requests.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) };
    };
    try {
        reminder.setClients(new Map([[SANTE_ORG_ID, { client: build360Client(SANTE_ORG_ID), orgId: SANTE_ORG_ID }]]));
        await reminder.checkAndSendReminders();
    } finally { global.fetch = original; }
    return requests;
}

// ─── isUsableName (helpers.js): la puerta NO puede ser isValidName a secas ───

test('isUsableName acepta los nombres REALES del CRM que isValidName rechaza', () => {
    // Filas reales de contacts el 04/08/2026. Si esto falla, 8 clientas dejan de recibir
    // recordatorio y Yulia recibe 8 avisos que no debería recibir.
    for (const n of ['Tiffany Dubois-Moiseaux', 'Marina Lyon (Blond)', 'Karima .IGHOUBA',
        'Alina Kirsanova(Kashuba)', 'Aleksandra Gajda-lin', 'Maria Jose   (mama Mar)']) {
        assert.ok(isUsableName(n), `debería aceptar: ${n}`);
    }
});

test('isUsableName acepta cirílico (185 clientas hablan ru/uk)', () => {
    for (const n of ['Людмила', 'Наталія Зінченко', 'Олена']) {
        assert.ok(isUsableName(n), `debería aceptar: ${n}`);
    }
});

test('isUsableName rechaza lo que dejaría un saludo roto', () => {
    for (const n of [null, undefined, '', '   ', 'a', '?', '-', 'null', 'undefined',
        'sin nombre', 'Cliente', 123, {}]) {
        assert.ok(!isUsableName(n), `debería rechazar: ${JSON.stringify(n)}`);
    }
});

test('motivoNoEnviable distingue los tres motivos', () => {
    assert.strictEqual(reminder.motivoNoEnviable(pendiente({ nombre: 'Ana' })), null);
    assert.strictEqual(reminder.motivoNoEnviable(pendiente({ nombre: null })), 'sin_nombre');
    assert.strictEqual(reminder.motivoNoEnviable(pendiente({ telefono: '' })), 'sin_telefono');
    assert.strictEqual(
        reminder.motivoNoEnviable(pendiente({ nombre: 'Ana', hora_cita: null })), 'sin_hora');
});

// ─── Vía TEXTO LIBRE (dentro de la ventana de 24 h) ──────────────────────────

test('texto libre sin nombre: NO se manda "Hola  😊" y se avisa', async () => {
    resetState();
    state.lastInbound['34624184532'] = horasAtras(1);   // dentro de ventana
    state.pendientes[SANTE_ORG_ID] = [pendiente()];

    const reqs = await correr();

    assert.strictEqual(reqs.length, 0, 'no debe salir ningún mensaje');
    assert.strictEqual(state.marcados.length, 0, 'no se marca enviado: queda pendiente');
    assert.strictEqual(state.alertas.length, 1, 'avisa al admin');
    assert.ok(state.alertas[0].mensaje.includes('no tiene nombre en la ficha'));
    assert.ok(state.alertas[0].mensaje.includes('+34624184532'));
    assert.ok(/l[uú]nes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo/i.test(state.alertas[0].mensaje), 'la fecha va en lenguaje natural, no ISO');
    assert.ok(!state.alertas[0].mensaje.includes('te lo mando yo'), 'no promete lo que no puede cumplir');
    assert.ok(state.warns.some(w => w.evento === 'recordatorio_bloqueado'));
});

// ─── Vía PLANTILLA (fuera de la ventana) — el caso de 34624184532 ────────────

test('plantilla sin nombre: NO se manda {{1}} vacío a Meta y se avisa', async () => {
    resetState();
    state.lastInbound['34624184532'] = horasAtras(30);  // fuera de ventana → plantilla
    state.pendientes[SANTE_ORG_ID] = [pendiente()];

    const reqs = await correr();

    assert.strictEqual(reqs.length, 0, 'ninguna petición a 360dialog con {{1}} vacío');
    assert.strictEqual(state.marcados.length, 0);
    assert.strictEqual(state.alertas.length, 1);
});

// ─── Le ponen nombre después → sí se envía ───────────────────────────────────

test('le completan la ficha entre dos tics → el recordatorio SALE', async () => {
    resetState();
    state.lastInbound['34624184532'] = horasAtras(30);
    const record = pendiente();
    state.pendientes[SANTE_ORG_ID] = [record];

    let reqs = await correr();
    assert.strictEqual(reqs.length, 0, 'primer tic: bloqueado');
    assert.strictEqual(state.alertas.length, 1);

    // Yulia rellena el nombre en el panel.
    record.nombre = 'Marta Ruiz';

    reqs = await correr();
    assert.strictEqual(reqs.length, 1, 'segundo tic: ya se puede mandar');
    const body = reqs[0].body;
    assert.strictEqual(body.type, 'template');
    // {{2}} es «la hora Y su fecha» desde el 10/08/2026 (tests/recordatorio-con-fecha.test.js);
    // aquí lo que se afirma es que sale el mismo valor que en el camino normal, no su forma.
    assert.deepStrictEqual(body.template.components[0].parameters, [
        { type: 'text', text: 'Marta Ruiz' },
        { type: 'text', text: formatReminderWhen(record.fecha_cita, record.hora_cita, 'es') },
    ]);
    assert.strictEqual(state.marcados.length, 1, 'ahora sí se marca enviado');
});

// ─── Contacto sin teléfono (Alexandra, cita del 19/08) ───────────────────────

test('sin teléfono: aviso al admin en vez de fallo silencioso', async () => {
    resetState();
    state.pendientes[SANTE_ORG_ID] = [pendiente({ telefono: '', nombre: 'Alexandra' })];

    const reqs = await correr();

    assert.strictEqual(reqs.length, 0);
    assert.strictEqual(state.marcados.length, 0);
    assert.strictEqual(state.alertas.length, 1);
    assert.ok(state.alertas[0].mensaje.includes('no tiene teléfono guardado'));
    assert.ok(state.alertas[0].mensaje.includes('(sin teléfono guardado)'));
});

// ─── Throttle: un aviso por cita, no uno por tic ─────────────────────────────

test('cinco tics seguidos → UN solo aviso', async () => {
    resetState();
    state.pendientes[SANTE_ORG_ID] = [pendiente()];

    for (let i = 0; i < 5; i++) await correr();

    assert.strictEqual(state.alertas.length, 1, 'el worker tica cada 5 min: sin throttle serían ~288');
});

test('el throttle REAL de admin-alerts es por clave', async () => {
    // Contra el módulo de verdad, no el stub: `alertOnce` es la pieza que reutilizará
    // el aviso de fallo de canal.
    //
    // `alertOnce` es ASÍNCRONA desde el 05/08/2026: espera a Telegram y solo marca la clave
    // si la entrega se confirma. Por eso el doble de notifyOrgAdmin tiene que devolver
    // `true` — devolver cualquier otra cosa significa "no entregado" y la clave quedaría
    // libre, que es justo el comportamiento nuevo que protege tests/admin-alert-reintento.
    const realPath = require.resolve('../services/admin-alerts');
    const cached = require.cache[realPath];
    delete require.cache[realPath];
    const telegramPath = require.resolve('../services/telegram');
    const enviados = [];
    require.cache[telegramPath] = {
        id: telegramPath, filename: telegramPath, loaded: true,
        exports: { notifyOrgAdmin: async (orgId, msg) => { enviados.push({ orgId, msg }); return true; } },
    };
    const alerts = require(realPath);

    assert.strictEqual(await alerts.alertOnce('org', 'cita-1', 'hola'), true);
    assert.strictEqual(await alerts.alertOnce('org', 'cita-1', 'hola'), false, 'segunda vez: throttleada');
    assert.strictEqual(await alerts.alertOnce('org', 'cita-2', 'hola'), true, 'otra cita: sí avisa');
    assert.strictEqual(enviados.length, 2);

    delete require.cache[telegramPath];
    require.cache[realPath] = cached;
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { console.error(`fail - ${name}`); console.error(e.message); fallos++; }
    }
    if (fallos) { console.error(`\n${fallos} test(s) fallidos`); process.exit(1); }
    console.log('\nTests del recordatorio sin nombre OK');
})();
