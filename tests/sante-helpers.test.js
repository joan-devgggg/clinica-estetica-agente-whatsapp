// Tests for extractServiceFromText and extractLargoPelo (Sante-specific helpers).
// Covers the extraction gaps fixed in the anti-regression pass.

const assert = require('assert');
const {
    extractServiceFromText, extractLargoPelo, extractQuickDataSante, buildFullServiceName,
} = require('../services/helpers');
const CATALOGO_REAL = require('./fixtures/sante-catalog.json');

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

// ── Fixture con NOMBRES REALES del catálogo de Sante (agent_configs.services) ──
// Los nombres deben salir del catálogo vivo, no inventarse: un fixture con un
// "Masaje relajante" que no existe en producción da verde sobre datos irreales y
// deja pasar bugs de resolución (así se coló el bucle de "Aromaterapia").
const catalog = [
    // Cortes — multi-service, no length variants
    { nombre: 'Mujer y peinado Dyson', categoria: 'Cortes', precio: 50, duracion: 60 },
    { nombre: 'Mujer y secado',        categoria: 'Cortes', precio: 40, duracion: 45 },
    { nombre: 'Hombre',                categoria: 'Cortes', precio: 25, duracion: 30 },
    // Alisado — multi-variant by length (largo 1/2/3)
    { nombre: 'Largo 1', categoria: 'Alisado vegano', precio: 210, duracion: 300 },
    { nombre: 'Largo 2', categoria: 'Alisado vegano', precio: 260, duracion: 300 },
    { nombre: 'Largo 3', categoria: 'Alisado vegano', precio: 310, duracion: 300 },
    // Masajes y SPA — multi-service; varios nombres comparten el token "relajante",
    // que es justo lo que hacía empatar y devolver null.
    { nombre: 'Relajante completo',         categoria: 'Masajes y SPA', precio: 70, duracion: 60 },
    { nombre: 'Holistic relajante Premium', categoria: 'Masajes y SPA', precio: 95, duracion: 90 },
    { nombre: 'Aromaterapia relax',         categoria: 'Masajes y SPA', precio: 75, duracion: 60 },
    { nombre: 'Drenaje linfático piernas',  categoria: 'Masajes y SPA', precio: 45, duracion: 40 },
    { nombre: 'Deportivo',                  categoria: 'Masajes y SPA', precio: 65, duracion: 60 },
    // "Blond" aparece en un nombre de Tratamiento Orgánico y en la CATEGORÍA Deco
    // Total Blond (variantes por largo): el rescate por token no debe cruzarlas.
    { nombre: 'Botanical Glow Pure Blond', categoria: 'Tratamiento Orgánico', precio: 45, duracion: 40 },
    { nombre: 'Largo 1', categoria: 'Deco Total Blond', precio: 125, duracion: 120 },
    { nombre: 'Largo 2', categoria: 'Deco Total Blond', precio: 145, duracion: 120 },
    { nombre: 'K18',     categoria: 'Reconstrucción',   precio: 45,  duracion: 60 },
];

// ─── extractServiceFromText — Fix: "degradado" maps to Cortes ─────────────────

test('extractServiceFromText: "degradado" resuelve a categoría Cortes', () => {
    const svc = extractServiceFromText('quiero un degradado', catalog);
    // En un catálogo real hay varias variantes de Cortes; aquí hay 3 → fuzzy devuelve
    // null si no hay palabra discriminante adicional (multi-service sin match exacto).
    // El test importante es que NO devuelve un servicio de otra categoría.
    if (svc !== null) {
        assert.strictEqual(svc.categoria, 'Cortes', `se esperaba Cortes pero se obtuvo ${svc.categoria}`);
    }
    // No debe resolver a Masajes, K18, etc.
    assert.ok(svc === null || svc.categoria === 'Cortes');
});

test('extractServiceFromText: "quiero un corte" resuelve a Cortes', () => {
    const svc = extractServiceFromText('quiero un corte', catalog);
    // Con un catálogo multi-servicio, si ninguna palabra discriminante → null es válido.
    // Pero NUNCA debe resolverse a otra categoría.
    assert.ok(svc === null || svc.categoria === 'Cortes');
});

