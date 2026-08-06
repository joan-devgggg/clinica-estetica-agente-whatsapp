// Un `upsert` de config que falla no puede devolver true (06/08/2026).
//
// Último superviviente de la familia "afirmar sin verificar" (docs/auditoria-afirmar-sin-verificar.md).
// `setConfigValue` hacía el upsert y devolvía `true` sin mirar el error NI cuántas filas tocó,
// y de esa tabla cuelga todo lo que la dueña configura: `bot_activo`, la ventana del
// recordatorio, las horas de la reseña, las plantillas de Meta. El panel decía "guardado" y el
// toggle se quedaba puesto en pantalla sobre una escritura que no había ocurrido; al recargar
// volvía el valor viejo, sin forma de saber si es que no se intentó o es que falló.
//
// Tres bloques:
//   A · db.setConfigValue LANZA ante un error y ante cero filas afectadas.
//   B · PUT /api/config/:clave devuelve 500 en vez de {ok:true}.
//   C · el call site de bot.js —que NO puede esperar la promesa— no deja un rechazo sin
//       manejar, deja traza, y mantiene el estado en memoria.
//
// Hermético: sin red, sin Supabase real.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const http = require('http');

const SANTE_ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// ─── Vigilante de rechazos sin manejar ──────────────────────────────────────────────────
// Es la mitad del encargo: `setBotActivo` es síncrona y no puede esperar la promesa, así que
// desde que setConfigValue lanza, un `.catch()` que falte deja de ser un detalle de estilo —
// en Node moderno un unhandled rejection tumba el proceso, o sea el bot entero de las dos orgs.
const rechazosSinManejar = [];
process.on('unhandledRejection', (r) => { rechazosSinManejar.push(r); });

// ─── Stubs ──────────────────────────────────────────────────────────────────────────────

// telegram.js va REAL (el bloque D ejercita su handler), pero sin tocar la red: se le quita
// el token para que `startTelegramBot` no arranque polling, y su `require('./db')` cae en el
// db real que ya trabaja contra el Supabase falso de abajo.
delete process.env.TELEGRAM_BOT_TOKEN;

const logs = [];
const loggerPath = require.resolve('../lib/logger');
const realLogger = require(loggerPath);
require.cache[loggerPath].exports = {
    ...realLogger,
    info: (e, m) => logs.push({ nivel: 'info', evento: e, meta: m }),
    warn: (e, m) => logs.push({ nivel: 'warn', evento: e, meta: m }),
    error: (e, m) => logs.push({ nivel: 'error', evento: e, meta: m }),
};

// Supabase falso: se controla qué contesta el upsert de `config`.
//   filasEscritas: [{clave}] → escribió (lo que devuelve el real con .select('clave'))
//   filasEscritas: []        → el upsert no casó nada
//   errorUpsert              → Supabase devolvió error
let filasEscritas = [{ clave: 'x' }];
let errorUpsert = null;
const upserts = [];
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: {
        from(tabla) {
            const q = { op: null, payload: null };
            const b = {
                select: () => b, eq: () => b, is: () => b, in: () => b, order: () => b, limit: () => b,
                update: () => b, insert: () => b,
                upsert: (p) => { q.op = 'upsert'; q.payload = p; upserts.push({ tabla, payload: p }); return b; },
                single: async () => ({ data: null, error: null }),
                maybeSingle: async () => ({ data: null, error: null }),
                then: (f, r) => Promise.resolve(
                    q.op === 'upsert'
                        ? { data: errorUpsert ? null : filasEscritas, error: errorUpsert }
                        : { data: [], error: null }).then(f, r),
            };
            return b;
        },
    },
};

const db = require('../services/db');
const { app } = require('../webhook');
db.authenticateToken = async (t) => (t === 'sante-token' ? { userId: 'u1', orgId: SANTE_ORG } : null);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function reset() {
    filasEscritas = [{ clave: 'x' }];
    errorUpsert = null;
    upserts.length = 0;
    logs.length = 0;
    rechazosSinManejar.length = 0;
}

// ─── A · setConfigValue ─────────────────────────────────────────────────────────────────

test('A1 · REGRESIÓN · un upsert que NO escribe ninguna fila ya no devuelve true', async () => {
    reset();
    filasEscritas = [];
    await assert.rejects(
        () => db.setConfigValue(SANTE_ORG, 'horas_recordatorio', 24),
        /config/,
        'devolvía true a ciegas: el panel cantaba "guardado" sobre una escritura que no ocurrió');
});

test('A2 · REGRESIÓN · un error de Supabase tampoco pasa por bueno', async () => {
    reset();
    errorUpsert = { message: 'TypeError: fetch failed', code: '' };
    await assert.rejects(() => db.setConfigValue(SANTE_ORG, 'bot_activo', false), /config/);
    assert.ok(logs.some(l => l.evento === 'db_write_error' && l.meta?.tabla === 'config'),
        'y queda la traza con la tabla y la operación');
});

