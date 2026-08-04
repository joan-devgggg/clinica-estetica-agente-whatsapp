// Captura de nombres en cirílico (RU/UK) — 185 de ~715 contactos de Sante hablan ru/uk.
//
// Tres capas estaban cerradas al cirílico a la vez, cada una por su cuenta:
//   · isNameToken   → /^[a-zñ]+$/
//   · isValidName   → /^[a-zA-ZáéíóúñüÁÉÍÓÚÑÜ\s]+$/ y un letterCount que solo contaba latinas
//   · NAME_INTRO_RE → sin "Меня зовут" / "Мене звати"
// Resultado medido antes del arreglo: extractQuickDataSante("Меня зовут Наталья") → undefined.
//
// Y una consecuencia peor que perder el dato: hasApellido("Наталія Зінченко") devolvía false,
// así que el bot le pedía el apellido a quien ya se lo había dado — y tampoco podía aceptar
// la respuesta. Bucle. No llegó a morder en producción sólo porque ninguna clienta con nombre
// cirílico había alcanzado ese punto del flujo todavía (verificado en messages el 04/08/2026).
//
// Las stopwords RU/UK salen de los 19 mensajes en cirílico REALES del historial, no de la
// cabeza de nadie. Ver CYRILLIC_STOPWORD_FRASES en helpers.js.

process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const assert = require('assert');
const {
    isValidName, isNameToken, isUsableName, hasApellido, normalizeText,
    extractNameAfterIntro, extractQuickDataSante,
    NAME_STOPWORDS, NOMBRES_RU_UK_NUNCA_STOPWORD,
} = require('../services/helpers');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e.message); process.exitCode = 1; }
}

const capturar = t => extractQuickDataSante(t, {}, [], []).nombre;
const capturarConOpts = (t, opts) => extractQuickDataSante(t, {}, [], [], opts).nombre;

// ─── Candados sobre la lista ─────────────────────────────────────────────────

test('CANDADO · ninguna stopword es un nombre de mujer ruso/ucraniano', () => {
    // Вера=fe, Надежда=esperanza, Любовь=amor, Слава=gloria, Злата=oro... son palabras
    // comunes Y nombres. Meter una como stopword descartaría a una clienta que se presenta
    // bien. Misma disciplina que con Rosa/Alba/Mar/Sol/Luz en español.
    const choques = NOMBRES_RU_UK_NUNCA_STOPWORD.filter(n => NAME_STOPWORDS.has(normalizeText(n)));
    assert.deepStrictEqual(choques, [], `estos nombres están como stopword: ${choques.join(', ')}`);
});

test('CANDADO · ninguna stopword lleva espacios (sería una entrada muerta)', () => {
    // NAME_STOPWORDS se compara token a token: isNameToken recibe UNA palabra. Una frase
    // dentro del Set no casaría nunca — el mismo fallo silencioso que el \b ASCII.
    const conEspacio = [...NAME_STOPWORDS].filter(s => /\s/.test(s));
    assert.deepStrictEqual(conEspacio, [], `tokeniza estas: ${conEspacio.join(' | ')}`);
});

test('CANDADO · las stopwords cirílicas están normalizadas (si no, no casan nunca)', () => {
    // normalizeText descompone NFD: й→и, ё→е, ї→і. Una entrada escrita "como se escribe"
    // no casaría contra el texto ya normalizado que recibe isNameToken.
    for (const s of NAME_STOPWORDS) {
        assert.strictEqual(s, normalizeText(s), `"${s}" no está normalizada`);
    }
});

// ─── La trampa: nombres que son palabras comunes ─────────────────────────────

test('TRAMPA · "Вера" y "Надежда" se capturan como nombre, no se descartan', () => {
    for (const n of ['Вера', 'Надежда', 'Любовь', 'Слава', 'Злата']) {
        assert.ok(isValidName(n), `isValidName debería aceptar ${n}`);
        assert.strictEqual(capturar(n), n, `debería capturarse ${n}`);
    }
});

// ─── Captura ─────────────────────────────────────────────────────────────────

test('nombre cirílico suelto y con presentación', () => {
    assert.strictEqual(capturar('Наталья'), 'Наталья');
    assert.strictEqual(capturar('Меня зовут Наталья'), 'Наталья');
    assert.strictEqual(capturar('Мене звати Олена'), 'Олена');
});

test('"я Светлана" — el caso real del historial', () => {
    // Mensaje real (02/08/2026): "Саша Абрамовский … ( я Светлана)". "я" tiene que ser
    // stopword y "Светлана" no: es lo que separa una lista útil de una que rompe la captura.
    assert.strictEqual(capturar('я Светлана'), 'Светлана');
    assert.ok(NAME_STOPWORDS.has('я'), '"я" debe ser stopword');
    assert.ok(!NAME_STOPWORDS.has(normalizeText('Светлана')), '"Светлана" NO puede ser stopword');
});

