// El idioma que el modelo NO dice no se fabrica, no se escribe y no se marca 'observed'.
//
// Hallazgo 🔴 1 de docs/auditoria-defaults-silenciosos-2.md. `openai.js` normalizaba con
// `parsed.idioma_detectado || 'es'`, y eso convertía «el modelo no ha dicho nada del idioma»
// en «el modelo ha detectado español».
//
// NO ES TEÓRICO: el campo se omite en el 27 % de las respuestas —18 de 67 en una corrida
// completa del arnés del 06/08/2026—, con el modelo contestando solo `{"respuesta": "..."}`.
// Y `bot.js` escribe ese valor en la ficha marcándolo **'observed'**, la etiqueta reservada a
// lo que sí se ha leído del mensaje. Como su condición es `idioma_detectado !== session.language`,
// el caso que disparaba era el peor: una clienta ya marcada en otro idioma. Un turno así y una
// de las 184 fichas en ruso pasaba a español, marcada como dato de fiar — y con ella el
// recordatorio de 24 h, la petición de reseña y la plantilla de campaña.
//
// Tres bloques, tres capas de la misma cadena:
//   A · openai.js  — CONDUCTA. Se ejecuta getChatbotResponse de verdad, con el SDK de
//                    OpenRouter stubeado: se controla el JSON crudo que "devuelve" el modelo.
//   B · bot.js     — ESTRUCTURA. El sitio que pone 'observed' vive dentro de
//                    processMessageCore, sin exportar. Cable trampa sobre su condición.
//   C · db.js      — CONDUCTA. Último eslabón: la ficha se protege sola aunque algo cuele.
//
// Hermético: sin red, sin LLM real, sin Supabase.
process.env.TZ = 'Europe/Madrid';
process.env.OPENROUTER_API_KEY = 'test-key-no-se-usa';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ORG_SALON = process.env.SANTE_ORG_ID || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// ─── Stubs, ANTES de requerir nada del sistema ──────────────────────────────────────────

// SDK de OpenRouter: `new OpenAI(...)` se ejecuta al cargar openai.js, así que el stub tiene
// que estar puesto antes. `respuestaCruda` es lo que "contesta" el modelo en cada test.
let respuestaCruda = '{"respuesta":"hola"}';
let reventar = null;
const openaiPath = require.resolve('openai');
require.cache[openaiPath] = {
    id: openaiPath, filename: openaiPath, loaded: true,
    exports: class FakeOpenAI {
        constructor() {
            this.chat = {
                completions: {
                    create: async () => {
                        if (reventar) throw reventar;
                        return { choices: [{ message: { content: respuestaCruda } }] };
                    },
                },
            };
        }
    },
};

// Supabase: cliente falso, para poder usar el `db.js` REAL (lo necesita el bloque C) sin que
// nada salga a la red. Cualquier `update()` que llegue aquí se cuenta: en este test, una
// escritura es un fallo.
let escriturasSupabase = 0;
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: {
        from() {
            const b = {
                select: () => b,
                update: () => { escriturasSupabase++; return b; },
                insert: () => { escriturasSupabase++; return b; },
                eq: () => b, is: () => b, in: () => b, order: () => b, limit: () => b,
                single: async () => ({ data: null, error: null }),
                maybeSingle: async () => ({ data: null, error: null }),
                then: (f, r) => Promise.resolve({ data: null, error: null }).then(f, r),
            };
            return b;
        },
    },
};

// db REAL sobre ese Supabase falso. Solo se sustituye `getAgentConfig`, que es lo único que
// openai.js le pide, para no depender del catálogo de producción.
const dbPath = require.resolve('../services/db');
const db = require(dbPath);
db.getAgentConfig = async () => ({
    business_info: { companyName: 'Sante Healthy Hair Salon' }, services: [],
});

const loggerPath = require.resolve('../lib/logger');
const realLogger = require(loggerPath);
let logs = [];
require.cache[loggerPath].exports = {
    ...realLogger,
    info: (e, m) => logs.push({ evento: e, meta: m }),
    warn: (e, m) => logs.push({ evento: e, meta: m }),
    error: (e, m) => logs.push({ evento: e, meta: m }),
};

