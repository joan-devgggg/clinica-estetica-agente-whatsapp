// Regresión del fallo de la noche del 02→03/08/2026 (Sante) y del comportamiento que pidió
// Yulia a raíz de él.
//
// Una clienta describió el estado de su cabello sin nombrar ningún servicio. El bot intentó
// resolverlo él solo y acabó ofreciéndole un tratamiento que no correspondía. El fallo tenía
// DOS mitades, las dos reproducidas aquí:
//
//   1) Síntoma que comparte palabra con una categoría → servicio equivocado y caro.
//      "tengo el pelo sin brillo" → extractServiceFromText → "Brillo intensivo", 120 €,
//      seleccionado y reservado sin preguntar ('brillo' es palabra de CATEGORY_KEYWORDS y
//      Brillo Glow tiene un único servicio).
//   2) Síntoma que no casa con nada → null → salonNoSlotsMsg → bucle de repregunta.
//      "tengo el pelo muy seco y estropeado", "lo tengo apagado y sin vida"…
//
// Comportamiento pedido: decir que hay muchos tratamientos, dar el rango 45-115 € y
// recomendar la consulta, donde se hace el diagnóstico. Sin adivinar el tratamiento.

process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
    detectHairProblemDescription, namesConcreteService,
    extractServiceFromText, detectConsultaValoracion,
} = require('../services/helpers');
const {
    salonHairTreatmentRangeMsg, SERVICE_STATE_DEFAULTS, createEmptySession,
} = require('../bot')._internals;

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// El fixture COMPLETO (81 entradas), no un recorte: el guard "¿ha nombrado un
// servicio?" recorre el catálogo entero, y con un recorte se dejarían de ver justo las
// colisiones que este camino existe para evitar.
const CATALOGO = require('./fixtures/sante-catalog.json').services;

// La condición exacta que evalúa bot.js antes de responder con el rango.
const dispara = (frase) => {
    const p = detectHairProblemDescription(frase);
    return !!p && !namesConcreteService(p.residual, CATALOGO);
};

// ─── 1 · las frases del incidente ─────────────────────────────────────────────

test('1 · "sin brillo" ya no acaba en Brillo intensivo (120 €)', () => {
    const frase = 'tengo el pelo sin brillo';
    // El resolvedor de servicio sigue devolviendo el de 120 € — no lo hemos tocado. Lo que
    // cambia es que este camino corta ANTES de que llegue a ejecutarse.
    assert.strictEqual(extractServiceFromText(frase, CATALOGO)?.nombre, 'Brillo intensivo',
        'si esto cambia, revisa si el guard de posición en bot.js sigue haciendo falta');
    assert.ok(dispara(frase), 'debe responder con el rango, no seleccionar Brillo intensivo');
    assert.ok(dispara('quiero algo para el pelo seco y sin brillo'));
});

test('1 · los síntomas que caían en el bucle ahora se reconocen', () => {
    for (const frase of [
        'tengo el pelo muy seco y estropeado',
        'lo tengo apagado y sin vida el pelo',
        'tengo las puntas abiertas',
        'mi pelo esta muy dañado',
        'tengo el pelo encrespado',
        'mi cabello está hecho polvo',
        'tengo el pelo quebradizo, se me rompe mucho',
        'tengo el cabello poroso y sin fuerza',
    ]) {
        assert.ok(dispara(frase), `debería disparar: "${frase}"`);
    }
});

test('1 · funciona en los cuatro idiomas', () => {
    assert.ok(dispara('my hair is very dry and damaged'));
    assert.ok(dispara('my hair is dull and lifeless, I have split ends'));
    // RU/UK ya normalizados por normalizeText (й→и, ё→е): ver el comentario del detector.
    assert.ok(dispara('у меня сухие и поврежденные волосы'));
    assert.ok(dispara('у мене сухе і пошкоджене волосся'));
});

// ─── 2 · si SÍ nombra un servicio, flujo normal de reserva ────────────────────

test('2 · describir el pelo Y nombrar el servicio → NO dispara', () => {
    for (const frase of [
        'tengo el pelo seco, quiero una hidratación',
        'quiero un balayage, lo tengo estropeado',
        'me han hecho mechas y mi cabello es un desastre',
        'lo tengo muy seco, me hago un tratamiento de keratina',
        'quiero un corte, tengo las puntas abiertas',
    ]) {
        assert.ok(!dispara(frase), `NO debería disparar: "${frase}"`);
    }
});

