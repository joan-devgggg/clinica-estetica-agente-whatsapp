// Regresión del incidente 34624184532 (Sante, 02/08/2026).
//
// Una clienta nueva escribió: "Soy rubia pero me han hecho mechas.. y vine hace un año a
// España y mi cabello es otro. Es un desastre!!!!!" y el bot guardó su nombre como
// "rubia pero" en contacts.full_name.
//
// Tres defectos encadenados, los tres cubiertos aquí:
//
//   1. `indexOf('soy ')` buscaba el patrón en CUALQUIER posición del mensaje, no anclado,
//      y luego cogía .slice(0,2) palabras a ciegas.
//   2. isValidName comparaba la blacklist contra la CADENA ENTERA
//      (`invalidWords.includes(lower)`), así que un candidato de dos palabras no podía
//      chocar nunca con ella. Ahora se comprueba token a token con isNameToken.
//   3. hasApellido('rubia pero') devolvía true por contar palabras y ya. Eso cerraba los
//      dos candados que volvían permanente la basura: el bot dejaba de pedir el apellido
//      y bot.js impedía al LLM corregir el nombre con uno real de una sola palabra.
//
// Bonus: el índice se medía sobre normalizeText(text) —que colapsa espacios— pero el
// substring se aplicaba al text CRUDO, así que "Hola   ,   me llamo   Lucia" devolvía
// "amo Lucia". Afectaba a las DOS orgs; la sección de San Remo del final lo congela.

process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    isValidName,
    isNameToken,
    extractNameAfterIntro,
    hasApellido,
    extractQuickData,
    extractQuickDataSante,
    getMissingFieldsSante,
} = require('../services/helpers');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

const nombreSante = (texto, partial = {}) =>
    extractQuickDataSante(texto, partial, [], []).nombre;

// ─── El caso literal de producción ───────────────────────────────────────────

test('el mensaje real de la clienta NO produce ningún nombre', () => {
    const real = 'Soy rubia pero me han hecho mechas.. y vine hace un año a España y mi '
        + 'cabello es otro. Es un desastre!!!!! Antes era suave, brillante, con movimiento, '
        + 'envidiable y ahora es tieso, hirrible';
    assert.strictEqual(nombreSante(real), undefined);
});

test('isValidName rechaza pares de palabras corrientes', () => {
    for (const basura of ['rubia pero', 'me han', 'hace un', 'un año', 'mi cabello',
        'es otro', 'era suave', 'no tengo', 'pero me']) {
        assert.strictEqual(isValidName(basura), false, `debería rechazar "${basura}"`);
    }
});

test('isNameToken separa palabra corriente de nombre propio', () => {
    for (const w of ['rubia', 'pero', 'cabello', 'semana', 'jueves', 'quiero', 'tarde']) {
        assert.strictEqual(isNameToken(w), false, `"${w}" no es un nombre`);
    }
    for (const w of ['Marta', 'García', 'Oksana', 'Petrova', 'Anna']) {
        assert.strictEqual(isNameToken(w), true, `"${w}" sí es un nombre`);
    }
});

test('los nombres de SERVICIO los sigue filtrando filterServiceKeyword', () => {
    // Reparto deliberado: isNameToken cubre el vocabulario corriente, y el vocabulario
    // del catálogo ya lo cubre SERVICE_NAME_KEYWORDS. Duplicarlo en las dos listas sería
    // dos sitios que mantener. Lo que importa es que el resultado final sea el mismo.
    for (const texto of ['Soy mechas', 'me llamo balayage', 'Soy manicura']) {
        assert.strictEqual(nombreSante(texto), undefined, `"${texto}"`);
    }
});

// ─── Lo que DEBE seguir funcionando ──────────────────────────────────────────

test('las presentaciones normales siguen resolviendo', () => {
    const casos = [
        ['Soy Marta', 'Marta'],
        ['me llamo Lucia', 'Lucia'],
        ['mi nombre es Oksana', 'Oksana'],
        ['Soy Ana García', 'Ana García'],
        ['Soy Ana García y quiero mechas el jueves', 'Ana García'],
        ['Hola, buenas tardes, soy Ana', 'Ana'],
        ['my name is Anna Petrova', 'Anna Petrova'],
        ['i am Anna', 'Anna'],
        ["i'm Anna", 'Anna'],
        ['Marta', 'Marta'],                       // respuesta de una sola palabra
    ];
    for (const [texto, esperado] of casos) {
        assert.strictEqual(nombreSante(texto), esperado, `"${texto}"`);
    }
});

test('nombres reales que también son palabras comunes NO se pierden', () => {
    // El riesgo de una lista de stopwords es tragarse nombres legítimos.
    for (const [texto, esperado] of [['Soy Rosa', 'Rosa'], ['Soy Alba', 'Alba'],
        ['me llamo Mar', 'Mar'], ['Soy Sol', 'Sol'], ['me llamo Luz', 'Luz']]) {
        assert.strictEqual(nombreSante(texto), esperado, `"${texto}"`);
    }
});

