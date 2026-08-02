// sanitizePhone: normalización a E.164 sin '+'.
//
// Contexto (01/08/2026): al dar de alta una cita a mano en el panel se escribió el teléfono
// de Valeria SIN el prefijo 34 ("611209542"). findByPhone hace .eq('wa_phone', ...) EXACTO,
// así que no casó con el contacto real ("34611209542") y se creó un duplicado con la cita
// colgando de él. El bot no podía ver esa cita ni aunque hubiera existido a tiempo.
//
// sanitizePhone es COMPARTIDO con San Remo (regla de oro: San Remo no se toca), así que la
// primera mitad de este fichero es un candado de regresión: para toda forma de teléfono que
// San Remo ve de verdad, la salida tiene que ser EXACTAMENTE la de antes del cambio.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');

// db.js hace `require('./supabase')` al cargar; lo inyectamos vacío para no tocar red.
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from() { throw new Error('no debería tocar Supabase'); } },
};

const { sanitizePhone } = require('../services/db');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// ─── Candado de regresión: comportamiento observable idéntico ────────────────────────
// Estas son las formas que existen HOY en la base de datos (verificado 02/08/2026:
// San Remo 2/2 contactos y Sante 701/705 son '34' + 9 dígitos) y las que produce el
// pipeline de entrada (JID de wwebjs, LID, comillas del panel).

test('San Remo · 34 + 9 dígitos se queda igual', () => {
    assert.strictEqual(sanitizePhone('34667474233'), '34667474233');
    assert.strictEqual(sanitizePhone('34611417234'), '34611417234');
});

test('San Remo · JID @c.us se limpia igual que antes', () => {
    assert.strictEqual(sanitizePhone('34667474233@c.us'), '34667474233');
});

test('LID (@lid, ~15 dígitos) se limpia igual que antes', () => {
    assert.strictEqual(sanitizePhone('128771743043705@lid'), '128771743043705');
    assert.strictEqual(sanitizePhone('128771743043705'), '128771743043705');
});

test('con + delante se queda en dígitos, igual que antes', () => {
    assert.strictEqual(sanitizePhone('+34667474233'), '34667474233');
});

test('espacios, guiones y comillas se siguen quitando', () => {
    assert.strictEqual(sanitizePhone(' "34 667-474-233" '), '34667474233');
});

test('entradas no válidas siguen devolviendo cadena vacía', () => {
    assert.strictEqual(sanitizePhone(''), '');
    assert.strictEqual(sanitizePhone(null), '');
    assert.strictEqual(sanitizePhone(undefined), '');
    assert.strictEqual(sanitizePhone(34667474233), ''); // no-string: igual que antes
});

test('internacionales existentes NO se tocan (Ucrania +380, Italia +39)', () => {
    assert.strictEqual(sanitizePhone('380672161779'), '380672161779');
    assert.strictEqual(sanitizePhone('393892416319'), '393892416319');
    assert.strictEqual(sanitizePhone('393892416319@c.us'), '393892416319');
});

// ─── Comportamiento NUEVO: móvil español de 9 dígitos → se le antepone 34 ────────────

test('móvil español de 9 dígitos (6…) recibe el prefijo 34', () => {
    assert.strictEqual(sanitizePhone('611209542'), '34611209542');
    assert.strictEqual(sanitizePhone('667474233'), '34667474233');
});

test('móvil español de 9 dígitos (7…) recibe el prefijo 34', () => {
    assert.strictEqual(sanitizePhone('722276798'), '34722276798');
});

test('el caso real de Valeria: las dos formas colapsan en la misma clave', () => {
    assert.strictEqual(sanitizePhone('611209542'), sanitizePhone('34611209542'));
});

test('con separadores y comillas, un 9 dígitos también se normaliza', () => {
    assert.strictEqual(sanitizePhone('611 20 95 42'), '34611209542');
    assert.strictEqual(sanitizePhone('"611209542"'), '34611209542');
});

// ─── Límites: solo móviles españoles, nada más ──────────────────────────────────────
// Fijos españoles (8…/9…) quedan fuera a propósito: WhatsApp es móvil, y un 9 dígitos que
// empieza por 9 choca con numeraciones de otros países. Prefijar mal es peor que no
// prefijar: mandaría mensajes a un número ajeno.

test('9 dígitos que NO empieza por 6 o 7 se queda como está', () => {
    assert.strictEqual(sanitizePhone('912345678'), '912345678');
    assert.strictEqual(sanitizePhone('812345678'), '812345678');
});

test('longitudes distintas de 9 no se tocan', () => {
    assert.strictEqual(sanitizePhone('77777777'), '77777777');       // 8 dígitos, dato de prueba real
    assert.strictEqual(sanitizePhone('6112095421'), '6112095421');   // 10 dígitos
    assert.strictEqual(sanitizePhone('34611209542'), '34611209542'); // 11, ya normalizado
});

test('idempotente: normalizar dos veces da lo mismo', () => {
    const once = sanitizePhone('611209542');
    assert.strictEqual(sanitizePhone(once), once);
});
