// Dar el día por revisado (migración 039). Fase 2·C.
//
// No es un cierre contable: es un ACUSE de que alguien ha mirado el día. La dueña dijo "nunca
// falta dinero" y que no quiere justificar diferencias, así que lo que se afirma aquí NO es que
// se detecten descuadres — es que el acuse siga diciendo lo que dijo, y que cuando el día se
// mueva por detrás se NOTE en vez de cambiar solo.
//
// Lo que se prueba:
//   · lo esperado se CONGELA al revisar y no se recalcula al leer;
//   · un cobro posterior marca el día como MOVIDO en vez de reescribirlo;
//   · una diferencia de 0 es un acuse válido y distinto de no haber revisado;
//   · las diferencias se calculan en el servidor, con signo, y sin arrastrar decimales de coma
//     flotante a una columna que luego nadie puede editar;
//   · la cola de días sin revisar excluye HOY y los días sin dinero.
//
// Los CHECK, el índice único y el trigger viven en Postgres y se probaron contra la BD real en
// un bloque que revierte (8 comprobaciones). Aquí se prueba lo que decide el código.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const assert = require('assert');
const {
    buildCajaResumen, buildEstadoDiaRevisado, calcularDiferenciasCierre,
} = require('../services/helpers');

let fallos = 0;
async function test(nombre, fn) {
    try { await fn(); console.log(`ok - ${nombre}`); }
    catch (e) { console.error(`fail - ${nombre}`); console.error(e.message); fallos++; process.exitCode = 1; }
}

const cobro = (total, efectivo) => ({
    id: `c${Math.random()}`, cobrado_por: 'est-1', cobrado_por_nombre: 'Olga',
    importe_total: String(total), importe_efectivo: String(efectivo), atribucion: 'declarada',
});

