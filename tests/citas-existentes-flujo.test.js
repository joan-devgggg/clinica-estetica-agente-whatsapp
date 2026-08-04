// Flujos sobre una cita que YA existe: consultar, referirse, cambiar y cancelar.
//
// Complementa tests/consulta-cita-existente.test.js (que cubre las piezas puras) ejercitando
// handleCitasExistentes de punta a punta contra un doble de Supabase, que es donde viven las
// garantías que de verdad importan:
//   · la cita se encuentra aunque cuelgue de un contacto DUPLICADO (incidente Valeria);
//   · no se dice "cancelada ✅" sin que la escritura haya ocurrido;
//   · con dos citas vivas nunca se adivina cuál;
//   · quien NO tiene ninguna cita sigue reservando exactamente igual que antes.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');

// ─── Doble de Supabase ──────────────────────────────────────────────────────────
// Se inyecta ANTES de require('../bot') para que db.js lo tome. Devuelve filas por tabla y
// respeta .single()/.maybeSingle() para que las funciones reales de db.js se comporten igual
// que en producción: lo que se prueba es el camino de datos completo, no un mock de db.
let filasPorTabla = {};
let errorPorTabla = {};

function makeQuery(tabla) {
    let singular = false;
    const api = {
        select() { return api; },
        eq() { return api; },
        in() { return api; },
        neq() { return api; },
        gte() { return api; },
        lte() { return api; },
        order() { return api; },
        limit() { return api; },
        update() { return api; },
        insert() { return api; },
        delete() { return api; },
        maybeSingle() { singular = true; return api; },
        single() { singular = true; return api; },
        then(res, rej) {
            const error = errorPorTabla[tabla] || null;
            const filas = filasPorTabla[tabla] || [];
            const data = error ? null : (singular ? (filas[0] || null) : filas);
            return Promise.resolve({ data, error }).then(res, rej);
        },
    };
    return api;
}

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from: makeQuery },
};

const calendarSante = require('../services/calendar-sante');
const { buildSystemPrompt } = require('../services/providers/openai');
const {
    handleCitasExistentes, matchCitaByPistas, ampliacionSolapa, dowLunes0,
} = require('../bot')._internals;

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// Cita real tal y como sale de Supabase (con el join de stylists).
function filaCita({ id = 'apt-1', service = 'Color raíz', starts = '2026-08-06T18:00:00+02:00',
    ends = '2026-08-06T19:30:00+02:00', stylist = 'Irina', stylistId = 's-1' } = {}) {
    return {
        id, service, starts_at: starts, ends_at: ends, status: 'confirmed',
        stylist_id: stylistId, stylists: stylist ? { name: stylist } : null,
    };
}

function sesion(extra = {}) {
    return {
        orgId: ORG, orgType: 'salon', leadId: 'c-canonico', language: 'es',
        reservaConfirmada: false, appointmentId: null,
        selectedService: null, selectedStylist: null,
        slotsProposed: false, citaEnCurso: null, pendingCitaAccion: null,
        pendingEscalation: false, upsellingAccepted: [],
        partialData: { nombre: 'Valeria', telefono: '34611209542' },
        history: [],
        ...extra,
    };
}

// Ejecuta un turno y devuelve { manejado, enviados, session }.
async function turno(session, texto) {
    const enviados = [];
    const client = { sendMessage: async (_to, t) => { enviados.push(t); }, getChatById: async () => ({ sendStateTyping: async () => {} }) };
    const _send = async (t) => { enviados.push(t); };
    const manejado = await handleCitasExistentes(client, ORG, session, texto, _send, '34611209542');
    return { manejado, enviados, session, texto: enviados.join('\n') };
}

function reset() {
    filasPorTabla = { contacts: [{ id: 'c-canonico', wa_phone: '34611209542', created_at: '2025-01-01T00:00:00Z' }] };
    errorPorTabla = {};
}

const results = [];
async function test(name, fn) {
    reset();
    const cancelOriginal = calendarSante.cancelAppointment;
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
    finally { calendarSante.cancelAppointment = cancelOriginal; }
    results.push(name);
}

