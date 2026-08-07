// Registro de caja (migración 035). Fase 1 del cierre de caja, 07/08/2026.
//
// Lo que se afirma aquí es lo que NO se puede comprobar mirando la pantalla:
//   · el día de caja es el de MADRID (entre las 00:00 y las 02:00 el día UTC es el anterior,
//     y un cobro mal fechado descuadra DOS cierres a la vez);
//   · el importe de referencia sale de la MISMA precedencia que pinta Facturación;
//   · las sumas de caja salen de la VISTA cobros_vigentes y de ningún otro sitio;
//   · rectificar hereda la fecha del original (corregir hoy un cobro de ayer es de AYER);
//   · anular no toca ni una columna de importe.
//
// Los CHECK y el trigger que congelan la fila viven en Postgres y se probaron contra la BD real
// al aplicar la migración; aquí se prueba lo que decide el código.
// Hermético: Supabase falso por require-cache, cero red.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const assert = require('assert');

let fallos = 0;
async function test(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e.message); fallos++; process.exitCode = 1; }
}

// ─── Supabase falso ──────────────────────────────────────────────────────────
const llamadas = [];
let filasPorTabla = {};

function builder(tabla) {
    const q = { tabla, op: 'select', payload: null };
    const run = () => {
        llamadas.push({ ...q });
        if (q.op === 'insert') return { data: [{ id: 'cobro-nuevo', ...q.payload }], error: null };
        if (q.op === 'update') return { data: [{ id: 'cobro-1', ...q.payload }], error: null };
        return { data: filasPorTabla[q.tabla] ?? [], error: null };
    };
    const b = {
        select() { return b; },
        insert(p) { q.op = 'insert'; q.payload = p; return b; },
        update(p) { q.op = 'update'; q.payload = p; return b; },
        delete() { q.op = 'delete'; return b; },
        eq() { return b; }, is() { return b; }, in() { return b; },
        gte() { return b; }, lte() { return b; }, order() { return b; },
        maybeSingle() {
            const r = run();
            return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error });
        },
        single() { return b.maybeSingle(); },
        then(onF, onR) { return Promise.resolve(run()).then(onF, onR); },
    };
    return b;
}

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from: (t) => builder(t) },
};

const db = require('../services/db');
const {
    normalizeCobroImportes, resolveImporteReferencia, resolveBillingAmount,
} = require('../services/helpers');
const { toLocalDateStr } = require('../services/date-utils');

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const ultima = (tabla, op) => [...llamadas].reverse().find(c => c.tabla === tabla && (!op || c.op === op));

