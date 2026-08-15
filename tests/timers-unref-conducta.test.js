/**
 * tests/timers-unref-conducta.test.js — poner `.unref()` a dos timers no puede cambiar NADA
 * de lo que ve una clienta. Este fichero lo afirma con conducta, no con razonamiento.
 *
 * Los dos timers (15/08/2026):
 *   · `bot.js` — el `setTimeout` de 45 s que compite en el `Promise.race` del LLM. Cuando
 *     gana el modelo, el perdedor seguía vivo reteniendo el proceso.
 *   · `bot.js` — la limpieza del buffer a los 60 s (`BUFFER_CLEANUP_TTL_MS`), que borra la
 *     entrada del Map cuando la conversación queda inactiva.
 *
 * **El timer que AGRUPA no se toca y no está en esa lista.** Agrupar es el `buffer.timer`
 * de `BUFFER_DELAY_MS` (se re-arma con cada mensaje, y otra vez tras un flush con pendientes);
 * el de 60 s solo limpia memoria cuando ya no hay nada. Aun así el bloque 1 vigila la
 * agrupación entera, porque es la pieza que más guerra ha dado y porque un test que solo
 * mirase el timer cambiado no protegería de nada.
 *
 * Qué hace `.unref()` y por qué es seguro: un timer con unref dispara EXACTAMENTE igual
 * mientras el proceso siga vivo por cualquier otro motivo — solo pierde la capacidad de ser
 * él la razón de seguir vivo. En producción el proceso lo mantienen Express y los clientes de
 * WhatsApp. Es la misma doctrina que ya aplican los tres `setInterval` de módulo
 * (docs/incidentes-cerrados.md#timers-unref); esto solo la extiende a dos `setTimeout` que se
 * habían quedado fuera. El bloque 3 lo comprueba en vez de suponerlo.
 *
 * Visto fallar sin lo que protege (sabotajes con cp previo, 15/08/2026 — los rojos son los
 * MEDIDOS):
 *   · sustituir el `setTimeout(…, BUFFER_DELAY_MS)` de `handleIncomingMessage` por un
 *     `await flushBuffer(sKey)` inmediato —o sea, dejar de agrupar sin tocar la constante—
 *     → **rojo 1.1 y 1.2**. Este es el sabotaje que importa: es la conducta, no el reloj.
 *   · no re-armar el timer cuando llega un mensaje nuevo (la ventana pasa a contar desde el
 *     PRIMERO en vez de desde el último) → **rojo 1.2**. Por eso 1.2 manda un tercer mensaje
 *     DESPUÉS de que la ventana original habría vencido: con el log solo no se distinguía.
 *   · `BUFFER_DELAY_MS` a 0 → el fichero aborta en el `assert` de cabecera antes de correr
 *     ningún bloque. Es a propósito: con otra ventana, las esperas de aquí abajo miden otra
 *     cosa y los verdes no valdrían nada.
 *   · 1.3 no lleva sabotaje propio: es un bloque **CONTROL**: existe para que un cambio que
 *     agrupe de MÁS (juntar mensajes separados por minutos) no pase el 1.1 tan campante.
 *
 * Hermético: Supabase, Telegram, el logger y el LLM interceptados. Cero red.
 * Cuesta ~15 s de reloj —esperas reales de la ventana, que es justo lo que hay que medir— y
 * los tres escenarios corren en PARALELO para no pagarlas tres veces. Se paga a gusto: el
 * cambio que acompaña baja `oferta-traspaso` de 62,4 s a 2,8 s.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const assert = require('assert');

const SANTE_ORG = process.env.SANTE_ORG_ID || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// ─── Supabase mudo (nunca `error`: assertRead lanzaría y no es lo que se prueba) ─────
function makeBuilder() {
    const state = { table: null, op: 'select', single: false };
    const resolve = () => Promise.resolve(
        state.op === 'insert' || state.op === 'upsert'
            ? { data: { id: `${state.table}-row-1` }, error: null }
            : { data: state.single ? null : [], error: null });
    const b = {
        from(t) { state.table = t; return b; },
        select() { return b; }, insert() { state.op = 'insert'; return b; },
        upsert() { state.op = 'upsert'; return b; }, update() { state.op = 'update'; return b; },
        delete() { state.op = 'delete'; return b; },
        eq() { return b; }, neq() { return b; }, in() { return b; }, gte() { return b; },
        lte() { return b; }, lt() { return b; }, gt() { return b; }, is() { return b; },
        or() { return b; }, not() { return b; }, order() { return b; }, limit() { return b; },
        single() { state.single = true; return resolve(); },
        maybeSingle() { state.single = true; return resolve(); },
        then(onF, onR) { return resolve().then(onF, onR); },
    };
    return b;
}
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from(t) { return makeBuilder().from(t); } },
};

const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        startTelegramBot: () => {}, notifyEscalation: async () => {},
        notifyBlacklistAlert: async () => {}, notifyBizumPending: async () => {},
        notifyVipSuggestion: async () => {}, notifyOrgAdmin: () => {},
    },
};

const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

// ─── LLM stubeado: responde por teléfono, y puede tardar o no entregar ───────────────
const openai = require('../services/providers/openai');
const plan = new Map(); // telefono -> { respuesta, demoraMs, entrega }
let llamadas = 0;
openai.getChatbotResponse = async (orgId, history, partial) => {
    llamadas++;
    const tel = String(partial?.telefono || '');
    const p = [...plan.entries()].find(([k]) => tel.includes(k))?.[1] || {};
    if (p.demoraMs) await new Promise(r => setTimeout(r, p.demoraMs));
    if (p.entrega === false) return null;   // el LLM no entrega: MISMA rama que el timeout
    return {
        respuesta: p.respuesta || 'Ok 😊',
        reserva_confirmada: false, cita_confirmada: false, slot_rechazado: false,
        accion: null, idioma_detectado: null,
        datos: { nombre: null, servicio: null, fecha_cita: null, hora_cita: null },
    };
};
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const { makeClient, makeMessage } = require('./lib/convo');
const BUFFER_DELAY_MS = bot._internals.BUFFER_DELAY_MS;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0;
const nuevoTelefono = () => `3460000${String(Date.now()).slice(-5)}${n++}@c.us`;

const turnos = tel => logs.filter(l => l.evento === 'process_core_inicio' && l.telefono === tel).length;
const flushes = tel => logs.filter(l => l.evento === 'buffer_flush' && l.telefono === tel);

let fallos = 0;
async function test(nombre, fn) {
    try { await fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`fail - ${nombre}\n   ${e.message}`); }
}

// Manda SIN forzar flush: se deja correr el debounce REAL, que es lo que se está midiendo.
async function manda(client, tel, texto) {
    await bot.handleIncomingMessage(client, makeMessage(tel, texto), SANTE_ORG);
}

(async () => {
    assert.strictEqual(BUFFER_DELAY_MS, 5000, 'la ventana del buffer cambió: revisa las esperas de este test');

    // ═══ 1. AGRUPACIÓN — la condición: esto NO puede cambiar ═════════════════════════
    // Los tres escenarios corren EN PARALELO, con teléfonos distintos (buffers
    // independientes): son esperas de reloj y en serie costarían el triple.
    const telA = nuevoTelefono(), telB = nuevoTelefono(), telC = nuevoTelefono();
    const sinkA = [], sinkB = [], sinkC = [];
    const cA = makeClient(sinkA), cB = makeClient(sinkB), cC = makeClient(sinkC);

    await Promise.all([
        // A · tres mensajes seguidos dentro de la ventana
        (async () => {
            await manda(cA, telA, 'hola');
            await sleep(150); await manda(cA, telA, 'quiero cita');
            await sleep(150); await manda(cA, telA, 'para mañana');
            await sleep(BUFFER_DELAY_MS + 1500);
        })(),
        // B · el timer se REINICIA con cada mensaje, y se comprueba por CONDUCTA, no por el
        //     log: el 2º llega casi al final de la ventana y el 3º DESPUÉS de que la ventana
        //     original hubiera vencido. Si la ventana contase desde el PRIMER mensaje, a los
        //     5 s se habría vaciado con dos y el tercero sería un turno aparte. Que los tres
        //     salgan en uno solo es lo que prueba que cada mensaje corre el plazo.
        (async () => {
            await manda(cB, telB, 'primero');
            await sleep(BUFFER_DELAY_MS - 800);
            await manda(cB, telB, 'segundo');
            await sleep(2000);
            await manda(cB, telB, 'tercero');
            await sleep(BUFFER_DELAY_MS + 1500);
        })(),
        // C · CONTROL — separados por MÁS de la ventana son DOS turnos. Sin esto, un
        //     sabotaje que agrupase para siempre pasaría el bloque A tan campante.
        (async () => {
            await manda(cC, telC, 'uno');
            await sleep(BUFFER_DELAY_MS + 2000);
            await manda(cC, telC, 'dos');
            await sleep(BUFFER_DELAY_MS + 1500);
        })(),
    ]);

    await test('1.1 tres mensajes seguidos = UN turno, con el texto combinado en orden', () => {
        assert.strictEqual(turnos(telA), 1, `esperaba 1 turno, hubo ${turnos(telA)}: dejó de agrupar`);
        const f = flushes(telA);
        assert.strictEqual(f.length, 1, `esperaba 1 flush, hubo ${f.length}`);
        assert.strictEqual(f[0].mensajesCombinados, 3, `combinó ${f[0].mensajesCombinados} de 3`);
        assert.strictEqual(f[0].textoCombinado, 'hola\nquiero cita\npara mañana',
            `el texto combinado no es el esperado: ${JSON.stringify(f[0].textoCombinado)}`);
        assert.strictEqual(sinkA.length, 1, `salió más de una respuesta: ${sinkA.length}`);
    });

    await test('1.2 el temporizador se REINICIA: la ventana cuenta desde el ÚLTIMO mensaje', () => {
        assert.strictEqual(turnos(telB), 1,
            `esperaba 1 turno, hubo ${turnos(telB)}: la ventana ya no se reinicia con cada mensaje`);
        const f = flushes(telB);
        assert.strictEqual(f[0].mensajesCombinados, 3, `combinó ${f[0].mensajesCombinados} de 3`);
        assert.strictEqual(f[0].textoCombinado, 'primero\nsegundo\ntercero');
        assert.ok(logs.some(l => l.evento === 'buffer_timer_reiniciado' && l.telefono === telB),
            'no se registró el reinicio del temporizador');
    });

    await test('1.3 CONTROL: separados por más de la ventana son DOS turnos', () => {
        assert.strictEqual(turnos(telC), 2, `esperaba 2 turnos, hubo ${turnos(telC)}: agrupa de más`);
        const f = flushes(telC);
        assert.deepStrictEqual(f.map(x => x.textoCombinado), ['uno', 'dos']);
        assert.strictEqual(sinkC.length, 2, `esperaba 2 respuestas, hubo ${sinkC.length}`);
    });

    // ═══ 2. EL LLM QUE TARDA — la otra mitad de lo aprobado ══════════════════════════
    await test('2.1 un LLM LENTO (pero que responde) se contesta igual, y una sola vez', async () => {
        const tel = nuevoTelefono();
        plan.set(tel.split('@')[0], { respuesta: 'Tardé pero aquí estoy 😊', demoraMs: 900 });
        const sink = [];
        const antes = llamadas;
        await manda(makeClient(sink), tel, 'hola?');
        await bot._internals.flushBuffer(SANTE_ORG, tel);
        assert.strictEqual(llamadas, antes + 1, 'el LLM se llamó más de una vez');
        assert.strictEqual(sink.length, 1, `esperaba 1 respuesta, hubo ${sink.length}`);
        assert.ok(/Tardé pero aquí estoy/.test(sink[0].text),
            `no llegó la respuesta del modelo: ${JSON.stringify(sink[0].text)}`);
    });

    await test('2.2 si el LLM NO entrega (la rama del timeout) sale el fallback, no el silencio', async () => {
        const tel = nuevoTelefono();
        plan.set(tel.split('@')[0], { entrega: false });
        const sink = [];
        await manda(makeClient(sink), tel, 'hola?');
        await bot._internals.flushBuffer(SANTE_ORG, tel);
        assert.strictEqual(sink.length, 1, `esperaba 1 respuesta, hubo ${sink.length}`);
        assert.ok(/no he podido procesar|repites|intenta/i.test(sink[0].text),
            `no salió el fallback: ${JSON.stringify(sink[0].text)}`);
        assert.ok(logs.some(l => l.evento === 'fallback_diagnostico' && l.telefono === tel),
            'no quedó la traza de diagnóstico del fallback');
    });

    // ═══ 3. La propiedad que hace segura la firma ════════════════════════════════════
    await test('3. un timer con .unref() SIGUE disparando mientras el proceso viva', async () => {
        let disparo = false;
        const t = setTimeout(() => { disparo = true; }, 120);
        assert.strictEqual(typeof t.unref, 'function', 'este entorno no da Timeout con unref');
        t.unref();
        await sleep(300);
        assert.strictEqual(disparo, true,
            'un timer unref no disparó con el proceso vivo: la premisa del cambio es falsa');
    });

    await test('3.b los dos timers del cambio llevan .unref() (y el que AGRUPA no)', () => {
        const fs = require('fs');
        const src = fs.readFileSync(require('path').join(__dirname, '..', 'bot.js'), 'utf8');
        // El perdedor del race del LLM.
        assert.ok(/const timeout = new Promise\(resolve => \{[\s\S]{0,200}?unrefTimer\(/.test(src)
            || /unrefTimer\(setTimeout\(\(\) => resolve\(TIMED_OUT\)/.test(src),
            'el setTimeout del Promise.race del LLM ya no va por unrefTimer');
        // La limpieza del buffer.
        assert.ok(/unrefTimer\(setTimeout\(\(\) => \{[\s\S]{0,320}?BUFFER_CLEANUP_TTL_MS\)/.test(src),
            'la limpieza del buffer ya no va por unrefTimer');
        // Y el que agrupa sigue SIN unref: si alguien se lo pone, el proceso podría morir
        // con mensajes de una clienta sin contestar dentro del buffer.
        const agrupa = src.match(/buffer\.timer = [^\n]*setTimeout\(\(\) => flushBuffer\(sKey\), BUFFER_DELAY_MS\)/g) || [];
        assert.strictEqual(agrupa.length, 2, `esperaba 2 armados del timer de agrupación, hay ${agrupa.length}`);
        for (const linea of agrupa) {
            assert.ok(!/unref/.test(linea), `el timer que AGRUPA lleva unref: ${linea}`);
        }
    });

    if (fallos) { console.error(`\n${fallos} FALLOS`); process.exit(1); }
    console.log('\nTODO OK');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
