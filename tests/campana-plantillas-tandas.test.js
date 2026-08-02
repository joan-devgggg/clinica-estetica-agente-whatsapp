// Campañas por PLANTILLA y por TANDAS (02/08/2026).
//
// Los broadcasts del panel mandaban texto libre a pelo. En Cloud API eso solo se entrega
// dentro de la ventana de 24 h; fuera, Meta responde 200 y no entrega nada — con ~700
// contactos y casi ninguno dentro de ventana, la campaña entera se perdía en silencio.
//
// Igual que plantillas-fuera-de-ventana.test.js, esto NO reconstruye el mensaje a mano:
// ejecuta el motor REAL (services/broadcast.runBroadcast) con `services/db` stubeado y
// `global.fetch` capturado, y afirma sobre el payload HTTP EXACTO que viajaría a 360dialog.
// Nada sale a WhatsApp real.
process.env.TZ = 'Europe/Madrid';
process.env.SANTE_360_API_KEY = 'test-key-360';
process.env.SANTE_360_PHONE_NUMBER_ID = '111222333';
process.env.WHATSAPP_360_BASE_URL = 'https://waba-v2.360dialog.io';

const assert = require('assert');
const { SANTE_ORG_ID, SANREMO_ORG_ID } = require('../services/org-registry');

// Mismo truco de require.cache que el resto de la suite: se neutraliza el cliente Supabase
// ANTES de cargar db (que requiere credenciales reales), se conserva la implementación REAL
// de isWithin24hWindow y sanitizePhone —son lógica bajo prueba, no dobles— y se sustituye el
// módulo db entero por un stub con estado controlable.
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };

const dbPath = require.resolve('../services/db');
const { isWithin24hWindow, sanitizePhone } = require(dbPath);

const PLANTILLA_CAMPANA = {
    es: { name: 'sante_verano_tratamientos2',    language: 'es' },
    en: { name: 'sante_verano_tratamientos_en2', language: 'en' },
    ru: { name: 'sante_verano_tratamientos_ru2', language: 'ru' },
    uk: { name: 'sante_verano_tratamientos_uk2', language: 'uk' },
};

let state;

function resetState() {
    state = {
        config: {
            [SANTE_ORG_ID]: { plantilla_campana: PLANTILLA_CAMPANA },
            [SANREMO_ORG_ID]: {},
        },
        lastInbound: {},   // telefono → ISO | null
        sends: [],         // filas de broadcast_sends
        claimSeq: 0,
        warns: [],
    };
}

const dbStub = {
    isWithin24hWindow,  // implementación REAL
    sanitizePhone,      // implementación REAL: el dedupe depende de que normalice igual
    async getLastInboundAt(_orgId, telefono) { return state.lastInbound[telefono] ?? null; },
    async getLastInboundAtBulk(_orgId, telefonos) {
        const m = new Map();
        for (const t of telefonos || []) {
            const p = sanitizePhone(t);
            if (state.lastInbound[p] !== undefined) m.set(p, state.lastInbound[p]);
        }
        return m;
    },
    async getConfigValue(orgId, clave) {
        const v = state.config[orgId]?.[clave];
        return v === undefined ? null : v;
    },
    async getBroadcastSentPhones(orgId, campaignKey) {
        return new Set(state.sends
            .filter(s => s.orgId === orgId && s.campaignKey === campaignKey && s.status === 'sent')
            .map(s => s.telefono));
    },
    async resetStaleBroadcastClaims(orgId, campaignKey) {
        const antes = state.sends.length;
        state.sends = state.sends.filter(s =>
            !(s.orgId === orgId && s.campaignKey === campaignKey && s.status !== 'sent'));
        return antes - state.sends.length;
    },
    async claimBroadcastRecipient(orgId, { campaignKey, contactId, telefono }) {
        const phone = sanitizePhone(telefono);
        // Réplica del UNIQUE (organization_id, campaign_key, wa_phone).
        const choca = state.sends.some(s =>
            s.orgId === orgId && s.campaignKey === campaignKey && s.telefono === phone);
        if (choca) return null;
        const id = `claim-${++state.claimSeq}`;
        state.sends.push({ id, orgId, campaignKey, contactId, telefono: phone, status: 'pending' });
        return id;
    },
    async finishBroadcastSend(orgId, claimId, patch) {
        const fila = state.sends.find(s => s.id === claimId && s.orgId === orgId);
        if (!fila) throw new Error('finishBroadcastSend: fila no encontrada');
        Object.assign(fila, patch, { sent_at: patch.status === 'sent' ? new Date().toISOString() : null });
        return true;
    },
    async countBroadcastSendsLast24h(orgId) {
        return state.sends.filter(s => s.orgId === orgId && s.status === 'sent').length;
    },
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };

