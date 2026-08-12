// Dos lecturas que se tragaban el `error` de Supabase y lo presentaban como un hecho.
//
// Las dos estaban anotadas y sin tocar desde el 09/08/2026, y las dos son el mismo patrón que
// motivó `assertRead` (auditoría del 28/07): `const { data } = await supabase…; return data || []`.
// Lo que cambia es lo que ese `[]` AFIRMA:
//
//   · getAppointmentsByDateRange → GET /api/citas → la agenda del panel. Un fallo de lectura
//     se pintaba como «no hay citas»: un día lleno indistinguible de un día vacío, y encima en
//     la pantalla desde la que se decide si cabe alguien más.
//
//   · getPendingActions → cinco call sites, y el que duele es el PRIMER paso del desbloqueo
//     (`PUT /api/leads/:id/bot-mode` con mode:'auto'). Un fallo devolvía `[]`, no encontraba la
//     escalada, no la resolvía, y el endpoint respondía `{ok:true}` igual: el panel cantaba
//     «Eliminado de la lista negra» dejando la `pending_action` abierta. CLAUDE.md ya la
//     señalaba («se traga el error: un vigilante ciego además tranquiliza») y hasta hoy se
//     esquivaba, no se arreglaba.
//
// Y la mitad que no es la línea del assertRead: `tryResolvePendingReply` (telegram.js) llama a
// getPendingActions desde el handler `bot.on('message')`, que NO tiene try/catch. Hacer lanzar
// una función obliga a mirar TODOS sus call sites: sin esto, una lectura caída pasaría de
// devolver `[]` a tumbar el proceso —el bot de las DOS orgs— por un rechazo sin manejar. Es
// exactamente la trampa de `setConfigValue`/`setBotActivo` (06/08/2026).
//
// Hermético: Supabase falso inyectado en require.cache, cero red, cero Telegram.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');

// ─── Supabase falso: falla o responde según la tabla ────────────────────────────────────
//
// `errorAlEscribir` es aparte de `failTables` a propósito: hace falta llegar al camino de
// ESCRITURA con la tabla en pie. Con `failTables` la lectura de arriba falla primero y nunca
// se llega a escribir, así que el escenario «la consulta va, el UPDATE lo rechazan» —que es el
// que deja al admin leyendo «confirmada» sobre una fila sin cerrar— no se podría montar.
const control = { failTables: new Set(), rows: {}, errorAlEscribir: new Set() };

function makeBuilder(tabla) {
    let esEscritura = false;
    const run = () => {
        if (control.failTables.has(tabla)) {
            return { data: null, error: { code: 'PGRST301', message: `simulated failure on ${tabla}` } };
        }
        if (esEscritura && control.errorAlEscribir.has(tabla)) {
            return { data: null, error: { code: 'PGRST301', message: `simulated write failure on ${tabla}` } };
        }
        return { data: control.rows[tabla] ?? [], error: null };
    };
    const b = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'then') return (onF, onR) => Promise.resolve(run()).then(onF, onR);
            if (prop === 'maybeSingle' || prop === 'single') {
                return () => ({ then: (onF, onR) => Promise.resolve(run()).then(onF, onR) });
            }
            if (prop === 'update' || prop === 'insert' || prop === 'upsert' || prop === 'delete') {
                esEscritura = true;
            }
            return () => b;   // select/eq/gte/lte/in/not/order… encadenan
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
const telegram = require('../services/telegram');

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

// Un rechazo sin manejar en cualquier punto del fichero es un fallo: es justo el modo de
// romperse que el try/catch de telegram.js existe para evitar.
const rechazosSinManejar = [];
process.on('unhandledRejection', (r) => { rechazosSinManejar.push(r); });

