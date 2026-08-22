// Una palabra que la gente dice DE PASADA no puede identificar un servicio ella sola.
//
// 22/08/2026, la tanda de renombrados de Yulia. «Facial reafirmante» pasa a llamarse
// «Santé Face Lift Natural», y ese nombre tiene UN solo token que el matcher considere
// distintivo: 'natural'. 'sante' es stopword desde el arreglo del nombre del salón, y
// 'face' y 'lift' son de CUATRO letras, o sea por debajo de MIN_DISTINCTIVE_TOKEN. Con eso,
// 'natural' identifica el servicio él solo — y es una palabra que las clientas escriben
// hablando del PELO, que es de lo que se habla en este salón:
//
//     «Hi! That's my hair in natural light, really dark»   null → Santé Face Lift Natural
//                                                                 (entrante REAL del 07/08)
//     «mi pelo natural» · «algo natural» · «luz natural» · «quiero un look natural»  → 40 €
//
// MEDIDO ANTES DE ESCRIBIR: 5 de los 533 entrantes reales llevan la palabra; cuatro se
// salvan porque otra cosa gana (Matiz, Color raíz) y UNO cambiaba de resolución. Es
// exactamente el mismo fallo que «sante» doce horas antes, y falla las mismas dos
// condiciones de admisión que dejan `blonde` fuera de `largoKeywords`: lo escribe gente de
// verdad Y lo dice de pasada.
//
// POR QUÉ VA EN UNA LISTA PROPIA Y NO EN LA DEL NOMBRE DEL SALÓN, aunque acaben en el mismo
// Set: son dos criterios distintos. 'sante' está vetado porque es CÓMO SE LLAMA EL NEGOCIO
// —nunca distingue un servicio de otro—; 'natural' está vetado porque es demasiado corriente
// en el vocabulario del salón. Si un día se separan (por ejemplo, leyendo el nombre del
// salón de business_info.companyName) hay que poder mover una sin arrastrar la otra.
//
// LO QUE ESTA PUERTA SÍ SE COME, dicho para que no se descubra tarde (regla 12): el servicio
// deja de resolver por «face lift natural» a secas, porque sin 'natural' no le queda ningún
// token de ≥5 letras. Sigue resolviendo por su NOMBRE COMPLETO, que es como lo escribe quien
// lo ha visto en el cartel. Medido: 328 sondas sobre el catálogo, solo las 2 diferencias
// buscadas. Se aceptó ese coste a sabiendas — la alternativa era un falso positivo ya
// registrado en producción. La salida buena es que el servicio lleve una palabra suya
// ('lifting', 'facial'), y entonces esta entrada de la lista se queda inerte sola.
//
// Visto fallar sin el arreglo: rojos MEDIDOS al final del fichero.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { extractServiceFromText, normalizeText } = require('../services/helpers');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Categoría real (CATEGORY_KEYWORDS vive en el código); nombres y precios, los de la tanda.
const CATALOGO = [
    { categoria: 'Masajes y SPA', nombre: 'Santé Face Lift Natural', precio: 40, duracion: 30 },
    { categoria: 'Masajes y SPA', nombre: 'Santé Aroma Relax', precio: 75, duracion: 60 },
    { categoria: 'Masajes y SPA', nombre: 'Santé Sport Recovery', precio: 65, duracion: 60 },
    { categoria: 'Cortes', nombre: 'Mujer y secado', precio: 40, duracion: 45 },
    { categoria: 'Matiz mujer', nombre: 'Matiz', precio: 40, duracion: 60 },
];
const buscar = t => extractServiceFromText(t, CATALOGO);
const nombre = s => (s ? s.nombre : null);

// ── Bloque 0 · el fixture REPRODUCE la condición ────────────────────────────────────────
test('0 · el fixture arma la trampa: «natural» es el ÚNICO token largo de ese nombre', () => {
    const n = normalizeText('Santé Face Lift Natural');
    const largos = n.split(/\s+/).filter(w => w.length >= 5);
    assert.deepStrictEqual(largos, ['sante', 'natural'],
        'el nombre tiene que tener exactamente estos dos tokens de ≥5 letras: uno ya vetado (sante) y el que se vigila (natural)');
    assert.deepStrictEqual(n.split(/\s+/).filter(w => w.length === 4).sort(), ['face', 'lift'],
        'face y lift tienen que quedar por debajo del umbral, o el servicio tendría otra vía y esto no mediría nada');
    assert.strictEqual(CATALOGO.filter(s => normalizeText(s.nombre).includes('natural')).length, 1,
        'una sola entrada con la palabra: es lo que hace que gane sin empate');
});

