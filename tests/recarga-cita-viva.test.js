// Recarga de sesión con cita viva (incidente 04/08/2026).
//
// bot.js solo reconocía `estado_cita === 'pendiente_bizum'` (el flujo Bizum de San Remo) al
// rehidratar. Sante escribe 'confirmado', así que TODA recarga suya caía en la rama
// "clienta recurrente": clearServiceState le borraba el servicio y reservaConfirmada se
// quedaba en false. Dos daños medidos:
//
//   1. El bot le preguntaba "¿qué servicio quieres?" a una clienta que ya tenía cita
//      (34624184532, 03/08 08:22, tras 10 h de silencio).
//   2. El barrido de abandono marcaba 'abandonado' a 3 clientas con cita confirmada viva, y
//      eso las sacaba de getLeadsPendientesRecordatorio (db.js:475 exige estado='confirmado')
//      → sin recordatorio de 24 h. Una tenía la cita ese mismo día.
//
// Lo que este test protege por encima de todo: la reparación NO puede poner
// reservaConfirmada = true. Eso apagaría cinco de las seis redes del salón, y en muchas más
// sesiones que antes — el bug del 30/07/2026. La sesión sabe que hay cita por appointmentId
// y citaEnCurso, no por reservaConfirmada.
//
// Ejecuta las funciones REALES de bot.js con services/db stubeado.

process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };

// Estado del stub, reseteado por escenario.
let state;
function resetState() {
    state = { citas: [], lanzaLectura: false, leadsGuardados: [], warns: [], infos: [] };
}
resetState();

const dbPath = require.resolve('../services/db');
const dbReal = require(dbPath);
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        ...dbReal,
        async getUpcomingAppointments() {
            if (state.lanzaLectura) throw new Error('supabase caído');
            return state.citas;
        },
        async saveLead(orgId, datos) { state.leadsGuardados.push({ orgId, datos }); return 'lead-1'; },
        async findByPhone() { return null; },
    },
};

const loggerPath = require.resolve('../lib/logger');
const loggerReal = require(loggerPath);
require.cache[loggerPath].exports = {
    ...loggerReal,
    warn: (evento, meta) => state.warns.push({ evento, meta }),
    info: (evento, meta) => state.infos.push({ evento, meta }),
    error: () => {},
};

const { reconciliarCitaViva, marcarAbandonadaSiNoTieneCita, createEmptySession } =
    require('../bot')._internals;
const BOT = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const SERVICIO = { nombre: 'Orising hidratación intensa', duracion: 90, precio: 85 };

function sesionRecargada(over = {}) {
    const s = createEmptySession('34624184532', 'org-sante', '34624184532');
    s.orgType = 'salon';
    s.leadId = 'contact-1';
    s.selectedService = SERVICIO;
    s._decidirCitaVivaAlRecargar = true;
    s.history = [{ role: 'user', content: 'hola' }, { role: 'user', content: 'gracias' }];
    return Object.assign(s, over);
}

const citaViva = () => ([{
    id: 'apt-9aa5', service: 'Orising hidratación intensa',
    starts_at: new Date(Date.now() + 30 * 3600 * 1000).toISOString(),
    ends_at: new Date(Date.now() + 31.5 * 3600 * 1000).toISOString(),
    status: 'confirmed', stylist_id: 'sty-yulia', stylists: { name: 'Yulia' },
}]);

// ─── 1A · con cita viva ──────────────────────────────────────────────────────

test('1A · con cita viva: conserva el servicio y fija appointmentId + citaEnCurso', async () => {
    resetState();
    state.citas = citaViva();
    const s = sesionRecargada();

    await reconciliarCitaViva('org-sante', s, '34624184532');

    assert.strictEqual(s.selectedService, SERVICIO, 'el servicio NO se borra: es el de esta cita');
    assert.strictEqual(s.appointmentId, 'apt-9aa5');
    assert.ok(s.citaEnCurso, 'citaEnCurso puesta');
    assert.strictEqual(s.citaEnCurso.servicio, 'Orising hidratación intensa');
    assert.strictEqual(s.citaEnCurso.estilista, 'Yulia');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(s.citaEnCurso.fecha), 'fecha local normalizada');
    assert.ok(/^\d{2}:\d{2}$/.test(s.citaEnCurso.hora));
});

test('CONDICIÓN 1 · reservaConfirmada sigue en false → las redes siguen armadas', async () => {
    resetState();
    state.citas = citaViva();
    const s = sesionRecargada();

    await reconciliarCitaViva('org-sante', s, '34624184532');

    assert.strictEqual(s.reservaConfirmada, false,
        'ponerlo a true apagaría 5 de las 6 redes del salón (bug del 30/07/2026)');
    assert.strictEqual(s.bizumAsked, false, 'nada del flujo Bizum de San Remo');
});

