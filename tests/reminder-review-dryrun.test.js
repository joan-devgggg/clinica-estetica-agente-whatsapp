// Dry-run de reminder.js / review.js con datos de clienta de prueba: reconstruye el texto
// EXACTO que cada worker enviaría y lo empuja a través del build360Client REAL (con fetch
// stubeado) para comprobar también la petición HTTP que viajaría a 360dialog — sin tocar
// WhatsApp real ni Supabase real. Mismo patrón que threesixty-dialog.test.js ("Fase 1").
process.env.TZ = 'Europe/Madrid';
process.env.SANTE_360_API_KEY = 'test-key-360';
process.env.SANTE_360_PHONE_NUMBER_ID = '111222333';

const assert = require('assert');
const { SANTE_ORG_ID } = require('../services/org-registry');
const { build360Client } = require('../services/providers/threesixty-dialog');

// reminder.js/review.js requieren ./db, que a su vez requiere ./supabase (cliente real). Este
// test es de construcción de mensajes + adapter 360, sin BD real, así que se inyecta un stub
// en require.cache ANTES de requerir los workers — mismo truco que tests/db-contracts.test.js.
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };

const { buildReminderMessage } = require('../services/reminder');
const { buildReviewMessage } = require('../services/review');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const SALON = 'Sante Healthy Hair Salon';
const REVIEW_LINK = 'https://maps.app.goo.gl/PGdw5KeetLKbbdk18';

async function sendThrough360(mensaje) {
    const original = global.fetch;
    let captured = null;
    global.fetch = async (url, opts) => {
        captured = { url, opts };
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) };
    };
    try {
        const client = build360Client(SANTE_ORG_ID);
        await client.sendMessage('34600111222@c.us', mensaje);
    } finally {
        global.fetch = original;
    }
    return captured;
}

// ─── Recordatorio 24h (cliente de prueba en español) ─────────────────────────
test('recordatorio ES: texto exacto y payload 360dialog correcto', async () => {
    const mensaje = buildReminderMessage('María López', SALON, '17:30', 'es');
    assert.strictEqual(mensaje, 'Hola María López 😊 Te recordamos tu cita en Sante Healthy Hair Salon a las 17:30. ¡Te esperamos!');

    const captured = await sendThrough360(mensaje);
    const body = JSON.parse(captured.opts.body);
    assert.strictEqual(body.to, '34600111222');
    assert.strictEqual(body.type, 'text');
    assert.strictEqual(body.text.body, mensaje);
});

// ─── Recordatorio: idioma de la clienta (antes hardcodeado en español) ───────
test('recordatorio EN/RU/UK usa el idioma de la clienta, no español fijo', () => {
    assert.strictEqual(
        buildReminderMessage('Anna', SALON, '17:30', 'en'),
        'Hi Anna 😊 Just a reminder of your appointment at Sante Healthy Hair Salon at 17:30. See you soon!'
    );
    assert.strictEqual(
        buildReminderMessage('Anna', SALON, '17:30', 'ru'),
        'Привет Anna 😊 Напоминаем о вашей записи в Sante Healthy Hair Salon в 17:30. Ждём вас!'
    );
    assert.strictEqual(
        buildReminderMessage('Anna', SALON, '17:30', 'uk'),
        'Привіт Anna 😊 Нагадуємо про ваш запис у Sante Healthy Hair Salon о 17:30. Чекаємо на вас!'
    );
});

test('recordatorio: idioma desconocido/ausente cae a español (no revienta)', () => {
    assert.strictEqual(
        buildReminderMessage('María López', SALON, '17:30', undefined),
        'Hola María López 😊 Te recordamos tu cita en Sante Healthy Hair Salon a las 17:30. ¡Te esperamos!'
    );
});

// ─── Reseña 2h después (cliente de prueba en español) ────────────────────────
test('reseña ES: texto exacto con el enlace de Google y payload 360dialog correcto', async () => {
    const mensaje = buildReviewMessage('María López', SALON, REVIEW_LINK, 'es');
    assert.strictEqual(
        mensaje,
        `Hola María López 😊 Esperamos que hayas disfrutado tu visita a ${SALON}. Nos encantaría conocer tu opinión:\n${REVIEW_LINK}`
    );

    const captured = await sendThrough360(mensaje);
    const body = JSON.parse(captured.opts.body);
    assert.strictEqual(body.to, '34600111222');
    assert.strictEqual(body.text.body, mensaje);
    assert.ok(body.text.body.includes(REVIEW_LINK), 'debe llevar el enlace de reseña configurado');
});

test('reseña EN/RU/UK: plantillas existentes siguen intactas', () => {
    assert.strictEqual(
        buildReviewMessage('Anna', SALON, REVIEW_LINK, 'en'),
        `Hi Anna 😊 We hope you enjoyed your visit to ${SALON}. We'd love to hear your feedback:\n${REVIEW_LINK}`
    );
    assert.strictEqual(
        buildReviewMessage('Anna', SALON, REVIEW_LINK, 'ru'),
        `Привет Anna 😊 Надеемся, вам понравился визит в ${SALON}. Будем рады вашему отзыву:\n${REVIEW_LINK}`
    );
    assert.strictEqual(
        buildReviewMessage('Anna', SALON, REVIEW_LINK, 'uk'),
        `Привіт Anna 😊 Сподіваємось, вам сподобався візит до ${SALON}. Будемо раді вашому відгуку:\n${REVIEW_LINK}`
    );
});

(async () => {
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
    }
})();