(async () => {
    // ─── 1. La agenda del panel ──────────────────────────────────────────────────────────
    await test('getAppointmentsByDateRange: un error de Supabase LANZA, no devuelve []', async () => {
        control.failTables = new Set(['appointments']);
        await lanza(() => db.getAppointmentsByDateRange(ORG, '2026-08-12', '2026-08-12'),
            'getAppointmentsByDateRange');
    });

    await test('getAppointmentsByDateRange: sin error sigue devolviendo la lista de siempre', async () => {
        control.failTables = new Set();
        control.rows.appointments = [{
            id: 'apt-1', service: 'Corte', status: 'confirmed',
            starts_at: '2026-08-12T10:00:00.000Z', ends_at: '2026-08-12T11:00:00.000Z',
            contacts: { id: 'c-1', full_name: 'Nora', wa_phone: '34600000001' },
            stylists: { id: 'sty-1', name: 'Irina' },
        }];
        const citas = await db.getAppointmentsByDateRange(ORG, '2026-08-12', '2026-08-12');
        assert(Array.isArray(citas), 'debe seguir devolviendo un array');
        assert.strictEqual(citas.length, 1, 'la fila buena tiene que llegar entera');
    });

    // El control que separa «no hay citas» de «no se pudo leer». Sin él, un test que solo
    // exige lanzar pasaría también con una función que lanzara SIEMPRE.
    await test('getAppointmentsByDateRange: un día de verdad vacío devuelve [], no lanza', async () => {
        control.failTables = new Set();
        control.rows.appointments = [];
        const citas = await db.getAppointmentsByDateRange(ORG, '2026-08-12', '2026-08-12');
        assert.deepStrictEqual(citas, [], 'un día sin citas es [] y sigue siéndolo');
    });

    // ─── 2. La cola de acciones pendientes ───────────────────────────────────────────────
    await test('getPendingActions: un error de Supabase LANZA, no devuelve []', async () => {
        control.failTables = new Set(['pending_actions']);
        await lanza(() => db.getPendingActions(ORG, 'escalation'), 'getPendingActions');
    });

    await test('getPendingActions: sin error devuelve las filas, y sin type también', async () => {
        control.failTables = new Set();
        control.rows.pending_actions = [{ id: 'pa-1', type: 'escalation', contact_id: 'c-1', status: 'pending' }];
        assert.strictEqual((await db.getPendingActions(ORG, 'escalation')).length, 1);
        assert.strictEqual((await db.getPendingActions(ORG)).length, 1, 'sin type recorre el mismo camino');
    });

    await test('getPendingActions: cero pendientes de verdad devuelve [], no lanza', async () => {
        control.failTables = new Set();
        control.rows.pending_actions = [];
        assert.deepStrictEqual(await db.getPendingActions(ORG, 'escalation'), []);
    });

    // ─── 3. El call site sin red: Telegram ───────────────────────────────────────────────
    //
    // `bot.on('message')` no tiene try/catch, así que aquí se afirma lo que impide que un
    // "sí" del admin con la BD caída tumbe el proceso entero.
    function botFalso() {
        const enviados = [];
        return { enviados, sendMessage: (_chat, texto) => { enviados.push(String(texto)); } };
    }

    await test('Telegram: con pending_actions caída NO propaga, avisa al admin y se para ahí', async () => {
        control.failTables = new Set(['pending_actions']);
        const bot = botFalso();
        let manejado;
        try {
            manejado = await telegram._tryResolvePendingReply(ORG, bot, 111, 222, 'sí');
        } catch (e) {
            throw new Error(`no debe propagar al handler sin try/catch, y propagó: ${e.message}`);
        }
        assert.strictEqual(manejado, true,
            'tiene que devolver true: caer al intérprete del LLM con un "sí" suelto es peor que pararse');
        assert.strictEqual(bot.enviados.length, 1, 'el admin tiene que enterarse, no quedarse esperando');
        assert(/no he podido|no se ha podido|no puedo/i.test(bot.enviados[0]),
            `el aviso tiene que decir que NO se ha podido mirar; decía: ${bot.enviados[0]}`);
        assert(!/no hay|ninguna pendiente/i.test(bot.enviados[0]),
            `y no puede afirmar que no hay pendientes: ${bot.enviados[0]}`);
    });

    await test('Telegram: sin fallo, el camino normal sigue igual (un bizum se resuelve)', async () => {
        control.failTables = new Set();
        control.rows.pending_actions = [];
        const bot = botFalso();
        // Sin pendientes de ningún tipo, la función devuelve false y el mensaje sigue su curso
        // hacia el intérprete. Es el control de que el try/catch no se ha tragado el camino bueno.
        const manejado = await telegram._tryResolvePendingReply(ORG, bot, 111, 222, 'sí');
        assert.strictEqual(manejado, false, 'sin pendientes tiene que dejar pasar el mensaje');
        assert.strictEqual(bot.enviados.length, 0, 'y no decir nada');
    });

    // ─── 3b. resolvePendingAction: cerrar una acción sin poder cerrarla ──────────────────
    await test('resolvePendingAction: un error de Supabase LANZA, no devuelve null callando', async () => {
        control.failTables = new Set(['pending_actions']);
        await lanza(() => db.resolvePendingAction(ORG, 'pa-1', 'resuelto_panel'), 'resolvePendingAction');
    });

    await test('resolvePendingAction: cero filas devuelve null y NO lanza (ya la cerró otro)', async () => {
        // Es el motivo de que use `.select()` en lista y no `.single()`: con single, cero filas
        // es un error PGRST116 y assertWrite lo confundiría con una BD caída. Y no lo es: el
        // panel y Telegram cierran las mismas acciones, así que perder la carrera es normal y
        // el resultado —la fila cerrada— es el mismo. Lo que no puede pasar por normal es un
        // error de infraestructura, que es el bloque de arriba.
        control.failTables = new Set();
        control.rows.pending_actions = [];
        assert.strictEqual(await db.resolvePendingAction(ORG, 'pa-1', 'resuelto_panel'), null);
    });

    await test('resolvePendingAction: con fila devuelve la fila cerrada', async () => {
        control.rows.pending_actions = [{ id: 'pa-1', type: 'escalation', status: 'resolved' }];
        const r = await db.resolvePendingAction(ORG, 'pa-1', 'resuelto_panel');
        assert(r && r.id === 'pa-1', 'quien llama tiene que poder ver que se cerró');
    });

    await test('Telegram: un «sí» cuyo cierre falla NO tumba el proceso ni dice "confirmada"', async () => {
        // El caso real: hay un bizum pendiente, el admin contesta «sí», la consulta va bien y
        // el UPDATE que cierra la acción lo rechaza la BD. Antes se tragaba el error y el
        // admin leía «Reserva confirmada» sobre una cola que seguía con su fila abierta.
        control.failTables = new Set();
        control.rows.pending_actions = [{
            id: 'pa-9', type: 'bizum_review', contact_id: 'c-1', status: 'pending',
            payload: { nombre: 'Quien Sea' }, contacts: { full_name: 'Quien Sea' },
        }];
        control.errorAlEscribir = new Set(['pending_actions']);
        const bot = botFalso();
        let manejado;
        try {
            manejado = await telegram._tryResolvePendingReply(ORG, bot, 111, 444, 'sí');
        } catch (e) {
            throw new Error(`propagó y tumbaría el proceso: ${e.message}`);
        } finally {
            control.errorAlEscribir = new Set();
            control.rows.pending_actions = [];
        }
        assert.strictEqual(manejado, true, 'el mensaje queda consumido, no cae al intérprete');
        const todo = bot.enviados.join(' | ');
        assert(!/confirmada/i.test(todo), `no puede decir que quedó confirmada: ${todo}`);
        assert(/no he podido/i.test(todo), `y tiene que decir que no se hizo: ${todo}`);
    });

    await test('Telegram: un texto que no es sí/no ni siquiera llega a leer la BD', async () => {
        control.failTables = new Set(['pending_actions']);   // fallaría si llegara a consultar
        const bot = botFalso();
        const manejado = await telegram._tryResolvePendingReply(ORG, bot, 111, 333, 'cuántas citas hay hoy');
        assert.strictEqual(manejado, false);
        assert.strictEqual(bot.enviados.length, 0, 'no hay nada que avisar: no se ha consultado nada');
    });

    // ─── 4. Ni un rechazo sin manejar en todo el fichero ─────────────────────────────────
    await new Promise(r => setTimeout(r, 50));
    await test('cero rechazos sin manejar (un throw nuevo no puede tumbar el proceso)', async () => {
        assert.strictEqual(rechazosSinManejar.length, 0,
            `hubo ${rechazosSinManejar.length} rechazo(s) sin manejar: ${rechazosSinManejar.map(String).join(' · ')}`);
    });

    console.log(`\n${pass} comprobaciones OK`);
})();
