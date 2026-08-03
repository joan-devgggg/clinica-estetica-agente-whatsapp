// Regresión del incidente 34624184532 (Sante, 02/08/2026), segunda mitad.
//
// La clienta pidió dos veces en lenguaje natural que le evaluaran el cabello. Ninguna de
// las dos frases la reconocía nadie (extractServiceFromText → null Y detectConsultaValoracion
// → false), así que selectedService se quedó en null, loadAvailableSlots no llegó a correr y
// la red anti-invención-de-disponibilidad sobrescribió la respuesta del LLM con
// salonNoSlotsMsg. Dos veces. Con el MISMO texto. Ella se rindió y pidió una hidratación
// que no quería.
//
// Aquí se congelan las tres piezas del arreglo:
//   D) detectConsultaValoracion reconoce la familia "evaluar / valorar / que me vean".
//   E) salonNoSlotsMsg deja de repetirse: a la 2ª cierra el abanico y ofrece la consulta.
//   C) "reactivo" es un dato (isReactiveOnlyService), no prosa del prompt.

process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
    detectConsultaValoracion, isReactiveOnlyService, isReactiveOnlyCategory,
    extractServiceFromText,
} = require('../services/helpers');
const {
    salonNoSlotsMsg, salonPickServiceMenuMsg, SERVICE_STATE_DEFAULTS, createEmptySession,
} = require('../bot')._internals;

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

const sesionSinServicio = (language = null) => ({
    selectedService: null, language, sinServicioStreak: 0, consultaOfrecida: false,
    availableSlots: [],
});

// ─── D · las frases reales de la clienta ──────────────────────────────────────

test('D · "me tienen que evaluar" y compañía ahora se reconocen', () => {
    const reales = [
        'Me gustaría que me evaluarán bien y me dijeran que necesito .... Si quisiera que me '
            + 'evaluará y lo hiciera alguien que sepa de rubios',
        'Me tienen que evaluar',
    ];
    for (const frase of reales) {
        assert.ok(detectConsultaValoracion(frase), `debería reconocer: "${frase.slice(0, 40)}…"`);
    }
    for (const frase of ['quiero que me valoren el pelo', 'que me vean el pelo',
        'me tienen que ver el pelo', 'quiero una valoración']) {
        assert.ok(detectConsultaValoracion(frase), `"${frase}"`);
    }
});

test('D · los negativos siguen siendo negativos', () => {
    for (const frase of ['quiero un corte de puntas', 'no sé si prefiero corto o largo',
        'balayage largo 2', 'quiero manicura', 'me recomendó este sitio una amiga',
        'quiero mechas el jueves', 'me han hecho mechas y mi cabello es un desastre', '']) {
        assert.ok(!detectConsultaValoracion(frase), `NO debería disparar: "${frase}"`);
    }
});

test('D · la bifurcación capilar vs genérico se decide antes, en el catálogo', () => {
    // bot.js corre extractServiceFromText ANTES del gate de la consulta, así que una señal
    // capilar se lleva la tricológica de 85€ y sólo lo genérico cae en la reactiva.
    const CAT = [
        { categoria: 'Consulta', nombre: 'Consulta', precio: null, duracion: 300 },
        { categoria: 'Diagnóstico Capilar', nombre: 'Consulta tricológica con Yulia', precio: 85, duracion: 60 },
    ];
    assert.strictEqual(extractServiceFromText('tengo caída del pelo', CAT).precio, 85,
        'señal capilar → tricológica');
    assert.strictEqual(extractServiceFromText('me tienen que evaluar', CAT), null,
        'genérico → no resuelve en el catálogo, lo recoge el gate reactivo');
});

// ─── E · el bucle ─────────────────────────────────────────────────────────────

test('E · la 1ª vez pregunta el servicio; la 2ª NO repite lo mismo', () => {
    const s = sesionSinServicio();
    const primera = salonNoSlotsMsg(s);
    assert.ok(/qué servicio quieres/i.test(primera), 'la 1ª es la pregunta de siempre');
    assert.strictEqual(s.sinServicioStreak, 1);

    const segunda = salonNoSlotsMsg(s);
    assert.notStrictEqual(segunda, primera, 'la 2ª no puede ser el mismo texto');
    assert.strictEqual(s.sinServicioStreak, 2);
});

test('E · el mensaje de rescate cierra el abanico y ofrece la consulta', () => {
    const s = sesionSinServicio();
    salonNoSlotsMsg(s);
    const menu = salonNoSlotsMsg(s);
    for (const cat of ['Color o mechas', 'Corte o peinado', 'Manicura o pedicura', 'Masaje o spa']) {
        assert.ok(menu.includes(cat), `el menú debe incluir "${cat}"`);
    }
    assert.ok(/consulta de valoraci[oó]n de 20 minutos/i.test(menu), 'ofrece la consulta');
    assert.strictEqual(s.consultaOfrecida, true,
        'deja armado el "sí" del turno siguiente (lo consume el gate de bot.js)');
});

