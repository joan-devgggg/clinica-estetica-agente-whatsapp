// El nombre del PROPIO SALÓN no puede ser lo que distingue un servicio de otro.
//
// 22/08/2026. Yulia añade «Santé Bamboo Harmony» (60 € / 45 min) a Masajes y SPA. El nombre
// lleva dentro el del salón, y la pasada 2 de `extractServiceFromText` (último recurso, la
// única que mira el NOMBRE) admite como DISTINTIVO cualquier token de ≥ MIN_DISTINCTIVE_TOKEN
// letras. «sante» son exactamente 5. Como el token vive en UNA sola entrada de las 82, gana
// sin empate que lo frene:
//
//     «…promociones disponibles en Sante Healthy Hair Salón…»   null → Santé Bamboo Harmony
//     «…quiero info de Sante…»                                  null → Santé Bamboo Harmony
//
// MEDIDO ANTES DE TOCAR NADA, sobre los 533 entrantes reales de Sante (31/07 → 22/08): DOS
// mensajes de verdad cambiaban de resolución, los dos hacia el masaje de 60 €. O sea que la
// entrada nueva no traía un riesgo teórico: traía dos casos ya escritos por clientas.
//
// Es la forma exacta de «Para lavar.» → «Reconstrucción K18 + lavar y peinar» (la cita
// fantasma de Ihab): un token que solo aparece en una entrada y no tiene quien lo dispute.
// Y falla las DOS condiciones de admisión de un token, las mismas que dejan `blonde` fuera
// de `largoKeywords`: lo escribe gente de verdad Y lo dice de pasada. Es como se llama el
// salón — aparece en saludos, en preguntas por promociones y en cualquier reenvío.
//
// LO QUE ESTA PUERTA NO PUEDE COMERSE (regla 12): el servicio en sí. «bamboo» y «harmony»
// siguen resolviéndolo, y el nombre completo también — lo que se retira es SOLO la capacidad
// de «sante» de identificar algo por su cuenta. Medido: 321 sondas sobre el catálogo vivo,
// 0 diferencias fuera de las que se buscaban (bloques 3 y 4).
//
// EL ALCANCE, dicho para que no se descubra tarde: la lista es una CONSTANTE en git, y el
// nombre del salón lo edita la dueña (`business_info.companyName`). Si mañana el salón se
// llama otra cosa, esto no la sigue: se queda INERTE (deja de casar nada, no rompe nada) y
// un servicio nombrado como el salón NUEVO reabriría el agujero. Hacerlo automático es leer
// `companyName`, y eso significa pasarlo por los ~17 call sites de `extractServiceFromText`
// (10 en bot.js y 7 dentro de helpers.js). Anotado en
// docs/observaciones-para-proxima-auditoria.md, no hecho.
//
// Visto fallar sin el arreglo (cp previo de services/helpers.js): rojos MEDIDOS al final.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { extractServiceFromText, normalizeText } = require('../services/helpers');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// El nombre del salón es REAL (es lo que se ejercita); los servicios y precios, inventados.
// La categoría sí es real: CATEGORY_KEYWORDS vive en el código y mapea a nombres escritos
// ahí, así que con una categoría inventada la pasada difusa ni corre (regla 5 para el resto).
const SALON = 'Sante';
const CATALOGO = [
    { categoria: 'Masajes y SPA', nombre: 'Santé Bamboo Harmony', precio: 60, duracion: 45 },
    { categoria: 'Masajes y SPA', nombre: 'Piedras calientes', precio: 90, duracion: 60 },
    { categoria: 'Cortes', nombre: 'Repaso de puntas', precio: 25, duracion: 30 },
    { categoria: 'Manicura/Pedicura', nombre: 'Esmaltado sencillo', precio: 20, duracion: 45 },
];
const buscar = t => extractServiceFromText(t, CATALOGO);
const nombre = s => (s ? s.nombre : null);

// ── Bloque 0 · el fixture REPRODUCE la condición ────────────────────────────────────────
// Sin esto, un fixture que no arme la trampa deja todo lo demás en verde con y sin arreglo.
test('0 · el fixture arma la trampa: una entrada nombrada como el salón, y solo una', () => {
    const conElNombre = CATALOGO.filter(s => normalizeText(s.nombre).includes(normalizeText(SALON)));
    assert.strictEqual(conElNombre.length, 1,
        'el fixture necesita EXACTAMENTE una entrada con el nombre del salón dentro: es lo que hace que el token gane sin empate');
    assert.ok(normalizeText(SALON).length >= 5,
        'si el nombre del salón tuviera menos de 5 letras quedaría fuera por MIN_DISTINCTIVE_TOKEN y este fichero no mediría nada');
    // Y la trampa tiene que ser alcanzable: el token va SOLO, sin ninguna otra evidencia.
    assert.ok(!/bamboo|harmony/i.test('hola, quiero info de Sante'),
        'la sonda del bloque 1 no puede llevar ninguna otra palabra del servicio');
});

