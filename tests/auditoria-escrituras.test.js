// Escrituras que no pueden mentir + ciclo de vida de citas.
// Auditoría de integridad de datos, 30/07/2026. Cubre lo que devolvía `true` sin haber escrito
// (setVip/setBlacklist), el incremento atómico de visit_count, el bucle infinito de
// updateLead/saveLead y autoCompleteAppointments (que no tenía ningún test).
// Hermético: Supabase falso inyectado por require-cache, cero red.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');

async function testAsync(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// ─── Escrituras que no pueden mentir (db.js) ─────────────────────────────────────
// Supabase falso: se inyecta por require-cache ANTES de db.js. Un UPDATE devuelve las filas
// afectadas (como el real con `.select('id')`), así que se puede simular "no casó nada".
function makeFake() {
    const state = { filasAfectadas: 1, error: null, rpc: [] };
    function builder() {
        const q = { op: null, payload: null };
        const run = () => {
            if (state.error) return { data: null, error: state.error };
            if (q.op === 'update') {
                return { data: Array.from({ length: state.filasAfectadas }, (_, i) => ({ id: `r${i}` })), error: null };
            }
            if (q.op === 'insert') return { data: { id: 'nuevo' }, error: null };
            return { data: [], error: null };
        };
        const b = {
            from() { return b; },
            select() { return b; },
            update(p) { q.op = 'update'; q.payload = p; return b; },
            insert(p) { q.op = 'insert'; q.payload = p; return b; },
            eq() { return b; },
            in() { return b; },
            is() { return b; },
            lte() { return b; },
            order() { return b; },
            limit() { return b; },
            maybeSingle() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }); },
            single() { return b.maybeSingle(); },
            then(onF, onR) { return Promise.resolve(run()).then(onF, onR); },
        };
        return b;
    }
    return {
        client: {
            from() { return builder(); },
            rpc(name, args) { state.rpc.push({ name, args }); return Promise.resolve({ data: 7, error: state.error }); },
        },
        state,
    };
}

const fake = makeFake();
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fake.client };
const db = require('../services/db');

(async () => {
    await testAsync('setVip sobre una fila que existe devuelve true', async () => {
        fake.state.error = null; fake.state.filasAfectadas = 1;
        assert.strictEqual(await db.setVip('org', 'c1', true), true);
    });

    // El caso que devolvía 200 {ok:true} y el panel cantaba "Añadido a VIP" sin escribir nada:
    // un id inexistente o de otra organización. Supabase NO da error, solo 0 filas.
    await testAsync('setVip que no casa ninguna fila LANZA (no dice que guardó)', async () => {
        fake.state.error = null; fake.state.filasAfectadas = 0;
        await assert.rejects(() => db.setVip('org', 'inexistente', true), /no encontró la fila/);
    });

    await testAsync('setBlacklist que no casa ninguna fila LANZA', async () => {
        fake.state.error = null; fake.state.filasAfectadas = 0;
        await assert.rejects(() => db.setBlacklist('org', 'inexistente', 'No-show'), /no encontró la fila/);
    });

    await testAsync('removeBlacklist que no casa ninguna fila LANZA', async () => {
        fake.state.error = null; fake.state.filasAfectadas = 0;
        await assert.rejects(() => db.removeBlacklist('org', 'inexistente'), /no encontró la fila/);
    });

    await testAsync('setVip con error de Supabase LANZA', async () => {
        fake.state.filasAfectadas = 1;
        fake.state.error = { message: 'permission denied for table contacts', code: '42501' };
        await assert.rejects(() => db.setVip('org', 'c1', true), /permission denied/);
        fake.state.error = null;
    });

    await testAsync('incrementVisitCount usa la RPC atómica, no read-modify-write', async () => {
        fake.state.error = null;
        fake.state.rpc.length = 0;
        const n = await db.incrementVisitCount('org', 'c1');
        assert.strictEqual(n, 7, 'devuelve el contador que calculó Postgres');
        assert.strictEqual(fake.state.rpc.length, 1, 'una sola llamada');
        assert.strictEqual(fake.state.rpc[0].name, 'increment_visit_count');
        assert.deepStrictEqual(Object.keys(fake.state.rpc[0].args).sort(), ['p_contact_id', 'p_organization_id']);
    });

    // ─── updateLead con un leadId muerto no puede colgarse ───────────────────────
    // La sesión del bot guarda leadId; si el contacto se borra desde el panel mientras la
    // clienta sigue escribiendo, ese id apunta a una fila que ya no existe. updateLead llamaba
    // a saveLead reenviándole el leadId, y saveLead se lo devolvía a updateLead: bucle
    // asíncrono infinito machacando Supabase a lecturas. No revienta la pila (cada await cede
    // el turno), así que no dejaba ni una traza.
    await testAsync('updateLead con leadId inexistente recrea el contacto sin colgarse', async () => {
        fake.state.error = null; fake.state.filasAfectadas = 1;
        const seCuelga = new Promise((_, rej) => setTimeout(() => rej(new Error('bucle infinito: no terminó')), 5000));
        const r = await Promise.race([
            db.updateLead('org', { leadId: 'id-que-ya-no-existe', telefono: '34600000009', notas: 'x' }),
            seCuelga,
        ]);
        assert.strictEqual(r, true, 'lo vuelve a crear');
    });

    // ─── autoCompleteAppointments: no tenía ningún test ──────────────────────────
    await testAsync('autoCompleteAppointments solo toca citas confirmed ya terminadas', async () => {
        fake.state.error = null; fake.state.filasAfectadas = 0;
        const filtros = [];
        const original = fake.client.from;
        fake.client.from = function (t) {
            const b = original.call(this, t);
            const eq = b.eq.bind(b), lte = b.lte.bind(b);
            b.eq = (k, v) => { filtros.push(['eq', k, v]); return eq(k, v); };
            b.lte = (k, v) => { filtros.push(['lte', k, v]); return lte(k, v); };
            return b;
        };
        await db.autoCompleteAppointments('org');
        fake.client.from = original;
        assert.ok(filtros.some(f => f[1] === 'status' && f[2] === 'confirmed'), 'solo confirmed');
        assert.ok(filtros.some(f => f[0] === 'lte' && f[1] === 'ends_at'), 'solo las ya terminadas');
        assert.ok(filtros.some(f => f[1] === 'organization_id'), 'aislada por organización');
    });

    await testAsync('autoCompleteAppointments con la BD caída LANZA (no informa de 0 citas)', async () => {
        fake.state.error = { message: 'timeout', code: '57014' };
        await assert.rejects(() => db.autoCompleteAppointments('org'), /autoComplete/);
        fake.state.error = null;
    });

    if (!process.exitCode) console.log('\nTodos los tests de escrituras y citas OK');
    process.exit(process.exitCode || 0);
})();
