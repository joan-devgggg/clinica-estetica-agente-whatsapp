// «Lo ambiguo no actúa»: un mensaje que da afirmativo Y negativo a la vez no cancela citas,
// no las reserva y no consume la oferta de traspaso — se pregunta o se deja el turno al LLM.
//
// Medido sobre los 411 entrantes reales de Sante (18/08/2026): 34 mensajes daban las dos
// cosas, y en los dos sitios que preguntan isAffirmative ANTES que isNegative salían como
// SÍ. «No tienes nada cita libre? No necesito cortar» (real, 17/08) habría CANCELADO la
// cita que la puerta de confirmación tuviera sobre la mesa.
//
// La ambigüedad se mide con esAmbiguo (helpers): afirmativo ∧ negación con FRONTERA — no
// isNegative a pelo, que casa 'no' por subcadena y congelaría síes reales («Si, perfecto.
// Muchas gracias. NOs vemos mañana»). El sexto call site (el trinquete de C7, bot.js) se
// queda SIN guard a propósito: ahí un true no crea nada — deja pasar la escalada, que es el
// lado recuperable — y frenarlo re-armaría una espera sobre un sí desordenado.
//
// Gemelo determinista (patrón de traspaso-declarado): LLM por cola, Supabase/Telegram
// inertes, cero red. Afirma ESTADO (escrituras, banderas), no redacción.
//
// Visto fallar sin lo que protege (sabotajes con cp previo, rojos MEDIDOS el 18/08/2026):
//   · quitar el guard de cancelar (bot.js, pendingCitaAccion) → 1 rojo: el ambiguo CANCELA;
//   · quitar el guard de la espera de traspaso → 2 rojos: el ambiguo escala Y desarma;
//   · quitar el guard de la segunda cita → 1 rojo: el ambiguo RESERVA;
//   · quitar 'нет'/'ні' de NEGACIONES_FRONTERA → 1 rojo (el bloque unitario cirílico).

process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const assert = require('assert');

const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/supabase', {});

const SERVICIO = { nombre: 'Manicura + gel', categoria: 'Manicura', precio: 35, duracion_min: 60 };
const SLOT = { fecha: '2026-08-21', hora: '10:00', stylistId: 'st-1', stylistName: 'Irina' };

// Recorder del calendario: bookAppointment/cancelAppointment son las escrituras que este
// test tiene prohibido ver en los turnos ambiguos.
const calendario = { llamadas: [] };
stub('../services/calendar-sante', {
    getAvailableSlots: async () => [{ ...SLOT }],
    bookAppointment: async (...args) => { calendario.llamadas.push('bookAppointment'); return { success: true, appointmentId: 'apt-nuevo' }; },
    rescheduleAppointment: async () => ({ success: true, appointmentId: 'apt-r' }),
    cancelAppointment: async (...args) => { calendario.llamadas.push('cancelAppointment'); return { success: true }; },
    formatSlotForMessage: s => `${s.fecha} ${s.hora}`,
});

const estado = { escrituras: [] };
const escribe = nombre => async (...args) => {
    estado.escrituras.push({ nombre, args });
    return nombre === 'createPendingAction' ? { id: 'pa-test' } : true;
};
const dbImpls = {
    findByPhone: async () => ({ id: 'ct-test', full_name: 'Clienta', wa_phone: '34600000000', bot_mode: 'auto' }),
    saveMessage: async () => 1,
    saveLead: async () => 'ct-test',
    updateLead: async () => true,
    getUpcomingAppointments: async () => [],
    hasActiveAppointmentForSlot: async () => false,
    getAppointmentsByLead: async () => [],
    getStylistsByOrg: async () => [{ id: 'st-1', name: 'Irina', role: 'colorista/estilista', skills: {} }],
    getAllStylistSchedules: async () => [],
    getScheduleBlocks: async () => [],
    getBlockedDays: async () => [],
    findContactIdsByPhone: async () => [],
    setLeadBotMode: escribe('setLeadBotMode'),
    setEscalationReason: escribe('setEscalationReason'),
    createPendingAction: escribe('createPendingAction'),
    getAgentConfig: async () => ({
        services: [SERVICIO],
        business_hours: {
            lunes: { apertura: '10:00', cierre: '19:00' }, martes: { apertura: '10:00', cierre: '19:00' },
            miercoles: { apertura: '10:00', cierre: '19:00' }, jueves: { apertura: '10:00', cierre: '19:00' },
            viernes: { apertura: '10:00', cierre: '19:00' }, sabado: { apertura: '10:00', cierre: '19:00' },
        },
        business_info: {},
    }),
};
stub('../services/db', new Proxy(dbImpls, { get: (t, k) => t[k] ?? (async () => null) }));
stub('../services/telegram', {
    notifyBizumPending: async () => {}, notifyEscalation: async () => {},
    notifyBlacklistAlert: async () => {}, startTelegramBot: () => {},
});
stub('../services/memory', { loadClient: () => null, saveClient: () => {}, saveSummary: () => {}, deleteClient: () => {} });
stub('../services/metrics', { incrementMetric: () => {} });

