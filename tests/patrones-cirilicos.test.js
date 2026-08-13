// Patrones cirílicos que no casaban NUNCA (RU/UK).
//
// Dos causas independientes, las dos silenciosas: el patrón existe, se lee bien, y no
// dispara jamás. Por eso el bug ha reaparecido tres veces (detectNoStylistPreference el
// 01/08, la fase D el 03/08, y este barrido).
//
//   1) normalizeText descompone en NFD y borra los diacríticos combinantes. En cirílico eso
//      no es un acento: й = и + breve, ё = е + diéresis, ї = і + diéresis, ў = у + breve.
//      El texto de la clienta llega como 'посоветуите' y el patrón dice 'посоветуйте'.
//   2) \b es ASCII en JavaScript: /\b(любое время)\b/ no casa ni con "любое время" exacto.
//      Esta mata también los literales BIEN escritos, por estar dentro de un \b(...)\b.
//
// Cada bloque de abajo es un caso de uso REAL que estaba muerto. Si alguno vuelve a fallar,
// es que se ha escrito un patrón cirílico a mano en vez de con buildCyrillicRe.

process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
    normalizeText, buildCyrillicRe, detectNoPreferenceSignal, extractDateSignalSante,
    detectConsultaValoracion, extractLargoPelo, detectNoStylistPreference,
} = require('../services/helpers');
const {
    isUpsellingAcceptance, asksForBookingApproval, respondsWithFalseClosureClaim,
} = require('../bot')._internals;

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// ─── 0 · el helper ────────────────────────────────────────────────────────────

test('0 · buildCyrillicRe normaliza los literales y no mete \\b', () => {
    const re = buildCyrillicRe(['подойдёт']);
    assert.ok(re.test(normalizeText('Тебе подойдёт?')), 'debe casar contra texto normalizado');
    assert.ok(!re.source.includes('\\b'), 'un \\b ASCII mataría el patrón');
});

test('0 · buildCyrillicRe deduplica lo que colapsa al normalizar', () => {
    // 'подойдет' y 'подойдёт' son la misma cadena tras normalizar: una sola alternativa.
    assert.strictEqual(buildCyrillicRe(['подойдет', 'подойдёт']).source, 'подоидет');
});

test('0 · buildCyrillicRe escapa metacaracteres (recibe literales, no regex)', () => {
    // Sin escapar, un '?' colado haría opcional la letra anterior en vez de buscar el signo.
    assert.strictEqual(buildCyrillicRe(['a?b']).source, 'a\\?b');
});

test('0 · las cuatro letras que descompone normalizeText', () => {
    for (const [letra, esperado] of [['й', 'и'], ['ё', 'е'], ['ї', 'і'], ['ў', 'у']]) {
        assert.strictEqual(normalizeText(letra), esperado, `${letra} se descompone`);
    }
});

// ─── 1 · "me da igual la estilista" / "lo antes posible" ──────────────────────

test('1 · RU/UK: "cualquiera" y "lo antes posible" activan la señal', () => {
    // Estaban TODAS muertas: unas por la й, el resto por el \b ASCII que las envolvía.
    for (const frase of ['любой', 'любую', 'любое время', 'ближайшее время', 'ближайший',
        'будь-хто', 'будь-який']) {
        assert.ok(detectNoPreferenceSignal(frase).sinPreferencia, `sinPreferencia: "${frase}"`);
    }
    for (const frase of ['как можно скорее', 'якомога швидше']) {
        assert.ok(detectNoPreferenceSignal(frase).asapTemporal, `asapTemporal: "${frase}"`);
    }
});

test('1 · el castellano y el inglés siguen igual', () => {
    assert.ok(detectNoPreferenceSignal('me da igual').sinPreferencia);
    assert.ok(detectNoPreferenceSignal('cualquiera').sinPreferencia);
    assert.ok(detectNoPreferenceSignal('anyone').sinPreferencia);
    assert.ok(detectNoPreferenceSignal('lo antes posible').asapTemporal);
    assert.ok(detectNoPreferenceSignal('as soon as possible').asapTemporal);
    assert.ok(!detectNoPreferenceSignal('quiero mechas el jueves').sinPreferencia);
});

// ─── 2 · franja del día ───────────────────────────────────────────────────────

test('2 · RU/UK: la franja del día fija periodo', () => {
    for (const frase of ['утром', 'вранці']) {
        assert.strictEqual(extractDateSignalSante(frase).periodo, 'mañana', `"${frase}"`);
    }
    for (const frase of ['днем', 'днём', 'вдень', 'ввечері']) {
        assert.strictEqual(extractDateSignalSante(frase).periodo, 'tarde', `"${frase}"`);
    }
});

test('2 · el castellano y el inglés siguen igual', () => {
    assert.strictEqual(extractDateSignalSante('por la manana').periodo, 'mañana');
    assert.strictEqual(extractDateSignalSante('por la tarde').periodo, 'tarde');
    assert.strictEqual(extractDateSignalSante('in the morning').periodo, 'mañana');
    assert.strictEqual(extractDateSignalSante('hola que tal').periodo, undefined);
});

