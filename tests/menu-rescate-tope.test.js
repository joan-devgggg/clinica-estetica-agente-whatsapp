// El menú de rescate tiene techo: dos veces y se ofrece una persona (07/08/2026).
//
// `salonNoSlotsMsg` subía `sinServicioStreak` y a partir de 2 devolvía SIEMPRE el mismo
// párrafo: `streak >= 2` es un suelo, no un tope. Olga Yarmak (34674987146) lo recibió tres
// veces palabra por palabra —15:32:02, 15:41:06 y 15:41:21—, una de ellas contestando a
// «¿me puedes mandar una foto?». Acabó con «me niego a hablar con un robot, solo con
// personas», que es exactamente adonde el bot tendría que haberla llevado él solo.
//
// Se afirma el ESTADO (`session.pendingEscalation`), no la redacción: la prosa del mensaje
// puede cambiar sin que este test tenga que enterarse, y lo que importa es que el "sí" del
// turno siguiente lo pueda resolver la capa determinista.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    salonNoSlotsMsg, salonPickServiceMenuMsg, salonOfferHumanMsg, createEmptySession,
} = require('../bot.js')._internals;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const SANTE = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

function sesionSinServicio(language = 'ru') {
    // Sesión REAL, no un objeto a mano: así el test se entera si algún día el estado de
    // servicio deja de arrancar como se supone (misma razón que SERVICE_STATE_DEFAULTS).
    const s = createEmptySession('34674987146@c.us', SANTE);
    s.language = language;
    s.selectedService = null;
    s.sinServicioStreak = 0;
    s.pendingEscalation = false;
    s.pendingEscalationService = null;
    return s;
}

test('la secuencia real de Olga: pregunta, menú, menú, y entonces persona', () => {
    const s = sesionSinServicio('ru');
    const turnos = [1, 2, 3, 4].map(() => salonNoSlotsMsg(s));

    const menu = salonPickServiceMenuMsg({ language: 'ru' });
    assert.notStrictEqual(turnos[0], menu, 'el 1º es la pregunta abierta, no el menú');
    assert.strictEqual(turnos[1], menu, 'el 2º es el menú');
    assert.strictEqual(turnos[2], menu, 'el 3º sigue siendo el menú');
    assert.notStrictEqual(turnos[3], menu, 'el 4º YA NO puede ser el menú');
});

test('el techo arma la espera de escalada, que es lo que importa', () => {
    const s = sesionSinServicio('ru');
    for (let i = 0; i < 3; i++) {
        salonNoSlotsMsg(s);
        assert.strictEqual(s.pendingEscalation, false, `turno ${i + 1}: aún no se ofrece persona`);
    }
    salonNoSlotsMsg(s);
    // Lo que hace que el "sí" del turno siguiente llegue a alguien: el bloque determinista
    // de pendingEscalation crea la fila en pending_actions y avisa por Telegram.
    assert.strictEqual(s.pendingEscalation, true);
    assert.strictEqual(s.pendingEscalationService, 'traspaso');
});

test('nunca se repite el menú una tercera vez, en ningún idioma', () => {
    for (const language of ['es', 'en', 'ru', 'uk']) {
        const s = sesionSinServicio(language);
        const vistos = [1, 2, 3, 4, 5, 6].map(() => salonNoSlotsMsg(s));
        const menu = salonPickServiceMenuMsg({ language });
        const veces = vistos.filter(m => m === menu).length;
        assert.ok(veces <= 2, `${language}: el menú salió ${veces} veces`);
    }
});

test('la oferta de persona se mantiene si el bucle continúa', () => {
    // Una vez ofrecida, los turnos siguientes no vuelven al menú ni se quedan mudos.
    const s = sesionSinServicio('es');
    for (let i = 0; i < 6; i++) salonNoSlotsMsg(s);
    assert.strictEqual(salonNoSlotsMsg(s), salonOfferHumanMsg({ language: 'es' }));
    assert.strictEqual(s.pendingEscalation, true);
});

test('encontrar el servicio resetea el contador y devuelve el flujo normal', () => {
    const s = sesionSinServicio('es');
    salonNoSlotsMsg(s);
    salonNoSlotsMsg(s);
    // La clienta por fin dice lo que quiere: el contador vuelve a cero y no arrastramos el
    // bucle a una conversación que ya va bien.
    s.selectedService = { nombre: 'Corte', categoria: 'Cortes' };
    salonNoSlotsMsg(s);
    assert.strictEqual(s.sinServicioStreak, 0);
    assert.strictEqual(s.pendingEscalation, false);
});

test('el mensaje de traspaso es una PREGUNTA: no escala sin el sí', () => {
    // Los casos 1-6 del prompt prohíben escalar en el mismo mensaje en que se ofrece.
    // `pendingEscalation` es una espera, no una escalada: la fila la crea el "sí".
    for (const language of ['es', 'en', 'ru', 'uk']) {
        const msg = salonOfferHumanMsg({ language });
        assert.ok(/[?？]/.test(msg), `${language}: la oferta tiene que preguntar`);
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
