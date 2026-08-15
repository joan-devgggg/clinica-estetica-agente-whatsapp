// Borrar un contacto desde el panel: que la confirmación diga lo que DESTRUYE.
//
// Por qué el texto merece un test. Hasta el 15/08/2026 el botón «Eliminar» de la ficha no
// preguntaba nada: un clic y la ficha desaparecía. Y lo que se va con ella no se adivina desde
// el botón — `conversations` y `messages` cuelgan de `contacts` con ON DELETE CASCADE, así que
// se lleva la conversación ENTERA sin emitir un solo DELETE contra `messages` y sin dejar
// traza. Pasó de verdad: Olga Yarmak, 11/08/2026 06:37:11 UTC, 30 mensajes de una conversación
// auditada dos días antes (docs/incidentes-cerrados.md#olga-borrada).
//
// Lo que se afirma aquí es la doctrina, no la redacción bonita:
//   · que la cifra REAL de mensajes sale en el texto (si el número desaparece, esto cae);
//   · que un fallo de lectura NO se presenta como «0 mensajes» — un cero inventado invita a
//     borrar, y es el mismo error que `Number(null) === 0` en la facturación;
//   · que se ofrece la alternativa REVERSIBLE (bloquear) en el mismo diálogo;
//   · y que NO se promete que el borrado vaya a salir bien (un cobro en caja lo rechaza).
//
// Visto fallar sin lo que protege (sabotajes con cp previo, 15/08/2026):
//   · devolver siempre la lista de «no se ha podido contar» → rojo el bloque 1 (la cifra);
//   · hacer que efectosBorrado con null diga «0 mensajes» → rojo el bloque 2;
//   · quitar ALTERNATIVA_BLOQUEAR del diálogo → rojo el bloque 3.
//
// Hermético: cero red, cero React, cero Supabase. El .ts se lee como TEXTO y se evalúa la
// parte pura, igual que hace lista-negra-panel con el menú.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'dashboard-app', 'src', 'lib', 'borrado-contacto.ts');
const src = fs.readFileSync(SRC, 'utf8');

// Transpilación mínima: quitar tipos de TS para poder ejecutar las funciones puras en Node.
// No es un compilador — solo hay interfaces, tipos de parámetro y `as`.
// El ORDEN importa: la anotación de retorno se quita antes que los tipos sueltos, o
// `: string[]` la parte por la mitad y deja `: {` suelto.
const js = src
    .replace(/export interface[\s\S]*?\n}\n/g, '')          // interfaces fuera
    .replace(/\):\s*\{[^{}]*\}\s*\{/g, ') {')               // tipo de retorno con forma de objeto
    .replace(/:\s*ImpactoBorrado\s*\|\s*null/g, '')
    .replace(/:\s*string\s*\|\s*null\s*\|\s*undefined/g, '')
    .replace(/:\s*string\[\]/g, '')
    .replace(/:\s*(string|number|boolean)\b/g, '')
    .replace(/^export /gm, '');
const mod = {};
new Function('module', 'exports', `${js}\nmodule.exports = { efectosBorrado, confirmacionBorrado, ALTERNATIVA_BLOQUEAR };`)
    (mod, mod);
const { efectosBorrado, confirmacionBorrado, ALTERNATIVA_BLOQUEAR } = mod.exports;

let fallos = 0;
function test(nombre, fn) {
    try { fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`fail - ${nombre}\n   ${e.message}`); }
}

// ═══ 1. La cifra real de mensajes SALE, y sale como pérdida irreversible ═══
test('dice cuántos mensajes se van a destruir, con el número exacto', () => {
    const efectos = efectosBorrado({ mensajes: 30, citas: 0, escaladas: 0 }).join(' ');
    assert.ok(/\b30 mensajes\b/.test(efectos), `no aparece la cifra: ${efectos}`);
    assert.ok(/no se puede deshacer/i.test(efectos), `no se dice que es irreversible: ${efectos}`);
});

test('singular y plural, para que «1 mensajes» no delate que el texto es de mentira', () => {
    assert.ok(/\b1 mensaje\b/.test(efectosBorrado({ mensajes: 1, citas: 0, escaladas: 0 }).join(' ')));
    assert.ok(/\b1 cita\b/.test(efectosBorrado({ mensajes: 0, citas: 1, escaladas: 0 }).join(' ')));
    assert.ok(/\b2 citas\b/.test(efectosBorrado({ mensajes: 0, citas: 2, escaladas: 0 }).join(' ')));
});

test('las citas se nombran junto a la facturación: borrarlas mueve meses ya cerrados', () => {
    const e = efectosBorrado({ mensajes: 5, citas: 3, escaladas: 0 }).join(' ');
    assert.ok(/3 citas/.test(e) && /factura/i.test(e), e);
});

test('las escaladas abiertas se nombran; a 0 no se enseña una línea vacía', () => {
    assert.ok(/escalada abierta/.test(efectosBorrado({ mensajes: 1, citas: 0, escaladas: 1 }).join(' ')));
    assert.ok(!/escalada/.test(efectosBorrado({ mensajes: 1, citas: 0, escaladas: 0 }).join(' ')));
});

