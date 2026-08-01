// El panel reconstruye las filas del formulario multi-servicio partiendo appointments.service
// con SU propia copia de splitServiceNames (TypeScript). La facturación lo parte con la del
// backend. Si divergen, la recepcionista ve unas líneas y se cobran otras.
//
// Este test compara las dos implementaciones sobre el catálogo REAL de Sante (el JSON que
// sirve /api/service-catalog), con especial atención a los nombres que llevan " + " dentro
// ("Pedicura + esmaltado"), que son los que rompen un split ingenuo.

const assert = require('assert');
const path = require('path');
const {
    splitServiceNames: splitBackend,
    buildFullServiceName,
} = require('../services/helpers');

const TS = path.join(__dirname, '..', 'dashboard-app', 'src', 'lib', 'service-names.ts');
const { splitServiceNames: splitCliente, joinServiceNames } = require(TS);

const CATALOGO = require('./fixtures/sante-catalog.json');
// Mismo shape que devuelve /api/service-catalog (webhook.js): fullName ya resuelto.
const CATALOGO_CLIENTE = CATALOGO.map(svc => ({
    nombre: svc.nombre,
    fullName: buildFullServiceName(svc, CATALOGO),
}));

let fallos = 0;
function test(nombre, fn) {
    try { fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`FALLO - ${nombre}\n   ${e.message}`); }
}

const ambas = s => ({
    backend: splitBackend(s, CATALOGO),
    cliente: splitCliente(s, CATALOGO_CLIENTE),
});

test('el catálogo real tiene servicios con " + " en el nombre (si no, el test no prueba nada)', () => {
    const conMas = CATALOGO.filter(s => String(s.nombre).includes(' + '));
    assert.ok(conMas.length > 0, 'ningún servicio con " + " en el catálogo de fixtures');
});

test('cada servicio del catálogo, a solas, se parte igual en cliente y backend', () => {
    for (const svc of CATALOGO) {
        const full = buildFullServiceName(svc, CATALOGO);
        const { backend, cliente } = ambas(full);
        assert.deepStrictEqual(cliente, backend, `divergen en "${full}"`);
        assert.deepStrictEqual(backend, [full], `"${full}" debería ser UN solo servicio`);
    }
});

test('todas las parejas contra un servicio con " + " se parten igual', () => {
    const conMas = CATALOGO.filter(s => String(s.nombre).includes(' + '));
    for (const a of conMas) {
        const fullA = buildFullServiceName(a, CATALOGO);
        for (const b of CATALOGO) {
            const fullB = buildFullServiceName(b, CATALOGO);
            const s = `${fullA} + ${fullB}`;
            const { backend, cliente } = ambas(s);
            assert.deepStrictEqual(cliente, backend, `divergen en "${s}"`);
            assert.strictEqual(backend.length, 2, `"${s}" debería dar 2 servicios, dio ${backend.length}`);
        }
    }
});

test('el caso real de Paloma: 3 servicios se parten en 3 en ambas', () => {
    const s = 'Mechas Contouring + Matiz plus + K18';
    const { backend, cliente } = ambas(s);
    assert.deepStrictEqual(cliente, backend);
    assert.deepStrictEqual(backend, ['Mechas Contouring', 'Matiz plus', 'K18']);
});

test('texto fuera de catálogo se parte igual (aunque no matchee nada)', () => {
    for (const s of ['lo que sea', 'algo + otra cosa', 'Corte mujer + inventado', '']) {
        const { backend, cliente } = ambas(s);
        assert.deepStrictEqual(cliente, backend, `divergen en "${s}"`);
    }
});

test('join → split es idempotente sobre nombres de catálogo', () => {
    const nombres = CATALOGO.slice(0, 40).map(s => buildFullServiceName(s, CATALOGO));
    for (let i = 0; i < nombres.length - 1; i++) {
        const combo = joinServiceNames([nombres[i], nombres[i + 1]]);
        assert.deepStrictEqual(
            splitCliente(combo, CATALOGO_CLIENTE),
            [nombres[i], nombres[i + 1]],
            `no round-trip: "${combo}"`
        );
    }
});

test('joinServiceNames descarta huecos vacíos (fila a medio rellenar)', () => {
    assert.strictEqual(joinServiceNames(['K18', '', null, 'Matiz plus']), 'K18 + Matiz plus');
    assert.strictEqual(joinServiceNames([]), '');
    assert.strictEqual(joinServiceNames(['  K18  ']), 'K18');
});

if (fallos) { console.error(`\n${fallos} fallo(s) de paridad cliente/backend`); process.exit(1); }
console.log('\nParidad splitServiceNames cliente/backend OK');