test('CONDICIÓN 1 · las 5 guardas !reservaConfirmada siguen en el código', () => {
    // Quitarlas tendría el mismo efecto que poner reservaConfirmada=true.
    const guardas = BOT.match(/!session\.reservaConfirmada/g) || [];
    assert.ok(guardas.length >= 5, `esperaba >=5 guardas, encontradas ${guardas.length}`);
    // Y la red anti-cita-fantasma sigue sin depender de reservaConfirmada.
    const red = BOT.split('async function blockPhantomBookingClaim')[1].split('\nasync function ')[0];
    assert.ok(!/if\s*\(\s*session\.reservaConfirmada\s*\)\s*return/.test(red));
});

test('appointmentId cierra el reagendado que duplica', () => {
    // reagendarAppointmentId sale de session.appointmentId; sin él el reagendado hacía
    // INSERT en vez de UPDATE y duplicaba la cita.
    assert.ok(/session\.reagendarAppointmentId = session\.appointmentId/.test(BOT));
});

// ─── 1A · sin cita viva ──────────────────────────────────────────────────────

test('1A · sin cita por delante: clienta recurrente, se limpia el servicio (como siempre)', async () => {
    resetState();
    state.citas = [];
    const s = sesionRecargada();

    await reconciliarCitaViva('org-sante', s, '34624184532');

    assert.strictEqual(s.selectedService, null, 'sin cita, el servicio viejo no debe arrastrarse');
    assert.strictEqual(s.clienteRecurrente, true);
    assert.strictEqual(s.appointmentId, null);
    assert.strictEqual(s.citaEnCurso, null);
});

// ─── CONDICIÓN 2 · fallo de lectura ──────────────────────────────────────────

test('CONDICIÓN 2 · si Supabase falla: no se limpia el servicio NI se afirma que hay cita', async () => {
    resetState();
    state.lanzaLectura = true;
    const s = sesionRecargada();

    await reconciliarCitaViva('org-sante', s, '34624184532');

    assert.strictEqual(s.selectedService, SERVICIO, 'no se destruye estado con la BD caída');
    assert.strictEqual(s.appointmentId, null, 'no se afirma que hay cita');
    assert.strictEqual(s.citaEnCurso, null);
    assert.notStrictEqual(s.clienteRecurrente, true, 'tampoco se decide que es recurrente');
    assert.ok(state.warns.some(w => w.evento === 'recarga_cita_viva_lectura_fallida'),
        'el fallo queda en los logs');
});

test('idempotente: llamarla dos veces no repite la decisión', async () => {
    resetState();
    state.citas = citaViva();
    const s = sesionRecargada();

    await reconciliarCitaViva('org-sante', s, '34624184532');
    state.citas = [];                       // si volviera a decidir, limpiaría el servicio
    await reconciliarCitaViva('org-sante', s, '34624184532');

    assert.strictEqual(s.selectedService, SERVICIO);
    assert.strictEqual(s.appointmentId, 'apt-9aa5');
});

// ─── Barrido de abandono ─────────────────────────────────────────────────────

test('BARRIDO · con cita viva NO se marca abandonado', async () => {
    resetState();
    state.citas = citaViva();
    const s = sesionRecargada({ _decidirCitaVivaAlRecargar: false });
    s.partialData.telefono = '34624184532';

    await marcarAbandonadaSiNoTieneCita('org-sante', 'org-sante:34624184532', s);

    assert.strictEqual(state.leadsGuardados.length, 0, 'no se escribe estado abandonado');
    assert.strictEqual(s.appointmentId, 'apt-9aa5', 'y la sesión se entera para no repreguntarlo');
    assert.ok(state.infos.some(i => i.evento === 'abandono_evitado_cita_viva'));
});

test('BARRIDO · sin cita sí se marca abandonado', async () => {
    resetState();
    state.citas = [];
    const s = sesionRecargada({ _decidirCitaVivaAlRecargar: false });
    s.partialData.telefono = '34624184532';

    await marcarAbandonadaSiNoTieneCita('org-sante', 'org-sante:34624184532', s);

    assert.strictEqual(state.leadsGuardados.length, 1);
    assert.strictEqual(state.leadsGuardados[0].datos.estado_cita, 'abandonado');
    assert.strictEqual(s.leadStatus, 'abandoned');
});

test('BARRIDO · si la lectura falla NO se marca (el lado seguro es callar)', async () => {
    resetState();
    state.lanzaLectura = true;
    const s = sesionRecargada({ _decidirCitaVivaAlRecargar: false });
    s.partialData.telefono = '34624184532';

    await marcarAbandonadaSiNoTieneCita('org-sante', 'org-sante:34624184532', s);

    assert.strictEqual(state.leadsGuardados.length, 0);
    assert.notStrictEqual(s.leadStatus, 'abandoned');
    assert.ok(state.warns.some(w => w.evento === 'abandono_lectura_citas_fallida'));
});

test('BARRIDO · idempotencia: leadStatus abandoned y appointmentId lo saltan', () => {
    // La guarda de entrada del barrido, tal cual (abarca dos líneas).
    const guarda = BOT.match(
        /if \(session\.reservaConfirmada[\s\S]{0,200}?\) continue;/);
    assert.ok(guarda, 'no encuentro la guarda de entrada del barrido');
    assert.ok(/session\.appointmentId/.test(guarda[0]), 'una cita conocida lo salta de entrada');
    assert.ok(/session\.leadStatus === 'abandoned'/.test(guarda[0]),
        'sin esta guarda reescribía la misma fila cada 60 s durante ~90 min');
});

