/**
 * tests/llm-caido-aviso.test.js — "El bot contesta a todo el mundo sin entender nada".
 *
 * El 05/08/2026 se acabó el saldo de OpenRouter. Cada llamada devolvía 402, getChatbotResponse
 * agotaba sus reintentos y devolvía el fallback —"Perdona, no he podido procesar tu
 * mensaje"— a la clienta. El bot siguió respondiendo con educación a todo el mundo, sin coger
 * una cita ni reconocer un servicio, y no se supo hasta mirar un log a mano.
 *
 * Se prueban las dos mitades:
 *   1. La política (llm-health): qué cuenta como proveedor caído, qué es cuenta de pago y
 *      qué es avería pasajera.
 *   2. El incidente real de punta a punta, conducido por getChatbotResponse con un cliente de
 *      OpenRouter falso que devuelve 402 — la vía por la que se manifestó.
 *
 * Sin red y sin Supabase.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const assert = require('assert');
const { test } = require('node:test');

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const OTRA_ORG = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── Telegram interceptado en su frontera real (notifyOrgAdmin) ──────────────
const avisos = [];
let entrega = true; // ¿acepta Telegram?
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        notifyOrgAdmin: async (orgId, mensaje) => { avisos.push({ orgId, mensaje }); return entrega; },
        startTelegramBot: () => {}, notifyEscalation: async () => {},
        notifyBlacklistAlert: async () => {}, notifyBizumPending: async () => {},
        notifyVipSuggestion: async () => {},
    },
};

const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

// ─── El paquete `openai` interceptado ANTES de que openai.js lo instancie ────
// openai.js hace `new OpenAI({...})` al cargarse, así que parchear la clase después no
// sirve de nada: el cliente ya existe. Y sin este stub el test SALE A INTERNET con una
// clave falsa — tardaba 27 s y medía el 401 de OpenRouter en vez de nuestro código.
let siguienteRespuestaLlm = null; // () => Promise<respuesta> | lanza
let llamadasLlm = 0;
const openaiPkgPath = require.resolve('openai');
class OpenAIFalso {
    constructor() {
        this.chat = {
            completions: {
                create: async (...args) => {
                    llamadasLlm++;
                    return siguienteRespuestaLlm(...args);
                },
            },
        };
    }
}
require.cache[openaiPkgPath] = {
    id: openaiPkgPath, filename: openaiPkgPath, loaded: true, exports: OpenAIFalso,
};

const { noteLlmResult, classifyLlmError, FALLOS_PARA_AVISAR, _reset } = require('../services/llm-health');
const { _resetThrottle } = require('../services/admin-alerts');

function limpiar() {
    avisos.length = 0;
    logs.length = 0;
    entrega = true;
    _reset();
    _resetThrottle();
}

const err = (message, status = null) => Object.assign(new Error(message), status ? { status } : {});
const fallar = async (n, e, orgId = ORG) => {
    for (let i = 0; i < n; i++) await noteLlmResult(orgId, { ok: false, error: e });
};

// ─── 1 · La política: qué cuenta y de qué tipo ───────────────────────────────

test('clasificación · cuenta de pago vs avería pasajera', () => {
    // Lo que NO se arregla solo: alguien tiene que pagar o renovar la clave.
    assert.deepStrictEqual(classifyLlmError(err('402 Insufficient credits', 402)),
        { tipo: 'cuenta', codigo: 'http_402' });
    assert.strictEqual(classifyLlmError(err('401 Unauthorized', 401)).tipo, 'cuenta');
    assert.strictEqual(classifyLlmError(err('403 Forbidden', 403)).tipo, 'cuenta');

    // Lo que suele volver solo.
    assert.strictEqual(classifyLlmError(err('429 Too Many Requests', 429)).tipo, 'transitorio');
    assert.strictEqual(classifyLlmError(err('503 Service Unavailable', 503)).tipo, 'transitorio');
    assert.strictEqual(classifyLlmError(err('socket hang up')).tipo, 'transitorio');
    assert.strictEqual(classifyLlmError(err('ECONNRESET')).tipo, 'transitorio');
});

test('clasificación · el 402 real de OpenRouter, tal cual llegó', () => {
    // Sin `status` en el objeto: solo el texto. Es como llegó envuelto el 05/08.
    const real = err('402 Insufficient credits. Add more using https://openrouter.ai/settings/credits');
    assert.deepStrictEqual(classifyLlmError(real), { tipo: 'cuenta', codigo: 'http_402' });
});

test('clasificación · lo que NO es del proveedor no cuenta', () => {
    // Un 400 es nuestro payload: contarlo aquí culparía al proveedor de un bug nuestro.
    assert.strictEqual(classifyLlmError(err('400 Bad Request', 400)), null);
    // Y lo desconocido tampoco: inflar la racha con lo que no se entiende es cómo un aviso
    // se convierte en ruido que nadie lee.
    assert.strictEqual(classifyLlmError(err('algo rarísimo')), null);
    assert.strictEqual(classifyLlmError(null), null);
});

// ─── 2 · El umbral y el throttle ─────────────────────────────────────────────

test('avisa al TERCER fallo seguido, no antes', async () => {
    limpiar();
    await fallar(FALLOS_PARA_AVISAR - 1, err('402 Insufficient credits', 402));
    assert.strictEqual(avisos.length, 0, 'dos fallos no son una caída');

    await fallar(1, err('402 Insufficient credits', 402));
    assert.strictEqual(avisos.length, 1);
    assert.strictEqual(avisos[0].orgId, ORG);
});

test('y no repite mientras siga caído', async () => {
    limpiar();
    await fallar(FALLOS_PARA_AVISAR + 20, err('402 Insufficient credits', 402));
    assert.strictEqual(avisos.length, 1, '23 conversaciones rotas = 1 aviso, no 23');
});

test('un motivo distinto empieza racha nueva', async () => {
    limpiar();
    await fallar(2, err('429 Too Many Requests', 429));
    await fallar(2, err('402 Insufficient credits', 402));
    assert.strictEqual(avisos.length, 0, 'dos por un motivo y dos por otro no son tres seguidos');
    await fallar(1, err('402 Insufficient credits', 402));
    assert.strictEqual(avisos.length, 1);
});

test('un éxito por medio corta la racha', async () => {
    limpiar();
    await fallar(2, err('402 Insufficient credits', 402));
    await noteLlmResult(ORG, { ok: true });
    await fallar(2, err('402 Insufficient credits', 402));
    assert.strictEqual(avisos.length, 0, 'la racha se cuenta SEGUIDA');
});

// ─── 3 · El texto: tiene que decirle a Yulia qué hacer ───────────────────────

test('el aviso de cuenta dice que no se arregla solo y qué hay que hacer', async () => {
    limpiar();
    await fallar(FALLOS_PARA_AVISAR, err('402 Insufficient credits', 402));
    const m = avisos[0].mensaje;
    assert.ok(/no se arregla solo/i.test(m), 'tiene que descartar que sea pasajero');
    assert.ok(/recargar saldo|renovar la clave/i.test(m), 'tiene que decir la acción');
    // Y el síntoma que ella va a ver o le van a contar, con sus palabras.
    assert.ok(/no he podido procesar tu mensaje/.test(m));
    assert.ok(/no coge citas/i.test(m));
});

test('el aviso transitorio NO manda pagar nada', async () => {
    limpiar();
    await fallar(FALLOS_PARA_AVISAR, err('503 Service Unavailable', 503));
    const m = avisos[0].mensaje;
    assert.ok(/se recupera solo/i.test(m));
    assert.ok(!/recargar saldo/i.test(m),
        'mandar pagar por una caída de 10 minutos del proveedor es la peor instrucción posible');
});

test('el texto va en español y sin jerga técnica suelta', async () => {
    limpiar();
    await fallar(FALLOS_PARA_AVISAR, err('402 Insufficient credits', 402));
    const m = avisos[0].mensaje;
    // El código va, pero etiquetado como dato entre <code>, no como explicación.
    assert.ok(/<code>http_402<\/code>/.test(m));
    for (const jerga of ['token', 'endpoint', 'timeout', 'API key', 'status code', 'null']) {
        assert.ok(!new RegExp(jerga, 'i').test(m.replace(/<code>.*?<\/code>/g, '')),
            `el mensaje a Yulia no puede llevar "${jerga}"`);
    }
});

// ─── 4 · La recuperación ─────────────────────────────────────────────────────

test('cuando vuelve, avisa — y sin eso el aviso vale la mitad', async () => {
    limpiar();
    await fallar(FALLOS_PARA_AVISAR, err('402 Insufficient credits', 402));
    assert.strictEqual(avisos.length, 1);

    await noteLlmResult(ORG, { ok: true });
    assert.strictEqual(avisos.length, 2);
    assert.ok(/vuelve a funcionar/i.test(avisos[1].mensaje));
    // Quien recibió la alarma tiene que saber que hubo clientas afectadas.
    assert.ok(/repasar el panel/i.test(avisos[1].mensaje));
});

test('y una segunda caída del mismo tipo vuelve a avisar (la clave se liberó)', async () => {
    limpiar();
    await fallar(FALLOS_PARA_AVISAR, err('402 Insufficient credits', 402));
    await noteLlmResult(ORG, { ok: true });
    avisos.length = 0;

    await fallar(FALLOS_PARA_AVISAR, err('402 Insufficient credits', 402));
    assert.strictEqual(avisos.length, 1, 'sin liberar la clave, la 2ª caída sería muda para siempre');
});

test('un ok sin caída previa no dice nada', async () => {
    limpiar();
    await noteLlmResult(ORG, { ok: true });
    assert.strictEqual(avisos.length, 0);
});

// ─── 5 · Aislamiento entre organizaciones ────────────────────────────────────

test('la racha de una org no avisa a la otra', async () => {
    limpiar();
    await fallar(FALLOS_PARA_AVISAR, err('402 Insufficient credits', 402), ORG);
    assert.strictEqual(avisos.length, 1);
    assert.ok(avisos.every(a => a.orgId === ORG), 'San Remo no tiene por qué recibir el de Sante');
});

// ─── 6 · Un aviso que no llega no cuenta como avisado ────────────────────────

test('si Telegram no lo acepta, el siguiente fallo reintenta', async () => {
    limpiar();
    entrega = false;
    await fallar(FALLOS_PARA_AVISAR, err('402 Insufficient credits', 402));
    assert.strictEqual(avisos.length, 1, 'se intentó');
    assert.ok(logs.some(l => l.evento === 'admin_alert_no_entregado'));

    entrega = true;
    await fallar(1, err('402 Insufficient credits', 402));
    assert.strictEqual(avisos.length, 2, 'un aviso que no llegó no puede contar como avisado');
});

// ─── 7 · Observar no puede romper ────────────────────────────────────────────

test('si el aviso revienta, la conversación sigue', async () => {
    limpiar();
    const original = require('../services/telegram').notifyOrgAdmin;
    require('../services/telegram').notifyOrgAdmin = async () => { throw new Error('telegram muerto'); };
    await assert.doesNotReject(() => fallar(FALLOS_PARA_AVISAR, err('402 Insufficient credits', 402)));
    require('../services/telegram').notifyOrgAdmin = original;
});

test('sin orgId no hace nada en vez de explotar', async () => {
    limpiar();
    await assert.doesNotReject(() => noteLlmResult(null, { ok: false, error: err('402', 402) }));
    assert.strictEqual(avisos.length, 0);
});

// ─── 8 · El incidente real, por el embudo de verdad ──────────────────────────

test('INCIDENTE 05/08 · tres conversaciones con 402 → Yulia se entera', async () => {
    limpiar();
    llamadasLlm = 0;
    // El 402 literal que devolvió OpenRouter, con su status, en todas las llamadas.
    siguienteRespuestaLlm = async () => {
        throw Object.assign(
            new Error('402 Insufficient credits. Add more using https://openrouter.ai/settings/credits'),
            { status: 402 });
    };

    // Los reintentos de openai.js esperan de verdad (RETRY_DELAYS = [0, 2000]). Con tres
    // conversaciones eso son ~34 s dentro de `npm test`, y lo que se prueba aquí no es la
    // espera. Se acorta durante este test y se restaura al salir.
    const setTimeoutReal = global.setTimeout;
    global.setTimeout = (fn, _ms, ...args) => setTimeoutReal(fn, 0, ...args);

    const { getChatbotResponse } = require('../services/providers/openai');
    const cfg = { services: [], business_info: {} };
    const historia = [{ role: 'user', content: 'hola quiero una cita' }];
    const conversacion = () => getChatbotResponse(ORG, historia, {}, 'reservar', false, null, cfg);

    const r1 = await conversacion();
    const r2 = await conversacion();
    assert.strictEqual(avisos.length, 0, 'dos conversaciones rotas todavía no son una caída');

    const r3 = await conversacion();

    // Lo que recibió la clienta: el fallback. Es el síntoma que nadie vio el 05/08.
    for (const r of [r1, r2, r3]) {
        assert.ok(String(r._fallbackReason || '').startsWith('api_error:402'),
            `esperaba el fallback por 402, llegó: ${r._fallbackReason}`);
        assert.ok(/no he podido procesar/i.test(r.respuesta || ''));
    }
    // Varios intentos por conversación, tres conversaciones: muchas llamadas, UN aviso.
    assert.ok(llamadasLlm >= 6, `esperaba reintentos, hubo ${llamadasLlm} llamadas`);
    assert.strictEqual(avisos.length, 1, 'los reintentos NO pueden contar como caídas distintas');
    assert.ok(/recargar saldo|renovar la clave/i.test(avisos[0].mensaje));

    // Y al volver el saldo, el aviso de recuperación.
    siguienteRespuestaLlm = async () => ({
        choices: [{ message: { content: '{"respuesta":"¡Hola! ¿Qué servicio quieres?","datos":{}}' } }],
    });
    await conversacion();
    assert.strictEqual(avisos.length, 2);
    assert.ok(/vuelve a funcionar/i.test(avisos[1].mensaje));

    global.setTimeout = setTimeoutReal;
});
