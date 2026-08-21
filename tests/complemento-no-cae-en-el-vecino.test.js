// Un complemento que sale de la OFERTA no puede dejar su mención en manos del vecino.
//
// 21/08/2026, al marcar los nueve complementos que confirmó Yulia. Ocho de los nueve dejan
// de resolver y devuelven null, que es lo correcto: el bot pregunta. El noveno NO:
//
//     «quiero un difuminado de raíz»   antes → Difuminado de raíz,  40 € /  30 min
//                                      después → Color raíz,        75 € / 120 min
//
// El token 'raiz' es keyword de Color Premium en CATEGORY_KEYWORDS y, retirado el
// difuminado de la lista ofertable, «Color raíz» es la única entrada de esa categoría que
// puntúa. Casi el doble de precio, cuatro veces la agenda, y comunicado a la clienta como
// cifra buena — un null lo recupera el bot preguntando; esto hay que deshacerlo en el salón.
//
// Es el mismo agujero que «Para lavar.» → «Reconstrucción K18 + lavar y peinar» (60 €) de la
// cita de Ihab, abierto desde el otro lado: allí sobraba un token ajeno, aquí falta la
// entrada propia.
//
// LO QUE PROTEGE NO ES UNA LISTA DE NOMBRES, ES UNA PREGUNTA AL CATÁLOGO RECIBIDO: «¿está
// aquí la entrada que este token nombra?». Por eso el mismo helper veta para el bot y calla
// para el panel, sin saber nada de `solo_complemento` ni de `activo`, y se apaga solo el día
// que la dueña le quite la marca. Los tokens van ENUMERADOS —mismo criterio que los typos
// del largo: que identifiquen a ESE servicio y que nadie los diga de pasada—; 'raiz' queda
// fuera a propósito y el bloque 5 lo afirma.
//
// EL FIXTURE TIENE QUE REPRODUCIR LA CAÍDA, Y LA PRIMERA VERSIÓN NO LO HACÍA. Con una
// categoría inventada de punta a punta («Color de prueba») la pasada fuzzy ni corre: se
// entra por CATEGORY_KEYWORDS, que mapea palabras a nombres de categoría ESCRITOS EN EL
// CÓDIGO, y sin uno de esos nombres el `inCat` sale vacío y la función devuelve null por su
// cuenta. Resultado: quitar el arreglo dejaba los 7 bloques en VERDE. Medido, no supuesto —
// es la regla 2, y por eso el bloque 0 existe: afirma que SIN el veto la mención acaba en el
// vecino. El día que ese camino deje de reproducirse, ese bloque se pone rojo en vez de
// dejar el fichero midiendo nada.
//
// De ahí que la categoría del fixture sea «Color Premium» y no un nombre inventado: no es
// afirmar nada del catálogo vivo (los cuatro servicios y sus precios son inventados), es que
// la lista que se está ejercitando vive en el CÓDIGO. Si la dueña renombra su categoría, lo
// que se rompe es el mapeo de helpers.js, no este fichero — y eso ya está anotado como la
// fragilidad conocida de CATEGORY_KEYWORDS y REACTIVE_ONLY_CATEGORIES.
//
// Visto fallar sin el arreglo (cp previo de services/helpers.js, rojos MEDIDOS el
// 21/08/2026, con el fixture ya corregido):
//   · sin el gate de `mencionaServicioFueraDeEsteCatalogo` ....... 2 rojos: la mención vuelve
//     a caer en el vecino, 35 € y 90 min por encima
//   · vetando el token SIEMPRE (sin mirar el catálogo recibido) .. 2 rojos: el panel deja de
//     poder añadirlo a mano, y quitarle la marca ya no lo devuelve. NO tumba el bloque de
//     facturación, y es correcto que no lo haga: `computeServiceBilling` casa EXACTO desde
//     f187270 y no pasa por aquí. Queda anotado para que nadie lo lea como cobertura.
//   · metiendo 'raiz' en la lista de tokens ...................... 1 rojo: «color raíz» se
//     llevaría por delante la respuesta buena (regla 12)
//
// Los cuatro servicios y sus precios son INVENTADOS a propósito (regla 5): con el catálogo
// real este fichero mediría antigüedad en vez de conducta. Lo que afirma algo del catálogo
// VIVO va a verify:sante.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
    extractServiceFromText, botOfferableCatalog, offerableCatalog,
    computeServiceBilling, resolveServiceDurationMin, isServiceName,
    TOKENS_SOLO_DE_SU_SERVICIO,
} = require('../services/helpers');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// El par que se pisa. Los dos viven en la misma categoría y comparten el token por el que se
// entra a la pasada fuzzy ('raiz', keyword de Color Premium en CATEGORY_KEYWORDS); sólo uno
// es complemento. Retirado el complemento de la lista ofertable, el vecino es el único que
// puntúa — y gana sin empate que lo frene. Nombres y precios inventados; la FORMA es la del
// par real que trajo el fichero (Difuminado de raíz 40 € vs Color raíz 75 €).
const COMPLEMENTO = { nombre: 'Velado de raíz',        precio: 40,  duracion: 30,  categoria: 'Color Premium', solo_complemento: true };
const VECINO      = { nombre: 'Tono raíz de prueba',   precio: 75,  duracion: 120, categoria: 'Color Premium' };
const CAT = [
    COMPLEMENTO,
    VECINO,
    { nombre: 'Tono entero de prueba', precio: 100, duracion: 120, categoria: 'Color Premium' },
    { nombre: 'Corte de prueba',       precio: 25,  duracion: 30,  categoria: 'Cortes de prueba' },
];
// El veto de este fichero. Se inyecta en la lista viva para no depender de que el token
// real siga ahí: lo que se prueba es el MECANISMO, no la palabra de hoy.
const TOKEN = 'velado';
const conVeto = () => {
    if (!TOKENS_SOLO_DE_SU_SERVICIO.includes(TOKEN)) TOKENS_SOLO_DE_SU_SERVICIO.push(TOKEN);
};
conVeto();

