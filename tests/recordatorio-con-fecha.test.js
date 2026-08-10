// El recordatorio no decía CUÁNDO era la cita, solo la hora ("a las 12:00").
//
// La fecha entra por el hueco que ya existe —el {{2}} de `sante_recordatorio_cita` es texto
// libre— y va DETRÁS de la hora, porque el texto fijo aprobado por Meta la precede con «a las
// / at / в / о». Lo que este fichero protege son las tres cosas que se rompen ahí:
//
//   1. El ACUSATIVO ruso y ucraniano. `toLocaleDateString` da nominativo («среда»), y detrás
//      de la preposición hace falta «в среду». Concatenar lo que devuelve Intl escribe
//      «в 12:00 в среда», que está mal. Los siete días, uno por uno, en los dos idiomas —el
//      martes incluido, que además cambia la preposición: «во вторник».
//   2. Que los DOS caminos digan lo mismo. Texto libre (dentro de la ventana de 24 h) y
//      plantilla (fuera) son código distinto; si solo se toca uno, dos clientas con la misma
//      cita reciben mensajes distintos y nadie lo ve.
//   3. Que SAN REMO no se entere. No lo ha pedido su dueño: su recordatorio tiene que quedar
//      byte por byte como estaba.
process.env.TZ = 'Europe/Madrid';
process.env.SANTE_360_API_KEY = 'test-key-360';
process.env.SANTE_360_PHONE_NUMBER_ID = '111222333';
process.env.WHATSAPP_360_BASE_URL = 'https://waba-v2.360dialog.io';

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { SANTE_ORG_ID, SANREMO_ORG_ID } = require('../services/org-registry');
const { build360Client } = require('../services/providers/threesixty-dialog');
const { formatReminderWhen } = require('../services/helpers');

// db.js requiere el cliente Supabase real: se stubea ANTES de requerir los workers, igual que
// en plantillas-fuera-de-ventana.test.js. Y el orden importa de verdad — con el stub de db
// instalado DESPUÉS del require de reminder, el worker se queda con el db real y
// `autoCompleteAppointments` revienta contra el Supabase falso.
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Estado del doble de BD (se rellena en resetState, más abajo). Las funciones del stub lo
// leen en el momento de la llamada, así que puede declararse vacío aquí.
let state;

const dbPath = require.resolve('../services/db');
const { isWithin24hWindow } = require(dbPath);
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        isWithin24hWindow,            // implementación REAL
        async getLastInboundAt(_orgId, telefono) { return state.lastInbound[telefono] ?? null; },
        async getConfigValue(orgId, clave) {
            const v = state.config[orgId]?.[clave];
            return v === undefined ? null : v;
        },
        async getAgentConfig(orgId) {
            return {
                business_info: {
                    companyName: orgId === SANTE_ORG_ID ? 'Sante Healthy Hair Salon' : 'Restaurante San Remo',
                },
            };
        },
        async autoCompleteAppointments() { return 0; },
        async getAppointmentsPendientesRecordatorio(orgId) { return state.pendientes[orgId] || []; },
        async marcarRecordatorioSent(orgId, id) { state.marcados.push({ orgId, id }); return true; },
    },
};

// El logger real escribe a stdout; capturamos los warn para poder afirmar el aviso de la
// fecha corrupta.
const loggerPath = require.resolve('../lib/logger');
const realLogger = require(loggerPath);
require.cache[loggerPath].exports = {
    ...realLogger,
    warn: (evento, meta) => { state.warns.push({ evento, meta }); },
    info: () => {}, error: () => {},
};

const reminder = require('../services/reminder');
const { buildReminderMessage } = reminder;
const SALON = 'Sante Healthy Hair Salon';

// ─── 1. La frase, día a día ──────────────────────────────────────────────────
//
// Semana completa de 2026: el 10 de agosto es lunes y el 16, domingo.
const LUNES = '2026-08-10';
const SEMANA = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'];