const loggerPath = require.resolve('../lib/logger');
const realLogger = require(loggerPath);
require.cache[loggerPath].exports = {
    ...realLogger,
    warn: (evento, meta) => { state.warns.push({ evento, meta }); },
    info: () => {},
    error: () => {},
};

const { runBroadcast } = require('../services/broadcast');
const { build360Client } = require('../services/providers/threesixty-dialog');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── Helpers ─────────────────────────────────────────────────────────────────

const horasAtras = h => new Date(Date.now() - h * 3600 * 1000).toISOString();

function contacto(n, { language = 'es', telefono, wa_jid = null } = {}) {
    return {
        id: `contact-${n}`,
        telefono: telefono || `3460000${String(n).padStart(4, '0')}`,
        nombre: `Clienta ${n}`,
        language,
        wa_jid,
    };
}

// Ejecuta el motor con fetch capturado. Devuelve { reqs, resumen }.
async function correr(orgId, opts) {
    const original = global.fetch;
    const reqs = [];
    global.fetch = async (url, o) => {
        reqs.push({ url, body: JSON.parse(o.body), headers: o.headers });
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) };
    };
    try {
        const resumen = await runBroadcast(orgId, {
            client: build360Client(orgId),
            // sendText inyectado: el waSendMessage real vive en bot.js y arrastraría medio
            // proyecto. Aquí el texto libre sale por el mismo cliente 360, que es lo que
            // queremos ver en el payload.
            sendText: async (client, jid, texto) => client.sendMessage(jid, texto),
            ...opts,
        });
        return { reqs, resumen };
    } finally { global.fetch = original; }
}

// ─── Fuera de ventana → plantilla del IDIOMA de la clienta, sin variables ────

test('fuera de ventana: cada idioma recibe SU plantilla y sin components', async () => {
    resetState();
    const destinatarios = [
        contacto(1, { language: 'es' }),
        contacto(2, { language: 'en' }),
        contacto(3, { language: 'ru' }),
        contacto(4, { language: 'uk' }),
    ];
    // Nadie tiene entrante → todos fuera de ventana.
    const { reqs, resumen } = await correr(SANTE_ORG_ID, {
        destinatarios,
        plantillaClave: 'plantilla_campana',
        campaignKey: 'verano2026',
    });

    assert.strictEqual(resumen.enviados, 4);
    assert.strictEqual(resumen.por_plantilla, 4);
    assert.strictEqual(resumen.texto_libre, 0);

    const porNombre = reqs.map(r => r.body.template.name).sort();
    assert.deepStrictEqual(porNombre, [
        'sante_verano_tratamientos2',
        'sante_verano_tratamientos_en2',
        'sante_verano_tratamientos_ru2',
        'sante_verano_tratamientos_uk2',
    ], 'el sufijo de idioma sale de config, no del código');

    for (const r of reqs) {
        assert.strictEqual(r.body.type, 'template');
        assert.ok(!('components' in r.body.template),
            'plantilla sin variables: mandar components la haría rechazar (132000)');
        assert.strictEqual(r.body.template.language.code, r.body.template.name.includes('_en') ? 'en'
            : r.body.template.name.includes('_ru') ? 'ru'
            : r.body.template.name.includes('_uk') ? 'uk' : 'es');
    }
});

test('idioma sin plantilla propia cae a la española', async () => {
    resetState();
    state.config[SANTE_ORG_ID].plantilla_campana = { es: PLANTILLA_CAMPANA.es };
    const { reqs } = await correr(SANTE_ORG_ID, {
        destinatarios: [contacto(1, { language: 'ru' })],
        plantillaClave: 'plantilla_campana',
        campaignKey: 'verano2026',
    });
    assert.strictEqual(reqs[0].body.template.name, 'sante_verano_tratamientos2');
});

// ─── Dentro de ventana → texto libre ─────────────────────────────────────────

test('dentro de ventana: texto libre; fuera: plantilla, en la misma tanda', async () => {
    resetState();
    const dentro = contacto(1, { language: 'es' });
    const fuera = contacto(2, { language: 'ru' });
    state.lastInbound[dentro.telefono] = horasAtras(3);
    state.lastInbound[fuera.telefono] = horasAtras(48);

    const { reqs, resumen } = await correr(SANTE_ORG_ID, {
        destinatarios: [dentro, fuera],
        mensaje: '¡Promo de verano!',
        plantillaClave: 'plantilla_campana',
        campaignKey: 'verano2026',
    });

    assert.strictEqual(resumen.texto_libre, 1);
    assert.strictEqual(resumen.por_plantilla, 1);

    const texto = reqs.find(r => r.body.type === 'text');
    const plantilla = reqs.find(r => r.body.type === 'template');
    assert.strictEqual(texto.body.text.body, '¡Promo de verano!');
    assert.strictEqual(texto.body.to, dentro.telefono.replace(/\D/g, ''));
    assert.strictEqual(plantilla.body.template.name, 'sante_verano_tratamientos_ru2');
});