const BOT   = () => botOfferableCatalog(CAT);   // sin el complemento
const PANEL = () => offerableCatalog(CAT);      // con él
const nombre = svc => (svc ? `${svc.categoria}|${svc.nombre}` : null);

// ── 0. EL FIXTURE MUERDE (regla 2) ──────────────────────────────────────────────────
// Sin este bloque, un fixture que dejara de reproducir la caída volvería verdes todos los
// demás sin que nadie se enterase: es exactamente lo que pasó con la primera versión de
// este fichero. Aquí se quita el veto a mano y se AFIRMA el daño.
test('el fixture reproduce la caída: SIN el veto, la mención acaba en el vecino', () => {
    const original = [...TOKENS_SOLO_DE_SU_SERVICIO];
    try {
        TOKENS_SOLO_DE_SU_SERVICIO.length = 0;
        TOKENS_SOLO_DE_SU_SERVICIO.push(...original.filter(x => x !== TOKEN));
        const caido = extractServiceFromText('quiero un velado de raíz', BOT());
        assert.strictEqual(nombre(caido), nombre(VECINO),
            'el fixture ya NO reproduce la caída al vecino: los demás bloques de este fichero '
            + 'estarían pasando con y sin el arreglo, que es no proteger nada (regla 2)');
    } finally {
        TOKENS_SOLO_DE_SU_SERVICIO.length = 0;
        TOKENS_SOLO_DE_SU_SERVICIO.push(...original);
    }
});

// ── 1. El daño que se arregla ────────────────────────────────────────────────────────
test('la mención del complemento NO cae en el vecino: da null', () => {
    for (const texto of [
        'velado de raíz',
        'quiero un velado de raíz',
        'me haces un velado?',
        'quiero mechas y un velado de raíz',
    ]) {
        assert.strictEqual(extractServiceFromText(texto, BOT()), null,
            `«${texto}» resolvió a ${nombre(extractServiceFromText(texto, BOT()))} en vez de null`);
    }
});

test('null y no el vecino: el vecino cuesta 35 € y 90 min MÁS', () => {
    const caido = extractServiceFromText('quiero un velado de raíz', BOT());
    assert.notStrictEqual(nombre(caido), nombre(VECINO),
        'la mención del complemento acabó en el vecino: precio y agenda equivocados, en silencio');
    assert.strictEqual(VECINO.precio - COMPLEMENTO.precio, 35, 'el fixture ya no mide la diferencia de precio');
    assert.strictEqual(VECINO.duracion - COMPLEMENTO.duracion, 90, 'el fixture ya no mide la diferencia de agenda');
});

