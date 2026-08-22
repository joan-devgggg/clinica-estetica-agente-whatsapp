// Quien NOMBRA gana a quien insinúa: la palabra coloquial no puede llevarse una mención
// que lleva escrito el nombre de otro servicio.
//
// `extractServiceFromText` tiene una pasada difusa que traduce una palabra suelta a una
// CATEGORÍA (CATEGORY_KEYWORDS) y elige dentro de ella; y, mucho después, una pasada de
// último recurso que es la ÚNICA que mira el NOMBRE de cada entrada. La primera corre antes,
// así que una clienta que escribe el nombre de un servicio se llevaba otro. Medido contra el
// catálogo vivo el 22/08/2026, cuatro cruces:
//
//     «botanical glow»  →  Brillo intensivo         120 € / 180 min   (era 45 € /  40 min)
//     «hair loss»       →  Consulta tricológica      85 € /  60 min   (era 75 € /  90 min)
//     «hair relax»      →  Aromaterapia relax        75 € /  60 min   (era 85 € /  45 min)
//     «anticaida»       →  Consulta tricológica      85 € /  60 min   (era 85 € / 120 min)
//
// Misma familia que «Para lavar.» → «Reconstrucción K18 + lavar y peinar», la cita fantasma
// de Ihab, vista desde el otro lado: allí un token ajeno se colaba en la pasada 2; aquí la
// pasada 2 ni se alcanza. Y el daño es el mismo: precio y agenda equivocados dichos como
// cifra buena, sin síntoma.
//
// LO QUE LA PUERTA NO PUEDE COMERSE (regla 12): la mención cuya única evidencia es una
// palabra del nombre de la CATEGORÍA que ya ganó. 'glow' es identidad de «Brillo Glow», así
// que «glow» y «brillo glow» NO saltan a la otra entrada — es el mismo criterio que
// `esIdentidadAjena` en la pasada 2, aplicado un peldaño antes. Bloques 5, 6 y 7.
//
// LA CATEGORÍA DEL FIXTURE ES REAL Y LOS NOMBRES Y PRECIOS SON INVENTADOS, a propósito y por
// el mismo motivo que en `complemento-no-cae-en-el-vecino`: la lista que se ejercita
// (CATEGORY_KEYWORDS) vive en el CÓDIGO y mapea a nombres de categoría escritos ahí, así que
// con una categoría inventada la pasada difusa ni corre y el fichero no mediría nada. Lo que
// afirme algo del catálogo VIVO va a verify:sante, no aquí (regla 5).
//
// Visto fallar sin el arreglo (cp previo de services/helpers.js, rojos MEDIDOS el
// 22/08/2026) — los números están al final de este fichero, en MUTACIONES.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { extractServiceFromText } = require('../services/helpers');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Nombres y precios INVENTADOS. Las categorías son las que CATEGORY_KEYWORDS nombra en el
// código, que es lo único que hace correr la pasada difusa.
const CATALOGO = [
    // Categoría de UNA entrada: la palabra coloquial la alcanza por el atajo
    // `inCat.length === 1`, sin que una sola palabra de su nombre esté en el texto.
    { categoria: 'Brillo Glow', nombre: 'Destello máximo', precio: 120, duracion: 180 },
    { categoria: 'Diagnóstico Capilar', nombre: 'Revisión con lupa', precio: 85, duracion: 60 },
    // Categorías cuyo NOMBRE DE SERVICIO lleva dentro esa misma palabra coloquial.
    { categoria: 'Tratamiento Orgánico', nombre: 'Vegetal Glow Suave', precio: 45, duracion: 40 },
    { categoria: 'Tratamiento Orgánico', nombre: 'Locion anticaida', precio: 30, duracion: 120 },
    { categoria: 'Spa Hair', nombre: 'Marino Glow Suave', precio: 70, duracion: 50 },
    // Categoría de varias entradas: la difusa desempata dentro y eso NO se toca.
    { categoria: 'Masajes y SPA', nombre: 'Aroma relax', precio: 75, duracion: 60 },
    { categoria: 'Masajes y SPA', nombre: 'Piedras calientes', precio: 90, duracion: 60 },
    { categoria: 'Cabina Nordica', nombre: 'Nordic Hair Relax', precio: 95, duracion: 45 },
];
const buscar = t => extractServiceFromText(t, CATALOGO);
const sinLa = nombre => CATALOGO.filter(s => s.nombre !== nombre);

// ── BLOQUE 0 ────────────────────────────────────────────────────────────────────────────
// El fixture tiene que REPRODUCIR la condición: que la palabra coloquial alcance sola a un
// servicio del que la clienta no ha dicho ni una palabra. Se comprueba quitando a la
// retadora: sin ella, la difusa es lo único que queda y se lleva la mención. El día que
// CATEGORY_KEYWORDS deje de mapear 'glow'/'caida'/'relax' a estas categorías, este bloque se
// pone rojo en vez de dejar los demás pasando con y sin el arreglo (regla 2).
test('0 · sin la retadora, la palabra coloquial se lleva la mención (la condición existe)', () => {
    assert.strictEqual(
        extractServiceFromText('vegetal glow', sinLa('Vegetal Glow Suave'))?.nombre,
        'Destello máximo', "'glow' ya no alcanza a «Brillo Glow»: el fixture no reproduce nada");
    assert.strictEqual(extractServiceFromText('anticaida', sinLa('Locion anticaida'))?.nombre,
        'Revisión con lupa', "'caida' ya no alcanza a «Diagnóstico Capilar»");
    assert.strictEqual(extractServiceFromText('hair relax', sinLa('Nordic Hair Relax'))?.nombre,
        'Aroma relax', "'relax' ya no alcanza a «Masajes y SPA»");
});

