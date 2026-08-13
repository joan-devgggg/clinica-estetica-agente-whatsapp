// La tanda entera, sin BD: qué se enseña antes de enviar y qué se enviaría.
//
// `construirTanda` es la única función que fabrica candidatas, y la llaman IGUAL el preview
// (para enseñar) y el worker (para mandar). Ese es el invariante que sostiene la promesa de
// "míralo antes": si fueran dos caminos, lo que se lee y lo que sale podrían diferir.
//
// Se stubea `services/db` en require.cache — `construirTanda` lo requiere de forma perezosa,
// así que el stub llega a tiempo. Mismo truco que tests/reminder-review-dryrun.test.js.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const CATALOGO = require('./fixtures/sante-catalog.json').services;

const AHORA = new Date('2026-08-13T12:00:00+02:00');
const haceDias = n => new Date(AHORA.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
const enDias   = n => new Date(AHORA.getTime() + n * 24 * 60 * 60 * 1000).toISOString();

// ─── El stub de BD ───────────────────────────────────────────────────────────

const estado = {
    reglas: [],
    botActivo: true,
    citas: [],
    agenda: [],
    accionesPendientes: new Set(),
    seguimientos: [],
};

const dbStub = {
    getAgentConfig: async () => ({ services: CATALOGO }),
    getConfigValue: async (_org, clave) => {
        if (clave === 'seguimientos') return estado.reglas;
        if (clave === 'bot_activo') return estado.botActivo;
        return null;
    },
    getCitasParaSeguimiento: async (_org, { desdeIso, hastaIso }) =>
        estado.citas.filter(c => c.ends_at >= desdeIso && c.ends_at <= hastaIso),
    getCitasDeContactosDesde: async () => estado.agenda,
    getContactIdsConAccionPendiente: async () => estado.accionesPendientes,
    getSeguimientosDeContactos: async () => estado.seguimientos,
};

const dbPath = require.resolve('../services/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };

const { construirTanda } = require('../services/seguimiento');
const { formatPrecioEur } = require('../services/helpers');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const REGLA_OK = {
    key: 'hidratacion_post_color',
    origen: 'Mechas Balayage',
    destino: 'Tratamiento Orgánico|Orising hidratación intensa',
    dias: 18, descuentoPct: 10, activa: true,
};
const REGLA_SIN_DESTINO = {
    key: 'hidratacion_post_color',
    origen: 'Mechas Balayage',
    destino: null, sugerencia: 'hidratación',
    dias: 18, descuentoPct: 10, activa: true,
};

const CONTACTO = {
    id: 'c1', full_name: 'Nora', wa_phone: '34600111222', language: 'en',
    metadata: {}, is_blacklisted: false, escalation_reason: null, bot_mode: 'auto',
};
const CITA = {
    id: 'a1', contact_id: 'c1', service: 'Cabello corto',
    starts_at: haceDias(18), ends_at: haceDias(18), status: 'completed',
    contacts: CONTACTO,
};

function reset(parches = {}) {
    Object.assign(estado, {
        reglas: [REGLA_OK], botActivo: true, citas: [CITA],
        agenda: [{ id: 'a1', contact_id: 'c1', service: 'Cabello corto', starts_at: haceDias(18), status: 'completed' }],
        accionesPendientes: new Set(), seguimientos: [],
    }, parches);
}

// ─── Lo que la dueña tiene que poder leer ANTES de que exista un destino ─────

test('CONDICIÓN · con la regla sin destino, la tanda se calcula igual y NO envía a nadie', async () => {
    reset({ reglas: [REGLA_SIN_DESTINO] });
    const t = await construirTanda('org', { ahora: AHORA });
    assert.strictEqual(t.enviables.length, 0, 'no puede enviar sin destino elegido');
    assert.strictEqual(t.reglas.length, 1);
    assert.strictEqual(t.reglas[0].resuelta.ok, false);
    assert.strictEqual(t.reglas[0].resuelta.motivo, 'sin_destino');
});

test('CONDICIÓN · y dice qué falta, con las tres opciones y sus precios', async () => {
    reset({ reglas: [REGLA_SIN_DESTINO] });
    const t = await construirTanda('org', { ahora: AHORA });
    const r = t.reglas[0].resuelta;

    assert.ok(/falta elegir/i.test(r.mensaje), `no dice qué falta: ${r.mensaje}`);
    // Los tres precios tienen que estar EN el mensaje, no solo en la estructura: es un texto
    // que se lee de corrido.
    for (const p of [45, 85, 110]) {
        assert.ok(r.mensaje.includes(formatPrecioEur(p)), `falta ${p} € en: ${r.mensaje}`);
    }
    assert.strictEqual(r.opciones.length, 3);
    // Y sin jerga: lo lee alguien que no sabe qué es una clave de catálogo.
    assert.ok(!/null|undefined|catalog|key|destino_/i.test(r.mensaje), `jerga en: ${r.mensaje}`);
});

test('CONDICIÓN · y dice a cuánta gente le llegaría en cuanto se elija', async () => {
    // Sin esto, con las DOS reglas aún sin destino —que es como nacen— el informe no
    // enseñaba a nadie: la ventana de lectura salía solo de las reglas resueltas, así que no
    // se leía ni una cita y la dueña elegía entre 45 € y 110 € a ciegas.
    reset({ reglas: [REGLA_SIN_DESTINO] });
    const t = await construirTanda('org', { ahora: AHORA });
    assert.strictEqual(t.reglas[0].esperando, 1, 'debería contar a Nora');
    assert.strictEqual(t.enviables.length, 0, 'contar no es enviar');
});

test('la cuenta de espera usa la MISMA ventana y categoría que el envío', async () => {
    reset({ reglas: [REGLA_SIN_DESTINO] });
    // Fuera de ventana: no cuenta.
    estado.citas = [{ ...CITA, ends_at: haceDias(60), starts_at: haceDias(60) }];
    assert.strictEqual((await construirTanda('org', { ahora: AHORA })).reglas[0].esperando, 0);
    // Otra categoría: tampoco.
    estado.citas = [{ ...CITA, service: 'Mechas Airtouch Corto' }];
    assert.strictEqual((await construirTanda('org', { ahora: AHORA })).reglas[0].esperando, 0);
});

test('una regla sin destino no impide que OTRA bien puesta envíe', async () => {
    reset({ reglas: [REGLA_SIN_DESTINO, { ...REGLA_OK, key: 'otra', origen: 'Mechas Airtouch' }] });
    estado.citas = [{ ...CITA, service: 'Mechas Airtouch Corto' }];
    estado.agenda = [{ id: 'a1', contact_id: 'c1', service: 'Mechas Airtouch Corto', starts_at: haceDias(18), status: 'completed' }];
    const t = await construirTanda('org', { ahora: AHORA });
    assert.strictEqual(t.enviables.length, 1);
    assert.strictEqual(t.enviables[0].regla.key, 'otra');
});

// ─── La tanda que sí sale ────────────────────────────────────────────────────

test('la candidata sale con el mensaje EXACTO que se enviaría', async () => {
    reset();
    const t = await construirTanda('org', { ahora: AHORA });
    assert.strictEqual(t.enviables.length, 1);
    const e = t.enviables[0];
    assert.strictEqual(e.nombre, 'Nora');
    assert.strictEqual(e.language, 'en');
    // Inglés, porque su ficha lo dice: el preview enseña el idioma real, no el castellano.
    assert.ok(e.mensaje.startsWith('Hi Nora'), e.mensaje);
    assert.ok(e.mensaje.includes('76,50 €'), e.mensaje);
    assert.ok(e.mensaje.includes('85 €'), e.mensaje);
    assert.ok(!e.mensaje.includes('%'), e.mensaje);
});

test('la ventana de lectura sale de las REGLAS, no de una constante', async () => {
    reset({ reglas: [REGLA_OK, { ...REGLA_OK, key: 'largo', dias: 90 }] });
    const t = await construirTanda('org', { ahora: AHORA });
    assert.strictEqual(t.ventana.minDias, 18);
    assert.strictEqual(t.ventana.maxDias, 97);   // 90 + margen
});

// ─── Lo que se aparta, y se ve por qué ───────────────────────────────────────

test('quien ya volvió aparece en excluidas con ese motivo, no desaparece', async () => {
    reset();
    estado.agenda = [
        { id: 'a1', contact_id: 'c1', service: 'Cabello corto', starts_at: haceDias(18), status: 'completed' },
        { id: 'a2', contact_id: 'c1', service: 'Corte mujer y secado', starts_at: enDias(4), status: 'confirmed' },
    ];
    const t = await construirTanda('org', { ahora: AHORA });
    assert.strictEqual(t.enviables.length, 0);
    assert.strictEqual(t.excluidas.length, 1);
    assert.strictEqual(t.excluidas[0].motivo, 'tiene_cita_futura');
    // Con su nombre: una exclusión anónima no se puede comprobar.
    assert.strictEqual(t.excluidas[0].nombre, 'Nora');
});

test('quien ya se hizo el servicio ofrecido, igual', async () => {
    reset();
    estado.agenda = [
        { id: 'a1', contact_id: 'c1', service: 'Cabello corto', starts_at: haceDias(18), status: 'completed' },
        { id: 'a2', contact_id: 'c1', service: 'Orising hidratación intensa', starts_at: haceDias(2), status: 'completed' },
    ];
    const t = await construirTanda('org', { ahora: AHORA });
    assert.strictEqual(t.enviables.length, 0);
    assert.strictEqual(t.excluidas[0].motivo, 'ya_se_lo_hizo');
});

test('un seguimiento ya enviado no vuelve a salir', async () => {
    reset({ seguimientos: [{ contact_id: 'c1', appointment_origen_id: 'a1', regla_key: REGLA_OK.key, estado: 'enviado', enviado_at: haceDias(1) }] });
    const t = await construirTanda('org', { ahora: AHORA });
    assert.strictEqual(t.enviables.length, 0);
    assert.strictEqual(t.excluidas[0].motivo, 'ya_enviado');
});

test('CRÍTICO · una fila RESERVADA (pendiente) cuenta como enviada', async () => {
    // El claim se escribe ANTES de mandar. Si 'pendiente' no contara, un segundo barrido que
    // pillara el hueco entre la reserva y el envío mandaría el mensaje dos veces.
    reset({ seguimientos: [{ contact_id: 'c1', appointment_origen_id: 'a1', regla_key: REGLA_OK.key, estado: 'pendiente', enviado_at: null }] });
    const t = await construirTanda('org', { ahora: AHORA });
    assert.strictEqual(t.enviables.length, 0);
    assert.strictEqual(t.excluidas[0].motivo, 'ya_enviado');
});

test('un FALLIDO sí se reintenta — si no, un fallo de red la deja fuera para siempre', async () => {
    reset({ seguimientos: [{ contact_id: 'c1', appointment_origen_id: 'a1', regla_key: REGLA_OK.key, estado: 'fallido', enviado_at: null }] });
    const t = await construirTanda('org', { ahora: AHORA });
    assert.strictEqual(t.enviables.length, 1);
});

test('con el bot apagado no sale nadie, y se dice', async () => {
    reset({ botActivo: false });
    const t = await construirTanda('org', { ahora: AHORA });
    assert.strictEqual(t.enviables.length, 0);
    assert.strictEqual(t.excluidas[0].motivo, 'bot_apagado');
});

test('sin `bot_activo` en config el bot está ACTIVO (San Remo no tiene la clave)', async () => {
    reset({ botActivo: null });
    const t = await construirTanda('org', { ahora: AHORA });
    assert.strictEqual(t.enviables.length, 1);
});

test('"todavía es pronto" y "no dispara" NO ensucian la lista de excluidas', async () => {
    // Son el 90 % de las filas y no dicen nada de nadie; en la lista la harían ilegible.
    reset({ citas: [{ ...CITA, id: 'a9', service: 'Corte mujer y secado' }] });
    const t = await construirTanda('org', { ahora: AHORA });
    assert.strictEqual(t.excluidas.length, 0);
    assert.strictEqual(t.enviables.length, 0);
});

test('sin reglas no se lee ni una cita', async () => {
    reset({ reglas: [] });
    let leyo = false;
    const original = dbStub.getCitasParaSeguimiento;
    dbStub.getCitasParaSeguimiento = async (...a) => { leyo = true; return original(...a); };
    const t = await construirTanda('org', { ahora: AHORA });
    dbStub.getCitasParaSeguimiento = original;
    assert.strictEqual(leyo, false, 'no debería consultar la agenda sin reglas');
    assert.strictEqual(t.enviables.length, 0);
});

test('un servicio dado de baja deja la regla sin destino, no la manda igual', async () => {
    reset();
    const conBaja = CATALOGO.map(s =>
        s.nombre === 'Orising hidratación intensa' ? { ...s, activo: false } : s);
    const orig = dbStub.getAgentConfig;
    dbStub.getAgentConfig = async () => ({ services: conBaja });
    const t = await construirTanda('org', { ahora: AHORA });
    dbStub.getAgentConfig = orig;
    assert.strictEqual(t.enviables.length, 0);
    assert.strictEqual(t.reglas[0].resuelta.ok, false);
    // Y el motivo es el VERDADERO. Esta línea es la que da sentido al bloque: con el catálogo
    // pre-filtrado por `offerableCatalog`, la entrada desaparecía antes de que nadie la
    // buscara y el motivo salía 'destino_no_existe' — o sea, la dueña leía «puede que se haya
    // renombrado» cuando lo que pasaba es que ella misma lo había dado de baja. Se quitó el
    // filtro por eso, no por ahorrar una llamada.
    assert.strictEqual(t.reglas[0].resuelta.motivo, 'destino_inactivo');
    assert.ok(/baja/i.test(t.reglas[0].resuelta.mensaje), t.reglas[0].resuelta.mensaje);
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { fallos++; console.error(`FALLO - ${name}\n   ${e.message}`); }
    }
    console.log(fallos ? `\n❌ ${fallos} fallo(s)` : `\n✅ ${tests.length} en verde`);
    process.exit(fallos ? 1 : 0);
})();