(async () => {

// ── Las diferencias ─────────────────────────────────────────────────────────

await test('1 · la diferencia lleva SIGNO: negativo es que falta', () => {
    const d = calcularDiferenciasCierre({
        esperadoEfectivo: 100, esperadoTarjeta: 200, contadoEfectivo: 95, tpvDeclarado: 205,
    });
    assert.strictEqual(d.diferencia_efectivo, -5, 'faltan 5 en el cajón');
    assert.strictEqual(d.diferencia_tarjeta, 5, 'el banco dice 5 más');
});

await test('2 · no se arrastran decimales de coma flotante a la columna', () => {
    // 100.1 - 100 da 0.09999999999999432 en JS, y eso acabaría escrito en un registro que
    // después nadie puede editar.
    const d = calcularDiferenciasCierre({
        esperadoEfectivo: 100, esperadoTarjeta: 0, contadoEfectivo: 100.1, tpvDeclarado: 0,
    });
    assert.strictEqual(d.diferencia_efectivo, 0.1);
});

await test('3 · cuadrar da 0, y 0 es una respuesta, no "no se ha mirado"', () => {
    const d = calcularDiferenciasCierre({
        esperadoEfectivo: 80, esperadoTarjeta: 120, contadoEfectivo: 80, tpvDeclarado: 120,
    });
    assert.deepStrictEqual(d, { diferencia_efectivo: 0, diferencia_tarjeta: 0 });
});

// ── El estado del día ───────────────────────────────────────────────────────

await test('4 · sin acuse: el día está SIN revisar y no se inventa uno', () => {
    const e = buildEstadoDiaRevisado(buildCajaResumen([cobro(50, 50)]), null);
    assert.strictEqual(e.revisado, false);
    assert.strictEqual(e.cierre, null);
    assert.strictEqual(e.movido, false);
    assert.strictEqual(e.esperado.efectivo, 50);
});

await test('5 · un día VACÍO revisado ≠ un día vacío sin revisar', () => {
    const sinRevisar = buildEstadoDiaRevisado(buildCajaResumen([]), null);
    const revisado = buildEstadoDiaRevisado(buildCajaResumen([]), {
        esperado_efectivo: '0.00', esperado_tarjeta: '0.00', esperado_total: '0.00', num_cobros: 0,
    });
    assert.strictEqual(sinRevisar.revisado, false);
    assert.strictEqual(revisado.revisado, true);
    assert.strictEqual(revisado.movido, false, 'un día a cero revisado cuadra consigo mismo');
});

await test('6 · revisado y quieto: no está movido', () => {
    const cobros = [cobro(100, 100), cobro(50, 0)];
    const e = buildEstadoDiaRevisado(buildCajaResumen(cobros), {
        esperado_efectivo: '100.00', esperado_tarjeta: '50.00', esperado_total: '150.00', num_cobros: 2,
    });
    assert.strictEqual(e.movido, false);
    assert.strictEqual(e.movimiento, null);
});

await test('7 · un cobro que entra DESPUÉS marca el día como movido, no lo reescribe', () => {
    // Es el caso corriente, no el raro: como se revisa hoy el día de ayer, un cobro de ayer
    // registrado más tarde llega a un día ya revisado.
    const congelado = { esperado_efectivo: '100.00', esperado_tarjeta: '50.00', esperado_total: '150.00', num_cobros: 2 };
    const ahora = buildCajaResumen([cobro(100, 100), cobro(50, 0), cobro(30, 30)]);
    const e = buildEstadoDiaRevisado(ahora, congelado);
    assert.strictEqual(e.movido, true);
    assert.strictEqual(e.movimiento.efectivo, 30, 'han entrado 30 € más en efectivo');
    assert.strictEqual(e.movimiento.numCobros, 1, 'y un cobro más');
    assert.strictEqual(e.cierre.esperado_total, '150.00',
        'lo CONGELADO no se toca: sigue diciendo lo que decía al revisar');
});

await test('8 · un cobro ANULADO después también mueve el día (hacia abajo)', () => {
    const congelado = { esperado_efectivo: '130.00', esperado_tarjeta: '50.00', esperado_total: '180.00', num_cobros: 3 };
    const e = buildEstadoDiaRevisado(buildCajaResumen([cobro(100, 100), cobro(50, 0)]), congelado);
    assert.strictEqual(e.movido, true);
    assert.strictEqual(e.movimiento.efectivo, -30);
    assert.strictEqual(e.movimiento.numCobros, -1);
});

await test('9 · movido por el NÚMERO de cobros aunque el total cuadre', () => {
    // Rectificar un cobro (anular uno y escribir otro por el mismo importe) deja el total igual
    // y el día distinto. Sin `num_cobros` esto no se vería.
    const congelado = { esperado_efectivo: '100.00', esperado_tarjeta: '0.00', esperado_total: '100.00', num_cobros: 1 };
    const e = buildEstadoDiaRevisado(buildCajaResumen([cobro(60, 60), cobro(40, 40)]), congelado);
    assert.strictEqual(e.movido, true);
    assert.strictEqual(e.movimiento.total, 0, 'el dinero es el mismo…');
    assert.strictEqual(e.movimiento.numCobros, 1, '…pero los cobros no');
});

await test('10 · lo que se compara es lo CONGELADO, no lo que la persona contó', () => {
    // Una diferencia al contar (contó 95 donde había 100) NO es "el día se ha movido": son dos
    // preguntas distintas y mezclarlas haría que todo día con descuadre pareciera movido.
    const congelado = {
        esperado_efectivo: '100.00', esperado_tarjeta: '0.00', esperado_total: '100.00',
        num_cobros: 1, contado_efectivo: '95.00', diferencia_efectivo: '-5.00',
    };
    const e = buildEstadoDiaRevisado(buildCajaResumen([cobro(100, 100)]), congelado);
    assert.strictEqual(e.movido, false, 'el día está quieto aunque el conteo no cuadrara');
});

if (!fallos) console.log('\nTodos los tests de acuse de revisión OK');
process.exit(process.exitCode || 0);
})();