const ESPERADO = {
    es: [
        '12:00 del lunes 10 de agosto',
        '12:00 del martes 11 de agosto',
        '12:00 del miércoles 12 de agosto',
        '12:00 del jueves 13 de agosto',
        '12:00 del viernes 14 de agosto',
        '12:00 del sábado 15 de agosto',
        '12:00 del domingo 16 de agosto',
    ],
    en: [
        '12:00 on Monday 10 August',
        '12:00 on Tuesday 11 August',
        '12:00 on Wednesday 12 August',
        '12:00 on Thursday 13 August',
        '12:00 on Friday 14 August',
        '12:00 on Saturday 15 August',
        '12:00 on Sunday 16 August',
    ],
    ru: [
        '12:00 в понедельник, 10 августа',
        '12:00 во вторник, 11 августа',
        '12:00 в среду, 12 августа',
        '12:00 в четверг, 13 августа',
        '12:00 в пятницу, 14 августа',
        '12:00 в субботу, 15 августа',
        '12:00 в воскресенье, 16 августа',
    ],
    uk: [
        '12:00 у понеділок, 10 серпня',
        '12:00 у вівторок, 11 серпня',
        '12:00 у середу, 12 серпня',
        '12:00 у четвер, 13 серпня',
        '12:00 у пʼятницю, 14 серпня',
        '12:00 у суботу, 15 серпня',
        '12:00 у неділю, 16 серпня',
    ],
};

for (const [lang, esperados] of Object.entries(ESPERADO)) {
    test(`${lang}: los siete días de la semana, uno por uno`, () => {
        SEMANA.forEach((fecha, i) => {
            assert.strictEqual(
                formatReminderWhen(fecha, '12:00', lang), esperados[i],
                `${lang} · ${fecha}`
            );
        });
    });
}

// El caso que Intl no puede dar y por el que existe la tabla a mano. Si alguien "simplifica"
// el helper a toLocaleDateString + concatenación, estos cuatro son los que se caen.
test('ru/uk: el día va en ACUSATIVO, no en el nominativo que devuelve Intl', () => {
    const nominativos = {
        ru: new Date(Date.UTC(2026, 7, 12, 12)).toLocaleDateString('ru-RU', { weekday: 'long', timeZone: 'UTC' }),
        uk: new Date(Date.UTC(2026, 7, 12, 12)).toLocaleDateString('uk-UA', { weekday: 'long', timeZone: 'UTC' }),
    };
    assert.strictEqual(nominativos.ru, 'среда', 'premisa: Intl da nominativo en ru');
    assert.strictEqual(nominativos.uk, 'середа', 'premisa: Intl da nominativo en uk');

    assert.ok(formatReminderWhen('2026-08-12', '12:00', 'ru').includes('в среду'));
    assert.ok(!formatReminderWhen('2026-08-12', '12:00', 'ru').includes('в среда'));
    assert.ok(formatReminderWhen('2026-08-12', '12:00', 'uk').includes('у середу'));
    assert.ok(!formatReminderWhen('2026-08-12', '12:00', 'uk').includes('у середа'));
});

test('ru: el martes lleva la preposición larga «во», no «в»', () => {
    const frase = formatReminderWhen('2026-08-11', '12:00', 'ru');
    assert.ok(frase.includes('во вторник'), frase);
    assert.ok(!/[^о]\sв вторник/.test(frase), frase);
});

// Los tres detalles de formato que rompen una frase distinta cada uno.
test('el día va en minúscula (es/ru/uk) y en mayúscula solo donde toca (en)', () => {
    assert.ok(formatReminderWhen(LUNES, '12:00', 'es').includes(' del lunes '));
    assert.ok(formatReminderWhen(LUNES, '12:00', 'ru').includes(' в понедельник,'));
    assert.ok(formatReminderWhen(LUNES, '12:00', 'uk').includes(' у понеділок,'));
    assert.ok(formatReminderWhen(LUNES, '12:00', 'en').includes(' on Monday '), 'inglés sí capitaliza');
});

test('la coma va en ru/uk y NO en es/en', () => {
    assert.ok(!formatReminderWhen(LUNES, '12:00', 'es').includes(','), 'es-ES mete «lunes, 10 de agosto» y aquí sobra');
    assert.ok(!formatReminderWhen(LUNES, '12:00', 'en').includes(','));
    assert.strictEqual((formatReminderWhen(LUNES, '12:00', 'ru').match(/,/g) || []).length, 1);
    assert.strictEqual((formatReminderWhen(LUNES, '12:00', 'uk').match(/,/g) || []).length, 1);
});