// ── Los cruces, uno por uno ─────────────────────────────────────────────────────────────
test('1 · el nombre propio gana a la palabra coloquial de una categoría de UNA entrada', () => {
    const r = buscar('vegetal glow');
    assert.strictEqual(r?.nombre, 'Vegetal Glow Suave',
        'la clienta nombró la entrada; 120 € y 180 min en vez de 45 € y 40 min es el cruce');
    assert.strictEqual(r.precio, 45);
    assert.strictEqual(r.duracion, 40);
});

test('2 · gana también cuando la coloquial SÍ había puntuado (2 palabras contra 1)', () => {
    const r = buscar('hair relax');
    assert.strictEqual(r?.nombre, 'Nordic Hair Relax',
        '«Aroma relax» casa una palabra, «Nordic Hair Relax» casa dos: manda el que está mejor nombrado');
    assert.strictEqual(r.precio, 95);
});

test('3 · una sola palabra del nombre basta contra una coloquial que no casó ninguna', () => {
    const r = buscar('anticaida');
    assert.strictEqual(r?.nombre, 'Locion anticaida', 'de «Revisión con lupa» no dijo ni una palabra');
    assert.strictEqual(r.duracion, 120, 'la agenda también se movía: 60 min por 120');
});

test('4 · DOS retadoras empatadas → null, que pregunte el bot (nunca elegir a cara o cruz)', () => {
    assert.strictEqual(buscar('glow suave'), null,
        '«Vegetal Glow Suave» (45 €) y «Marino Glow Suave» (70 €) casan lo mismo: preguntar es más barato');
});

// ── La exención: lo que la puerta NO puede comerse (regla 12) ───────────────────────────
test('5 · la palabra que es identidad de la categoría elegida se queda en ella', () => {
    const r = buscar('glow');
    assert.strictEqual(r?.nombre, 'Destello máximo',
        "'glow' es una palabra del nombre de «Brillo Glow»: la mención es de esa categoría");
    assert.strictEqual(r.precio, 120, 'esta es la respuesta BUENA que la puerta no puede tragarse');
});

test('6 · y sigue siéndolo cuando la clienta nombra la categoría entera', () => {
    assert.strictEqual(buscar('brillo glow')?.nombre, 'Destello máximo');
    assert.strictEqual(buscar('quiero brillo')?.nombre, 'Destello máximo');
});

test('7 · una retadora que NO supera a la elegida no la mueve', () => {
    assert.strictEqual(buscar('relax')?.nombre, 'Aroma relax',
        '«Nordic Hair Relax» casa lo mismo (una palabra) y no supera: no hay reto');
    assert.strictEqual(buscar('piedras')?.nombre, 'Piedras calientes');
});

test('8 · un nombre exacto no pasa por aquí: la puerta solo mira lo elegido por coloquial', () => {
    assert.strictEqual(buscar('vegetal glow suave')?.nombre, 'Vegetal Glow Suave');
    assert.strictEqual(buscar('quiero destello máximo')?.nombre, 'Destello máximo');
    assert.strictEqual(buscar('nordic hair relax')?.nombre, 'Nordic Hair Relax');
});

test('9 · sin retadora nombrada, la difusa sigue resolviendo igual que siempre', () => {
    assert.strictEqual(buscar('quiero un masaje')?.nombre ?? null, null,
        'categoría ambigua sin variante nombrada → null, como antes');
    assert.strictEqual(buscar('aroma')?.nombre, 'Aroma relax');
});

// MUTACIONES medidas el 22/08/2026 (cp previo de services/helpers.js, `cp` de vuelta después):
//   · quitando el bloque «Lo elegido por palabra coloquial cede…» de extractServiceFromText
//     ............................................................ 4 rojos (1, 2, 3 y 4)
//   · (el filtro por categoría se midió y NO estaba protegido por nada: 0 rojos aquí y 0
//     cambios en 817 sondas contra el catálogo vivo, porque la difusa puntúa por subcadena y
//     su marcador nunca es menor. Se quitó en vez de dejarlo sin medir — regla 2.)
//   · quitando la exención de identidad de la categoría elegida
//     ............................................................ 2 rojos (5 y 6)
//   · devolviendo la primera retadora en vez de null cuando empatan
//     ............................................................ 1 rojo (4)
// Ningún otro fichero de la suite se entera de ninguna de las cuatro.

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { fallos++; console.error(`FALLO - ${name}\n   ${e.message}`); }
    }
    console.log(fallos ? `\n❌ ${fallos} fallo(s)` : `\n✅ ${tests.length} en verde`);
    process.exit(fallos ? 1 : 0);
})();
