// El trato de usted se guarda y sobrevive (07/08/2026).
//
// Olga Yarmak (34674987146) pidió «Тогда давай на вы 🧐» a las 15:29:18. El bot dijo que sí
// —«Конечно, без проблем 😊 Когда Вам удобно…»— y volvió a tutearla al turno siguiente. El
// trato no existía como dato en NINGUNA parte del código: cero apariciones de 'usted',
// 'tuteo' o 'formal' en bot.js, openai.js y helpers.js. El "sí" duraba lo que el LLM lo
// arrastrase del historial, y en cuanto contestaba un texto FIJO —todos escritos en `ты`—
// se perdía sin que nadie se enterase.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { detectTratamiento } = require('../services/helpers');
const {
    porTrato, salonPickServiceMenuMsg, salonNoSlotsMsg, salonFueraDeHorarioMsg,
    salonOfferHumanMsg, ensureHandoverAcknowledged, HANDOVER_ACUSE_FORMAL,
    createEmptySession, buildSessionExtra,
} = require('../bot.js')._internals;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const SANTE = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// ─── Detección ───────────────────────────────────────────────────────────────

test('el mensaje literal de Olga', () => {
    assert.strictEqual(detectTratamiento('Тогда давай на вы 🧐'), 'formal');
});

test('las cuatro formas de pedirlo', () => {
    assert.strictEqual(detectTratamiento('давайте на вы'), 'formal');
    assert.strictEqual(detectTratamiento('перейдемо на ви, будь ласка'), 'formal');
    assert.strictEqual(detectTratamiento('prefiero que me hable de usted'), 'formal');
    assert.strictEqual(detectTratamiento('Háblame de usted por favor'), 'formal');
});

test('TRAMPA: "на выходных" es el fin de semana, no el trato', () => {
    // «на вы» es subcadena literal de «на выходных», y «на ви» de «на вихідних». Sin el
    // lookahead, proponer día ("давай на выходных") se leía como "trátame de usted" — y a
    // partir de ahí toda la conversación cambiaba de registro por una frase de calendario.
    assert.strictEqual(detectTratamiento('давай на выходных'), null);
    assert.strictEqual(detectTratamiento('можемо на вихідних?'), null);
    assert.strictEqual(detectTratamiento('запишите на выходные'), null);
});

test('volver al tuteo también se detecta, y gana al formal en el mismo mensaje', () => {
    assert.strictEqual(detectTratamiento('давай лучше на ты'), 'informal');
    assert.strictEqual(detectTratamiento('tutéame, por favor'), 'informal');
});

test('un mensaje normal no dice nada del trato', () => {
    // Regla 3: no se infiere del registro con que escriba. Solo lo que pide explícitamente.
    for (const t of ['hola, quiero un corte', 'Здравствуйте, хочу записаться', 'a las 12:00']) {
        assert.strictEqual(detectTratamiento(t), null, t);
    }
});

// ─── Sobrevive a la rehidratación ────────────────────────────────────────────

test('el trato viaja a SQLite: sin esto se pierde en cada rehidratación', () => {
    // Es la lección de session.leadId y de languageSource. Una sesión rehidratada sin el
    // trato vuelve a tutear a quien pidió lo contrario, y nadie lo relaciona con la causa.
    const s = createEmptySession('34674987146@c.us', SANTE);
    assert.strictEqual(s.tratamiento, null, 'arranca sin constar');
    s.tratamiento = 'formal';
    const extra = buildSessionExtra(s);
    assert.strictEqual(extra.tratamiento, 'formal');
});

// ─── Los textos FIJOS cambian de registro ────────────────────────────────────

test('porTrato cae en la variante informal cuando no hay formal para ese idioma', () => {
    // El inglés no distingue tú/usted: no tiene entrada formal y debe devolver la normal,
    // nunca vacío.
    const msgs = { es: 'tú', en: 'you' };
    const formal = { es: 'usted' };
    assert.strictEqual(porTrato({ language: 'en', tratamiento: 'formal' }, msgs, formal), 'you');
    assert.strictEqual(porTrato({ language: 'es', tratamiento: 'formal' }, msgs, formal), 'usted');
    assert.strictEqual(porTrato({ language: 'es', tratamiento: null }, msgs, formal), 'tú');
});

test('el menú de rescate: el que la tuteó tres veces después de aceptar el usted', () => {
    const informal = salonPickServiceMenuMsg({ language: 'ru', tratamiento: null });
    const formal = salonPickServiceMenuMsg({ language: 'ru', tratamiento: 'formal' });
    assert.notStrictEqual(informal, formal);
    assert.ok(informal.includes('тебя'), 'premisa: el original tutea');
    assert.ok(!/\bтебя\b|\bтебе\b|\bты\b/.test(formal), `la variante formal sigue tuteando: ${formal}`);
    assert.ok(formal.includes('Вас'), 'la variante formal trata de usted');
});

test('la pregunta de servicio, fuera de horario y la oferta de persona', () => {
    const sesion = (tratamiento) => ({
        language: 'ru', tratamiento, selectedService: null, sinServicioStreak: 0,
    });
    // Pregunta de servicio (primer turno del bucle).
    assert.notStrictEqual(salonNoSlotsMsg(sesion(null)), salonNoSlotsMsg(sesion('formal')));

    const horario = { hora: '23:00', apertura: '10:00', cierre: '19:00' };
    const fh = salonFueraDeHorarioMsg({ language: 'ru', tratamiento: 'formal' }, horario);
    assert.ok(fh.includes('Вам'), `fuera de horario no trata de usted: ${fh}`);
    // Y sigue diciendo el horario entero: el registro no puede comerse el dato.
    assert.ok(fh.includes('10:00') && fh.includes('19:00') && fh.includes('23:00'));

    const oh = salonOfferHumanMsg({ language: 'ru', tratamiento: 'formal' });
    assert.ok(oh.includes('Вас'), `la oferta de persona no trata de usted: ${oh}`);
});

test('el acuse de escalada también', () => {
    const salida = ensureHandoverAcknowledged('Хорошо.', 'ru', 'formal');
    assert.ok(salida.includes(HANDOVER_ACUSE_FORMAL.ru));
    assert.ok(!salida.includes('тобой'), 'el acuse formal no puede tutear');
});

test('sin trato pedido, todo sigue exactamente igual que antes', () => {
    // Nadie que no lo haya pedido puede notar este cambio.
    for (const language of ['es', 'en', 'ru', 'uk']) {
        const sinCampo = salonPickServiceMenuMsg({ language });
        const conNull = salonPickServiceMenuMsg({ language, tratamiento: null });
        assert.strictEqual(sinCampo, conNull, language);
    }
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { fallos++; console.error(`FALLO - ${name}\n   ${e.message}`); }
    }
    console.log(fallos ? `\n❌ ${fallos} fallo(s)` : `\n✅ ${tests.length} en verde`);
    process.exit(fallos ? 1 : 0);
})();