const { getChatbotResponse } = require('../services/providers/openai');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function responder(json, { error = null } = {}) {
    respuestaCruda = json;
    reventar = error;
    logs = [];
    return getChatbotResponse(ORG_SALON, [{ role: 'user', content: 'hola' }], {}, 'general', false, null);
}

// ─── A · CONDUCTA · openai.js no fabrica ────────────────────────────────────────────────

test('A1 · el modelo contesta SOLO `respuesta` → idioma_detectado queda a null', async () => {
    // El literal es una respuesta real del log del arnés (06/08/2026).
    const r = await responder('{"respuesta":"Genial, cabello medio. ¿Tienes estilista de confianza?"}');
    assert.strictEqual(r._isFallback, undefined, 'esto es el camino de ÉXITO, no el fallback');
    assert.strictEqual(r.idioma_detectado, null,
        'antes salía "es" de aquí y acababa en la ficha marcado como observado');
});

test('A2 · CONTROL · si el modelo SÍ lo declara, se respeta (el A1 no pasa por vacío)', async () => {
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        const r = await responder(`{"respuesta":"привет","idioma_detectado":"${lang}"}`);
        assert.strictEqual(r.idioma_detectado, lang, `se perdió un ${lang} declarado de verdad`);
    }
});

test('A3 · un idioma FUERA de los cuatro soportados tampoco es una observación', async () => {
    const r = await responder('{"respuesta":"olá","idioma_detectado":"pt"}');
    assert.strictEqual(r.idioma_detectado, null,
        'un "pt" se usaría como clave contra config.plantilla_* y contra los diccionarios de '
        + 'texto: caería otra vez en español, pero ya marcado como sabido');
    assert.ok(logs.some(l => l.evento === 'idioma_detectado_no_soportado'),
        'y a diferencia de la omisión, esto sí merece traza: es raro y es accionable');
});

test('A4 · idioma_detectado vacío, null o de otro tipo se tratan igual que ausente', async () => {
    for (const valor of ['""', 'null', '123', 'true', '{"a":1}']) {
        const r = await responder(`{"respuesta":"hola","idioma_detectado":${valor}}`);
        assert.strictEqual(r.idioma_detectado, null, `entró un ${valor} como idioma`);
    }
});

test('A5 · el FALLBACK tampoco afirma haber detectado español', async () => {
    // Es el caso más claro de todos: esto se monta cuando el LLM NO ha contestado.
    const err = new Error('402 Insufficient credits');
    err.status = 402;
    const r = await responder('{}', { error: err });
    assert.strictEqual(r._isFallback, true);
    assert.strictEqual(r.idioma_detectado, null, 'la llamada falló: no se ha detectado nada');
    assert.ok(r.respuesta, 'sigue habiendo algo que decirle a la clienta');
});

test('A6 · el fallback CON idioma conocido lo conserva (no se ha roto la memoria)', async () => {
    const err = new Error('502 Bad Gateway');
    err.status = 502;
    respuestaCruda = '{}'; reventar = err; logs = [];
    const r = await getChatbotResponse(
        ORG_SALON, [{ role: 'user', content: 'привет' }],
        { __clientLanguage: 'ru' }, 'general', false, null);
    assert.strictEqual(r.idioma_detectado, 'ru', 'el idioma ya sabido no se pierde por un 502');
});

// ─── B · ESTRUCTURA · el sitio que marca 'observed' ─────────────────────────────────────

const BOT_SRC = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');

test('B1 · el "observed" que viene del LLM exige un idioma de la lista soportada', () => {
    const lineas = BOT_SRC.split('\n');
    // Hay DOS sitios que marcan 'observed' (ver B3). Este es el del LLM: se ancla en su
    // condición, no en la marca, porque la marca sola encuentra primero el otro.
    const i = lineas.findIndex(l => l.includes('aiResponse.idioma_detectado !== session.language'));
    assert.notStrictEqual(i, -1, 'desapareció la rama de idioma del LLM — revisa este test');

    const guarda = lineas.slice(Math.max(0, i - 2), i + 12).join('\n');
    assert.ok(/IDIOMAS_SOPORTADOS\.includes\(aiResponse\.idioma_detectado\)/.test(guarda),
        'este es EL sitio que decide de qué fiarse después; un truthy suelto deja entrar '
        + 'cualquier cosa que devuelva el modelo:\n' + guarda);
    assert.ok(/session\.languageSource = 'observed'/.test(guarda),
        'la marca sigue colgando de esa misma condición:\n' + guarda);
});

