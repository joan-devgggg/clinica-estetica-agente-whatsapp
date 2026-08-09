/**
 * tests/espera-sin-atender.test.js — Nadie vigilaba lo que el bot suelta.
 *
 * Los casos de aquí NO son inventados: son los de la auditoría del 09/08/2026 sobre las 38
 * conversaciones de Sante, con sus fechas y horas reales.
 *
 *  - Olga Yarmak escaló el vie 07/08 a las 17:42 y seguía sin respuesta 3 días después.
 *  - 34656332064 pidió ayuda el sáb 08/08 a las 11:08 tras un "en breve se pondrá en
 *    contacto contigo", y seguía esperando 33 h más tarde.
 *  - Valeria Rivera escribió el sáb 01/08 a las 16:22 y el bot se quedó mudo: la primera
 *    respuesta humana llegó a las 20:18, ya con el salón cerrado.
 *  - Tania Daza escaló el dom 02/08 a las 22:33 — cerrado y en domingo.
 *
 * El umbral es de horario de ATENCIÓN, no de reloj. Y la medición que lo justifica: de 213
 * entrantes, 199 se contestaron en menos de 20 segundos. Entre 18 s y 236 min no hay nada,
 * así que cualquier umbral de esa franja da 0 falsos positivos: el número sale de la jornada
 * del salón (9 h), no de la distribución.
 */
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { test } = require('node:test');

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// Telegram interceptado en su frontera real.
const avisos = [];
let entrega = true;
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        notifyOrgAdmin: async (orgId, mensaje) => { avisos.push({ orgId, mensaje }); return entrega; },
        startTelegramBot: () => {},
    },
};

const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

const {
    decidirAvisoEspera, revisarEsperas, mensajeEscalada, mensajeSinResponder,
    duracionTexto, telefonoBonito, MINUTOS_PARA_AVISAR, HORIZONTE_DIAS, _resetWatchdog,
} = require('../services/espera-alert');
const { _resetThrottle } = require('../services/admin-alerts');

// El horario REAL de Sante: L-S 10:00–19:00, domingo cerrado.
const HORARIO = {
    lun: { apertura: '10:00', cierre: '19:00', abierto: true },
    mar: { apertura: '10:00', cierre: '19:00', abierto: true },
    mie: { apertura: '10:00', cierre: '19:00', abierto: true },
    jue: { apertura: '10:00', cierre: '19:00', abierto: true },
    vie: { apertura: '10:00', cierre: '19:00', abierto: true },
    sab: { apertura: '10:00', cierre: '19:00', abierto: true },
    dom: { apertura: '10:00', cierre: '19:00', abierto: false },
};

// 2026: sáb 01/08 · dom 02/08 · lun 03/08 · vie 07/08 · sáb 08/08 · dom 09/08 · lun 10/08.
const t = iso => new Date(`${iso}+02:00`);   // hora de pared de Madrid en verano

function limpiar() { avisos.length = 0; logs.length = 0; entrega = true; _resetWatchdog(); _resetThrottle(); }

const escalada = (over = {}) => ({
    id: 'pa-1', creadaAt: t('2026-08-07T17:42'), motivo: 'pedir_persona',
    ultimoTexto: 'Вы или меня не понимаете или просто угораете 😭',
    contactId: 'c-olga', telefono: '34674987146', nombre: 'Olga Yarmak', blacklisted: false, ...over,
});
const sinResponder = (over = {}) => ({
    conversationId: 'cv-1', esperandoDesde: t('2026-08-01T16:22'),
    ultimoTexto: 'No tengo estilista', contactId: 'c-valeria', telefono: '34611209542',
    nombre: 'Valeria Rivera', blacklisted: false, botMode: 'auto', ...over,
});

// ─── La decisión ─────────────────────────────────────────────────────────────

test('el umbral es 1 h de APERTURA, y una hora de reloj de noche no cuenta', () => {
    assert.strictEqual(MINUTOS_PARA_AVISAR, 60);
    const desde = t('2026-08-07T17:42');   // viernes, salón abierto hasta las 19:00

    assert.strictEqual(decidirAvisoEspera({ desde, ahora: t('2026-08-07T18:41'), horario: HORARIO }).avisar,
        false, 'a los 59 min todavía no');

    const justo = decidirAvisoEspera({ desde, ahora: t('2026-08-07T18:42'), horario: HORARIO });
    assert.strictEqual(justo.avisar, true);
    assert.strictEqual(justo.motivo, 'acumulado');
    assert.strictEqual(justo.minutosAbierto, 60);
});