test('dentro de ventana pero sin mensaje: recibe la plantilla, no se la omite', async () => {
    resetState();
    const dentro = contacto(1, { language: 'en' });
    state.lastInbound[dentro.telefono] = horasAtras(1);

    const { reqs, resumen } = await correr(SANTE_ORG_ID, {
        destinatarios: [dentro],
        plantillaClave: 'plantilla_campana',
        campaignKey: 'verano2026',
    });
    assert.strictEqual(resumen.omitidos, 0);
    assert.strictEqual(reqs[0].body.template.name, 'sante_verano_tratamientos_en2');
});

// ─── Sin plantilla configurada → omitido y avisado, cero HTTP ────────────────

test('sin plantilla configurada: omite, avisa y no manda nada', async () => {
    resetState();
    state.config[SANTE_ORG_ID].plantilla_campana = null;

    const { reqs, resumen } = await correr(SANTE_ORG_ID, {
        destinatarios: [contacto(1)],
        plantillaClave: 'plantilla_campana',
        campaignKey: 'verano2026',
    });

    assert.strictEqual(reqs.length, 0, 'ni una petición a Meta');
    assert.strictEqual(resumen.enviados, 0);
    assert.strictEqual(resumen.omitidos, 1);
    assert.ok(state.warns.some(w => w.evento === 'campana_destinatario_omitido'));
    assert.strictEqual(state.sends.length, 0, 'no se reserva a quien no se le puede enviar');
});

// ─── Tandas ──────────────────────────────────────────────────────────────────

test('limit corta la tanda y reporta los restantes', async () => {
    resetState();
    const destinatarios = Array.from({ length: 10 }, (_, i) => contacto(i + 1));

    const { reqs, resumen } = await correr(SANTE_ORG_ID, {
        destinatarios,
        plantillaClave: 'plantilla_campana',
        campaignKey: 'verano2026',
        limit: 4,
    });

    assert.strictEqual(reqs.length, 4);
    assert.strictEqual(resumen.enviados, 4);
    assert.strictEqual(resumen.restantes, 6);
    assert.strictEqual(resumen.total_audiencia, 10);
});

test('la segunda tanda NO reenvía a quien ya recibió', async () => {
    resetState();
    const destinatarios = Array.from({ length: 10 }, (_, i) => contacto(i + 1));
    const comun = {
        destinatarios,
        plantillaClave: 'plantilla_campana',
        campaignKey: 'verano2026',
        limit: 4,
    };

    const primera = await correr(SANTE_ORG_ID, comun);
    const segunda = await correr(SANTE_ORG_ID, comun);

    const tel = r => r.body.to;
    const enPrimera = new Set(primera.reqs.map(tel));
    const enSegunda = segunda.reqs.map(tel);

    assert.strictEqual(segunda.resumen.enviados, 4);
    assert.strictEqual(segunda.resumen.restantes, 2);
    assert.ok(enSegunda.every(t => !enPrimera.has(t)), 'ningún teléfono repetido entre tandas');

    const tercera = await correr(SANTE_ORG_ID, comun);
    assert.strictEqual(tercera.resumen.enviados, 2, 'la última tanda solo tiene 2');
    assert.strictEqual(tercera.resumen.restantes, 0);

    const cuarta = await correr(SANTE_ORG_ID, comun);
    assert.strictEqual(cuarta.resumen.enviados, 0, 'campaña agotada: no reenvía a nadie');
    assert.strictEqual(cuarta.reqs.length, 0);
});