test('B3 · el OTRO "observed" no necesita guarda: lo alimenta detectLanguage', () => {
    // detectLanguage tiene vocabulario cerrado —devuelve uno de los cuatro o null—, así que
    // por ahí no puede entrar un idioma inventado. Se afirma para que quede escrito por qué
    // son dos sitios y solo uno lleva la comprobación.
    const lineas = BOT_SRC.split('\n');
    const i = lineas.findIndex((l, n) => l.includes("session.languageSource = 'observed'")
        && !lineas.slice(Math.max(0, n - 14), n).join('\n').includes('aiResponse.idioma_detectado'));
    assert.notStrictEqual(i, -1, 'desapareció el marcado por detectLanguage');
    const contexto = lineas.slice(Math.max(0, i - 6), i).join('\n');
    assert.ok(/detectLanguage\(sanitized\)/.test(contexto),
        'si este "observed" pasara a alimentarse de otra cosa, necesitaría su propia guarda:\n' + contexto);

    const HELPERS = fs.readFileSync(path.join(__dirname, '..', 'services', 'helpers.js'), 'utf8');
    const cuerpo = HELPERS.slice(HELPERS.indexOf('function detectLanguage'));
    const fin = cuerpo.indexOf('\nfunction ', 1);
    const devoluciones = [...(fin > 0 ? cuerpo.slice(0, fin) : cuerpo).matchAll(/return\s+('[a-z]{2}'|null)/g)]
        .map(m => m[1].replace(/'/g, ''));
    assert.ok(devoluciones.length > 0, 'no se han encontrado los return de detectLanguage');
    for (const d of devoluciones) {
        assert.ok(d === 'null' || ['es', 'en', 'ru', 'uk'].includes(d),
            `detectLanguage puede devolver "${d}", que no está en IDIOMAS_SOPORTADOS`);
    }
});

test('B2 · el fallback del LLM sigue sin llegar a la lógica que escribe idioma', () => {
    // A5 deja el fallback honesto (null), pero lo que de verdad impide que un fallback toque
    // la ficha es este `return` temprano. Si desapareciera, A5 sería lo único que quedaría.
    const lineas = BOT_SRC.split('\n');
    const i = lineas.findIndex(l => l.includes('if (!aiResponse?.respuesta || aiResponse._isFallback)'));
    assert.notStrictEqual(i, -1, 'desapareció la rama de fallback de processMessageCore');
    const bloque = lineas.slice(i, i + 90).join('\n');
    assert.ok(/^\s*return;\s*$/m.test(bloque),
        'la rama de fallback tiene que seguir cortando antes de procesar datos del LLM');
});

// ─── C · CONDUCTA · la ficha se protege sola ────────────────────────────────────────────

test('C1 · updateContactLanguage rechaza null, vacío y no soportados sin escribir nada', async () => {
    escriturasSupabase = 0;
    for (const valor of [null, undefined, '', 'pt', 'ES', 'español', 123]) {
        const ok = await db.updateContactLanguage(ORG_SALON, 'c1', valor);
        assert.strictEqual(ok, false, `aceptó "${valor}" como idioma`);
    }
    assert.strictEqual(escriturasSupabase, 0, 'ni una sola escritura debería haber salido');
});

test('C2 · CONTROL · un idioma soportado sí llega a intentar la escritura', () => {
    // Sin esto, C1 pasaría igual con updateContactLanguage devolviendo false siempre.
    assert.ok(/IDIOMAS_SOPORTADOS\.includes\(language\)/.test(
        fs.readFileSync(path.join(__dirname, '..', 'services', 'db.js'), 'utf8')),
        'la validación de updateContactLanguage sigue siendo la lista única de idiomas');
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
