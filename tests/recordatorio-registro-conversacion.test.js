// Un recordatorio ENVIADO deja rastro donde la conversación y el panel lo ven (H1,
// nocturno 14/08). Barbora Jalova, 13/08/2026: su recordatorio salió por plantilla, no se
// escribió en `messages` (el Monitor enseñó su «Hola, si confirmado» como primer mensaje
// de la nada) ni en `session.history` (el bot, que SOLO lee el historial, le contestó
// «¿Qué día o semana te viene mejor?»).
//
// Este fichero conduce el worker REAL (checkAndSendReminders) con db/outbound stubeados y
// afirma las cuatro conductas del arreglo:
//   1. tras enviar, se guarda el saliente en `messages` (texto libre: literal; plantilla:
//      prefijada con su nombre — no afirmamos bytes que Meta renderiza);
//   2. tras enviar, queda la nota en pending-outbound para el historial del bot;
//   3. el marcado va a la CITA cuando el record es de cita (esCita), nunca a la ficha;
//   4. San Remo queda byte por byte: ni registro en messages, ni nota, y marca la FICHA.
//
// Visto fallar sin el arreglo (sabotajes con cp previo, 14/08): quitar la llamada a
// registrarRecordatorioEnviado deja en rojo 1 y 2; quitar la rama esCita del marcado deja
// en rojo 3.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');
const path = require('path');
const { SANTE_ORG_ID, SANREMO_ORG_ID } = require('../services/org-registry');

let state;

// ─── Stubs ANTES de requerir el worker (mismo patrón que recordatorio-con-fecha) ───────
const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

stub('../services/supabase', {});
stub('../services/db', {
    async getConfigValue(orgId, clave) { return clave === 'horas_recordatorio' ? '24' : null; },
    async getAgentConfig() { return { business_info: { companyName: 'Sante Healthy Hair Salon' } }; },
    async autoCompleteAppointments() { return 0; },
    async getAppointmentsPendientesRecordatorio(orgId) { return state.pendientes[orgId] || []; },
    async marcarRecordatorioSent(orgId, id) { state.marcadosFicha.push({ orgId, id }); return true; },
    async marcarRecordatorioCitaSent(orgId, id) { state.marcadosCita.push({ orgId, id }); return true; },
    async saveMessage(orgId, msg) { state.mensajesGuardados.push({ orgId, ...msg }); return 1; },
});
stub('../services/outbound', {
    resolveOutboundClient: (_orgId, fallback) => fallback,
    async resolveAutomatedSend(orgId) { return state.decision[orgId] || { mode: 'free_text' }; },
});
stub('../services/channel-health', { async noteSendResult() {} });
stub('../services/admin-alerts', { async alertOnce(orgId, clave, mensaje) { state.alertas.push({ orgId, clave, mensaje }); return true; } });

const loggerPath = require.resolve('../lib/logger');
const realLogger = require(loggerPath);
require.cache[loggerPath].exports = { ...realLogger, info: () => {}, warn: () => {}, error: (e, m) => { state.errores.push({ e, m }); } };

const reminder = require('../services/reminder');
const { drainPendingOutboundTurns, _resetPendingOutbound } = require('../services/pending-outbound');

// Una cita dentro de la ventana de 24 h: ahora + 3 h, en cadenas de Madrid (la misma
// convención que escribe construirPendientesDesdeCitas y que espera minutosHastaCita).
function citaEnHoras(horas) {
    const d = new Date(Date.now() + horas * 3600 * 1000);
    return {
        fecha: d.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }),
        hora: d.toLocaleTimeString('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }),
    };
}

function makeClient() {
    const sent = { textos: [], plantillas: [] };
    return {
        sent,
        async sendMessage(chatId, texto) { sent.textos.push({ chatId, texto }); },
        async sendTemplate(chatId, tpl) { sent.plantillas.push({ chatId, tpl }); },
    };
}

function resetState() {
    state = {
        pendientes: {}, decision: {}, marcadosFicha: [], marcadosCita: [],
        mensajesGuardados: [], alertas: [], errores: [],
    };
    _resetPendingOutbound();
    reminder._resetPendientesDeMarcar();
}

const { fecha, hora } = citaEnHoras(3);
const recordSante = () => ({
    id: 'apt-1', esCita: true, contactId: 'ct-1', nombre: 'Barbora Jalova',
    telefono: '34603426950', wa_jid: null, language: 'es', fecha_cita: fecha, hora_cita: hora,
});
const recordSanRemo = () => ({
    id: 'lead-9', nombre: 'Cliente Mesa', telefono: '34667000111',
    fecha_cita: fecha, hora_cita: hora,
});