// ── Bloque 1 · lo que rompía: el nombre del salón dicho de pasada ───────────────────────
test('1 · nombrar el SALÓN no elige servicio', () => {
    for (const frase of [
        'Sante',
        'hola sante',
        'quiero info de Sante',
        'Hola, quiero obtener una de las promociones disponibles en Sante Healthy Hair Salón. ¿Me das más información?',
        'buenos dias Sante Healthy Hair',
        'me han hablado muy bien de Sante',
    ]) {
        assert.strictEqual(buscar(frase), null,
            `«${frase}» nombra al salón, no a un servicio — resolvió a ${nombre(buscar(frase))}`);
    }
});

// El acento no puede ser la diferencia: normalizeText lo quita, y la clienta escribe las dos.
test('2 · con acento y sin acento se comportan igual', () => {
    assert.strictEqual(buscar('Santé'), null);
    assert.strictEqual(buscar('quiero saber de Santé Healthy Hair'), null);
});

// ── Bloques 3 y 4 · LA EXENCIÓN (regla 12): el servicio sigue siendo alcanzable ─────────
test('3 · el servicio sigue resolviendo por su nombre completo', () => {
    for (const frase of ['Santé Bamboo Harmony', 'santé bamboo harmony', 'quiero el Santé Bamboo Harmony']) {
        assert.strictEqual(nombre(buscar(frase)), 'Santé Bamboo Harmony', `«${frase}»`);
    }
});

test('4 · y por las palabras que SÍ lo distinguen', () => {
    for (const frase of ['bamboo', 'harmony', 'bamboo harmony', 'quiero el bamboo harmony']) {
        assert.strictEqual(nombre(buscar(frase)), 'Santé Bamboo Harmony', `«${frase}»`);
    }
});

// ── Bloque 5 · no se lleva por delante al resto del catálogo ────────────────────────────
test('5 · los demás servicios resuelven exactamente igual', () => {
    assert.strictEqual(nombre(buscar('piedras calientes')), 'Piedras calientes');
    assert.strictEqual(nombre(buscar('repaso de puntas')), 'Repaso de puntas');
    assert.strictEqual(nombre(buscar('esmaltado sencillo')), 'Esmaltado sencillo');
});

// ── Bloque 6 · la regla es del NOMBRE DEL SALÓN, no de esa entrada ──────────────────────
// Si mañana hay DOS servicios nombrados como el salón, «sante» sigue sin decidir entre ellos
// — y sin la stopword tampoco decidiría (empatarían), así que lo que se afirma aquí es que la
// puerta no introduce un desempate nuevo.
test('6 · con dos entradas nombradas como el salón sigue sin elegir ninguna', () => {
    const dos = [...CATALOGO, { categoria: 'Masajes y SPA', nombre: 'Santé Ritual Oriental', precio: 80, duracion: 60 }];
    assert.strictEqual(extractServiceFromText('quiero algo de Sante', dos), null);
    assert.strictEqual(extractServiceFromText('ritual oriental', dos)?.nombre, 'Santé Ritual Oriental',
        'lo que SÍ distingue sigue distinguiendo');
});

// MUTACIONES medidas el 22/08/2026 (cp previo de services/helpers.js, `cp` de vuelta después):
//   · vaciando TOKENS_DEL_NOMBRE_DEL_SALON (o sea, dejando el código de ayer)
//     ............................................................ 2 rojos (bloques 1 y 2)
//
// Ningún otro fichero de la suite se entera, y no hace falta creerlo: el token solo puede
// actuar donde una entrada lo lleve en el nombre, y NINGUNA lo lleva — ni las 81 del fixture
// `sante-catalog.json` ni las 82 del catálogo vivo de antes de esta tanda. Fuera de este
// fichero la lista es inerte por construcción, no por suerte.

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { fallos++; console.error(`FALLO - ${name}\n   ${e.message}`); }
    }
    console.log(fallos ? `\n❌ ${fallos} fallo(s)` : `\n✅ ${tests.length} en verde`);
    process.exit(fallos ? 1 : 0);
})();
