// El idioma de una ficha no lo fija la CENTRALITA de otro negocio.
//
// ── El incidente ────────────────────────────────────────────────────────────────────────
// Tanda 1 de la campaña de verano (07/08/2026, 250 envíos). Tres de las seis respuestas no
// eran clientas: eran autocontestadores de otros negocios (DarYsol Events, Save Yourself y el
// bot de una videógrafa) cuyos números están en la agenda como si fueran fichas de clienta.
// El bot les leyó el idioma y escribió `language_source: 'observed'` — la etiqueta que
// significa "se lo hemos leído a ELLA", la única que apaga todas las cautelas río abajo (el
// prompt deja de anunciarlo como probable) y la que decide qué plantilla de Meta recibe en la
// tanda siguiente.
//
// Daño real: Dasha Kotenko pasó de `es` a `uk` y ALLA Sinchuk de `ru` a `uk`, las dos por el
// texto de una centralita. Oksana Kachalova conservó el valor por casualidad y se llevó la
// etiqueta igual.
//
// ── La señal, medida (no inventada) ─────────────────────────────────────────────────────
// Segundos entre nuestro envío (`broadcast_sends.sent_at`) y su respuesta:
//     centralitas → 7,1 · 8,1 · 10,0
//     personas    → 126 · 132 · 459
// Umbral 30 s, en mitad del hueco. Es una HIPÓTESIS sobre n=3 y falla hacia el lado bueno:
// una clienta rápida conserva su idioma un mensaje más.
//
// Lo que estos tests fijan es la CONDUCTA de `persistirIdiomaObservado`, que es el paso único
// por el que escriben los dos detectores (el determinista y el del LLM). Hermético: el doble
// de db.js registra qué se habría escrito.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const assert = require('assert');

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const TEL = '34643209389';   // Dasha Kotenko, el caso real

// ─── Doble de db.js, ANTES de requerir bot.js ───────────────────────────────────────────
// Respeta el contrato del original: `getRecentBroadcastSendAt` devuelve el ISO del envío si
// cae dentro de la ventana y null si no, igual que la consulta real. Un doble que devolviera
// siempre null haría pasar estos tests con la guarda desconectada.
const dbPath = require.resolve('../services/db');
const real = require('../services/db');
const escrituras = [];
let envioRecienteISO = null;

require.cache[dbPath].exports = {
    ...real,
    getRecentBroadcastSendAt: async (orgId, telefono) => {
        assert.strictEqual(orgId, ORG, 'la guarda debe consultar con el orgId del turno');
        assert.ok(telefono, 'la guarda debe recibir un teléfono resuelto, no undefined');
        return envioRecienteISO;
    },
    updateContactLanguage: async (orgId, contactId, language) => {
        escrituras.push({ orgId, contactId, language });
        return true;
    },
    findByPhone: async () => ({ id: 'contacto-1' }),
};

const { _internals } = require('../bot');
const { persistirIdiomaObservado } = _internals;

let fallos = 0;
async function test(nombre, fn) {
    escrituras.length = 0;
    try { await fn(); console.log(`ok - ${nombre}`); }
    catch (e) { console.error(`fail - ${nombre}`); console.error(e.message); fallos++; process.exitCode = 1; }
}

const sesion = () => ({ leadId: 'contacto-1', partialData: { telefono: TEL } });
const opts = { dbPhone: TEL, userPhone: `${TEL}@c.us`, origen: 'detector' };

(async () => {

await test('1 · respuesta a los 8 s de un envío: NO se escribe nada en la ficha', async () => {
    envioRecienteISO = new Date(Date.now() - 8_000).toISOString();
    const persistido = await persistirIdiomaObservado(ORG, sesion(), 'uk', opts);
    assert.strictEqual(persistido, false, 'debe declarar que NO ha persistido');
    assert.deepStrictEqual(escrituras, [], 'ni una escritura: es el caso Dasha Kotenko');
});

await test('2 · el que devuelve false es el que impide que la sesión suba a observed', async () => {
    // Es el contrato del que dependen los dos call sites: `if (persistido) languageSource=...`.
    // Si esto devolviera true con la guarda activa, la sesión se marcaría fiable igual.
    envioRecienteISO = new Date(Date.now() - 1_000).toISOString();
    assert.strictEqual(await persistirIdiomaObservado(ORG, sesion(), 'uk', opts), false);
});

await test('3 · sin envío reciente: se escribe con normalidad (la conducta de siempre)', async () => {
    envioRecienteISO = null;
    const persistido = await persistirIdiomaObservado(ORG, sesion(), 'ru', opts);
    assert.strictEqual(persistido, true);
    assert.deepStrictEqual(escrituras, [{ orgId: ORG, contactId: 'contacto-1', language: 'ru' }]);
});

await test('4 · respuesta a los 126 s: es una PERSONA, se escribe', async () => {
    // Svetlana Shapavalova, la más rápida de las tres personas reales de la tanda 1.
    // Fuera de la ventana → la consulta real no la devuelve → null.
    envioRecienteISO = null;
    const persistido = await persistirIdiomaObservado(ORG, sesion(), 'ru', opts);
    assert.strictEqual(persistido, true, 'una persona que tarda 2 min no puede quedar bloqueada');
    assert.strictEqual(escrituras.length, 1);
});

await test('5 · la vía del LLM pasa por la MISMA guarda', async () => {
    // El modelo lee igual de bien el texto de una centralita que el de una clienta: dejar la
    // guarda solo en el detector determinista no protegería nada.
    envioRecienteISO = new Date(Date.now() - 9_000).toISOString();
    const persistido = await persistirIdiomaObservado(ORG, sesion(), 'uk', { ...opts, origen: 'llm' });
    assert.strictEqual(persistido, false);
    assert.deepStrictEqual(escrituras, []);
});

await test('6 · sin contacto resoluble no se inventa una escritura', async () => {
    envioRecienteISO = null;
    require.cache[dbPath].exports.findByPhone = async () => null;
    const persistido = await persistirIdiomaObservado(ORG, { partialData: {} }, 'ru', opts);
    assert.strictEqual(persistido, false);
    assert.deepStrictEqual(escrituras, []);
    require.cache[dbPath].exports.findByPhone = async () => ({ id: 'contacto-1' });
});

// ─── Los dos call sites siguen pasando por aquí ─────────────────────────────────────────
// Cable trampa: la guarda vive dentro de processMessageCore, que no se exporta. Si alguien
// vuelve a llamar a updateContactLanguage directamente desde ahí, la guarda deja de existir
// sin que ningún test de conducta se entere.
await test('7 · bot.js no escribe el idioma por fuera de persistirIdiomaObservado', async () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../bot.js'), 'utf8');
    const llamadas = (src.match(/updateContactLanguage\(/g) || []).length;
    assert.strictEqual(llamadas, 1,
        'solo persistirIdiomaObservado puede llamar a updateContactLanguage; '
        + `encontradas ${llamadas} llamadas`);
    const enGuarda = /persistirIdiomaObservado[\s\S]{0,1200}?updateContactLanguage\(/.test(src);
    assert.ok(enGuarda, 'la única llamada debe estar dentro de persistirIdiomaObservado');
    // Y los dos detectores tienen que seguir usándola.
    assert.strictEqual((src.match(/await persistirIdiomaObservado\(/g) || []).length, 2,
        'los dos detectores (determinista y LLM) deben pasar por la guarda');
});

if (!fallos) console.log('\nTodos los tests de autocontestador OK');
process.exit(process.exitCode || 0);
})();