// ─── 3 · pedir asesoramiento en ruso ──────────────────────────────────────────

test('3 · "Посоветуйте" activa la consulta de valoración', () => {
    assert.ok(detectConsultaValoracion('Посоветуйте, пожалуйста'));
    assert.ok(detectConsultaValoracion('посоветуй что мне сделать'));
    // El resto de la familia ya funcionaba: no debe romperse.
    assert.ok(detectConsultaValoracion('консультация'));
    assert.ok(detectConsultaValoracion('порадьте'));
    assert.ok(!detectConsultaValoracion('хочу маникюр'));
});

test('3 · "evaluad mi pelo" con cualquier posesivo (мой/мои/моє/мої)', () => {
    // 'мой' y 'мої' se descomponen (й, ї): enumerados como alternativas literales estaban
    // muertos y la frase entera no disparaba.
    for (const frase of ['оцените мои волосы', 'оцените мой волос', 'посмотрите волосы',
        'оцініть моє волосся', 'оцініть мої волосся', 'подивіться волосся']) {
        assert.ok(detectConsultaValoracion(frase), `"${frase}"`);
    }
});

// ─── 4 · largo del pelo (fija el PRECIO) ──────────────────────────────────────

test('4 · "до плечей" da largo 1', () => {
    assert.strictEqual(extractLargoPelo('до плечей'), 1);
    assert.strictEqual(extractLargoPelo('до плеч'), 1);
    assert.strictEqual(extractLargoPelo('коротко'), 1);
    // Los otros largos no se tocan.
    assert.strictEqual(extractLargoPelo('до лопаток'), 2);
    assert.strictEqual(extractLargoPelo('до пояса'), 3);
    assert.strictEqual(extractLargoPelo('очень длинные'), 4);
});

// ─── 5 · aceptar un upsell en ucraniano ───────────────────────────────────────

test('5 · "Додай" acepta el upsell', () => {
    assert.ok(isUpsellingAcceptance('Додай'));
    assert.ok(isUpsellingAcceptance('додай'));
    // Las que ya funcionaban.
    assert.ok(isUpsellingAcceptance('добавь'));
    assert.ok(isUpsellingAcceptance('да'));
    assert.ok(isUpsellingAcceptance('конечно'));
    assert.ok(!isUpsellingAcceptance('нет'));
});

// ─── 6 · la propuesta del bot no es una cita dada por hecha ───────────────────

test('6 · RU/UK: "¿te viene bien?" se reconoce como propuesta', () => {
    // llmClaimsBooked SÍ reconoce el cirílico ("записал"), así que sin esto la red
    // anti-cita-fantasma leía la propuesta como promesa incumplida y reiniciaba el flujo.
    assert.ok(asksForBookingApproval('Записал тебя на четверг в 10:00. Тебе подойдёт?'));
    assert.ok(asksForBookingApproval('подойдет'));
    assert.ok(asksForBookingApproval('Записав тебе на четвер. Тобі підійде?'));
    assert.ok(!asksForBookingApproval('Записал тебя на четверг в 10:00.'));
});

// ─── 7 · red anti-cierre-falso ────────────────────────────────────────────────

// Desde el 13/08/2026 la red recibe el horario: qué día cierra el salón lo dice
// `business_hours`, no una constante. Aquí se le pasa el de Sante (lunes-sábado, domingo
// ausente = cerrado) para seguir midiendo lo que este fichero mide, que es el CIRÍLICO.
const HORARIO_SANTE = {
    lunes: { apertura: '10:00', cierre: '19:00' },
    martes: { apertura: '10:00', cierre: '19:00' },
    miercoles: { apertura: '10:00', cierre: '19:00' },
    jueves: { apertura: '10:00', cierre: '19:00' },
    viernes: { apertura: '10:00', cierre: '19:00' },
    sabado: { apertura: '10:00', cierre: '19:00' },
};

test('7 · RU/UK: "выходной" cuenta como afirmación de cierre', () => {
    assert.ok(respondsWithFalseClosureClaim('В понедельник у нас выходной', HORARIO_SANTE));
    assert.ok(respondsWithFalseClosureClaim('У вівторок у нас вихідний', HORARIO_SANTE));
    // Las que ya funcionaban.
    assert.ok(respondsWithFalseClosureClaim('В понедельник закрыто', HORARIO_SANTE));
    // El domingo SÍ cierra: no es un cierre falso.
    assert.ok(!respondsWithFalseClosureClaim('В воскресенье у нас выходной', HORARIO_SANTE));
    assert.ok(!respondsWithFalseClosureClaim('Записал тебя на понедельник', HORARIO_SANTE));
});

// ─── 8 · el arreglo anterior sigue en pie ─────────────────────────────────────

test('8 · detectNoStylistPreference (arreglado el 01/08) no ha vuelto a romperse', () => {
    for (const frase of ['нет мастера', 'первый раз', 'немає майстра', 'перший раз']) {
        assert.ok(detectNoStylistPreference(frase), `"${frase}"`);
    }
});

if (!process.exitCode) console.log('\nTests de patrones cirílicos OK');
process.exit(process.exitCode || 0);
