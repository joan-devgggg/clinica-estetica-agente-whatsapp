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
 * Y la otra mitad, que importa más: entre los excluidos hay clientas REALES con cita cuyo
 * teléfono está mal escrito (un 0 inicial pegado, un fijo de 9 dígitos, una ficha sin número).
 * A esas la campaña no les llegaba tampoco antes — la diferencia es que ahora se sabe quiénes
 * son y por qué. Filtrarlas evita el envío inútil; enseñarlas es lo que hace que alguien las
 * llame.
 *
 * Se prueba contra `getBroadcastAudience` / `getBroadcastRecipients` REALES, con un doble de
 * Supabase que imita la semántica de PostgREST. Un stub del módulo db entero no probaría nada
 * aquí: lo que está bajo prueba ES la consulta y su reparto.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { SANTE_ORG_ID } = require('../services/org-registry');

// ─── Doble de Supabase con semántica PostgREST ───────────────────────────────────────
// Solo lo que usa la consulta: .eq, .or, .in, .order. A propósito no entiende nada más: si
// alguien añade un filtro nuevo a la consulta, esto revienta en vez de ignorarlo en silencio
// y dejar el test afirmando sobre una audiencia que ya no es la de producción.
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

function makeBuilder() {
    const filtros = [];
    const b = {
        from() { return b; },
        select() { return b; },
        eq(col, val) { filtros.push(f => valorDe(f, col) === val); return b; },
        or(expr) { filtros.push(f => evaluaOr(f, expr)); return b; },
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
const { TEST_PHONE_PREFIX, isSendablePhone } = require('../services/helpers');

const ARNES_1 = `${TEST_PHONE_PREFIX}6001000`;
const ARNES_2 = `${TEST_PHONE_PREFIX}6001016`;   // el que se fugó de verdad, escenario 17

function seed() {
    filas = [
        { id: 'c1', organization_id: SANTE_ORG_ID, wa_phone: '34600111111', full_name: 'Clienta real', origen: 'importado_shortcuts', is_vip: false, is_blacklisted: false },
        { id: 'c2', organization_id: SANTE_ORG_ID, wa_phone: '34600222222', full_name: 'Clienta VIP', origen: 'whatsapp', is_vip: true, is_blacklisted: false },
        { id: 'c3', organization_id: SANTE_ORG_ID, wa_phone: '34600333333', full_name: 'Bloqueada', origen: 'whatsapp', is_vip: false, is_blacklisted: true },
        { id: 't1', organization_id: SANTE_ORG_ID, wa_phone: ARNES_1, full_name: null, origen: 'whatsapp', is_vip: false, is_blacklisted: false },
        { id: 't2', organization_id: SANTE_ORG_ID, wa_phone: ARNES_2, full_name: null, origen: 'whatsapp', is_vip: false, is_blacklisted: false },
        // Los tres casos REALES de Sante a 05/08/2026, con sus números tal cual: dos clientas
        // con cita y el teléfono mal escrito, y una prueba antigua. Copiarlos de la base y no
        // inventarlos es lo que hace que este test hable del problema que hay.
        { id: 'c4', organization_id: SANTE_ORG_ID, wa_phone: '', full_name: 'Alexandra (sin teléfono)', origen: 'manual', is_vip: false, is_blacklisted: false },
        { id: 'c5', organization_id: SANTE_ORG_ID, wa_phone: null, full_name: 'Sin número en absoluto', origen: 'manual', is_vip: false, is_blacklisted: false },
        { id: 'c6', organization_id: SANTE_ORG_ID, wa_phone: '0789717626', full_name: 'Elena Baltaga', origen: 'manual', is_vip: false, is_blacklisted: false },
        { id: 'c7', organization_id: SANTE_ORG_ID, wa_phone: '965288498', full_name: 'Tatiana Zotova', origen: 'manual', is_vip: false, is_blacklisted: false },
        { id: 'c8', organization_id: SANTE_ORG_ID, wa_phone: '77777777', full_name: 'ja', origen: 'manual', is_vip: false, is_blacklisted: false },
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

    // ═══ Quién no puede recibir, y que se SEPA ════════════════════════════════════════
    // La parte que de verdad importa: entre los excluidos hay clientas reales con cita cuyo
    // teléfono está mal escrito. Filtrarlas evita el envío inútil; ENSEÑARLAS es lo que hace
    // que alguien las llame. Una campaña que las salta en silencio deja el problema igual.

    await test('un teléfono que no es E.164 no recibe, y sale con su motivo', async () => {
        const { destinatarios, excluidos } = await db.getBroadcastAudience(SANTE_ORG_ID, { audience: 'todos' });
        assert.ok(!tel(destinatarios).includes('0789717626'), 'el 0 inicial no viaja: no se le entrega');
        assert.ok(!tel(destinatarios).includes('965288498'), 'un fijo de 9 dígitos tampoco');
        assert.ok(!tel(destinatarios).includes(''), 'ni una ficha sin teléfono');

        const porTel = Object.fromEntries(excluidos.map(e => [e.telefono, e.motivo]));
        assert.strictEqual(porTel['0789717626'], 'numero_invalido');
        assert.strictEqual(porTel['965288498'], 'numero_invalido');
        assert.strictEqual(porTel[''], 'sin_numero');
        assert.strictEqual(porTel[ARNES_1], 'prueba', 'el del arnés se distingue: se borra, no se llama');
    });

    await test('el excluido conserva el NOMBRE — sin él la lista no sirve de nada', async () => {
        const { excluidos } = await db.getBroadcastAudience(SANTE_ORG_ID, { audience: 'todos' });
        const alexandra = excluidos.find(e => e.telefono === '');
        assert.ok(alexandra, 'tiene que estar en la lista, no desaparecer');
        assert.strictEqual(alexandra.nombre, 'Alexandra (sin teléfono)',
            'un teléfono suelto no permite reconocer a nadie ni ir a su ficha');
    });

    await test('quien sí puede recibir NO aparece entre los excluidos', async () => {
        const { destinatarios, excluidos } = await db.getBroadcastAudience(SANTE_ORG_ID, { audience: 'todos' });
        assert.ok(tel(destinatarios).includes('34600111111'));
        assert.ok(!tel(excluidos).includes('34600111111'));
        // Las dos listas juntas son la audiencia entera: nadie se pierde por el camino.
        assert.strictEqual(destinatarios.length + excluidos.length, 9,
            'los 9 de Sante no bloqueados (la de otra org no cuenta)');
        assert.strictEqual(destinatarios.length, 2, 'solo dos tienen un número al que entregar');
    });

    await test('getBroadcastRecipients sigue devolviendo un array plano (runBroadcast no cambia)', async () => {
        const d = await db.getBroadcastRecipients(SANTE_ORG_ID, { audience: 'todos' });
        assert.ok(Array.isArray(d));
        assert.deepStrictEqual(d, (await db.getBroadcastAudience(SANTE_ORG_ID, { audience: 'todos' })).destinatarios);
    });

    await test('isSendablePhone: la regla, en seco', () => {
        for (const bueno of ['34600111111', '9996001000', '380672707832', '1954224098']) {
            assert.ok(isSendablePhone(bueno), `${bueno} debería poder recibir`);
        }
        for (const malo of ['', '   ', '0789717626', '965288498', '77777777', '3460011111x', '3460011111122222', null, undefined]) {
            assert.ok(!isSendablePhone(malo), `${JSON.stringify(malo)} NO debería poder recibir`);
        }
    });

    if (!process.exitCode) console.log('\nTests de audiencia de campaña OK');
    process.exit(process.exitCode || 0);
})();
