// Pedido por Yulia (dueña), 02/08/2026 (migración 026): la categoría "Reconstrucción" se
// renombra entera y el "Reconstrucción" a secas (duplicado por error) se borra. Quedan:
//   • "Reconstrucción K18"                  — complemento DENTRO de un color: 35€ / 15 min
//     (el lavado y el peinado ya van incluidos en el color, solo queda aplicar el producto).
//   • "Reconstrucción K18 + lavar y peinar" — SUELTO, sin color asociado: 60€ / 60 min.
//   • "Reconstrucción Pro Miracle"          — 60€ / 60 min (antes 65€).
//
// El cambio de naming invierte el problema que documentaba la migración 024. Antes existía
// una entrada llamada exactamente "K18" y el nombre corto ganaba por substring; ahora NO
// existe, así que extractServiceFromText por sí solo:
//   • "k18" a secas            → null  (el bot no resuelve el servicio y vuelve a preguntar)
//   • "reconstrucción k18"     → el complemento de 35€/15min
// El segundo es el lado peligroso: cobrar 35€ y reservar 15 min para una hora de trabajo.
// Por eso la decisión ya NO puede depender del texto: la toma resolveK18ComplementIfNeeded /
// resolveK18ServiceFromText a partir de si hay un color en la sesión.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    extractServiceFromText,
    resolveServiceDurationMin,
    resolveK18ComplementIfNeeded,
    resolveK18ServiceFromText,
    isBareK18Mention,
    computeServiceBilling,
} = require('../services/helpers');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// Catálogo real tras la migración 026 (subconjunto).
const CATALOG = [
    { nombre: 'Mechas Contouring', categoria: 'Mechas Contouring', precio: 160, duracion: 200 },
    { nombre: 'Matiz plus',        categoria: 'Matiz mujer',       precio: 15,  duracion: 20 },
    { nombre: 'Reconstrucción Pro Miracle',          categoria: 'Reconstrucción', precio: 60, duracion: 60 },
    { nombre: 'Reconstrucción K18 + lavar y peinar', categoria: 'Reconstrucción', precio: 60, duracion: 60 },
    { nombre: 'Reconstrucción K18',                  categoria: 'Reconstrucción', precio: 35, duracion: 15 },
];

const SUELTO = 'Reconstrucción K18 + lavar y peinar';
const COMPLEMENTO = 'Reconstrucción K18';

// ─── Los dos caminos que exige el cambio de naming ───────────────────────────

test('CAMINO A — "K18" a secas SIN color en sesión → suelto (60€/60min)', () => {
    const svc = resolveK18ServiceFromText('k18', null, CATALOG);
    assert.ok(svc, 'debería resolver: un null deja al bot preguntando el servicio en bucle');
    assert.strictEqual(svc.nombre, SUELTO);
    assert.strictEqual(svc.precio, 60);
    assert.strictEqual(svc.duracion, 60);
});

test('CAMINO B — "K18" a secas CON color en sesión → complemento (35€/15min)', () => {
    const svc = resolveK18ServiceFromText('k18', 'Mechas Contouring', CATALOG);
    assert.ok(svc);
    assert.strictEqual(svc.nombre, COMPLEMENTO);
    assert.strictEqual(svc.precio, 35);
    assert.strictEqual(svc.duracion, 15);
});

test('el caso que cobraba de menos: "reconstrucción k18" sin color NO cae al de 15 min', () => {
    // Sin la corrección, extractServiceFromText resuelve esta frase al complemento porque
    // es literalmente su nombre de catálogo — 35€ y 15 min de agenda para 60 min de trabajo.
    assert.strictEqual(extractServiceFromText('reconstruccion k18', CATALOG).nombre, COMPLEMENTO);
    const svc = resolveK18ServiceFromText('reconstruccion k18', null, CATALOG);
    assert.strictEqual(svc.nombre, SUELTO);
    assert.strictEqual(svc.duracion, 60);
});

test('variantes de escritura de la clienta ("k-18", "K 18") toman el mismo camino', () => {
    for (const txt of ['k-18', 'K 18', 'K18', 'k18']) {
        assert.strictEqual(resolveK18ServiceFromText(txt, null, CATALOG).nombre, SUELTO, `falló sin color: ${txt}`);
        assert.strictEqual(resolveK18ServiceFromText(txt, 'Mechas Airtouch', CATALOG).nombre, COMPLEMENTO, `falló con color: ${txt}`);
    }
});

test('pedir el suelto por su nombre COMPLETO manda, aunque haya color en sesión', () => {
    // "lavar y peinar" es una elección explícita de la clienta: no se reinterpreta.
    assert.ok(!isBareK18Mention(SUELTO));
    assert.strictEqual(resolveK18ServiceFromText(SUELTO, 'Mechas Contouring', CATALOG), null);
    assert.strictEqual(resolveK18ComplementIfNeeded(SUELTO, 'Mechas Contouring', CATALOG), SUELTO);
});