test('A3 · CONTROL · el camino bueno sigue devolviendo true y escribiendo lo de siempre', async () => {
    reset();
    assert.strictEqual(await db.setConfigValue(SANTE_ORG, 'horas_resena', 2), true);
    const fila = upserts.find(u => u.tabla === 'config');
    assert.ok(fila, 'sin esto, A1 y A2 pasarían con la función rota');
    assert.strictEqual(fila.payload.clave, 'horas_resena');
    assert.strictEqual(fila.payload.valor, '2');
    assert.strictEqual(fila.payload.organization_id, SANTE_ORG);
});

test('A4 · el valor se serializa como siempre: cadena tal cual, lo demás en JSON', async () => {
    reset();
    await db.setConfigValue(SANTE_ORG, 'plantilla_resena', { es: 'sante_solicitud_resena' });
    await db.setConfigValue(SANTE_ORG, 'un_texto', 'hola');
    await db.setConfigValue(SANTE_ORG, 'bot_activo', true);
    const [plantilla, texto, activo] = upserts.map(u => u.payload.valor);
    assert.strictEqual(plantilla, '{"es":"sante_solicitud_resena"}');
    assert.strictEqual(texto, 'hola', 'una cadena NO se re-serializa (iría con comillas dentro)');
    assert.strictEqual(activo, 'true');
});

// ─── B · El panel deja de decir "guardado" cuando no se guardó ──────────────────────────

function request(server, { clave, valor }) {
    const { port } = server.address();
    const payload = JSON.stringify({ valor });
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, method: 'PUT', path: `/api/config/${clave}`,
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer sante-token',
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

async function conServidor(fn) {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    try { await fn(server); } finally { server.close(); }
}

test('B1 · REGRESIÓN · si la escritura falla, el endpoint responde 500 y NO {ok:true}', async () => {
    await conServidor(async (server) => {
        reset();
        filasEscritas = [];
        const r = await request(server, { clave: 'horas_recordatorio', valor: 24 });
        assert.strictEqual(r.status, 500, 'antes devolvía 200 {ok:true} y el panel cerraba el diálogo');
        assert.notStrictEqual(r.body?.ok, true);
    });
});

test('B2 · CONTROL · una escritura buena sigue devolviendo 200 {ok:true}', async () => {
    await conServidor(async (server) => {
        reset();
        const r = await request(server, { clave: 'horas_recordatorio', valor: 24 });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ok, true);
    });
});

// ─── C · El call site que NO puede esperar la promesa ───────────────────────────────────

const bot = require('../bot');

test('C1 · un fallo al persistir bot_activo NO deja un rechazo sin manejar', async () => {
    reset();
    const real = db.setConfigValue;
    // El require de setConfigValue vive DENTRO de setBotActivo, así que se resuelve en cada
    // llamada: sustituir la propiedad basta.
    db.setConfigValue = async () => { throw new Error('config: nada guardado'); };
    try {
        bot.setBotActivo(SANTE_ORG, false, true);       // síncrona: no se puede await
        await new Promise(r => setTimeout(r, 50));      // se le da tiempo a rechazar
        assert.deepStrictEqual(rechazosSinManejar, [],
            'un unhandled rejection aquí tumba el proceso, o sea el bot de las DOS orgs');
    } finally {
        db.setConfigValue = real;
    }
});

test('C2 · y deja traza de nivel error, diciendo que un reinicio lo revierte', async () => {
    reset();
    const real = db.setConfigValue;
    db.setConfigValue = async () => { throw new Error('config: nada guardado'); };
    try {
        bot.setBotActivo(SANTE_ORG, false, true);
        await new Promise(r => setTimeout(r, 50));
        const traza = logs.find(l => l.evento === 'bot_activo_no_persistido');
        assert.ok(traza, 'sin traza, el bot revive solo en el siguiente despliegue y nadie sabe por qué');
        assert.strictEqual(traza.nivel, 'error', 'no es un warn: revive un bot que alguien pausó');
        assert.strictEqual(traza.meta.valor, false);
        assert.strictEqual(traza.meta.orgId, SANTE_ORG);
    } finally {
        db.setConfigValue = real;
    }
});

test('C3 · el estado en MEMORIA sí queda aplicado: la pausa funciona ahora mismo', async () => {
    reset();
    const real = db.setConfigValue;
    db.setConfigValue = async () => { throw new Error('config: nada guardado'); };
    try {
        bot.setBotActivo(SANTE_ORG, false, true);
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(bot.isBotActivo(SANTE_ORG), false,
            'que no se pueda apuntar no puede impedir que el bot se calle ya');
    } finally {
        db.setConfigValue = real;
        bot.setBotActivo(SANTE_ORG, true, false);
    }
});

