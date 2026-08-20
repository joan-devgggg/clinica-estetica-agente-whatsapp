/**
 * tests/auditoria-cita.test.js — Auditoría mínima de appointments (migración 033).
 *
 * Una cita solo tenía `created_at`. Reagendar hace UPDATE in-place, cancelar cambia
 * `status`, el panel edita servicio y estilista: todo se pisa en el sitio. Cuando una
 * clienta decía "yo no pedí esa hora" no había NADA que mirar.
 *
 * Lo que se comprueba aquí es lo que la base de datos no puede saber sola (el trigger pone
 * `updated_at`, pero no quién ni desde dónde):
 *   · `updated_by` sale del actor que declara el llamante, y si no lo declara queda NULL —
 *     "no consta" — en vez de atribuírselo al bot por defecto.
 *   · `last_change` guarda el de → a de los campos que le importan a alguien, y NO se
 *     ensucia con los interruptores mecánicos de los workers.
 *
 * ── 20/08/2026: el mismo instante contado como cambio, y lo que colgaba de eso ───────────
 *
 * La comparación era `String(previo) === String(nuevo)`, y los dos lados escriben la hora de
 * forma distinta: Supabase devuelve '+00:00' y nosotros escribimos '.000Z'. Medido en
 * producción: 10 de las 47 filas de last_change de Sante (21 %) registran un cambio de
 * horario que nunca ocurrió.
 *
 * No era solo ruido. De ese mismo falso positivo colgaba `recordatorio_enviado`, que se
 * reiniciaba «si el formulario trae fecha y hora» — y el panel las manda SIEMPRE. Resultado
 * esa semana: 3 de los 18 recordatorios de Sante salieron dos veces, dos de ellos a 27 y 49
 * minutos de la cita, por guardados que no movieron nada. Los seis bloques nuevos prueban
 * las dos mitades y, sobre todo, sus CONTROLES: que una cita movida de verdad siga
 * rearmando, y que sin estado previo se rearme igual (el lado recuperable).
 *
 * Sabotajes medidos (cp previo):
 *   · volver a comparar instantes como cadenas ................................. 3 rojos
 *   · rearmar siempre que el UPDATE reescriba el horario ....................... 2 rojos
 *
 * Que el primero tumbe TRES y el segundo DOS no es redundancia: son dos arreglos encadenados
 * y el de arriba tapa al de abajo. Con las cadenas de vuelta, el rearme vuelve a dispararse
 * aunque su condición esté bien escrita — que es exactamente cómo un bug de formato acabó
 * mandando WhatsApps.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const CITA = 'apt-1';

// Estado "previo" que devolverá la lectura de auditoría.
let filaPrevia = {
    starts_at: '2026-08-20T10:00:00.000Z',
    ends_at: '2026-08-20T11:00:00.000Z',
    service: 'Corte',
    status: 'confirmed',
    stylist_id: 'sty-1',
    notes: null,
};
let lecturaFalla = false;
const sqlCalls = [];

function makeBuilder() {
    const state = { table: null, op: 'select', payload: null, filters: [], single: false };
    const resolve = () => { sqlCalls.push(state); return Promise.resolve(respond(state)); };
    const b = {
        from(t) { state.table = t; return b; },
        select(cols) { state.cols = cols; return b; },
        insert(p) { state.op = 'insert'; state.payload = p; return b; },
        update(p) { state.op = 'update'; state.payload = p; return b; },
        eq(k, v) { state.filters.push(['eq', k, v]); return b; },
        neq() { return b; }, in() { return b; }, is() { return b; }, not() { return b; },
        lte() { return b; }, gte() { return b; }, or() { return b; }, order() { return b; }, limit() { return b; },
        single() { state.single = true; return resolve(); },
        maybeSingle() { state.single = true; return resolve(); },
        then(onF, onR) { return resolve().then(onF, onR); },
    };
    return b;
}

function respond(state) {
    const { table, op, single } = state;
    if (table === 'appointments' && op === 'update') {
        return { data: single ? { id: CITA, contact_id: 'c-1' } : [{ id: CITA }], error: null };
    }
    if (table === 'appointments') {
        if (lecturaFalla) return { data: null, error: { message: 'timeout', code: '57014' } };
        return { data: single ? { ...filaPrevia } : [{ ...filaPrevia }], error: null };
    }
    return { data: single ? null : [], error: null };
}

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from(t) { return makeBuilder().from(t); } },
};

const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

const db = require('../services/db');

const updateDeCita = () => [...sqlCalls].reverse().find(c => c.table === 'appointments' && c.op === 'update');

test('mover una cita desde el panel deja quién y de dónde a dónde', async () => {
    sqlCalls.length = 0;
    await db.updateAppointment(ORG, CITA, {
        fecha: '2026-08-21', hora: '17:30', duracionMin: 60,
        actor: 'panel:11111111-2222-3333-4444-555555555555',
    });

    const upd = updateDeCita().payload;
    assert.strictEqual(upd.updated_by, 'panel:11111111-2222-3333-4444-555555555555');
    assert.ok(upd.last_change, 'falta last_change');
    assert.strictEqual(upd.last_change.by, 'panel:11111111-2222-3333-4444-555555555555');
    assert.strictEqual(upd.last_change.de.starts_at, '2026-08-20T10:00:00.000Z');
    assert.strictEqual(upd.last_change.a.starts_at, upd.starts_at);
    // No se cuela lo que no ha cambiado.
    assert.ok(!('service' in upd.last_change.de));
});

test('sin actor declarado, updated_by NO se toca: "no consta" ≠ "fue el bot"', async () => {
    sqlCalls.length = 0;
    await db.updateAppointment(ORG, CITA, { servicio: 'Balayage' });
    const upd = updateDeCita().payload;
    assert.ok(!('updated_by' in upd), 'no se debe inventar un autor');
    assert.strictEqual(upd.last_change.by, null);
    assert.strictEqual(upd.last_change.de.service, 'Corte');
    assert.strictEqual(upd.last_change.a.service, 'Balayage');
});

test('los interruptores de los workers no ensucian last_change', async () => {
    sqlCalls.length = 0;
    await db.updateAppointment(ORG, CITA, { resenaEnviada: true, actor: 'worker:review' });
    const upd = updateDeCita().payload;
    assert.strictEqual(upd.resena_enviada, true);
    assert.strictEqual(upd.updated_by, 'worker:review');
    // El último cambio de VERDAD (la hora, el servicio) tiene que sobrevivir a que un
    // worker marque una casilla mecánica.
    assert.ok(!('last_change' in upd), 'marcar reseña enviada no es un cambio auditable');
});

test('escribir el mismo valor no cuenta como cambio', async () => {
    sqlCalls.length = 0;
    await db.updateAppointment(ORG, CITA, { servicio: 'Corte', actor: 'bot' });
    const upd = updateDeCita().payload;
    assert.strictEqual(upd.service, 'Corte');
    assert.ok(!('last_change' in upd));
});

test('si no se puede leer el estado previo, el cambio se guarda igual', async () => {
    sqlCalls.length = 0;
    logs.length = 0;
    lecturaFalla = true;
    try {
        const r = await db.updateAppointment(ORG, CITA, { estado: 'cancelled', actor: 'bot' });
        assert.ok(r, 'la cancelación debe guardarse aunque no se pueda auditar');
    } finally {
        lecturaFalla = false;
    }
    const upd = updateDeCita().payload;
    assert.strictEqual(upd.status, 'cancelled');
    assert.ok(!('last_change' in upd));
    assert.ok(logs.some(l => l.evento === 'auditoria_cita_sin_estado_previo'));
});

// ─── El mismo instante escrito de dos formas, y lo que colgaba de confundirlo ────────────
//
// Supabase DEVUELVE '2026-08-20T10:00:00+00:00' y nosotros ESCRIBIMOS
// '2026-08-20T10:00:00.000Z'. Son el mismo momento y `String(a) === String(b)` decía que no.
// Medido el 20/08/2026: 10 de las 47 filas de last_change de Sante (21 %) registran un
// cambio de horario que nunca ocurrió. Y de ese falso positivo colgaba el rearme del
// recordatorio, así que tres clientas recibieron uno duplicado —dos de ellas a 27 y 49
// minutos de la cita— por guardados del panel que no movieron nada.
//
// El fixture usa la forma de SUPABASE a propósito: con la nuestra el bug no se ve.
const MISMO_INSTANTE = { fecha: '2026-08-20', hora: '12:00', duracionMin: 60 };  // = 10:00Z en agosto

test('el mismo instante en otro formato NO es un cambio', async () => {
    sqlCalls.length = 0;
    const antes = { ...filaPrevia };
    filaPrevia = { ...filaPrevia, starts_at: '2026-08-20T10:00:00+00:00', ends_at: '2026-08-20T11:00:00+00:00' };
    try {
        await db.updateAppointment(ORG, CITA, { ...MISMO_INSTANTE, actor: 'panel:x' });
    } finally { filaPrevia = antes; }
    const upd = updateDeCita().payload;
    assert.strictEqual(upd.starts_at, '2026-08-20T10:00:00.000Z', 'el UPDATE sí reescribe el horario');
    assert.ok(!('last_change' in upd),
        `guardar la misma hora no es un cambio: ${JSON.stringify(upd.last_change)}`);
});

test('guardar sin mover la cita NO rearma el recordatorio', async () => {
    // El caso real: el panel manda fecha y hora en TODOS sus guardados, así que cambiar la
    // estilista traía el horario igual y el flag se reiniciaba lo mismo.
    sqlCalls.length = 0;
    const antes = { ...filaPrevia };
    filaPrevia = { ...filaPrevia, starts_at: '2026-08-20T10:00:00+00:00', ends_at: '2026-08-20T11:00:00+00:00' };
    try {
        await db.updateAppointment(ORG, CITA, { ...MISMO_INSTANTE, stylistId: 'sty-2', actor: 'panel:x' });
    } finally { filaPrevia = antes; }
    const upd = updateDeCita().payload;
    assert.strictEqual(upd.stylist_id, 'sty-2', 'el cambio que SÍ pidió el panel se guarda');
    assert.ok(!('recordatorio_enviado' in upd),
        'se rearmó el recordatorio de una cita que no se ha movido: eso es el duplicado');
    assert.ok(logs.some(l => l.evento === 'cita_recordatorio_rearme' && l.rearmado === false),
        'y la decisión queda registrada, no en silencio');
});

test('mover la cita de verdad SÍ rearma el recordatorio', async () => {
    // El CONTROL del bloque anterior: si esto deja de rearmar, una clienta se planta a la
    // hora vieja con el único aviso que recibió diciendo otra cosa.
    sqlCalls.length = 0;
    await db.updateAppointment(ORG, CITA, { fecha: '2026-08-21', hora: '17:30', duracionMin: 60, actor: 'panel:x' });
    const upd = updateDeCita().payload;
    assert.strictEqual(upd.recordatorio_enviado, false, 'una cita movida vuelve a deber su recordatorio');
    assert.ok(upd.last_change?.a?.starts_at, 'y el movimiento queda en la traza');
});

test('alargar la cita sin moverla no rearma: el recordatorio dice la hora de EMPEZAR', async () => {
    sqlCalls.length = 0;
    const antes = { ...filaPrevia };
    filaPrevia = { ...filaPrevia, starts_at: '2026-08-20T10:00:00+00:00', ends_at: '2026-08-20T11:00:00+00:00' };
    try {
        await db.updateAppointment(ORG, CITA, { ...MISMO_INSTANTE, duracionMin: 120, actor: 'panel:x' });
    } finally { filaPrevia = antes; }
    const upd = updateDeCita().payload;
    assert.strictEqual(upd.ends_at, '2026-08-20T12:00:00.000Z', 'la duración sí cambia');
    assert.ok(upd.last_change?.a?.ends_at, 'y se audita, que para eso está');
    assert.ok(!('recordatorio_enviado' in upd),
        '«a las 12:00 del jueves» sigue siendo verdad: no hay nada que rearmar');
});

test('sin estado previo se rearma: el lado recuperable es el recordatorio de más', async () => {
    sqlCalls.length = 0;
    logs.length = 0;
    lecturaFalla = true;
    try {
        await db.updateAppointment(ORG, CITA, { ...MISMO_INSTANTE, actor: 'panel:x' });
    } finally { lecturaFalla = false; }
    const upd = updateDeCita().payload;
    assert.strictEqual(upd.recordatorio_enviado, false,
        'sin poder mirar, entre un recordatorio de más y una clienta a la hora vieja se elige el primero');
    assert.ok(logs.some(l => l.evento === 'cita_recordatorio_rearme' && l.motivo === 'sin_estado_previo'),
        'y se dice por qué, que es lo que distingue una decisión de un descuido');
});

test('CONTROL: si quien llama fija recordatorioEnviado, manda él', async () => {
    sqlCalls.length = 0;
    await db.updateAppointment(ORG, CITA, {
        fecha: '2026-08-21', hora: '17:30', duracionMin: 60, recordatorioEnviado: true, actor: 'worker:reminder',
    });
    const upd = updateDeCita().payload;
    assert.strictEqual(upd.recordatorio_enviado, true, 'un valor explícito no lo pisa la heurística');
});

test('el barrido que auto-completa citas firma su escritura', async () => {
    sqlCalls.length = 0;
    await db.autoCompleteAppointments(ORG);
    const upd = sqlCalls.find(c => c.table === 'appointments' && c.op === 'update');
    assert.strictEqual(upd.payload.status, 'completed');
    assert.strictEqual(upd.payload.updated_by, 'worker:auto-complete');
});
