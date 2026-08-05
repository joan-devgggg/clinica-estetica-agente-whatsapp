// Campañas — "una clienta no puede recibir dos veces la misma campaña" (06/08/2026).
//
// El agujero: `finishBroadcastSend('sent')` estaba DENTRO del try del envío y lanza
// (assertRowsAffected). Si lanzaba, con el mensaje YA entregado:
//   · el contacto se contaba en `enviados` Y en `omitidos` — el resumen no cuadraba solo;
//   · el claim se marcaba 'failed', que es justo lo que resetStaleBroadcastClaims BORRA al
//     empezar la tanda siguiente → el contacto volvía a ser elegible → segundo WhatsApp.
// El UNIQUE de broadcast_sends existe para impedirlo y ese camino lo rodeaba borrando su fila.
//
// Aquí se ejecuta el motor REAL (runBroadcast) con `services/db` stubeado. El stub de
// resetStaleBroadcastClaims replica la consulta de verdad —borra lo que NO es 'sent' y
// además está 'failed' o caducado— porque el arreglo se apoya exactamente en esa diferencia:
// un 'pending' reciente sobrevive, un 'failed' no. Con un stub que borrara todo lo no-'sent'
// este test pasaría igual antes y después del arreglo, o sea que no probaría nada.
process.env.TZ = 'Europe/Madrid';
process.env.SANTE_360_API_KEY = 'test-key-360';
process.env.SANTE_360_PHONE_NUMBER_ID = '111222333';
process.env.WHATSAPP_360_BASE_URL = 'https://waba-v2.360dialog.io';

const assert = require('assert');
const { SANTE_ORG_ID } = require('../services/org-registry');

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };

const dbPath = require.resolve('../services/db');
const { sanitizePhone, isWithin24hWindow } = require(dbPath);

// Telegram en su frontera real, para poder afirmar el aviso.
const avisos = [];
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        notifyOrgAdmin: async (orgId, mensaje) => { avisos.push({ orgId, mensaje }); return true; },
        startTelegramBot: () => {}, notifyEscalation: async () => {},
        notifyBlacklistAlert: async () => {}, notifyBizumPending: async () => {},
        notifyVipSuggestion: async () => {},
    },
};

const CADUCA_MS = 15 * 60 * 1000; // mismo valor que CLAIM_CADUCA_MS en db.js
let state;

function resetState() {
    state = {
        sends: [],
        claimSeq: 0,
        // Cuántas veces debe fallar finishBroadcastSend({status:'sent'}) antes de funcionar.
        fallosRegistroPendientes: 0,
        registrosIntentados: 0,
        logs: [],
    };
    avisos.length = 0;
}

const dbStub = {
    sanitizePhone,
    isWithin24hWindow,
    // DENTRO de la ventana de 24 h: así el modo es `free_text` y el escenario se centra en
    // el registro, no en la mecánica de plantillas (que ya cubre campana-plantillas-tandas).
    async getLastInboundAt() { return new Date(Date.now() - 3600 * 1000).toISOString(); },
    async getLastInboundAtBulk(_orgId, telefonos) {
        const m = new Map();
        for (const t of telefonos || []) m.set(sanitizePhone(t), new Date(Date.now() - 3600 * 1000).toISOString());
        return m;
    },
    async getConfigValue() { return null; },
    async getBroadcastSentPhones(orgId, campaignKey) {
        return new Set(state.sends
            .filter(s => s.orgId === orgId && s.campaignKey === campaignKey && s.status === 'sent')
            .map(s => s.telefono));
    },
    // Réplica de la consulta real (db.js): .neq('status','sent') Y (status='failed' OR caducado).
    async resetStaleBroadcastClaims(orgId, campaignKey) {
        const limite = Date.now() - CADUCA_MS;
        const antes = state.sends.length;
        state.sends = state.sends.filter(s => {
            if (s.orgId !== orgId || s.campaignKey !== campaignKey) return true;
            if (s.status === 'sent') return true;
            const caducado = new Date(s.created_at).getTime() < limite;
            return !(s.status === 'failed' || caducado);
        });
        return antes - state.sends.length;
    },
    async claimBroadcastRecipient(orgId, { campaignKey, contactId, telefono }) {
        const phone = sanitizePhone(telefono);
        const choca = state.sends.some(s =>
            s.orgId === orgId && s.campaignKey === campaignKey && s.telefono === phone);
        if (choca) return null; // UNIQUE
        const id = `claim-${++state.claimSeq}`;
        state.sends.push({
            id, orgId, campaignKey, contactId, telefono: phone,
            status: 'pending', created_at: new Date().toISOString(),
        });
        return id;
    },
    async finishBroadcastSend(orgId, claimId, patch) {
        if (patch.status === 'sent') {
            state.registrosIntentados++;
            if (state.fallosRegistroPendientes > 0) {
                state.fallosRegistroPendientes--;
                // Igual que assertRowsAffected en la vida real: LANZA.
                throw new Error('broadcast_sends (update finish): no afectó ninguna fila');
            }
        }
        const fila = state.sends.find(s => s.id === claimId && s.orgId === orgId);
        if (!fila) throw new Error('finishBroadcastSend: fila no encontrada');
        Object.assign(fila, patch, { sent_at: patch.status === 'sent' ? new Date().toISOString() : null });
        return true;
    },
    async countBroadcastSendsLast24h() { return 0; },
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };

const loggerPath = require.resolve('../lib/logger');
const realLogger = require(loggerPath);
require.cache[loggerPath].exports = {
    ...realLogger,
    info: (evento, meta) => state.logs.push({ nivel: 'info', evento, meta }),
    warn: (evento, meta) => state.logs.push({ nivel: 'warn', evento, meta }),
    error: (evento, meta) => state.logs.push({ nivel: 'error', evento, meta }),
};

const { runBroadcast } = require('../services/broadcast');
const { _resetThrottle } = require('../services/admin-alerts');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const CAMPANA = 'verano-2026';
const CONTACTO = { id: 'c1', telefono: '34600000001', nombre: 'Ana', language: 'es', wa_jid: null };

// Cliente saliente falso: cuenta cada entrega. Es "el móvil de la clienta".
function clienteFalso(entregas) {
    return {
        sendTemplate: async (chatId) => { entregas.push(chatId); return { id: 'wamid.X' }; },
        sendMessage: async (chatId) => { entregas.push(chatId); return { id: 'wamid.X' }; },
    };
}

const correr = (entregas, opts = {}) => runBroadcast(SANTE_ORG_ID, {
    client: clienteFalso(entregas),
    destinatarios: [CONTACTO],
    mensaje: 'Hola, tenemos novedades',
    campaignKey: CAMPANA,
    sendText: async (_client, chatId) => { entregas.push(chatId); },
    ...opts,
});

// ─── El invariante ───────────────────────────────────────────────────────────

test('REGRESIÓN · entregado + registro fallido → la tanda siguiente NO reenvía', async () => {
    resetState(); _resetThrottle();
    const entregas = [];

    state.fallosRegistroPendientes = 99; // el registro no funciona nunca
    const t1 = await correr(entregas);
    assert.strictEqual(entregas.length, 1, 'la primera tanda entrega una vez');
    assert.strictEqual(t1.enviados, 1);

    // Segunda tanda, inmediatamente después (el claim NO ha caducado).
    const t2 = await correr(entregas);
    assert.strictEqual(entregas.length, 1,
        'la clienta ha recibido la campaña DOS veces — es el bug que este test existe para cazar');
    assert.strictEqual(t2.enviados, 0);
});

test('la fila NO queda en "failed" después de una entrega confirmada', async () => {
    resetState(); _resetThrottle();
    state.fallosRegistroPendientes = 99;
    await correr([]);

    const fila = state.sends.find(s => s.telefono === sanitizePhone(CONTACTO.telefono));
    assert.ok(fila, 'el claim sigue ahí');
    assert.notStrictEqual(fila.status, 'failed',
        'marcar failed algo ya entregado es lo que resetStaleBroadcastClaims borra → reenvío');
    assert.strictEqual(fila.status, 'pending');
});

test('el resumen no cuenta al mismo contacto en dos sitios', async () => {
    resetState(); _resetThrottle();
    state.fallosRegistroPendientes = 99;
    const r = await correr([]);

    assert.strictEqual(r.enviados, 1, 'se entregó');
    assert.strictEqual(r.omitidos, 0, 'no es un fallo de envío: la clienta lo recibió');
    assert.strictEqual(r.registro_fallido, 1, 'va a su propio contador');
    // Y la aritmética del operador cuadra: nadie está contado dos veces.
    assert.strictEqual(r.enviados + r.omitidos, r.total_audiencia);
});