test('texto libre: envía, guarda el literal en messages, deja la nota y marca la CITA', async () => {
    resetState();
    const cli = makeClient();
    reminder.setClients(new Map([[SANTE_ORG_ID, { client: cli }]]));
    state.pendientes[SANTE_ORG_ID] = [recordSante()];
    state.decision[SANTE_ORG_ID] = { mode: 'free_text' };

    await reminder.checkAndSendReminders();

    assert.strictEqual(cli.sent.textos.length, 1, 'salió un recordatorio por texto libre');
    const texto = cli.sent.textos[0].texto;
    assert.ok(texto.includes('Barbora Jalova'), 'el mensaje lleva su nombre');

    assert.strictEqual(state.mensajesGuardados.length, 1, 'el saliente queda en messages (el Monitor lo ve)');
    assert.strictEqual(state.mensajesGuardados[0].direccion, 'saliente');
    assert.strictEqual(state.mensajesGuardados[0].contenido, texto, 'texto libre: se guarda EL LITERAL enviado');
    assert.strictEqual(state.mensajesGuardados[0].telefono, '34603426950');

    const nota = drainPendingOutboundTurns(SANTE_ORG_ID, '34603426950@c.us', 60000);
    assert.strictEqual(nota.length, 1, 'la nota espera al bot: sin ella el prompt sigue ciego');
    assert.strictEqual(nota[0].content, texto);

    assert.deepStrictEqual(state.marcadosCita, [{ orgId: SANTE_ORG_ID, id: 'apt-1' }], 'la marca va a la CITA');
    assert.strictEqual(state.marcadosFicha.length, 0, 'y NO a la ficha, que la conversación pisa');
});

test('plantilla: messages lleva el prefijo [plantilla …]; la nota, el contenido a secas', async () => {
    resetState();
    const cli = makeClient();
    reminder.setClients(new Map([[SANTE_ORG_ID, { client: cli }]]));
    state.pendientes[SANTE_ORG_ID] = [recordSante()];
    state.decision[SANTE_ORG_ID] = { mode: 'template', template: { name: 'sante_recordatorio_cita', language: 'es' } };

    await reminder.checkAndSendReminders();

    assert.strictEqual(cli.sent.plantillas.length, 1, 'salió por plantilla');
    assert.strictEqual(state.mensajesGuardados.length, 1);
    assert.ok(state.mensajesGuardados[0].contenido.startsWith('[plantilla sante_recordatorio_cita] '),
        'no afirmamos los bytes de Meta: el registro dice que fue plantilla y qué contenía');

    const nota = drainPendingOutboundTurns(SANTE_ORG_ID, '34603426950', 60000);
    assert.strictEqual(nota.length, 1);
    assert.ok(!nota[0].content.startsWith('[plantilla'),
        'al historial del modelo va el contenido, sin prefijo técnico que lo despiste');

    assert.strictEqual(state.marcadosCita.length, 1);
});

test('SAN REMO: ni registro en messages, ni nota, y la marca sigue en la FICHA', async () => {
    resetState();
    const cli = makeClient();
    reminder.setClients(new Map([[SANREMO_ORG_ID, { client: cli }]]));
    state.pendientes[SANREMO_ORG_ID] = [recordSanRemo()];
    state.decision[SANREMO_ORG_ID] = { mode: 'free_text' };

    await reminder.checkAndSendReminders();

    assert.strictEqual(cli.sent.textos.length, 1, 'su recordatorio sale como siempre');
    assert.strictEqual(state.mensajesGuardados.length, 0, 'regla de oro: nada nuevo en su panel');
    assert.strictEqual(drainPendingOutboundTurns(SANREMO_ORG_ID, '34667000111', 60000).length, 0,
        'ni nota para su prompt');
    assert.deepStrictEqual(state.marcadosFicha, [{ orgId: SANREMO_ORG_ID, id: 'lead-9' }]);
    assert.strictEqual(state.marcadosCita.length, 0);
});

test('si el registro falla, el envío NO se repite: se loguea y el marcado sigue', async () => {
    resetState();
    const cli = makeClient();
    reminder.setClients(new Map([[SANTE_ORG_ID, { client: cli }]]));
    state.pendientes[SANTE_ORG_ID] = [recordSante()];
    state.decision[SANTE_ORG_ID] = { mode: 'free_text' };
    const db = require('../services/db');
    const originalSave = db.saveMessage;
    db.saveMessage = async () => { throw new Error('messages caída'); };
    try {
        await reminder.checkAndSendReminders();
    } finally {
        db.saveMessage = originalSave;
    }
    assert.strictEqual(cli.sent.textos.length, 1);
    assert.strictEqual(state.marcadosCita.length, 1,
        'el fallo del registro no puede desmarcar: desmarcar es reenviar cada 5 minutos');
    assert.ok(state.errores.some(x => x.e === 'recordatorio_registro_mensaje_fallido'),
        'y no es silencioso: queda logueado');
});