(async () => {

// ── 1. El día de caja es el de Madrid, no el de UTC ─────────────────────────
await test('1 · un instante de las 00:30 de Madrid es del día de Madrid, no del día UTC', () => {
    // 2026-08-07T22:30:00Z = 08/08 00:30 en Madrid (UTC+2 en verano).
    const instante = new Date('2026-08-07T22:30:00Z');
    assert.strictEqual(toLocalDateStr(instante), '2026-08-08', 'el día de caja debe ser el de Madrid');
    assert.strictEqual(instante.toISOString().slice(0, 10), '2026-08-07',
        'control: el atajo UTC habría fechado el cobro un día antes');
});

await test('2 · diaDeCajaHoy() nunca usa el atajo de toISOString', () => {
    // No se puede fijar `now`, así que se afirma la propiedad: el día de caja coincide con el
    // que da la TZ del negocio. Si alguien cambiara la implementación a UTC, esto falla en la
    // franja 00:00–02:00, que es justo cuando importa.
    assert.strictEqual(db.diaDeCajaHoy(), toLocalDateStr(new Date()));
    assert.match(db.diaDeCajaHoy(), /^\d{4}-\d{2}-\d{2}$/);
});

// ── 2. El reparto efectivo/tarjeta ──────────────────────────────────────────
await test('3 · el efectivo se DERIVA del método: la estilista no teclea el importe de tarjeta', () => {
    assert.deepStrictEqual(normalizeCobroImportes({ metodo: 'efectivo', importeTotal: 50 }),
        { importe_total: 50, importe_efectivo: 50 });
    assert.deepStrictEqual(normalizeCobroImportes({ metodo: 'tarjeta', importeTotal: 50 }),
        { importe_total: 50, importe_efectivo: 0 });
    assert.deepStrictEqual(normalizeCobroImportes({ metodo: 'bizum', importeTotal: 50 }),
        { importe_total: 50, importe_efectivo: 0 });
    assert.deepStrictEqual(normalizeCobroImportes({ metodo: 'mixto', importeTotal: 50, importeEfectivo: 20 }),
        { importe_total: 50, importe_efectivo: 20 });
});

await test('4 · un cobro de 0 € (cortesía) es válido, no "sin importe"', () => {
    assert.deepStrictEqual(normalizeCobroImportes({ metodo: 'efectivo', importeTotal: 0 }),
        { importe_total: 0, importe_efectivo: 0 });
});

await test('5 · un "mixto" que no lo es se rechaza en vez de guardarse mintiendo', () => {
    assert.throws(() => normalizeCobroImportes({ metodo: 'mixto', importeTotal: 50, importeEfectivo: 50 }), /entre 0 y el total/);
    assert.throws(() => normalizeCobroImportes({ metodo: 'mixto', importeTotal: 50, importeEfectivo: 0 }), /entre 0 y el total/);
    assert.throws(() => normalizeCobroImportes({ metodo: 'mixto', importeTotal: 50 }), /cuánto se pagó en efectivo/);
    assert.throws(() => normalizeCobroImportes({ metodo: 'transferencia', importeTotal: 50 }), /Método de cobro inválido/);
    assert.throws(() => normalizeCobroImportes({ metodo: 'efectivo', importeTotal: -1 }), /Importe inválido/);
});

// ── 3. El importe de referencia sale de Facturación, no de una copia ────────
const CATALOGO = [
    { nombre: 'Corte hombre', precio: 25 },
    { nombre: 'Color raíz', precio: 70 },
];

await test('6 · la referencia es lo que Facturación diría por esa cita', () => {
    // Congelado manda sobre el recálculo.
    assert.strictEqual(
        resolveImporteReferencia({ service: 'Corte hombre', precio_facturado: 22, facturado_at: 'x', servicio_facturado: 'Corte hombre' }, CATALOGO),
        22);
    // Manual manda sobre el congelado.
    assert.strictEqual(
        resolveImporteReferencia({ service: 'Corte hombre', precio_facturado: 22, facturado_at: 'x', precio_manual: 30, servicio_facturado: 'Corte hombre' }, CATALOGO),
        30);
    // Sin snapshot, se recalcula del catálogo.
    assert.strictEqual(resolveImporteReferencia({ service: 'Corte hombre' }, CATALOGO), 25);
});

await test('7 · una cita sin servicio resoluble NO tiene referencia: es null, no un 0 inventado', () => {
    // Es el caso de las 3 "Cita manual" de Sante. Un 0 aquí las metería en el descuadre
    // como si se hubiera cobrado de menos; null las deja fuera, que es lo correcto.
    assert.strictEqual(resolveImporteReferencia({ service: 'Cita manual' }, CATALOGO), null);
    assert.strictEqual(resolveImporteReferencia({ service: '' }, CATALOGO), null);
});

await test('8 · un facturado_at sin precio NO es snapshot (no vale como referencia 0)', () => {
    const r = resolveBillingAmount({ service: 'Cita manual', facturado_at: 'x', precio_facturado: null }, CATALOGO);
    assert.strictEqual(r.origen, 'sin_calcular');
    assert.strictEqual(resolveImporteReferencia({ service: 'Cita manual', facturado_at: 'x', precio_facturado: null }, CATALOGO), null);
});

// ── 4. La capa de datos ─────────────────────────────────────────────────────
await test('9 · createCobro congela el nombre de la estilista y fecha en Madrid', async () => {
    filasPorTabla = { stylists: [{ name: 'Natalia' }] };
    llamadas.length = 0;
    await db.createCobro(ORG, {
        appointmentId: 'apt-1', cobradoPor: 'est-1', metodo: 'efectivo', importeTotal: 25,
        importeReferencia: 25, userId: 'user-1',
    });
    const ins = ultima('cobros', 'insert');
    assert.ok(ins, 'debe insertar en cobros');
    assert.strictEqual(ins.payload.cobrado_por_nombre, 'Natalia', 'el nombre se congela al escribir');
    assert.strictEqual(ins.payload.fecha_caja, toLocalDateStr(new Date()));
    assert.strictEqual(ins.payload.importe_efectivo, 25);
    assert.strictEqual(ins.payload.registrado_por, 'user-1');
});

await test('10 · las sumas de caja salen de la VISTA cobros_vigentes, no de la tabla', async () => {
    filasPorTabla = { cobros_vigentes: [] };
    llamadas.length = 0;
    await db.getCobrosVigentes(ORG, { desde: '2026-08-07', hasta: '2026-08-07' });
    assert.ok(ultima('cobros_vigentes'), 'debe leer la vista');
    assert.ok(!llamadas.some(c => c.tabla === 'cobros'),
        'NO puede leer la tabla y filtrar a mano: el invariante "vigente y sin sucesor" vive en la vista');
});

await test('11 · el histórico SÍ lee la tabla: es justo lo que la vista esconde', async () => {
    filasPorTabla = { cobros: [] };
    llamadas.length = 0;
    await db.getCobrosHistorial(ORG, { desde: '2026-08-01', hasta: '2026-08-07' });
    assert.ok(ultima('cobros'), 'el histórico lee la tabla');
});

await test('12 · rectificar hereda la fecha de caja del ORIGINAL, no la de hoy', async () => {
    // Corregir hoy un cobro de ayer pertenece a la caja de AYER. Si se recalculara a hoy, la
    // corrección movería dinero de un día cerrado a otro y descuadraría los dos.
    filasPorTabla = {
        cobros: [{
            id: 'cobro-viejo', estado: 'vigente', fecha_caja: '2026-08-05',
            appointment_id: 'apt-1', cobrado_por: 'est-1', metodo: 'efectivo',
            importe_total: '25.00', importe_efectivo: '25.00', importe_referencia: '25.00',
            concepto: null, motivo_diferencia: null,
        }],
        stylists: [{ name: 'Natalia' }],
    };
    llamadas.length = 0;
    await db.rectifyCobro(ORG, 'cobro-viejo', { importeTotal: 30, motivoCorreccion: 'cobré 30', userId: 'u1' });
    const ins = ultima('cobros', 'insert');
    assert.strictEqual(ins.payload.fecha_caja, '2026-08-05', 'la rectificación es del día del original');
    assert.strictEqual(ins.payload.corrige_a, 'cobro-viejo', 'el sucesor apunta al anterior: es su anulación');
    assert.strictEqual(ins.payload.importe_total, 30);
    assert.strictEqual(ins.payload.motivo_correccion, 'cobré 30');
});

await test('13 · rectificar es UNA escritura: no hay UPDATE sobre el original', async () => {
    filasPorTabla = {
        cobros: [{ id: 'c1', estado: 'vigente', fecha_caja: '2026-08-05', metodo: 'efectivo',
                   importe_total: '25.00', importe_efectivo: '25.00', concepto: 'x' }],
        stylists: [],
    };
    llamadas.length = 0;
    await db.rectifyCobro(ORG, 'c1', { importeTotal: 30, motivoCorreccion: 'x' });
    const updates = llamadas.filter(c => c.tabla === 'cobros' && c.op === 'update');
    assert.strictEqual(updates.length, 0,
        'anular el original en un segundo UPDATE deja un estado roto si falla: el sucesor ES la anulación');
});

await test('14 · rectificar sin motivo no escribe nada', async () => {
    filasPorTabla = { cobros: [{ id: 'c1', estado: 'vigente', metodo: 'efectivo', importe_total: '25.00', importe_efectivo: '25.00', concepto: 'x' }] };
    llamadas.length = 0;
    await assert.rejects(() => db.rectifyCobro(ORG, 'c1', { importeTotal: 30 }), /por qué/);
    assert.ok(!llamadas.some(c => c.tabla === 'cobros' && c.op === 'insert'));
});

await test('15 · anular no toca NINGUNA columna de importe', async () => {
    filasPorTabla = { cobros: [] };
    llamadas.length = 0;
    await db.anularCobro(ORG, 'c1', { motivo: 'no se llegó a cobrar', userId: 'u1' });
    const upd = ultima('cobros', 'update');
    assert.ok(upd, 'debe hacer UPDATE');
    const prohibidas = ['importe_total', 'importe_efectivo', 'metodo', 'fecha_caja', 'cobrado_por', 'iva_rate', 'corrige_a'];
    for (const col of prohibidas) {
        assert.ok(!(col in upd.payload), `anular no puede tocar ${col} — el trigger de la 035 lo rechazaría`);
    }
    assert.strictEqual(upd.payload.estado, 'anulado');
    assert.ok(upd.payload.anulado_at, 'un anulado sabe cuándo lo anularon');
});

console.log(fallos === 0 ? '\n✅ Registro de caja OK' : `\n❌ ${fallos} fallo(s)`);
})();
