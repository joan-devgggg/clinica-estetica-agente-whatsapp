// Errores de lectura en el camino de disponibilidad de Sante.
//
// El fallo real (auditoría 28/07/2026): las cinco lecturas que alimentan el motor de
// huecos hacían `const { data } = await supabase…; return data || []`, descartando
// `error`. Consecuencias, ambas vistas o reproducidas:
//   · un timeout/RLS se convertía en "no hay huecos" → cita perdida, y el LLM anunciaba
//     una avería técnica y escalaba (le pasó a una clienta real con la agenda vacía);
//   · si la que fallaba era la lectura de CITAS, el motor creía que la agenda estaba
//     vacía y ofrecía huecos YA RESERVADOS → doble reserva.
// Y `getAgentConfig` además CACHEABA el null 60 s, dejando a toda la org sin catálogo.
//
// Hermético: Supabase falso inyectado en require.cache, cero red.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');

// ─── Supabase falso: falla o responde según la tabla ─────────────────────────────────
const control = { failTables: new Set(), rows: {} };

function makeBuilder(tabla) {
    const run = () => (control.failTables.has(tabla)
        ? { data: null, error: { code: 'PGRST301', message: `simulated failure on ${tabla}` } }
        : { data: control.rows[tabla] ?? [], error: null });
    const b = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'then') return (onF, onR) => Promise.resolve(run()).then(onF, onR);
            if (prop === 'maybeSingle' || prop === 'single') {
                return () => ({ then: (onF, onR) => Promise.resolve(run()).then(onF, onR) });
            }
            return () => b;   // select/eq/neq/gte/lte/or/order… encadenan
        },
    });
    return b;
}

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from: (t) => makeBuilder(t) },
};

const db = require('../services/db');
const calendarSante = require('../services/calendar-sante');

// Cuántos días hay que tapar para que la agenda esté LLENA de verdad. Sale del horizonte del
// motor, jamás de un número escrito aquí: el fixture tiene que seguir al horizonte solo, o
// vuelve a caducar en silencio la próxima vez que se mueva. El +2 es el margen de los bordes
// (el bucle arranca en «ayer» y el recorrido acaba en dia(horizonte)).
const DIAS_A_TAPAR = calendarSante.HORIZONTE_DIAS_DEFAULT + 2;

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
let pass = 0;
function test(nombre, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { pass++; console.log(`ok - ${nombre}`); })
        .catch(e => { console.error(`fail - ${nombre}\n    ${e.message}`); process.exitCode = 1; });
}

async function lanza(fn, etiqueta) {
    try { await fn(); }
    catch { return; }
    throw new Error(`${etiqueta}: debería haber lanzado y no lanzó`);
}

