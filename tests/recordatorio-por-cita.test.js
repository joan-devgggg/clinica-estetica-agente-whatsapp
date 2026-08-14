// El recordatorio del salón cuelga de la CITA, no de la ficha (H2 del nocturno 14/08).
//
// Lo que costó (medido en producción esa noche, 19 citas futuras confirmadas):
//   · Dasha Kotenko: cita del panel sin tocar la ficha (estado 'pendiente') → recordatorio
//     que no salía nunca, sin síntoma.
//   · Barbora Jalova: su respuesta al recordatorio regresó la ficha a 'pendiente'
//     (bot.js, saveLead de fin de turno) — un «gracias!» la víspera costaba el recordatorio.
//   · Nieves Armengol: ficha con fecha_cita vieja (08/08) y cita real el 29/08 → ventana
//     calculada con la fecha equivocada.
//
// Aquí se fija: (1) el mapeo puro cita+contacto → record del worker, con la GUARDA DE
// TRANSICIÓN que hace seguro desplegar el código antes que la migración 042 (nadie recibe
// el recordatorio dos veces); (2) el enrutado por tipo de org (salón → appointments,
// San Remo → ficha, byte por byte); (3) pending-outbound, el buzón por el que el bot ve
// los salientes automáticos (H1).
//
// Visto fallar sin el arreglo (sabotajes con cp previo, 14/08):
//   · guarda de transición quitada → rojo el bloque de la guarda;
//   · enrutado devuelto a la ficha para todo → rojo el bloque de enrutado.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');

// ─── Doble de supabase, encadenable y consultable ────────────────────────────
// Cada cadena `.from(...).select(...).eq(...)…` es un thenable: al await se registra la
// consulta (tabla + filtros) y responde lo que diga `responder(consulta)`. Así el test
// afirma QUÉ se consultó (enrutado) además de qué se devolvió.
const consultas = [];
let responder = () => [];
function makeQuery(tabla) {
    const q = { tabla, filtros: [], op: 'select' };
    const api = {
        select() { return api; },
        update(vals) { q.op = 'update'; q.vals = vals; return api; },
        eq(col, v) { q.filtros.push(['eq', col, v]); return api; },
        gt(col, v) { q.filtros.push(['gt', col, v]); return api; },
        in(col, v) { q.filtros.push(['in', col, v]); return api; },
        not(col, op, v) { q.filtros.push(['not', col, op, v]); return api; },
        or(expr) { q.filtros.push(['or', expr]); return api; },
        order() { return api; }, range() { return api; }, limit() { return api; },
        maybeSingle() { return api; }, single() { return api; },
        then(resolve) { consultas.push(q); resolve({ data: responder(q), error: null }); },
    };
    return api;
}
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from: makeQuery },
};

const db = require('../services/db');
const { construirPendientesDesdeCitas } = db;
const { SANTE_ORG_ID, SANREMO_ORG_ID } = require('../services/org-registry');
const {
    notePendingOutboundTurn, drainPendingOutboundTurns, _resetPendingOutbound,
} = require('../services/pending-outbound');

// La cita de Barbora, literal: 14/08 08:00 UTC = 10:00 Madrid.
const CITA_BARBORA = {
    id: 'apt-barbora', contact_id: 'ct-barbora', full_name: 'Barbora Jalova',
    phone: null, starts_at: '2026-08-14T08:00:00+00:00',
};
const FICHA_BARBORA = {
    id: 'ct-barbora', full_name: 'Barbora Jalova', wa_phone: '34603426950',
    language: 'es', is_blacklisted: false, recordatorio_enviado: true,
    fecha_cita: '2026-08-14', metadata: { wa_jid: null },
};

const mapa = (...contactos) => new Map(contactos.map(c => [c.id, c]));

// ─── 1 · El mapeo puro ───────────────────────────────────────────────────────

test('la fecha y la hora del record salen de starts_at en hora de MADRID', () => {
    const ficha = { ...FICHA_BARBORA, recordatorio_enviado: false };
    const [r] = construirPendientesDesdeCitas([CITA_BARBORA], mapa(ficha));
    assert.strictEqual(r.fecha_cita, '2026-08-14');
    assert.strictEqual(r.hora_cita, '10:00', '08:00 UTC son las 10:00 de Madrid');
    assert.strictEqual(r.esCita, true, 'el record declara que su marca vive en la cita');
    assert.strictEqual(r.id, 'apt-barbora');
    assert.strictEqual(r.telefono, '34603426950');
    assert.strictEqual(r.language, 'es');
});

test('GUARDA DE TRANSICIÓN: la ficha ya recordó ESTE día → la cita no entra (cero dobles)', () => {
    // Barbora literal: recordatorio_enviado=true y fecha_cita = el día de la cita.
    const out = construirPendientesDesdeCitas([CITA_BARBORA], mapa(FICHA_BARBORA));
    assert.strictEqual(out.length, 0,
        'sin la guarda, el primer tic tras el despliegue le reenviaría el recordatorio que recibió ayer');
});

test('la marca vieja de OTRO día NO bloquea: esa clienta no recibió el de esta cita', () => {
    // Nieves: flag true pero fecha_cita=08/08; su cita real es el 29/08.
    const ficha = { ...FICHA_BARBORA, recordatorio_enviado: true, fecha_cita: '2026-08-08' };
    const out = construirPendientesDesdeCitas([CITA_BARBORA], mapa(ficha));
    assert.strictEqual(out.length, 1, 'una marca rancia no puede costar un recordatorio real');
});

