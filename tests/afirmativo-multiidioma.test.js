// isAffirmative no conocía el "yes" (09/08/2026).
//
// Lo cazó el escenario 23 del arnés LLM, con la conversación de Esther Cediloo, que escribe
// en inglés: el bot le ofreció preguntarle el dato al equipo, ella contestó «yes please» y
// isAffirmative devolvió FALSE. La oferta (pendingEscalation) se desarma en silencio cuando
// la respuesta no es afirmativa, así que la escalada nunca ocurrió.
//
// No es un problema del caso nuevo: esta función es la puerta que confirma las SEIS escaladas
// del salón —extensiones, permanente, pigmento, pedir persona…— y también la elección de
// hueco. Una clienta anglófona podía decir que sí a cualquiera de ellas y no pasar nada.
//
// Y al escribir el test apareció el segundo defecto, más viejo: la lista casa por SUBCADENA,
// así que «yesterday I came and it was bad» ya devolvía TRUE —'este' vive dentro de
// «y-este-rday»— desde mucho antes de tocar nada.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { isAffirmative } = require('../services/helpers');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── Lo que faltaba ──────────────────────────────────────────────────────────

test('REGRESIÓN · "yes please" es que sí', () => {
    assert.strictEqual(isAffirmative('yes please'), true);
});

test('las formas normales de decir que sí en inglés', () => {
    for (const t of ['yes', 'Yes!', 'yeah', 'yep', 'yup', 'sure', 'okay',
        'of course', 'go ahead', 'please do', 'yes, please']) {
        assert.strictEqual(isAffirmative(t), true, `debería ser sí: "${t}"`);
    }
});

test('y en ucraniano, que tenía menos que el ruso', () => {
    assert.strictEqual(isAffirmative('добре'), true);
    assert.strictEqual(isAffirmative('звичайно'), true);
    assert.strictEqual(isAffirmative('конечно'), true);
});

// ─── FALSOS POSITIVOS, que es lo que costó verlo ─────────────────────────────

test('REGRESIÓN · "yesterday" no es que sí', () => {
    // 'este' está dentro de «y-este-rday». Fallaba ANTES de este arreglo.
    assert.strictEqual(isAffirmative('yesterday I came and it was bad'), false);
});

test('los demostivos dentro de otra palabra tampoco', () => {
    for (const t of ['el peso del pelo', 'quiero queso', 'la mesa', 'llevo tres meses',
        'el poliéster', 'soy esteticista']) {
        assert.strictEqual(isAffirmative(t), false, `no debería ser sí: "${t}"`);
    }
});

test('pero sueltos siguen valiendo: significan "ese hueco"', () => {
    for (const t of ['ese', 'esa', 'eso', 'este', 'ese me viene bien', 'el 2, ese']) {
        assert.strictEqual(isAffirmative(t), true, `debería ser sí: "${t}"`);
    }
});

test('un no sigue siendo un no', () => {
    for (const t of ['no', 'no thanks', 'not really', 'maybe later', 'нет',
        'I want a haircut', 'mañana no puedo']) {
        assert.strictEqual(isAffirmative(t), false, `no debería ser sí: "${t}"`);
    }
});

test('el castellano de siempre no se ha movido', () => {
    for (const t of ['sí', 'si', 'vale', 'ok', 'perfecto', 'de acuerdo', 'claro',
        'dale', 'venga', 'adelante', 'me viene bien', 'confirmo']) {
        assert.strictEqual(isAffirmative(t), true, `debería seguir siendo sí: "${t}"`);
    }
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
