// La puerta del nombre era de UN SOLO DATO y se comía el turno (caso Ihab, 16/08/2026).
//
//   13:37:36  ÉL   A las 15:00 puedo?
//   13:37:47  BOT  ¿A nombre de quién la pongo? 😊
//   13:38:16  ÉL   Hay cita libre a las 15 h?
//   13:38:22  BOT  Perdona, ¿me dices tu nombre para la cita? 😊
//
// Su segunda pregunta no se procesó EN ABSOLUTO: `handleNombreParaCita` pasa el texto por
// `leerNombreDeRespuesta`, salió null y repreguntó con `return true`. Estas dos funciones son
// la mitad pura del arreglo: `residuoTrasNombre` quita la presentación y el nombre, y
// `mensajeTraeOtraCosa` dice si lo que queda PIDE algo. Ninguna sustituye nada — solo deciden
// si el turno sigue vivo, que es lo que hace que un falso positivo cueste una respuesta de más
// y no un mensaje bueno comido (regla 12).
//
// Visto fallar sin lo que protege (mutaciones con cp previo, rojos MEDIDOS el 17/08/2026):
//   · `mensajeTraeOtraCosa` devolviendo siempre {trae:false} → 11 bloques en rojo, los dos
//     turnos de Ihab entre ellos;
//   · quitar la señal 'dia' → rojo SOLO el bloque de los días sueltos en 4 idiomas (es lo que
//     demuestra que `extractMentionedDates` no la cubre: un día sin mes se deja fuera allí a
//     propósito, para no fabricar fechas);
//   · quitar `RESIDUO_CORTESIA_RE` → rojo SOLO el bloque del turno 3 de Ihab: «Claro, me llamo
//     Ihab. Muchas gracias.» pasaría por mensaje con contenido y abriría un turno de más;
//   · dejar `residuoTrasNombre` quitando solo el nombre (sin la presentación) → 3 rojos
//     (turno 3 de Ihab, «ambas cosas» y la presentación): el residuo se queda con «me llamo»,
//     dos tokens que parecen contenido.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    residuoTrasNombre, mensajeTraeOtraCosa, extractNameAfterIntro,
} = require('../services/helpers');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Catálogo mínimo y FIJO (lo determinista va a fixture, regla 5): el vivo es
// agent_configs.services y se verifica en verify:sante.
const CATALOGO = [
    { nombre: 'Lavar y peinar', categoria: 'Lavar y peinar', precio: 25 },
    { nombre: 'Balayage', categoria: 'Mechas', precio: 120 },
];

const trae = (texto, nombre = null) =>
    mensajeTraeOtraCosa(residuoTrasNombre(texto, nombre), { catalogo: CATALOGO });

// ─── 1 · Los dos turnos reales de Ihab ───────────────────────────────────────

test('REGRESIÓN Ihab · «A las 15:00 puedo?» trae otra cosa (hora)', () => {
    const v = trae('A las 15:00 puedo?');
    assert.strictEqual(v.trae, true);
    assert.strictEqual(v.senal, 'hora');
});

test('REGRESIÓN Ihab · «Hay cita libre a las 15 h?» trae otra cosa (hora)', () => {
    const v = trae('Hay cita libre a las 15 h?');
    assert.strictEqual(v.trae, true);
    assert.strictEqual(v.senal, 'hora');
});

test('REGRESIÓN Ihab · «Claro, me llamo Ihab.» + «Muchas gracias.» NO trae otra cosa', () => {
    // El turno 3 real. Si esto diera `trae`, el arreglo abriría un turno de más sobre una
    // conversación que solo estaba dando el nombre.
    assert.strictEqual(residuoTrasNombre('Claro, me llamo Ihab. Muchas gracias.', 'Ihab').replace(/[^\p{L}]/gu, ''), '');
    assert.strictEqual(trae('Claro, me llamo Ihab. Muchas gracias.', 'Ihab').trae, false);
});

// ─── 2 · Ambas cosas en el mismo mensaje ─────────────────────────────────────

test('nombre Y pregunta: el nombre se lee y el residuo conserva la pregunta', () => {
    assert.strictEqual(extractNameAfterIntro('a las 15 puedo? me llamo Ihab'), 'Ihab');
    assert.strictEqual(residuoTrasNombre('a las 15 puedo? me llamo Ihab', 'Ihab'), 'a las 15 puedo?');
    assert.strictEqual(trae('a las 15 puedo? me llamo Ihab', 'Ihab').senal, 'hora');
});

