// El nombre se pide ANTES de escribir la cita (Sante).
//
// El 02/08/2026 el bot reservó una cita entera sin nombre: preguntó "Как тебя зовут?", la
// clienta contestó otra cosa, y 17 mensajes después escribió la cita con contacts.full_name
// = null. Esa clienta acabó además fuera del recordatorio de 24 h, porque el recordatorio no
// puede salir sin nombre.
//
// Comportamiento congelado aquí:
//   · sin nombre → se pregunta y NO se escribe nada
//   · respuesta inválida → UNA segunda pregunta, con frase DISTINTA
//   · segundo fallo → se reserva IGUAL, sin nombre, con logger.warn
//   · apellido: como máximo una vez, nunca bloquea
//   · tope duro de 2 preguntas entre elegir hueco y confirmar
//
// Y los tres invariantes que no se pueden romper:
//   1. el turno de la pregunta no suena a cita hecha (la red anti-fantasma no lo bloquea)
//   2. el hueco se revalida en CADA reentrada
//   3. el estado sobrevive a una recarga de sesión

process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };

const SERVICIO = { nombre: 'Alisado vegano', categoria: 'Alisados', duracion: 60, precio: 210 };
const CATALOGO = [SERVICIO, { nombre: 'Manicura', categoria: 'Uñas', duracion: 45, precio: 25 }];

let state;
function resetState() {
    state = {
        citasGuardadas: [], leadsGuardados: [], warns: [], infos: [],
        slotLibre: true,
    };
}
resetState();

const dbPath = require.resolve('../services/db');
const dbReal = require(dbPath);
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        ...dbReal,
        async getAgentConfig() {
            return { services: CATALOGO, business_info: { direccion: 'Calle San Juan Bosco 14' } };
        },
        async saveLead(orgId, datos) { state.leadsGuardados.push(datos); return 'contact-1'; },
        async updateLead() { return true; },
        async hasActiveAppointmentForSlot() { return false; },
        async getUpcomingAppointments() { return []; },
        async getAppointmentsByLead() { return []; },
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

const bot = require('../bot');
const {
    evaluarNombreAntesDeReservar, handleNombreParaCita, handleApellidoParaCita,
    leerNombreDeRespuesta, preguntaNombreMsg, preguntaApellidoMsg, PENDIENTE_NOMBRE,
    createEmptySession, llmClaimsBooked, clearServiceState, SERVICE_STATE_DEFAULTS,
    textoPuertaNombre, pedirNombre, textoYaPideNombre, mencionaLoRetenido,
    ACUSE_HUECO_LIBRE, CODAS_NOMBRE_MAX, buildSessionExtra,
} = bot._internals;

const BOT = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const SLOT = { fecha: '2026-08-12', hora: '16:30', stylistId: 'sty-1' };

function sesion(over = {}) {
    const s = createEmptySession('34600111222', 'org-sante', '34600111222');
    s.orgType = 'salon';
    s.leadId = 'contact-1';
    s.language = 'es';
    s.selectedService = SERVICIO;
    s.selectedStylist = { id: 'sty-1', nombre: 'Irina' };
    return Object.assign(s, over);
}

// Captura lo que el bot envía.
function makeSend(sink) { return async texto => { sink.push(texto); }; }

// La puerta como la recorre PRODUCCIÓN: arma la espera y, acto seguido, emite el texto.
//
// Desde el 17/08/2026 son dos pasos y no uno: `evaluarNombreAntesDeReservar` ARMA y no cuenta,
// y quien cuenta es el emisor (`textoPuertaNombre` → `pedirNombre`), porque solo en el momento
// de emitir se sabe si la pregunta va sola o PEGADA a una respuesta — y una pregunta pegada a
// una respuesta no le cuesta un turno a la clienta, así que no puede gastar el presupuesto que
// protege la reserva. Contando en la puerta, cada disparo de la confirmación gastaba tope y dos
// preguntas sobre horas dejaban la cita sin nombre (medido: era el caso de Ihab).
function puerta(s, sink = []) {
    const r = evaluarNombreAntesDeReservar(s, SLOT, '34600111222');
    if (r === PENDIENTE_NOMBRE) sink.push(textoPuertaNombre(s, { conRespuesta: false }));
    return r;
}