const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

const openai = require('../services/providers/openai');
let llmCalls = 0;
openai.getChatbotResponse = async () => {
    llmCalls++;
    return {
        respuesta: 'Ok 😊', reserva_confirmada: false, cita_confirmada: false,
        slot_rechazado: false, accion: null, motivo_escalado: null,
        ofrezco_traspaso: null, idioma_detectado: null,
        datos: { nombre: null, servicio: null, fecha_cita: null, hora_cita: null },
    };
};
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const I = bot._internals;
const { createEmptySession, userSessions, sessionKey, CONFIRM_YES, CANCEL_OK_MSGS } = I;
const { esAmbiguo, buildCancelConfirmMsg } = require('../services/helpers');
const { SANTE_ORG_ID } = require('../services/org-registry');
const ORG = SANTE_ORG_ID;
bot.setBotActivo(ORG, true, false);

// Los DOS mensajes reales de la medición, congelados byte a byte de `messages`.
// El primero era EL caso del gate de cancelar bajo la lista de subcadenas (nece-SI-to);
// la frontera de la pieza 2 lo mató en la raíz —ya ni siquiera es afirmativo— y el test
// afirma AMBAS capas. El segundo sigue siendo ambiguo también con frontera (si + no puedo).
const NI_SI_CANCELAR = 'No tienes nada cita libre? No necesito cortar';         // 17/08
const AMBIGUO_TRASPASO = 'Si pero no puedo decirte cuando ahora vale';          // 10/08

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const makeClient = sink => ({
    sendMessage: async (_p, text) => { sink.push(text); return { id: { _serialized: `wamid.T${sink.length}` } }; },
    getChatById: async () => ({ sendStateTyping: async () => {} }),
});

let seq = 0;
function armarSesion(over = {}) {
    const phone = `346000${String(2000 + seq++).slice(-4)}@c.us`;
    const session = createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    session.orgType = 'salon';
    session.leadId = 'ct-test';
    session.language = 'es';
    session.nombreGuardado = true;
    session.partialData = { ...session.partialData, nombre: 'Clienta', telefono: phone.replace(/\D/g, '') };
    session.spaPromoOffered = true;
    Object.assign(session, over);
    userSessions.set(sessionKey(ORG, phone), session);
    return { phone, session };
}

async function turno(phone, sink, texto) {
    const s = userSessions.get(sessionKey(ORG, phone));
    if (s && s.lastMessageTime) s.lastMessageTime -= 5000;
    await bot.handleIncomingMessage(makeClient(sink), {
        from: phone, body: texto, id: { _serialized: `wamid.AM${Date.now()}_${seq++}` },
        fromMe: false, timestamp: Date.now(), isStatus: false, isBroadcast: false,
        hasMedia: false, type: 'chat',
        getChat: async () => ({ sendStateTyping: async () => {} }),
        getContact: async () => ({ number: phone.replace(/\D/g, '') }),
    }, ORG);
    await I.flushBuffer(ORG, phone);
    await new Promise(r => setTimeout(r, 400));
}

