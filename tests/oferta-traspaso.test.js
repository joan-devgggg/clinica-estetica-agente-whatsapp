// El anillo 1 de C7: la oferta de traspaso arma, el «sí» ejecuta la triple VERIFICADA,
// y solo entonces pronuncia la máquina. Cierra los casos de Estefania Sanz (03/08:
// remisión al equipo aceptada con «Claro ☺️» y evaporada) y el acuse-sobre-fallo del
// bloque de aceptación (el catch se tragaba la escritura rota y el acuse salía igual).
//
// Visto fallar sin lo que protege (sabotajes con cp previo, 14/08):
//   · quitar el gate del boolean de escalateToHuman → acuse sobre escritura fallida (rojo);
//   · quitar el ru del detector → rojo el bloque de idiomas;
//   · quitar el chequeo de TTL → rojo el bloque de la re-oferta.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');

// ─── Stubs ANTES de requerir bot (patrón de media-dedupe.test.js) ────────────
const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/supabase', {});

// db como Proxy con capturas: lo que el flujo toque existe; lo que importa se graba.
// `fallarEscrituras` simula la BD rechazando la triple (el camino del acuse mentiroso).
const estado = { escrituras: [], fallarEscrituras: false };
const escribe = nombre => async (...args) => {
    if (estado.fallarEscrituras) throw new Error(`${nombre} rechazada (simulada)`);
    estado.escrituras.push({ nombre, args });
    return nombre === 'createPendingAction' ? { id: 'pa-test' } : true;
};
const dbImpls = {
    setLeadBotMode: escribe('setLeadBotMode'),
    setEscalationReason: escribe('setEscalationReason'),
    createPendingAction: escribe('createPendingAction'),
    findByPhone: async () => ({ id: 'ct-test', full_name: 'Test', wa_phone: '34600000001' }),
    saveMessage: async () => 1,
};
stub('../services/db', new Proxy(dbImpls, { get: (t, k) => t[k] ?? (async () => null) }));
stub('../services/telegram', {
    notifyBizumPending: async () => {}, notifyEscalation: async () => {},
    notifyBlacklistAlert: async () => {}, startTelegramBot: () => {},
});

const bot = require('../bot');
const {
    detectaOfertaTraspaso, remisionAlEquipo, createEmptySession, userSessions, sessionKey,
    flushBuffer, CONFIRM_YES,
} = bot._internals;
const { SANTE_ORG_ID } = require('../services/org-registry');

// ─── 1 · El detector, fuente única ───────────────────────────────────────────

test('detecta las ofertas reales: Celeste, el pronombre de Mafe y las plantillas en 4 idiomas', () => {
    const ofertas = [
        '¿Quieres que te ponga en contacto con una especialista para que valore tu caso?', // Celeste 06/08
        '¿Quieres que te ponga en contacto con ellas para que te lo aclaren?',             // Mafe 12/08 (pronombre)
        'Extensions require a personalized assessment 😊 Would you like me to put you in touch with one of our specialists?',
        'Наращивание требует индивидуальной оценки 😊 Хочешь, чтобы я связала тебя с одной из наших специалисток?',
        "Нарощування потребує індивідуальної оцінки 😊 Хочеш, щоб я зв'язала тебе з однією з наших спеціалісток?",
    ];
    for (const o of ofertas) assert.ok(detectaOfertaTraspaso(o), `debería detectar: "${o.slice(0, 50)}"`);
});

test('detecta la REMISIÓN de Estefania (sin «¿?» y sin verbo de traspaso)', () => {
    const remision = 'te recomiendo que hables directamente con nuestro equipo — ellos podrán valorar tu situación.';
    assert.ok(detectaOfertaTraspaso(remision));
    assert.ok(remisionAlEquipo(remision), 'y la subclase remisión la distingue el barrido');
});

test('no dispara con menciones de pasada ni afirmaciones (la lección de Olga: armar de más aún es barato, pero no gratis)', () => {
    for (const t of [
        'Nuestro equipo abre a las 10 😊 ¿Te reservo para mañana?',
        'Le paso tu mensaje a nuestro equipo para que te atiendan personalmente 🙏', // afirmación, no oferta
        'El salón te espera el jueves a las 10:00',
        '¿Qué servicio necesitas hoy?',
        'te ayudo a reservar cuando quieras 😊',
    ]) assert.ok(!detectaOfertaTraspaso(t), `NO debería disparar: "${t.slice(0, 50)}"`);
});