async function main() {

// ─── Consultar ──────────────────────────────────────────────────────────────────

await test('consultar · "¿a qué hora tengo la cita?" responde con la cita real, sin LLM', async () => {
    filasPorTabla.appointments = [filaCita()];
    const r = await turno(sesion(), '¿a qué hora tengo la cita?');
    assert.strictEqual(r.manejado, true, 'el turno debe resolverse aquí, sin llegar al LLM');
    assert.ok(r.texto.includes('18:00'), `falta la hora real: ${r.texto}`);
    assert.ok(r.texto.includes('Color raíz'));
    assert.ok(r.texto.includes('Irina'), '"¿con quién voy?" necesita la estilista');
});

await test('consultar · el caso VALERIA: la cita cuelga del contacto DUPLICADO', async () => {
    // El contacto canónico no tiene citas; la cita está colgada del duplicado creado por el
    // panel al teclear el teléfono sin prefijo. Antes esto respondía "no tienes ninguna cita".
    filasPorTabla.contacts = [
        { id: 'c-canonico',  wa_phone: '34611209542', created_at: '2025-01-01T00:00:00Z' },
        { id: 'c-duplicado', wa_phone: '611209542',   created_at: '2026-08-01T10:00:00Z' },
    ];
    filasPorTabla.appointments = [filaCita({ id: 'apt-dup' })];
    const r = await turno(sesion(), '¿a qué hora tengo la cita?');
    assert.strictEqual(r.manejado, true);
    assert.ok(r.texto.includes('18:00'), 'la cita del duplicado tiene que verse');
    assert.ok(!/no me consta/i.test(r.texto));
});

await test('consultar · sin citas lo dice, no inventa ninguna', async () => {
    filasPorTabla.appointments = [];
    const r = await turno(sesion(), '¿a qué hora tengo la cita?');
    assert.strictEqual(r.manejado, true);
    assert.ok(/no me consta/i.test(r.texto));
});

await test('consultar · si la LECTURA falla no afirma que no tiene citas', async () => {
    // "No tienes ninguna cita" y "no he podido comprobarlo" no son lo mismo. Afirmar lo
    // primero sin haber leído es la cita fantasma en versión lectura.
    errorPorTabla.contacts = { message: 'timeout', code: '57014' };
    const r = await turno(sesion(), '¿a qué hora tengo la cita?');
    assert.strictEqual(r.manejado, true);
    assert.ok(!/no me consta/i.test(r.texto), `no puede negar la cita sin haber leído: ${r.texto}`);
});

await test('consultar · una hora que no casa ninguna cita no se responde con otra', async () => {
    filasPorTabla.appointments = [filaCita()];   // 18:00
    const r = await turno(sesion(), '¿a qué hora es mi cita de las 11?');
    assert.strictEqual(r.manejado, true);
    assert.ok(/no encuentro/i.test(r.texto), `debe admitir que no cuadra: ${r.texto}`);
    assert.ok(r.texto.includes('18:00'), 'y enumerar lo que sí tiene');
});

// ─── Referirse a la cita ────────────────────────────────────────────────────────

await test('referirse · "es para mi cita de las 6" carga la cita y NO abre una reserva', async () => {
    filasPorTabla.appointments = [filaCita()];   // 18:00
    const s = sesion();
    const r = await turno(s, 'es para mi cita de las 6');
    assert.strictEqual(r.manejado, false, 'el turno sigue, pero ya sobre la cita correcta');
    assert.strictEqual(s.citaEnCurso?.appointmentId, 'apt-1');
    assert.strictEqual(s.appointmentId, 'apt-1', 'sin id real, cancelar/cambiar no pueden operar');
    assert.strictEqual(s.reservaConfirmada, true);
    assert.strictEqual(r.enviados.length, 0, 'identificar la cita no manda ningún mensaje');
});

await test('referirse · con DOS citas pregunta cuál, no adivina', async () => {
    filasPorTabla.appointments = [
        filaCita({ id: 'apt-1', service: 'Color raíz', starts: '2026-08-06T18:00:00+02:00' }),
        filaCita({ id: 'apt-2', service: 'Manicura', starts: '2026-08-04T11:00:00+02:00', stylist: 'Olgha', stylistId: 's-2' }),
    ];
    const s = sesion();
    const r = await turno(s, 'quiero añadir algo a mi cita');
    assert.strictEqual(r.manejado, true);
    assert.ok(/cu[aá]l/i.test(r.texto), `debe preguntar cuál: ${r.texto}`);
    assert.strictEqual(s.citaEnCurso, null, 'no puede haber elegido una por su cuenta');
    assert.strictEqual(s.pendingCitaAccion?.estado, 'elegir');
});

await test('referirse · la respuesta "la del jueves" resuelve la ambigüedad', async () => {
    filasPorTabla.appointments = [
        filaCita({ id: 'apt-1', service: 'Color raíz', starts: '2026-08-06T18:00:00+02:00' }),
        filaCita({ id: 'apt-2', service: 'Manicura', starts: '2026-08-04T11:00:00+02:00', stylistId: 's-2' }),
    ];
    const s = sesion();
    await turno(s, 'quiero añadir algo a mi cita');
    const r = await turno(s, 'la del jueves');   // 2026-08-06 es jueves
    assert.strictEqual(r.manejado, false, 'resuelta la duda, el turno sigue su curso');
    assert.strictEqual(s.citaEnCurso?.appointmentId, 'apt-1');
});

// ─── Cancelar ───────────────────────────────────────────────────────────────────

await test('cancelar · el primer turno NO escribe: recita la cita y pregunta', async () => {
    filasPorTabla.appointments = [filaCita()];
    let escrituras = 0;
    calendarSante.cancelAppointment = async () => { escrituras++; return { success: true }; };
    const s = sesion();
    const r = await turno(s, 'quiero cancelar mi cita');
    assert.strictEqual(r.manejado, true);
    assert.strictEqual(escrituras, 0, 'no se cancela sobre una intención, se pregunta antes');
    assert.ok(r.texto.includes('18:00') && r.texto.includes('Color raíz'), 'debe recitar la cita');
    assert.ok(!/cancelada/i.test(r.texto), 'no puede darla por cancelada');
    assert.strictEqual(s.pendingCitaAccion?.estado, 'confirmar');
});

await test('cancelar · el "sí" ejecuta y solo entonces confirma', async () => {
    filasPorTabla.appointments = [filaCita()];
    const cancelados = [];
    calendarSante.cancelAppointment = async (_o, id) => { cancelados.push(id); return { success: true }; };
    const s = sesion();
    await turno(s, 'quiero cancelar mi cita');
    const r = await turno(s, 'sí');
    assert.deepStrictEqual(cancelados, ['apt-1'], 'debe cancelar la cita REAL de Supabase');
    assert.ok(/cancelada/i.test(r.texto));
    assert.strictEqual(s.reservaConfirmada, false);
    assert.strictEqual(s.appointmentId, null);
});

await test('cancelar · el "no" deja la cita en paz', async () => {
    filasPorTabla.appointments = [filaCita()];
    let escrituras = 0;
    calendarSante.cancelAppointment = async () => { escrituras++; return { success: true }; };
    const s = sesion();
    await turno(s, 'quiero cancelar mi cita');
    const r = await turno(s, 'no, déjala');
    assert.strictEqual(escrituras, 0);
    assert.ok(!/cancelada/i.test(r.texto), `no debe anunciar cancelación: ${r.texto}`);
});

await test('cancelar · si la ESCRITURA falla NO dice "cancelada"', async () => {
    // El gemelo de la red anti-cita-fantasma. Antes el bot decía "cancelada ✅" con la cita
    // viva en la agenda y la clienta no aparecía el día de su cita.
    filasPorTabla.appointments = [filaCita()];
    calendarSante.cancelAppointment = async () => { const e = new Error('no existe'); e.code = 'PGRST116'; throw e; };
    const s = sesion();
    await turno(s, 'quiero cancelar mi cita');
    const r = await turno(s, 'sí');
    assert.ok(!/cancelada/i.test(r.texto), `mintió: ${r.texto}`);
    assert.ok(/no he podido/i.test(r.texto), 'debe decir la verdad y avisar al salón');
});

await test('cancelar · sin ninguna cita nunca anuncia una cancelación', async () => {
    filasPorTabla.appointments = [];
    let escrituras = 0;
    calendarSante.cancelAppointment = async () => { escrituras++; return { success: true }; };
    const r = await turno(sesion(), 'quiero cancelar mi cita');
    assert.strictEqual(escrituras, 0);
    assert.ok(!/cancelada/i.test(r.texto));
    assert.ok(/no me consta/i.test(r.texto));
});

await test('cancelar · con DOS citas pregunta cuál antes de confirmar nada', async () => {
    filasPorTabla.appointments = [
        filaCita({ id: 'apt-1', service: 'Color raíz', starts: '2026-08-06T18:00:00+02:00' }),
        filaCita({ id: 'apt-2', service: 'Manicura', starts: '2026-08-04T11:00:00+02:00', stylistId: 's-2' }),
    ];
    let escrituras = 0;
    calendarSante.cancelAppointment = async () => { escrituras++; return { success: true }; };
    const s = sesion();
    const r = await turno(s, 'quiero cancelar mi cita');
    assert.strictEqual(escrituras, 0);
    assert.ok(/cu[aá]l/i.test(r.texto));
    assert.strictEqual(s.pendingCitaAccion?.accion, 'cancelar');
    // Y al elegir, se recita ESA y se sigue pidiendo confirmación.
    const r2 = await turno(s, 'la manicura');
    assert.strictEqual(escrituras, 0, 'elegir no es confirmar');
    assert.ok(r2.texto.includes('Manicura'));
    assert.strictEqual(s.pendingCitaAccion?.cita.id, 'apt-2');
});

await test('cancelar · "no puedo ir el miércoles" con huecos propuestos es RECHAZO de hueco', async () => {
    // Si acabamos de ofrecerle huecos, esa frase rechaza el hueco: no cancela nada.
    filasPorTabla.appointments = [filaCita()];
    const s = sesion({ slotsProposed: true });
    const r = await turno(s, 'no puedo ir el miércoles');
    assert.strictEqual(r.manejado, false, 'debe seguir el flujo normal de propuesta de huecos');
    assert.strictEqual(s.pendingCitaAccion, null);
});

await test('cancelar · "no puedo ir el jueves" SIN huecos propuestos sí propone cancelar', async () => {
    filasPorTabla.appointments = [filaCita()];   // jueves 06/08
    const s = sesion();
    const r = await turno(s, 'no puedo ir el jueves');
    assert.strictEqual(r.manejado, true);
    assert.strictEqual(s.pendingCitaAccion?.estado, 'confirmar');
    assert.ok(!/cancelada/i.test(r.texto));
});

// ─── Cambiar ────────────────────────────────────────────────────────────────────

await test('cambiar · fija el id REAL de Supabase antes de entrar en reagendado', async () => {
    // Sin esto, reagendarAppointmentId quedaba en null tras un timeout y finalizarCitaSante
    // creaba una cita nueva dejando viva la vieja: dos reservas facturables.
    filasPorTabla.appointments = [filaCita()];
    const s = sesion();
    const r = await turno(s, 'quiero cambiar mi cita al jueves');
    assert.strictEqual(r.manejado, true);
    assert.strictEqual(s.reagendarAppointmentId, 'apt-1');
    assert.strictEqual(s.modoReagendamiento, true);
});

await test('cambiar · "quiero cambiar de look" NO toca la agenda', async () => {
    // detectIntent devuelve 'cambiar' con un includes() a secas; sobre eso no se reagenda.
    filasPorTabla.appointments = [filaCita()];
    const s = sesion();
    const r = await turno(s, 'quiero cambiar de look');
    assert.strictEqual(r.manejado, false);
    assert.ok(!s.modoReagendamiento);
});

// ─── El flujo normal de quien NO tiene cita ─────────────────────────────────────

await test('reserva normal · sin citas, un "quiero pedir cita" pasa de largo', async () => {
    filasPorTabla.appointments = [];
    const s = sesion();
    const r = await turno(s, 'hola, quiero pedir cita para un corte');
    assert.strictEqual(r.manejado, false, 'el flujo de reserva no puede quedar secuestrado');
    assert.strictEqual(r.enviados.length, 0);
    assert.strictEqual(s.citaEnCurso, null);
});

await test('reserva normal · CON una cita, pedir otra explícitamente pasa de largo', async () => {
    filasPorTabla.appointments = [filaCita()];
    const s = sesion();
    const r = await turno(s, 'quiero reservar otra cita para manicura');
    assert.strictEqual(r.manejado, false);
    assert.strictEqual(r.enviados.length, 0);
});

await test('reserva normal · aceptar un hueco propuesto no se confunde con una cita', async () => {
    filasPorTabla.appointments = [filaCita()];
    const s = sesion({ slotsProposed: true });
    const r = await turno(s, 'sí, las 18:00 perfecto');
    assert.strictEqual(r.manejado, false);
});

// ─── Guard de solape al ampliar ─────────────────────────────────────────────────

await test('ampliar · detecta que la nueva duración pisa la cita siguiente', async () => {
    const apt = { id: 'apt-1', stylist_id: 's-1', starts_at: '2026-08-06T18:00:00+02:00' };
    filasPorTabla.appointments = [
        { id: 'apt-1', stylist_id: 's-1', starts_at: '2026-08-06T18:00:00+02:00', ends_at: '2026-08-06T19:30:00+02:00' },
        { id: 'apt-9', stylist_id: 's-1', starts_at: '2026-08-06T19:30:00+02:00', ends_at: '2026-08-06T20:30:00+02:00' },
    ];
    const solapa = await ampliacionSolapa(ORG, apt, new Date('2026-08-06T20:00:00+02:00'));
    assert.strictEqual(solapa, true, 'ampliar hasta las 20:00 se come la cita de las 19:30');
});

await test('ampliar · si cabe justo hasta la siguiente, no solapa', async () => {
    const apt = { id: 'apt-1', stylist_id: 's-1', starts_at: '2026-08-06T18:00:00+02:00' };
    filasPorTabla.appointments = [
        { id: 'apt-1', stylist_id: 's-1', starts_at: '2026-08-06T18:00:00+02:00' },
        { id: 'apt-9', stylist_id: 's-1', starts_at: '2026-08-06T19:30:00+02:00' },
    ];
    assert.strictEqual(await ampliacionSolapa(ORG, apt, new Date('2026-08-06T19:30:00+02:00')), false);
});

// ─── Piezas de localización ─────────────────────────────────────────────────────

await test('dowLunes0 · convención 0=Lunes, igual que stylist_schedules', () => {
    assert.strictEqual(dowLunes0('2026-08-06'), 3);   // jueves
    assert.strictEqual(dowLunes0('2026-08-03'), 0);   // lunes
    assert.strictEqual(dowLunes0('2026-08-09'), 6);   // domingo
});

// ─── El bloque del prompt (refuerzo) ────────────────────────────────────────────

await test('prompt · con citas, el modelo las ve con fecha, hora, servicio y estilista', () => {
    const p = buildSystemPrompt(ORG, {
        __citasVivas: [{ fecha: '2026-08-06', hora: '18:00', servicio: 'Color raíz', estilista: 'Irina' }],
    }, 'general', false, null, { services: [], business_info: {} });
    assert.ok(p.includes('YA TIENE RESERVADAS'), 'falta el bloque de citas');
    assert.ok(p.includes('2026-08-06') && p.includes('18:00') && p.includes('Irina'));
});

await test('prompt · sin citas se lo dice explícitamente', () => {
    const p = buildSystemPrompt(ORG, { __citasVivas: [] }, 'general', false, null, { services: [], business_info: {} });
    assert.ok(/YA TIENE RESERVADAS: ninguna/.test(p));
});

await test('prompt · si la lectura FALLÓ, el bloque se omite (no afirma "ninguna")', () => {
    // Decirle al modelo que no tiene citas porque no hemos podido mirarlo es la misma
    // mentira que la cita fantasma, solo que dicha al modelo en vez de a la clienta.
    const p = buildSystemPrompt(ORG, { __citasVivas: null }, 'general', false, null, { services: [], business_info: {} });
    assert.ok(!/YA TIENE RESERVADAS/.test(p), 'no puede afirmar nada sobre citas sin haber leído');
});

await test('matchCitaByPistas · una hora inexistente contradice, no elige otra cita', () => {
    const citas = [{ id: 'a', fecha: '2026-08-06', hora: '18:00' }];
    assert.strictEqual(matchCitaByPistas(citas, { horas: ['11:00'], diaSemana: null }).contradice, true);
    assert.strictEqual(matchCitaByPistas(citas, { horas: ['18:00'], diaSemana: null }).cita.id, 'a');
    assert.strictEqual(matchCitaByPistas(citas, { horas: [], diaSemana: null }).cita.id, 'a');
});

}

main().then(() => process.exit(process.exitCode || 0));