// ── Bloque 1 · lo que rompía: la palabra dicha de pasada, hablando del pelo ─────────────
test('1 · decir «natural» de pasada no elige servicio', () => {
    for (const frase of [
        "Hi! That's my hair in natural light, really dark",
        'mi pelo natural',
        'algo natural',
        'luz natural',
        'quiero un look natural',
        'natural',
        'prefiero un tono natural',
    ]) {
        assert.strictEqual(buscar(frase), null,
            `«${frase}» habla del pelo, no pide un facial — resolvió a ${nombre(buscar(frase))}`);
    }
});

// ── Bloque 2 · LA EXENCIÓN (regla 12): el servicio sigue siendo alcanzable ──────────────
test('2 · el servicio sigue resolviendo por su nombre completo', () => {
    for (const frase of [
        'Santé Face Lift Natural',
        'santé face lift natural',
        'quiero el Santé Face Lift Natural',
        'me interesa el santé face lift natural',
    ]) {
        assert.strictEqual(nombre(buscar(frase)), 'Santé Face Lift Natural', `«${frase}»`);
    }
});

// ── Bloque 3 · EL COSTE, escrito como test para que sea una decisión y no un descubrimiento ──
test('3 · el coste aceptado: «face lift natural» a secas ya NO resuelve', () => {
    assert.strictEqual(buscar('face lift natural'), null,
        'sin «natural» no le queda token de ≥5 letras; hace falta el nombre completo');
    // Y esto ya daba null ANTES del arreglo: no lo rompe esta puerta.
    assert.strictEqual(buscar('face lift'), null, '«face lift» tampoco resolvía antes: 4 letras cada uno');
});

// ── Bloque 4 · no se lleva por delante al resto ─────────────────────────────────────────
test('4 · los demás servicios resuelven exactamente igual', () => {
    assert.strictEqual(nombre(buscar('santé aroma relax')), 'Santé Aroma Relax');
    assert.strictEqual(nombre(buscar('aroma')), 'Santé Aroma Relax');
    assert.strictEqual(nombre(buscar('sport recovery')), 'Santé Sport Recovery');
    assert.strictEqual(nombre(buscar('recovery')), 'Santé Sport Recovery');
    assert.strictEqual(nombre(buscar('mujer y secado')), 'Mujer y secado');
});

// ── Bloque 5 · el veto es de la PALABRA, no de esa entrada ──────────────────────────────
// OJO al montaje: la entrada de «Face Lift» se QUITA y se pone otra distinta con 'natural'
// dentro. Si el veto estuviera atado a un nombre concreto en vez de a la palabra, aquí
// resolvería — y de hecho resuelve sin el arreglo, que es lo que hace que este bloque mida
// algo. Con las DOS entradas a la vez no valdría: empatarían y darían null por otra razón.
test('5 · el veto es de la palabra: otra entrada con «natural» tampoco la identifica sola', () => {
    const otra = [
        ...CATALOGO.filter(s => s.nombre !== 'Santé Face Lift Natural'),
        { categoria: 'Tratamiento Orgánico', nombre: 'Color Natural Suave', precio: 55, duracion: 50 },
    ];
    assert.strictEqual(otra.filter(s => normalizeText(s.nombre).includes('natural')).length, 1,
        'una sola entrada con la palabra, o el null vendría del empate y no del veto');
    assert.strictEqual(extractServiceFromText('quiero algo natural', otra), null);
    assert.strictEqual(extractServiceFromText('color natural suave', otra)?.nombre, 'Color Natural Suave',
        'lo que la nombra entera sigue funcionando');
});

// MUTACIONES medidas el 22/08/2026 (cp previo de services/helpers.js, `cp` de vuelta después):
//   · vaciando TOKENS_DEMASIADO_COMUNES .......................... 3 rojos (bloques 1, 3 y 5)
//
// El resto del catálogo no se entera: 328 sondas sobre el catálogo con los 12 nombres nuevos
// y solo las 2 diferencias buscadas («Natural» y «quiero Natural»). Y estructuralmente
// tampoco puede: la palabra solo actúa donde una entrada la lleve en el NOMBRE, y hay
// exactamente UNA en las 82 —«Santé Face Lift Natural»—, cero en el fixture de 81 y cero en
// el catálogo de antes de esta tanda. Fuera de este fichero la lista es inerte.

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { fallos++; console.error(`FALLO - ${name}\n   ${e.message}`); }
    }
    console.log(fallos ? `\n❌ ${fallos} fallo(s)` : `\n✅ ${tests.length} en verde`);
    process.exit(fallos ? 1 : 0);
})();