function reset() {
    logs.length = 0; estado.escrituras.length = 0; calendario.llamadas.length = 0; llmCalls = 0;
}
const CITA = { id: 'apt-1', fecha: '2026-08-20', hora: '10:00', servicio: 'Manicura + gel' };

// ─── 1 · esAmbiguo, los controles medidos ────────────────────────────────────

test('esAmbiguo: los cuatro controles de la medición del 18/08', () => {
    // Sí real con 'no' solo por subcadena («NOs vemos»): NO es ambiguo — con isNegative a
    // pelo lo sería, y ese sí quedaría congelado.
    assert.strictEqual(esAmbiguo('Si, perfecto. Muchas gracias. Nos vemos mañana.'), false);
    assert.strictEqual(esAmbiguo(AMBIGUO_TRASPASO), true);
    assert.strictEqual(esAmbiguo('No es perfecto, a que hora?'), true);
    // El caso que trajo la regla, resuelto una capa más abajo: la frontera (pieza 2) mató
    // el «nece-SI-to» en la raíz. Ya no es afirmativo, así que tampoco ambiguo — y las DOS
    // capas se afirman para que ninguna pueda retirarse en silencio.
    const { isAffirmative } = require('../services/helpers');
    assert.strictEqual(isAffirmative(NI_SI_CANCELAR), false, 'la frontera lo mata en la raíz');
    assert.strictEqual(esAmbiguo(NI_SI_CANCELAR), false);
});

test('esAmbiguo: un sí limpio y un no limpio no son ambiguos', () => {
    for (const t of ['sí', 'vale', 'claro', 'yes please']) assert.strictEqual(esAmbiguo(t), false, t);
    for (const t of ['no', 'no gracias', 'no puedo']) assert.strictEqual(esAmbiguo(t), false, t);
});

test('esAmbiguo: la negación cirílica cuenta (isNegative no la veía)', () => {
    // «так, але ні» — un sí ucraniano seguido de un no. Sin 'ні' en la lista, esto actuaría.
    assert.strictEqual(esAmbiguo('так, але ні'), true);
    assert.strictEqual(esAmbiguo('да нет, не надо'), true);
});

// ─── 2 · Cancelar (pendingCitaAccion 'confirmar'): el ambiguo re-pregunta ────

test('CANCELAR · un ambiguo real NO cancela: re-pregunta y la cita sigue viva', async () => {
    reset();
    const { phone, session } = armarSesion({ pendingCitaAccion: { estado: 'confirmar', accion: 'cancelar', cita: CITA } });
    const sink = [];
    await turno(phone, sink, AMBIGUO_TRASPASO);

    assert.ok(!calendario.llamadas.includes('cancelAppointment'), 'la cita se canceló sobre un mensaje ambiguo');
    assert.strictEqual(session.pendingCitaAccion?.repetida, true, 'la pregunta se repite (techo 1), no se abandona');
    assert.strictEqual(sink[0], buildCancelConfirmMsg({ cita: CITA, language: 'es' }),
        're-pregunta con la plantilla de confirmación, no otra cosa');
});

test('CANCELAR · el caso del 17/08, ya matado en la raíz por la frontera: la cita sigue viva', async () => {
    // «No tienes nada cita libre? No necesito cortar» disparaba por nece-SI-to y habría
    // CANCELADO. Con la frontera ya ni es afirmativo: cae en la rama del no (conservadora:
    // la cita se queda) — lo que este bloque prohíbe para siempre es la cancelación.
    reset();
    const { phone } = armarSesion({ pendingCitaAccion: { estado: 'confirmar', accion: 'cancelar', cita: CITA } });
    const sink = [];
    await turno(phone, sink, NI_SI_CANCELAR);
    assert.ok(!calendario.llamadas.includes('cancelAppointment'), 'volvió a cancelar sobre un no-sí');
});

test('CANCELAR · control: un «sí» limpio SÍ ejecuta (el guard no sobre-bloquea)', async () => {
    reset();
    const { phone } = armarSesion({ pendingCitaAccion: { estado: 'confirmar', accion: 'cancelar', cita: CITA } });
    const sink = [];
    await turno(phone, sink, 'sí');

    assert.deepStrictEqual(calendario.llamadas, ['cancelAppointment']);
    assert.strictEqual(sink[0], CANCEL_OK_MSGS.es);
});