test('inglés en formato británico: «10 August», no «August 10»', () => {
    assert.ok(/on Monday 10 August$/.test(formatReminderWhen(LUNES, '12:00', 'en')));
});

test('la fecha lleva MES: un envío que se desplace sigue siendo cierto', () => {
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        assert.ok(
            /agosto|August|августа|серпня/.test(formatReminderWhen(LUNES, '12:00', lang)),
            `falta el mes en ${lang}`
        );
    }
});

test('nunca dice «mañana»: la palabra no aparece en ningún idioma', () => {
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        const frase = formatReminderWhen(LUNES, '12:00', lang);
        assert.ok(!/mañana|tomorrow|завтра|тим/i.test(frase), `${lang}: ${frase}`);
    }
});

// ─── 2. La fecha ancla el DÍA, no un instante ────────────────────────────────

test('el día no se mueve con el huso horario del servidor', () => {
    const script = `
        const { formatReminderWhen } = require(${JSON.stringify(path.resolve(__dirname, '../services/helpers'))});
        process.stdout.write(['es','en','ru','uk'].map(l => formatReminderWhen('2026-08-12','12:00',l)).join('|'));
    `;
    const corre = tz => execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz } }).toString();

    const madrid = corre('Europe/Madrid');
    assert.strictEqual(corre('Pacific/Kiritimati'), madrid, 'UTC+14 mueve el día');
    assert.strictEqual(corre('Pacific/Midway'), madrid, 'UTC-11 mueve el día');
    assert.ok(madrid.startsWith('12:00 del miércoles 12 de agosto'), madrid);
});

// ─── 3. Nada de fechas inventadas ────────────────────────────────────────────

test('una fecha que no se entiende devuelve null, no una fecha cualquiera', () => {
    assert.strictEqual(formatReminderWhen(null, '12:00', 'es'), null);
    assert.strictEqual(formatReminderWhen('', '12:00', 'es'), null);
    assert.strictEqual(formatReminderWhen('mañana', '12:00', 'es'), null);
    assert.strictEqual(formatReminderWhen('12/08/2026', '12:00', 'es'), null, 'formato no ISO');
    assert.strictEqual(formatReminderWhen('2026-02-31', '12:00', 'es'), null, 'Date.UTC lo rodaría a marzo');
    assert.strictEqual(formatReminderWhen('2026-13-01', '12:00', 'es'), null);
});

test('sin hora no hay frase: {{2}} vacío lo rechaza Meta entera (132000)', () => {
    assert.strictEqual(formatReminderWhen(LUNES, null, 'es'), null);
    assert.strictEqual(formatReminderWhen(LUNES, '   ', 'es'), null);
});

test('un idioma desconocido cae a español, igual que REMINDER_TEMPLATES', () => {
    const es = formatReminderWhen(LUNES, '12:00', 'es');
    assert.strictEqual(formatReminderWhen(LUNES, '12:00', undefined), es);
    assert.strictEqual(formatReminderWhen(LUNES, '12:00', 'fr'), es);
    assert.strictEqual(formatReminderWhen(LUNES, '12:00', null), es);
});

// ─── 4. La frase completa, que es lo que lee la clienta ──────────────────────

test('el mensaje entero, en los cuatro idiomas', () => {
    const cuando = l => formatReminderWhen('2026-08-12', '12:00', l);
    assert.strictEqual(
        buildReminderMessage('Anna', SALON, cuando('es'), 'es'),
        'Hola Anna 😊 Te recordamos tu cita en Sante Healthy Hair Salon a las 12:00 del miércoles 12 de agosto. ¡Te esperamos!'
    );
    assert.strictEqual(
        buildReminderMessage('Anna', SALON, cuando('en'), 'en'),
        'Hi Anna 😊 Just a reminder of your appointment at Sante Healthy Hair Salon at 12:00 on Wednesday 12 August. See you soon!'
    );
    assert.strictEqual(
        buildReminderMessage('Anna', SALON, cuando('ru'), 'ru'),
        'Привет Anna 😊 Напоминаем о вашей записи в Sante Healthy Hair Salon в 12:00 в среду, 12 августа. Ждём вас!'
    );
    assert.strictEqual(
        buildReminderMessage('Anna', SALON, cuando('uk'), 'uk'),
        'Привіт Anna 😊 Нагадуємо про ваш запис у Sante Healthy Hair Salon о 12:00 у середу, 12 серпня. Чекаємо на вас!'
    );
});