test('la PRESENTACIÓN entera se va, no solo el nombre', () => {
    // Sin quitar «me llamo», el residuo tendría dos tokens y parecería contenido.
    for (const [txt, nom] of [
        ['me llamo Marta', 'Marta'],
        ['soy Marta', 'Marta'],
        ['my name is Michal', 'Michal'],
        ['Меня зовут Наталья', 'Наталья'],
        ['Мене звати Оксана', 'Оксана'],
    ]) {
        assert.strictEqual(residuoTrasNombre(txt, nom), '', `${txt} deja residuo`);
        assert.strictEqual(trae(txt, nom).trae, false, `${txt} trae otra cosa`);
    }
});

// ─── 3 · Un nombre a secas NUNCA trae otra cosa (la dirección que no puede fallar) ──

test('nombres solos, en los cuatro idiomas, no traen nada', () => {
    for (const n of ['Ihab', 'Marta', 'Marta Lopez', 'Michal', 'Наталья', 'Оксана', 'Yulia']) {
        assert.strictEqual(trae(n, n).trae, false, `${n} trae otra cosa`);
    }
});

test('un residuo de UN token no es una pregunta («¿Ihab?»)', () => {
    assert.strictEqual(trae('¿Ihab?', 'Ihab').trae, false);
});

test('negarse a dar el nombre no es traer otra cosa: eso lo resuelve la repregunta', () => {
    for (const t of ['da igual', 'me da igual', 'no te lo voy a decir', 'gracias']) {
        assert.strictEqual(trae(t).trae, false, `${t} trae otra cosa`);
    }
});

// ─── 4 · Las señales, una a una y en los cuatro idiomas ──────────────────────

test('señal HORA en los cuatro idiomas', () => {
    for (const t of ['a las 15:00 puedo?', 'can I at 3pm?', 'а в 15:00 можно?', 'а о 15:00 можна?']) {
        assert.strictEqual(trae(t).senal, 'hora', t);
    }
});

test('señal DIA: un día suelto SÍ cuenta aquí (extractMentionedDates lo deja fuera)', () => {
    for (const [t, n] of [
        ['Ihab, y el jueves mejor', 'Ihab'],
        ['Michal, thursday is better', 'Michal'],
        ['Наталья, а в четверг?', 'Наталья'],
        ['Оксана, у четвер краще', 'Оксана'],
        ['Ihab, mañana mejor', 'Ihab'],
    ]) {
        assert.strictEqual(trae(t, n).trae, true, t);
    }
});

test('señal FECHA con día y mes', () => {
    assert.strictEqual(trae('el 28 de agosto mejor').senal, 'fecha');
});

test('señal SERVICIO contra el catálogo', () => {
    assert.strictEqual(trae('quiero balayage').senal, 'servicio');
});

test('señales CANCELAR / REAGENDAR / REINICIO / VARIAS PERSONAS', () => {
    assert.strictEqual(trae('cancélala').senal, 'cancelar');
    assert.strictEqual(trae('quiero cambiar mi cita').senal, 'reagendar');
    assert.strictEqual(trae('empecemos desde cero').senal, 'reinicio');
    assert.strictEqual(trae('es para mi y una amiga').senal, 'varias_personas');
});

test('señal de PREGUNTA sin «?»: interrogativos enumerados, cuatro idiomas', () => {
    assert.strictEqual(trae('Ihab, cuánto cuesta', 'Ihab').senal, 'interrogativo_es');
    assert.strictEqual(trae('Michal, how much is it', 'Michal').senal, 'interrogativo_en');
    assert.strictEqual(trae('Наталья, сколько стоит', 'Наталья').senal, 'interrogativo_cirilico');
    assert.strictEqual(trae('Оксана, скільки коштує', 'Оксана').senal, 'interrogativo_cirilico');
});

test('el signo de interrogación basta, con dos tokens', () => {
    assert.strictEqual(trae('Marta. Tenéis parking?', 'Marta').senal, 'interrogacion');
});

// ─── 5 · Un catálogo ausente no rompe nada (la lectura puede fallar) ─────────

test('sin catálogo la señal de servicio no se evalúa, y el resto sigue', () => {
    assert.strictEqual(mensajeTraeOtraCosa('quiero balayage', {}).trae, false);
    assert.strictEqual(mensajeTraeOtraCosa('a las 15:00?', {}).senal, 'hora');
    assert.strictEqual(mensajeTraeOtraCosa('', { catalogo: CATALOGO }).trae, false);
    assert.strictEqual(mensajeTraeOtraCosa(null).trae, false);
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
