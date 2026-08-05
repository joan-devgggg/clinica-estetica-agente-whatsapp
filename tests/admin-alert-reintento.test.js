/**
 * tests/admin-alert-reintento.test.js — Un aviso que no llegó no cuenta como avisado.
 *
 * El bug (05/08/2026): `alertOnce` marcaba la clave ANTES de enviar y `notifyOrgAdmin` no se
 * esperaba —disparaba `.then/.catch` y volvía—, así que un `_botInstance` null, una org sin
 * admins o un rechazo de Telegram producían exactamente lo mismo que un envío correcto:
 * `admin_alert_enviado` en el log, clave marcada y **cero reintentos**. El aviso se perdía
 * en silencio, y el único log que prueba entrega, `telegram_notify_ok`, podía no existir.
 *
 * Salió investigando por qué una clienta sin nombre con cita al día siguiente podía haberse
 * quedado sin recordatorio Y sin que nadie se enterara.
 *
 * Se stubea `node-telegram-bot-api`, NO `services/telegram`: así corre el telegram.js real
 * encima y se afirma sobre su comportamiento de verdad. Sin red.
 */
process.env.TZ = 'Europe/Madrid';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';

const assert = require('assert');
const { test } = require('node:test');
const { SANTE_ORG_ID } = require('../services/org-registry');

const ORG = SANTE_ORG_ID;

// ─── Telegram falso ──────────────────────────────────────────────────────────
const enviados = [];
// Decide qué hace cada envío. Por defecto, entregar.
let responder = () => ({ message_id: 999 });

class FakeTelegramBot {
    on() {}
    async sendMessage(userId, texto, opts) {
        enviados.push({ userId, texto, opts });
        const r = responder(userId);
        if (r instanceof Error) throw r;
        return r;
    }
}
const tgLibPath = require.resolve('node-telegram-bot-api');
require.cache[tgLibPath] = { id: tgLibPath, filename: tgLibPath, loaded: true, exports: FakeTelegramBot };

// ─── Logger que graba ────────────────────────────────────────────────────────
const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

// ─── db falso: solo lo que telegram.js usa para el mapa usuario→org ──────────
let adminsDeLaOrg = [12345];
const dbPath = require.resolve('../services/db');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        getConfigValue: async (orgId, clave) =>
            (clave === 'telegram_admins' && orgId === ORG) ? adminsDeLaOrg : null,
    },
};

const telegramPath = require.resolve('../services/telegram');
const alertsPath = require.resolve('../services/admin-alerts');

/**
 * Recarga telegram.js y admin-alerts.js con estado limpio.
 *
 * Se recargan LOS DOS y en este orden porque admin-alerts hace
 * `const { notifyOrgAdmin } = require('./telegram')` al cargarse: captura la referencia, así
 * que recargar solo uno dejaría el otro apuntando a la instancia vieja.
 *
 * `conBot: false` reproduce el proceso arrancado sin bot de Telegram: basta con NO llamar a
 * initSendOnlyBot, que es lo único que fija `_botInstance`.
 */
async function preparar({ conBot = true, admins = [12345], enviar = null } = {}) {
    enviados.length = 0;
    logs.length = 0;
    adminsDeLaOrg = admins;
    responder = enviar || (() => ({ message_id: 999 }));

    delete require.cache[telegramPath];
    delete require.cache[alertsPath];
    const telegram = require('../services/telegram');
    if (conBot) await telegram.initSendOnlyBot();
    return require('../services/admin-alerts');
}

const tuvo = evento => logs.some(l => l.evento === evento);
const RECHAZO = () => new Error('Bad Request: chat not found');

// ─── 1. Camino feliz ─────────────────────────────────────────────────────────

test('entregado → clave marcada y el segundo aviso no se repite', async () => {
    const { alertOnce } = await preparar();

    assert.strictEqual(await alertOnce(ORG, 'clave-1', 'hola'), true);
    assert.strictEqual(enviados.length, 1);
    assert.strictEqual(enviados[0].userId, 12345);
    assert.ok(tuvo('telegram_notify_ok'));
    assert.ok(tuvo('admin_alert_enviado'));

    assert.strictEqual(await alertOnce(ORG, 'clave-1', 'hola'), false);
    assert.strictEqual(enviados.length, 1, 'no debe reenviarse');
});

// ─── 2. El bug: Telegram rechaza → NO se da por avisado ──────────────────────

