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
//
// 18/08/2026 — el segundo defecto se arregló ENTERO, medido sobre los 411 entrantes reales
// de Sante: la subcadena mentía en 26 («nece-SI-ta», «повреж-ДА-ются», «VALE-ria»…) y esos
// 26 van congelados en tests/fixtures/afirmativo-falsos-reales.json, cada uno FALSE para
// siempre. Con frontera: 102 → 76 síes, los 26 perdidos son exactamente los falsos, gana 0,
// y los síes alargados («siii», «Perfectooo», «дааá») se recuperan por colapso + variantes
// enumeradas EN EL MISMO CAMBIO — sin ventana en la que el bot no entienda un «siii».
// «так» (sí ucraniano, adverbio ruso) se decide por opts.lang: con 'ru' no cuenta.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { isAffirmative } = require('../services/helpers');
const FALSOS_REALES = require('./fixtures/afirmativo-falsos-reales.json');

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

// ─── La frontera (18/08/2026): los 26 falsos REALES, congelados ──────────────

test('REGRESIÓN · los 26 entrantes reales que la subcadena leía como «sí» dan FALSE', () => {
    assert.strictEqual(FALSOS_REALES.falsos.length, 26, 'el fixture son exactamente los 26 medidos');
    for (const f of FALSOS_REALES.falsos) {
        assert.strictEqual(isAffirmative(f.texto), false,
            `«${f.texto.slice(0, 60)}» (${f.fecha}, disparaba por «${f.subcadena_culpable}»)`);
    }
});

// ─── El alargamiento se recupera EN EL MISMO CAMBIO, no después ──────────────

test('los síes alargados de WhatsApp siguen siendo sí (colapso de letras repetidas)', () => {
    for (const t of ['siii', 'siiiii', 'Perfectooo', 'okkk', 'claroo', 'vaaale',
        'дааа', 'yesss', 'genialll']) {
        assert.strictEqual(isAffirmative(t), true, `debería ser sí: "${t}"`);
    }
});

test('las variantes ENUMERADAS, una a una (quitar una del código pone SU fila en rojo)', () => {
    assert.strictEqual(isAffirmative('Oki'), true, 'Oki — real, 17/08');
    assert.strictEqual(isAffirmative('okey'), true);
    assert.strictEqual(isAffirmative('sip'), true);
    assert.strictEqual(isAffirmative('sipi'), true);
});

test('y el colapso no fabrica síes: palabras con letra doble legítima siguen fuera', () => {
    // «ll» y «rr» colapsan a una letra al MIRAR; ninguna produce una entrada de la lista.
    for (const t of ['me llamo Marta', 'quiero un corte', 'para aclarar el color',
        'necesito ayuda', 'terrible']) {
        assert.strictEqual(isAffirmative(t), false, `no debería ser sí: "${t}"`);
    }
});

// ─── «так»: sí en ucraniano, adverbio en ruso — decide el idioma de la sesión ─

test('«так» cuenta en ucraniano y con idioma desconocido; con sesión rusa NO', () => {
    assert.strictEqual(isAffirmative('так'), true, 'sin idioma: no se deja a una ucraniana sin su sí');
    assert.strictEqual(isAffirmative('так', { lang: 'uk' }), true);
    assert.strictEqual(isAffirmative('так', { lang: 'ru' }), false, 'el ruso tiene «да» y «давай»');
    // El mensaje REAL del 04/08 que dio afirmativo en un turno que creó cita:
    const ruso = 'У меня этот номер больше сетырех лет уже. И я всегда к Веронике так зари варюсь через смс.';
    assert.strictEqual(isAffirmative(ruso, { lang: 'ru' }), false, 'con la ficha rusa ya no miente');
    assert.strictEqual(isAffirmative(ruso), true,
        'RESIDUO DECLARADO: sin idioma conocido, «так» suelto sigue contando — es el precio de no perder el sí ucraniano');
    // Y «да» con frontera ya no vive dentro de otra palabra, en ningún idioma:
    assert.strictEqual(isAffirmative('Это сильно волосы повреждает?'), false);
    assert.strictEqual(isAffirmative('да'), true);
    assert.strictEqual(isAffirmative('Да, давай'), true);
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