test('un fallo de envío se reintenta en la tanda siguiente', async () => {
    resetState();
    const destinatarios = [contacto(1), contacto(2)];

    // Primera pasada: el segundo envío revienta.
    const original = global.fetch;
    let n = 0;
    global.fetch = async (_url, o) => {
        n++;
        if (n === 2) return { ok: false, status: 500, text: async () => 'boom' };
        return { ok: true, json: async () => ({}) };
    };
    let primera;
    try {
        primera = await runBroadcast(SANTE_ORG_ID, {
            client: build360Client(SANTE_ORG_ID),
            sendText: async (c, j, t) => c.sendMessage(j, t),
            destinatarios,
            plantillaClave: 'plantilla_campana',
            campaignKey: 'verano2026',
            concurrencia: 1,
        });
    } finally { global.fetch = original; }

    assert.strictEqual(primera.enviados, 1);
    assert.strictEqual(primera.omitidos, 1);
    assert.ok(state.sends.some(s => s.status === 'failed'), 'el fallo queda registrado');

    const { resumen } = await correr(SANTE_ORG_ID, {
        destinatarios,
        plantillaClave: 'plantilla_campana',
        campaignKey: 'verano2026',
    });
    assert.strictEqual(resumen.enviados, 1, 'reintenta solo al que falló');
});

// ─── Tope de 24 h ────────────────────────────────────────────────────────────

test('el tope de 24h recorta la tanda solo, sin que nadie lo recuerde', async () => {
    resetState();
    const destinatarios = Array.from({ length: 20 }, (_, i) => contacto(i + 1));

    const { reqs, resumen } = await correr(SANTE_ORG_ID, {
        destinatarios,
        plantillaClave: 'plantilla_campana',
        campaignKey: 'verano2026',
        maxPor24h: 6,
    });

    assert.strictEqual(reqs.length, 6, 'se corta en el tope aunque no se pidiera limit');
    assert.strictEqual(resumen.recortado_por_tope, true);
    assert.strictEqual(resumen.restantes, 14);

    // Cupo agotado: la siguiente tanda del mismo día no manda nada.
    const segunda = await correr(SANTE_ORG_ID, {
        destinatarios,
        plantillaClave: 'plantilla_campana',
        campaignKey: 'verano2026',
        maxPor24h: 6,
    });
    assert.strictEqual(segunda.reqs.length, 0, 'cupo de 24 h agotado');
    assert.strictEqual(segunda.resumen.cupo_24h_restante, 0);
});

test('el tope cuenta TODAS las campañas de la org, no solo la actual', async () => {
    resetState();
    await correr(SANTE_ORG_ID, {
        destinatarios: [contacto(1), contacto(2), contacto(3)],
        plantillaClave: 'plantilla_campana',
        campaignKey: 'campana_a',
        maxPor24h: 5,
    });
    const { reqs } = await correr(SANTE_ORG_ID, {
        destinatarios: [contacto(4), contacto(5), contacto(6), contacto(7)],
        plantillaClave: 'plantilla_campana',
        campaignKey: 'campana_b',
        maxPor24h: 5,
    });
    assert.strictEqual(reqs.length, 2, 'quedaban 2 de cupo tras la campaña anterior');
});

// ─── San Remo intacto ────────────────────────────────────────────────────────

test('San Remo (wwebjs) sigue mandando texto libre sin tocar broadcast_sends', async () => {
    resetState();
    const enviados = [];
    const fakeWwebjs = {
        async sendMessage(jid, text) { enviados.push({ jid, text }); return { id: 'wweb-1' }; },
        getChatById() { return { sendStateTyping: async () => {} }; },
    };

    const original = global.fetch;
    const reqs = [];
    global.fetch = async (url, o) => { reqs.push({ url, body: JSON.parse(o.body) }); return { ok: true, json: async () => ({}) }; };
    let resumen;
    try {
        resumen = await runBroadcast(SANREMO_ORG_ID, {
            client: fakeWwebjs,
            sendText: async (c, j, t) => c.sendMessage(j, t),
            destinatarios: [contacto(1), contacto(2)],
            mensaje: 'Menú de temporada',
            // sin campaignKey: comportamiento histórico
        });
    } finally { global.fetch = original; }

    assert.strictEqual(reqs.length, 0, 'San Remo no habla por Cloud API');
    assert.strictEqual(enviados.length, 2);
    assert.strictEqual(resumen.texto_libre, 2);
    assert.strictEqual(resumen.por_plantilla, 0);
    assert.strictEqual(state.sends.length, 0, 'sin campaignKey no se registra nada');
});

// ─── JID canónico ────────────────────────────────────────────────────────────

test('usa el wa_jid guardado (p.ej. @lid) en vez de reconstruir el WID', async () => {
    resetState();
    const c = contacto(1, { wa_jid: '123456789012345@lid' });
    const { reqs } = await correr(SANTE_ORG_ID, {
        destinatarios: [c],
        plantillaClave: 'plantilla_campana',
        campaignKey: 'verano2026',
    });
    assert.strictEqual(reqs[0].body.to, '123456789012345');
});

(async () => {
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
    }
})();
