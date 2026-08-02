// Camino COMPLETO de una visita con varios servicios dada de alta desde el panel:
//
//   filas del formulario → joinServiceNames → POST/PUT (servicio + duracionMin)
//   → db.saveAppointment/updateAppointment → appointments.service + ends_at
//   → stampBillingSnapshot → informe de facturación
//   → y de vuelta: splitServiceNames reconstruye las MISMAS filas al reabrir la cita.
//
// Caso real que lo motivó (Paloma, 01/08/2026): Contouring + Matiz plus + K18 se registraba
// eligiendo UN servicio del desplegable y escribiendo el resto en Notas con el total a mano.
// La facturación no lee Notas, así que la cita se facturaba mal.
//
// Hermético: cliente Supabase falso inyectado por require-cache, cero red.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const path = require('path');

// ─── Cliente Supabase falso (mismo patrón que tests/db-contracts.test.js) ─────────────
function makeSupabaseMock() {
    const calls = [];
    let responder = () => ({ data: null, error: null });
    function makeBuilder() {
        const state = { table: null, op: null, payload: null, filters: [] };
        const resolve = () => { calls.push(state); return Promise.resolve(responder(state)); };
        const b = {
            from(t) { state.table = t; return b; },
            update(p) { state.op = 'update'; state.payload = p; return b; },
            insert(p) { state.op = 'insert'; state.payload = p; return b; },
            delete() { state.op = 'delete'; return b; },
            select() { return b; },
            eq(k, v) { state.filters.push(['eq', k, v]); return b; },
            neq(k, v) { state.filters.push(['neq', k, v]); return b; },
            is(k, v) { state.filters.push(['is', k, v]); return b; },
            in(k, v) { state.filters.push(['in', k, v]); return b; },
            gte() { return b; },
            lte() { return b; },
            order() { return b; },
            limit() { return b; },
            single() { return resolve(); },
            maybeSingle() { return resolve(); },
            then(onF, onR) { return resolve().then(onF, onR); },
        };
        return b;
    }
    return {
        client: { from(t) { return makeBuilder().from(t); } },
        calls,
        setResponder(fn) { responder = fn; },
        reset() { calls.length = 0; },
    };
}

const mock = makeSupabaseMock();
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: mock.client };

const db = require('../services/db');
const { computeServiceBilling, buildStylistBillingReport, buildFullServiceName } = require('../services/helpers');
const { splitServiceNames, joinServiceNames, catalogDurationTotal } = require(
    path.join(__dirname, '..', 'dashboard-app', 'src', 'lib', 'service-names.ts')
);

const CATALOGO = require('./fixtures/sante-catalog.json');
// Mismo shape que sirve /api/service-catalog (webhook.js), incluida la duración: es la que
// el formulario suma para derivar el campo "Duración".
const CAT_CLIENTE = CATALOGO.map(s => ({
    nombre: s.nombre,
    fullName: buildFullServiceName(s, CATALOGO),
    duracion: s.duracion ?? 60,
}));
const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// Las tres filas que la recepcionista elegiría en el desplegable para la cita de Paloma.
// El tercero es el K18 suelto, que tras la migración 026 se llama "Reconstrucción K18 +
// lavar y peinar": lleva " + " DENTRO del nombre, así que esta cita ejercita de paso la
// recomposición por longest match (3 filas, no 4).
const FILAS = ['Mechas Contouring', 'Matiz plus', 'Reconstrucción K18 + lavar y peinar'];
const SERVICE_STR = joinServiceNames(FILAS);
// Duración = suma, que es lo que ServiceListField manda como duracionMin.
const DURACION = FILAS.reduce((s, n) => s + Number(CATALOGO.find(c => c.nombre === n).duracion), 0);

async function test(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e.message); process.exitCode = 1; }
}
const callsTo = (table, op) => mock.calls.filter(c => c.table === table && c.op === op);