// ─── La puerta ───────────────────────────────────────────────────────────────

test('sin nombre: la puerta devuelve PENDIENTE_NOMBRE y deja la reserva en espera', () => {
    resetState();
    const s = sesion();
    const r = puerta(s);
    assert.strictEqual(r, PENDIENTE_NOMBRE);
    assert.ok(s.pendingNameForBooking, 'la reserva queda en espera');
    assert.strictEqual(s.pendingNameForBooking.intentos, 1);
    assert.deepStrictEqual(s.pendingNameForBooking.slot, SLOT, 'con el hueco guardado');
    assert.strictEqual(s.preguntasCierre, 1);
});

test('si el contacto YA tiene nombre no se pregunta nada', () => {
    resetState();
    const s = sesion({ partialData: { telefono: '34600111222', nombre: 'Marina Petrova' } });
    assert.strictEqual(evaluarNombreAntesDeReservar(s, SLOT, '34600111222'), null);
    assert.strictEqual(s.pendingNameForBooking, null);
    assert.strictEqual(s.preguntasCierre, 0);
});

test('San Remo no pasa por la puerta', () => {
    resetState();
    const s = sesion({ orgType: 'restaurant' });
    assert.strictEqual(evaluarNombreAntesDeReservar(s, SLOT, '34600111222'), null);
    // Y finalizarReservaConBizum no se toca.
    assert.ok(!/evaluarNombreAntesDeReservar/.test(
        BOT.split('async function finalizarReservaConBizum')[1].split('\n// ─')[0]));
});

test('tope duro: con 2 preguntas ya gastadas no se pregunta más', () => {
    resetState();
    const s = sesion({ preguntasCierre: 2 });
    assert.strictEqual(evaluarNombreAntesDeReservar(s, SLOT, '34600111222'), null,
        'se reserva sin nombre antes que hacer una tercera pregunta');
});

// ─── INVARIANTE 1 · el turno de la pregunta no suena a cita hecha ────────────

test('INVARIANTE 1 · ninguna pregunta dispara llmClaimsBooked', () => {
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        const s = sesion({ language: lang });
        for (const intento of [1, 2]) {
            const msg = preguntaNombreMsg(s, intento);
            assert.ok(!llmClaimsBooked(msg),
                `"${msg}" suena a cita hecha → la red anti-fantasma lo bloquearía`);
            assert.ok(!msg.includes('✅'), 'sin ✅ en un turno que no ha escrito nada');
            assert.ok(!/\d{1,2}:\d{2}/.test(msg), 'sin hora: parecería una confirmación');
        }
        assert.ok(!llmClaimsBooked(preguntaApellidoMsg(s)));
    }
});

test('INVARIANTE 1 · el segundo intento NO repite la frase del primero', () => {
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        const s = sesion({ language: lang });
        assert.notStrictEqual(preguntaNombreMsg(s, 1), preguntaNombreMsg(s, 2),
            `en ${lang} se repite la misma frase: parece que el bot se ha colgado`);
    }
});

// ─── INVARIANTE 5 · validación estricta ──────────────────────────────────────

test('validación estricta: no se guarda basura como nombre', () => {
    for (const t of ['da igual', 'sí', 'no', 'хочу', 'спасибо', 'vale', 'lo que sea',
        'Alisado vegano', 'Manicura', '?', '']) {
        assert.strictEqual(leerNombreDeRespuesta(t, CATALOGO), null, `NO debe aceptar "${t}"`);
    }
});

