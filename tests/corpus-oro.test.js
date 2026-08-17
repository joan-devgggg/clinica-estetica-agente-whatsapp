/**
 * tests/corpus-oro.test.js — el CORPUS DE ORO: turnos reales de conversaciones auditadas,
 * congelados en tests/fixtures/corpus/*.json y rejugados EN SECO contra los detectores
 * REALES. Sin LLM, determinista, dentro de npm test.
 *
 * Mide las dos direcciones:
 *   · turnos CORRECTOS/NEUTROS → cero intervenciones (la batería de redes de sustitución
 *     no puede comerse un mensaje bueno — lo que faltó las tres veces: el horario de Olga,
 *     «подойдёт», «¿te lo reservo?»);
 *   · turnos FALLO → la detección salta (el «te apunto» de Tania, los 60 € de Mariola,
 *     el timing sin servicio de Michal).
 *
 * REGLA DE ADMISIÓN (está en el _meta de cada fixture): solo se afirma lo comprobable
 * contra estado positivo — los textos congelados (filas de messages), filas de
 * appointments/pending_actions (sin agujero de Coexistence), snapshots de catálogo y
 * business_hours. Los turnos cuyo veredicto dependa de un silencio de messages o de
 * estado de sesión irrecuperable van con `excluido: {motivo}` y aquí solo se cuentan.
 *
 * ESTE RUNNER NO CONTIENE LÓGICA DE DETECCIÓN (la trampa del doble de caja-pendientes):
 * la tabla DETECTORES mapea nombres a funciones importadas de bot._internals y
 * services/helpers, los argumentos salen SOLO del fixture, y el resultado esperado vive
 * en el fixture — aquí nunca se recalcula.
 *
 * Visto fallar sin lo que protege (sabotajes con cp previo, 15/08/2026 — los rojos son
 * los MEDIDOS, no los previstos):
 *   · bot.js — quitar /\bte (?:la |lo |las |los )?(?:reservo|apunto|anoto|agendo)\b/ de
 *     BOOKING_CLAIM_PATTERNS → rojos Tania t2 (la promesa sin fila se vuelve invisible
 *     para las redes: dirección 2 muerta) y Carolina t3.
 *   · bot.js — quitar /¿\s*(lo|la|te lo|te la) (confirmo|reservo|apunto)/ de
 *     BOOKING_APPROVAL_QUESTIONS → rojo Carolina t3: «¿Te la reservo?» pierde la exención
 *     y deja de ser una pregunta para las redes. La dirección que faltó las tres veces
 *     (una red ensanchada comiéndose el mensaje bueno) sale en rojo aquí.
 *   · services/helpers.js — extractPrecioMencionado devolviendo [] → rojos Estefania t5,
 *     Mafe t4, Mafe t13 y Mariola t3. Prueba que la cadena de imports llega al helper
 *     REAL, no a una copia del runner.
 *   · services/helpers.js — mensajeTraeOtraCosa devolviendo {trae:false} → rojos Ihab t2.1 y
 *     t2.2 (17/08/2026), los dos turnos que la puerta del nombre se comía.
 *
 * Duración medida el 15/08/2026: ~0,8 s el fichero entero (55 turnos + 3 rejugados por el
 * arnés real + 13 excluidos documentados). Desde el 17/08/2026 hay un 4º rejugado
 * (Ihab, confirmacion_en_historial), que además conduce el motor de huecos real.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SANTE_ORG = process.env.SANTE_ORG_ID || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// ─── 1. Supabase doble: sirve filas enlatadas por tabla y GRABA las escrituras ───────
// Las filas enlatadas son las anclas congeladas del fixture (DB.appointments, etc.): el
// doble ignora los filtros del builder a propósito, y eso es lo que hace el rejuego
// independiente del reloj — el .gte('starts_at', ahora) de getUpcomingAppointments se
// evalúa en Postgres, no aquí, así que una cita congelada de agosto de 2026 sigue
// sirviéndose entera aunque el test corra en 2027. Nunca devuelve `error` (assertRead
// lanzaría y no es lo que se prueba).
const DB = { appointments: [] };
const WRITES = [];
function makeBuilder(table) {
    const state = { table, op: 'select', single: false, payload: null };
    const resolve = () => {
        if (state.op === 'insert' || state.op === 'upsert') {
            const row = Object.assign({ id: `${state.table}-row-${WRITES.length}` },
                Array.isArray(state.payload) ? state.payload[0] : state.payload);
            return Promise.resolve({ data: state.single ? row : [row], error: null });
        }
        if (state.op === 'update' || state.op === 'delete') {
            return Promise.resolve({ data: state.single ? { id: `${state.table}-upd` } : [{ id: `${state.table}-upd` }], error: null });
        }
        const rows = DB[state.table] || [];
        return Promise.resolve({ data: state.single ? (rows[0] ?? null) : rows, error: null });
    };
    const b = {
        select() { return b; },
        insert(p) { state.op = 'insert'; state.payload = p; WRITES.push({ table: state.table, op: 'insert', payload: p }); return b; },
        upsert(p) { state.op = 'upsert'; state.payload = p; WRITES.push({ table: state.table, op: 'upsert', payload: p }); return b; },
        update(p) { state.op = 'update'; WRITES.push({ table: state.table, op: 'update', payload: p }); return b; },
        delete() { state.op = 'delete'; WRITES.push({ table: state.table, op: 'delete' }); return b; },
        eq() { return b; }, neq() { return b; }, in() { return b; },
        gte() { return b; }, lte() { return b; }, lt() { return b; }, gt() { return b; },
        is() { return b; }, or() { return b; }, not() { return b; }, contains() { return b; },
        order() { return b; }, limit() { return b; }, range() { return b; },
        single() { state.single = true; return resolve(); },
        maybeSingle() { state.single = true; return resolve(); },
        then(onF, onR) { return resolve().then(onF, onR); },
    };
    return b;
}
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from(t) { return makeBuilder(t); } },
};

// ─── 2. Telegram mudo ────────────────────────────────────────────────────────────────
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        startTelegramBot: () => {},
        notifyEscalation: async () => {}, notifyBlacklistAlert: async () => {},
        notifyBizumPending: async () => {}, notifyVipSuggestion: async () => {},
        notifyOrgAdmin: () => {},
    },
};

// ─── 3. Logger que graba ─────────────────────────────────────────────────────────────
const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

// ─── 4. LLM stubeado: una cola de respuestas históricas para los rejugados ───────────
const openai = require('../services/providers/openai');
const llmQueue = [];
let llmCalls = 0;
// El history que RECIBIÓ la última llamada: el rejugado de Ihab afirma lo que el modelo
// VE (su propio ✅ en el historial), no lo que redacta.
let ultimoHistoryLLM = null;
openai.getChatbotResponse = async (_orgId, history) => {
    llmCalls++;
    ultimoHistoryLLM = (history || []).map(m => ({ ...m }));
    const respuesta = llmQueue.length ? llmQueue.shift() : 'Ok 😊';
    return {
        respuesta,
        reserva_confirmada: false, cita_confirmada: false, slot_rechazado: false,
        accion: null, idioma_detectado: null,
        datos: { nombre: null, servicio: null, fecha_cita: null, hora_cita: null },
    };
};
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const I = bot._internals;
const h = require('../services/helpers');
const { makeClient, makeMessage } = require('./lib/convo');

const CATALOGO = require('./fixtures/sante-catalog.json').services;
const CORPUS_DIR = path.join(__dirname, 'fixtures', 'corpus');

let fallos = 0;
async function test(nombre, fn) {
    try { await fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`fail - ${nombre}\n   ${e.message}`); }
}

// ─── El contexto de un turno: SOLO datos del fixture ─────────────────────────────────
function buildCtx(fx, turno) {
    const estado = turno.estado || {};
    return {
        saliente: turno.saliente,
        entrantes: turno.entrante || [],
        ts: turno.ts,
        businessHours: fx.business_hours,
        horasHorario: I.horasLimiteHorario(fx.business_hours),
        slots: estado.availableSlots || [],
        citasVivas: estado.citasVivas || [],
        citasReales: estado.citasReales || [],
        precioPedido: (estado.precioPedido === undefined) ? null : estado.precioPedido,
        session: Object.assign({
            selectedService: null, reservaConfirmada: false, citaEnCurso: null,
            pendingCitaAccion: null, modoReagendamiento: false, anchorAppointment: null,
            language: (fx._meta && fx._meta.idioma) || null,
        }, estado.session || {}),
    };
}

function textoSobre(ctx, sobre) {
    if (!sobre || sobre === 'saliente') return ctx.saliente;
    const m = /^entrante:(\d+)$/.exec(sobre);
    if (m) return ctx.entrantes[Number(m[1])];
    throw new Error(`sobre desconocido: ${sobre}`);
}

// La red anti-fantasma se llama ENTERA (la real, no recompuesta): la sesión mínima lleva
// leadId para que ensureLeadId no consulte, y las citas del fixture entran por el doble
// de Supabase, que es por donde entra la BD en producción (db.getUpcomingAppointments).
async function correPhantom(ctx) {
    DB.appointments = ctx.citasReales.map(c => Object.assign({}, c));
    const session = Object.assign(I.createEmptySession('corpus@c.us', SANTE_ORG, '34600000000'), {
        leadId: 'corpus-lead', language: ctx.session.language,
    });
    const ai = { respuesta: ctx.saliente, reserva_confirmada: false };
    const bloqueo = await I.blockPhantomBookingClaim(SANTE_ORG, session, 'corpus@c.us', ai, ctx.entrantes.join(' ') || 'ok');
    return { bloqueo, respuestaFinal: ai.respuesta };
}

// ─── La tabla: nombre → detector REAL importado. Nada se recalcula aquí. ─────────────
const DETECTORES = {
    llmClaimsBooked: (ctx, t) => I.llmClaimsBooked(t),
    asksForBookingApproval: (ctx, t) => I.asksForBookingApproval(t),
    statesOpeningHours: (ctx, t) => I.statesOpeningHours(t),
    detectaOfertaTraspaso: (ctx, t) => I.detectaOfertaTraspaso(t),
    remisionAlEquipo: (ctx, t) => I.remisionAlEquipo(t),
    ofertaTraspasoEnPregunta: (ctx, t) => I.ofertaTraspasoEnPregunta(t),
    announcesHumanHandover: (ctx, t) => I.announcesHumanHandover(t),
    offersHumanHandover: (ctx, t) => I.offersHumanHandover(t),
    proposesTimingWithoutService: (ctx, t) => I.proposesTimingWithoutService(t, ctx.session, ctx.horasHorario),
    respondsWithInventedSlots: (ctx, t) => I.respondsWithInventedSlots(t, ctx.slots, ctx.horasHorario),
    respondsWithInventedDates: (ctx, t) => I.respondsWithInventedDates(t, ctx.slots, { citasVivas: ctx.citasVivas, refNow: ctx.ts }),
    respondsWithFalseClosureClaim: (ctx, t) => I.respondsWithFalseClosureClaim(t, ctx.businessHours),
    respondsWithUnbackedPrice: (ctx, t) => I.respondsWithUnbackedPrice(t, ctx.precioPedido, CATALOGO).accion,
    blockPhantomBookingClaim: async ctx => (await correPhantom(ctx)).bloqueo,
    extractPrecioMencionado: (ctx, t) => h.extractPrecioMencionado(t),
    extractMentionedDates: (ctx, t) => h.extractMentionedDates(t, ctx.ts),
    extractMentionedHours: (ctx, t) => h.extractMentionedHours(t),
    extractLargoPelo: (ctx, t) => h.extractLargoPelo(t),
    detectVariasPersonas: (ctx, t) => h.detectVariasPersonas(t),
    // La resolución de servicio de la conversación, contra el catálogo FIJO del fixture
    // (regla 5: nada de catálogo vivo aquí). Devuelve el nombre de catálogo o null; null
    // significa «el bot pregunta». Entró con el caso de Ihab (contención del catálogo).
    extractServiceFromText: (ctx, t) => h.extractServiceFromText(t, CATALOGO)?.nombre ?? null,
    detectCancelRequest: (ctx, t) => h.detectCancelRequest(t),
    // La puerta del nombre, en sus dos mitades: lo ÚNICO que leía del mensaje (el nombre) y lo
    // que ahora también lee (si el mensaje pide algo más). Los dos con el catálogo FIJO del
    // fixture; el segundo devuelve la SEÑAL, que es lo que declara el turno.
    leerNombreDeRespuesta: (ctx, t) => I.leerNombreDeRespuesta(t, CATALOGO),
    mensajeTraeOtraCosa: (ctx, t) => h.mensajeTraeOtraCosa(
        h.residuoTrasNombre(t, I.leerNombreDeRespuesta(t, CATALOGO)), { catalogo: CATALOGO }).senal,
    detectConsultaService: (ctx, t) => h.detectConsultaService(t),
    isAffirmative: (ctx, t) => h.isAffirmative(t),
    detectLanguage: (ctx, t) => h.detectLanguage(t),
};

// ─── La batería: las redes de SUSTITUCIÓN, ninguna puede intervenir ──────────────────
// (detectaOfertaTraspaso y ensureHandoverAcknowledged no están: arman o añaden, no
// sustituyen — una oferta detectada en un turno bueno no es una intervención.)
async function bateriaCero(ctx, etiqueta) {
    assert.strictEqual(I.proposesTimingWithoutService(ctx.saliente, ctx.session, ctx.horasHorario), false,
        `${etiqueta}: proposesTimingWithoutService se comería este turno`);
    assert.strictEqual(I.respondsWithInventedSlots(ctx.saliente, ctx.slots, ctx.horasHorario), false,
        `${etiqueta}: respondsWithInventedSlots se comería este turno`);
    assert.strictEqual(I.respondsWithInventedDates(ctx.saliente, ctx.slots, { citasVivas: ctx.citasVivas, refNow: ctx.ts }), false,
        `${etiqueta}: respondsWithInventedDates se comería este turno`);
    assert.strictEqual(I.respondsWithFalseClosureClaim(ctx.saliente, ctx.businessHours), false,
        `${etiqueta}: respondsWithFalseClosureClaim se comería este turno`);
    const precio = I.respondsWithUnbackedPrice(ctx.saliente, ctx.precioPedido, CATALOGO);
    assert.notStrictEqual(precio.accion, 'rectificar',
        `${etiqueta}: la red de precio rectificaría este turno (${JSON.stringify(precio)})`);
    if (I.llmClaimsBooked(ctx.saliente)) {
        const { bloqueo, respuestaFinal } = await correPhantom(ctx);
        assert.strictEqual(bloqueo, false, `${etiqueta}: la red anti-fantasma sustituiría este turno`);
        assert.strictEqual(respuestaFinal, ctx.saliente, `${etiqueta}: la red anti-fantasma tocó el texto`);
    }
}

function cmp(real, esperado, msg) {
    if (esperado !== null && typeof esperado === 'object') assert.deepStrictEqual(real, esperado, msg);
    else assert.strictEqual(real, esperado, msg);
}

// ─── Rejugados por el arnés REAL (estado Tier-1: emerge del código, no se siembra) ───
function nuevoTelefono() {
    return `34600${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}@c.us`;
}
async function turnoReal(client, phone, texto, salienteLLM, regeneracionLLM) {
    if (salienteLLM) llmQueue.push(salienteLLM);
    // La escalera (punto 4) puede pedir una SEGUNDA llamada en un turno intervenido: si un
    // rejugado la necesita, el fixture la declara aquí. Sin declararla, la afirmación de
    // llamadas de abajo se pone roja con el número en pantalla — una regeneración
    // silenciosa en un rejugado nunca pasa desapercibida.
    if (regeneracionLLM) llmQueue.push(regeneracionLLM);
    const llmAntes = llmCalls;
    const s = I.getSession(SANTE_ORG, phone);
    if (s) s.lastMessageTime = 0;
    const sink = client.__sink;
    const before = sink.length;
    await bot.handleIncomingMessage(client, makeMessage(phone, texto), SANTE_ORG);
    await I.flushBuffer(SANTE_ORG, phone);
    const esperadas = (salienteLLM ? 1 : 0) + (regeneracionLLM ? 1 : 0);
    assert.strictEqual(llmCalls - llmAntes, esperadas,
        `llamadas al LLM del rejugado: esperaba ${esperadas} y hubo ${llmCalls - llmAntes} — de más es una regeneración de la escalera sin declarar; de menos, una respuesta encolada sin consumir que contaminaría el turno siguiente`);
    return sink.slice(before).map(m => m.text).join('\n');
}
function clienteNuevo() {
    const sink = [];
    const client = makeClient(sink);
    client.__sink = sink;
    return client;
}

async function replaySiTrasOferta(fx) {
    const r = fx.replay;
    const phone = nuevoTelefono();
    const client = clienteNuevo();
    await turnoReal(client, phone, r.turno_oferta.entrante, r.turno_oferta.saliente_llm);
    const s = I.getSession(SANTE_ORG, phone);
    assert.strictEqual(s.pendingEscalation, true,
        'la oferta de traspaso del saliente histórico NO armó pendingEscalation');
    const writesAntes = WRITES.filter(w => w.table === 'pending_actions' && w.op === 'insert').length;
    const llmAntes = llmCalls;
    await turnoReal(client, phone, r.turno_si.entrante);
    const writesDespues = WRITES.filter(w => w.table === 'pending_actions' && w.op === 'insert').length;
    assert.ok(writesDespues > writesAntes,
        'el «sí» a la oferta NO escribió la escalada en pending_actions — el fallo histórico sigue');
    assert.strictEqual(llmCalls, llmAntes,
        'el «sí» pasó por el LLM: el gate determinista de pendingEscalation no lo interceptó');
}

async function replayConsultaSiEscala(fx) {
    const r = fx.replay;
    const phone = nuevoTelefono();
    const client = clienteNuevo();
    const llmAntes = llmCalls;
    const out1 = await turnoReal(client, phone, r.turno_consulta.entrante);
    assert.strictEqual(llmCalls, llmAntes, 'la consulta de permanente pasó por el LLM: el gate determinista no la vio');
    assert.strictEqual(out1, r.turno_consulta.saliente_esperado,
        `la plantilla de consulta ya no es byte-idéntica al saliente de producción.\n   salió: ${JSON.stringify(out1)}`);
    const s = I.getSession(SANTE_ORG, phone);
    assert.strictEqual(s.pendingEscalation, true, 'la consulta no armó pendingEscalation');
    const writesAntes = WRITES.filter(w => w.table === 'pending_actions' && w.op === 'insert').length;
    const out2 = await turnoReal(client, phone, r.turno_si.entrante);
    assert.ok(WRITES.filter(w => w.table === 'pending_actions' && w.op === 'insert').length > writesAntes,
        'el «sí» no escribió la escalada');
    // El TEXTO del acuse evolucionó desde el 08/08 (hoy es el HANDOVER_ACUSE unificado, no
    // «En breve una de nuestras especialistas…»): se afirma la CONDUCTA — el traspaso se
    // ANUNCIA — y no la redacción, que ya divergió una vez de la foto congelada.
    assert.ok(I.announcesHumanHandover(out2),
        `el «sí» no produjo un acuse de traspaso reconocible.\n   salió: ${JSON.stringify(out2)}`);
}

async function replayVariasPersonasPegajosa(fx) {
    const r = fx.replay;
    const phone = nuevoTelefono();
    const client = clienteNuevo();
    const llmAntes = llmCalls;
    const out1 = await turnoReal(client, phone, r.turno_varias.entrante);
    assert.strictEqual(llmCalls, llmAntes, '«para mi y una amiga» pasó por el LLM: detectVariasPersonas no interceptó');
    const s = I.getSession(SANTE_ORG, phone);
    assert.strictEqual(s.variasPersonas, true, 'variasPersonas no quedó marcada');
    assert.strictEqual(out1, I.salonVariasPersonasMsg(s),
        `el aviso de dos personas no es el texto fijo.\n   salió: ${JSON.stringify(out1)}`);
    const logsAntes = logs.length;
    const out2 = await turnoReal(client, phone, r.turno_precio.entrante, r.turno_precio.saliente_llm);
    // En la cadena COMPLETA la mentira del Detox no la caza la red de precio sino la de
    // timing-sin-servicio, que va antes (bot.js:6315 < 6387): «¿Para cuándo os vendría
    // bien, esta semana…?» con selectedService a null se sustituye entera. Lo que se
    // afirma es la CONDUCTA: el saliente histórico (su cifra con otra unidad) NO llega.
    // La salida 'rectificar' de la red de precio, aislada, se afirma en los turnos 3 y 4.
    assert.notStrictEqual(out2, r.turno_precio.saliente_llm,
        'la mentira del Detox de 60 minutos llegó tal cual a la clienta');
    assert.ok(!/60 minutos/.test(out2),
        `el texto sustituido sigue conteniendo la unidad cambiada.\n   salió: ${JSON.stringify(out2)}`);
    assert.ok(logs.slice(logsAntes).some(l => l.evento === 'cita_sante_timing_sin_servicio_bloqueado'),
        'no quedó la traza de la red que interceptó (cita_sante_timing_sin_servicio_bloqueado)');
    assert.strictEqual(I.getSession(SANTE_ORG, phone).variasPersonas, true,
        'la marca variasPersonas se perdió un turno después: ya no es pegajosa');
}

// El turno 4 de Ihab en el arnés real: tras el ✅ determinista, el modelo del turno
// siguiente VE ese ✅ en su historial (era el trabajo del arreglo del 17/08/2026) y el
// emoji no crea otra cita. El estado del cierre (servicio + reserva esperando nombre) se
// SIEMBRA, como el rescate de Ludmila en escalera-agenda: el estado de sesión de aquel
// instante no se conserva, y reconstruirlo desde el turno 1 exigiría rejugar la
// resolución mala que la contención del catálogo ya prohíbe. La agenda sí es del motor
// REAL: filas congeladas de estilista/horarios servidas por el doble de Supabase.
async function replayConfirmacionEnHistorial(fx) {
    const r = fx.replay;
    const phone = nuevoTelefono();
    const client = clienteNuevo();
    const st = r.agenda.stylist;
    DB.stylists = [{ id: st.id, name: st.name, skills: st.skills, is_active: true }];
    DB.stylist_schedules = [];
    for (let d = 0; d <= 6; d++) DB.stylist_schedules.push({ stylist_id: st.id, day_of_week: d, start_time: '10:00', end_time: '19:00' });
    DB.schedule_blocks = [];
    DB.appointments = [];
    DB.contacts = [{ id: 'ct-ihab', full_name: 'Ihab', wa_phone: phone.replace(/\D/g, '') }];
    try {
        const svc = CATALOGO.find(s => s.nombre === r.servicio);
        assert.ok(svc, `el servicio del rejugado no está en el catálogo congelado: ${r.servicio}`);
        const d = new Date(Date.now() + 7 * 24 * 3600 * 1000);
        const fecha = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const session = I.createEmptySession(phone, SANTE_ORG, phone.replace(/\D/g, ''));
        session.leadId = 'ct-ihab';
        session.language = 'es';
        session.selectedService = { ...svc };
        session.pendingNameForBooking = { slot: { fecha, hora: '15:00', stylistId: st.id, stylistName: st.name }, intentos: 1, fase: 'nombre', agotado: false };
        session.preguntasCierre = 2;
        session.spaPromoOffered = true;
        I.userSessions.set(I.sessionKey(SANTE_ORG, phone), session);

        const out1 = await turnoReal(client, phone, r.turno_nombre.entrante);
        assert.ok(/✅/.test(out1) && new RegExp(`${svc.precio}€`).test(out1),
            `el ✅ con el precio del catálogo congelado no salió.\n   salió: ${JSON.stringify(out1)}`);
        const citasEscritas = WRITES.filter(w => w.table === 'appointments' && w.op === 'insert').length;
        assert.ok(citasEscritas >= 1, 'el ✅ salió sin que el motor real escribiera la cita');
        const last = session.history[session.history.length - 1];
        assert.strictEqual(last && last.content, out1, 'el ✅ enviado no quedó en session.history');
        assert.strictEqual(last.det, true, 'el ✅ entró sin la marca det');

        // La agenda ahora dice que la cita existe, como diría Supabase.
        DB.appointments = [{ id: 'apt-ihab', service: svc.nombre, status: 'confirmed', starts_at: `${fecha}T13:00:00Z`, contact_id: 'ct-ihab' }];
        await turnoReal(client, phone, r.turno_emoji.entrante, r.turno_emoji.saliente_llm);
        assert.ok(ultimoHistoryLLM && ultimoHistoryLLM.some(m => m.role === 'assistant' && m.content === out1),
            'LA CEGUERA DE IHAB: el ✅ no está en el history que recibió el modelo — puede reabrir la cita con otro precio');
        assert.strictEqual(ultimoHistoryLLM[ultimoHistoryLLM.length - 1].role, 'user',
            'el history del modelo no puede terminar en assistant: prefill cerrado (bot.js:2500)');
        assert.strictEqual(WRITES.filter(w => w.table === 'appointments' && w.op === 'insert').length, citasEscritas,
            'el emoji volvió a escribir una cita: la 2ª cita fantasma del 16/08 sigue viva');
    } finally {
        delete DB.stylists; delete DB.stylist_schedules; delete DB.schedule_blocks; delete DB.contacts;
        DB.appointments = [];
    }
}

const REPLAYS = {
    si_tras_oferta: replaySiTrasOferta,
    consulta_si_escala: replayConsultaSiEscala,
    varias_personas_pegajosa: replayVariasPersonasPegajosa,
    confirmacion_en_historial: replayConfirmacionEnHistorial,
};

// ─── Corrida ─────────────────────────────────────────────────────────────────────────
(async () => {
    const t0 = Date.now();
    const ficheros = fs.readdirSync(CORPUS_DIR).filter(f => f.endsWith('.json')).sort();
    assert.ok(ficheros.length >= 9, `esperaba ≥9 fixtures en ${CORPUS_DIR}, hay ${ficheros.length}`);

    const cuenta = { fallo_anclado: 0, correcto_anclado: 0, neutro: 0, excluidos: 0, asserts: 0 };

    // El seam del reloj no cambia la conducta por defecto: sin refNow, byte-idéntico a hoy.
    await test('refNow: sin parámetro, extractMentionedDates se comporta como siempre', async () => {
        assert.deepStrictEqual(h.extractMentionedDates('el 28 de agosto'), h.extractMentionedDates('el 28 de agosto', Date.now()));
        assert.deepStrictEqual(h.extractMentionedDates('nada de fechas'), []);
    });

    for (const fichero of ficheros) {
        const fx = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, fichero), 'utf8'));
        const quien = fx._meta.contacto;

        for (const turno of fx.turnos) {
            const etiqueta = `${quien} · turno ${turno.n}`;
            if (turno.excluido) {
                cuenta.excluidos++;
                continue;
            }
            const ctx = buildCtx(fx, turno);
            await test(`${etiqueta} [${turno.clase}]`, async () => {
                for (const e of (turno.espera || [])) {
                    const det = DETECTORES[e.detector];
                    if (!det) throw new Error(`detector desconocido en el fixture: ${e.detector}`);
                    const real = await det(ctx, textoSobre(ctx, e.sobre));
                    cmp(real, e.resultado, `${e.detector} sobre ${e.sobre || 'saliente'}: esperaba ${JSON.stringify(e.resultado)}, salió ${JSON.stringify(real)}`);
                    cuenta.asserts++;
                }
                if (turno.clase === 'correcto_anclado' || turno.clase === 'neutro') {
                    await bateriaCero(ctx, etiqueta);
                    cuenta.asserts++;
                }
                cuenta[turno.clase]++;
            });
        }

        if (fx.replay) {
            const runner = REPLAYS[fx.replay.tipo];
            await test(`${quien} · rejugado «${fx.replay.tipo}» por el arnés real`, async () => {
                if (!runner) throw new Error(`tipo de replay desconocido: ${fx.replay.tipo}`);
                await runner(fx);
                cuenta.asserts++;
            });
        }
    }

    const ms = Date.now() - t0;
    console.log(`\nCORPUS DE ORO — fallo:${cuenta.fallo_anclado} correcto:${cuenta.correcto_anclado} neutro:${cuenta.neutro} · excluidos (documentados, no ejecutados): ${cuenta.excluidos} · asserts: ${cuenta.asserts} · ${ms} ms`);
    if (fallos) { console.error(`\n${fallos} FALLOS`); process.exit(1); }
    console.log('\nTODO OK');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