test('"Soy Ana mañana" conserva Ana y descarta la 2ª palabra', () => {
    // Si el 2º token no es plausible nos quedamos con el 1º: mejor un nombre de pila sin
    // apellido (el bot lo pedirá) que descartar un nombre bueno.
    assert.strictEqual(nombreSante('Soy Ana mañana'), 'Ana');
    assert.strictEqual(hasApellido('Ana'), false, 'y queda pendiente el apellido');
});

// ─── Anclaje: el patrón debe abrir el mensaje o una frase ────────────────────

test('"soy" en mitad de una frase corriente no captura nada', () => {
    for (const texto of [
        'no soy la titular, es para mi hija',
        'si soy sincera no se que quiero',
        'creo que soy alergica al amoniaco',
        'la verdad es que soy muy indecisa',
    ]) {
        assert.strictEqual(nombreSante(texto), undefined, `"${texto}"`);
    }
});

test('extractNameAfterIntro corta en el primer conector', () => {
    assert.strictEqual(extractNameAfterIntro('Soy Marta y quiero cita'), 'Marta');
    assert.strictEqual(extractNameAfterIntro('Soy Marta, quiero cita'), 'Marta');
    assert.strictEqual(extractNameAfterIntro('Soy rubia pero me han hecho mechas'), null);
    assert.strictEqual(extractNameAfterIntro('quiero cita'), null);
});

// ─── Regresión del desalineamiento de índices ────────────────────────────────

test('espacios dobles y saltos de línea ya no parten el nombre', () => {
    // Antes: 'amo Lucia', 'y Ana', 'a Marta'. El idx se medía sobre el texto normalizado
    // (espacios colapsados) y el substring sobre el crudo.
    assert.strictEqual(nombreSante('Hola   ,   me llamo   Lucia'), 'Lucia');
    assert.strictEqual(nombreSante('  Hola, soy Ana'), 'Ana');
    assert.strictEqual(nombreSante('Hola.\n\nSoy Marta'), 'Marta');
});

test('"llámame X" ya funciona (antes estaba muerto por la tilde)', () => {
    // Se buscaba 'llámame ' CON tilde dentro de normalizeText(text), que ya la había
    // quitado: la rama no podía casar nunca.
    assert.strictEqual(nombreSante('llámame Alba'), 'Alba');
    assert.strictEqual(nombreSante('llamame Alba'), 'Alba');
});

// ─── hasApellido y el candado que hacía permanente la basura ─────────────────

test('hasApellido exige tokens plausibles, no contar palabras', () => {
    assert.strictEqual(hasApellido('rubia pero'), false, 'el candado del incidente');
    assert.strictEqual(hasApellido('Ana García'), true);
    assert.strictEqual(hasApellido('María del Carmen Ruiz'), true, '"del" no debe estorbar');
    assert.strictEqual(hasApellido('Ana'), false);
    assert.strictEqual(hasApellido(''), false);
    assert.strictEqual(hasApellido(null), false);
});

test('con basura por nombre, el bot vuelve a pedir el nombre completo', () => {
    // getMissingFieldsSante es lo que decide si se sigue preguntando.
    assert.deepStrictEqual(getMissingFieldsSante({ nombre: 'rubia pero' }), ['apellido'],
        'antes devolvía [] y el bot daba el nombre por bueno');
    assert.deepStrictEqual(getMissingFieldsSante({ nombre: 'Ana García' }), []);
    assert.deepStrictEqual(getMissingFieldsSante({}), ['nombre']);
});

// ─── Rama del apellido diferido (no debe romperse) ───────────────────────────

test('el apellido en un turno posterior sigue completando el nombre', () => {
    assert.strictEqual(nombreSante('García', { nombre: 'Ana' }), 'Ana García');
    assert.strictEqual(nombreSante('pero no sé', { nombre: 'Ana' }), 'Ana',
        'una respuesta corriente no se pega como apellido');
});

// ─── Paridad San Remo: la lógica gemela de extractQuickData ──────────────────

test('San Remo: el mismo mensaje tampoco produce nombre, y personas sigue igual', () => {
    const r = extractQuickData('Soy rubia pero me han hecho mechas y somos 2', {});
    assert.strictEqual(r.nombre, undefined);
    assert.strictEqual(r.personas, 2, 'la extracción de personas no se toca');
});

test('San Remo: las reservas normales siguen funcionando', () => {
    const r = extractQuickData('Hola, soy Marta y somos 4', {});
    assert.strictEqual(r.nombre, 'Marta');
    assert.strictEqual(r.personas, 4);
});

test('San Remo: se corrige el desalineamiento ("y Ana" → "Ana")', () => {
    assert.strictEqual(extractQuickData('  Hola, soy Ana', {}).nombre, 'Ana');
});

if (!process.exitCode) console.log('\nTests de nombre basura OK');
process.exit(process.exitCode || 0);
