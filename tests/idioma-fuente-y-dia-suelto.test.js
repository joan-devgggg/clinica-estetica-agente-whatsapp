/**
 * De dónde salió el idioma de una ficha, y qué pasa cuando la clienta dice un día a secas.
 *
 * Caso real (05/08/2026). Contacto 19542240982, prefijo +1 (EEUU), ficha creada con su cita
 * y `language = 'es'` — el default del INSERT, que no eligió nadie. Escribe "Thursday" (el
 * día de su cita) y 36 s después una foto. Las dos respuestas salen en castellano.
 *
 * Eran dos fallos encadenados, y hacían falta los dos:
 *
 *   A · detectLanguage("Thursday") devolvía null. La lista de marcadores en inglés llevaba
 *       tomorrow/today/morning/afternoon pero ningún día de la semana, y un día suelto es de
 *       las respuestas más frecuentes que hay ("¿qué día te viene bien?"). Con null, el
 *       idioma lo decide el LLM.
 *   B · …y al LLM se le anunciaba ese 'es' por defecto como «Último idioma detectado», que es
 *       una afirmación que nadie había hecho. Ante una palabra suelta, el modelo se quedó ahí.
 *       La columna `contacts.language` mezcla tres calidades —observada, deducida del nombre,
 *       default— y ninguna capa las distinguía: ni el prompt, ni la campaña de plantillas.
 *
 * Aquí se prueban las dos, y por separado: A es una lista de palabras, B es de quién se fía
 * el bot. Con solo A arreglado este caso sale bien y "ok"/"yes" siguen fallando.
 *
 * El bloque E conduce el MOTOR REAL (bot.handleIncomingMessage + flushBuffer) con Supabase
 * interceptado a nivel de cliente: corre el db.js de verdad encima. Cero red.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const assert = require('assert');

const SANTE_ORG = process.env.SANTE_ORG_ID || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const SANREMO_ORG = process.env.SANREMO_ORG_ID || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── Supabase interceptado, con estado ───────────────────────────────────────────────
const contactos = new Map();   // wa_phone → fila
const sqlCalls = [];
let seq = 0;

function makeBuilder() {
    const st = { table: null, op: 'select', payload: null, filters: [], single: false };
    const resolve = () => { sqlCalls.push(st); return Promise.resolve(respond(st)); };
    const b = {
        from(t) { st.table = t; return b; },
        select() { return b; },
        insert(p) { st.op = 'insert'; st.payload = p; return b; },
        upsert(p) { st.op = 'upsert'; st.payload = p; return b; },
        update(p) { st.op = 'update'; st.payload = p; return b; },
        delete() { st.op = 'delete'; return b; },
        eq(k, v) { st.filters.push(['eq', k, v]); return b; },
        neq() { return b; }, in() { return b; }, gte() { return b; }, lte() { return b; },
        lt() { return b; }, gt() { return b; }, is() { return b; },
        or() { return b; }, not() { return b; }, order() { return b; }, limit() { return b; },
        single() { st.single = true; return resolve(); },
        maybeSingle() { st.single = true; return resolve(); },
        then(f, r) { return resolve().then(f, r); },
    };
    return b;
}

const filtro = (filters, col) => filters.find(f => f[1] === col)?.[2];

function respond(st) {
    const { table, op, single, filters, payload } = st;

    if (table === 'contacts') {
        if (op === 'insert') {
            const fila = { id: `contact-${++seq}`, ...payload };
            contactos.set(fila.wa_phone, fila);
            return { data: single ? { id: fila.id } : [{ id: fila.id }], error: null };
        }
        if (op === 'update') {
            const id = filtro(filters, 'id');
            const fila = [...contactos.values()].find(r => r.id === id);
            if (fila) Object.assign(fila, payload);
            return { data: single ? (fila ? { id } : null) : (fila ? [{ id }] : []), error: null };
        }
        const phone = filtro(filters, 'wa_phone');
        const id = filtro(filters, 'id');
        let fila = null;
        if (phone) fila = contactos.get(phone) || null;
        else if (id) fila = [...contactos.values()].find(r => r.id === id) || null;
        return { data: single ? fila : (fila ? [fila] : []), error: null };
    }

    if (op === 'insert' || op === 'upsert') return { data: { id: `${table}-${++seq}` }, error: null };
    if (op === 'update' || op === 'delete') return { data: single ? { id: `${table}-x` } : [], error: null };
    if (table === 'conversations') return { data: single ? { id: 'conv-1' } : [], error: null };
    if (table === 'appointments') return { data: single ? null : [], error: null };
    return { data: single ? null : [], error: null };
}

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from(t) { return makeBuilder().from(t); } },
};

const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        startTelegramBot: () => {}, notifyEscalation: async () => {},
        notifyBlacklistAlert: async () => {}, notifyBizumPending: async () => {},
        notifyVipSuggestion: async () => {}, notifyOrgAdmin: () => {},
    },
};

const logs = [];
const rec = level => (evento, f = {}) => { logs.push({ level, evento, ...f }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

// El LLM responde fijo, pero ANOTA el contexto de idioma que se le pasa: es justo el dato
// que estaba mal (un default anunciado como observación) y no se puede afirmar de otra forma.
const openai = require('../services/providers/openai');
const { buildSystemPrompt } = openai;
const vistoPorElLLM = [];
openai.getChatbotResponse = async (_orgId, _hist, partialData = {}) => {
    vistoPorElLLM.push({
        language: partialData.__clientLanguage ?? null,
        source: partialData.__clientLanguageSource ?? null,
    });
    return { respuesta: 'Ok 😊', reserva_confirmada: false, slot_rechazado: false, accion: null, datos: {} };
};
openai.summarizeHistory = async () => null;

const { detectLanguage, resolveLanguageSource, LANGUAGE_SOURCES } = require('../services/helpers');
const db = require('../services/db');
const bot = require('../bot');
const { makeClient, makeMessage } = require('./lib/convo');

// ─── Runner ──────────────────────────────────────────────────────────────────────────
async function test(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

function driver(orgId, phoneDigits) {
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
            if (s) s.lastMessageTime = 0;   // la ventana anti-duplicado de 1500 ms
            return sink.slice(before).map(m => m.text);
        },
        session() { return bot._internals.getSession(orgId, phone); },
    };
}

const ultimo = () => vistoPorElLLM[vistoPorElLLM.length - 1];

(async () => {
    // ═══ A · un día de la semana a secas ══════════════════════════════════════════════

    await test('A1 · "Thursday" es inglés (el caso real de 19542240982)', () => {
        assert.strictEqual(detectLanguage('Thursday'), 'en');
    });

    await test('A2 · los siete días en inglés, en cualquier caja y con puntuación', () => {
        const dias = ['Monday', 'tuesday', 'WEDNESDAY', 'Thursday', 'friday', 'Saturday', 'sunday'];
        for (const d of dias) assert.strictEqual(detectLanguage(d), 'en', `«${d}» debería ser en`);
        assert.strictEqual(detectLanguage('thursday?'), 'en');
        assert.strictEqual(detectLanguage('  Friday  '), 'en');
        assert.strictEqual(detectLanguage('Thursday at 5pm'), 'en');
    });

    await test('A3 · simetría: un día suelto en español también decide', () => {
        const dias = ['lunes', 'Martes', 'miércoles', 'miercoles', 'JUEVES', 'viernes', 'sábado', 'sabado', 'domingo'];
        for (const d of dias) assert.strictEqual(detectLanguage(d), 'es', `«${d}» debería ser es`);
    });

    await test('A4 · ningún día activa las dos listas a la vez (no hay solape)', () => {
        // Si un día español fuese subcadena de uno inglés (o al revés) saldría null y el
        // arreglo no serviría de nada: hasEs && hasEn devuelve null.
        const todos = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
            'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
        for (const d of todos) assert.ok(detectLanguage(d) !== null, `«${d}» no puede quedar ambiguo`);
    });

    await test('A5 · lo que YA funcionaba sigue igual (cirílico, ambiguos, frases)', () => {
        assert.strictEqual(detectLanguage('Доброго дня'), 'uk');
        assert.strictEqual(detectLanguage('Спасибо'), 'ru');
        assert.strictEqual(detectLanguage('hola quiero una cita'), 'es');
        assert.strictEqual(detectLanguage('hello I want an appointment'), 'en');
        assert.strictEqual(detectLanguage('Yulia'), null, 'un nombre suelto sigue siendo ambiguo');
        assert.strictEqual(detectLanguage('ok'), null);
        assert.strictEqual(detectLanguage(''), null);
    });

    // ═══ B · resolveLanguageSource: qué se puede afirmar de una fila sin marca ═════════

    await test('B1 · la marca explícita manda sobre todo lo demás', () => {
        assert.strictEqual(resolveLanguageSource({ language: 'es', metadata: { language_source: 'observed' } }), 'observed');
        assert.strictEqual(resolveLanguageSource({ language: 'ru', metadata: { language_source: 'default' } }), 'default');
    });

    await test('B2 · sin marca, el booleano histórico vale como conjetura', () => {
        assert.strictEqual(resolveLanguageSource({ language: 'ru', metadata: { language_inferred: true } }), 'inferred');
    });

    await test('B3 · sin marca y sin booleano: un idioma que no es "es" no pudo salir del default', () => {
        // El default del INSERT es SIEMPRE 'es'. Un 'ru'/'uk'/'en' llegó por detección o por
        // la ficha del panel, así que se respeta.
        assert.strictEqual(resolveLanguageSource({ language: 'ru', metadata: null }), 'observed');
        assert.strictEqual(resolveLanguageSource({ language: 'en', metadata: {} }), 'observed');
    });

    await test('B4 · un "es" sin marca se trata como default — es el caso de 19542240982', () => {
        assert.strictEqual(resolveLanguageSource({ language: 'es', metadata: null }), 'default');
        assert.strictEqual(resolveLanguageSource({ language: null, metadata: null }), 'default');
        assert.strictEqual(resolveLanguageSource(null), 'default');
    });

    await test('B5 · una marca inventada no se cuela (se cae al respaldo)', () => {
        assert.deepStrictEqual(LANGUAGE_SOURCES, ['observed', 'inferred', 'default']);
        assert.strictEqual(resolveLanguageSource({ language: 'ru', metadata: { language_source: 'telepatía' } }), 'observed');
    });

    // ═══ C · dónde se estampa la fuente (db.js) ═══════════════════════════════════════

    await test('C1 · saveLead marca "default" cuando nace sin idioma (el INSERT que no elige nadie)', async () => {
        const id = await db.saveLead(SANTE_ORG, { telefono: '34600000101' });
        const fila = contactos.get('34600000101');
        assert.ok(id);
        assert.strictEqual(fila.language, 'es', 'el valor de la columna no cambia');
        assert.strictEqual(fila.metadata.language_source, 'default', 'pero ya se sabe que es de relleno');
        assert.strictEqual((await db.findById(SANTE_ORG, id)).language_source, 'default');
    });

    await test('C2 · saveLead con idioma ya observado en el turno lo marca "observed"', async () => {
        await db.saveLead(SANTE_ORG, { telefono: '34600000102', language: 'uk' });
        assert.strictEqual(contactos.get('34600000102').metadata.language_source, 'observed');
    });

    await test('C3 · updateContactLanguage marca "observed" y FUSIONA metadata', async () => {
        contactos.set('34600000103', {
            id: 'contact-C3', organization_id: SANTE_ORG, wa_phone: '34600000103',
            language: 'es', metadata: { wa_jid: '34600000103@c.us', language_source: 'default' },
        });
        await db.updateContactLanguage(SANTE_ORG, 'contact-C3', 'en');
        const meta = contactos.get('34600000103').metadata;
        assert.strictEqual(contactos.get('34600000103').language, 'en');
        assert.strictEqual(meta.language_source, 'observed');
        assert.strictEqual(meta.wa_jid, '34600000103@c.us',
            'un UPDATE de jsonb sustituye el objeto entero: sin fusionar, el panel pierde el chat');
        assert.ok(meta.language_observed_at, 'cuándo se observó');
    });

    await test('C4 · observar el idioma apaga la conjetura por nombre', async () => {
        contactos.set('34600000104', {
            id: 'contact-C4', organization_id: SANTE_ORG, wa_phone: '34600000104',
            language: 'ru',
            metadata: { language_source: 'inferred', language_inferred: true, language_inference_source: 'name_heuristic' },
        });
        await db.updateContactLanguage(SANTE_ORG, 'contact-C4', 'uk');
        const ficha = await db.findById(SANTE_ORG, 'contact-C4');
        assert.strictEqual(ficha.language, 'uk');
        assert.strictEqual(ficha.language_source, 'observed');
        assert.strictEqual(ficha.language_inferred, false,
            'la ficha no puede seguir avisando «deducido de su nombre» de algo ya observado');
    });

    await test('C5 · sin nada que cambiar no escribe (se llama en CADA turno del salón)', async () => {
        contactos.set('34600000105', {
            id: 'contact-C5', organization_id: SANTE_ORG, wa_phone: '34600000105',
            language: 'ru', metadata: { language_source: 'observed' },
        });
        const antes = sqlCalls.filter(c => c.table === 'contacts' && c.op === 'update').length;
        await db.updateContactLanguage(SANTE_ORG, 'contact-C5', 'ru');
        const despues = sqlCalls.filter(c => c.table === 'contacts' && c.op === 'update').length;
        assert.strictEqual(despues, antes, 'un UPDATE por mensaje para dejar la fila igual');
    });

    await test('C6 · sigue LANZANDO si el UPDATE no toca ninguna fila', async () => {
        await assert.rejects(
            () => db.updateContactLanguage(SANTE_ORG, 'contact-que-no-existe', 'uk'),
            /no encontró la fila/,
        );
    });

    await test('C7 · corregir el idioma desde la ficha del panel es "observed"', async () => {
        contactos.set('34600000107', {
            id: 'contact-C7', organization_id: SANTE_ORG, wa_phone: '34600000107',
            language: 'ru', metadata: { wa_jid: 'x@c.us', language_source: 'inferred', language_inferred: true },
        });
        await db.updateLeadById(SANTE_ORG, 'contact-C7', { language: 'uk' });
        const meta = contactos.get('34600000107').metadata;
        assert.strictEqual(contactos.get('34600000107').language, 'uk');
        assert.strictEqual(meta.language_source, 'observed', 'lo ha elegido una persona: no hay fuente mejor');
        assert.strictEqual(meta.language_inferred, false);
        assert.strictEqual(meta.wa_jid, 'x@c.us');
    });

    await test('C8 · guardar la ficha SIN tocar el idioma no reescribe metadata (San Remo incluido)', async () => {
        contactos.set('34600000108', {
            id: 'contact-C8', organization_id: SANREMO_ORG, wa_phone: '34600000108',
            language: 'es', metadata: { wa_jid: 'sanremo@c.us' },
        });
        await db.updateLeadById(SANREMO_ORG, 'contact-C8', { notas: 'mesa junto a la ventana' });
        assert.deepStrictEqual(contactos.get('34600000108').metadata, { wa_jid: 'sanremo@c.us' },
            'el camino del restaurante no pasa por el idioma ni paga la lectura extra');
    });

    await test('C9 · setInferredContactLanguage marca "inferred"', async () => {
        contactos.set('34600000109', {
            id: 'contact-C9', organization_id: SANTE_ORG, wa_phone: '34600000109',
            language: 'es', metadata: { wa_jid: 'y@c.us' },
        });
        await db.setInferredContactLanguage(SANTE_ORG, 'contact-C9', 'ru', 'Natalia');
        const ficha = await db.findById(SANTE_ORG, 'contact-C9');
        assert.strictEqual(ficha.language_source, 'inferred');
        assert.strictEqual(ficha.language_inferred, true);
        assert.strictEqual(contactos.get('34600000109').metadata.wa_jid, 'y@c.us');
    });

    // ═══ D · el prompt no anuncia como observado lo que no lo es ══════════════════════

    await test('D1 · sin idioma → "aún no se conoce", que es lo que había que decir', () => {
        const p = buildSystemPrompt(SANTE_ORG, { __clientLanguage: null }, 'general', false, null, null);
        assert.ok(/Aún no se conoce el idioma/.test(p));
        assert.ok(!/Último idioma detectado/.test(p));
    });

    await test('D2 · idioma observado → sigue diciéndose «último idioma detectado» (sin cambios)', () => {
        const p = buildSystemPrompt(SANTE_ORG,
            { __clientLanguage: 'ru', __clientLanguageSource: 'observed' }, 'general', false, null, null);
        assert.ok(/Último idioma detectado: "ru"/.test(p));
    });

    await test('D3 · idioma deducido del nombre → se anuncia como PROBABLE, no como detectado', () => {
        const p = buildSystemPrompt(SANTE_ORG,
            { __clientLanguage: 'ru', __clientLanguageSource: 'inferred' }, 'general', false, null, null);
        assert.ok(/PROBABLE/.test(p), 'una conjetura por nombre no puede pesar como una observación');
        assert.ok(/deducido de su nombre/.test(p));
        assert.ok(!/Último idioma detectado/.test(p),
            'la heurística por nombre no distingue ruso de ucraniano: afirmarlo es lo que la hace dañina');
    });

    // ═══ E · el motor real, con el caso tal como ocurrió ══════════════════════════════

    await test('E1 · "Thursday" con la ficha en el "es" por defecto → inglés en sesión Y en ficha', async () => {
        const tel = `1954${String(Date.now()).slice(-6)}`;
        contactos.set(tel, {
            id: 'contact-E1', organization_id: SANTE_ORG, wa_phone: tel,
            full_name: 'Tammy N.', language: 'es', metadata: null,   // el default, sin marca
        });
        const d = driver(SANTE_ORG, tel);
        await d.turn('Thursday');

        assert.strictEqual(d.session().language, 'en', 'ANTES: se quedaba en el "es" de la ficha');
        assert.strictEqual(d.session().languageSource, 'observed');
        assert.strictEqual(contactos.get(tel).language, 'en', 'y aterriza en la ficha');
        assert.strictEqual(contactos.get(tel).metadata.language_source, 'observed');
    });

    await test('E2 · un mensaje ambiguo NO hereda el default: al LLM se le dice que no se sabe', async () => {
        const tel = `1954${String(Date.now()).slice(-6)}9`;
        contactos.set(tel, {
            id: 'contact-E2', organization_id: SANTE_ORG, wa_phone: tel,
            full_name: 'Clienta E2', language: 'es', metadata: null,
        });
        const d = driver(SANTE_ORG, tel);
        await d.turn('ok');

        assert.strictEqual(ultimo().language, null,
            'ANTES: se le pasaba "es" y el modelo lo trataba como dato — de ahí el saludo en castellano');
        assert.strictEqual(ultimo().source, 'default');
        assert.strictEqual(contactos.get(tel).language, 'es', 'la columna NO se toca: la campaña sigue igual');
        assert.ok(logs.some(l => l.evento === 'idioma_ficha_por_defecto_ignorado'),
            'ignorar un dato de la ficha tiene que dejar traza');
    });

    await test('E3 · un idioma OBSERVADO en la ficha sí se hereda (no se ha roto la memoria)', async () => {
        const tel = `3460${String(Date.now()).slice(-6)}`;
        contactos.set(tel, {
            id: 'contact-E3', organization_id: SANTE_ORG, wa_phone: tel,
            full_name: 'Clienta E3', language: 'ru',
            metadata: { language_source: 'observed' },
        });
        const d = driver(SANTE_ORG, tel);
        await d.turn('ok');

        assert.strictEqual(ultimo().language, 'ru', 'lo que la clienta demostró se conserva');
        assert.strictEqual(ultimo().source, 'observed');
    });

    await test('E4 · un idioma INFERIDO se hereda, pero declarado como conjetura', async () => {
        const tel = `3461${String(Date.now()).slice(-6)}`;
        contactos.set(tel, {
            id: 'contact-E4', organization_id: SANTE_ORG, wa_phone: tel,
            full_name: 'Marta Malamud', language: 'ru',
            metadata: { language_source: 'inferred', language_inferred: true },
        });
        const d = driver(SANTE_ORG, tel);
        await d.turn('ok');

        assert.strictEqual(ultimo().language, 'ru');
        assert.strictEqual(ultimo().source, 'inferred');
    });

    if (!process.exitCode) console.log('\nTests de fuente del idioma y día suelto OK');
    process.exit(process.exitCode || 0);
})();