// ── 2. El contrapeso: donde la entrada SÍ está, el veto calla ───────────────────────
test('con el catálogo del PANEL el complemento sigue resolviendo (la dueña lo añade a mano)', () => {
    assert.strictEqual(nombre(extractServiceFromText('velado de raíz', PANEL())), nombre(COMPLEMENTO));
    assert.strictEqual(nombre(extractServiceFromText('quiero un velado de raíz', PANEL())), nombre(COMPLEMENTO));
});

test('con el catálogo COMPLETO sigue resolviendo: facturación, duración y guardas', () => {
    const full = 'Velado de raíz';
    const b = computeServiceBilling(full, CAT);
    assert.strictEqual(b.segments[0].status, 'ok', 'una cita ya cobrada dejaría de facturar');
    assert.strictEqual(b.totalConIva, 40);
    assert.strictEqual(resolveServiceDurationMin(full, CAT, null), 30, 'la duración del upsell se apagaría');
    // Las guardas no son ofertas: reciben el catálogo completo y no pueden confundir
    // el nombre de un servicio con el de una persona.
    assert.strictEqual(isServiceName('Velado de raíz', CAT), true);
});

// ── 3. Que no se lleve por delante al vecino (regla 12) ─────────────────────────────
test('el vecino y las demás entradas resuelven EXACTAMENTE igual con y sin veto', () => {
    const sinVeto = TOKENS_SOLO_DE_SU_SERVICIO.filter(x => x !== TOKEN);
    const original = [...TOKENS_SOLO_DE_SU_SERVICIO];
    // Frases que NO dicen el token vetado. Ninguna puede cambiar: es la mitad de la regla 12
    // — una red se define por el mensaje bueno que NO debe comerse.
    const buenos = ['tono raíz de prueba', 'quiero tono raíz de prueba', 'tono entero de prueba',
                    'corte de prueba', 'color', 'quiero un tono nuevo'];
    const con = buenos.map(t => nombre(extractServiceFromText(t, BOT())));
    try {
        TOKENS_SOLO_DE_SU_SERVICIO.length = 0;
        TOKENS_SOLO_DE_SU_SERVICIO.push(...sinVeto);
        const sin = buenos.map(t => nombre(extractServiceFromText(t, BOT())));
        assert.deepStrictEqual(con, sin, 'el veto cambió una resolución que no era suya');
    } finally {
        TOKENS_SOLO_DE_SU_SERVICIO.length = 0;
        TOKENS_SOLO_DE_SU_SERVICIO.push(...original);
    }
    assert.strictEqual(con[0], nombre(VECINO), 'el vecino dejó de resolver por su propio nombre');
});

// ── 4. Se apaga solo cuando la dueña quita la marca ─────────────────────────────────
test('quitada la marca, el complemento vuelve a resolver sin tocar código', () => {
    const sinMarca = CAT.map(s => (s === COMPLEMENTO ? { ...s, solo_complemento: false } : s));
    assert.strictEqual(nombre(extractServiceFromText('velado de raíz', botOfferableCatalog(sinMarca))),
        nombre(COMPLEMENTO), 'el veto quedó pegado a la palabra en vez de al catálogo');
});

// ── 5. La lista es enumerada, y 'raiz' NO está en ella ──────────────────────────────
test("la lista de tokens es enumerada y no contiene tokens que se digan de pasada", () => {
    assert.ok(Array.isArray(TOKENS_SOLO_DE_SU_SERVICIO), 'TOKENS_SOLO_DE_SU_SERVICIO tiene que exportarse');
    assert.ok(TOKENS_SOLO_DE_SU_SERVICIO.includes('difuminado'),
        'falta el token que trajo este fichero: «difuminado»');
    for (const prohibido of ['raiz', 'raíz', 'color', 'corte', 'largo', 'gel', 'uña', 'una', 'k18']) {
        assert.ok(!TOKENS_SOLO_DE_SU_SERVICIO.includes(prohibido),
            `«${prohibido}» es identidad de una categoría entera o se dice de pasada: vetarlo se come la respuesta BUENA (regla 12)`);
    }
    for (const tok of TOKENS_SOLO_DE_SU_SERVICIO) {
        assert.strictEqual(tok, tok.toLowerCase().normalize('NFC'),
            `«${tok}» tiene que ir ya normalizado: se compara contra normalizeService()`);
        assert.ok(tok.length >= 5, `«${tok}» es demasiado corto para ser identidad de un servicio`);
    }
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