test('validación estricta: sí acepta nombres reales, incluido cirílico', () => {
    assert.strictEqual(leerNombreDeRespuesta('Marta', CATALOGO), 'Marta');
    assert.strictEqual(leerNombreDeRespuesta('Marina Petrova', CATALOGO), 'Marina Petrova');
    assert.strictEqual(leerNombreDeRespuesta('Me llamo Marina Petrova', CATALOGO), 'Marina Petrova');
    assert.strictEqual(leerNombreDeRespuesta('Наталья', CATALOGO), 'Наталья');
    assert.strictEqual(leerNombreDeRespuesta('Меня зовут Наталья', CATALOGO), 'Наталья');
});

// ─── Flujo de reentrada ──────────────────────────────────────────────────────

test('no contesta el nombre: segunda pregunta, distinta, y sigue sin escribirse nada', async () => {
    resetState();
    const s = sesion();
    puerta(s);
    const enviados = [];

    const resuelto = await handleNombreParaCita(
        null, 'org-sante', s, 'da igual', makeSend(enviados), '34600111222');

    assert.strictEqual(resuelto, true, 'el turno lo resuelve el handler');
    assert.strictEqual(enviados.length, 1);
    assert.strictEqual(enviados[0], preguntaNombreMsg(s, 2), 'segunda frase, no la primera');
    assert.strictEqual(s.pendingNameForBooking.intentos, 2);
    assert.strictEqual(s.preguntasCierre, 2);
    assert.strictEqual(state.citasGuardadas.length, 0, 'nada escrito todavía');
});

test('contesta al SEGUNDO intento: se guarda el nombre', async () => {
    resetState();
    const s = sesion();
    puerta(s);
    await handleNombreParaCita(null, 'org-sante', s, 'ni idea', makeSend([]), '34600111222');

    // Segundo turno: ahora sí da el nombre. Con apellido, para que no pregunte más.
    await handleNombreParaCita(null, 'org-sante', s, 'Marina Petrova', makeSend([]), '34600111222');

    assert.strictEqual(s.partialData.nombre, 'Marina Petrova');
});

test('da nombre Y apellido de una: NO se pregunta el apellido', async () => {
    resetState();
    const s = sesion();
    puerta(s);
    const enviados = [];

    await handleNombreParaCita(null, 'org-sante', s, 'Marina Petrova', makeSend(enviados), '34600111222');

    assert.strictEqual(s.partialData.nombre, 'Marina Petrova');
    assert.ok(!enviados.includes(preguntaApellidoMsg(s)), 'no debe preguntar el apellido');
    assert.strictEqual(s.preguntasCierre, 1, 'solo se gastó la pregunta del nombre');
});

test('da solo el nombre: se pregunta el apellido UNA vez', async () => {
    resetState();
    const s = sesion();
    puerta(s);
    const enviados = [];

    const resuelto = await handleNombreParaCita(
        null, 'org-sante', s, 'Marta', makeSend(enviados), '34600111222');

    assert.strictEqual(resuelto, true);
    assert.strictEqual(enviados[0], preguntaApellidoMsg(s));
    assert.strictEqual(s.pendingNameForBooking.fase, 'apellido');
    assert.strictEqual(s.preguntasCierre, 2, 'nombre + apellido = tope alcanzado');
});

test('el apellido NUNCA bloquea: si no llega, se guarda solo el nombre', async () => {
    resetState();
    const s = sesion();
    puerta(s);
    await handleNombreParaCita(null, 'org-sante', s, 'Marta', makeSend([]), '34600111222');
    assert.strictEqual(s.pendingNameForBooking.fase, 'apellido');

    // Contesta cualquier cosa que no es un apellido.
    await handleApellidoParaCita(null, 'org-sante', s, 'da igual', makeSend([]), '34600111222');

    assert.strictEqual(s.partialData.nombre, 'Marta', 'se queda solo con el nombre');
    assert.ok(state.infos.some(i => i.evento === 'cita_sante_apellido_no_llego'));
});

