// Una reseña que SALE y no se puede apuntar no se vuelve a pedir (06/08/2026).
//
// Hallazgo 🟠 3 de docs/auditoria-afirmar-sin-verificar.md. `updateAppointment` LANZA ante
// cualquier error de escritura y el `try` que lo recogía estaba al nivel de la ORG, fuera del
// bucle de citas. Con el mensaje ya entregado, un fallo de marcado hacía dos cosas:
//
//   1. abortaba el resto de citas pendientes de esa org en ese tic, y
//   2. dejaba `resena_enviada = false` → al tic siguiente (5 min) la misma cita volvía a
//      estar pendiente y la clienta recibía la petición otra vez. Y otra. Cada cinco minutos.
//
// Lo que se congela aquí: reintento del MARCADO, nunca del envío; el fallo de una cita no se
// lleva por delante a las demás; y cuando ni con reintentos se puede apuntar, se avisa a una
// persona en vez de dejarlo en un log.
//
// Ejecuta el motor real (checkAndSendReviews) con db/outbound/telegram stubeados. Sin red.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };

// Telegram se stubea ANTES que nada: admin-alerts DESESTRUCTURA notifyOrgAdmin al cargarse,
// así que si cualquier require anterior arrastra el módulo real, el stub llega tarde.
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        async notifyOrgAdmin(orgId, mensaje) { state.avisos.push({ orgId, mensaje }); return true; },
    },
};

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
let state;

function cita(id, over = {}) {
    return {
        id,
        full_name: `Clienta ${id}`,
        phone: `3460000000${id.slice(-1)}`,
        contacts: {
            id: `c-${id}`, full_name: `Clienta ${id}`, wa_phone: `3460000000${id.slice(-1)}`,
            language: 'es', metadata: {}, is_blacklisted: false,
        },
        ...over,
    };
}

function resetState() {
    state = {
        agentConfig: {
            business_info: {
                googleReviewLink: 'https://maps.app.goo.gl/PGdw5KeetLKbbdk18',
                companyName: 'Sante Healthy Hair Salon',
            },
        },
        horasResena: '2',
        pendientes: [cita('apt-1')],
        updates: [],          // llamadas a updateAppointment que NO fallaron
        intentosUpdate: 0,    // incluye las que fallaron
        idsQueFallan: new Set(),
        enviados: [],
        logs: [],
        avisos: [],
    };
}

const dbPath = require.resolve('../services/db');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        async getAgentConfig() { return state.agentConfig; },
        async getConfigValue(_o, clave) { return clave === 'horas_resena' ? state.horasResena : null; },
        async getCompletedAppointmentsForReview() { return state.pendientes; },
        async updateAppointment(orgId, id, campos) {
            state.intentosUpdate++;
            if (state.idsQueFallan.has(id)) throw new Error('appointments: no afectó ninguna fila');
            state.updates.push({ orgId, id, campos });
            // La fila SÍ se escribió: la cita deja de estar pendiente, como en producción.
            state.pendientes = state.pendientes.filter(a => a.id !== id);
            return { id };
        },
    },
};

const loggerPath = require.resolve('../lib/logger');
const realLogger = require(loggerPath);
require.cache[loggerPath].exports = {
    ...realLogger,
    info: (e, m) => state.logs.push({ nivel: 'info', evento: e, meta: m }),
    warn: (e, m) => state.logs.push({ nivel: 'warn', evento: e, meta: m }),
    error: (e, m) => state.logs.push({ nivel: 'error', evento: e, meta: m }),
};

const outboundPath = require.resolve('../services/outbound');
const realOutbound = require(outboundPath);
require.cache[outboundPath].exports = {
    ...realOutbound,
    resolveOutboundClient: (_o, fallback) => fallback,
    resolveAutomatedSend: async () => ({ mode: 'free_text' }),
};

// admin-alerts va REAL: su throttle forma parte de lo que aquí se afirma (un aviso por cita,
// no uno por tic). alertOnce solo marca la clave si Telegram confirma, y el stub confirma.
const { _resetThrottle } = require('../services/admin-alerts');

const { checkAndSendReviews, setClients, _resetPendientesDeMarcar } = require('../services/review');

const clienteFalso = {
    sendMessage: async (chatId, texto) => { state.enviados.push({ chatId, texto }); },
    sendTemplate: async (chatId) => { state.enviados.push({ chatId, plantilla: true }); },
};

