/**
 * tests/oferta-no-es-afirmacion.test.js — «¿Te lo reservo?» es una PREGUNTA, y la red final
 * anti-mentira no puede sustituirla por «no he podido fijar ese hueco».
 *
 * El caso que lo destapó (11/08/2026, conv 7a92ac2a): una clienta pregunta por el
 * anti-encrespamiento, el bot le pide el largo del pelo y ella contesta «Lo tengo por encima
 * del pecho». El modelo responde BIEN —«Perfecto, entonces es cabello medio. El
 * Anti-encrespamiento te cuesta 160 € y dura 240 minutos. ¿Te lo reservo?»— y lo que le llegó
 * a ella fue «Uy, no he podido fijar ese hueco 😕 ¿Cuál de los horarios disponibles te viene
 * mejor?». Dos veces, las dos justo tras describir el largo, sin que se hubiera hablado de
 * horarios en toda la conversación. Se fue sin cita.
 *
 * El camino: `llmClaimsBooked` casa «te lo reservo» por su patrón de 1ª persona
 * (/\bte (la|lo|…)? (reservo|apunto|anoto|agendo)\b/), o sea que la red se activa sobre una
 * OFERTA; y como no hay hora ni fecha que casar, `pickChosenSlot` devuelve null y el `else`
 * pisaba el texto. Medido: 6 de cada 10 turnos reales en ese estado.
 *
 * Lo que se afirma aquí NO es «no falla», es que **el texto del modelo llega intacto**. Y la
 * otra mitad, que es la que impide que el arreglo se pase de ancho: las AFIRMACIONES de
 * verdad, en los cuatro idiomas, siguen rectificándose. Esa segunda parte existe porque el
 * 07/08/2026 `asksForBookingApproval` se QUITÓ de la exención de horario por exonerar de más
 * («подойдёт» está en BOOKING_APPROVAL_QUESTIONS): aquí se usa en otro sitio y con otro
 * efecto, y hay que poder demostrarlo en vez de suponerlo.
 *
 * Hermético: Supabase, Telegram y el LLM interceptados. Cero red.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const assert = require('assert');

const SANTE_ORG = process.env.SANTE_ORG_ID || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

// ─── 1. Supabase mudo ────────────────────────────────────────────────────────────────
// Nunca devuelve `error`: assertRead lanzaría y lo que se prueba no es un fallo de BD.
function makeBuilder() {
    const state = { table: null, op: 'select', single: false };
    const resolve = () => Promise.resolve(
        state.op === 'insert' || state.op === 'upsert'
            ? { data: { id: `${state.table}-row-1` }, error: null }
            : { data: state.single ? null : [], error: null }
    );
    const b = {
        from(t) { state.table = t; return b; },
        select() { return b; },
        insert() { state.op = 'insert'; return b; },
        upsert() { state.op = 'upsert'; return b; },
        update() { state.op = 'update'; return b; },
        delete() { state.op = 'delete'; return b; },
        eq() { return b; }, neq() { return b; }, in() { return b; },
        gte() { return b; }, lte() { return b; }, lt() { return b; }, gt() { return b; },
        is() { return b; }, or() { return b; }, not() { return b; },
        order() { return b; }, limit() { return b; },
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

// ─── 2. Telegram mudo ────────────────────────────────────────────────────────────────
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        startTelegramBot: () => {},
        notifyEscalation: async () => {}, notifyBlacklistAlert: async () => {},
        notifyBizumPending: async () => {}, notifyVipSuggestion: async () => {},
        notifyOrgAdmin: () => {},
    },
};

// ─── 3. Logger que GRABA ─────────────────────────────────────────────────────────────
const logs = [];
const rec = level => (evento, fields = {}) => { logs.push({ level, evento, ...fields }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

// ─── 4. LLM stubeado, con el texto del turno bajo prueba ─────────────────────────────
const openai = require('../services/providers/openai');
let respuestaLLM = 'Ok 😊';
openai.getChatbotResponse = async () => ({
    respuesta: respuestaLLM,
    reserva_confirmada: false, cita_confirmada: false, slot_rechazado: false,
    accion: null, idioma_detectado: null,
    // Sin hora ni fecha: es exactamente lo que devolvió el modelo en el caso real, y es lo
    // que hace que pickChosenSlot no pueda identificar ningún hueco.
    datos: { nombre: null, servicio: null, fecha_cita: null, hora_cita: null },
});
openai.summarizeHistory = async () => null;

const bot = require('../bot');
const { makeClient, makeMessage } = require('./lib/convo');
const { llmClaimsBooked, asksForBookingApproval } = bot._internals;

const RETRY = /no he podido fijar ese hueco/i;

// El servicio y los huecos del caso real. Tres huecos y ninguna hora en el mensaje: la
// selección es ambigua, así que pickChosenSlot devuelve null — que es la rama bajo prueba.
const SERVICIO = { nombre: 'Medio', categoria: 'Anti-encrespamiento', precio: 160, duracion: 240 };
const HUECOS = [
    { fecha: '2026-08-12', hora: '10:00', stylistId: 'sty-1', stylistName: 'Irina',    texto: 'miércoles 12 a las 10:00 con Irina' },
    { fecha: '2026-08-13', hora: '10:00', stylistId: 'sty-2', stylistName: 'Veronika', texto: 'jueves 13 a las 10:00 con Veronika' },
    { fecha: '2026-08-14', hora: '11:00', stylistId: 'sty-1', stylistName: 'Irina',    texto: 'viernes 14 a las 11:00 con Irina' },
];

let fallos = 0;
async function test(nombre, fn) {
    try { await fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`fail - ${nombre}\n   ${e.message}`); }
}

// Conduce UN turno con el estado exacto del incidente: servicio resuelto, huecos cargados
// (y jamás nombrados — el prompt del largo le ordena al modelo «NO propongas huecos», que es
// por lo que desde fuera parecía que no había ninguno) y la cita sin confirmar.
async function turnoConHuecosCargados(textoClienta, textoDelModelo) {
    respuestaLLM = textoDelModelo;
    const sink = [];
    const client = makeClient(sink);
    // Teléfono único por corrida: memory.js persiste de verdad en data/clients.db.
    const phone = `34600${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}@c.us`;

    // Turno de arranque, solo para que exista la sesión que hay que sembrar.
    await bot.handleIncomingMessage(client, makeMessage(phone, 'hola'), SANTE_ORG);
    await bot._internals.flushBuffer(SANTE_ORG, phone);

    const s = bot._internals.getSession(SANTE_ORG, phone);
    assert.ok(s, 'no se creó la sesión');
    s.selectedService = SERVICIO;
    s.availableSlots = HUECOS.slice();
    s.proposedSlots = HUECOS.slice();
    s.slotsProposed = true;
    s.reservaConfirmada = false;
    s.currentSlotIndex = 0;
    s.lastMessageTime = 0;

    const before = sink.length;
    await bot.handleIncomingMessage(client, makeMessage(phone, textoClienta), SANTE_ORG);
    await bot._internals.flushBuffer(SANTE_ORG, phone);
    return sink.slice(before).map(m => m.text).join('\n');
}

(async () => {
    // ═══ 1. La conducta: el mensaje bueno llega intacto ═══════════════════════════════
    await test('«¿Te lo reservo?» tras el largo: el texto del modelo LLEGA INTACTO', async () => {
        const bueno = 'Perfecto, entonces es cabello medio. El Anti-encrespamiento te cuesta 160€ y dura 240 minutos. ¿Te lo reservo?';
        const salida = await turnoConHuecosCargados('Lo tengo por encima del pecho', bueno);

        assert.ok(!RETRY.test(salida),
            `se pisó el mensaje bueno con el de reintento.\n   salió: ${JSON.stringify(salida)}`);
        assert.ok(/¿te lo reservo\?/i.test(salida),
            `la oferta del modelo no llegó.\n   salió: ${JSON.stringify(salida)}`);
        assert.ok(/160/.test(salida),
            `se perdió el precio, que es el dato por el que preguntaba.\n   salió: ${JSON.stringify(salida)}`);
    });

    // La traza distingue este caso del que sí es un fallo. Sin ella, el día que esto vuelva
    // a pasar el log dice lo mismo que cuando no pasa nada.
    await test('deja traza propia (cita_sante_oferta_sin_slot), no el warn de fallo', async () => {
        assert.ok(logs.some(l => l.evento === 'cita_sante_oferta_sin_slot'),
            'no se registró cita_sante_oferta_sin_slot');
        assert.ok(!logs.some(l => l.evento === 'cita_sante_texto_sin_guardar'),
            'se registró cita_sante_texto_sin_guardar: la rama vieja se sigue comiendo el turno');
    });

    // ═══ 2. El límite: una AFIRMACIÓN sin hueco sigue rectificándose ══════════════════
    //
    // Es la mitad que impide que el arreglo se pase de ancho. Si esto se pusiera en verde por
    // el camino equivocado, el bot podría afirmar una cita que no existe — la cita fantasma.
    await test('una afirmación sin hueco identificable SIGUE rectificándose', async () => {
        const mentira = 'Listo, te la he reservado ✅ ¡Nos vemos!';
        const salida = await turnoConHuecosCargados('vale', mentira);

        assert.ok(RETRY.test(salida),
            `una afirmación sin respaldo salió tal cual.\n   salió: ${JSON.stringify(salida)}`);
        assert.ok(!/reservad/i.test(salida),
            `el texto que afirmaba la reserva sobrevivió.\n   salió: ${JSON.stringify(salida)}`);
    });

    // ═══ 3. Los cuatro idiomas, fila por fila ════════════════════════════════════════
    //
    // Puro (sin conducir el bot) porque lo que se fija es el criterio: qué separa una oferta
    // de una afirmación. Es lo que hay que volver a mirar el día que alguien toque
    // BOOKING_APPROVAL_QUESTIONS o BOOKING_CLAIM_PATTERNS.
    const OFERTAS = [
        ['es', '¿Te lo reservo?'],
        ['es', 'El Anti-encrespamiento te cuesta 160€. ¿Te lo reservo?'],
        ['es', '¿Te la apunto para el jueves?'],
    ];
    const AFIRMACIONES = [
        ['es', 'Te la he reservado para el jueves a las 10:00 ✅'],
        ['es', 'Tu cita queda confirmada el jueves a las 10:00'],
        ['es', 'Listo, te apunto el jueves a las 10:00'],
        ['en', 'You are all set for Thursday at 10:00'],
        ['ru', 'Записала тебя на четверг в 10:00 ✅'],
        ['uk', 'Запис підтверджено на четвер о 10:00'],
    ];

    await test('las ofertas quedan EXENTAS (llmClaimsBooked true + asksForBookingApproval true)', async () => {
        for (const [lang, t] of OFERTAS) {
            assert.strictEqual(llmClaimsBooked(t), true,
                `[${lang}] llmClaimsBooked debería seguir casando (si deja de hacerlo, la exención sobra): ${t}`);
            assert.strictEqual(asksForBookingApproval(t), true,
                `[${lang}] asksForBookingApproval NO reconoce la oferta, así que se volvería a pisar: ${t}`);
        }
    });

    await test('las afirmaciones de los 4 idiomas NO quedan exentas', async () => {
        for (const [lang, t] of AFIRMACIONES) {
            assert.strictEqual(llmClaimsBooked(t), true,
                `[${lang}] la red ni siquiera se activaría sobre esta afirmación: ${t}`);
            assert.strictEqual(asksForBookingApproval(t), false,
                `[${lang}] la exención se traga una AFIRMACIÓN: quedaría una cita fantasma sin rectificar: ${t}`);
        }
    });

    console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} FALLO(S)`);
    process.exit(fallos === 0 ? 0 : 1);
})();