test('Olga (vie 17:42) se caza el MISMO viernes, antes de cerrar', () => {
    // Es el argumento de por qué 60 y no 120: con 2 h, esta espera se iría al lunes siguiente
    // (quedan 78 min de jornada). Con 1 h se avisa a las 18:42, con el salón todavía abierto.
    const desde = t('2026-08-07T17:42');
    assert.strictEqual(decidirAvisoEspera({ desde, ahora: t('2026-08-07T18:45'), horario: HORARIO }).avisar, true);

    const conDos = require('../services/horario-apertura')
        .minutosDeAperturaEntre(desde, t('2026-08-07T19:00'), HORARIO).minutos;
    assert.strictEqual(conDos, 78, 'el viernes solo quedaban 78 min de jornada tras escalar');
});

test('escribió de noche o en domingo: NO avisa de madrugada, y sí al abrir', () => {
    // Tania Daza escaló el domingo 02/08 a las 22:33. Cerrado, y encima domingo.
    const desde = t('2026-08-02T22:33');

    const madrugada = decidirAvisoEspera({ desde, ahora: t('2026-08-03T02:00'), horario: HORARIO });
    assert.strictEqual(madrugada.avisar, false, 'un Telegram a las 2 de la mañana es cómo se silencian los avisos');
    assert.strictEqual(madrugada.minutosAbierto, 0);

    const alAbrir = decidirAvisoEspera({ desde, ahora: t('2026-08-03T10:05'), horario: HORARIO });
    assert.strictEqual(alAbrir.avisar, true, 'ya ha esperado toda la noche: no se le hace acumular otra hora');
    assert.strictEqual(alAbrir.motivo, 'abierto_con_espera_anterior');
});

test('el domingo no suma: sábado a las 18:50 no avisa hasta el lunes', () => {
    const desde = t('2026-08-08T18:50');
    assert.strictEqual(decidirAvisoEspera({ desde, ahora: t('2026-08-09T15:00'), horario: HORARIO }).avisar,
        false, 'domingo cerrado');
    assert.strictEqual(decidirAvisoEspera({ desde, ahora: t('2026-08-10T10:05'), horario: HORARIO }).motivo,
        'abierto_con_espera_anterior');
});

test('más allá del horizonte no hay nadie esperando, hay una conversación muerta', () => {
    assert.strictEqual(HORIZONTE_DIAS, 7);
    const d = decidirAvisoEspera({ desde: t('2026-08-01T11:00'), ahora: t('2026-08-20T11:00'), horario: HORARIO });
    assert.strictEqual(d.avisar, false);
    assert.strictEqual(d.motivo, 'fuera_de_horizonte');
});

test('sin fecha legible no se inventa una espera', () => {
    assert.strictEqual(decidirAvisoEspera({ desde: null, ahora: new Date(), horario: HORARIO }).avisar, false);
    assert.strictEqual(decidirAvisoEspera({ desde: 'ayer', ahora: new Date(), horario: HORARIO }).motivo, 'fecha_ilegible');
});

// ─── Los 199 que SÍ se contestaron: ni uno debe avisar ───────────────────────

test('los 199 entrantes contestados en segundos no producen NI UN aviso', () => {
    // p50 9,6 s · p95 13,1 s · p99 16,0 s · máximo 18 s. Ese es el tráfico normal del bot.
    const desde = t('2026-08-04T12:00');
    for (const seg of [9.6, 13.1, 16, 18, 60, 300]) {
        const ahora = new Date(desde.getTime() + seg * 1000);
        assert.strictEqual(decidirAvisoEspera({ desde, ahora, horario: HORARIO }).avisar, false,
            `${seg}s no puede disparar un aviso`);
    }
});

// ─── El vigilante completo ───────────────────────────────────────────────────

test('una escalada sin atender avisa UNA vez, no cada 10 minutos', async () => {
    limpiar();
    const estado = { horario: HORARIO, escaladas: [escalada()], sinResponder: [] };

    assert.strictEqual(await revisarEsperas(ORG, estado, t('2026-08-07T18:45')), 1);
    assert.strictEqual(await revisarEsperas(ORG, estado, t('2026-08-07T18:55')), 0);
    assert.strictEqual(await revisarEsperas(ORG, estado, t('2026-08-08T11:00')), 0);

    assert.strictEqual(avisos.length, 1, 'el vigilante tica cada 10 min: sin throttle serían decenas');
    assert.ok(logs.some(l => l.evento === 'espera_escalada_sin_atender'));
});