test('2 · una categoría AMBIGUA sigue contando como servicio nombrado', () => {
    // "hidratación" existe a 45/85/110 € y extractServiceFromText devuelve null a propósito
    // (commit 0e4ea2f). Aun así la clienta LA HA NOMBRADO: le toca el flujo normal, que le
    // preguntará cuál de las tres quiere — no el rango genérico.
    const p = detectHairProblemDescription('tengo el pelo seco, quiero una hidratación');
    assert.strictEqual(extractServiceFromText(p.residual, CATALOGO), null);
    assert.ok(namesConcreteService(p.residual, CATALOGO), 'la categoría nombrada debe contar');
});

test('2 · el largo del pelo no cuenta como "ha pedido un corte"', () => {
    // 'corto' es palabra de la categoría Cortes en CATEGORY_KEYWORDS. Sin la exclusión de
    // las palabras de largo, "tengo el pelo corto y seco" se leería como una petición de
    // corte y este camino no dispararía.
    assert.ok(dispara('tengo el pelo corto y seco'));
    assert.ok(dispara('tengo el pelo largo y muy estropeado'));
});

// ─── 3 · fronteras con los otros detectores ───────────────────────────────────

test('3 · la caída del pelo NO pasa por aquí (va a Diagnóstico Capilar)', () => {
    for (const frase of ['se me cae el pelo', 'tengo mucha caída de pelo', 'creo que tengo alopecia']) {
        assert.ok(!dispara(frase), `la caída sigue siendo de la tricológica: "${frase}"`);
    }
});

test('3 · las frases de fase D siguen siendo de detectConsultaValoracion', () => {
    for (const frase of ['me tienen que evaluar', 'quiero que me valoren el pelo',
        '¿qué me recomendáis?']) {
        assert.ok(detectConsultaValoracion(frase), `fase D intacta: "${frase}"`);
    }
    // Y al revés: describir el pelo NO se cuela como petición de asesoramiento.
    assert.ok(!detectConsultaValoracion('tengo el pelo seco y estropeado'));
});

test('3 · sin sustantivo capilar no hay descripción del cabello', () => {
    for (const frase of ['hola buenas', 'estoy hecha polvo, quiero un masaje',
        'el día está horrible', 'quiero mechas el jueves', '']) {
        assert.ok(!dispara(frase), `NO debería disparar: "${frase}"`);
    }
});

// ─── 4 · el mensaje ───────────────────────────────────────────────────────────

test('4 · el mensaje lleva el rango, la consulta y ningún servicio concreto', () => {
    for (const language of ['es', 'en', 'ru', 'uk', null]) {
        const session = { language, consultaOfrecida: false };
        const msg = salonHairTreatmentRangeMsg(session);
        assert.ok(msg.includes('45') && msg.includes('115'), `rango en ${language}`);
        assert.ok(/consulta|consultation|консультаци|консультаці/i.test(msg), `consulta en ${language}`);
        // Ningún nombre exacto de catálogo: esos nombres cambian en las migraciones.
        for (const svc of CATALOGO) {
            assert.ok(!msg.includes(svc.nombre), `no debe nombrar "${svc.nombre}" (${language})`);
        }
        // Ningún otro precio suelto que confunda con el rango.
        const numeros = msg.match(/\d+/g) || [];
        assert.deepStrictEqual(numeros, ['45', '115'], `solo el rango en ${language}`);
        assert.ok(!/[*_`#]/.test(msg), `sin markdown en ${language}`);
        assert.ok(msg.length < 1000, `bajo 1000 caracteres en ${language}`);
        assert.strictEqual(session.consultaOfrecida, true, `deja la consulta ofrecida (${language})`);
    }
});

// ─── 5 · higiene de estado ────────────────────────────────────────────────────

test('5 · rangoTratamientosOfrecido se limpia con el servicio', () => {
    assert.ok('rangoTratamientosOfrecido' in SERVICE_STATE_DEFAULTS,
        'debe limpiarse en clearServiceState o la 2ª reserva hereda el flag');
    assert.strictEqual(SERVICE_STATE_DEFAULTS.rangoTratamientosOfrecido, false);
    const s = createEmptySession('34600000000', 'org', '34600000000');
    assert.strictEqual(s.rangoTratamientosOfrecido, false, 'debe nacer en createEmptySession');
});

if (!process.exitCode) console.log('\nTests de tratamiento genérico OK');
process.exit(process.exitCode || 0);