test('C4 · CONTROL · con persist=false no se escribe nada (arranque y eco del panel)', async () => {
    reset();
    bot.setBotActivo(SANTE_ORG, false, false);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(upserts.length, 0, 'server.js y webhook.js lo llaman así a propósito');
    assert.strictEqual(bot.isBotActivo(SANTE_ORG), false);
    bot.setBotActivo(SANTE_ORG, true, false);
});

test('C5 · devuelve una promesa que RESUELVE a booleano y nunca rechaza', async () => {
    reset();
    // Es el contrato que permite las dos cosas a la vez: que Telegram pueda esperar el
    // resultado y que server.js pueda ignorarlo sin tumbar el proceso.
    assert.strictEqual(await bot.setBotActivo(SANTE_ORG, true, true), true, 'guardado → true');
    assert.strictEqual(await bot.setBotActivo(SANTE_ORG, true, false), true, 'sin persistir → true (nada divergió)');

    const real = db.setConfigValue;
    db.setConfigValue = async () => { throw new Error('config: nada guardado'); };
    try {
        const r = bot.setBotActivo(SANTE_ORG, false, true);
        assert.ok(r && typeof r.then === 'function', 'tiene que ser esperable');
        await assert.doesNotReject(() => r, 'un rechazo aquí lo hereda quien no pueda esperarlo');
        assert.strictEqual(await r, false, 'no guardado → false, no una excepción');
    } finally {
        db.setConfigValue = real;
        bot.setBotActivo(SANTE_ORG, true, false);
    }
});

// ─── D · Telegram: no decirle "Bot pausado" al admin sobre algo que no se guardó ─────────

const telegram = require('../services/telegram');

// Se cablea el `setBotActivo` real, igual que hace server.js al arrancar.
telegram.startTelegramBot({ setBotActivo: bot.setBotActivo, getBotActivo: bot.isBotActivo });

test('D1 · REGRESIÓN · si no se guardó, el admin NO lee "pausado" a secas', async () => {
    reset();
    const real = db.setConfigValue;
    db.setConfigValue = async () => { throw new Error('config: nada guardado'); };
    try {
        const respuesta = await telegram._ejecutarAccion(SANTE_ORG, 'pause_bot', {}, null, null);
        assert.ok(!/^⏸️ Bot de WhatsApp <b>pausado<\/b>/.test(respuesta),
            `antes contestaba esto pasara lo que pasara: ${respuesta}`);
        assert.ok(/no he podido guardarlo/i.test(respuesta), respuesta);
        // Y tiene que decir la consecuencia REAL, que no es obvia: está pausado ahora, pero un
        // reinicio lo revive. Sin eso el admin no sabe que hay que volver a intentarlo.
        assert.ok(/reinicia/i.test(respuesta), `sin la consecuencia no es accionable: ${respuesta}`);
        assert.ok(/pausado y no contesta/i.test(respuesta), 'y que ahora mismo SÍ está pausado');
    } finally {
        db.setConfigValue = real;
    }
});

test('D2 · lo mismo al reactivar: si no se guardó, se dice', async () => {
    reset();
    const real = db.setConfigValue;
    db.setConfigValue = async () => { throw new Error('config: nada guardado'); };
    try {
        const respuesta = await telegram._ejecutarAccion(SANTE_ORG, 'resume_bot', {}, null, null);
        assert.ok(/no he podido guardarlo/i.test(respuesta), respuesta);
        assert.ok(/quedar[ií]a pausado|volver[ií]a a quedarse pausado/i.test(respuesta),
            `la consecuencia al reactivar es la contraria, y también hay que decirla: ${respuesta}`);
    } finally {
        db.setConfigValue = real;
    }
});

test('D3 · CONTROL · cuando SÍ se guarda, el mensaje es el de siempre', async () => {
    reset();
    const pausa = await telegram._ejecutarAccion(SANTE_ORG, 'pause_bot', {}, null, null);
    assert.strictEqual(pausa, '⏸️ Bot de WhatsApp <b>pausado</b> para tu negocio.');
    assert.strictEqual(bot.isBotActivo(SANTE_ORG), false, 'y el bot está pausado de verdad');

    const reanuda = await telegram._ejecutarAccion(SANTE_ORG, 'resume_bot', {}, null, null);
    assert.strictEqual(reanuda, '▶️ Bot de WhatsApp <b>reactivado</b> para tu negocio.');
    assert.strictEqual(bot.isBotActivo(SANTE_ORG), true);

    assert.strictEqual(upserts.filter(u => u.payload.clave === 'bot_activo').length, 2,
        'las dos veces se escribió de verdad: sin esto D1/D2 no demuestran nada');
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