test('si el nombre gasta las 2 preguntas, el apellido ya no se pide', async () => {
    resetState();
    const s = sesion();
    puerta(s);                                                     // pregunta 1
    await handleNombreParaCita(null, 'org-sante', s, 'qué?', makeSend([]), '34600111222'); // pregunta 2
    assert.strictEqual(s.preguntasCierre, 2);
    const enviados = [];

    await handleNombreParaCita(null, 'org-sante', s, 'Marta', makeSend(enviados), '34600111222');

    assert.strictEqual(s.partialData.nombre, 'Marta');
    assert.ok(!enviados.includes(preguntaApellidoMsg(s)), 'tope agotado: no se pregunta el apellido');
});

// ─── Se reserva IGUAL tras dos fallos ────────────────────────────────────────

test('dos intentos fallidos: la cita SE CREA sin nombre y sale el warn', () => {
    resetState();
    const s = sesion();
    evaluarNombreAntesDeReservar(s, SLOT, '34600111222');
    s.pendingNameForBooking = { ...s.pendingNameForBooking, intentos: 2, agotado: true };

    // La puerta ya no vuelve a preguntar: deja pasar la escritura.
    assert.strictEqual(evaluarNombreAntesDeReservar(s, SLOT, '34600111222'), null);

    // Y finalizarCitaSante emite el warn justo antes de escribir.
    const fn = BOT.split('async function finalizarCitaSante')[1].split('\n// ─')[0];
    assert.ok(/logger\.warn\('cita_sante_sin_nombre'/.test(fn));
    assert.ok(fn.indexOf("logger.warn('cita_sante_sin_nombre'") < fn.indexOf('saveLead('),
        'el warn va antes de escribir, no después');
});

// ─── INVARIANTE 2 · el hueco se revalida en cada reentrada ───────────────────

test('INVARIANTE 2 · la reentrada pasa por confirmSlotConReverificacion', () => {
    const fn = BOT.split('async function finalizarReservaPendiente')[1].split('\n// ─')[0];
    assert.ok(/confirmSlotConReverificacion\(client, session, userPhone, slot\)/.test(fn),
        'entre la pregunta y la respuesta pasan turnos: el hueco puede haberse ocupado');
    assert.ok(/res\.reason === 'ocupado'/.test(fn), 'y hay que contemplar que lo esté');
    assert.ok(/buildHuecoOcupadoMsg/.test(fn), 'ofreciéndole huecos reales, no un error vacío');
});

test('INVARIANTE 2 · si el hueco se ocupó, NO se reserva y se avisa', async () => {
    resetState();
    const s = sesion();
    puerta(s);
    const enviados = [];
    // confirmSlotConReverificacion recarga huecos reales; sin calendario devuelve 'ocupado'.
    await handleNombreParaCita(null, 'org-sante', s, 'Marina Petrova', makeSend(enviados), '34600111222');

    assert.strictEqual(state.citasGuardadas.length, 0, 'no se crea la cita');
    assert.strictEqual(s.reservaConfirmada, false, 'y no se le dice que la tiene');
    assert.strictEqual(s.pendingNameForBooking, null, 'la espera se cierra');
    assert.strictEqual(enviados.length, 1, 'se le responde algo, nunca silencio');
});

// ─── INVARIANTE 3 · sobrevive a una recarga de sesión ────────────────────────

test('INVARIANTE 3 · pendingNameForBooking se persiste y se restaura', () => {
    // Va por el MISMO camino que selectedService: buildSessionExtra → SQLite → recarga.
    const extra = BOT.split('function buildSessionExtra')[1].split('\nfunction ')[0];
    assert.ok(/pendingNameForBooking: session\.pendingNameForBooking/.test(extra),
        'sin esto la clienta contesta su nombre al vacío y la cita no se guarda nunca');
    assert.ok(/preguntasCierre: session\.preguntasCierre/.test(extra));
    assert.ok(/newSession\.pendingNameForBooking = ex\.pendingNameForBooking/.test(BOT),
        'y hay que restaurarlo al recargar');
    assert.ok(/newSession\.preguntasCierre\s+= ex\.preguntasCierre/.test(BOT));
});

test('INVARIANTE 3 · el flujo continúa tras una recarga entre la pregunta y la respuesta', async () => {
    resetState();
    const s = sesion();
    evaluarNombreAntesDeReservar(s, SLOT, '34600111222');

    // Simula el viaje completo por SQLite: se serializa el extra y se rehidrata una sesión nueva.
    const extra = JSON.parse(JSON.stringify(bot._internals.buildSessionExtra
        ? bot._internals.buildSessionExtra(s)
        : { pendingNameForBooking: s.pendingNameForBooking, preguntasCierre: s.preguntasCierre }));
    const recargada = sesion();
    recargada.pendingNameForBooking = extra.pendingNameForBooking;
    recargada.preguntasCierre = extra.preguntasCierre;

    assert.ok(recargada.pendingNameForBooking, 'la espera sobrevive');
    assert.deepStrictEqual(recargada.pendingNameForBooking.slot, SLOT, 'con su hueco');

    const enviados = [];
    const resuelto = await handleNombreParaCita(
        null, 'org-sante', recargada, 'Marina Petrova', makeSend(enviados), '34600111222');

    assert.strictEqual(resuelto, true, 'el turno se resuelve: no contesta al vacío');
    assert.strictEqual(recargada.partialData.nombre, 'Marina Petrova');
});

// ─── INVARIANTE 4 · limpieza de estado ───────────────────────────────────────

test('INVARIANTE 4 · está en SERVICE_STATE_DEFAULTS y clearServiceState lo limpia', () => {
    assert.ok('pendingNameForBooking' in SERVICE_STATE_DEFAULTS);
    assert.ok('preguntasCierre' in SERVICE_STATE_DEFAULTS);
    const s = sesion();
    s.pendingNameForBooking = { slot: SLOT, intentos: 2, fase: 'nombre' };
    s.preguntasCierre = 2;
    clearServiceState(s);
    assert.strictEqual(s.pendingNameForBooking, null);
    assert.strictEqual(s.preguntasCierre, 0);
});

test('INVARIANTE 4 · al reservar se limpia SIEMPRE, con nombre o sin él', () => {
    const fn = BOT.split('async function finalizarCitaSante')[1].split('\n// ─')[0];
    assert.ok(/session\.pendingNameForBooking = null;/.test(fn));
    assert.ok(fn.indexOf('session.pendingNameForBooking = null;') < fn.indexOf('saveLead('),
        'se limpia antes de escribir, no en una rama de éxito que puede no alcanzarse');
});

// ─── INVARIANTE 6 · el acuse solo sale con el hueco VERIFICADO en ese turno ──
//
// El acuse deíctico («ese hueco te lo puedo dejar») es lo que hace que el turno de la puerta
// CONTESTE: Ihab preguntó por las 15:00 y solo recibió la pregunta del nombre. Pero afirmar que
// el hueco está ahí sin haberlo comprobado es afirmar disponibilidad sin respaldo, así que la
// condición es dura y se prueba en las dos direcciones.

test('INVARIANTE 6 · con el hueco verificado en ESTE turno, el acuse sale (4 idiomas)', () => {
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        const s = sesion({ language: lang });
        evaluarNombreAntesDeReservar(s, SLOT, '34600111222');
        s._huecoVerificadoEsteTurno = true;
        const msg = textoPuertaNombre(s, { conRespuesta: false });
        assert.ok(msg.startsWith(ACUSE_HUECO_LIBRE[lang]), `${lang}: falta el acuse → "${msg}"`);
        assert.ok(msg.endsWith(preguntaNombreMsg(s, 1)), `${lang}: falta la pregunta → "${msg}"`);
        // Y sigue sin poder sonar a cita hecha: es un turno que no ha escrito nada.
        assert.ok(!llmClaimsBooked(msg), `${lang}: el acuse suena a reserva hecha`);
        assert.ok(!msg.includes('✅'), `${lang}: ✅ en un turno sin escritura`);
        assert.ok(!/\d{1,2}:\d{2}/.test(msg), `${lang}: el acuse dice una hora`);
    }
});

