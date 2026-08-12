/**
 * tests/blacklist-aviso-entrega.test.js — el aviso de lista negra solo cuenta si LLEGA.
 *
 * Hallazgo 3 de la auditoría del 12/08/2026. `bot.js` ponía `blacklistNotified = true` como
 * PRIMERA línea de la rama y disparaba `notifyBlacklistAlert(...).catch(() => {})` sin
 * esperarla: la inversión exacta de la regla de `alertOnce`, que marca la clave DESPUÉS de que
 * Telegram confirme y la libera si no.
 *
 * Y no se recuperaba solo. `rearmarSiLaFichaNoLoRefleja` desempata por `bot_mode !== 'manual'`,
 * y en este camino el `setLeadBotMode` SÍ había funcionado: la ficha reflejaba el bloqueo
 * perfectamente y lo único que faltaba era el empujón que hace que alguien lo mire. El rearme
 * miraba hacia otro lado y el aviso se perdía para siempre, en silencio, en el escenario para
 * el que se escribió (el acosador del 10/08).
 *
 * DOS BANDERAS, y es la parte del diseño que hay que entender antes de tocarlo:
 *
 *   · `blacklistNotified`        → el bloqueo ya está PROCESADO en la ficha (manual, escalada,
 *                                  fila en pending_actions). No se repite nunca.
 *   · `blacklistAlertEntregado`  → Telegram lo confirmó. Se reintenta hasta que sea cierto.
 *
 * Con una sola bandera no hay forma de reintentar el aviso sin repetir el INSERT de
 * `pending_actions`, que NO es idempotente: con Telegram caído se abriría una fila por cada
 * mensaje que escriba. Ese es el caso 3 de abajo y es el que justifica la bandera nueva.
 *
 * Hermético: Supabase, Telegram y el LLM interceptados en require.cache. Cero red.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const assert = require('assert');

const SANTE_ORG = process.env.SANTE_ORG_ID || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// ─── Supabase con memoria en `contacts` ──────────────────────────────────────────────
// Guarda los UPDATE: la rama pone bot_mode='manual' y la recarga vuelve a leer esa ficha para
// decidir si el bloqueo ya está procesado. Con una ficha que contestara 'auto' para siempre,
// el rearme dispararía cada turno y mediríamos el mock.
const sqlCalls = [];
const ficha = {
    id: 'contact-sante', organization_id: SANTE_ORG, wa_phone: null,
    full_name: 'Contacto Test', bot_mode: 'auto', is_blacklisted: true,
    blacklist_reason: 'Amenazas', escalation_reason: null, is_vip: false,
    estado: 'pendiente', language: 'es', metadata: {}, visit_count: 0,
    created_at: '2026-07-01T10:00:00.000Z',
};

function makeBuilder() {
    const state = { table: null, op: 'select', payload: null, filters: [], single: false };
    const resolve = () => { sqlCalls.push(state); return Promise.resolve(respond(state)); };
    const b = {
        from(t) { state.table = t; return b; },
        select() { return b; },
        insert(p) { state.op = 'insert'; state.payload = p; return b; },
        upsert(p) { state.op = 'upsert'; state.payload = p; return b; },
        update(p) { state.op = 'update'; state.payload = p; return b; },
        delete() { state.op = 'delete'; return b; },
        eq(k, v) { state.filters.push(['eq', k, v]); return b; },
        neq(k, v) { state.filters.push(['neq', k, v]); return b; },
        in(k, v) { state.filters.push(['in', k, v]); return b; },
        gte(k, v) { state.filters.push(['gte', k, v]); return b; },
        lte(k, v) { state.filters.push(['lte', k, v]); return b; },
        lt(k, v) { state.filters.push(['lt', k, v]); return b; },
        gt(k, v) { state.filters.push(['gt', k, v]); return b; },
        is(k, v) { state.filters.push(['is', k, v]); return b; },
        or() { return b; }, not() { return b; }, order() { return b; }, limit() { return b; },
        single() { state.single = true; return resolve(); },
        maybeSingle() { state.single = true; return resolve(); },
        then(onF, onR) { return resolve().then(onF, onR); },
    };
    return b;
}

function respond(state) {
    const { table, op, single, filters, payload } = state;
    if (table === 'contacts' && op === 'update') {
        Object.assign(ficha, payload);
        return { data: [{ id: ficha.id }], error: null };
    }
    if (op === 'insert' || op === 'upsert') return { data: { id: `${table}-row-1` }, error: null };
    if (op === 'update' || op === 'delete') return { data: single ? { id: `${table}-row-1` } : [], error: null };
    if (table === 'contacts') {
        const phone = filters.find(f => f[1] === 'wa_phone')?.[2] || null;
        const row = { ...ficha, wa_phone: phone };
        return { data: single ? row : [row], error: null };
    }
    return { data: single ? null : [], error: null };
}

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from(t) { return makeBuilder().from(t); } },
};

// ─── Telegram con INTERRUPTOR de entrega ─────────────────────────────────────────────
// `tg.entrega` es lo que devuelve el notificador: true = llegó, false = el bot está caído, la
// org no tiene admins o Telegram lo rechazó. Las tres son lo mismo para quien llama.
const tg = { intentos: [], entrega: true };
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        startTelegramBot: () => {},
        notifyEscalation:     async () => true,
        notifyBlacklistAlert: async (...a) => { tg.intentos.push(a); return tg.entrega; },
        notifyBizumPending:   async () => {},
        notifyVipSuggestion:  async () => {},
        notifyOrgAdmin:       async () => true,
    },
};

const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

const openai = require('../services/providers/openai');
openai.getChatbotResponse = async () => ({
    respuesta: 'Ok 😊', reserva_confirmada: false, slot_rechazado: false, accion: null, datos: {},
});
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const { makeClient, makeMessage } = require('./lib/convo');

let fallos = 0;
async function test(nombre, fn) {
    try { await fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`fail - ${nombre}\n   ${e.message}`); }
}

// Teléfono único por corrida: memory.js persiste de verdad en data/clients.db y una sesión
// vieja traería sus banderas puestas.
const PHONE_DIGITS = `34600${String(Date.now()).slice(-6)}`;
const phone = `${PHONE_DIGITS}@c.us`;
const sink = [];
const client = makeClient(sink);

async function turn(text) {
    await bot.handleIncomingMessage(client, makeMessage(phone, text), SANTE_ORG);
    await bot._internals.flushBuffer(SANTE_ORG, phone);
    const s = bot._internals.getSession(SANTE_ORG, phone);
    if (s) s.lastMessageTime = 0;
}
const session = () => bot._internals.getSession(SANTE_ORG, phone);
const olvidarSesionViva = () =>
    bot._internals.userSessions.delete(bot._internals.sessionKey(SANTE_ORG, phone));
const insertsPending = () => sqlCalls.filter(c => c.table === 'pending_actions' && c.op === 'insert');

(async () => {
    // ═══ Telegram CAÍDO desde el principio ════════════════════════════════════════════
    tg.entrega = false;
    await turn('hola??');

    await test('1 · con Telegram caído, el bloqueo SÍ se procesa en la ficha', async () => {
        assert.strictEqual(ficha.bot_mode, 'manual', 'la ficha queda en manual');
        assert.strictEqual(ficha.escalation_reason, 'lista_negra');
        assert.strictEqual(insertsPending().length, 1, 'una fila en pending_actions');
        assert.strictEqual(session().blacklistNotified, true, 'el lado de la BD queda hecho');
    });

    await test('2 · pero el aviso NO se da por dado: se intentó y no llegó', async () => {
        assert.strictEqual(tg.intentos.length, 1, 'se intentó una vez');
        assert.strictEqual(session().blacklistAlertEntregado, false,
            'sin confirmación de Telegram la bandera NO se pone: es el patrón de alertOnce');
        assert.ok(logs.some(l => l.evento === 'blacklist_aviso_no_entregado'),
            'y queda dicho en el log, que es lo único que prueba que no llegó');
    });

    await test('3 · el reintento NO reabre la escalada (la razón de que sean DOS banderas)', async () => {
        await turn('contéstame');
        assert.strictEqual(tg.intentos.length, 2, 'se reintenta el aviso al escribir otra vez');
        assert.strictEqual(insertsPending().length, 1,
            'y NO se abre una segunda pending_actions: con una sola bandera saldría una por mensaje');
        assert.deepStrictEqual(sink.map(m => m.text), [], 'y al salón se le sigue sin contestar');
    });

    await test('4 · el reintento sobrevive a un timeout de sesión', async () => {
        olvidarSesionViva();
        await turn('sigo aquí');
        assert.strictEqual(session().blacklistNotified, true,
            'el bloqueo sigue procesado: no se rehace nada de la ficha');
        assert.strictEqual(insertsPending().length, 1, 'sigue habiendo UNA escalada');
        assert.strictEqual(tg.intentos.length, 3, 'y se vuelve a intentar el aviso');
    });

    // ═══ Telegram VUELVE ══════════════════════════════════════════════════════════════
    await test('5 · cuando Telegram vuelve, el aviso llega y la bandera se pone', async () => {
        tg.entrega = true;
        await turn('¿hay alguien?');
        assert.strictEqual(tg.intentos.length, 4, 'un intento más, el bueno');
        assert.strictEqual(session().blacklistAlertEntregado, true,
            'ahora sí: se confirmó la entrega');
        assert.strictEqual(insertsPending().length, 1, 'y la escalada sigue siendo una');
    });

    await test('6 · entregado el aviso, NO se repite por muchos mensajes que mande', async () => {
        await turn('otra vez');
        await turn('y otra');
        assert.strictEqual(tg.intentos.length, 4,
            'ni un Telegram más: es la conducta que blacklistNotified vino a dar y no se pierde');
    });

    await test('7 · tras un timeout, tampoco (la entrega viaja a SQLite)', async () => {
        olvidarSesionViva();
        await turn('sigo insistiendo');
        assert.strictEqual(session().blacklistAlertEntregado, true,
            'la bandera llega desde SQLite; sin persistirla se mandaría otro aviso por sesión');
        assert.strictEqual(tg.intentos.length, 4, 'cero avisos nuevos');
    });

    await test('8 · buildSessionExtra la lleva (si no, el caso 7 es imposible)', async () => {
        const extra = bot._internals.buildSessionExtra(session());
        assert.strictEqual(extra.blacklistAlertEntregado, true,
            'tiene que ir en el extra que persiste memory.js');
        assert.strictEqual(extra.blacklistNotified, true, 'y la de siempre sigue yendo');
    });

    await test('9 · si la ficha deja de reflejar el bloqueo, se rearma TODO, aviso incluido', async () => {
        // Rebloqueo sin mensaje en medio: la sesión guardada dice "ya avisado" pero la ficha
        // está en 'auto', o sea que ese bloqueo no lo ha procesado nadie. El aviso del bloqueo
        // NUEVO es un aviso nuevo: dejar la entrega en true lo dejaría mudo.
        ficha.bot_mode = 'auto';
        ficha.escalation_reason = null;
        olvidarSesionViva();
        await turn('vuelvo');
        assert.strictEqual(ficha.bot_mode, 'manual', 'la ficha se vuelve a poner en manual');
        assert.strictEqual(insertsPending().length, 2, 'y sí hay una escalada nueva: es otro bloqueo');
        assert.strictEqual(tg.intentos.length, 5, 'con su aviso');
        assert.strictEqual(session().blacklistAlertEntregado, true, 'entregado, porque Telegram va');
    });

    console.log(fallos === 0 ? '\n✅ El aviso de lista negra solo cuenta si llega' : `\n❌ ${fallos} fallo(s)`);
    if (fallos) process.exitCode = 1;
})();