(async () => {
    // ─── 1. Las cinco lecturas propagan el error en vez de devolver [] ────────────────
    const lecturas = [
        ['stylists', () => db.getStylistsByOrg(ORG)],
        ['stylist_schedules', () => db.getStylistSchedule(ORG, 'sty-1')],
        ['schedule_blocks', () => db.getScheduleBlocks(ORG, 'sty-1', '2026-07-01', '2026-07-31')],
        ['blocked_days', () => db.getBlockedDays(ORG, { from: '2026-07-01', to: '2026-07-31' })],
        ['appointments', () => db.getAppointmentsByStylistAndRange(ORG, 'sty-1', '2026-07-01T00:00:00Z', '2026-07-31T00:00:00Z')],
    ];
    for (const [tabla, call] of lecturas) {
        await test(`${tabla}: un error de Supabase LANZA, no devuelve []`, async () => {
            control.failTables = new Set([tabla]);
            await lanza(call, tabla);
            // Y sin error, sigue devolviendo la lista normal.
            control.failTables = new Set();
            const res = await call();
            assert(Array.isArray(res), `${tabla}: sin error debe devolver un array`);
        });
    }

    // ─── 2. El caso peligroso: nunca disponibilidad fantasma ──────────────────────────
    await test('lectura de citas caída → getAvailableSlots lanza (nunca ofrece huecos sin verificar)', async () => {
        control.rows = {
            stylists: [{ id: 'sty-1', name: 'Irina', active: true, skills: ['Cortes'] }],
            stylist_schedules: [0, 1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d, start_time: '10:00:00', end_time: '19:00:00' })),
            blocked_days: [], schedule_blocks: [], appointments: [],
        };
        control.failTables = new Set(['appointments']);
        await lanza(
            () => calendarSante.getAvailableSlots(ORG, { serviceDuration: 60, serviceCategory: 'Cortes' }),
            'getAvailableSlots con appointments caído');
    });

    // ─── 3. Causa explícita del cero (para no comunicarlo como avería) ────────────────
    await test('cero por agenda llena → causa "agenda_llena", no un [] pelado', async () => {
        control.failTables = new Set();
        // El motor agrupa las citas por su fecha de INICIO, así que hace falta una cita por
        // día: una sola cita larguísima solo taparía el día en que empieza.
        //
        // Y hacen falta TODAS las del horizonte, contadas desde la constante y nunca a mano:
        // aquí había un 20 escrito, que tapaba de sobra los 14 días de entonces y dejó de
        // tapar nada el 20/08/2026, cuando el horizonte pasó a 90. Un fixture que cubre
        // menos que el horizonte no falla diciendo «faltan días»: dice «la causa no es
        // agenda_llena», que manda a buscar el bug al sitio equivocado.
        const hoy = new Date();
        control.rows.appointments = Array.from({ length: DIAS_A_TAPAR }, (_, i) => {
            const d = new Date(hoy.getTime() + (i - 1) * 86400000).toISOString().slice(0, 10);
            return {
                id: `a${i}`, stylist_id: 'sty-1', status: 'confirmed', service: 'x',
                starts_at: `${d}T05:00:00.000Z`, ends_at: `${d}T21:00:00.000Z`,
            };
        });
        const slots = await calendarSante.getAvailableSlots(ORG, { serviceDuration: 60, serviceCategory: 'Cortes' });
        assert.strictEqual(slots.length, 0, 'la agenda está tapada: no debe haber huecos');
        assert.strictEqual(slots.causa, 'agenda_llena', `causa esperada agenda_llena, recibida ${slots.causa}`);
    });

    await test('cero por servicio que no cabe en la jornada → causa "no_cabe_antes_del_cierre"', async () => {
        control.rows.appointments = [];
        const slots = await calendarSante.getAvailableSlots(ORG, { serviceDuration: 600, serviceCategory: 'Cortes' });
        assert.strictEqual(slots.length, 0);
        assert.strictEqual(slots.causa, 'no_cabe_antes_del_cierre', `recibida ${slots.causa}`);
    });

    await test('un servicio que cabe CLAVADO en la jornada no se diagnostica como «no cabe»', async () => {
        // La jornada es 10:00–19:00 (540'). Un servicio de 540' cabe exacto y desde el
        // arreglo de D3 el motor SÍ lo ofrece. `diagnosticarCero` tiene que medir con el
        // mismo criterio: con el `<` estricto que tenía, si además la agenda estuviera llena
        // la clienta oiría «no cabe en la jornada» cuando lo cierto es «está todo cogido».
        control.rows.appointments = [];
        const cabe = await calendarSante.getAvailableSlots(ORG, { serviceDuration: 540, serviceCategory: 'Cortes' });
        assert.ok(cabe.length > 0, 'un servicio que cabe clavado tiene que dar hueco (D3)');
        assert.strictEqual(cabe.causa, null);

        // Y ahora el mismo servicio con la agenda tapada: la causa es agenda_llena.
        const hoy = new Date();
        control.rows.appointments = Array.from({ length: DIAS_A_TAPAR }, (_, i) => {
            const d = new Date(hoy.getTime() + (i - 1) * 86400000).toISOString().slice(0, 10);
            return {
                id: `b${i}`, stylist_id: 'sty-1', status: 'confirmed', service: 'x',
                starts_at: `${d}T05:00:00.000Z`, ends_at: `${d}T21:00:00.000Z`,
            };
        });
        const lleno = await calendarSante.getAvailableSlots(ORG, { serviceDuration: 540, serviceCategory: 'Cortes' });
        assert.strictEqual(lleno.length, 0);
        assert.strictEqual(lleno.causa, 'agenda_llena',
            `el diagnóstico mide con otro criterio que el motor: recibida ${lleno.causa}`);
        control.rows.appointments = [];   // los bloques de abajo cuentan con la agenda vacía
    });

    await test('cero por categoría sin estilista → causa "sin_skill"', async () => {
        const slots = await calendarSante.getAvailableSlots(ORG, { serviceDuration: 60, serviceCategory: 'Categoria Inexistente' });
        assert.strictEqual(slots.causa, 'sin_skill', `recibida ${slots.causa}`);
    });

    await test('con huecos disponibles la causa es null', async () => {
        const slots = await calendarSante.getAvailableSlots(ORG, { serviceDuration: 60, serviceCategory: 'Cortes' });
        assert(slots.length > 0, 'con horario abierto y sin citas debe haber huecos');
        assert.strictEqual(slots.causa, null, 'no debe haber causa cuando sí hay huecos');
    });

    // ─── 4. getAgentConfig no cachea el fallo ─────────────────────────────────────────
    await test('getAgentConfig NO cachea un fallo: reintenta y recupera en la llamada siguiente', async () => {
        const ORG_X = '00000000-0000-4000-8000-0000000000ff';   // org virgen: sin entrada en caché
        control.failTables = new Set(['agent_configs']);
        const durante = await db.getAgentConfig(ORG_X);
        assert.strictEqual(durante, null, 'ante un fallo sin copia previa devuelve null');

        control.failTables = new Set();
        control.rows.agent_configs = { id: 'cfg-1', organization_id: ORG_X, services: [{ nombre: 'X' }] };
        const despues = await db.getAgentConfig(ORG_X);
        assert(despues && despues.id === 'cfg-1',
            'tras restaurarse la BD debe volver a consultar; si devuelve null es que cacheó el fallo');
    });

    await test('getAgentConfig sirve la última copia buena si la lectura falla después', async () => {
        const ORG_Y = '00000000-0000-4000-8000-0000000000ee';
        control.failTables = new Set();
        control.rows.agent_configs = { id: 'cfg-buena', organization_id: ORG_Y, services: [] };
        const buena = await db.getAgentConfig(ORG_Y);
        assert.strictEqual(buena.id, 'cfg-buena');

        // Se fuerza la expiración del TTL para que vuelva a consultar, y esa consulta falla.
        const realNow = Date.now;
        Date.now = () => realNow() + 120000;
        control.failTables = new Set(['agent_configs']);
        try {
            const trasFallo = await db.getAgentConfig(ORG_Y);
            assert(trasFallo && trasFallo.id === 'cfg-buena',
                'debe servir el catálogo viejo antes que dejar a la org sin catálogo');
        } finally { Date.now = realNow; }
    });

    console.log(`\n${pass} comprobaciones OK`);
})();
