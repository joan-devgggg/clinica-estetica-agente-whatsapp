/**
 * tests/idioma-ucraniano-y-ficha.test.js — El idioma de una clienta: detectarlo, escribirlo
 * y poder corregirlo. 05/08/2026.
 *
 * De las 720 fichas de Sante, 0 tenían 'uk' y 185 'ru', con el dueño confirmando que sí hay
 * clientas ucranianas. Tres fallos encadenados, uno por bloque de este fichero:
 *
 *   A · detectLanguage marcaba 'uk' SOLO si el texto traía і/ї/є/ґ. Sin ellas caía en 'ru',
 *       y las dos frases más frecuentes —el saludo y el gracias— no las llevan. «Доброго
 *       дня» (34696073110, 01/08) quedó como ruso.
 *   B · el idioma NO se podía corregir desde el panel: `language` no estaba en el fieldMap
 *       de updateLeadById ni en el de updateLead. La única escritura era la automática.
 *   C · y la automática tampoco aterrizaba: session.leadId solo se asignaba en la rama de
 *       sesión NUEVA, y en el primer mensaje de una desconocida todavía no hay contacto
 *       (lo crea saveMessage un instante después). La sesión seguía con leadId a null y
 *       `if (session.leadId) updateContactLanguage(...)` no llegaba a ejecutarse nunca.
 *       Resultado observado en producción: el bot responde en ruso y la ficha dice 'es'.
 *
 * El bloque C conduce el MOTOR REAL (bot.handleIncomingMessage + flushBuffer) con Supabase
 * interceptado a nivel de cliente, para que corra el db.js de verdad encima y la aserción
 * sea sobre el UPDATE real. No toca red, credenciales ni la base de producción.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const assert = require('assert');

const SANTE_ORG = process.env.SANTE_ORG_ID || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// ─── Supabase interceptado, con estado ───────────────────────────────────────────────
// Los contactos viven en un Map para poder reproducir lo que importa: una fila que NO
// existe al empezar la conversación y aparece a mitad, que es el caso del bug C.
const contactos = new Map();        // wa_phone → fila
const citasPorContacto = new Map(); // contact_id → [citas futuras]
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
        neq(k, v) { st.filters.push(['neq', k, v]); return b; },
        in(k, v) { st.filters.push(['in', k, v]); return b; },
        gte(k, v) { st.filters.push(['gte', k, v]); return b; },
        lte(k, v) { st.filters.push(['lte', k, v]); return b; },
        lt(k, v) { st.filters.push(['lt', k, v]); return b; },
        gt(k, v) { st.filters.push(['gt', k, v]); return b; },
        is(k, v) { st.filters.push(['is', k, v]); return b; },
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
            // Sin fila, cero filas afectadas: es lo que assertRowsAffected debe detectar.
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

    // Citas futuras por contacto. getUpcomingAppointments filtra con .in('contact_id', ids),
    // así que el filtro llega como ['in', 'contact_id', [...]].
    if (table === 'appointments') {
        const enIds = filters.find(f => f[0] === 'in' && f[1] === 'contact_id')?.[2] || [];
        const filas = enIds.flatMap(id => citasPorContacto.get(id) || []);
        return { data: single ? (filas[0] || null) : filas, error: null };
    }

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

// El LLM no participa en nada de lo que se afirma aquí: responde fijo para que los turnos
// sean rápidos y deterministas. `idioma_detectado` se deja fuera a propósito — lo que se
// prueba es la heurística determinista, no que el modelo acierte.
const openai = require('../services/providers/openai');
openai.getChatbotResponse = async () => ({
    respuesta: 'Ок 😊', reserva_confirmada: false, slot_rechazado: false, accion: null, datos: {},
});
openai.summarizeHistory = async () => null;

const {
    detectLanguage, normalizeText, buildCyrillicRe, IDIOMAS_SOPORTADOS,
} = require('../services/helpers');
const db = require('../services/db');
const bot = require('../bot');
const { makeClient, makeMessage } = require('./lib/convo');

// ─── Runner ──────────────────────────────────────────────────────────────────────────
const results = [];
async function test(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); results.push(true); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; results.push(false); }
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
            // La ventana anti-duplicado de 1500 ms descartaría el turno siguiente.
            if (s) s.lastMessageTime = 0;
            return sink.slice(before).map(m => m.text);
        },
        session() { return bot._internals.getSession(orgId, phone); },
    };
}

(async () => {
    // ═══ A · detectLanguage: ucraniano SIN letras exclusivas ═══════════════════════════

    await test('A1 · «Доброго дня» es ucraniano, no ruso (el caso real de 34696073110)', () => {
        assert.strictEqual(detectLanguage('Доброго дня'), 'uk');
    });

    await test('A2 · las demás fórmulas ucranianas sin і/ї/є/ґ también', () => {
        const casos = ['Дякую', 'дуже дякую!', 'Будь ласка', 'Гарного дня', 'Добрий день',
            'Доброго ранку', 'Доброго вечора', 'До побачення', 'Вибачте', 'Гаразд'];
        for (const t of casos) {
            assert.strictEqual(detectLanguage(t), 'uk', `«${t}» debería ser uk`);
        }
    });

    await test('A3 · el ruso SIGUE siendo ruso — sin este bloque el arreglo sería un cambio de bando', () => {
        const casos = ['Здравствуйте', 'Добрый день', 'Спасибо', 'Пожалуйста',
            'Привет, хочу записаться', 'Доброе утро', 'До свидания', 'Извините',
            'Хорошего дня', 'Лучше не трогать рабочий. Бот сбивается', 'Нет. Спасибо'];
        for (const t of casos) {
            assert.strictEqual(detectLanguage(t), 'ru', `«${t}» debería seguir siendo ru`);
        }
    });

    await test('A4 · la regla de las letras exclusivas no se ha tocado', () => {
        assert.strictEqual(detectLanguage('Привіт, хочу записатися'), 'uk');
        assert.strictEqual(detectLanguage('Скільки коштує?'), 'uk');
        assert.strictEqual(detectLanguage('Це моє'), 'uk');
    });

    await test('A5 · el patrón se compiló con buildCyrillicRe: sin \\b y contra texto normalizado', () => {
        // Si alguien reescribe la lista a mano dentro de un \b(...)\b, esto lo caza: la й de
        // «добрий» se descompone al normalizar y el literal crudo dejaría de casar.
        assert.strictEqual(detectLanguage('ДОБРИЙ ДЕНЬ'), 'uk', 'mayúsculas');
        assert.strictEqual(detectLanguage('  дякую!!  '), 'uk', 'con signos y espacios');
        assert.strictEqual(detectLanguage('Вітаю, будь   ласка запишіть мене'), 'uk', 'espacios múltiples');
        const re = buildCyrillicRe(['добрий день']);
        assert.ok(!re.source.includes('\\b'), 'un \\b ASCII mataría el patrón');
        assert.ok(re.test(normalizeText('Добрий день!')));
    });

    await test('A6 · no toca el camino no cirílico (es/en/null)', () => {
        assert.strictEqual(detectLanguage('hola quiero una cita'), 'es');
        assert.strictEqual(detectLanguage('hello I want an appointment'), 'en');
        assert.strictEqual(detectLanguage('Yulia'), null, 'un nombre suelto sigue siendo ambiguo');
    });

    // ═══ B · el idioma se puede corregir desde la ficha del panel ══════════════════════

    await test('B1 · updateLeadById escribe `language` (antes lo tiraba en silencio)', async () => {
        contactos.set('34600000001', {
            id: 'contact-B1', organization_id: SANTE_ORG, wa_phone: '34600000001',
            full_name: 'Clienta B1', language: 'ru', metadata: null,
        });
        await db.updateLeadById(SANTE_ORG, 'contact-B1', { language: 'uk' });
        assert.strictEqual(contactos.get('34600000001').language, 'uk',
            'la dueña debe poder marcar a una clienta como ucraniana');
    });

    await test('B2 · un idioma fuera de lista se rechaza y NO escribe nada', async () => {
        contactos.set('34600000002', {
            id: 'contact-B2', organization_id: SANTE_ORG, wa_phone: '34600000002',
            full_name: 'Clienta B2', language: 'es', metadata: null,
        });
        await assert.rejects(
            () => db.updateLeadById(SANTE_ORG, 'contact-B2', { language: 'pt' }),
            /Idioma no soportado/,
            'un idioma inventado se usaría como clave contra config.plantilla_* y omitiría a la clienta',
        );
        assert.strictEqual(contactos.get('34600000002').language, 'es', 'la fila queda intacta');
    });

    await test('B3 · guardar la ficha SIN tocar el idioma no lo pisa', async () => {
        contactos.set('34600000003', {
            id: 'contact-B3', organization_id: SANTE_ORG, wa_phone: '34600000003',
            full_name: 'Clienta B3', language: 'ru', metadata: null,
        });
        await db.updateLeadById(SANTE_ORG, 'contact-B3', { notas: 'viene el jueves' });
        assert.strictEqual(contactos.get('34600000003').language, 'ru');
    });

    await test('B4 · la ficha dice si el idioma es una CONJETURA por el nombre', async () => {
        contactos.set('34600000004', {
            id: 'contact-B4', organization_id: SANTE_ORG, wa_phone: '34600000004',
            full_name: 'Clienta B4', language: 'ru',
            metadata: { language_inferred: true, language_inference_source: 'name_heuristic' },
        });
        const inferida = await db.findById(SANTE_ORG, 'contact-B4');
        assert.strictEqual(inferida.language_inferred, true,
            'sin esto las 184 conjeturas son indistinguibles de las verificadas');
        const verificada = await db.findById(SANTE_ORG, 'contact-B3');
        assert.strictEqual(verificada.language_inferred, false);
    });

    await test('B5 · updateContactLanguage descarta un idioma inventado por el LLM', async () => {
        contactos.set('34600000005', {
            id: 'contact-B5', organization_id: SANTE_ORG, wa_phone: '34600000005',
            full_name: 'Clienta B5', language: 'es', metadata: null,
        });
        const escrito = await db.updateContactLanguage(SANTE_ORG, 'contact-B5', 'pt-BR');
        assert.strictEqual(escrito, false);
        assert.strictEqual(contactos.get('34600000005').language, 'es');
        assert.ok(logs.some(l => l.evento === 'idioma_no_soportado_descartado'),
            'descartarlo en silencio deja el mismo vacío que había');
    });

    await test('B6 · updateContactLanguage LANZA si el UPDATE no toca ninguna fila', async () => {
        await assert.rejects(
            () => db.updateContactLanguage(SANTE_ORG, 'contact-que-no-existe', 'uk'),
            /no encontró la fila/,
            'devolver true sin escribir es lo que hizo imposible diagnosticar el caso real',
        );
    });

    await test('B7 · los cuatro idiomas soportados son los que declara la lista única', () => {
        assert.deepStrictEqual(IDIOMAS_SOPORTADOS, ['es', 'en', 'ru', 'uk']);
    });

    // ═══ C · la detección automática ATERRIZA en la ficha ══════════════════════════════
    // El bug de raíz: contacto que NO existe al abrir la conversación (primer mensaje de una
    // desconocida) y que se crea a mitad. Teléfono único por ejecución porque memory.js
    // persiste en SQLite de verdad y una sesión vieja restauraría estado.

    const telC = `34600${String(Date.now()).slice(-6)}`;
    const c = driver(SANTE_ORG, telC);

    await test('C1 · el primer mensaje crea la ficha (con el idioma por defecto)', async () => {
        await c.turn('Hola');
        const fila = contactos.get(telC);
        assert.ok(fila, 'saveMessage debe haber creado el contacto');
        assert.strictEqual(fila.language, 'es', 'nace en el default: aún no ha escrito nada revelador');
    });

    await test('C2 · el segundo mensaje en ucraniano SÍ se escribe en la ficha', async () => {
        await c.turn('Доброго дня');
        assert.strictEqual(c.session().language, 'uk', 'el bot cambia de idioma en memoria');
        assert.strictEqual(contactos.get(telC).language, 'uk',
            'ANTES: se quedaba en "es" porque session.leadId seguía a null y la escritura ni se intentaba');
    });

    await test('C3 · el leadId quedó resuelto YA EN EL PRIMER turno, y con traza', async () => {
        assert.ok(c.session().leadId, 'sin leadId, todo lo que cuelga de él sigue mudo');
        // ensureLeadId corre dentro del propio turno, así que el hueco que quedaba —el
        // primer mensaje, cuando saveMessage acaba de crear la fila y el relleno diferido
        // de la reconciliación todavía no ha pasado— ya no existe: para cuando llega el
        // segundo mensaje no hay nada que rellenar.
        assert.ok(logs.some(l => l.evento === 'session_leadid_resuelto'),
            'la resolución debe ser visible: es un remiendo sobre un dato que puede faltar');
        assert.ok(!logs.some(l => l.evento === 'session_leadid_backfill'),
            'el relleno diferido ya no debería hacer falta: ensureLeadId llega antes');
    });

    await test('C4 · un tercer mensaje en ruso corrige la ficha — manda el último', async () => {
        await c.turn('Спасибо, до свидания');
        assert.strictEqual(contactos.get(telC).language, 'ru',
            'el solape de «доброго дня» se corrige solo en cuanto escribe otra cosa');
    });

    // ═══ D · ensureLeadId: ningún call site tiene que acordarse ════════════════════════
    // `session.leadId` viene vacío en dos situaciones normales (primer mensaje de una
    // desconocida, y sesión rehidratada — leadId no viaja a SQLite). Todo lo que colgaba de
    // `if (session.leadId)` se saltaba en silencio en las dos.

    const { ensureLeadId, marcarAbandonadaSiNoTieneCita, reconciliarCitaViva } = bot._internals;

    // Sesión mínima con el contacto SIN resolver, como la deja una rehidratación.
    function sesionSinLeadId(telefono, extra = {}) {
        return {
            orgId: SANTE_ORG, orgType: 'salon', leadId: null,
            partialData: { telefono }, history: [], ...extra,
        };
    }

    await test('D1 · resuelve el contacto por teléfono y lo cachea en la sesión', async () => {
        contactos.set('34600000010', {
            id: 'contact-D1', organization_id: SANTE_ORG, wa_phone: '34600000010',
            full_name: 'Clienta D1', language: 'es', metadata: null,
        });
        const s = sesionSinLeadId('34600000010');
        assert.strictEqual(await ensureLeadId(SANTE_ORG, s), 'contact-D1');
        assert.strictEqual(s.leadId, 'contact-D1', 'debe cachear en la sesión, no solo devolver');
        assert.ok(logs.some(l => l.evento === 'session_leadid_resuelto'));
    });

    await test('D2 · si ya hay leadId no consulta nada (devuelve el cacheado)', async () => {
        const antes = sqlCalls.length;
        const s = sesionSinLeadId('34600000010', { leadId: 'ya-lo-tengo' });
        assert.strictEqual(await ensureLeadId(SANTE_ORG, s), 'ya-lo-tengo');
        assert.strictEqual(sqlCalls.length, antes, 'no debe pegarle a la BD en el camino caliente');
    });

    await test('D3 · sin contacto para ese teléfono devuelve null, sin reventar', async () => {
        const s = sesionSinLeadId('34699999999');
        assert.strictEqual(await ensureLeadId(SANTE_ORG, s), null);
        assert.strictEqual(s.leadId, null);
    });

    await test('D4 · barrido de abandono: NO marca abandonada a quien tiene cita, aunque llegue sin leadId', async () => {
        // El incidente del 04/08/2026: tres clientas con cita confirmada acabaron en
        // 'abandonado' y se quedaron sin recordatorio de 24 h. La comprobación existía; el
        // `if (session.leadId)` que la envolvía la hacía opcional justo aquí.
        contactos.set('34600000011', {
            id: 'contact-D4', organization_id: SANTE_ORG, wa_phone: '34600000011',
            full_name: 'Clienta D4', language: 'es', estado: 'confirmado', metadata: null,
        });
        const futuro = new Date(Date.now() + 48 * 3600e3).toISOString();
        citasPorContacto.set('contact-D4', [{ id: 'apt-D4', starts_at: futuro, service: 'Corte' }]);

        const s = sesionSinLeadId('34600000011');
        await marcarAbandonadaSiNoTieneCita(SANTE_ORG, `${SANTE_ORG}:34600000011`, s);

        assert.notStrictEqual(contactos.get('34600000011').estado, 'abandonado',
            'tiene cita por delante: marcarla abandonada la saca del recordatorio de 24 h');
        assert.strictEqual(s.appointmentId, 'apt-D4', 'y la sesión debe enterarse de la cita');
        assert.ok(logs.some(l => l.evento === 'abandono_evitado_cita_viva'));
    });

    await test('D5 · …y sí la marca cuando de verdad no hay cita', async () => {
        contactos.set('34600000012', {
            id: 'contact-D5', organization_id: SANTE_ORG, wa_phone: '34600000012',
            full_name: 'Clienta D5', language: 'es', estado: 'pendiente', metadata: null,
        });
        citasPorContacto.set('contact-D5', []);
        const s = sesionSinLeadId('34600000012');
        await marcarAbandonadaSiNoTieneCita(SANTE_ORG, `${SANTE_ORG}:34600000012`, s);
        assert.strictEqual(contactos.get('34600000012').estado, 'abandonado',
            'sin cita, el barrido debe seguir haciendo su trabajo');
    });

    await test('D6 · reconciliación de cita viva: encuentra la cita sin leadId previo', async () => {
        contactos.set('34600000013', {
            id: 'contact-D6', organization_id: SANTE_ORG, wa_phone: '34600000013',
            full_name: 'Clienta D6', language: 'es', metadata: null,
        });
        const futuro = new Date(Date.now() + 24 * 3600e3).toISOString();
        citasPorContacto.set('contact-D6', [{ id: 'apt-D6', starts_at: futuro, service: 'Color raíz' }]);

        const s = sesionSinLeadId('34600000013', { _decidirCitaVivaAlRecargar: true });
        await reconciliarCitaViva(SANTE_ORG, s, '34600000013@c.us');

        assert.strictEqual(s.appointmentId, 'apt-D6',
            'antes salía por la puerta de "sin contacto" y la sesión nunca sabía que había cita');
        assert.strictEqual(s.citaEnCurso?.servicio, 'Color raíz');
    });

    console.log(`\n${results.filter(Boolean).length}/${results.length} OK`);
})();