test('bloqueada → fuera, como en el camino por ficha', () => {
    const ficha = { ...FICHA_BARBORA, recordatorio_enviado: false, is_blacklisted: true };
    assert.strictEqual(construirPendientesDesdeCitas([CITA_BARBORA], mapa(ficha)).length, 0);
});

test('cita sin contacto NO se tira: entra con los datos de la propia cita (regla 3)', () => {
    const huerfana = { ...CITA_BARBORA, contact_id: null, phone: '34600111222' };
    const [r] = construirPendientesDesdeCitas([huerfana], mapa());
    assert.ok(r, 'tirarla en silencio es cómo Dasha se quedó sin recordatorio sin que nadie lo viera');
    assert.strictEqual(r.telefono, '34600111222');
    assert.strictEqual(r.nombre, 'Barbora Jalova');
});

test('el nombre prefiere el primero USABLE de ficha/cita (el vacío de cita es "", no null)', () => {
    const citaSinNombre = { ...CITA_BARBORA, full_name: '' };
    const fichaSinNombre = { ...FICHA_BARBORA, recordatorio_enviado: false, full_name: null };
    // ficha null + cita '' → nada usable → null (y motivoNoEnviable avisará)
    assert.strictEqual(construirPendientesDesdeCitas([citaSinNombre], mapa(fichaSinNombre))[0].nombre, null);
    // ficha null + cita con nombre → el de la cita
    assert.strictEqual(construirPendientesDesdeCitas([CITA_BARBORA], mapa(fichaSinNombre))[0].nombre, 'Barbora Jalova');
});

// ─── 2 · El enrutado por tipo de org ─────────────────────────────────────────

test('SALÓN: getAppointmentsPendientesRecordatorio consulta appointments (status confirmed, flag false)', async () => {
    consultas.length = 0;
    responder = q => (q.tabla === 'appointments' ? [CITA_BARBORA] : [{ ...FICHA_BARBORA, recordatorio_enviado: false }]);
    const out = await db.getAppointmentsPendientesRecordatorio(SANTE_ORG_ID);
    const tablas = consultas.map(q => q.tabla);
    assert.deepStrictEqual(tablas, ['appointments', 'contacts'],
        'el salón lee la agenda, no el embudo de la ficha');
    const filtros = consultas[0].filtros.map(f => f.slice(0, 2).join(':'));
    assert.ok(filtros.includes('eq:status'), 'filtra por status de la CITA');
    assert.ok(filtros.includes('eq:recordatorio_enviado'), 'filtra por el flag de la CITA');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].esCita, true);
});

test('SAN REMO: sigue leyendo contacts por estado, byte por byte', async () => {
    consultas.length = 0;
    responder = () => [];
    await db.getAppointmentsPendientesRecordatorio(SANREMO_ORG_ID);
    assert.strictEqual(consultas.length, 1);
    assert.strictEqual(consultas[0].tabla, 'contacts');
    assert.ok(consultas[0].filtros.some(f => f[0] === 'eq' && f[1] === 'estado' && f[2] === 'confirmado'),
        'la regla de oro: el camino del restaurante no cambia');
});

test('marcarRecordatorioCitaSent escribe en appointments con updated_by=worker:reminder', async () => {
    consultas.length = 0;
    responder = () => [{ id: 'apt-barbora' }];
    await db.marcarRecordatorioCitaSent(SANTE_ORG_ID, 'apt-barbora');
    const q = consultas[0];
    assert.strictEqual(q.tabla, 'appointments');
    assert.strictEqual(q.op, 'update');
    assert.strictEqual(q.vals.recordatorio_enviado, true);
    assert.strictEqual(q.vals.updated_by, 'worker:reminder', 'migración 033: quién escribe, dicho');
});

// ─── 3 · pending-outbound: el buzón que hace visible el saliente (H1) ────────

test('anotar con dígitos y drenar con @c.us es la MISMA conversación', () => {
    _resetPendingOutbound();
    notePendingOutboundTurn(SANTE_ORG_ID, '34603426950', 'Te recordamos tu cita…', { ttlMs: 1000 * 60 });
    const turnos = drainPendingOutboundTurns(SANTE_ORG_ID, '34603426950@c.us', 60000);
    assert.strictEqual(turnos.length, 1, 'el worker conoce dígitos y el bot @c.us; la clave debe normalizar');
    assert.strictEqual(turnos[0].role, 'assistant');
    assert.strictEqual(turnos[0].content, 'Te recordamos tu cita…');
    assert.strictEqual(drainPendingOutboundTurns(SANTE_ORG_ID, '34603426950', 60000).length, 0,
        'drenar vacía: el mismo turno no puede entrar dos veces al historial');
});

test('un turno caducado no se drena (ttl propio manda sobre el timeout de sesión)', () => {
    _resetPendingOutbound();
    notePendingOutboundTurn(SANTE_ORG_ID, '34603426950', 'viejo', { ttlMs: -1 });
    notePendingOutboundTurn(SANTE_ORG_ID, '34603426950', 'vigente', { ttlMs: 60000 });
    const turnos = drainPendingOutboundTurns(SANTE_ORG_ID, '34603426950', 60000);
    assert.deepStrictEqual(turnos.map(t => t.content), ['vigente']);
});

test('otra org, mismo teléfono: buzones separados (multi-tenancy)', () => {
    _resetPendingOutbound();
    notePendingOutboundTurn(SANTE_ORG_ID, '34600000001', 'de sante');
    assert.strictEqual(drainPendingOutboundTurns(SANREMO_ORG_ID, '34600000001', 60000).length, 0);
    assert.strictEqual(drainPendingOutboundTurns(SANTE_ORG_ID, '34600000001', 60000).length, 1);
});