// ═══ 2. Un fallo de lectura NO se disfraza de cero ═══
test('CONTROL: si no se ha podido contar, no se inventa un «0 mensajes»', () => {
    const e = efectosBorrado(null).join(' ');
    assert.ok(/no se ha podido contar/i.test(e), `no lo dice: ${e}`);
    assert.ok(!/\b0 mensajes\b/.test(e), `presenta un cero inventado: ${e}`);
    assert.ok(/conversación completa/i.test(e), `deja de avisar de lo que destruye: ${e}`);
});

test('un contacto sin mensajes se distingue de uno no contado', () => {
    const cero = efectosBorrado({ mensajes: 0, citas: 0, escaladas: 0 }).join(' ');
    assert.ok(!/no se ha podido contar/i.test(cero), cero);
    assert.ok(/ningún mensaje guardado/i.test(cero), cero);
});

// ═══ 3. La alternativa reversible, en el mismo diálogo ═══
test('ofrece BLOQUEAR como alternativa, y dice que se deshace', () => {
    assert.ok(/bloqu/i.test(ALTERNATIVA_BLOQUEAR), ALTERNATIVA_BLOQUEAR);
    assert.ok(/deshace|reversible/i.test(ALTERNATIVA_BLOQUEAR), ALTERNATIVA_BLOQUEAR);
    // Y enumera lo que el bloqueo SÍ corta, que es lo que suele querer quien iba a borrar.
    for (const w of ['campañas', 'recordatorios', 'reseñas']) {
        assert.ok(ALTERNATIVA_BLOQUEAR.includes(w), `falta «${w}»: ${ALTERNATIVA_BLOQUEAR}`);
    }
    assert.strictEqual(confirmacionBorrado('Olga', null).alternativa, ALTERNATIVA_BLOQUEAR);
});

test('el nombre va en el título, y sin nombre no queda un hueco', () => {
    assert.ok(confirmacionBorrado('Olga Yarmak', null).titulo.includes('Olga Yarmak'));
    assert.ok(/este contacto/.test(confirmacionBorrado(null, null).titulo));
    assert.ok(/este contacto/.test(confirmacionBorrado('   ', null).titulo));
});

// ═══ 4. CONTROL: informar, NO impedir (lo pidió el dueño explícitamente) ═══
test('CONTROL: no promete que el borrado vaya a salir bien (un cobro en caja lo rechaza)', () => {
    const todo = JSON.stringify(confirmacionBorrado('Olga', { mensajes: 30, citas: 2, escaladas: 1 }));
    assert.ok(!/se ha eliminado|eliminado correctamente/i.test(todo), todo);
});

test('CONTROL: el botón de confirmar sigue siendo UN clic, no una escalera', () => {
    const c = confirmacionBorrado('Olga', { mensajes: 30, citas: 0, escaladas: 0 });
    assert.strictEqual(c.confirmar, 'Eliminar de todas formas');
    assert.strictEqual(c.cancelar, 'Cancelar');
    // Nada de «escribe el nombre para confirmar»: se decidió avisar, no poner barreras.
    assert.ok(!/escribe|teclea|confirma escribiendo/i.test(JSON.stringify(c)));
});

// ═══ 5. El diálogo del panel usa este texto, y el botón ya no borra a la primera ═══
test('la ficha llama a la confirmación y NO borra en el onClick del botón', () => {
    const sheet = fs.readFileSync(
        path.join(__dirname, '..', 'dashboard-app', 'src', 'components', 'clientes', 'cliente-edit-sheet.tsx'), 'utf8');
    assert.ok(/confirmacionBorrado/.test(sheet), 'el sheet no usa el texto de @/lib/borrado-contacto');
    assert.ok(/onClick=\{pedirBorrado\}/.test(sheet),
        'el botón Eliminar vuelve a llamar directamente a handleDelete: borraría sin preguntar');
    assert.ok(/Bloquear en su lugar/.test(sheet), 'no se ofrece la alternativa en el diálogo');
});

test('el endpoint que cuenta el impacto existe y es de LECTURA', () => {
    const wh = fs.readFileSync(path.join(__dirname, '..', 'webhook.js'), 'utf8');
    assert.ok(/app\.get\('\/api\/leads\/:id\/impacto-borrado'/.test(wh), 'no está el endpoint');
    const db = fs.readFileSync(path.join(__dirname, '..', 'services', 'db.js'), 'utf8');
    assert.ok(/async function contarImpactoBorrado/.test(db));
    // assertRead en las tres lecturas: un cero por lectura rota es peor que no decir nada.
    const cuerpo = db.slice(db.indexOf('async function contarImpactoBorrado'));
    const hasta = cuerpo.indexOf('async function getAppointmentsByLead');
    assert.strictEqual((cuerpo.slice(0, hasta).match(/assertRead\(/g) || []).length, 4,
        'faltan assertRead: una lectura rota devolvería 0 y el panel invitaría a borrar');
});

if (fallos) { console.error(`\n${fallos} FALLOS`); process.exit(1); }
console.log('\nTODO OK');