test('se avisa a una persona: hay riesgo de reenvío si se relanza', async () => {
    resetState(); _resetThrottle();
    state.fallosRegistroPendientes = 99;
    await correr([]);

    assert.strictEqual(avisos.length, 1);
    assert.ok(/s[íi] lo ha recibido/i.test(avisos[0].mensaje), 'tiene que decir que llegó');
    assert.ok(/segunda vez|reenv/i.test(avisos[0].mensaje), 'y cuál es el riesgo');
    assert.ok(state.logs.some(l => l.evento === 'campana_entregado_sin_registrar'));
});

test('el registro se reintenta antes de rendirse', async () => {
    resetState(); _resetThrottle();
    state.fallosRegistroPendientes = 2; // falla dos veces, a la tercera entra
    const r = await correr([]);

    assert.strictEqual(state.registrosIntentados, 3);
    assert.strictEqual(r.registro_fallido, 0, 'se recuperó: no hay nada que avisar');
    assert.strictEqual(avisos.length, 0);
    const fila = state.sends.find(s => s.telefono === sanitizePhone(CONTACTO.telefono));
    assert.strictEqual(fila.status, 'sent');
});

// ─── Lo que NO se puede haber roto ───────────────────────────────────────────

test('camino feliz · se marca sent y la tanda siguiente lo excluye', async () => {
    resetState(); _resetThrottle();
    const entregas = [];

    const t1 = await correr(entregas);
    assert.strictEqual(t1.enviados, 1);
    assert.strictEqual(t1.registro_fallido, 0);
    const fila = state.sends.find(s => s.telefono === sanitizePhone(CONTACTO.telefono));
    assert.strictEqual(fila.status, 'sent');

    const t2 = await correr(entregas);
    assert.strictEqual(entregas.length, 1, 'no se reenvía a quien ya está sent');
    assert.strictEqual(t2.enviados, 0);
});

test('un fallo de ENVÍO real sí marca failed y sí se reintenta después', async () => {
    resetState(); _resetThrottle();
    const entregas = [];

    // El envío revienta: no ha llegado nada al móvil de nadie.
    const r1 = await runBroadcast(SANTE_ORG_ID, {
        client: clienteFalso(entregas),
        destinatarios: [CONTACTO],
        mensaje: 'Hola',
        campaignKey: CAMPANA,
        sendText: async () => { throw new Error('360dialog send 500: Internal'); },
    });
    assert.strictEqual(r1.enviados, 0);
    assert.strictEqual(r1.omitidos, 1, 'esto SÍ es un fallo de envío');
    assert.strictEqual(r1.registro_fallido, 0);
    const fila = state.sends.find(s => s.telefono === sanitizePhone(CONTACTO.telefono));
    assert.strictEqual(fila.status, 'failed', 'no llegó nada: reintentarlo es lo correcto');

    // Y la tanda siguiente sí vuelve a intentarlo: resetStale borra los 'failed'.
    const r2 = await correr(entregas);
    assert.strictEqual(entregas.length, 1, 'ahora sí se entrega');
    assert.strictEqual(r2.enviados, 1);
});

test('si además falla el registro DEL FALLO, queda rastro (no un catch mudo)', async () => {
    resetState(); _resetThrottle();
    const original = dbStub.finishBroadcastSend;
    dbStub.finishBroadcastSend = async () => { throw new Error('supabase caído'); };

    const r = await runBroadcast(SANTE_ORG_ID, {
        client: clienteFalso([]),
        destinatarios: [CONTACTO],
        mensaje: 'Hola',
        campaignKey: CAMPANA,
        sendText: async () => { throw new Error('360dialog send 500: Internal'); },
    });
    assert.strictEqual(r.omitidos, 1);
    assert.ok(state.logs.some(l => l.evento === 'campana_registro_fallo_no_guardado'),
        'antes era un .catch(() => {}) sin log: se perdía el único rastro');

    dbStub.finishBroadcastSend = original;
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