test('el aviso deja actuar sin abrir el panel: quién, desde cuándo, qué dijo y dónde escribir', async () => {
    limpiar();
    await revisarEsperas(ORG, { horario: HORARIO, escaladas: [escalada()], sinResponder: [] }, t('2026-08-07T18:45'));

    const m = avisos[0].mensaje;
    assert.ok(m.includes('Olga Yarmak'), 'quién');
    assert.ok(m.includes('+34 674 987 146'), 'teléfono legible');
    assert.ok(/hoy a las 17:42/.test(m), 'desde cuándo, en hora de pared');
    assert.ok(/1 h/.test(m), 'cuánto lleva esperando');
    assert.ok(/salón abierto/.test(m), 'y que el tiempo es de apertura, no de reloj');
    assert.ok(m.includes('pidió hablar con una persona'), 'el motivo, en español corriente');
    assert.ok(m.includes('угораете'), 'lo último que dijo la clienta');
    assert.ok(m.includes('https://wa.me/34674987146'), 'un enlace en el que tocar');
    assert.ok(!/pedir_persona|pending_action|escalation/.test(m), 'nada de jerga interna');
});

test('cuando alguien contesta, el aviso se cierra y una espera NUEVA vuelve a avisar', async () => {
    limpiar();
    const conv = sinResponder();
    await revisarEsperas(ORG, { horario: HORARIO, escaladas: [], sinResponder: [conv] }, t('2026-08-01T17:30'));
    assert.strictEqual(avisos.length, 1);

    // Contestada: ya no aparece en la lectura, así que su clave se libera.
    await revisarEsperas(ORG, { horario: HORARIO, escaladas: [], sinResponder: [] }, t('2026-08-01T18:00'));
    assert.ok(logs.some(l => l.evento === 'espera_atendida'));

    // Vuelve a escribir y vuelven a dejarla colgada: tiene que avisar otra vez.
    await revisarEsperas(ORG, {
        horario: HORARIO, escaladas: [],
        sinResponder: [sinResponder({ esperandoDesde: t('2026-08-03T11:00') })],
    }, t('2026-08-03T12:30'));
    assert.strictEqual(avisos.length, 2, 'sin liberar la clave, la segunda espera no avisaría jamás');
});

test('una clienta con escalada abierta NO recibe dos avisos por lo mismo', async () => {
    limpiar();
    // Es el caso de Olga: tiene escalada pendiente Y su último mensaje sin contestar.
    const entregados = await revisarEsperas(ORG, {
        horario: HORARIO,
        escaladas: [escalada()],
        sinResponder: [sinResponder({ conversationId: 'cv-olga', contactId: 'c-olga', esperandoDesde: t('2026-08-07T17:42') })],
    }, t('2026-08-07T18:45'));

    assert.strictEqual(entregados, 1, 'dos Telegrams por la misma clienta es el ruido que hace que no se lea ninguno');
    assert.ok(/espera a que le escriba una persona/.test(avisos[0].mensaje), 'gana el de la escalada, que lleva el motivo');
});

test('con el bot pausado calla: de eso avisa bot-pause-alert, y una vez', async () => {
    limpiar();
    const entregados = await revisarEsperas(ORG, {
        botActivo: false, horario: HORARIO,
        escaladas: [escalada()],
        sinResponder: [sinResponder(), sinResponder({ conversationId: 'cv-2', contactId: 'c-2' })],
    }, t('2026-08-07T18:45'));

    assert.strictEqual(entregados, 0);
    assert.strictEqual(avisos.length, 0, 'una pausa de org deja a TODAS sin responder: aquí sería una inundación');
    assert.ok(logs.some(l => l.evento === 'espera_watchdog_omitido_bot_pausado'));
});

test('a una clienta en lista negra no se le contesta a propósito: no es una espera', async () => {
    limpiar();
    const entregados = await revisarEsperas(ORG, {
        horario: HORARIO,
        escaladas: [escalada({ blacklisted: true })],
        sinResponder: [sinResponder({ blacklisted: true })],
    }, t('2026-08-07T18:45'));
    assert.strictEqual(entregados, 0);
    assert.strictEqual(avisos.length, 0);
});

