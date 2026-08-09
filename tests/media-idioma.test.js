// El aviso de "no puedo ver fotos" sale en el idioma de la clienta (09/08/2026).
//
// Michal Gradziel (447432204269, 07/08/2026), tres mensajes en 8 segundos:
//
//   11:04:54.230  in   «Hi! That's my hair in natural light, really dark»
//   11:04:54.938  in   [image]
//   11:04:54.939  OUT  «No puedo ver fotos ni vídeos 😅 ¿Me describes con palabras…»
//   11:05:02.443  OUT  «Hi! Your hair looks beautiful 😊 What can we do for you today?»
//
// El aviso leía el idioma SOLO de userSessions (RAM), y en el primer mensaje de una
// conversación no hay sesión: se crea dentro de processMessageCore, que corre cuando el
// buffer hace flush 5 s más tarde. Así que ese camino no podía acertar nunca, ni con la
// ficha en 'en'. El texto inglés existía desde siempre en unsupportedMediaMsg.
//
// Familia del caso de Tammy (CLAUDE.md), por una puerta peor: allí session.language tenía un
// valor equivocado, aquí no hay sesión de la que sacarlo.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { _internals } = require('../bot');
const { unsupportedMediaMsg } = require('../services/helpers');

const { resolveMediaLanguage, userSessions, messageBuffers, sessionKey } = _internals;

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const TEL = '447432204269';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function limpiar() {
    userSessions.delete(sessionKey(ORG, TEL));
    messageBuffers.delete(sessionKey(ORG, TEL));
}

// ─── El caso que lo pagó ─────────────────────────────────────────────────────

test('REGRESIÓN · sin sesión, el idioma sale del texto que espera en el buffer', () => {
    limpiar();
    // Exactamente el estado del 11:04:54.938: su texto lleva 0,7 s en el buffer, la sesión
    // todavía no existe porque el flush no ha corrido.
    messageBuffers.set(sessionKey(ORG, TEL), {
        texts: ['Hi! That’s my hair in natural light, really dark'], state: 'buffering',
    });
    return resolveMediaLanguage(ORG, TEL, TEL).then((idioma) => {
        assert.strictEqual(idioma, 'en');
        const msg = unsupportedMediaMsg('image', idioma);
        assert.ok(/can't see photos/i.test(msg), `esperaba el aviso en inglés, salió: ${msg}`);
    });
});

test('y el mensaje que le llegó de verdad era el castellano', () => {
    // Lo que produce la resolución vieja (null): la prueba de que el texto inglés ya existía
    // y lo único que faltaba era llegar hasta él.
    assert.ok(/No puedo ver fotos/.test(unsupportedMediaMsg('image', null)));
});

// ─── La cascada, en orden ────────────────────────────────────────────────────

test('la sesión manda sobre todo lo demás', () => {
    limpiar();
    userSessions.set(sessionKey(ORG, TEL), { language: 'ru' });
    messageBuffers.set(sessionKey(ORG, TEL), { texts: ['hello there'], state: 'buffering' });
    return resolveMediaLanguage(ORG, TEL, TEL).then(i => assert.strictEqual(i, 'ru'));
});

test('un buffer que no resuelve no inventa idioma', () => {
    limpiar();
    messageBuffers.set(sessionKey(ORG, TEL), { texts: ['👍'], state: 'buffering' });
    // Sin ficha 'observed' detrás (el teléfono no existe en la BD de test) la cascada se
    // queda sin señal y lo DICE devolviendo null, en vez de elegir castellano como si lo
    // hubiera leído en algún sitio.
    return resolveMediaLanguage(ORG, '000000000000', '000000000000').then(i => assert.strictEqual(i, null));
});

test('un idioma fuera de IDIOMAS_SOPORTADOS no se cuela', () => {
    limpiar();
    userSessions.set(sessionKey(ORG, TEL), { language: 'pl' });
    messageBuffers.set(sessionKey(ORG, TEL), { texts: ['hello there'], state: 'buffering' });
    // 'pl' se descarta y la cascada sigue al buffer.
    return resolveMediaLanguage(ORG, TEL, TEL).then(i => assert.strictEqual(i, 'en'));
});

test('sin sesión, sin buffer y sin ficha devuelve null y no revienta', () => {
    limpiar();
    return resolveMediaLanguage(ORG, '000000000001', '000000000001').then(i => assert.strictEqual(i, null));
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { fallos++; console.error(`FALLO - ${name}\n   ${e.message}`); }
    }
    limpiar();
    console.log(fallos ? `\n❌ ${fallos} fallo(s)` : `\n✅ ${tests.length} en verde`);
    process.exit(fallos ? 1 : 0);
})();
