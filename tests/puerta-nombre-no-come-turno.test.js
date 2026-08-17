// La puerta del nombre deja de comerse el turno — GEMELO de los dos turnos reales de Ihab.
//
// 16/08/2026 (hora local, UTC+2), congelado byte a byte de `messages`:
//   13:37:36  ÉL   A las 15:00 puedo?
//   13:37:47  BOT  ¿A nombre de quién la pongo? 😊
//   13:38:16  ÉL   Hay cita libre a las 15 h?
//   13:38:22  BOT  Perdona, ¿me dices tu nombre para la cita? 😊
//
// Dos cosas distintas, y las dos se afirman aquí:
//   1. la SEGUNDA pregunta no se procesó EN ABSOLUTO — la puerta pre-LLM la pasaba por
//      leerNombreDeRespuesta, salía null y repreguntaba con return true. El assert que lo mide
//      es `llmCalls`: si el turno no llega al modelo, no se ha procesado;
//   2. la PRIMERA sí se procesó (el hueco quedó retenido y la cita acabó a las 15:00) pero el
//      acuse no podía decírselo. Lo mide la presencia del acuse deíctico, y su condición: solo
//      sale con el hueco verificado contra el motor EN ESE TURNO.
//
// Y el tragado estaba en DOS capas: con la puerta pre-LLM abierta, «Hay cita libre a las 15 h?»
// vuelve a disparar la confirmación por 'match_hora' (hora_cita 15:00 contra los huecos que él
// vio), así que el segundo bloque prueba la capa del LLM, no la primera.
//
// Afirma ESTADO y no redacción del modelo (regla 2), con UNA excepción a propósito: las frases
// de promesa del bloque 5, donde las palabras SON el daño.
//
// LLM por cola, calendar-sante y Supabase stubeados, cero red (patrón de
// deterministas-en-historial.test.js).
//
// Visto fallar sin lo que protege (sabotajes con cp previo, rojos MEDIDOS el 17/08/2026):
//   · `mensajeTraeOtraCosa` → siempre {trae:false} (la puerta vuelve a comerse el turno) → 7
//     rojos, con el t2 de Ihab a la cabeza;
//   · el PASO 4 v1 —conservar la prosa del modelo en el sitio de sustitución con una guarda
//     enumerada— → 2 rojos: el t2 y «la promesa SIN hora». El segundo es el que explica por qué
//     la sustitución sigue siendo total: las promesas CON hora las sigue cazando
//     `mencionaLoRetenido`, pero «ese hueco es tuyo» no la caza NADIE;
//   · el coda gastando intento (la contabilidad de antes) → 1 rojo, y es el que impedía que
//     dos preguntas sobre horas dejaran la cita sin nombre;
//   · el coda pegado sin recortar la base → 1 rojo (se perdía a los 1000 caracteres);
//   · el acuse ignorando `_huecoVerificadoEsteTurno` → 1 rojo aquí y 2 en
//     tests/nombre-antes-de-reservar.test.js: afirmaría el hueco sin haberlo mirado;
//   · el tope de codas a 3 → 1 rojo aquí y 1 allí.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const assert = require('assert');

// ─── Stubs ANTES de requerir bot ─────────────────────────────────────────────
const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/supabase', {});