// ─── 3 · Segunda cita retenida: el ambiguo no reserva ────────────────────────

test('SEGUNDA CITA · «Si pero no puedo…» NO autoriza: cero reservas, la pregunta muere en silencio', async () => {
    reset();
    const { phone, session } = armarSesion({
        selectedService: SERVICIO,
        pendingSegundaCita: { slot: { ...SLOT }, citaExistente: { fecha: '2026-08-20', hora: '10:00' } },
    });
    const sink = [];
    await turno(phone, sink, AMBIGUO_TRASPASO);

    assert.ok(!calendario.llamadas.includes('bookAppointment'), 'se reservó sobre un mensaje ambiguo');
    assert.strictEqual(session.pendingSegundaCita, null, 'la retención muere como con «cualquier otra cosa»');
    assert.ok(!sink.some(t => /✅/.test(t)), 'ningún acuse de cita sobre cero escrituras');
    assert.strictEqual(llmCalls, 1, 'el turno sigue su curso: contesta el LLM');
});

test('SEGUNDA CITA · control: un «sí» limpio SÍ reserva el hueco retenido', async () => {
    reset();
    const { phone } = armarSesion({
        selectedService: SERVICIO,
        pendingSegundaCita: { slot: { ...SLOT }, citaExistente: { fecha: '2026-08-20', hora: '10:00' } },
    });
    const sink = [];
    await turno(phone, sink, 'sí');

    assert.deepStrictEqual(calendario.llamadas.filter(c => c === 'bookAppointment'), ['bookAppointment']);
    assert.ok(logs.some(l => l.evento === 'cita_sante_segunda_autorizada'));
});

// ─── 4 · Espera de traspaso: el ambiguo ni consume, ni desarma, ni escala ────

test('TRASPASO · el ambiguo deja la espera ARMADA, cero filas, y el turno sigue al LLM', async () => {
    reset();
    const ofrecidaAt = Date.now() - 60000;
    const { phone, session } = armarSesion({
        pendingEscalation: true, pendingEscalationService: 'dato_no_disponible',
        pendingEscalationOfrecidaAt: ofrecidaAt,
    });
    const sink = [];
    await turno(phone, sink, AMBIGUO_TRASPASO);

    assert.strictEqual(estado.escrituras.length, 0, 'un ambiguo escaló: filas sobre un sí que nadie dijo');
    assert.strictEqual(session.pendingEscalation, true, 'la espera se desarmó (el bug del silencio)');
    assert.strictEqual(session.pendingEscalationOfrecidaAt, ofrecidaAt, 'el reloj del TTL no se toca');
    assert.ok(logs.some(l => l.evento === 'traspaso_respuesta_ambigua'), 'la traza dice qué pasó');
    assert.ok(!sink.includes(CONFIRM_YES.es), 'ningún acuse de traspaso');
    assert.strictEqual(llmCalls, 1, 'no se come el turno (lección de Ihab): contesta el LLM');
});

test('TRASPASO · y el «sí» limpio del turno SIGUIENTE ejecuta la triple entera', async () => {
    reset();
    const { phone, session } = armarSesion({
        pendingEscalation: true, pendingEscalationService: 'dato_no_disponible',
        pendingEscalationOfrecidaAt: Date.now() - 60000,
    });
    const sink = [];
    await turno(phone, sink, AMBIGUO_TRASPASO);
    assert.strictEqual(estado.escrituras.length, 0);

    session.lastMessageTime = 0; // la guarda anti-ráfaga no es lo que se prueba aquí
    await turno(phone, sink, 'vale');
    assert.deepStrictEqual(estado.escrituras.map(e => e.nombre),
        ['setLeadBotMode', 'setEscalationReason', 'createPendingAction']);
    assert.strictEqual(estado.escrituras[2].args[1].payload.motivo, 'consulta_dato_no_disponible');
    assert.ok(sink.includes(CONFIRM_YES.es));
});

