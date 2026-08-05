/**
 * La audiencia de una campaña nunca incluye los teléfonos del arnés de pruebas.
 *
 * El caso real (05/08/2026): `verify:robustez:llm` conduce conversaciones contra la Supabase
 * REAL de Sante —es lo que le da valor: catálogo, estilistas y horarios de verdad—, así que
 * cada escenario crea un contacto real y lo borra al acabar. Pero la limpieza tiene una
 * carrera que no se puede cerrar del todo: `saveMessage` es fire-and-forget y el turno sigue
 * vivo después del borrado, así que una escritura en vuelo resucita el contacto. Aparecieron
 * DOS residuos en la base, y los dos estaban dentro de la audiencia 'todos' — que es la que el
 * panel manda por defecto. Con el rango antiguo (`3460099xxxx`, un móvil español plausible),
 * lanzar la campaña de verano le habría escrito a un desconocido.
 *
 * Se prueba contra el `getBroadcastRecipients` REAL, con un doble de Supabase que imita la
 * semántica de PostgREST (incluido el NOT LIKE sobre NULL, que es la parte sutil). Un stub del
 * módulo db entero no probaría nada aquí: la función bajo prueba ES la consulta.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { SANTE_ORG_ID } = require('../services/org-registry');

// ─── Doble de Supabase con semántica PostgREST ───────────────────────────────────────
// Solo lo que usa getBroadcastRecipients: .eq, .or, .not(like), .in, .order.
let filas = [];

function valorDe(fila, col) { return fila[col]; }

// `is_blacklisted.is.null,is_blacklisted.eq.false` → OR de términos `col.op.valor`.
function evaluaOr(fila, expr) {
    return String(expr).split(',').some(term => {
        const [col, op, ...resto] = term.split('.');
        const bruto = resto.join('.');
        const v = valorDe(fila, col);
        if (op === 'is') return bruto === 'null' ? (v === null || v === undefined) : v === (bruto === 'true');
        if (op === 'eq') {
            if (bruto === 'true' || bruto === 'false') return v === (bruto === 'true');
            return String(v) === bruto;
        }
        throw new Error(`operador .or no soportado en el doble: ${op}`);
    });
}

// NOT LIKE con semántica SQL: sobre NULL da NULL, y una fila con NULL NO pasa el filtro.
// Es exactamente lo que hace Postgres, y es la razón de que un contacto sin teléfono quede
// fuera de la audiencia. Si el doble no lo imitara, el test mentiría justo en el borde.
function evaluaNotLike(fila, col, patron) {
    const v = valorDe(fila, col);
    if (v === null || v === undefined) return false;
    const re = new RegExp(`^${String(patron).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`);
    return !re.test(String(v));
}

function makeBuilder() {
    const filtros = [];
    const b = {
        from() { return b; },
        select() { return b; },
        eq(col, val) { filtros.push(f => valorDe(f, col) === val); return b; },
        or(expr) { filtros.push(f => evaluaOr(f, expr)); return b; },
        not(col, op, val) {
            if (op !== 'like') throw new Error(`.not con operador no soportado: ${op}`);
            filtros.push(f => evaluaNotLike(f, col, val));
            return b;
        },
        in(col, vals) { filtros.push(f => vals.includes(valorDe(f, col))); return b; },
        order() { return Promise.resolve({ data: filas.filter(f => filtros.every(fn => fn(f))), error: null }); },
        then(res, rej) { return b.order().then(res, rej); },
    };
    return b;
}

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from() { return makeBuilder(); } },
};

const db = require('../services/db');
const { TEST_PHONE_PREFIX } = require('../services/helpers');

const ARNES_1 = `${TEST_PHONE_PREFIX}6001000`;
const ARNES_2 = `${TEST_PHONE_PREFIX}6001016`;   // el que se fugó de verdad, escenario 17

function seed() {
    filas = [
        { id: 'c1', organization_id: SANTE_ORG_ID, wa_phone: '34600111111', full_name: 'Clienta real', origen: 'importado_shortcuts', is_vip: false, is_blacklisted: false },
        { id: 'c2', organization_id: SANTE_ORG_ID, wa_phone: '34600222222', full_name: 'Clienta VIP', origen: 'whatsapp', is_vip: true, is_blacklisted: false },
        { id: 'c3', organization_id: SANTE_ORG_ID, wa_phone: '34600333333', full_name: 'Bloqueada', origen: 'whatsapp', is_vip: false, is_blacklisted: true },
        { id: 't1', organization_id: SANTE_ORG_ID, wa_phone: ARNES_1, full_name: null, origen: 'whatsapp', is_vip: false, is_blacklisted: false },
        { id: 't2', organization_id: SANTE_ORG_ID, wa_phone: ARNES_2, full_name: null, origen: 'whatsapp', is_vip: false, is_blacklisted: false },
        { id: 'c4', organization_id: SANTE_ORG_ID, wa_phone: '', full_name: 'Alexandra (sin teléfono)', origen: 'manual', is_vip: false, is_blacklisted: false },
        { id: 'c5', organization_id: SANTE_ORG_ID, wa_phone: null, full_name: 'Sin número en absoluto', origen: 'manual', is_vip: false, is_blacklisted: false },
        { id: 'x1', organization_id: 'otra-org', wa_phone: '34600999999', full_name: 'De otra org', origen: 'whatsapp', is_vip: false, is_blacklisted: false },
    ];
}

const tel = destinatarios => destinatarios.map(d => d.telefono);

async function test(name, fn) {
    try { seed(); await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

(async () => {
    await test('el prefijo reservado es un código de país sin asignar, no un móvil real', () => {
        assert.strictEqual(TEST_PHONE_PREFIX, '999');
        // Si sanitizePhone reescribiera estos números, lo guardado no casaría con el filtro y
        // la exclusión no serviría de nada: los dos extremos tienen que hablar del mismo texto.
        assert.strictEqual(db.sanitizePhone(ARNES_1), ARNES_1);
        assert.strictEqual(db.sanitizePhone(`+${ARNES_1}`), ARNES_1);
        assert.strictEqual(db.sanitizePhone(`${ARNES_1}@c.us`), ARNES_1);
    });

    await test('audiencia "todos": entran las clientas, NO los teléfonos del arnés', async () => {
        const d = await db.getBroadcastRecipients(SANTE_ORG_ID, { audience: 'todos' });
        assert.ok(tel(d).includes('34600111111'));
        assert.ok(tel(d).includes('34600222222'), 'una VIP sí está en "todos"');
        assert.ok(!tel(d).includes(ARNES_1), 'ANTES: el residuo del arnés era una destinataria más');
        assert.ok(!tel(d).includes(ARNES_2));
    });

    await test('audiencia "no_vip": mismo filtro (no depende de la rama)', async () => {
        const d = await db.getBroadcastRecipients(SANTE_ORG_ID, { audience: 'no_vip' });
        assert.ok(tel(d).includes('34600111111'));
        assert.ok(!tel(d).includes('34600222222'), 'la VIP queda fuera, como antes');
        assert.ok(!tel(d).includes(ARNES_1));
    });

    await test('audiencia "nunca_reservado": tampoco', async () => {
        const d = await db.getBroadcastRecipients(SANTE_ORG_ID, { audience: 'nunca_reservado' });
        assert.deepStrictEqual(tel(d), ['34600111111']);
    });

    await test('ni siquiera por allowlist explícito de teléfonos', async () => {
        // El allowlist existe para pruebas seguras contra un número REAL. Un número del arnés
        // no es un destinatario ni cuando alguien lo pide a mano: no existe, no se entrega, y
        // si se entregara sería a quien no debe.
        const d = await db.getBroadcastRecipients(SANTE_ORG_ID, { phones: [ARNES_1, '34600111111'] });
        assert.deepStrictEqual(tel(d), ['34600111111']);
    });

    await test('la lista negra sigue excluyendo (no se ha roto lo de antes)', async () => {
        const d = await db.getBroadcastRecipients(SANTE_ORG_ID, { audience: 'todos' });
        assert.ok(!tel(d).includes('34600333333'));
    });

    await test('otra org no se cuela por el filtro nuevo', async () => {
        const d = await db.getBroadcastRecipients(SANTE_ORG_ID, { audience: 'todos' });
        assert.ok(!tel(d).includes('34600999999'));
    });

    await test('sin número: la cadena vacía SE VE en la audiencia; el NULL no', async () => {
        const d = await db.getBroadcastRecipients(SANTE_ORG_ID, { audience: 'todos' });
        // Una ficha con el teléfono en blanco tiene que verse: es una clienta real con el dato
        // mal, y esconderla de la audiencia es esconder el problema.
        assert.ok(tel(d).includes(''), 'la ficha con teléfono vacío sigue contándose');
        // El NULL queda fuera por la semántica del NOT LIKE. Es lo que corresponde —no se
        // escribe a quien no tiene número— pero se afirma aquí para que sea una decisión
        // consciente y no una sorpresa el día que aparezca uno.
        assert.strictEqual(d.filter(x => x.telefono === null || x.telefono === undefined).length, 0);
    });

    if (!process.exitCode) console.log('\nTests de audiencia de campaña OK');
    process.exit(process.exitCode || 0);
})();
