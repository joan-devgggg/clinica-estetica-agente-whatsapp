/**
 * tests/recordatorio-suelo.test.js — Un «recordatorio de 24 h» a 20 minutos de la cita no
 * es un recordatorio.
 *
 * La ventana del worker tenía techo (`minutos_recordatorio`, 24 h en las dos orgs) y no
 * tenía suelo: `minutosRestantes < 0 || minutosRestantes > minutosAntes`. Cualquier cita de
 * las próximas 24 h con `recordatorio_enviado = false` recibía el mensaje, faltaran veinte
 * horas o veinte minutos — y quien ponía ese flag a false por sorpresa era el rearme del
 * panel (arreglado el 20/08/2026 en db.js).
 *
 * MEDIDO ANTES DE PONERLO. De los 21 recordatorios de Sante desde el 01/07/2026, repartidos
 * por antelación real contra `starts_at`:
 *
 *      < 1 h ....  2     (26 min · 49 min)
 *      1-3 h ....  1     (1 h 48)
 *     12-20 h ...  2
 *     20-24 h ... 16
 *
 * Los TRES de menos de tres horas son los tres duplicados que el arreglo del rearme elimina.
 * O sea que este suelo hoy NO CORTA NADA: es un backstop, no un cambio de política. Se pone
 * igualmente porque el rearme no es la única forma de que una cita entre tarde en la cola.
 *
 * Las dos decisiones que hay dentro y que este fichero fija:
 *
 *  1. El que se salta NO se marca como enviado. Marcar lo que no ha salido es justo lo que
 *     este worker no hace en ningún otro sitio, y además dejarlo pendiente es lo que permite
 *     que si la cita se mueve a mañana el siguiente tic sí la mande. Bloque 5.
 *
 *  2. SOLO SALÓN. San Remo tiene HOY cero citas y cero recordatorios en la base (medido el
 *     20/08/2026): no hay con qué afirmar que un suelo no le rompe nada, y un cero es una
 *     lectura sin datos, no una ausencia de riesgo. Encima una reserva de restaurante para
 *     esta misma noche es su caso NORMAL. Bloque 6.
 *
 * Los bordes se prueban a 118 y 122 minutos y no a 119/121 a propósito: el record lleva la
 * hora en 'HH:MM', así que al construirlo se pierden los segundos y un 121 puede medirse
 * como 120,0x. Con dos minutos de margen el borde se afirma sin depender del reloj.
 *
 * Visto fallar sin el arreglo (cp previo, 20/08/2026): quitar el suelo deja en rojo 3
 * bloques (los tres que exigen SILENCIO). Los otros tres son CONTROLES y pasan con y sin él.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');
const { SANTE_ORG_ID, SANREMO_ORG_ID } = require('../services/org-registry');

let state;

const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

stub('../services/supabase', {});
stub('../services/db', {
    async getConfigValue(orgId, clave) {
        // Las dos orgs tienen 24 h, cada una con su clave (San Remo en minutos, Sante en
        // horas). Es lo que hay en producción.
        if (clave === 'minutos_recordatorio') return orgId === SANREMO_ORG_ID ? '1440' : null;
        if (clave === 'horas_recordatorio') return '24';
        return null;
    },
    async getAgentConfig() { return { business_info: { companyName: 'Sante Healthy Hair Salon' } }; },
    async autoCompleteAppointments() { return 0; },
    async getAppointmentsPendientesRecordatorio(orgId) { return state.pendientes[orgId] || []; },
    async marcarRecordatorioSent(orgId, id) { state.marcadosFicha.push({ orgId, id }); return true; },
    async marcarRecordatorioCitaSent(orgId, id) { state.marcadosCita.push({ orgId, id }); return true; },
    async saveMessage() { return 1; },
});
stub('../services/outbound', {
    resolveOutboundClient: (_orgId, fallback) => fallback,
    async resolveAutomatedSend() { return { mode: 'free_text' }; },
});
stub('../services/channel-health', { async noteSendResult() {} });
stub('../services/admin-alerts', { async alertOnce() { return true; } });

const loggerPath = require.resolve('../lib/logger');
const realLogger = require(loggerPath);
require.cache[loggerPath].exports = {
    ...realLogger,
    info: (evento, campos) => { state.logs.push({ evento, ...campos }); },
    warn: () => {}, error: () => {},
};

const reminder = require('../services/reminder');
const { _resetPendingOutbound } = require('../services/pending-outbound');

// Una cita a N minutos de AHORA, en las cadenas de Madrid que espera minutosHastaCita.
function citaEnMinutos(min) {
    const d = new Date(Date.now() + min * 60 * 1000);
    return {
        fecha: d.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }),
        hora: d.toLocaleTimeString('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }),
    };
}

function makeClient() {
    const sent = { textos: [] };
    return {
        sent,
        async sendMessage(chatId, texto) { sent.textos.push({ chatId, texto }); },
        async sendTemplate(chatId, tpl) { sent.textos.push({ chatId, tpl }); },
    };
}

function resetState() {
    state = { pendientes: {}, marcadosFicha: [], marcadosCita: [], logs: [] };
    _resetPendingOutbound();
    reminder._resetPendientesDeMarcar();
}

const record = (min, extra = {}) => {
    const { fecha, hora } = citaEnMinutos(min);
    return {
        id: 'apt-1', esCita: true, contactId: 'ct-1', nombre: 'Mary Ray',
        telefono: '34672765379', wa_jid: null, language: 'es',
        fecha_cita: fecha, hora_cita: hora, ...extra,
    };
};

async function correr(orgId, rec) {
    const cli = makeClient();
    reminder.setClients(new Map([[orgId, { client: cli }]]));
    state.pendientes[orgId] = [rec];
    await reminder.checkAndSendReminders();
    return cli;
}

// ─── 1-2 · Por debajo del suelo: SILENCIO, y sin consumir la cita ────────────────────────

test('a 30 minutos de la cita NO sale el recordatorio, y NO se marca como enviado', async () => {
    resetState();
    const cli = await correr(SANTE_ORG_ID, record(30));
    assert.strictEqual(cli.sent.textos.length, 0,
        'salió un «recordatorio» a media hora de la cita: eso llega cuando ya va de camino');
    assert.strictEqual(state.marcadosCita.length, 0, 'marcar lo que no ha salido es mentir en la tabla');
    assert.strictEqual(state.marcadosFicha.length, 0);
    assert.ok(state.logs.some(l => l.evento === 'recordatorio_fuera_de_plazo'),
        'y no es un silencio: queda dicho con sus minutos');
});

test('el borde: a 118 minutos todavía NO sale', async () => {
    resetState();
    const cli = await correr(SANTE_ORG_ID, record(118));
    assert.strictEqual(cli.sent.textos.length, 0, 'el suelo son 120 minutos y 118 está por debajo');
});

// ─── 3-4 · Por encima: la ventana de siempre, intacta ────────────────────────────────────

test('CONTROL el borde por arriba: a 122 minutos SÍ sale', async () => {
    // Es el bloque que impide que el suelo se coma la ventana: sin él, subir el número
    // «por si acaso» no rompería ningún test hasta que dejaran de salir recordatorios.
    resetState();
    const cli = await correr(SANTE_ORG_ID, record(122));
    assert.strictEqual(cli.sent.textos.length, 1, 'a más de dos horas el recordatorio es útil y tiene que salir');
    assert.strictEqual(state.marcadosCita.length, 1, 'y se marca, que si no sale cada cinco minutos');
});

test('CONTROL el caso normal de 24 h sigue igual', async () => {
    resetState();
    const cli = await correr(SANTE_ORG_ID, record(23 * 60));
    assert.strictEqual(cli.sent.textos.length, 1);
    assert.ok(/Mary Ray/.test(cli.sent.textos[0].texto), 'con su nombre, como siempre');
});

// ─── 5 · Saltarse uno no lo consume ──────────────────────────────────────────────────────

test('la cita saltada sigue PENDIENTE: si se mueve a mañana, el siguiente tic la manda', async () => {
    // Esta es la mitad que justifica no marcarla. Si el salón mueve la cita de dentro de
    // media hora a mañana, el recordatorio vuelve a tener sentido y tiene que salir solo.
    resetState();
    const cli1 = await correr(SANTE_ORG_ID, record(30));
    assert.strictEqual(cli1.sent.textos.length, 0);

    const cli2 = await correr(SANTE_ORG_ID, record(20 * 60));
    assert.strictEqual(cli2.sent.textos.length, 1,
        'la cita nunca se marcó, así que al moverse vuelve a entrar en la ventana por su cuenta');
});

// ─── 6 · Regla de oro ────────────────────────────────────────────────────────────────────

test('SAN REMO no tiene suelo: su recordatorio a 30 minutos sale igual que siempre', async () => {
    // Gateado por tipo de org y a sabiendas: San Remo tiene cero citas y cero recordatorios
    // en la base, así que no hay con qué afirmar que un suelo no le rompe nada — y una
    // reserva para esta misma noche es su caso normal, no el raro.
    resetState();
    const cli = await correr(SANREMO_ORG_ID, {
        id: 'lead-9', nombre: 'Cliente Mesa', telefono: '34667000111',
        ...(() => { const { fecha, hora } = citaEnMinutos(30); return { fecha_cita: fecha, hora_cita: hora }; })(),
    });
    assert.strictEqual(cli.sent.textos.length, 1, 'su conducta no cambia ni un byte');
    assert.strictEqual(state.marcadosFicha.length, 1, 'y sigue marcando la FICHA, que es su camino');
});
