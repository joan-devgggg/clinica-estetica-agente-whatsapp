// De quién es una venta (migración 038). Fase 2·B.
//
// La dueña quiere ver "la venta de cada clienta". Hasta ahora, una VENTA SIN CITA no podía
// decir de quién era: `cobros` llegaba al contacto por `appointment_id → appointments.
// contact_id`, y en una venta suelta no hay cita. El champú que se llevaba una clienta conocida
// quedaba como texto libre en `concepto`, sin relación con su ficha.
//
// Lo que se afirma aquí:
//   · la clienta la decide UN resolutor, no dos columnas peleando;
//   · con cita, `contact_id` NO se guarda (si se guardaran las dos, acabarían discrepando);
//   · una clienta de OTRA organización no se puede atar a un cobro de esta;
//   · rectificar hereda de quién era la venta;
//   · `contact_id` está en la proyección: sin eso se escribiría y no se podría leer.
//
// El doble de Supabase APLICA los `.eq()`, que es lo que hace válido el test de multi-tenancy:
// uno que los ignorara devolvería la clienta de la otra org y el test pasaría con la guarda
// rota — la trampa de los dobles que no respetan el contrato.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const assert = require('assert');

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const OTRA_ORG = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── Supabase falso que SÍ filtra ────────────────────────────────────────────
const filas = {
    stylists: [{ id: 'est-1', organization_id: ORG, name: 'Olga' }],
    contacts: [
        { id: 'cli-1', organization_id: ORG, full_name: 'Ana' },
        { id: 'cli-ajena', organization_id: OTRA_ORG, full_name: 'De otro salón' },
    ],
    cobros: [],
};
let ultimoInsert = null;

function builder(tabla) {
    const filtros = [];
    let op = 'select';
    let payload = null;
    const resolver = () => {
        if (op === 'insert') { ultimoInsert = payload; return { data: [{ id: 'cobro-nuevo', ...payload }], error: null }; }
        const base = filas[tabla] ?? [];
        const datos = base.filter((f) => filtros.every(([col, val]) => f[col] === val));
        return { data: datos, error: null };
    };
    const b = {
        select() { return b; },
        insert(p) { op = 'insert'; payload = p; return b; },
        update(p) { op = 'update'; payload = p; return b; },
        eq(col, val) { filtros.push([col, val]); return b; },
        is() { return b; }, in() { return b; }, gte() { return b; }, lte() { return b; }, order() { return b; },
        maybeSingle() { const r = resolver(); return Promise.resolve({ data: r.data[0] ?? null, error: null }); },
        single() { return b.maybeSingle(); },
        then(onF, onR) { return Promise.resolve(resolver()).then(onF, onR); },
    };
    return b;
}
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from: (t) => builder(t) },
};

const db = require('../services/db');
const { resolveClienteDelCobro } = require('../services/helpers');

let fallos = 0;
async function test(nombre, fn) {
    ultimoInsert = null;
    try { await fn(); console.log(`ok - ${nombre}`); }
    catch (e) { console.error(`fail - ${nombre}`); console.error(e.message); fallos++; process.exitCode = 1; }
}