// ─── 5. Motor real: los dos caminos y la regla de oro ────────────────────────

function resetState() {
    state = {
        config: {
            [SANTE_ORG_ID]: {
                horas_recordatorio: 24,
                plantilla_recordatorio: { es: { name: 'sante_recordatorio_cita', language: 'es' } },
            },
            [SANREMO_ORG_ID]: { minutos_recordatorio: 1440 },
        },
        lastInbound: {},
        pendientes: {},
        marcados: [],
        warns: [],
    };
}

// Cita a 2 h vista: dentro de la ventana de 24 h de disparo, y con fecha REAL de calendario
// (no una fija) para que el test no caduque.
function citaEnDosHoras() {
    const d = new Date(Date.now() + 2 * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    return {
        fecha_cita: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
        hora_cita: `${p(d.getHours())}:${p(d.getMinutes())}`,
    };
}

function pendiente({ telefono = '34600111222', nombre = 'Anna', language = 'es' } = {}) {
    return { id: 'contact-1', telefono, nombre, language, wa_jid: null, ...citaEnDosHoras() };
}

function fakeWwebjsClient(sink) {
    return {
        async sendMessage(jid, text) { sink.push({ jid, text }); return { id: 'wweb-1' }; },
        getChatById() { return { sendStateTyping: async () => {} }; },
    };
}

async function correr(clients) {
    const original = global.fetch;
    const requests = [];
    global.fetch = async (url, opts) => {
        requests.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) };
    };
    try {
        reminder.setClients(clients);
        await reminder.checkAndSendReminders();
    } finally { global.fetch = original; }
    return requests;
}

const santeClients = () => new Map([[SANTE_ORG_ID, { client: build360Client(SANTE_ORG_ID), orgId: SANTE_ORG_ID }]]);

// Independiente del helper a propósito: si el patrón casa, la fecha llegó de verdad al
// mensaje. Un test que reconstruyera la frase con formatReminderWhen pasaría aunque el worker
// no la usara.
const CON_FECHA_ES = /a las \d{1,2}:\d{2} del (lunes|martes|miércoles|jueves|viernes|sábado|domingo) \d{1,2} de [a-zé]+\. ¡Te esperamos!$/;

test('Sante, TEXTO LIBRE (dentro de la ventana): el mensaje lleva la fecha', async () => {
    resetState();
    state.lastInbound['34600111222'] = new Date(Date.now() - 3600 * 1000).toISOString();
    state.pendientes[SANTE_ORG_ID] = [pendiente()];

    const reqs = await correr(santeClients());

    assert.strictEqual(reqs.length, 1);
    assert.strictEqual(reqs[0].body.type, 'text');
    assert.ok(CON_FECHA_ES.test(reqs[0].body.text.body), reqs[0].body.text.body);
});

test('Sante, PLANTILLA (fuera de la ventana): {{2}} lleva la fecha, sin plantilla nueva', async () => {
    resetState();
    state.lastInbound['34600111222'] = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    const p = pendiente();
    state.pendientes[SANTE_ORG_ID] = [p];

    const reqs = await correr(santeClients());

    assert.strictEqual(reqs.length, 1);
    const body = reqs[0].body;
    assert.strictEqual(body.type, 'template');
    assert.strictEqual(body.template.name, 'sante_recordatorio_cita', 'la MISMA plantilla aprobada');
    const params = body.template.components[0].parameters;
    assert.strictEqual(params[0].text, 'Anna');
    assert.strictEqual(params[1].text, formatReminderWhen(p.fecha_cita, p.hora_cita, 'es'));
    assert.notStrictEqual(params[1].text, p.hora_cita, '{{2}} ya no es solo la hora');
});

test('los dos caminos dicen EXACTAMENTE lo mismo', async () => {
    resetState();
    const p = pendiente({ language: 'ru' });

    state.lastInbound['34600111222'] = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    state.pendientes[SANTE_ORG_ID] = [p];
    const fuera = await correr(santeClients());
    const enPlantilla = fuera[0].body.template.components[0].parameters[1].text;

    resetState();
    state.lastInbound['34600111222'] = new Date(Date.now() - 3600 * 1000).toISOString();
    state.pendientes[SANTE_ORG_ID] = [p];
    const dentro = await correr(santeClients());

    assert.ok(
        dentro[0].body.text.body.includes(`в ${enPlantilla}.`),
        `plantilla: «${enPlantilla}» · texto libre: «${dentro[0].body.text.body}»`
    );
});