// ─── 1B · un solo camino de recarga ──────────────────────────────────────────

test('1B · la ventana 1h-2h ya no crea una sesión vacía sin leer SQLite', () => {
    assert.ok(!/else if \(Date\.now\(\) - existingSession\.lastUpdate > SESSION_TIMEOUT\)/.test(BOT),
        'la rama separada de timeout debe haber desaparecido');
    assert.ok(/userSessions\.delete\(sKey\);\s*\n\s*existingSession = null;/.test(BOT),
        'la sesión caducada se desaloja para caer por el camino de rehidratación');
    assert.strictEqual((BOT.match(/loadClient\(orgId, userPhone\)/g) || []).length, 1,
        'un solo punto de entrada a SQLite, y ahora lo alcanzan los dos casos');
});

// ─── Las tres ramas de rehidratación ─────────────────────────────────────────
// La rehidratación tiene tres caminos: (A) leadGuardado + 'pendiente_bizum' (San Remo),
// (B) leadGuardado + cualquier otro estado (Sante), (C) sin lead guardado. La rama B
// solo rescataba el `nombre` y tiraba el resto de partialData. Dos daños:
//   · leadGuardado se quedaba en false con el contacto YA guardado, así que el guardado
//     oportunista volvía a llamar a saveLead con estado_cita:'pendiente' en cada turno,
//     pisando contacts.estado='confirmado'. getLeadsPendientesRecordatorio exige
//     'confirmado' → la clienta perdía el recordatorio de 24 h. La misma pérdida del
//     incidente de este fichero, por un camino distinto.
//   · sin fecha_cita/hora_cita el guard anti-cierre del upselling ni se evalúa: su
//     puerta las exige.
const bloqueRecarga = BOT.split('if (persisted.leadGuardado) {')[1].split('userSessions.set(sKey, newSession);')[0];
const [cabeceraYBizum, ramaSante, ramaSinLead] = bloqueRecarga.split('} else {');
// Estas ramas llevan comentarios largos que citan el código viejo ("llamaba a
// clearServiceState"). Comprobar prohibiciones contra el texto crudo daría falsos
// positivos sobre la explicación, no sobre el código.
const soloCodigo = src => src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

test('las TRES ramas de recarga restauran partialData entero', () => {
    for (const [nombre, rama] of [['bizum', cabeceraYBizum], ['sante', ramaSante], ['sin-lead', ramaSinLead]]) {
        assert.ok(/newSession\.partialData = \{ telefono, \.\.\.persisted\.partialData \}/.test(rama),
            `la rama ${nombre} debe restaurar partialData completo`);
    }
});

test('la rama Sante marca leadGuardado: el contacto YA estaba guardado', () => {
    assert.ok(/newSession\.leadGuardado = true/.test(ramaSante),
        'con false, saveLead vuelve a escribir estado_cita:pendiente en cada turno');
});

test('el guardado oportunista sigue dependiendo de leadGuardado', () => {
    // Es lo que convierte el flag en una escritura real sobre contacts.estado.
    assert.ok(/if \(!session\.leadGuardado && session\.partialData\.telefono/.test(BOT));
    assert.ok(/saveLead\(orgId, \{ \.\.\.session\.partialData, estado_cita: 'pendiente'/.test(BOT));
});

test('CONDICIÓN 1 (fuente) · la rama Sante restaura DATOS pero no DECIDE', () => {
    // Restaurar partialData no puede colarse en una decisión: la cita se resuelve contra
    // Supabase en reconciliarCitaViva, no contra partialData.estado_cita.
    const codigo = soloCodigo(ramaSante);
    for (const prohibido of ['reservaConfirmada = true', 'bizumAsked = true', 'bizumPendiente = true',
        "leadStatus = 'completed'", 'appointmentId = persisted']) {
        assert.ok(!codigo.includes(prohibido), `la rama Sante no puede fijar ${prohibido}`);
    }
    assert.ok(/_decidirCitaVivaAlRecargar = true/.test(codigo), 'la decisión se sigue aplazando');
    assert.ok(!/clearServiceState\(/.test(codigo), 'y sigue sin borrar el servicio aquí');
});

// ─── San Remo no se toca ─────────────────────────────────────────────────────

test('San Remo: la rama pendiente_bizum sigue intacta', () => {
    const rama = BOT.split("if (estadoCita === 'pendiente_bizum')")[1].split('} else {')[0];
    for (const linea of ['newSession.reservaConfirmada = true', 'newSession.bizumAsked = true',
        'newSession.bizumPendiente = true', "newSession.leadStatus = 'completed'"]) {
        assert.ok(rama.includes(linea), `falta en la rama Bizum: ${linea}`);
    }
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { console.error(`fail - ${name}`); console.error('  ' + e.message); fallos++; }
    }
    if (fallos) { console.error(`\n${fallos} test(s) fallidos`); process.exit(1); }
    console.log('\nTests de recarga con cita viva OK');
    process.exit(0);
})();