function arrancar() {
    resetState();
    _resetPendientesDeMarcar();
    _resetThrottle();
    setClients(new Map([[ORG, { client: clienteFalso, orgId: ORG }]]));
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── El hallazgo ─────────────────────────────────────────────────────────────

test('REGRESIÓN · enviada y sin poder marcar: el tic siguiente NO la reenvía', async () => {
    arrancar();
    state.idsQueFallan.add('apt-1');

    await checkAndSendReviews();
    assert.strictEqual(state.enviados.length, 1, 'el primer tic sí la pide');
    assert.strictEqual(state.updates.length, 0, 'y el marcado no llegó a escribirse');

    // La cita sigue pendiente en BD (la fila no se escribió), que es justo la trampa.
    assert.strictEqual(state.pendientes.length, 1);

    await checkAndSendReviews();
    await checkAndSendReviews();
    assert.strictEqual(state.enviados.length, 1,
        'antes cada tic de 5 min le pedía la reseña otra vez, indefinidamente');
});

test('los tics siguientes reintentan el MARCADO, y en cuanto se puede queda apuntada', async () => {
    arrancar();
    state.idsQueFallan.add('apt-1');
    await checkAndSendReviews();

    state.idsQueFallan.clear();       // la escritura vuelve a funcionar
    await checkAndSendReviews();

    assert.strictEqual(state.updates.length, 1, 'se apuntó sin volver a enviar');
    assert.strictEqual(state.updates[0].campos.resenaEnviada, true);
    assert.strictEqual(state.updates[0].campos.actor, 'worker:review');
    assert.strictEqual(state.enviados.length, 1, 'y solo salió UN mensaje en total');
});

test('el marcado se reintenta dentro del mismo tic antes de rendirse', async () => {
    arrancar();
    state.idsQueFallan.add('apt-1');
    await checkAndSendReviews();

    assert.ok(state.intentosUpdate >= 3,
        `un solo intento no distingue un error transitorio de uno real (hubo ${state.intentosUpdate})`);
});

test('si no se pudo apuntar, se entera una persona (no solo el log)', async () => {
    arrancar();
    state.idsQueFallan.add('apt-1');
    await checkAndSendReviews();

    assert.ok(state.logs.some(l => l.evento === 'resena_enviada_sin_registrar'), 'queda en el log');
    assert.strictEqual(state.avisos.length, 1, 'y sale un aviso al admin');
    assert.ok(/rese/i.test(state.avisos[0].mensaje));

    // Throttle por cita: el reintento del tic siguiente no repite el aviso.
    await checkAndSendReviews();
    assert.strictEqual(state.avisos.length, 1, 'un aviso por cita, no uno por tic');
});

test('REGRESIÓN · un fallo en una cita no se lleva por delante a las siguientes', async () => {
    arrancar();
    state.pendientes = [cita('apt-1'), cita('apt-2'), cita('apt-3')];
    state.idsQueFallan.add('apt-1');

    await checkAndSendReviews();

    assert.strictEqual(state.enviados.length, 3,
        'antes el throw de la primera abortaba el bucle y las otras dos se quedaban sin reseña');
    assert.deepStrictEqual(state.updates.map(u => u.id), ['apt-2', 'apt-3']);
});

// ─── Lo que no ha cambiado ───────────────────────────────────────────────────

test('camino normal: se envía una vez, se marca una vez y desaparece de la cola', async () => {
    arrancar();
    await checkAndSendReviews();

    assert.strictEqual(state.enviados.length, 1);
    assert.strictEqual(state.updates.length, 1);
    assert.strictEqual(state.avisos.length, 0, 'sin fallo no se molesta a nadie');

    await checkAndSendReviews();
    assert.strictEqual(state.enviados.length, 1, 'ya no está pendiente');
});

test('un fallo de ENVÍO sí se reintenta en el tic siguiente (no se apunta nada)', async () => {
    arrancar();
    let primeraVez = true;
    setClients(new Map([[ORG, {
        client: {
            sendMessage: async (chatId, texto) => {
                if (primeraVez) { primeraVez = false; throw new Error('360dialog send 500'); }
                state.enviados.push({ chatId, texto });
            },
            sendTemplate: async () => {},
        },
        orgId: ORG,
    }]]));

    await checkAndSendReviews();
    assert.strictEqual(state.enviados.length, 0);
    assert.strictEqual(state.updates.length, 0, 'no se marca lo que no salió');

    await checkAndSendReviews();
    assert.strictEqual(state.enviados.length, 1, 'un envío fallido SÍ se reintenta');
    assert.strictEqual(state.updates.length, 1);
});

test('la memoria de "entregado sin apuntar" se poda cuando la cita deja de estar pendiente', async () => {
    arrancar();
    state.idsQueFallan.add('apt-1');
    await checkAndSendReviews();

    // Alguien la marca a mano desde el panel: desaparece de la cola.
    state.pendientes = [];
    await checkAndSendReviews();

    // Y si esa misma cita reapareciera (otra cita, mismo id no pasa; esto afirma la poda),
    // el envío volvería a intentarse en vez de quedarse mudo para siempre.
    state.idsQueFallan.clear();
    state.pendientes = [cita('apt-1')];
    await checkAndSendReviews();
    assert.strictEqual(state.enviados.length, 2, 'la entrada muerta no puede silenciar la cita para siempre');
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