test('extractServiceFromText: "masaje" a secas NO resuelve (categoría ambigua)', () => {
    // Masajes y SPA tiene 9 servicios en el catálogo real: "quiero un masaje" no
    // identifica ninguno. null es la respuesta CORRECTA — el bot repregunta el tipo,
    // que es exactamente lo que hace en producción. Lo que nunca debe hacer es elegir
    // uno arbitrario (precio y duración distintos).
    assert.strictEqual(extractServiceFromText('quiero un masaje', catalog), null);
});

test('extractServiceFromText: "masaje relajante" resuelve a "Relajante completo"', () => {
    // El token "relajante" está en "Relajante completo" (lo encabeza) y en "Holistic
    // relajante Premium" (accesorio). Antes empataban y se abortaba con null; el
    // desempate por prefijo elige el que lleva el término como nombre principal.
    const svc = extractServiceFromText('quiero un masaje relajante', catalog);
    assert.ok(svc !== null, 'no debe abortar por empate');
    assert.strictEqual(svc.nombre, 'Relajante completo');
    assert.strictEqual(svc.categoria, 'Masajes y SPA');
});

test('extractServiceFromText: "k18" resuelve a Reconstrucción', () => {
    const svc = extractServiceFromText('k18', catalog);
    assert.ok(svc !== null, 'debería encontrar un servicio');
    assert.strictEqual(svc.categoria, 'Reconstrucción');
});

test('extractServiceFromText: "alisado largo 2" resuelve a variante Largo 2 de Alisado vegano', () => {
    const svc = extractServiceFromText('quiero alisado largo 2', catalog);
    assert.ok(svc !== null, 'debería encontrar un servicio');
    assert.strictEqual(svc.nombre, 'Largo 2');
    assert.strictEqual(svc.categoria, 'Alisado vegano');
});

// ─── extractLargoPelo — Fix: "normal" → 2 (medio) ────────────────────────────

test('extractLargoPelo: "normal" → 2 (medio)', () => {
    assert.strictEqual(extractLargoPelo('normal'), 2);
});

test('extractLargoPelo: "media" → 2 (medio)', () => {
    assert.strictEqual(extractLargoPelo('media'), 2);
});

test('extractLargoPelo: "corto" → 1', () => {
    assert.strictEqual(extractLargoPelo('corto'), 1);
});

test('extractLargoPelo: "largo" → 3', () => {
    assert.strictEqual(extractLargoPelo('largo'), 3);
});

test('extractLargoPelo: "muy largo" → 4', () => {
    assert.strictEqual(extractLargoPelo('muy largo'), 4);
});

test('extractLargoPelo: "no lo sé" → null (desconocido manejado por el caller)', () => {
    assert.strictEqual(extractLargoPelo('no lo sé'), null);
});

test('extractLargoPelo: "largo 2" → null (número de variante, no longitud física)', () => {
    // "largo 2" en el catálogo es el nombre de la variante — extractLargoPelo retorna
    // null a propósito para que el caller lo interprete como número de variante directamente.
    assert.strictEqual(extractLargoPelo('largo 2'), null);
});

test('extractLargoPelo: preserva Ruso "средн" → 2', () => {
    assert.strictEqual(extractLargoPelo('средней длины'), 2);
});

// ─── extractQuickDataSante — Fix: 'semana' no se fija con día/fecha concreto ──────────
// Bug real: "mañana" (día siguiente) ponía semana:'esta'; combinado con un día explícito
// ("lunes") en el mismo mensaje, calendar-sante acotaba el rango de búsqueda a
// [hoy, hoy] en domingo (todayDow=6) y descartaba el lunes pedido → totalSlots:0 falso
// pese a que la estilista tenía la skill, el horario y el día libres.

test('extractQuickDataSante: "mañana lunes" NO fija semana (ya hay diaSemana explícito)', () => {
    const result = extractQuickDataSante('¿Mañana lunes tienes hueco para Balayage?');
    assert.strictEqual(result.preferencia_horaria.diaSemana, 0, 'debe reconocer lunes como diaSemana=0');
    assert.strictEqual(result.preferencia_horaria.semana, undefined, 'NO debe fijar semana cuando ya hay un día concreto');
});

