// Tests for classifyLanguageByName (services/language-name-heuristic.js).
// Two failure modes matter equally here: missing a real Slavic name (under-flagging is
// recoverable, Joan can review later) and wrongly flagging a common Spanish name (touches
// real client data — see scripts/classify-sante-language-by-name.js).

const assert = require('assert');
const { classifyLanguageByName } = require('../services/language-name-heuristic');

function test(name, fn) {
    try {
        fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

test('nombre del equipo real de Sante → ru', () => {
    for (const [nombre, apellidos] of [
        ['Irina', 'Petrova'], ['Veronika', 'Kovalenko'], ['Yulia', 'Sydorenko'],
        ['Tetiana', 'Melnyk'], ['Larisa', 'Ivanovna'], ['Olgha', 'Kravchuk'],
    ]) {
        const { suggested } = classifyLanguageByName(nombre, apellidos);
        assert.strictEqual(suggested, 'ru', `${nombre} ${apellidos} debería sugerir 'ru'`);
    }
});

test('apellido con sufijo eslavo sin nombre reconocido → ru', () => {
    const { suggested, matched } = classifyLanguageByName('Anna', 'Kovaleva');
    assert.strictEqual(suggested, 'ru');
    assert.ok(matched.includes('apellido:kovaleva'));
});

test('nombres/apellidos españoles ambiguos NO se marcan', () => {
    for (const [nombre, apellidos] of [
        ['Carolina', 'Molina'], ['Cristina', 'Medina'], ['Ana', 'Urbina'],
        ['Martín', 'Martín'], ['Natalia', 'Fernández'], ['Marina', 'Ruiz'],
        ['Elena', 'Sánchez'], ['Diana', 'Torres'], ['Valentina', 'Gómez'],
        ['María', 'García López'],
    ]) {
        const { suggested } = classifyLanguageByName(nombre, apellidos);
        assert.strictEqual(suggested, null, `${nombre} ${apellidos} NO debería marcarse`);
    }
});

test('Casanova (catalán, "casa nueva") no se confunde con el sufijo -ova', () => {
    const { suggested } = classifyLanguageByName('Mamen', 'Casanova');
    assert.strictEqual(suggested, null);
});

test('sin nombre ni apellidos → null, no revienta', () => {
    assert.deepStrictEqual(classifyLanguageByName('', ''), { suggested: null, matched: [] });
    assert.deepStrictEqual(classifyLanguageByName(null, undefined), { suggested: null, matched: [] });
});

test('acentos y mayúsculas no afectan el matching', () => {
    const { suggested } = classifyLanguageByName('OKSANA', 'ŠEVCHENKO');
    assert.strictEqual(suggested, 'ru');
});