(async () => {

// ── El resolutor: una sola respuesta ────────────────────────────────────────

await test('1 · la venta suelta dice de quién es por su propia columna', () => {
    assert.strictEqual(resolveClienteDelCobro({ contact_id: 'cli-1' }), 'cli-1');
});

await test('2 · con cita y sin columna, la clienta sale de la CITA', () => {
    assert.strictEqual(resolveClienteDelCobro({ contact_id: null }, { contact_id: 'cli-2' }), 'cli-2');
});

await test('3 · si las dos existen manda lo que se escribió en el cobro', () => {
    // No debería pasar (createCobro no las deja convivir), y justo por eso la precedencia
    // tiene que estar declarada: para filas viejas o escritas por otra vía.
    assert.strictEqual(resolveClienteDelCobro({ contact_id: 'cli-1' }, { contact_id: 'cli-2' }), 'cli-1');
});

await test('4 · sin ninguna de las dos, null — no se inventa una clienta', () => {
    assert.strictEqual(resolveClienteDelCobro({ contact_id: null }, null), null);
    assert.strictEqual(resolveClienteDelCobro(null, null), null);
});

// ── La escritura ────────────────────────────────────────────────────────────

await test('5 · venta SIN cita con clienta: se guarda contact_id', async () => {
    await db.createCobro(ORG, {
        contactId: 'cli-1', concepto: 'Champú K18', metodo: 'efectivo', importeTotal: 20,
    });
    assert.strictEqual(ultimoInsert.contact_id, 'cli-1');
    assert.strictEqual(ultimoInsert.appointment_id, null);
});

await test('6 · CON cita, contact_id NO se guarda (una sola fuente)', async () => {
    await db.createCobro(ORG, {
        appointmentId: 'apt-1', contactId: 'cli-1', metodo: 'tarjeta', importeTotal: 50,
    });
    assert.strictEqual(ultimoInsert.contact_id, null,
        'con cita la clienta sale de la cita; guardar las dos es tener dos verdades');
});

await test('7 · venta suelta sin clienta: null, y se registra igual', async () => {
    await db.createCobro(ORG, { concepto: 'Producto', metodo: 'efectivo', importeTotal: 12 });
    assert.strictEqual(ultimoInsert.contact_id, null);
    assert.strictEqual(Number(ultimoInsert.importe_total), 12, 'entra gente de paso: no se bloquea');
});

await test('8 · una clienta de OTRA organización no se puede atar a este cobro', async () => {
    // La FK sola no protege de esto: garantiza que el contacto existe, no que sea de este
    // salón. Sin la comprobación explícita, el dinero de aquí quedaría atado a una ficha de allí.
    await assert.rejects(
        () => db.createCobro(ORG, {
            contactId: 'cli-ajena', concepto: 'Champú', metodo: 'efectivo', importeTotal: 20,
        }),
        /no existe en esta organización/,
    );
});

await test('9 · una clienta que no existe tampoco cuela', async () => {
    await assert.rejects(
        () => db.createCobro(ORG, {
            contactId: 'cli-fantasma', concepto: 'Champú', metodo: 'efectivo', importeTotal: 20,
        }),
        /no existe en esta organización/,
    );
});

// ── Lectura y rectificación ─────────────────────────────────────────────────

await test('10 · contact_id está en la proyección: se escribe Y se puede leer', () => {
    // Sin esto la columna sería un dato escrito e invisible, que es de los fallos más caros
    // de detectar: nada falla, simplemente la respuesta nunca trae el campo.
    const cols = require('../services/db')._internals?.COBRO_COLUMNS;
    const fuente = require('fs').readFileSync(require.resolve('../services/db'), 'utf8');
    const linea = fuente.slice(fuente.indexOf('const COBRO_COLUMNS'), fuente.indexOf('const COBRO_COLUMNS') + 400);
    assert.ok((cols || linea).includes('contact_id'),
        'COBRO_COLUMNS tiene que traer contact_id o la venta no sabrá decir de quién es');
});

await test('11 · rectificar hereda de quién era la venta', async () => {
    filas.cobros = [{
        id: 'cobro-viejo', organization_id: ORG, estado: 'vigente', appointment_id: null,
        contact_id: 'cli-1', concepto: 'Champú K18', metodo: 'efectivo',
        importe_total: '20.00', importe_efectivo: '20.00', fecha_caja: '2026-08-07',
        cobrado_por: null, importe_referencia: null, motivo_diferencia: null,
    }];
    await db.rectifyCobro(ORG, 'cobro-viejo', { importeTotal: 25, motivoCorreccion: 'mal tecleado' });
    assert.strictEqual(ultimoInsert.contact_id, 'cli-1',
        'corregir un importe no cambia a quién se le vendió');
    assert.strictEqual(ultimoInsert.corrige_a, 'cobro-viejo');
});

if (!fallos) console.log('\nTodos los tests de cliente del cobro OK');
process.exit(process.exitCode || 0);
})();