test('extractQuickDataSante: "mañana" + fecha explícita ("24 de julio") tampoco fija semana', () => {
    const result = extractQuickDataSante('¿mañana el 24 de julio tienes hueco?');
    assert.ok(result.preferencia_horaria.fecha, 'debe extraer la fecha explícita');
    assert.strictEqual(result.preferencia_horaria.semana, undefined, 'NO debe fijar semana cuando ya hay fecha concreta');
});

test('extractQuickDataSante: "mañana" a secas (sin día/fecha) sigue fijando semana:"esta"', () => {
    const result = extractQuickDataSante('¿Tienes hueco mañana?');
    assert.strictEqual(result.preferencia_horaria.semana, 'esta', 'sin día concreto, "mañana" debe seguir acotando a esta semana (comportamiento previo intacto)');
});

test('extractQuickDataSante: "esta semana" explícita sin día concreto sigue funcionando', () => {
    const result = extractQuickDataSante('¿Tienes hueco esta semana?');
    assert.strictEqual(result.preferencia_horaria.semana, 'esta');
});

test('extractQuickDataSante: un diaSemana ya guardado en un turno anterior también bloquea "semana" en el turno siguiente', () => {
    const result = extractQuickDataSante('¿Y mañana tienes algo?', { preferencia_horaria: { diaSemana: 3 } });
    assert.strictEqual(result.preferencia_horaria.diaSemana, 3, 'conserva el día ya fijado');
    assert.strictEqual(result.preferencia_horaria.semana, undefined, 'no debe añadir semana sobre un día ya concreto de un turno previo');
});

// ─── Pasada de último recurso: nombre de catálogo abreviado ───────────────────
// Bug de producción (27/07/2026): la clienta pide "Aromaterapia", el catálogo la
// guarda como "Aromaterapia relax" y la resolución devolvía null. Como el prompt ya
// le había dicho al LLM que no volviera a preguntar el servicio, el null se convertía
// en bucle infinito ("Para mirarte los huecos primero necesito saber qué servicio").

test('extractServiceFromText: "Aromaterapia" resuelve a "Aromaterapia relax" (nombre abreviado)', () => {
    const svc = extractServiceFromText('Aromaterapia', catalog);
    assert.ok(svc !== null, 'no debe devolver null: el null dispara el bucle de repregunta');
    assert.strictEqual(svc.nombre, 'Aromaterapia relax');
    assert.strictEqual(svc.categoria, 'Masajes y SPA');
});

test('extractServiceFromText: el rescate por token no cruza a una categoría que el texto nombra', () => {
    // "Deco Total Blond" es una categoría con variantes por largo: lo correcto es NO
    // resolver (el bot preguntará el largo). Resolver a "Botanical Glow Pure Blond"
    // por el token "blond" sería reservar otro servicio a otro precio en silencio.
    const svc = extractServiceFromText('quiero deco total blond', catalog);
    assert.ok(svc === null || svc.categoria === 'Deco Total Blond',
        `no debe salirse de la categoría nombrada; se obtuvo ${svc && svc.categoria}`);
});

test('extractServiceFromText: un token corto/no distintivo no basta para resolver', () => {
    // Sin esta guarda, cualquier palabra suelta del mensaje engancharía un servicio.
    assert.strictEqual(extractServiceFromText('a las cinco', catalog), null);
    assert.strictEqual(extractServiceFromText('mañana', catalog), null);
    assert.strictEqual(extractServiceFromText('me llamo Ana', catalog), null);
});

// ── Red de propiedad sobre el catálogo REAL completo ──────────────────────────
// Es la Fase 1 de `npm run verify:sante` pero offline, sobre el fixture: entra en
// `npm test` y detecta cualquier regresión de la resolución sin credenciales de
// Supabase. La añadió el incidente 02/08/2026: la pasada de especificidad toca la
// función más delicada del salón, y "5 diffs medidos" sólo vale si algo lo vigila.
test('catálogo real: cada servicio se resuelve a sí mismo (ida y vuelta, 81 entradas)', () => {
    const desajustes = [];
    for (const svc of CATALOGO_REAL) {
        const full = buildFullServiceName(svc, CATALOGO_REAL);
        const got = extractServiceFromText(full, CATALOGO_REAL);
        if (!got || got.nombre !== svc.nombre || got.categoria !== svc.categoria) {
            desajustes.push(`${full} → ${got ? `${got.categoria} / ${got.nombre}` : 'null'}`);
        }
    }
    assert.deepStrictEqual(desajustes, [], 'servicios que no se resuelven a sí mismos');
});