test('si el aviso no llega a Telegram, se reintenta en el siguiente tic', async () => {
    limpiar();
    entrega = false;
    const estado = { horario: HORARIO, escaladas: [escalada()], sinResponder: [] };

    assert.strictEqual(await revisarEsperas(ORG, estado, t('2026-08-07T18:45')), 0);
    assert.strictEqual(avisos.length, 1, 'se intentó');
    assert.ok(logs.some(l => l.evento === 'admin_alert_no_entregado'));

    entrega = true;
    assert.strictEqual(await revisarEsperas(ORG, estado, t('2026-08-07T18:55')), 1,
        'un aviso que no llegó vale lo mismo que no haberlo mandado');
    assert.strictEqual(avisos.length, 2);
});

test('el aviso de turno caído dice que el fallo es del bot; el de manual, que toca a una persona', async () => {
    limpiar();
    await revisarEsperas(ORG, { horario: HORARIO, escaladas: [], sinResponder: [sinResponder()] }, t('2026-08-01T17:30'));
    assert.ok(/El bot debería haberle contestado en segundos/.test(avisos[0].mensaje));

    limpiar();
    await revisarEsperas(ORG, {
        horario: HORARIO, escaladas: [],
        sinResponder: [sinResponder({ botMode: 'manual', conversationId: 'cv-svetlana' })],
    }, t('2026-08-01T17:30'));
    assert.ok(/está en manual/.test(avisos[0].mensaje));
});

// ─── Detalles del texto ──────────────────────────────────────────────────────

test('el tiempo y el teléfono se escriben para leerlos, no para parsearlos', () => {
    assert.strictEqual(duracionTexto(45), '45 min');
    assert.strictEqual(duracionTexto(60), '1 h');
    assert.strictEqual(duracionTexto(78), '1 h 18 min');
    assert.strictEqual(duracionTexto(678), '11 h 18 min');

    assert.strictEqual(telefonoBonito('34674987146'), '+34 674 987 146');
    assert.strictEqual(telefonoBonito('447432204269'), '+447432204269');
    assert.strictEqual(telefonoBonito(null), 'sin teléfono');
});

test('un motivo desconocido se enseña crudo en vez de disfrazarse de otro', () => {
    const m = mensajeEscalada(
        { nombre: 'X', telefono: '34600000000', ultimoTexto: null, motivo: 'motivo_nuevo_sin_traducir' },
        t('2026-08-07T17:42'), 60, t('2026-08-07T18:42'));
    assert.ok(m.includes('motivo_nuevo_sin_traducir'), 'inventarle una traducción sería peor que enseñar la etiqueta');
});

test('el texto de la clienta no puede romper el HTML del aviso', () => {
    const m = mensajeSinResponder(
        { nombre: '<b>Ana</b>', telefono: '34600000000', ultimoTexto: 'me dijo <script>alert(1)</script>', botMode: 'auto' },
        t('2026-08-01T16:22'), 60, t('2026-08-01T17:22'));
    assert.ok(!/<script>/.test(m));
    assert.ok(m.includes('&lt;script&gt;'));
    assert.ok(m.includes('&lt;b&gt;Ana&lt;/b&gt;'));
});

test('un mensaje larguísimo se recorta: el aviso da contexto, no transcribe', () => {
    const m = mensajeSinResponder(
        { nombre: 'Ana', telefono: '34600000000', ultimoTexto: 'a'.repeat(500), botMode: 'auto' },
        t('2026-08-01T16:22'), 60, t('2026-08-01T17:22'));
    assert.ok(m.includes('…'));
    assert.ok(m.length < 700);
});

test('sin nombre en la ficha, el teléfono se dice UNA vez', () => {
    const m = mensajeEscalada(
        { nombre: null, telefono: '34656332064', motivo: 'consulta_permanente', ultimoTexto: 'Si por favor gracias' },
        t('2026-08-08T11:08'), 480, t('2026-08-10T10:05'));
    assert.strictEqual((m.match(/\+34 656 332 064/g) || []).length, 1,
        'concatenar nombre y teléfono sin mirar daba "+34 656 332 064 · +34 656 332 064"');
    assert.ok(/el sábado 8 de agosto a las 11:08/.test(m), 'sin la coma que mete es-ES');
});
