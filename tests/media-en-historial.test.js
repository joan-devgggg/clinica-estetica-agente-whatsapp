// La foto y nuestro aviso llegan al LLM (09/08/2026).
//
// Michal Gradziel (07/08/2026):
//   11:04:54.939  OUT  «No puedo ver fotos ni vídeos 😅 …»        ← rama de media
//   11:05:02.443  OUT  «Hi! Your hair looks beautiful 😊 …»       ← el LLM, 7,5 s después
//
// Los dos motores son ciegos entre sí. La rama de media contesta y hace return ANTES del
// buffer: el placeholder `[image]` se escribe con saveMessage —que va a la tabla `messages`,
// o sea al PANEL— y la respuesta fija sale por sendWithDelay, que tampoco toca el historial.
// El historial que consume el prompt es session.history, otro array. Para el modelo la foto
// no existía y nuestro aviso tampoco, así que contestó al texto de al lado dando por hecho
// que la había visto.
//
// Aquí se fija lo que faltaba: que ese turno se anote y acabe en session.history, en orden.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { _internals } = require('../bot');

const { notePendingMediaTurn, drainPendingMediaTurns, pendingMediaHistory } = _internals;

const SKEY = 'org-test:447432204269@c.us';
const AVISO_EN = "I can't see photos or videos 😅 Could you describe in words what you'd like done?";

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function sesion() { return { history: [] }; }

// ─── El caso que lo pagó ─────────────────────────────────────────────────────

test('REGRESIÓN · el LLM ve que llegó una foto Y que ya le dijimos que no la vemos', () => {
    pendingMediaHistory.delete(SKEY);
    notePendingMediaTurn(SKEY, 'image', AVISO_EN);

    const s = sesion();
    // Su texto va primero, como en la conversación real (texto 11:04:54.230, foto .938).
    s.history.push({ role: 'user', content: 'Hi! That’s my hair in natural light, really dark', ts: Date.now() });
    const drenados = drainPendingMediaTurns(SKEY, s);

    assert.strictEqual(drenados, 2, 'el marcador de la foto y el aviso que le mandamos');
    assert.strictEqual(s.history.length, 3);
    assert.strictEqual(s.history[1].role, 'user');
    assert.ok(/foto/.test(s.history[1].content), `el marcador debe decir que llegó una foto: ${s.history[1].content}`);
    assert.ok(/no puedes verlo/.test(s.history[1].content), 'y que no se puede ver');
    assert.strictEqual(s.history[2].role, 'assistant');
    assert.strictEqual(s.history[2].content, AVISO_EN, 'el aviso EXACTO que salió, no una paráfrasis');
});

test('el orden es el real: primero su texto, después la foto', () => {
    pendingMediaHistory.delete(SKEY);
    notePendingMediaTurn(SKEY, 'image', AVISO_EN);
    const s = sesion();
    s.history.push({ role: 'user', content: 'su texto', ts: Date.now() });
    drainPendingMediaTurns(SKEY, s);
    assert.deepStrictEqual(s.history.map(h => h.role), ['user', 'user', 'assistant']);
});

// ─── Lo que no puede pasar ───────────────────────────────────────────────────

test('un aviso que NO salió no se anota como dicho', () => {
    // notePendingMediaTurn se llama después del envío; si no hubo aviso (lista negra, o el
    // envío lanzó), solo queda el marcador. Escribir en el historial que dijimos algo que no
    // salió sería inventarse la conversación.
    pendingMediaHistory.delete(SKEY);
    notePendingMediaTurn(SKEY, 'image', null);
    const s = sesion();
    assert.strictEqual(drainPendingMediaTurns(SKEY, s), 1);
    assert.strictEqual(s.history[0].role, 'user');
});

test('drenar vacía: el mismo turno no se cuenta dos veces', () => {
    pendingMediaHistory.delete(SKEY);
    notePendingMediaTurn(SKEY, 'image', AVISO_EN);
    const s1 = sesion(); const s2 = sesion();
    assert.strictEqual(drainPendingMediaTurns(SKEY, s1), 2);
    assert.strictEqual(drainPendingMediaTurns(SKEY, s2), 0);
    assert.strictEqual(s2.history.length, 0);
});

test('una foto vieja no se cuela en la conversación de ahora', () => {
    pendingMediaHistory.delete(SKEY);
    notePendingMediaTurn(SKEY, 'image', AVISO_EN);
    // Envejecemos los dos turnos más allá del timeout de sesión (1 h).
    for (const t of pendingMediaHistory.get(SKEY)) t.ts = Date.now() - 2 * 3600000;
    const s = sesion();
    assert.strictEqual(drainPendingMediaTurns(SKEY, s), 0);
    assert.strictEqual(s.history.length, 0);
});

test('una ráfaga de fotos no infla el historial sin límite', () => {
    pendingMediaHistory.delete(SKEY);
    for (let i = 0; i < 20; i++) notePendingMediaTurn(SKEY, 'image', AVISO_EN);
    const s = sesion();
    assert.ok(drainPendingMediaTurns(SKEY, s) <= 6, 'tope de turnos pendientes');
});

test('los tipos que no son foto también se anotan', () => {
    pendingMediaHistory.delete(SKEY);
    notePendingMediaTurn(SKEY, 'document', 'No puedo abrir documentos 😅');
    const s = sesion();
    drainPendingMediaTurns(SKEY, s);
    assert.ok(/document/.test(s.history[0].content), s.history[0].content);
});

test('sin nada pendiente no hace nada', () => {
    pendingMediaHistory.delete(SKEY);
    const s = sesion();
    assert.strictEqual(drainPendingMediaTurns(SKEY, s), 0);
    assert.strictEqual(drainPendingMediaTurns(null, s), 0);
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { fallos++; console.error(`FALLO - ${name}\n   ${e.message}`); }
    }
    pendingMediaHistory.delete(SKEY);
    console.log(fallos ? `\n❌ ${fallos} fallo(s)` : `\n✅ ${tests.length} en verde`);
    process.exit(fallos ? 1 : 0);
})();