test('Telegram rechaza → la clave queda libre y el siguiente tic reintenta', async () => {
    const { alertOnce } = await preparar({ enviar: RECHAZO });

    assert.strictEqual(await alertOnce(ORG, 'clave-2', 'hola'), false);
    assert.ok(tuvo('telegram_notify_error'));
    assert.ok(tuvo('admin_alert_no_entregado'));
    assert.ok(!tuvo('admin_alert_enviado'), 'no puede decir que lo envió');

    // Siguiente tic del worker: ahora Telegram sí acepta.
    responder = () => ({ message_id: 1 });
    logs.length = 0;
    assert.strictEqual(await alertOnce(ORG, 'clave-2', 'hola'), true,
        'la clave tenía que haber quedado libre para reintentar');
    assert.strictEqual(enviados.length, 2);
    assert.ok(tuvo('admin_alert_enviado'));
});

// ─── 3 y 4. No hay a quién avisar ────────────────────────────────────────────

test('sin bot arrancado → no se da por avisado, no lanza, y sale en cuanto arranca', async () => {
    const sinBot = await preparar({ conBot: false });
    assert.strictEqual(await sinBot.alertOnce(ORG, 'clave-3', 'hola'), false);
    assert.strictEqual(enviados.length, 0);
    assert.ok(tuvo('telegram_no_iniciado_notify'));
    assert.ok(!tuvo('admin_alert_enviado'));

    const conBot = await preparar({ conBot: true });
    assert.strictEqual(await conBot.alertOnce(ORG, 'clave-3', 'hola'), true);
});

test('org sin admins configurados → no se da por avisado, y se registra', async () => {
    const { alertOnce } = await preparar({ admins: [] });
    assert.strictEqual(await alertOnce(ORG, 'clave-4', 'hola'), false);
    assert.strictEqual(enviados.length, 0);
    assert.ok(tuvo('telegram_sin_admins'));
    assert.ok(!tuvo('admin_alert_enviado'));
});

// ─── 5. Candado de regresión sobre la causa exacta ───────────────────────────

test('nunca hay admin_alert_enviado sin un telegram_notify_ok delante', async () => {
    const escenarios = [
        { conBot: false },
        { admins: [] },
        { enviar: RECHAZO },
        {},
    ];
    for (const esc of escenarios) {
        const { alertOnce } = await preparar(esc);
        await alertOnce(ORG, 'candado', 'hola');
        const iOk = logs.findIndex(l => l.evento === 'telegram_notify_ok');
        const iEnviado = logs.findIndex(l => l.evento === 'admin_alert_enviado');
        if (iEnviado !== -1) {
            assert.notStrictEqual(iOk, -1, `admin_alert_enviado sin entrega en ${JSON.stringify(esc)}`);
            assert.ok(iOk < iEnviado, 'la confirmación va ANTES de darlo por enviado');
        }
    }
});

// ─── Varios admins: basta con que uno lo reciba ──────────────────────────────

test('con dos admins, si uno falla y el otro recibe, cuenta como entregado', async () => {
    const { alertOnce } = await preparar({
        admins: [111, 222],
        enviar: (userId) => (userId === 111 ? new Error('chat not found') : { message_id: 7 }),
    });

    assert.strictEqual(await alertOnce(ORG, 'clave-5', 'hola'), true);
    assert.strictEqual(enviados.length, 2, 'se intenta con los dos');
    assert.ok(tuvo('admin_alert_enviado'));
});

test('con dos admins, si fallan LOS DOS no se da por avisado', async () => {
    const { alertOnce } = await preparar({ admins: [111, 222], enviar: RECHAZO });
    assert.strictEqual(await alertOnce(ORG, 'clave-6', 'hola'), false);
    assert.ok(!tuvo('admin_alert_enviado'));
});

// ─── clearAlert: liberar una clave a mano (lo usará el aviso de canal) ───────

test('clearAlert libera la clave para que el próximo aviso vuelva a salir', async () => {
    const { alertOnce, clearAlert } = await preparar();
    await alertOnce(ORG, 'clave-7', 'hola');
    assert.strictEqual(await alertOnce(ORG, 'clave-7', 'hola'), false);

    clearAlert(ORG, 'clave-7');
    assert.strictEqual(await alertOnce(ORG, 'clave-7', 'hola'), true);
    assert.strictEqual(enviados.length, 2);
});