const SERVICIO = { nombre: 'Lavar y peinar', categoria: 'Lavar y peinar', precio: 25, duracion_min: 45 };
const CATALOGO = [SERVICIO, { nombre: 'Balayage', categoria: 'Mechas', precio: 120, duracion_min: 180 }];
const HOY = new Date();
const FECHA = (() => {
    const d = new Date(HOY.getTime() + 3 * 24 * 3600 * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();
const SLOT = { fecha: FECHA, hora: '15:00', stylistId: 'st-natalia', stylistName: 'Natalia' };

// El motor: por defecto el hueco de las 15:00 sigue libre. `motorVacio` lo apaga, que es la
// forma de probar que sin verificación no hay acuse.
let motorVacio = false;
const reservas = [];
stub('../services/calendar-sante', {
    getAvailableSlots: async () => (motorVacio ? [] : [{ ...SLOT }]),
    bookAppointment: async (_org, slot) => { reservas.push(slot); return { success: true, appointmentId: `apt-${reservas.length}` }; },
    rescheduleAppointment: async () => ({ success: true, appointmentId: 'apt-r' }),
    cancelAppointment: async () => ({ success: true }),
    formatSlotForMessage: s => `${s.fecha} ${s.hora}`,
});

// La agenda que devolvería Supabase DESPUÉS de escribir: sin esto, la red anti-cita-fantasma
// leería cero citas sobre un ✅ legítimo y lo rectificaría — un artefacto del doble, no del
// sistema. Se alimenta de `reservas`, o sea de lo que el motor dice haber escrito.
let upcomingImpl = async () => reservas.map((s, i) => ({
    id: `apt-${i + 1}`, service: SERVICIO.nombre, status: 'confirmed',
    starts_at: new Date(`${s.fecha}T${s.hora}:00`).toISOString(),
    stylist_id: s.stylistId, stylists: { name: s.stylistName },
}));
const dbImpls = {
    findByPhone: async () => ({ id: 'ct-ihab', full_name: null, wa_phone: '34790768781', bot_mode: 'auto' }),
    saveMessage: async () => 1,
    saveLead: async () => 'ct-ihab',
    updateLead: async () => true,
    getUpcomingAppointments: async (...a) => upcomingImpl(...a),
    hasActiveAppointmentForSlot: async () => false,
    getAppointmentsByLead: async () => [],
    getStylistsByOrg: async () => [],
    getAllStylistSchedules: async () => [],
    getScheduleBlocks: async () => [],
    getBlockedDays: async () => [],
    findContactIdsByPhone: async () => [],
    getAgentConfig: async () => ({
        services: CATALOGO,
        business_hours: {
            lunes: { apertura: '10:00', cierre: '19:00' }, martes: { apertura: '10:00', cierre: '19:00' },
            miercoles: { apertura: '10:00', cierre: '19:00' }, jueves: { apertura: '10:00', cierre: '19:00' },
            viernes: { apertura: '10:00', cierre: '19:00' }, sabado: { apertura: '10:00', cierre: '19:00' },
        },
        business_info: { direccion: 'Calle San Juan Bosco 14' },
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
const llmQueue = [];
openai.getChatbotResponse = async () => {
    llmCalls++;
    const item = llmQueue.length ? llmQueue.shift() : 'Ok 😊';
    const val = (typeof item === 'function') ? await item() : item;
    const base = {
        respuesta: null, reserva_confirmada: false, cita_confirmada: false,
        slot_rechazado: false, accion: null, idioma_detectado: null,
        datos: { nombre: null, servicio: null, fecha_cita: null, hora_cita: null },
    };
    return (typeof val === 'string') ? { ...base, respuesta: val } : { ...base, ...val };
};
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const I = bot._internals;
const { createEmptySession, userSessions, sessionKey, ACUSE_HUECO_LIBRE, preguntaNombreMsg } = I;
const { SANTE_ORG_ID } = require('../services/org-registry');
const ORG = SANTE_ORG_ID;
bot.setBotActivo(ORG, true, false);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const makeClient = sink => ({
    sendMessage: async (_p, text) => { sink.push(text); return { id: { _serialized: `wamid.T${sink.length}` } }; },
    getChatById: async () => ({ sendStateTyping: async () => {} }),
});

let seq = 0;
// La sesión del instante EXACTO del primer turno de Ihab: servicio resuelto, los huecos que él
// VIO (proposedSlots, de donde sale frozenProposed) y sin nombre en la ficha.
function armarSesion(over = {}) {
    const phone = `347907${String(1000 + seq++).slice(-4)}@c.us`;
    const session = createEmptySession(phone, ORG, phone.replace(/\D/g, ''));
    session.orgType = 'salon';
    session.leadId = 'ct-ihab';
    session.language = 'es';
    session.selectedService = { ...SERVICIO };
    session.selectedStylist = { id: 'st-natalia', nombre: 'Natalia' };
    session.availableSlots = [{ ...SLOT }];
    session.proposedSlots = [{ ...SLOT }];
    session.slotsProposed = true;
    session.spaPromoOffered = true;    // la promo no es lo que se prueba
    Object.assign(session, over);
    userSessions.set(sessionKey(ORG, phone), session);
    return { phone, session };
}

async function turno(phone, sink, texto) {
    const s = userSessions.get(sessionKey(ORG, phone));
    if (s && s.lastMessageTime) s.lastMessageTime -= 5000;
    await bot.handleIncomingMessage(makeClient(sink), {
        from: phone, body: texto, id: { _serialized: `wamid.PN${Date.now()}_${seq++}` },
        fromMe: false, timestamp: Date.now(), isStatus: false, isBroadcast: false,
        hasMedia: false, type: 'chat',
        getChat: async () => ({ sendStateTyping: async () => {} }),
        getContact: async () => ({ number: phone.replace(/\D/g, '') }),
    }, ORG);
    await I.flushBuffer(ORG, phone);
    await new Promise(r => setTimeout(r, 400));
}

function reset() { logs.length = 0; llmQueue.length = 0; reservas.length = 0; motorVacio = false; }
const trazas = evento => logs.filter(l => l.evento === evento);
const ultimo = sink => sink[sink.length - 1] || '';
// Lo que la clienta NO puede recibir en un turno donde no se ha escrito nada.
function assertNadaDeCitaHecha(texto, etiqueta) {
    assert.ok(!/✅/.test(texto), `${etiqueta}: lleva ✅ sin haber escrito nada → "${texto}"`);
    assert.ok(!/\d{1,2}:\d{2}/.test(texto), `${etiqueta}: lleva una hora → "${texto}"`);
    assert.ok(!I.llmClaimsBooked(texto), `${etiqueta}: suena a cita hecha → "${texto}"`);
}

// ─── 1 · Turno 1 de Ihab: la puerta pregunta, pero ya CONTESTA ───────────────

test('IHAB t1 · «A las 15:00 puedo?» → acuse + pregunta, sin ✅, sin hora y sin escribir nada', async () => {
    reset();
    const { phone, session } = armarSesion();
    const sink = [];
    // Lo que el modelo devolvió de verdad ese turno: identifica el hueco pedido.
    llmQueue.push({ respuesta: 'Perfecto, las 15:00 con Natalia.', datos: { hora_cita: '15:00', fecha_cita: FECHA } });

    await turno(phone, sink, 'A las 15:00 puedo?');

    const salida = ultimo(sink);
    assert.ok(salida.startsWith(ACUSE_HUECO_LIBRE.es), `falta el acuse: "${salida}"`);
    assert.ok(/nombre/i.test(salida), `falta la pregunta del nombre: "${salida}"`);
    assertNadaDeCitaHecha(salida, 't1');
    assert.strictEqual(reservas.length, 0, 'no se escribe nada en este turno');
    assert.ok(session.pendingNameForBooking, 'la reserva queda en espera');
    assert.strictEqual(session.pendingNameForBooking.slot.hora, '15:00');
    assert.strictEqual(session.pendingNameForBooking.intentos, 1, 'la pregunta sola gasta intento');
    assert.strictEqual(session.reservaConfirmada, false);
    // Y lo que se anota en history es lo que ella leyó.
    const last = session.history[session.history.length - 1];
    assert.strictEqual(last.content, salida, 'history y envío tienen que ser el mismo texto');
});

// ─── 2 · Turno 2 de Ihab: el que no se procesaba EN ABSOLUTO ─────────────────

test('IHAB t2 · «Hay cita libre a las 15 h?» SÍ se procesa: llega al modelo y no se traga el turno', async () => {
    reset();
    const { phone, session } = armarSesion({
        pendingNameForBooking: { slot: { ...SLOT }, intentos: 1, codas: 0, fase: 'nombre', agotado: false },
        preguntasCierre: 1,
    });
    const sink = [];
    llmQueue.push({ respuesta: 'Sí, sigue libre.', datos: { hora_cita: '15:00', fecha_cita: FECHA } });
    const antes = llmCalls;

    await turno(phone, sink, 'Hay cita libre a las 15 h?');

    // ESTE es el assert del bug: antes del arreglo el turno moría en la puerta, sin modelo.
    assert.strictEqual(llmCalls - antes, 1, 'el turno no llegó al modelo: se lo comió la puerta');
    assert.strictEqual(trazas('cita_sante_nombre_puerta_no_come_turno').length, 1, 'falta la traza');
    assert.strictEqual(trazas('cita_sante_nombre_puerta_no_come_turno')[0].senal, 'hora');

    const salida = ultimo(sink);
    assert.ok(salida.startsWith(ACUSE_HUECO_LIBRE.es), `el turno no contesta: "${salida}"`);
    assertNadaDeCitaHecha(salida, 't2');
    assert.strictEqual(reservas.length, 0, 'sigue sin escribirse nada');
    assert.ok(session.pendingNameForBooking, 'y la reserva sigue en espera');
});

test('IHAB t3 · y después el nombre cierra la reserva, como en producción', async () => {
    reset();
    const { phone, session } = armarSesion({
        pendingNameForBooking: { slot: { ...SLOT }, intentos: 2, codas: 0, fase: 'nombre', agotado: false },
        preguntasCierre: 2,
    });
    const sink = [];
    const antes = llmCalls;

    await turno(phone, sink, 'Claro, me llamo Ihab.');

    assert.strictEqual(llmCalls - antes, 0, 'el cierre es determinista puro');
    assert.strictEqual(session.partialData.nombre, 'Ihab');
    assert.strictEqual(reservas.length, 1, 'la cita se escribe');
    assert.ok(/✅/.test(ultimo(sink)), `ahora sí toca el ✅: "${ultimo(sink)}"`);
});

// ─── 3 · El coda: contestar y volver a pedir el nombre en el MISMO mensaje ───

test('pregunta que no es de agenda: se contesta y el nombre viaja PEGADO, sin gastar intento', async () => {
    reset();
    const { phone, session } = armarSesion({
        pendingNameForBooking: { slot: { ...SLOT }, intentos: 1, codas: 0, fase: 'nombre', agotado: false },
        preguntasCierre: 1,
    });
    const sink = [];
    llmQueue.push('Sí, hay parking justo enfrente 😊');

    await turno(phone, sink, '¿Tenéis parking?');

    const salida = ultimo(sink);
    assert.ok(/parking/i.test(salida), `se comió la respuesta: "${salida}"`);
    assert.ok(salida.includes(preguntaNombreMsg(session, 2)), `falta el coda: "${salida}"`);
    assert.strictEqual(session.pendingNameForBooking.intentos, 1, 'el coda NO gasta intento');
    assert.strictEqual(session.preguntasCierre, 1, 'ni pregunta de cierre');
    assert.strictEqual(session.pendingNameForBooking.codas, 1);
    assert.strictEqual(session.history[session.history.length - 1].content, salida,
        'history tiene que llevar el texto CON el coda: es lo que ella leyó');
});

test('el tope de codas es 2: la tercera respuesta ya no lleva la pregunta', async () => {
    reset();
    const { phone, session } = armarSesion({
        pendingNameForBooking: { slot: { ...SLOT }, intentos: 1, codas: 2, fase: 'nombre', agotado: false },
        preguntasCierre: 1,
    });
    const sink = [];
    llmQueue.push('Estamos en Calle San Juan Bosco 14 😊');

    await turno(phone, sink, '¿Dónde estáis?');

    const salida = ultimo(sink);
    assert.ok(/Bosco/.test(salida), 'la respuesta sigue saliendo');
    assert.ok(!/nombre/i.test(salida), `la tercera coda no debía salir: "${salida}"`);
    assert.strictEqual(session.pendingNameForBooking.codas, 2, 'y no cuenta la que no salió');
});

test('con una respuesta larguísima, lo que se recorta es la BASE y el coda sobrevive', async () => {
    reset();
    const { phone, session } = armarSesion({
        pendingNameForBooking: { slot: { ...SLOT }, intentos: 1, codas: 0, fase: 'nombre', agotado: false },
        preguntasCierre: 1,
    });
    const sink = [];
    llmQueue.push(`${'Tenemos parking y muchas cosas más. '.repeat(40)}😊`);

    await turno(phone, sink, '¿Tenéis parking?');

    const salida = ultimo(sink);
    assert.ok(salida.length <= 1000, `se pasa de 1000 (${salida.length})`);
    assert.ok(salida.includes(preguntaNombreMsg(session, 2)),
        `el coda se perdió en el recorte: "...${salida.slice(-80)}"`);
});

test('si la espera se resuelve en el MISMO turno, el coda no se pega detrás del ✅', async () => {
    // La puerta deja pasar el turno, y dentro del turno la reserva se escribe (aquí porque los
    // dos intentos estaban gastados: «la cita vale más que el dato»). Preguntar el nombre
    // detrás de un ✅ sería preguntar por algo ya cerrado.
    reset();
    const { phone, session } = armarSesion({
        pendingNameForBooking: { slot: { ...SLOT }, intentos: 2, codas: 0, fase: 'nombre', agotado: false },
        preguntasCierre: 2,
    });
    const sink = [];
    llmQueue.push({ respuesta: 'Perfecto, las 15:00.', datos: { hora_cita: '15:00', fecha_cita: FECHA } });

    await turno(phone, sink, 'A las 15:00 puedo? gracias');

    assert.strictEqual(reservas.length, 1, 'con los intentos gastados la cita se escribe');
    assert.ok(/✅/.test(ultimo(sink)), `esperaba el ✅: "${ultimo(sink)}"`);
    assert.ok(!/nombre/i.test(ultimo(sink)), `pidió el nombre detrás del ✅: "${ultimo(sink)}"`);
    assert.strictEqual(session.reservaConfirmada, true);
});

// ─── 4 · La repregunta pura: sin verificación NO hay acuse ───────────────────

test('«da igual» → pregunta A SECAS (sin acuse: nadie ha mirado el motor este turno)', async () => {
    reset();
    const { phone, session } = armarSesion({
        pendingNameForBooking: { slot: { ...SLOT }, intentos: 1, codas: 0, fase: 'nombre', agotado: false },
        preguntasCierre: 1,
    });
    const sink = [];
    const antes = llmCalls;

    await turno(phone, sink, 'da igual');

    assert.strictEqual(llmCalls - antes, 0, 'una no-respuesta sí se resuelve en la puerta');
    const salida = ultimo(sink);
    assert.strictEqual(salida, preguntaNombreMsg(session, 2), `debía ser la pregunta sola: "${salida}"`);
    assert.ok(!salida.includes(ACUSE_HUECO_LIBRE.es), 'acuse sin verificación de este turno');
    assert.strictEqual(session.pendingNameForBooking.intentos, 2, 'la pregunta sola sí gasta intento');
});

test('con el motor VACÍO no se afirma disponibilidad: ni acuse, ni escritura', async () => {
    reset();
    motorVacio = true;   // el hueco ya no está: no se puede verificar nada
    const { phone } = armarSesion();
    const sink = [];
    llmQueue.push({ respuesta: 'Perfecto, las 15:00.', datos: { hora_cita: '15:00', fecha_cita: FECHA } });

    await turno(phone, sink, 'A las 15:00 puedo?');

    const salida = ultimo(sink);
    assert.ok(!salida.includes(ACUSE_HUECO_LIBRE.es), `acuse sin hueco verificado: "${salida}"`);
    assert.strictEqual(reservas.length, 0);
});

// ─── 5 · La promesa que NO casa los patrones enumerados ─────────────────────
//
// Aquí las palabras SON el daño, así que se mide TEXTO. Las cinco frases dan llmClaimsBooked
// false y no las para ninguna red: la garantía no puede ser una lista de verbos.

const PROMESAS = [
    ['es', 'Te la dejo apartada a las 15:00.'],
    ['en', 'I will hold it for you at 3pm.'],
    ['ru', 'Оставлю за тобой 15:00.'],
    ['uk', 'Тримаю за тобою 15:00.'],
    ['es', 'Perfecto, ese hueco es tuyo a las 15:00.'],
];

test('la promesa del modelo NO sale cuando la confirmación dispara: habla la puerta', async () => {
    for (const [lang, frase] of PROMESAS) {
        reset();
        const { phone } = armarSesion({ language: lang });
        const sink = [];
        llmQueue.push({ respuesta: frase, datos: { hora_cita: '15:00', fecha_cita: FECHA } });

        await turno(phone, sink, 'A las 15:00 puedo?');

        const salida = ultimo(sink);
        assert.ok(!salida.includes(frase), `${lang}: la promesa salió entera → "${salida}"`);
        assert.ok(salida.startsWith(ACUSE_HUECO_LIBRE[lang]), `${lang}: no habló la puerta → "${salida}"`);
        assertNadaDeCitaHecha(salida, `promesa/${lang}`);
        assert.strictEqual(reservas.length, 0, `${lang}: se escribió algo`);
    }
});

test('la promesa SIN hora es la que obliga a que la sustitución siga siendo TOTAL', async () => {
    // Ninguna regla la caza: no casa llmClaimsBooked (medido) y no nombra la hora retenida, así
    // que `mencionaLoRetenido` tampoco la ve. Lo único que impide que salga es que en ese turno
    // hablemos NOSOTROS. Este bloque es el que se pone rojo si alguien vuelve a la idea de
    // conservar la prosa del modelo con una guarda enumerada.
    reset();
    const frase = 'Perfecto, ese hueco es tuyo.';
    assert.strictEqual(I.llmClaimsBooked(frase), false, 'precondición: la lista no la caza');
    const { phone } = armarSesion();
    const sink = [];
    llmQueue.push({ respuesta: frase, datos: { hora_cita: '15:00', fecha_cita: FECHA } });

    await turno(phone, sink, 'A las 15:00 puedo?');

    const salida = ultimo(sink);
    assert.ok(!salida.includes(frase), `la promesa sin hora salió → "${salida}"`);
    assert.ok(salida.startsWith(ACUSE_HUECO_LIBRE.es), `no habló la puerta → "${salida}"`);
});

test('y en un turno de coda, nombrar la hora RETENIDA descarta el texto del modelo', async () => {
    reset();
    const { phone } = armarSesion({
        pendingNameForBooking: { slot: { ...SLOT }, intentos: 1, codas: 0, fase: 'nombre', agotado: false },
        preguntasCierre: 1,
    });
    const sink = [];
    // Sin datos.hora_cita la confirmación no dispara: el texto llega hasta el coda.
    llmQueue.push('Te la dejo apartada a las 15:00, tranquilo.');

    await turno(phone, sink, '¿Tenéis parking?');

    const salida = ultimo(sink);
    assert.ok(!/apartada/.test(salida), `la promesa salió → "${salida}"`);
    assert.strictEqual(trazas('cita_sante_hora_retenida_en_texto').length, 1, 'falta la traza');
    assertNadaDeCitaHecha(salida, 'coda con hora retenida');
});

test('pero el HORARIO del salón sigue saliendo (la lección de Olga)', async () => {
    reset();
    const { phone } = armarSesion({
        pendingNameForBooking: { slot: { ...SLOT }, intentos: 1, codas: 0, fase: 'nombre', agotado: false },
        preguntasCierre: 1,
    });
    const sink = [];
    llmQueue.push('Abrimos de 10:00 a 19:00 😊');

    await turno(phone, sink, '¿A qué hora abrís?');

    const salida = ultimo(sink);
    assert.ok(/10:00/.test(salida) && /19:00/.test(salida), `se comió el horario: "${salida}"`);
    assert.strictEqual(trazas('cita_sante_hora_retenida_en_texto').length, 0);
});

// ─── 6 · Nombre Y otra cosa en el mismo mensaje ─────────────────────────────

test('nombre + pregunta suelta: se reserva, sale el ✅ y la pregunta se contesta después', async () => {
    reset();
    const { phone, session } = armarSesion({
        pendingNameForBooking: { slot: { ...SLOT }, intentos: 1, codas: 0, fase: 'nombre', agotado: false },
        preguntasCierre: 1,
    });
    const sink = [];
    llmQueue.push('Sí, hay parking justo enfrente 😊');

    await turno(phone, sink, 'Me llamo Ihab, ¿tenéis parking?');

    assert.strictEqual(session.partialData.nombre, 'Ihab');
    assert.strictEqual(reservas.length, 1, 'la cita se escribe');
    assert.ok(/✅/.test(sink[0]), `el primer mensaje es el ✅: "${sink[0]}"`);
    assert.ok(/parking/i.test(ultimo(sink)), `la pregunta se queda sin contestar: "${ultimo(sink)}"`);
    assert.ok(sink.length >= 2, 'tienen que ser dos mensajes: el ✅ y la respuesta');
    // El apellido NO se pide: no le gana el turno a una pregunta sin contestar.
    assert.ok(!sink.some(m => /apellido/i.test(m)), 'preguntó el apellido');
});

test('nombre + OTRA hora: no se escribe la retenida a espaldas de lo que pide', async () => {
    reset();
    const { phone, session } = armarSesion({
        pendingNameForBooking: { slot: { ...SLOT }, intentos: 1, codas: 0, fase: 'nombre', agotado: false },
        preguntasCierre: 1,
    });
    const sink = [];
    llmQueue.push('Mejor a las 17:00, te mirot 😊');

    await turno(phone, sink, 'Me llamo Ihab, mejor a las 17:00');

    assert.strictEqual(session.partialData.nombre, 'Ihab', 'el nombre sí se captura');
    assert.strictEqual(reservas.length, 0, 'no se escribe el hueco viejo');
    assert.strictEqual(trazas('cita_sante_nombre_con_peticion_nueva').length, 1, 'falta la traza');
});

test('nombre a secas: el apellido se sigue pidiendo (conducta de siempre)', async () => {
    reset();
    const { phone, session } = armarSesion({
        pendingNameForBooking: { slot: { ...SLOT }, intentos: 1, codas: 0, fase: 'nombre', agotado: false },
        preguntasCierre: 1,
    });
    const sink = [];

    await turno(phone, sink, 'Ihab');

    assert.strictEqual(session.partialData.nombre, 'Ihab');
    assert.strictEqual(session.pendingNameForBooking.fase, 'apellido');
    assert.ok(/apellido/i.test(ultimo(sink)), `no pidió el apellido: "${ultimo(sink)}"`);
    assert.strictEqual(reservas.length, 0, 'todavía no se escribe: espera el apellido');
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { console.error(`fail - ${name}`); console.error('  ' + e.message); fallos++; }
    }
    if (fallos) { console.error(`\n${fallos} test(s) fallidos`); process.exit(1); }
    console.log('\nTests de la puerta del nombre (no come turno) OK');
    process.exit(0);
})();
