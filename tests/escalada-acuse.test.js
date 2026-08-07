// Si se escala, se le dice a la clienta (07/08/2026).
//
// La red de escalada solo existía en un sentido: `announcesHumanHandover` ejecuta la
// escalada cuando el LLM la PROMETE y no la hace (bug del 28/07). La mitad contraria —la
// hace y no la dice— no la miraba nadie.
//
// Olga Yarmak (34674987146): a las 15:42:10 el LLM puso accion:escalar_humano con motivo
// 'pedir_persona'. En Supabase quedó todo bien —pending_actions status pending, bot_mode
// manual, escalation_reason 'pedir_persona'— y el texto que ella recibió fue «Прости, я
// реально запуталась 😅 Объясни мне ещё раз…»: le pedía que se explicara otra vez, justo
// cuando el bot acababa de dejar de hablarle. 44 s después escribió «me niego a hablar con
// un robot, solo con personas» y no recibió nada.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    ensureHandoverAcknowledged, announcesHumanHandover, HANDOVER_ACUSE,
} = require('../bot.js')._internals;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// El texto EXACTO que recibió Olga en el turno en que se la escaló.
const TEXTO_DE_OLGA = 'Прости, я реально запуталась 😅 Объясни мне ещё раз — что ты имеешь '
    + 'в виду под "волосы между двух половин"? Я хочу тебя правильно понять и записать на нужный сервис.';

test('el caso real: un texto que no anuncia nada acaba anunciándolo', () => {
    const salida = ensureHandoverAcknowledged(TEXTO_DE_OLGA, 'ru');
    assert.notStrictEqual(salida, TEXTO_DE_OLGA, 'el texto tiene que cambiar');
    assert.ok(salida.includes(HANDOVER_ACUSE.ru), 'falta el acuse en ruso');
});

test('se AÑADE, no se sustituye: lo que dijo el modelo sigue ahí', () => {
    // El texto del modelo suele llevar algo aprovechable (una disculpa, media respuesta).
    // Lo que le falta es el acuse, no todo lo demás.
    const salida = ensureHandoverAcknowledged(TEXTO_DE_OLGA, 'ru');
    assert.ok(salida.startsWith(TEXTO_DE_OLGA), 'el texto original tiene que conservarse entero');
});

test('en los cuatro idiomas', () => {
    for (const language of ['es', 'en', 'ru', 'uk']) {
        const salida = ensureHandoverAcknowledged('Vale.', language);
        assert.ok(salida.includes(HANDOVER_ACUSE[language]), `${language}: falta el acuse`);
    }
});

test('un idioma desconocido cae en castellano y NO se queda sin acuse', () => {
    // Regla 3: lo que no resuelve no se queda en blanco. Callar aquí es el fallo original.
    const salida = ensureHandoverAcknowledged('Vale.', 'fr');
    assert.ok(salida.includes(HANDOVER_ACUSE.es));
});

test('sin texto del modelo, el acuse va solo (nunca se manda vacío)', () => {
    for (const vacio of ['', '   ', null, undefined]) {
        const salida = ensureHandoverAcknowledged(vacio, 'es');
        assert.strictEqual(salida, HANDOVER_ACUSE.es);
    }
});

test('si el texto YA promete el traspaso, no se toca', () => {
    // Los mensajes escritos en el prompt para los casos 5, 6 y 7 ya anuncian el traspaso:
    // duplicarlo sería peor que no hacer nada.
    const yaLoDice = 'Lamento mucho lo que me cuentas 😔 Voy a pasar tu caso a nuestro equipo '
        + 'para que te atiendan personalmente y lo solucionen.';
    assert.ok(announcesHumanHandover(yaLoDice), 'premisa: este texto sí anuncia el traspaso');
    assert.strictEqual(ensureHandoverAcknowledged(yaLoDice, 'es'), yaLoDice);
});

test('una PREGUNTA de traspaso no cuenta como anuncio', () => {
    // "¿Quieres que te ponga en contacto con el equipo?" es una oferta que espera un sí.
    // Si aun así se está escalando en este turno, hay que decir que se está haciendo.
    const pregunta = '¿Quieres que te ponga en contacto con nuestro equipo?';
    assert.strictEqual(announcesHumanHandover(pregunta), false);
    const salida = ensureHandoverAcknowledged(pregunta, 'es');
    assert.ok(salida.includes(HANDOVER_ACUSE.es));
});

test('el acuse no promete una hora ni una cita', () => {
    // No puede reintroducir por la puerta de atrás lo que las redes de arriba impiden:
    // ni horas concretas (anti-invención) ni una reserva dada por hecha (anti-fantasma).
    for (const language of ['es', 'en', 'ru', 'uk']) {
        assert.ok(!/\d{1,2}:\d{2}/.test(HANDOVER_ACUSE[language]), `${language}: lleva una hora`);
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
