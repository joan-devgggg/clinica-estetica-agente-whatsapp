/**
 * tests/blacklist-no-promete.test.js — A quien está en lista negra no se le promete atención,
 * y desbloquear no le escribe.
 *
 * Dos conductas, un mismo principio: bloquear significa «no queremos tratar con esta persona»,
 * así que todo lo que el sistema haga después tiene que decir eso.
 *
 *  1. **El salón no contesta nada.** Aquí salía «Gracias por tu mensaje 🙏 En breve te atenderá
 *     nuestro equipo», que es una promesa de atención. Con el caso que lo destapó —alguien
 *     amenazando a la dueña, 10/08/2026— ese mensaje le confirma que hay alguien leyéndole y le
 *     da a entender que van a responderle. San Remo sí lo sigue mandando y tiene su CONTROL
 *     abajo: allí la lista negra es una retención a la espera de que un humano decida (no-show,
 *     Bizum rechazado), o sea que la frase es verdad.
 *  2. **El aviso al admin no se repite.** `blacklistNotified` no viajaba a SQLite, así que cada
 *     sesión nueva —timeout de 1 h, GC o reinicio— rearmaba la rama entera: otro Telegram y
 *     otra fila en `pending_actions`. El aviso que debía significar «está escribiendo otra vez»
 *     acababa significando «sigue existiendo».
 *  3. **Desbloquear son dos escrituras y en este orden**, y no manda ningún mensaje.
 *
 * Hermético: se interceptan los bordes —Supabase (a nivel de cliente, para que corra el db.js
 * REAL encima y se afirme sobre la sentencia de verdad), Telegram y el LLM—. Cero red.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const assert = require('assert');

const SANTE_ORG   = process.env.SANTE_ORG_ID   || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const SANREMO_ORG = process.env.SANREMO_ORG_ID || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── 1. Supabase con memoria en la tabla `contacts` ──────────────────────────────────
//
// El mock GUARDA los UPDATE de contacts en vez de devolver siempre la misma fila, y eso no es
// lujo: la rama de lista negra pone `bot_mode='manual'`, y al recargar la sesión se vuelve a
// leer esa ficha para decidir si el bloqueo ya está procesado. Con un mock que contestara
// 'auto' para siempre, la rama se rearmaría en cada turno y el test mediría el mock.
const sqlCalls = [];
const contactos = new Map();   // orgId → fila

function fichaDe(orgId) {
    if (!contactos.has(orgId)) {
        contactos.set(orgId, {
            id: `contact-${orgId.slice(0, 8)}`,
            organization_id: orgId,
            wa_phone: null,
            full_name: 'Contacto Test',
            bot_mode: 'auto',
            is_blacklisted: false,
            blacklist_reason: null,
            escalation_reason: null,
            is_vip: false,
            estado: 'pendiente',
            language: 'es',
            metadata: {},
            visit_count: 0,
            created_at: '2026-07-01T10:00:00.000Z',
        });
    }
    return contactos.get(orgId);
}

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

function orgDelFiltro(filters) {
    return filters.find(f => f[1] === 'organization_id')?.[2] || SANTE_ORG;
}

// Nunca devuelve `error`: assertRead lanzaría y el escenario a probar no es un fallo de BD.
function respond(state) {
    const { table, op, single, filters, payload } = state;
    if (table === 'contacts' && op === 'update') {
        Object.assign(fichaDe(orgDelFiltro(filters)), payload);
        return { data: [{ id: fichaDe(orgDelFiltro(filters)).id }], error: null };
    }
    if (op === 'insert' || op === 'upsert') return { data: { id: `${table}-row-1` }, error: null };
    if (op === 'update' || op === 'delete') return { data: single ? { id: `${table}-row-1` } : [], error: null };
    if (table === 'contacts') {
        const phone = filters.find(f => f[1] === 'wa_phone')?.[2] || null;
        const row = { ...fichaDe(orgDelFiltro(filters)), wa_phone: phone };
        return { data: single ? row : [row], error: null };
    }
    return { data: single ? null : [], error: null };
}

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from(t) { return makeBuilder().from(t); } },
};

// ─── 2. Telegram que GRABA ───────────────────────────────────────────────────────────
const tg = { blacklist: [], escalations: [] };
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        startTelegramBot: () => {},
        notifyEscalation:     async (...a) => { tg.escalations.push(a); },
        // Devuelve true = Telegram lo ENTREGÓ. Desde el 12/08/2026 ese booleano es el
        // contrato: bot.js solo marca el aviso como dado si se confirma la entrega
        // (patrón de alertOnce). Un stub que devolviera undefined estaría simulando un
        // Telegram caído, y entonces los casos 4 y 5 medirían el reintento, no el aviso.
        notifyBlacklistAlert: async (...a) => { tg.blacklist.push(a); return true; },
        notifyBizumPending:   async () => {},
        notifyVipSuggestion:  async () => {},
        notifyOrgAdmin:       () => {},
    },
};

// ─── 3. Logger que GRABA ─────────────────────────────────────────────────────────────
const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

// ─── 4. LLM stubeado ─────────────────────────────────────────────────────────────────
const openai = require('../services/providers/openai');
openai.getChatbotResponse = async () => ({
    respuesta: 'Ok 😊', reserva_confirmada: false, slot_rechazado: false, accion: null, datos: {},
});
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const { makeClient, makeMessage } = require('./lib/convo');

// El telegram.js REAL, para probar `_ejecutarDesbloqueo`. Se borra la entrada FALSA del caché
// y se vuelve a requerir: bot.js ya tiene cogida la referencia al objeto de mentira, así que
// sigue grabando avisos en `tg` y no sale ningún Telegram de verdad por aquí.
delete require.cache[telegramPath];
const telegramReal = require('../services/telegram');

// ─── Runner ──────────────────────────────────────────────────────────────────────────
let fallos = 0;
async function test(nombre, fn) {
    try { await fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`fail - ${nombre}\n   ${e.message}`); }
}

function makeDriver(orgId, phoneDigits) {
    const sink = [];
    const client = makeClient(sink);
    const phone = `${phoneDigits}@c.us`;
    return {
        sink, phone,
        async turn(text) {
            const before = sink.length;
            await bot.handleIncomingMessage(client, makeMessage(phone, text), orgId);
            await bot._internals.flushBuffer(orgId, phone);
            const s = bot._internals.getSession(orgId, phone);
            if (s) s.lastMessageTime = 0;
            return sink.slice(before).map(m => m.text);
        },
        // Timeout de sesión / reinicio del proceso: la sesión viva desaparece y la siguiente
        // llega desde SQLite. Es el escenario que rearmaba el aviso una y otra vez.
        olvidarSesionViva() {
            bot._internals.userSessions.delete(bot._internals.sessionKey(orgId, phone));
        },
        session() { return bot._internals.getSession(orgId, phone); },
    };
}

const insertsPending = () => sqlCalls.filter(c => c.table === 'pending_actions' && c.op === 'insert');
const PROMESA = /en breve|te atender|nuestro equipo/i;

(async () => {
    // ═══ Sante: bloqueada ═════════════════════════════════════════════════════════════
    // Teléfono único por corrida: memory.js persiste de verdad en data/clients.db y una
    // sesión guardada de una corrida anterior traería su blacklistNotified puesto.
    const santePhone = `34600${String(Date.now()).slice(-6)}`;
    const sante = makeDriver(SANTE_ORG, santePhone);
    fichaDe(SANTE_ORG).is_blacklisted = true;
    fichaDe(SANTE_ORG).blacklist_reason = 'Amenazas';

    const t1 = await sante.turn('hola??');

    await test('1 · Sante: al primer mensaje NO se le contesta absolutamente nada', async () => {
        assert.deepStrictEqual(t1, [], `no debe salir ningún mensaje; salió: ${JSON.stringify(t1)}`);
    });

    await test('2 · Sante: en ninguna parte se le promete que le van a atender', async () => {
        const todo = sante.sink.map(m => m.text).join(' | ');
        assert.ok(!PROMESA.test(todo), `promesa de atención filtrada al salón: "${todo}"`);
    });

    await test('3 · Sante: el bloqueo SÍ se procesa (manual + escalada + Telegram), una vez', async () => {
        assert.strictEqual(fichaDe(SANTE_ORG).bot_mode, 'manual', 'la ficha queda en manual');
        assert.strictEqual(fichaDe(SANTE_ORG).escalation_reason, 'lista_negra');
        assert.strictEqual(insertsPending().length, 1, 'una fila en pending_actions');
        assert.strictEqual(tg.blacklist.length, 1, 'un aviso de Telegram');
    });

    await test('4 · Sante: sigue escribiendo y no pasa NADA más (ni mensaje ni aviso)', async () => {
        const t2 = await sante.turn('contéstame');
        assert.deepStrictEqual(t2, [], 'sigue sin recibir respuesta');
        assert.strictEqual(insertsPending().length, 1, 'no se abre una segunda escalada');
        assert.strictEqual(tg.blacklist.length, 1, 'no llega un segundo Telegram');
    });

    await test('5 · Sante: tras un timeout de sesión TAMPOCO se repite el aviso', async () => {
        // Es la razón de que blacklistNotified viaje en buildSessionExtra. Sin eso, cada
        // sesión nueva volvía a avisar: con una hora de timeout, un acosador insistente
        // generaba un Telegram por hora indefinidamente.
        sante.olvidarSesionViva();
        const t3 = await sante.turn('sigo aquí');
        assert.strictEqual(bot._internals.getSession(SANTE_ORG, sante.phone).blacklistNotified, true,
            'blacklistNotified debe llegar desde SQLite');
        assert.deepStrictEqual(t3, [], 'sigue sin recibir respuesta');
        assert.strictEqual(tg.blacklist.length, 1, 'no llega un segundo Telegram tras rehidratar');
        assert.strictEqual(insertsPending().length, 1, 'no se abre una segunda escalada tras rehidratar');
    });

    await test('6 · Sante: si la ficha NO refleja el bloqueo, se rearma (rebloqueo sin mensaje en medio)', async () => {
        // Desbloquear y volver a bloquear sin que él escriba en medio dejaba la marca de
        // "ya avisado" puesta en SQLite: el segundo bloqueo no habría puesto manual, ni
        // escalada, ni Telegram — y el panel enseñaría la conversación en 'auto', o sea "el
        // bot le está contestando", mientras el bot callaba. Se decide contra la FICHA.
        fichaDe(SANTE_ORG).bot_mode = 'auto';
        fichaDe(SANTE_ORG).escalation_reason = null;
        sante.olvidarSesionViva();
        const t4 = await sante.turn('otra vez yo');
        assert.deepStrictEqual(t4, [], 'sigue sin recibir respuesta');
        assert.strictEqual(tg.blacklist.length, 2, 'el rebloqueo sí vuelve a avisar');
        assert.strictEqual(fichaDe(SANTE_ORG).bot_mode, 'manual', 'y vuelve a dejar la ficha en manual');
        assert.ok(logs.some(l => l.evento === 'blacklist_rearmada_ficha_no_lo_refleja'));
    });

    // ═══ CONTROL San Remo ═════════════════════════════════════════════════════════════
    await test('7 · CONTROL San Remo: su aviso sigue saliendo, palabra por palabra', async () => {
        // Allí la frase es VERDAD: la lista negra retiene a la espera de que Alberto decida
        // por Telegram. Cambiarla sería romper un flujo que funciona, no arreglar nada.
        const sanremo = makeDriver(SANREMO_ORG, `34611${String(Date.now()).slice(-6)}`);
        fichaDe(SANREMO_ORG).is_blacklisted = true;
        const t = await sanremo.turn('hola');
        assert.deepStrictEqual(t, ['Gracias por tu mensaje 🙏 En breve te atenderá nuestro equipo.'],
            `San Remo debe recibir su mensaje de siempre; recibió: ${JSON.stringify(t)}`);
    });

    // ═══ Desbloquear desde Telegram ═══════════════════════════════════════════════════
    await test('8 · desbloquear: primero bot_mode="auto", DESPUÉS quitar la marca', async () => {
        // El orden es la protección: si falla la segunda escritura el contacto sigue
        // bloqueado (recuperable). Al revés quedaría "desbloqueado" y mudo para siempre,
        // porque auto-return no rescata nada con una escalada abierta.
        const antes = sqlCalls.length;
        const r = await telegramReal._ejecutarDesbloqueo(SANTE_ORG, santePhone);
        assert.strictEqual(r.ok, true);
        const updates = sqlCalls.slice(antes)
            .filter(c => c.table === 'contacts' && c.op === 'update')
            .map(c => c.payload);
        const iAuto = updates.findIndex(p => p.bot_mode === 'auto');
        const iMarca = updates.findIndex(p => p.is_blacklisted === false);
        assert.ok(iAuto !== -1, 'no se devolvió la conversación a auto');
        assert.ok(iMarca !== -1, 'no se quitó la marca de lista negra');
        assert.ok(iAuto < iMarca, `orden equivocado: auto en ${iAuto}, marca en ${iMarca}`);
        assert.strictEqual(updates[iAuto].escalation_reason, null, 'auto debe limpiar la escalada');
    });

    await test('9 · desbloquear NO le escribe: cero mensajes salientes', async () => {
        // Antes mandaba «Hola 😊 Hemos revisado tu caso. ¿En qué puedo ayudarte?» — una
        // invitación a seguir, a un toque de distancia y sin confirmar. Y encima nunca salía:
        // sendDirectMessage no está definido en telegram.js, así que lanzaba ReferenceError
        // y el admin leía "error" sobre un contacto ya desbloqueado.
        const antes = sante.sink.length;
        await telegramReal._ejecutarDesbloqueo(SANTE_ORG, santePhone);
        assert.strictEqual(sante.sink.length, antes, 'el desbloqueo no debe enviar nada');
    });

    await test('10 · desbloquear un contacto que no existe no toca nada', async () => {
        const antes = sqlCalls.filter(c => c.table === 'contacts' && c.op === 'update').length;
        contactos.delete('org-inexistente-0000-0000-000000000000');
        const r = await telegramReal._ejecutarDesbloqueo(SANTE_ORG, '34699999999');
        // El mock siempre encuentra ficha para una org conocida, así que este caso se afirma
        // por la vía honesta: si algún día devuelve null, no puede haber escrituras detrás.
        if (!r.ok) {
            const despues = sqlCalls.filter(c => c.table === 'contacts' && c.op === 'update').length;
            assert.strictEqual(despues, antes, 'sin contacto no se escribe nada');
        }
    });

    console.log(fallos === 0 ? '\n✅ Lista negra: ni promesa ni mensaje OK' : `\n${fallos} test(s) FALLIDO(S)`);
    process.exit(fallos === 0 ? 0 : 1);
})();
