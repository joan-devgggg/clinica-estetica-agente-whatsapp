// El botón "enviar reseña" del panel — que envíe de verdad (06/08/2026).
//
// Hasta hoy `POST /api/reviews/:id/send` solo ponía `resena_enviada = true` y devolvía
// {ok:true}; el panel cantaba "Reseña enviada" y no salía ni un mensaje. Y como la cola del
// worker filtra por `resena_enviada = false`, el clic sacaba la cita TAMBIÉN de ahí: era la
// forma más eficaz de garantizar que esa reseña no se pidiera nunca. Cinco reseñas reales se
// perdieron así entre el 01 y el 05/08/2026.
//
// Lo que se congela aquí: se envía ANTES de marcar, y si no se envía no se marca — porque
// marcar sin enviar es lo que destruye la reseña para siempre.
//
// Ejecuta la función real de review.js con `services/db` stubeado. Sin red y sin Supabase.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
let state;

function resetState() {
    state = {
        agentConfig: {
            business_info: {
                googleReviewLink: 'https://maps.app.goo.gl/PGdw5KeetLKbbdk18',
                companyName: 'Sante Healthy Hair Salon',
            },
        },
        horasResena: '2',
        pendientes: [cita()],
        updates: [],        // llamadas a updateAppointment
        fallaUpdate: false,
        logs: [],
    };
}

function cita(over = {}) {
    return {
        id: 'apt-1',
        full_name: 'Ana Pérez',
        phone: '34600000001',
        contacts: {
            id: 'c1', full_name: 'Ana Pérez', wa_phone: '34600000001',
            language: 'es', metadata: {}, is_blacklisted: false,
        },
        ...over,
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
            if (state.fallaUpdate) throw new Error('appointments: no afectó ninguna fila');
            state.updates.push({ orgId, id, campos });
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

// outbound: sin canal Cloud, resolveAutomatedSend devuelve texto libre.
const outboundPath = require.resolve('../services/outbound');
const realOutbound = require(outboundPath);
require.cache[outboundPath].exports = {
    ...realOutbound,
    resolveOutboundClient: (_o, fallback) => fallback,
    resolveAutomatedSend: async () => ({ mode: 'free_text' }),
};

const { sendReviewForAppointment } = require('../services/review');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function clienteFalso(enviados, { revienta = false } = {}) {
    return {
        sendMessage: async (chatId, texto) => {
            if (revienta) throw new Error('360dialog send 500: Internal');
            enviados.push({ chatId, texto });
        },
        sendTemplate: async (chatId) => { enviados.push({ chatId, plantilla: true }); },
    };
}

// ─── Lo esencial ─────────────────────────────────────────────────────────────

test('envía DE VERDAD y solo entonces marca', async () => {
    resetState();
    const enviados = [];
    const r = await sendReviewForAppointment(ORG, 'apt-1', {
        client: clienteFalso(enviados), actor: 'panel:u1',
    });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(enviados.length, 1, 'tiene que salir un mensaje — antes salían cero');
    assert.ok(enviados[0].texto.includes('maps.app.goo.gl/PGdw5KeetLKbbdk18'),
        'el mensaje lleva el enlace de reseñas');
    assert.ok(enviados[0].texto.includes('Ana Pérez'));

    assert.strictEqual(state.updates.length, 1, 'y solo después se marca');
    assert.strictEqual(state.updates[0].campos.resenaEnviada, true);
    assert.strictEqual(state.updates[0].campos.actor, 'panel:u1', 'queda quién lo pulsó');
});

test('REGRESIÓN · si NO se envía, NO se marca', async () => {
    resetState();
    const enviados = [];
    const r = await sendReviewForAppointment(ORG, 'apt-1', {
        client: clienteFalso(enviados, { revienta: true }), actor: 'panel:u1',
    });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.motivo, 'fallo');
    assert.strictEqual(enviados.length, 0);
    assert.strictEqual(state.updates.length, 0,
        'marcar sin enviar saca la cita de la cola del worker: la reseña se pierde para siempre');
});

test('una cita que no está pendiente no se envía ni se marca', async () => {
    resetState();
    state.pendientes = []; // ya enviada, cancelada, en lista negra o fuera de ventana
    const enviados = [];
    const r = await sendReviewForAppointment(ORG, 'apt-1', { client: clienteFalso(enviados) });

    assert.deepStrictEqual(r, { ok: false, motivo: 'no_pendiente' });
    assert.strictEqual(enviados.length, 0);
    assert.strictEqual(state.updates.length, 0);
});

test('sin enlace de Google configurado no se inventa nada', async () => {
    resetState();
    state.agentConfig.business_info.googleReviewLink = null;
    const enviados = [];
    const r = await sendReviewForAppointment(ORG, 'apt-1', { client: clienteFalso(enviados) });

    assert.deepStrictEqual(r, { ok: false, motivo: 'sin_enlace' });
    assert.strictEqual(enviados.length, 0);
    assert.strictEqual(state.updates.length, 0);
});

test('sin teléfono utilizable tampoco se marca', async () => {
    resetState();
    state.pendientes = [cita({ phone: null, contacts: { ...cita().contacts, wa_phone: null } })];
    const enviados = [];
    const r = await sendReviewForAppointment(ORG, 'apt-1', { client: clienteFalso(enviados) });

    assert.deepStrictEqual(r, { ok: false, motivo: 'sin_telefono' });
    assert.strictEqual(state.updates.length, 0);
});

test('enviado pero sin poder marcar → ok con registrado:false, no un error', async () => {
    resetState();
    state.fallaUpdate = true;
    const enviados = [];
    const r = await sendReviewForAppointment(ORG, 'apt-1', { client: clienteFalso(enviados) });

    assert.strictEqual(enviados.length, 1, 'el mensaje salió');
    assert.deepStrictEqual(r, { ok: true, registrado: false });
    assert.ok(state.logs.some(l => l.evento === 'resena_enviada_sin_registrar'));
    // Devolver error haría que el operador volviera a pulsar y la clienta recibiera dos
    // peticiones de reseña. El mal menor es que el worker pueda repetirla.
});

test('el idioma de la clienta manda en el texto', async () => {
    resetState();
    state.pendientes = [cita({ contacts: { ...cita().contacts, language: 'ru' } })];
    const enviados = [];
    await sendReviewForAppointment(ORG, 'apt-1', { client: clienteFalso(enviados) });

    assert.ok(/Привет|отзыв/i.test(enviados[0].texto), `en ruso, no en español: ${enviados[0].texto}`);
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