(async () => {
    await test('el formulario produce UN string con los 3 servicios unidos por " + "', () => {
        assert.strictEqual(SERVICE_STR, 'Mechas Contouring + Matiz plus + Reconstrucción K18 + lavar y peinar');
        assert.strictEqual(DURACION, 200 + 60 + 60);
    });

    await test('alta manual: UNA fila, service verbatim y ends_at = starts_at + suma', async () => {
        mock.reset();
        mock.setResponder((state) => {
            if (state.table === 'contacts') return { data: { id: 'c1', nombre: 'Paloma', telefono: '34600' }, error: null };
            // Guard de idempotencia: no hay cita previa a esa hora.
            if (state.table === 'appointments' && state.op === null) return { data: null, error: null };
            return { data: { id: 'apt-1', ...state.payload }, error: null };
        });

        const row = await db.saveAppointment(ORG, 'c1', {
            servicio: SERVICE_STR, fecha: '2026-08-01', hora: '10:30',
            duracionMin: DURACION, stylistId: 'st-1', source: 'manual',
        });

        const inserts = callsTo('appointments', 'insert');
        assert.strictEqual(inserts.length, 1, 'debe insertar UNA sola fila, no una por servicio');
        const p = inserts[0].payload;
        assert.strictEqual(p.service, SERVICE_STR, 'el service se guarda tal cual, sin trocear');
        const mins = (new Date(p.ends_at) - new Date(p.starts_at)) / 60000;
        assert.strictEqual(mins, DURACION, `ends_at debe cubrir ${DURACION} min, cubre ${mins}`);
        assert.strictEqual(row.id, 'apt-1');
    });

    await test('edición: PUT con fecha+hora+duracionMin recalcula ends_at con la nueva suma', async () => {
        mock.reset();
        mock.setResponder((state) => ({ data: { id: 'apt-1', ...state.payload }, error: null }));

        await db.updateAppointment(ORG, 'apt-1', {
            servicio: SERVICE_STR, fecha: '2026-08-01', hora: '10:30', duracionMin: DURACION,
        });

        const p = callsTo('appointments', 'update')[0].payload;
        assert.strictEqual(p.service, SERVICE_STR);
        assert.strictEqual((new Date(p.ends_at) - new Date(p.starts_at)) / 60000, DURACION);
    });

    await test('quitar un servicio acorta ends_at (no se queda con la duración vieja)', async () => {
        mock.reset();
        mock.setResponder((state) => ({ data: { id: 'apt-1', ...state.payload }, error: null }));

        const dosFilas = joinServiceNames(['Mechas Contouring', 'Matiz plus']);
        await db.updateAppointment(ORG, 'apt-1', {
            servicio: dosFilas, fecha: '2026-08-01', hora: '10:30', duracionMin: 200 + 60,
        });

        const p = callsTo('appointments', 'update')[0].payload;
        assert.strictEqual(p.service, dosFilas);
        assert.strictEqual((new Date(p.ends_at) - new Date(p.starts_at)) / 60000, 260);
    });

    await test('la facturación cobra los TRES servicios (285 €), no solo uno', () => {
        const { totalConIva, segments } = computeServiceBilling(SERVICE_STR, CATALOGO);
        assert.strictEqual(segments.length, 3);
        assert.ok(segments.every(s => s.status === 'ok'), 'los 3 deben resolver contra el catálogo');
        assert.strictEqual(totalConIva, 285);
        // Lo que se facturaba antes del formulario multi-servicio: solo el del desplegable.
        // K18 suelto (sin color asociado) = 60 €, distinto del complemento "Reconstrucción K18" (35 €).
        assert.strictEqual(computeServiceBilling('Reconstrucción K18 + lavar y peinar', CATALOGO).totalConIva, 60);
        assert.strictEqual(computeServiceBilling('Reconstrucción K18', CATALOGO).totalConIva, 35);
    });

    await test('al completar, el snapshot congela los 285 € (no el precio de un servicio suelto)', async () => {
        mock.reset();
        mock.setResponder((state) => {
            if (state.table === 'agent_configs') return { data: { services: CATALOGO }, error: null };
            if (state.table === 'appointments' && state.op === null) {
                return { data: [{ id: 'apt-1', service: SERVICE_STR, facturado_at: null, stylists: { name: 'Irina' } }], error: null };
            }
            return { data: null, error: null };
        });

        const n = await db.stampBillingSnapshot(ORG, ['apt-1']);
        assert.strictEqual(n, 1);
        const p = callsTo('appointments', 'update')[0].payload;
        assert.strictEqual(p.precio_facturado, 285);
        assert.strictEqual(p.stylist_name_facturado, 'Irina');
    });

    await test('el informe muestra la cita a 270 € y sin "revisar"', () => {
        const report = buildStylistBillingReport([{
            appointment_id: 'apt-1', service: SERVICE_STR, stylist_id: 'st-1', stylist_name: 'Irina',
            starts_at: '2026-08-01T08:30:00.000Z', cliente: 'Paloma',
            precio_facturado: 270, iva_rate: 0.21, facturado_at: '2026-08-01T12:00:00.000Z',
        }], CATALOGO);
        assert.strictEqual(report.totales.totalConIva, 270);
        assert.strictEqual(report.sinCalcularTotal, 0);
        assert.strictEqual(report.estilistas[0].citas[0].calculable, true);
    });

    await test('reabrir la cita reconstruye las MISMAS 3 filas del formulario', () => {
        assert.deepStrictEqual(splitServiceNames(SERVICE_STR, CAT_CLIENTE), FILAS);
    });

    // ─── Reabrir la cita: el campo "Duración" se DERIVA, no se hereda de la BD ────────────
    // La cita de Paloma quedó en la BD con ends_at a 60 min (starts 10:30 → 11:30) pese a
    // llevar tres servicios. Al reabrirla, el resumen decía "3 servicios · 320 min" pero el
    // campo Duración seguía enseñando ese 60, y Guardar mandaba 60: la cita se registraba
    // como cinco horas más corta de lo que dura. Estas pruebas fijan que la duración sale
    // siempre de los servicios, no del ends_at guardado.
    const duracionMostrada = (servicio, manual) => {
        const derivada = catalogDurationTotal(servicio, CAT_CLIENTE);
        return derivada != null ? String(derivada) : manual;
    };

    await test('reabrir la cita de Paloma: el campo Duración enseña 320, no el 60 de la BD', () => {
        // `manual` = lo que formFromReserva saca de starts_at/ends_at de la fila real.
        assert.strictEqual(duracionMostrada(SERVICE_STR, '60'), '320');
        assert.strictEqual(catalogDurationTotal(SERVICE_STR, CAT_CLIENTE), DURACION);
    });

    await test('guardar sin tocar nada reescribe ends_at con los 320 min', async () => {
        mock.reset();
        mock.setResponder((state) => ({ data: { id: 'apt-1', ...state.payload }, error: null }));

        // Exactamente el PUT que manda el sheet: duracionMin = duración derivada.
        await db.updateAppointment(ORG, 'apt-1', {
            servicio: SERVICE_STR, fecha: '2026-08-01', hora: '10:30',
            duracionMin: parseInt(duracionMostrada(SERVICE_STR, '60')),
        });

        const p = callsTo('appointments', 'update')[0].payload;
        const mins = (new Date(p.ends_at) - new Date(p.starts_at)) / 60000;
        assert.strictEqual(mins, DURACION, `ends_at debe cubrir ${DURACION} min, cubre ${mins}`);
    });

    await test('quitar un servicio al reabrir baja la duración mostrada en el acto', () => {
        assert.strictEqual(duracionMostrada(joinServiceNames(['Mechas Contouring', 'Matiz plus']), '320'), '260');
        assert.strictEqual(duracionMostrada('Reconstrucción K18 + lavar y peinar', '320'), '60');
        assert.strictEqual(duracionMostrada('Reconstrucción K18', '320'), '15');
    });

    await test('sin suma fiable NO se inventa duración: manda el valor manual', () => {
        // Texto libre: el campo se rehabilita y conserva lo que hubiera.
        assert.strictEqual(catalogDurationTotal('Peinado de novia a domicilio', CAT_CLIENTE), null);
        assert.strictEqual(duracionMostrada('Peinado de novia a domicilio', '90'), '90');
        // Mezcla de catálogo y texto libre: tampoco hay total, no se guarda una suma parcial.
        assert.strictEqual(catalogDurationTotal(joinServiceNames(['Reconstrucción K18', 'Algo raro']), CAT_CLIENTE), null);
        // Catálogo aún cargando (fetch en vuelo): null, y el campo se queda con el valor de
        // la BD en lugar de enseñar un 0 o un parcial.
        assert.strictEqual(catalogDurationTotal(SERVICE_STR, []), null);
        // Cita vacía / San Remo.
        assert.strictEqual(catalogDurationTotal('', CAT_CLIENTE), null);
    });

    await test('nombre ambiguo del catálogo: no se resuelve por el nombre crudo', () => {
        // "Largo" existe en varias categorías con duraciones distintas (120, 240, 300, 360);
        // elegir una al azar daría un número plausible y equivocado. Sin el nombre completo
        // (buildFullServiceName) no hay suma, y el campo se deja editable.
        const ambiguos = CATALOGO.filter(s => String(s.nombre).trim().toLowerCase() === 'largo');
        assert.ok(ambiguos.length > 1, 'el catálogo real debe tener "Largo" repetido');
        assert.ok(new Set(ambiguos.map(s => s.duracion)).size > 1, 'y con duraciones distintas');
        assert.strictEqual(catalogDurationTotal('Largo', CAT_CLIENTE), null);
    });

    await test('un servicio con " + " en el nombre no se trocea al reabrir', () => {
        const s = joinServiceNames(['Pedicura + esmaltado', 'Reconstrucción K18']);
        assert.deepStrictEqual(splitServiceNames(s, CAT_CLIENTE), ['Pedicura + esmaltado', 'Reconstrucción K18']);
        assert.strictEqual(computeServiceBilling(s, CATALOGO).segments.length, 2);
        // Dos nombres con " + " dentro en el mismo string: el longest match debe recomponer
        // los dos, no trocearlos en cuatro.
        const s2 = joinServiceNames(['Pedicura + esmaltado', 'Reconstrucción K18 + lavar y peinar']);
        assert.deepStrictEqual(splitServiceNames(s2, CAT_CLIENTE), ['Pedicura + esmaltado', 'Reconstrucción K18 + lavar y peinar']);
        assert.strictEqual(computeServiceBilling(s2, CATALOGO).segments.length, 2);
    });

    await test('San Remo (catálogo vacío) no se ve afectado: el texto libre pasa entero', () => {
        assert.deepStrictEqual(splitServiceNames('Reserva mesa terraza', []), ['Reserva mesa terraza']);
        // Sin catálogo no hay longest match, pero tampoco hay formulario multi-servicio
        // (ServiceListField está detrás de isSalon) — el string se guarda tal cual.
        assert.deepStrictEqual(splitServiceNames('Cena aniversario', []), ['Cena aniversario']);
    });

    if (!process.exitCode) console.log('\nTodos los tests de cita multi-servicio OK');
    process.exit(process.exitCode || 0);
})();