test('E · resolver el servicio pone el contador a cero', () => {
    const s = sesionSinServicio();
    salonNoSlotsMsg(s);
    assert.strictEqual(s.sinServicioStreak, 1);
    s.selectedService = { nombre: 'Corte mujer', categoria: 'Cortes', duracion: 60 };
    salonNoSlotsMsg(s);
    assert.strictEqual(s.sinServicioStreak, 0, 'con servicio, la racha se reinicia');
});

test('E · i18n: el rescate respeta el idioma, con fallback a español', () => {
    for (const [lang, aguja] of [['ru', 'консультацию'], ['uk', 'консультацію'], ['en', 'consultation']]) {
        const s = sesionSinServicio(lang);
        salonNoSlotsMsg(s);
        const menu = salonNoSlotsMsg(s);
        assert.ok(menu.includes(aguja), `${lang} debe salir en su idioma`);
    }
    const desconocido = sesionSinServicio('pt');
    salonNoSlotsMsg(desconocido);
    assert.ok(/consulta de valoraci[oó]n/i.test(salonNoSlotsMsg(desconocido)), 'fallback ES');
});

test('E · salonPickServiceMenuMsg es idempotente respecto a consultaOfrecida', () => {
    const s = sesionSinServicio();
    salonPickServiceMenuMsg(s);
    salonPickServiceMenuMsg(s);
    assert.strictEqual(s.consultaOfrecida, true);
});

// ─── C · "reactivo" como dato ─────────────────────────────────────────────────

test('C · isReactiveOnlyService identifica la Consulta y sólo la Consulta', () => {
    assert.ok(isReactiveOnlyService({ categoria: 'Consulta', nombre: 'Consulta' }));
    assert.ok(isReactiveOnlyCategory('consulta'), 'insensible a mayúsculas/acentos');
    assert.ok(!isReactiveOnlyService({ categoria: 'Diagnóstico Capilar', nombre: 'Consulta tricológica con Yulia' }),
        'la tricológica es un servicio normal y ofertable');
    assert.ok(!isReactiveOnlyService({ categoria: 'Cortes', nombre: 'Corte mujer' }));
    assert.ok(!isReactiveOnlyService(null));
});

test('C · el catálogo del prompt NO enseña la categoría reactiva al modelo', () => {
    const { buildSystemPrompt } = require('../services/providers/openai');
    const cfg = {
        business_info: { companyName: 'Sante', direccion: 'X', horario: 'Y' },
        services: [
            { categoria: 'Cortes', nombre: 'Corte mujer', precio: 35, duracion: 60 },
            { categoria: 'Consulta', nombre: 'Consulta', precio: null, duracion: 300 },
            { categoria: 'Diagnóstico Capilar', nombre: 'Consulta tricológica con Yulia', precio: 85, duracion: 60 },
        ],
    };
    const SANTE_ORG_ID = process.env.SANTE_ORG_ID || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
    const prompt = buildSystemPrompt(SANTE_ORG_ID, {}, 'reservar', false, null, cfg);
    assert.ok(!/Consulta de valoraci[oó]n\s+—/.test(prompt),
        'la línea de menú "Consulta de valoración —" ya no existe: el modelo la ofrecía');
    assert.ok(prompt.includes('Consulta tricológica con Yulia'),
        'la tricológica SÍ sigue en el catálogo (es reservable y tiene precio)');
    assert.ok(/NUNCA lo mezcles con la "Consulta tricol[oó]gica con Yulia"/.test(prompt),
        'y la regla anti-fusión está presente');
    // El bloque interno de 300 min no puede aparecer como línea de catálogo. (La cadena
    // "300" sí sale en la instrucción `NUNCA digas "300 minutos"`, que es justo lo contrario
    // de una fuga: por eso se comprueba el formato de línea de catálogo, no el número.)
    assert.ok(!/•.*\(300 min\)/.test(prompt), 'el bloque de 300 min no se lista como servicio');
    assert.ok(!/^Consulta:$/m.test(prompt), 'la categoría reactiva no encabeza ninguna sección');
});

// ─── Higiene de estado ────────────────────────────────────────────────────────

test('las claves nuevas están en SERVICE_STATE_DEFAULTS (las limpia clearServiceState)', () => {
    for (const k of ['consultaValoracionDetectada', 'sinServicioStreak', 'consultaOfrecida']) {
        assert.ok(k in SERVICE_STATE_DEFAULTS, `${k} debe registrarse para la 2ª reserva`);
    }
    assert.strictEqual(SERVICE_STATE_DEFAULTS.sinServicioStreak, 0);
    assert.strictEqual(SERVICE_STATE_DEFAULTS.consultaValoracionDetectada, false);
    assert.strictEqual(SERVICE_STATE_DEFAULTS.consultaOfrecida, false);
});

test('createEmptySession arranca con las tres claves', () => {
    const s = createEmptySession('34600000000', 'org', '34600000000');
    assert.strictEqual(s.consultaValoracionDetectada, false);
    assert.strictEqual(s.sinServicioStreak, 0);
    assert.strictEqual(s.consultaOfrecida, false);
});

if (!process.exitCode) console.log('\nTests del bucle sin servicio OK');
process.exit(process.exitCode || 0);