// La fecha se escribe en el idioma de la FICHA, no siempre en español: el día de la semana en
// castellano dentro de una frase en ruso sería peor que no ponerlo.
test('el idioma de la ficha manda también en la fecha', async () => {
    const ALFABETO = { es: /[a-zñáéíóú]/i, en: /[a-z]/i, ru: /[а-яё]/i, uk: /[а-яіїєґ]/i };
    for (const language of ['es', 'en', 'ru', 'uk']) {
        resetState();
        const p = pendiente({ language });
        state.lastInbound['34600111222'] = new Date(Date.now() - 3600 * 1000).toISOString();
        state.pendientes[SANTE_ORG_ID] = [p];

        const reqs = await correr(santeClients());
        const esperado = formatReminderWhen(p.fecha_cita, p.hora_cita, language);

        assert.ok(reqs[0].body.text.body.includes(esperado), `${language}: ${reqs[0].body.text.body}`);
        assert.ok(ALFABETO[language].test(esperado.replace(/[\d:,\s]/g, '')), `${language}: ${esperado}`);
    }
});

test('fecha corrupta: sale la hora sola (el mensaje de siempre) y se avisa en el log', async () => {
    resetState();
    state.lastInbound['34600111222'] = new Date(Date.now() - 3600 * 1000).toISOString();
    const p = pendiente();
    const horaBuena = p.hora_cita;
    // Pasa el filtro de ventana (minutosHastaCita da NaN y NaN>minutos es false) y llega aquí.
    state.pendientes[SANTE_ORG_ID] = [{ ...p, fecha_cita: '2026-99-99' }];

    const reqs = await correr(santeClients());

    assert.strictEqual(reqs.length, 1);
    assert.strictEqual(
        reqs[0].body.text.body,
        `Hola Anna 😊 Te recordamos tu cita en ${SALON} a las ${horaBuena}. ¡Te esperamos!`
    );
    assert.ok(state.warns.some(w => w.evento === 'recordatorio_fecha_no_formateable'),
        `esperaba el warn; hubo: ${JSON.stringify(state.warns)}`);
});

// ─── Regla de oro ────────────────────────────────────────────────────────────

test('SAN REMO: su recordatorio queda byte por byte como estaba, sin fecha', async () => {
    resetState();
    const enviados = [];
    const p = pendiente({ telefono: '34600999888', nombre: 'Alberto' });
    state.pendientes[SANREMO_ORG_ID] = [p];

    const reqs = await correr(new Map([[SANREMO_ORG_ID, {
        client: fakeWwebjsClient(enviados), orgId: SANREMO_ORG_ID,
    }]]));

    assert.strictEqual(reqs.length, 0, 'San Remo no llama a 360dialog');
    assert.strictEqual(enviados.length, 1);
    assert.strictEqual(
        enviados[0].text,
        `Hola Alberto 😊 Te recordamos tu cita en Restaurante San Remo a las ${p.hora_cita}. ¡Te esperamos!`,
        'el texto de San Remo no puede cambiar'
    );
    assert.ok(!CON_FECHA_ES.test(enviados[0].text), 'a San Remo no se le mete la fecha');
    assert.strictEqual(state.marcados.length, 1);
});

test('SAN REMO: tampoco cambia con una clienta en otro idioma', async () => {
    resetState();
    const enviados = [];
    const p = pendiente({ telefono: '34600999888', nombre: 'Anna', language: 'ru' });
    state.pendientes[SANREMO_ORG_ID] = [p];

    await correr(new Map([[SANREMO_ORG_ID, { client: fakeWwebjsClient(enviados), orgId: SANREMO_ORG_ID }]]));

    assert.strictEqual(
        enviados[0].text,
        `Привет Anna 😊 Напоминаем о вашей записи в Restaurante San Remo в ${p.hora_cita}. Ждём вас!`
    );
});

(async () => {
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
    }
})();
