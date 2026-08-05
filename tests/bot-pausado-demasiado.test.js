/**
 * tests/bot-pausado-demasiado.test.js — Nadie debería dejar el bot pausado media jornada.
 *
 * El 01/08/2026 alguien pausó el bot de Sante a nivel de ORGANIZACIÓN creyendo que pausaba
 * una conversación. Estuvo 3 h 56 min tirando todos los mensajes de todas las clientas.
 * `notePausedDrop` (ya existente) avisa cuando se tira un mensaje: es reactivo, y deja fuera
 * la pausa que empieza de noche o en domingo, que no se manifiesta hasta que la primera
 * clienta se lleva el golpe.
 *
 * Esto vigila el ESTADO. El umbral son 2 h **de horario de atención**, no de reloj: con el
 * reloj corriendo de noche, una pausa inocua a las 23:00 mandaría un Telegram a la 1:00, que
 * es el camino más corto a que se silencie al bot.
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
    decidirAvisoPausa, revisarPausaProlongada, MINUTOS_PARA_AVISAR, _resetWatchdog,
} = require('../services/bot-pause-alert');
const { minutosDeAperturaEntre } = require('../services/horario-apertura');
const { _resetThrottle } = require('../services/admin-alerts');

// El horario REAL de Sante hoy: L-S 10:00–19:00, domingo cerrado.
const HORARIO = {
    lun: { apertura: '10:00', cierre: '19:00', abierto: true },
    mar: { apertura: '10:00', cierre: '19:00', abierto: true },
    mie: { apertura: '10:00', cierre: '19:00', abierto: true },
    jue: { apertura: '10:00', cierre: '19:00', abierto: true },
    vie: { apertura: '10:00', cierre: '19:00', abierto: true },
    sab: { apertura: '10:00', cierre: '19:00', abierto: true },
    dom: { apertura: '10:00', cierre: '19:00', abierto: false },
};

// Fechas de referencia (2026): mar 04/08, sáb 08/08, dom 09/08, lun 10/08.
const t = iso => new Date(`${iso}+02:00`); // hora de pared de Madrid en verano

function limpiar() { avisos.length = 0; logs.length = 0; entrega = true; _resetWatchdog(); _resetThrottle(); }

// ─── La aritmética de horas de apertura ──────────────────────────────────────

test('las horas de apertura no cuentan la noche ni el domingo', () => {
    // Martes 15:00 → 17:00: dos horas dentro del horario.
    assert.strictEqual(minutosDeAperturaEntre(t('2026-08-04T15:00'), t('2026-08-04T17:00'), HORARIO).minutos, 120);

    // 23:00 → 01:00: cero. El salón está cerrado.
    assert.strictEqual(minutosDeAperturaEntre(t('2026-08-04T23:00'), t('2026-08-05T01:00'), HORARIO).minutos, 0);

    // Sábado 18:50 → lunes 10:10: 10 min del sábado + 10 del lunes. El domingo no suma.
    assert.strictEqual(minutosDeAperturaEntre(t('2026-08-08T18:50'), t('2026-08-10T10:10'), HORARIO).minutos, 20);

    // Sin horario configurado no se inventa uno: cuenta reloj y lo dice.
    const sinH = minutosDeAperturaEntre(t('2026-08-04T23:00'), t('2026-08-05T01:00'), null);
    assert.strictEqual(sinH.minutos, 120);
    assert.strictEqual(sinH.sinHorario, true);
});

// ─── La decisión ─────────────────────────────────────────────────────────────

test('pausa un martes a las 15:00 → avisa a las 17:00, no antes', () => {
    assert.strictEqual(MINUTOS_PARA_AVISAR, 120);
    const pausadoDesde = t('2026-08-04T15:00');

    assert.strictEqual(decidirAvisoPausa({ pausadoDesde, ahora: t('2026-08-04T16:59'), horario: HORARIO }).avisar, false);

    const d = decidirAvisoPausa({ pausadoDesde, ahora: t('2026-08-04T17:00'), horario: HORARIO });
    assert.strictEqual(d.avisar, true);
    assert.strictEqual(d.motivo, 'acumulado');
});

test('el incidente real del 01/08 (3 h 56 min) se corta por la mitad', () => {
    const pausadoDesde = t('2026-08-04T14:00');
    // A las 15:56 llevaría el tiempo del incidente entero; a las 16:00 ya se ha avisado.
    assert.strictEqual(decidirAvisoPausa({ pausadoDesde, ahora: t('2026-08-04T16:00'), horario: HORARIO }).avisar, true);
});

test('pausa a las 23:00: NO avisa de madrugada, y sí al abrir', () => {
    const pausadoDesde = t('2026-08-04T23:00');

    const madrugada = decidirAvisoPausa({ pausadoDesde, ahora: t('2026-08-05T01:00'), horario: HORARIO });
    assert.strictEqual(madrugada.avisar, false, 'con el salón cerrado no hay daño ni Telegram');
    assert.strictEqual(madrugada.minutosAbierto, 0);

    const alAbrir = decidirAvisoPausa({ pausadoDesde, ahora: t('2026-08-05T10:01'), horario: HORARIO });
    assert.strictEqual(alAbrir.avisar, true, 'el daño empieza con la primera clienta del día');
    assert.strictEqual(alAbrir.motivo, 'abierto_con_pausa_anterior');
});

test('pausa el sábado 18:50 → avisa el lunes al abrir (el domingo no cuenta)', () => {
    const pausadoDesde = t('2026-08-08T18:50');
    assert.strictEqual(decidirAvisoPausa({ pausadoDesde, ahora: t('2026-08-09T12:00'), horario: HORARIO }).avisar,
        false, 'domingo cerrado: ni suma ni avisa');
    const lunes = decidirAvisoPausa({ pausadoDesde, ahora: t('2026-08-10T10:05'), horario: HORARIO });
    assert.strictEqual(lunes.avisar, true);
    assert.strictEqual(lunes.motivo, 'abierto_con_pausa_anterior');
});

test('pausa DENTRO del horario no dispara la regla de apertura, espera a las 2 h', () => {
    const pausadoDesde = t('2026-08-04T11:00');
    const d = decidirAvisoPausa({ pausadoDesde, ahora: t('2026-08-04T11:30'), horario: HORARIO });
    assert.strictEqual(d.avisar, false, 'se pausó ya abierto: no es una pausa heredada');
    assert.strictEqual(d.minutosAbierto, 30);
});

test('sin fecha de pausa no se inventa nada', () => {
    assert.strictEqual(decidirAvisoPausa({ pausadoDesde: null, ahora: new Date(), horario: HORARIO }).avisar, false);
    assert.strictEqual(decidirAvisoPausa({ pausadoDesde: 'no-es-fecha', ahora: new Date(), horario: HORARIO }).motivo,
        'fecha_de_pausa_ilegible');
});

// ─── El vigilante completo ───────────────────────────────────────────────────

test('con el bot ACTIVO no avisa nunca', async () => {
    limpiar();
    const avisado = await revisarPausaProlongada(ORG,
        { activo: true, pausadoDesde: t('2026-01-01T10:00'), horario: HORARIO }, t('2026-08-04T17:00'));
    assert.strictEqual(avisado, false);
    assert.strictEqual(avisos.length, 0);
});

test('un episodio de pausa avisa UNA sola vez, no cada 10 minutos', async () => {
    limpiar();
    const estado = { activo: false, pausadoDesde: t('2026-08-04T15:00'), horario: HORARIO };

    await revisarPausaProlongada(ORG, estado, t('2026-08-04T17:00'));
    await revisarPausaProlongada(ORG, estado, t('2026-08-04T17:10'));
    await revisarPausaProlongada(ORG, estado, t('2026-08-04T17:20'));

    assert.strictEqual(avisos.length, 1, 'el vigilante tica cada 10 min: sin throttle serían decenas');
    assert.ok(/lleva pausado/i.test(avisos[0].mensaje));
    assert.ok(logs.some(l => l.evento === 'bot_pausado_demasiado'));
});

test('al reactivar se avisa, y una pausa NUEVA vuelve a avisar', async () => {
    limpiar();
    await revisarPausaProlongada(ORG,
        { activo: false, pausadoDesde: t('2026-08-04T15:00'), horario: HORARIO }, t('2026-08-04T17:00'));
    assert.strictEqual(avisos.length, 1);

    await revisarPausaProlongada(ORG, { activo: true, pausadoDesde: null, horario: HORARIO }, t('2026-08-04T17:30'));
    assert.strictEqual(avisos.length, 2);
    assert.ok(/vuelve a responder/i.test(avisos[1].mensaje));

    // Otra pausa distinta (otro updated_at) → aviso nuevo, no throttleado por la anterior.
    await revisarPausaProlongada(ORG,
        { activo: false, pausadoDesde: t('2026-08-05T11:00'), horario: HORARIO }, t('2026-08-05T13:00'));
    assert.strictEqual(avisos.length, 3);
});

test('si el aviso no llega a Telegram, se reintenta en el siguiente tic', async () => {
    limpiar();
    entrega = false;
    const estado = { activo: false, pausadoDesde: t('2026-08-04T15:00'), horario: HORARIO };

    assert.strictEqual(await revisarPausaProlongada(ORG, estado, t('2026-08-04T17:00')), false);
    assert.strictEqual(avisos.length, 1, 'se intentó');

    entrega = true;
    assert.strictEqual(await revisarPausaProlongada(ORG, estado, t('2026-08-04T17:10')), true);
    assert.strictEqual(avisos.length, 2, 'y se reintentó, porque el primero no llegó');
});

test('reactivar sin aviso previo no manda un "vuelve a responder" de la nada', async () => {
    limpiar();
    await revisarPausaProlongada(ORG, { activo: true, pausadoDesde: null, horario: HORARIO }, new Date());
    assert.strictEqual(avisos.length, 0);
});