test('INVERSO · un mensaje que es SOLO una stopword no se guarda como nombre', () => {
    for (const t of ['Спасибо', 'Привет', 'Нет', 'Ок', 'хочу', 'Добрый день',
        'я хочу записаться', 'Доброго дня', 'Отлично', 'пожалуйста']) {
        assert.strictEqual(capturar(t), undefined, `NO debería capturar "${t}"`);
    }
});

// ─── Meses: mes en genitivo vs. nombre de mujer ──────────────────────────────

test('MESES · los que no colisionan con un nombre son stopword siempre', () => {
    // "27 августа" es cómo se dice una fecha en ruso: el mes va en genitivo.
    for (const t of ['сентября', 'октября', 'января', 'декабря', 'вересня', 'грудня']) {
        assert.strictEqual(capturar(t), undefined, `"${t}" es un mes, no un nombre`);
    }
});

test('MESES · Августа/Марта/Майя se descartan por CONTEXTO, no por lista', () => {
    // Son mes en genitivo Y nombre de mujer real. Meterlos como stopword fija descartaría
    // a una clienta que se presenta bien; no meterlos guardaba "августа" como nombre.
    for (const mes of ['августа', 'марта', 'мая']) {
        assert.strictEqual(capturarConOpts(mes, { datePreferenceAsked: true }), undefined,
            `"${mes}" en un turno de elección de día es una fecha`);
        assert.strictEqual(capturarConOpts(mes, {}), mes,
            `"${mes}" fuera de ese turno sigue pudiendo ser un nombre`);
    }
    // Y el nombre propio, tal cual lo escribiría ella, se captura siempre.
    for (const nombre of ['Августа', 'Марта', 'Майя']) {
        assert.strictEqual(capturar(nombre), nombre);
    }
});

test('MESES · con dígitos de fecha nunca fue un nombre', () => {
    // El fallback de una sola palabra no llega a dispararse.
    for (const t of ['5 августа', '27 августа', 'Мне удобно на 27 августа']) {
        assert.strictEqual(capturar(t), undefined);
    }
});

test('el español sigue igual (no hay regresión)', () => {
    assert.strictEqual(capturar('Ana'), 'Ana');
    assert.strictEqual(capturar('Soy Ana Garcia'), 'Ana Garcia');
    assert.strictEqual(capturar('Soy rubia pero me han hecho mechas'), undefined);
    assert.strictEqual(capturar('hola'), undefined);
});

// ─── hasApellido: el bucle del apellido ──────────────────────────────────────

test('BUCLE · nombre con apellido en cirílico → NO se le vuelve a pedir el apellido', () => {
    for (const n of ['Наталія Зінченко', 'Олена Ковальчук', 'Людмила Заряхович']) {
        assert.ok(hasApellido(n), `hasApellido debería ser true para "${n}"`);
    }
    // Y un nombre suelto SÍ debe seguir pidiéndolo.
    assert.ok(!hasApellido('Наталья'), 'un nombre suelto sigue sin apellido');
});

test('BUCLE · los 8 nombres REALES del CRM con puntuación tampoco lo disparan', () => {
    // Filas reales de contacts (04/08/2026). Antes hasApellido devolvía false sobre todas,
    // así que el bot pedía un apellido que ya tenía en la ficha.
    for (const n of ['Tiffany Dubois-Moiseaux', 'Aleksandra Gajda-lin', 'Marina Lyon (Blond)',
        'Karima .IGHOUBA', 'Alina Kirsanova(Kashuba)', 'Nataliia ZINCHENKO(newton)',
        'Maria Jose   (mama Mar)']) {
        assert.ok(hasApellido(n), `hasApellido debería ser true para "${n}"`);
    }
});

// ─── Coherencia entre las dos puertas ────────────────────────────────────────

test('isUsableName sigue siendo MÁS laxa que isValidName, no al revés', () => {
    // Todo lo que vale para capturar vale para saludar. Lo contrario no: isUsableName
    // acepta "хочу" y por eso no puede usarse para capturar.
    for (const n of ['Наталья', 'Ana Garcia', 'Вера', 'Tiffany Dubois-Moiseaux']) {
        if (isValidName(n)) assert.ok(isUsableName(n), `${n}: válida para capturar pero no para saludar`);
    }
    assert.ok(isUsableName('хочу'), 'isUsableName es laxa a propósito');
    assert.ok(!isValidName('хочу'), 'isValidName NO puede aceptar "хочу"');
    assert.ok(!isNameToken('хочу'), 'isNameToken NO puede aceptar "хочу"');
});

if (process.exitCode) console.error('\nTests de nombre cirílico FALLIDOS');
else console.log('\nTests de nombre cirílico OK');