test('INVARIANTE 6 · SIN verificación no sale: solo la pregunta, en los 4 idiomas', () => {
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        const s = sesion({ language: lang });
        evaluarNombreAntesDeReservar(s, SLOT, '34600111222');
        // La bandera es de TURNO y aquí no la ha puesto nadie: es el caso del turno de
        // repregunta pura, donde no se ha vuelto a mirar el motor.
        const msg = textoPuertaNombre(s, { conRespuesta: false });
        assert.strictEqual(msg, preguntaNombreMsg(s, 1), `${lang}: acuse sin verificación`);
        assert.ok(!msg.includes(ACUSE_HUECO_LIBRE[lang]));
    }
});

test('INVARIANTE 6 · la bandera no viaja a SQLite (no es estado de la conversación)', () => {
    const s = sesion();
    s._huecoVerificadoEsteTurno = true;
    s._codaNombre = true;
    const extra = buildSessionExtra(s);
    assert.ok(!('_huecoVerificadoEsteTurno' in extra), 'un hueco verificado hace 3 turnos no está verificado');
    assert.ok(!('_codaNombre' in extra), 'un coda heredado se pegaría a un turno que no preguntó nada');
    // Y se borran al empezar cada turno, junto a la caché de citas vivas.
    assert.ok(/delete session\._huecoVerificadoEsteTurno;/.test(BOT));
    assert.ok(/delete session\._codaNombre;/.test(BOT));
});

