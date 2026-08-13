// «Somos dos»: la cita es para más de una persona (12/08/2026).
//
// Mariola Mira Lopez pidió cita «para mí y una amiga», lo repitió tres veces, y el bot lo
// leyó como DOS SERVICIOS para una sola persona hasta preguntarle «¿cuál queréis primero,
// el Spa Hair Detox o la Reconstrucción Pro Miracle?». El LLM sí lo había entendido —lo dijo
// dos veces con sus palabras («podemos agendar para las dos», «¿es para ti, para tu amiga o
// para las dos?»)— pero no había dónde guardarlo, así que el determinista lo aplanaba cada
// turno.
//
// Se afirma el ESTADO, no la redacción del modelo (regla 2): el detector, la marca pegajosa
// de la sesión y su viaje a SQLite. La prosa del bot no la mide ningún assert salvo donde
// las palabras SON el daño (que aquí no es el caso).
//
// Probado por DOS mutaciones, porque prueban cosas distintas:
//   · revertir `detectVariasPersonas` (return false) tumba los bloques 1-4;
//   · meter 'las dos' A SECAS en VARIAS_PERSONAS_FRASES tumba el bloque 5 —y SOLO ese—,
//     que es lo que demuestra que el que protege es la exclusión deliberada de la hora, no
//     el vocabulario.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { detectVariasPersonas, detectGuestBooking } = require('../services/helpers');
const { _internals } = require('../bot');
const { buildSessionExtra, salonVariasPersonasMsg } = _internals;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── 1 · La conversación que lo originó, palabra por palabra ─────────────────

test('REGRESIÓN · el primer mensaje literal de Mariola', () => {
    assert.strictEqual(
        detectVariasPersonas('Hola quiero saber si teneis citas disponibles para mi y una amiga'),
        true,
    );
});

test('la forma sin la conjunción seguía funcionando, y la de ella fallaba por UNA palabra', () => {
    // detectGuestBooking tenía 'para mi amiga' y 'para una amiga'; el «y» de en medio la
    // dejaba fuera. Las dos formas tienen que casar ahora, y por las dos vías.
    assert.strictEqual(detectVariasPersonas('es para mi y una amiga'), true);
    assert.strictEqual(detectGuestBooking('citas disponibles para mi y una amiga'), true);
    assert.strictEqual(detectGuestBooking('es para mi amiga'), true);
});

// ─── 2 · Las formas reales, en los cuatro idiomas ────────────────────────────

test('castellano: la cantidad dicha de frente', () => {
    for (const t of ['somos dos', 'Somos 2', 'seríamos dos', 'venimos dos',
        'para dos personas', 'una para cada una', 'las dos juntas']) {
        assert.strictEqual(detectVariasPersonas(t), true, `no casó: ${t}`);
    }
});

test('castellano: la pareja nombrada, en los dos órdenes', () => {
    for (const t of ['para mí y mi madre', 'para mí y una amiga', 'mi amiga y yo',
        'mi hermana y yo', 'una amiga y yo', 'para mí y para mi amiga']) {
        assert.strictEqual(detectVariasPersonas(t), true, `no casó: ${t}`);
    }
});

test('inglés', () => {
    for (const t of ['we are two', 'there are two of us', 'for two people',
        'for both of us', 'me and a friend', 'my friend and I']) {
        assert.strictEqual(detectVariasPersonas(t), true, `no casó: ${t}`);
    }
});

test('ruso y ucraniano NO comparten entrada, aunque se parezcan a la vista', () => {
    // «на двоих» (ru, и) y «на двох» (uk, х) son palabras distintas: es la lección de
    // «до талии» / «до талії». Y todo el cirílico va por buildCyrillicRe — normalizeText
    // descompone й/ё/ї y \b es ASCII, así que un patrón a mano no casaría nunca.
    for (const t of ['нас двое', 'для двоих', 'на двоих', 'мы вдвоём', 'я и подруга']) {
        assert.strictEqual(detectVariasPersonas(t), true, `ru no casó: ${t}`);
    }
    for (const t of ['нас двоє', 'для двох', 'на двох', 'ми вдвох', 'я і подруга']) {
        assert.strictEqual(detectVariasPersonas(t), true, `uk no casó: ${t}`);
    }
});

// ─── 3 · La marca es pegajosa y viaja ────────────────────────────────────────

test('la marca y su aviso viajan en buildSessionExtra', () => {
    // Sin esto, una conversación que cruce un timeout vuelve a leerse como de una sola
    // persona y el párrafo se repite. Es la lección de session.tratamiento y session.leadId.
    const extra = buildSessionExtra({
        orgType: 'salon', variasPersonas: true, variasPersonasAvisado: true,
    });
    assert.strictEqual(extra.variasPersonas, true);
    assert.strictEqual(extra.variasPersonasAvisado, true);
});

test('San Remo no lleva nada de esto en su extra', () => {
    const extra = buildSessionExtra({ orgType: 'restaurant', variasPersonas: true });
    assert.strictEqual(extra.variasPersonas, undefined);
});

// ─── 4 · El mensaje arma la escalada y no promete horario ────────────────────

test('el mensaje OFRECE una persona y arma pendingEscalation a mano', () => {
    // Armado a mano y no vía offersHumanHandover, que solo reconoce el castellano: para una
    // clienta rusa la oferta se quedaría colgando. Mismo criterio que salonOfferHumanMsg.
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        const session = { language: lang };
        const msg = salonVariasPersonasMsg(session);
        assert.strictEqual(session.pendingEscalation, true, `${lang}: no armó la escalada`);
        assert.strictEqual(session.pendingEscalationService, 'varias_personas');
        assert.ok(msg && msg.length > 40, `${lang}: mensaje vacío o demasiado corto`);
    }
});

test('los cuatro idiomas dan textos DISTINTOS (ninguno cae a castellano)', () => {
    const vistos = new Set();
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        vistos.add(salonVariasPersonasMsg({ language: lang }));
    }
    assert.strictEqual(vistos.size, 4);
});

// ─── 5 · «LAS DOS» ES UNA HORA ───────────────────────────────────────────────
// El bloque que cae —y solo él— si alguien mete 'las dos' a secas en la lista.

test('CRÍTICO · «a las dos» son las 14:00, no dos personas', () => {
    for (const t of ['a las dos', 'me viene bien a las dos', 'las dos y media',
        'para las dos y cuarto', '¿puedes para las dos?', 'mejor a las dos']) {
        assert.strictEqual(detectVariasPersonas(t), false, `falso positivo: ${t}`);
    }
});

test('CRÍTICO · «sería para las dos» se deja FUERA a propósito', () => {
    // Mariola lo usó con el sentido de dos personas, pero en castellano vale igual para las
    // 14:00 y no hay forma de deducir cuál. Mismo criterio que el sujetador en
    // extractLargoPelo: en la raya no se adivina. Ella queda cubierta por su PRIMER mensaje,
    // que sí es inequívoco, y la marca es pegajosa: basta con acertar una vez.
    assert.strictEqual(detectVariasPersonas('Para esta semana porque la que viene no podemos. Seria para las dos'), false);
});

test('otros falsos positivos que no son una petición para dos', () => {
    for (const t of ['quiero las dos cosas', 'El masaje capilar el de 60 euros',
        'quiero una cita', 'hola buenas', 'para mí a las 5']) {
        assert.strictEqual(detectVariasPersonas(t), false, `falso positivo: ${t}`);
    }
    // Y el negativo que ya protegía a detectGuestBooking sigue en pie.
    assert.strictEqual(detectGuestBooking('para mí a las 5'), false);
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
