// Transiciones de las filas del formulario multi-servicio (ServiceListField), simulando lo
// que hace la recepcionista: añadir fila, elegir del desplegable, borrar, reabrir la cita.
//
// El estado es {servicio, numFilas}: los nombres NO se duplican en estado local (viven en el
// `servicio` del formulario padre) y lo único local es cuántas filas se enseñan. Esa mezcla es
// la parte sutil — de ahí este test. Hermético: cero red, cero React.

const assert = require('assert');
const path = require('path');
const { buildFullServiceName } = require('../services/helpers');

const {
    serviceRows, addServiceRow, setServiceRow, removeServiceRow,
} = require(path.join(__dirname, '..', 'dashboard-app', 'src', 'lib', 'service-names.ts'));

const CATALOGO = require('./fixtures/sante-catalog.json').services;
const CAT = CATALOGO.map(s => ({ nombre: s.nombre, fullName: buildFullServiceName(s, CATALOGO) }));

let fallos = 0;
function test(nombre, fn) {
    try { fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`FALLO - ${nombre}\n   ${e.message}`); }
}

// Azúcar para leer los tests como una sesión de la recepcionista.
const filas = (s) => serviceRows(s, CAT);
const nueva = () => ({ servicio: '', numFilas: 1 });
const abrir = (servicio) => ({ servicio, numFilas: 1 });
const anadir = (s) => ({ ...s, numFilas: addServiceRow(s, CAT).numFilas });
const elegir = (s, idx, valor) => setServiceRow(s, idx, valor, CAT);
const borrar = (s, idx) => removeServiceRow(s, idx, CAT);

test('cita nueva: una sola fila vacía', () => {
    assert.deepStrictEqual(filas(nueva()), ['']);
});

test('alta de 3 servicios: añadir → elegir, sin filas fantasma', () => {
    let s = nueva();
    s = elegir(s, 0, 'Mechas Contouring');
    assert.deepStrictEqual(filas(s), ['Mechas Contouring']);

    s = anadir(s);
    assert.deepStrictEqual(filas(s), ['Mechas Contouring', ''], 'la fila añadida se ve vacía');

    s = elegir(s, 1, 'Matiz plus');
    assert.deepStrictEqual(filas(s), ['Mechas Contouring', 'Matiz plus'], 'sin fila vacía de más');

    s = anadir(s);
    s = elegir(s, 2, 'K18');
    assert.deepStrictEqual(filas(s), ['Mechas Contouring', 'Matiz plus', 'K18']);
    assert.strictEqual(s.servicio, 'Mechas Contouring + Matiz plus + K18');
});

test('añadir una fila y rellenar OTRA no hace desaparecer la vacía', () => {
    // El bug que tenía la primera versión: recalcular numFilas desde las filas rellenas.
    let s = abrir('Mechas Contouring');
    s = anadir(s);
    assert.deepStrictEqual(filas(s), ['Mechas Contouring', '']);
    s = elegir(s, 0, 'Corte mujer y secado'); // cambia la PRIMERA, no la nueva
    assert.deepStrictEqual(filas(s), ['Corte mujer y secado', ''], 'la fila 2 sigue ahí');
});

test('borrar la fila del medio no deja hueco fantasma', () => {
    let s = abrir('Mechas Contouring + Matiz plus + K18');
    assert.strictEqual(filas(s).length, 3);
    s = borrar(s, 1);
    assert.deepStrictEqual(filas(s), ['Mechas Contouring', 'K18']);
    assert.strictEqual(s.servicio, 'Mechas Contouring + K18');
});

test('borrar una fila vacía recién añadida vuelve al estado anterior', () => {
    let s = abrir('K18');
    s = anadir(s);
    s = borrar(s, 1);
    assert.deepStrictEqual(filas(s), ['K18']);
    assert.strictEqual(s.servicio, 'K18');
});

test('nunca se baja de una fila', () => {
    let s = abrir('K18');
    s = borrar(s, 0);
    assert.deepStrictEqual(filas(s), ['']);
    assert.strictEqual(s.servicio, '');
});

test('reabrir una cita de 3 servicios muestra 3 filas de entrada', () => {
    assert.deepStrictEqual(
        filas(abrir('Mechas Contouring + Matiz plus + K18')),
        ['Mechas Contouring', 'Matiz plus', 'K18'],
        'numFilas arranca en 1 pero el servicio guardado manda'
    );
});

test('un servicio con " + " en el nombre ocupa UNA fila, no dos', () => {
    assert.deepStrictEqual(filas(abrir('Pedicura + esmaltado')), ['Pedicura + esmaltado']);
    assert.deepStrictEqual(filas(abrir('Pedicura + esmaltado + K18')), ['Pedicura + esmaltado', 'K18']);
});

test('se permite repetir el mismo servicio (dos manicuras en la misma visita)', () => {
    let s = nueva();
    s = elegir(s, 0, 'Manicura + gel');
    s = anadir(s);
    s = elegir(s, 1, 'Manicura + gel');
    assert.strictEqual(s.servicio, 'Manicura + gel + Manicura + gel');
    assert.deepStrictEqual(filas(s), ['Manicura + gel', 'Manicura + gel'], 'longest match resuelve las dos');
});

test('texto libre fuera de catálogo ocupa su fila y no rompe las demás', () => {
    let s = abrir('K18');
    s = anadir(s);
    s = elegir(s, 1, 'Tratamiento especial de la casa');
    assert.strictEqual(s.servicio, 'K18 + Tratamiento especial de la casa');
    assert.deepStrictEqual(filas(s), ['K18', 'Tratamiento especial de la casa']);
});

test('San Remo (catálogo vacío): una fila con el texto tal cual', () => {
    assert.deepStrictEqual(serviceRows({ servicio: 'Reserva mesa terraza', numFilas: 1 }, []), ['Reserva mesa terraza']);
});

if (fallos) { console.error(`\n${fallos} fallo(s) en las transiciones de filas`); process.exit(1); }
console.log('\nTodos los tests de filas multi-servicio OK');