// ─── El coda: una pregunta pegada a una respuesta ────────────────────────────

test('el coda NO gasta intento ni preguntasCierre, y tiene su propio tope de 2', () => {
    const s = sesion();
    evaluarNombreAntesDeReservar(s, SLOT, '34600111222');
    assert.strictEqual(CODAS_NOMBRE_MAX, 2, 'el tope de codas es el MISMO que el de preguntas');

    const c1 = pedirNombre(s, { conRespuesta: true });
    assert.ok(c1, 'la primera coda sale');
    assert.strictEqual(s.pendingNameForBooking.intentos, 0, 'no gasta intento');
    assert.strictEqual(s.preguntasCierre, 0, 'no gasta pregunta de cierre');
    assert.strictEqual(s.pendingNameForBooking.codas, 1);

    const c2 = pedirNombre(s, { conRespuesta: true });
    assert.ok(c2, 'la segunda coda sale');
    assert.notStrictEqual(c2, c1, 'y no repite la frase');

    assert.strictEqual(pedirNombre(s, { conRespuesta: true }), null, 'la tercera NO sale');
    assert.strictEqual(s.pendingNameForBooking.codas, 2, 'y no cuenta la que no salió');
    assert.strictEqual(s.preguntasCierre, 0, 'el tope del cierre sigue intacto');
});

test('los dos intentos PUROS siguen gastando, y el acuse no cambia eso', () => {
    const s = sesion();
    evaluarNombreAntesDeReservar(s, SLOT, '34600111222');
    s._huecoVerificadoEsteTurno = true;
    textoPuertaNombre(s, { conRespuesta: false });
    assert.strictEqual(s.pendingNameForBooking.intentos, 1);
    assert.strictEqual(s.preguntasCierre, 1);
});

