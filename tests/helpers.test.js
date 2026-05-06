const assert = require('assert');
const { extractQuickData, getStepFromPartialData, responseMatchesStep, normalizeText } = require('../services/helpers');

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

test('normalizeText removes accents and trims spaces', () => {
    assert.strictEqual(normalizeText('  L’Hospitalet  '), 'l’hospitalet');
});

test('getStepFromPartialData returns first missing field', () => {
    assert.strictEqual(getStepFromPartialData({ tipo_reforma: 'baño' }), 'zona');
});

test('responseMatchesStep validates current step text', () => {
    assert.strictEqual(responseMatchesStep('¿Tu nombre?', 'nombre'), true);
});

test('extractQuickData detects city and budget', () => {
    const result = extractQuickData('vivo en terrassa y tengo 5k', {});
    assert.strictEqual(result.zona, 'terrassa');
    assert.strictEqual(result.presupuesto, '5000');
});