// ─── resolveK18ComplementIfNeeded: la vía de nombres (upselling_aceptado) ─────

test('con color ya seleccionado, "K18" se corrige al complemento', () => {
    assert.strictEqual(resolveK18ComplementIfNeeded('K18', 'Mechas Contouring', CATALOG), COMPLEMENTO);
});

test('funciona para las 5 categorías de decoloración, con y sin tildes', () => {
    const categorias = ['Mechas Balayage', 'Mechas Airtouch', 'Mechas Contouring', 'Mechas clásicas', 'Deco Total Blond'];
    for (const cat of categorias) {
        assert.strictEqual(resolveK18ComplementIfNeeded('K18', cat, CATALOG), COMPLEMENTO, `falló para ${cat}`);
    }
});

test('sin color asociado, "K18" resuelve al SUELTO por su nombre nuevo', () => {
    // Cambio respecto a la migración 024: antes se devolvía el string 'K18' intacto porque
    // era un nombre de catálogo válido. Ya no lo es, así que devolverlo tal cual dejaría un
    // nombre no facturable en appointments.service.
    assert.strictEqual(resolveK18ComplementIfNeeded('K18', null, CATALOG), SUELTO);
    assert.strictEqual(resolveK18ComplementIfNeeded('K18', undefined, CATALOG), SUELTO);
    assert.strictEqual(resolveK18ComplementIfNeeded('K18', 'Cortes', CATALOG), SUELTO);
});

test('un servicio que no es K18 nunca se toca', () => {
    assert.strictEqual(resolveK18ComplementIfNeeded('Manicura', 'Mechas Contouring', CATALOG), 'Manicura');
    assert.strictEqual(resolveK18ComplementIfNeeded('Reconstrucción Pro Miracle', 'Mechas Contouring', CATALOG), 'Reconstrucción Pro Miracle');
    assert.strictEqual(resolveK18ServiceFromText('quiero una manicura', null, CATALOG), null);
});

test('si el catálogo no tiene las entradas nuevas (org distinta o catálogo viejo), no revienta', () => {
    // Degradación: si no encuentra el nombre nuevo devuelve el que le pasaron, así que
    // sobre un catálogo que aún tiene "K18" se resuelve a esa entrada en vez de a null.
    const catalogoViejo = [{ nombre: 'K18', categoria: 'Reconstrucción', precio: 60, duracion: 60 }];
    assert.strictEqual(resolveK18ComplementIfNeeded('K18', 'Mechas Contouring', catalogoViejo), 'K18');
    assert.strictEqual(resolveK18ServiceFromText('k18', null, catalogoViejo).nombre, 'K18');
    assert.strictEqual(resolveK18ComplementIfNeeded('K18', null, []), 'K18');
    assert.strictEqual(resolveK18ServiceFromText('k18', null, []), null);
});

// ─── Duración y facturación con los nombres nuevos ───────────────────────────

test('resolveServiceDurationMin: suelto → 60, complemento → 15', () => {
    assert.strictEqual(resolveServiceDurationMin(SUELTO, CATALOG), 60);
    assert.strictEqual(resolveServiceDurationMin(COMPLEMENTO, CATALOG), 15);
});

test('computeServiceBilling: "Mechas Contouring + Reconstrucción K18" cobra 195', () => {
    const { totalConIva, segments } = computeServiceBilling(`Mechas Contouring + ${COMPLEMENTO}`, CATALOG);
    assert.strictEqual(segments.length, 2);
    assert.ok(segments.every(s => s.status === 'ok'));
    assert.strictEqual(totalConIva, 160 + 35);
});

test('computeServiceBilling: el suelto cobra 60 pese a llevar " + " en el nombre', () => {
    // splitServiceNames no puede trocear este nombre por el separador: es UN servicio.
    const { totalConIva, segments } = computeServiceBilling(SUELTO, CATALOG);
    assert.strictEqual(segments.length, 1);
    assert.strictEqual(totalConIva, 60);
});

test('computeServiceBilling: "Mechas Contouring + Reconstrucción K18 + lavar y peinar" son 2 servicios, no 3', () => {
    const { totalConIva, segments } = computeServiceBilling(`Mechas Contouring + ${SUELTO}`, CATALOG);
    assert.strictEqual(segments.length, 2);
    assert.ok(segments.every(s => s.status === 'ok'));
    assert.strictEqual(totalConIva, 160 + 60);
});

test('Reconstrucción Pro Miracle cuesta 60 (antes 65)', () => {
    assert.strictEqual(computeServiceBilling('Reconstrucción Pro Miracle', CATALOG).totalConIva, 60);
    assert.strictEqual(extractServiceFromText('pro miracle', CATALOG).nombre, 'Reconstrucción Pro Miracle');
});