// ─── La hora RETENIDA no se dice hasta que esté escrita ──────────────────────
//
// Es la regla que sustituye a una lista de verbos. Medido el 17/08/2026: las cinco frases de
// abajo dan `llmClaimsBooked` FALSE y no las para NINGUNA red (la anti-fantasma la gatea
// llmClaimsBooked; la de huecos inventados deja pasar la hora porque tiene respaldo real). Lo
// que se vigila aquí es el DATO, no la redacción.

test('mencionaLoRetenido caza la promesa que NO casa ningún patrón', () => {
    const slot = { fecha: '2026-08-17', hora: '15:00' };
    for (const frase of [
        'Te la dejo apartada a las 15:00.',
        'I will hold it for you at 3pm.',
        'Оставлю за тобой 15:00.',
        'Тримаю за тобою 15:00.',
    ]) {
        // La mitad del valor de este bloque está en esta línea: si algún día llmClaimsBooked
        // empieza a cazarla, este assert lo dirá y habrá que decidir qué red manda.
        assert.strictEqual(llmClaimsBooked(frase), false,
            `este test existe porque llmClaimsBooked NO la caza: "${frase}"`);
        assert.strictEqual(mencionaLoRetenido(frase, slot, []), true, `no cazada: "${frase}"`);
    }
    // Control: la que SÍ casa el patrón enumerado sigue casándolo.
    assert.strictEqual(llmClaimsBooked('Te la reservo para las 15:00'), true);
});

test('RESIDUO DECLARADO · una promesa SIN hora ni fecha no la caza esta regla', () => {
    // No es un agujero de este trabajo: es el hueco preexistente de llmClaimsBooked, que
    // afecta a TODOS los turnos anteriores a una reserva. Se deja escrito en un test para que
    // esté medido y no descubierto, y porque ensanchar llmClaimsBooked no es gratis —
    // alimenta resolveSalonConfirmation ('texto_llm_confirma'), así que pondría a CREAR citas
    // desde la prosa del modelo. Decisión del dueño, no de este arreglo.
    const slot = { fecha: '2026-08-17', hora: '15:00' };
    for (const frase of ['Perfecto, ese hueco es tuyo.', 'Vale, te lo guardo.']) {
        assert.strictEqual(llmClaimsBooked(frase), false);
        assert.strictEqual(mencionaLoRetenido(frase, slot, []), false);
    }
});

test('mencionaLoRetenido NO se come el horario del salón (la lección de Olga)', () => {
    const slot = { fecha: '2026-08-17', hora: '19:00' };   // el hueco retenido ES el de cierre
    assert.strictEqual(
        mencionaLoRetenido('Abrimos de 10:00 a 19:00.', slot, ['10:00', '19:00']),
        false,
        'declarar el horario no es hablar del hueco retenido',
    );
    // Y una respuesta que no habla de cuándo, tampoco.
    assert.strictEqual(mencionaLoRetenido('Sí, tenemos parking en la puerta.', slot, []), false);
});

test('mencionaLoRetenido también mira la FECHA retenida', () => {
    const slot = { fecha: '2026-08-28', hora: '15:00' };
    assert.strictEqual(mencionaLoRetenido('Te lo dejo para el 28 de agosto.', slot, []), true);
    assert.strictEqual(mencionaLoRetenido('Te lo dejo para el 29 de agosto.', slot, []), false);
});

test('textoYaPideNombre reconoce las cuatro preguntas propias (no se duplica el coda)', () => {
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        const s = sesion({ language: lang });
        for (const intento of [1, 2]) {
            assert.ok(textoYaPideNombre(preguntaNombreMsg(s, intento)),
                `${lang}/${intento}: no se reconoce como pregunta por el nombre`);
        }
    }
    assert.ok(!textoYaPideNombre('Sí, tenemos parking en la puerta.'));
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { console.error(`fail - ${name}`); console.error('  ' + e.message); fallos++; }
    }
    if (fallos) { console.error(`\n${fallos} test(s) fallidos`); process.exit(1); }
    console.log('\nTests de nombre antes de reservar OK');
    process.exit(0);
})();