// ── Palabra ambigua entre categorías → preguntar, no cobrar de más ────────────
// Incidente 02/08/2026: la clienta escribió "Hidratación" a secas y se le reservó la de
// 110 € sin preguntarle. Había TRES servicios con esa palabra (45 / 85 / 110 €) y el
// desempate por prefijo de la pasada de último recurso elegía el que EMPIEZA por ella.
// O sea: el orden de las palabras dentro del nombre decidía el precio, siempre hacia
// arriba. Renombrarlo a "Spa Hidratación 60min" NO lo arregla —"spa" tiene 3 letras y el
// filtro de tokens distintivos exige 5, así que "hidratacion" sigue encabezando—; el
// arreglo es no aplicar el desempate cuando el empate cruza categorías.
test('catálogo real: una palabra que varias CATEGORÍAS comparten no resuelve sola', () => {
    for (const [frase, servicios] of [['hidratacion', '45/85/110 €'], ['detox', '35/115 €']]) {
        assert.strictEqual(extractServiceFromText(frase, CATALOGO_REAL), null,
            `"${frase}" es ambigua (${servicios}): el bot debe preguntar, no elegir`);
    }
    assert.strictEqual(extractServiceFromText('quiero una hidratación', CATALOGO_REAL), null);
});

test('catálogo real: con un discriminador, la misma palabra sí resuelve', () => {
    const casos = [
        ['fresh hidratacion', 'Fresh Hidratación', 45],
        ['orising hidratacion intensa', 'Orising hidratación intensa', 85],
        ['spa hidratacion 60min', 'Spa Hidratación 60min', 110],
        ['green purity detox', 'Green Purity Detox', 35],
        ['detox 60min', 'Detox 60min', 115],
    ];
    for (const [frase, nombre, precio] of casos) {
        const got = extractServiceFromText(frase, CATALOGO_REAL);
        assert.ok(got, `"${frase}" debe resolver`);
        assert.strictEqual(got.nombre, nombre, `"${frase}"`);
        assert.strictEqual(got.precio, precio, `"${frase}" al precio correcto`);
    }
});

test('catálogo real: el desempate por prefijo sigue vivo DENTRO de una categoría', () => {
    // Es el caso que la pasada de último recurso existe para rescatar. Solo se anula
    // cuando el empate cruza categorías, que es cuando cambia el precio de verdad.
    const casos = [
        ['aromaterapia', 'Aromaterapia relax'],
        ['espalda y hombros', 'Espalda y hombros'],
        ['quiero un masaje relajante', 'Relajante completo'],
        ['pro miracle', 'Reconstrucción Pro Miracle'],
    ];
    for (const [frase, nombre] of casos) {
        const got = extractServiceFromText(frase, CATALOGO_REAL);
        assert.ok(got, `"${frase}" NO debe devolver null: un null aquí se paga en repreguntas`);
        assert.strictEqual(got.nombre, nombre, `"${frase}"`);
    }
});

test('catálogo real: los pares prefijo no se resuelven a ciegas', () => {
    // Los únicos pares donde un nombre es prefijo de otro. La regla de especificidad
    // sólo debe promover el largo cuando el texto trae su discriminador.
    const casos = [
        ['quiero un matiz', 'Matiz'],
        ['matiz plus', 'Matiz plus'],
        ['reconstruccion k18', 'Reconstrucción K18'],                        // complemento 35€/15min
        ['reconstruccion k18 lavar y peinar', 'Reconstrucción K18 + lavar y peinar'], // suelto 60€/60min
        ['quiero un cambio importante', 'XL / cambio importante'],
    ];
    for (const [frase, esperado] of casos) {
        const got = extractServiceFromText(frase, CATALOGO_REAL);
        assert.ok(got, `"${frase}" debe resolver`);
        assert.strictEqual(got.nombre, esperado, `"${frase}"`);
    }
});