// ─── 4b · Elegir hueco (resolveSalonConfirmation): el ambiguo no elige ───────
// Directo sobre la función pura: es la puerta que ESCRIBE citas, y con UN solo hueco
// propuesto la rama (c) de pickChosenSlot lo devuelve sin exigir selección.

test('HUECO · el ambiguo no elige por afirmativo NI por la prosa del modelo', () => {
    const base = () => ({
        ...createEmptySession('34600009999@c.us', ORG, '34600009999'),
        orgType: 'salon', slotsProposed: true, selectedService: SERVICIO,
        proposedSlots: [{ ...SLOT }], availableSlots: [{ ...SLOT }],
    });
    const aiSinNada = { datos: {}, respuesta: 'Ok 😊', reserva_confirmada: false };
    // afirmativo_tras_propuesta, gateado:
    assert.strictEqual(I.resolveSalonConfirmation(base(), aiSinNada, AMBIGUO_TRASPASO, [{ ...SLOT }]), null);
    // texto_llm_confirma, gateado (el modelo da la reserva por hecha sobre un turno ambiguo):
    const aiClaims = { datos: {}, respuesta: 'Listo, tu cita está confirmada ✅', reserva_confirmada: false };
    assert.ok(I.llmClaimsBooked(aiClaims.respuesta), 'precondición: la prosa sí afirma reserva');
    assert.strictEqual(I.resolveSalonConfirmation(base(), aiClaims, AMBIGUO_TRASPASO, [{ ...SLOT }]), null);
    // control: el sí limpio elige el único hueco (el guard no sobre-bloquea):
    const limpio = I.resolveSalonConfirmation(base(), aiSinNada, 'sí, perfecto', [{ ...SLOT }]);
    assert.strictEqual(limpio?.motivo, 'afirmativo_tras_propuesta');
    // y el demostrativo TAMBIÉN, porque este sitio es el único que pasa conHueco: «ese»
    // contestando a una lista de huecos es una elección (el scoping de la pieza 3 no puede
    // dejar mudo al único contexto donde el demostrativo significa exactamente eso):
    const demostrativo = I.resolveSalonConfirmation(base(), aiSinNada, 'ese', [{ ...SLOT }]);
    assert.strictEqual(demostrativo?.motivo, 'afirmativo_tras_propuesta');
    // y la hora explícita sigue mandando aunque el mensaje sea ambiguo («sí pero a las 18»
    // con hueco a las 18 debe seguir funcionando — las ramas de hora no se gatean):
    const slot18 = { fecha: '2026-08-21', hora: '18:00', stylistId: 'st-1', stylistName: 'Irina' };
    const s18 = { ...base(), proposedSlots: [slot18], availableSlots: [slot18] };
    const conHora = I.resolveSalonConfirmation(s18, { datos: { hora_cita: '18:00' }, respuesta: 'Ok', reserva_confirmada: false },
        'si pero mejor no a las 17, a las 18:00', [slot18]);
    assert.strictEqual(conHora?.motivo, 'match_hora', 'la hora es la señal buena y no se pierde');
});

// ─── 5 · Consulta ofrecida: el ambiguo no selecciona el bloque de 300 min ────

test('CONSULTA · el ambiguo no selecciona; la oferta sigue en pie para el sí limpio', async () => {
    reset();
    const consultaSvc = { nombre: 'Consulta', categoria: 'Consulta', precio: null, duracion_min: 300 };
    dbImpls.getAgentConfig = async () => ({
        services: [SERVICIO, consultaSvc],
        business_hours: { lunes: { apertura: '10:00', cierre: '19:00' } },
        business_info: {},
    });
    const { phone, session } = armarSesion({ consultaOfrecida: true });
    const sink = [];
    await turno(phone, sink, AMBIGUO_TRASPASO);

    assert.strictEqual(session.selectedService, null, 'el ambiguo seleccionó la Consulta');
    assert.strictEqual(session.consultaOfrecida, true, 'la oferta no se consume: el próximo sí limpio decide');
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { fallos++; console.error(`fail - ${name}\n   ${e.message}`); }
    }
    console.log(fallos ? `\n❌ ${fallos} fallo(s)` : `\n✅ ${tests.length} en verde`);
    process.exit(fallos ? 1 : 0);
})();
