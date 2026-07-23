// Unitario puro del mapeo username → email sintético (login del dashboard).
const assert = require('assert');
const { usernameToEmail, INTERNAL_EMAIL_DOMAIN } = require('../scripts/auth-email');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

test('mapea "Sante" al email interno en minúsculas', () => {
    assert.strictEqual(usernameToEmail('Sante'), `sante@${INTERNAL_EMAIL_DOMAIN}`);
});

test('es determinista: espacios y mayúsculas colapsan al mismo email', () => {
    assert.strictEqual(usernameToEmail('  SANTE  '), usernameToEmail('sante'));
    assert.strictEqual(usernameToEmail(' Sante'), `sante@${INTERNAL_EMAIL_DOMAIN}`);
});

test('tolera entradas vacías / nulas sin romper', () => {
    assert.strictEqual(usernameToEmail(''), `@${INTERNAL_EMAIL_DOMAIN}`);
    assert.strictEqual(usernameToEmail(undefined), `@${INTERNAL_EMAIL_DOMAIN}`);
    assert.strictEqual(usernameToEmail(null), `@${INTERNAL_EMAIL_DOMAIN}`);
});

if (!process.exitCode) console.log('\nTests de auth-email OK');
process.exit(process.exitCode || 0);
