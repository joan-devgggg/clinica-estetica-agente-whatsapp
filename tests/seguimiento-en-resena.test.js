// Camino A: la oferta viaja DENTRO del mensaje de reseña, o no viaja.
//
// Es lo que pidió la dueña ("junto con el enlace de reseña") y no cuesta un WhatsApp: el de
// la reseña ya salía. Pero solo puede engancharse cuando el envío va por TEXTO LIBRE — una
// plantilla de Meta no admite un párrafo de más, y a las 2 h de la cita lo normal es estar
// fuera de la ventana de 24 h. De ahí que exista el worker del día N.
//
// Lo que este fichero vigila de verdad: que San Remo no note nada, y que un fallo de la
// oferta no se lleve por delante la reseña, que es lo que ya funcionaba.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const CATALOGO = require('./fixtures/sante-catalog.json').services;

const AHORA = new Date();
const haceHoras = h => new Date(AHORA.getTime() - h * 36e5).toISOString();

const enviados = [];
const estado = {
    modo: 'free_text',
    orgType: 'salon',
    reglas: null,
    seguimientosPrevios: [],
    claimDevuelve: 'seg-1',
    claimLanza: null,
    marcados: [],
};

const REGLA = {
    key: 'hidratacion', origen: 'Mechas Balayage',
    destino: 'Tratamiento Orgánico|Orising hidratación intensa',
    dias: 18, descuentoPct: 10, activa: true,
};
const CITA = {
    id: 'a1', contact_id: 'c1', service: 'Cabello corto',
    starts_at: haceHoras(4), ends_at: haceHoras(3), status: 'completed',
    contacts: { id: 'c1', full_name: 'Nora', wa_phone: '34600111222', language: 'es', metadata: {} },
};

const dbStub = {
    getAgentConfig: async () => ({
        services: CATALOGO,
        business_info: { googleReviewLink: 'https://g.page/r/XYZ', companyName: 'Sante' },
    }),
    getConfigValue: async (_o, k) => {
        if (k === 'horas_resena') return 2;
        if (k === 'seguimientos') return estado.reglas;
        return null;
    },
    getCompletedAppointmentsForReview: async () => [CITA],
    updateAppointment: async () => { estado.marcados.push('resena'); return true; },
    getSeguimientosDeContactos: async () => estado.seguimientosPrevios,
    claimSeguimiento: async () => {
        if (estado.claimLanza) throw new Error(estado.claimLanza);
        return estado.claimDevuelve;
    },
    marcarSeguimientoEnviado: async () => { estado.marcados.push('oferta'); return true; },
};

function stub(ruta, exports) {
    const p = require.resolve(ruta);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('../services/db', dbStub);
stub('../services/outbound', {
    resolveOutboundClient: () => cliente,
    resolveAutomatedSend: async () => (
        estado.modo === 'template'
            ? { mode: 'template', template: { name: 'sante_solicitud_resena', language: 'es' } }
            : { mode: estado.modo }
    ),
});
stub('../services/channel-health', { noteSendResult: async () => {} });
stub('../services/admin-alerts', { alertOnce: async () => {} });
stub('../services/org-registry', { getOrgType: () => estado.orgType });

const cliente = {
    sendMessage: async (chatId, texto) => { enviados.push({ tipo: 'texto', texto }); },
    sendTemplate: async (chatId, t) => { enviados.push({ tipo: 'plantilla', params: t.params }); },
};

const review = require('../services/review');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function reset(parches = {}) {
    enviados.length = 0;
    Object.assign(estado, {
        modo: 'free_text', orgType: 'salon', reglas: [REGLA],
        seguimientosPrevios: [], claimDevuelve: 'seg-1', claimLanza: null, marcados: [],
    }, parches);
    review._resetPendientesDeMarcar();
    review.setClients(new Map([['org-sante', { client: cliente }]]));
}

// ─── Lo que se busca ─────────────────────────────────────────────────────────

test('en ventana, la oferta va PEGADA a la reseña: UN solo mensaje', async () => {
    reset();
    await review.checkAndSendReviews();
    assert.strictEqual(enviados.length, 1, `mandó ${enviados.length} mensajes, debería ser 1`);
    const t = enviados[0].texto;
    assert.ok(t.includes('https://g.page/r/XYZ'), 'falta el enlace de reseña');
    assert.ok(t.includes('Orising hidratación intensa'), 'falta el servicio ofrecido');
    assert.ok(t.includes('76,50 €') && t.includes('85 €'), `faltan los euros: ${t}`);
    assert.ok(!t.includes('%'), `enseña el porcentaje: ${t}`);
});

test('se apuntan las DOS cosas, y la reseña primero', async () => {
    reset();
    await review.checkAndSendReviews();
    assert.deepStrictEqual(estado.marcados, ['resena', 'oferta']);
});

// ─── Cuándo NO se engancha ───────────────────────────────────────────────────

test('CRÍTICO · fuera de ventana (plantilla) NO se engancha nada', async () => {
    // Una plantilla de Meta no admite párrafo extra: colarlo ahí sería reservar un descuento
    // que la clienta nunca ve. Le llegará por el worker del día N.
    reset({ modo: 'template' });
    await review.checkAndSendReviews();
    assert.strictEqual(enviados[0].tipo, 'plantilla');
    assert.deepStrictEqual(enviados[0].params, ['Nora', 'https://g.page/r/XYZ']);
    assert.ok(!estado.marcados.includes('oferta'), 'reservó una oferta que no salió');
});

test('sin reglas configuradas, la reseña es la de siempre', async () => {
    reset({ reglas: [] });
    await review.checkAndSendReviews();
    assert.strictEqual(enviados.length, 1);
    assert.ok(!enviados[0].texto.includes('Orising'), enviados[0].texto);
});

test('si la cita no es de la familia de ninguna regla, no se ofrece nada', async () => {
    reset({ reglas: [{ ...REGLA, origen: 'Mechas Airtouch' }] });
    await review.checkAndSendReviews();
    assert.ok(!enviados[0].texto.includes('Orising'), enviados[0].texto);
});

test('si ya se le ofreció por esta cita, no se repite', async () => {
    reset({ seguimientosPrevios: [{ appointment_origen_id: 'a1', regla_key: 'hidratacion#resena', estado: 'pendiente' }] });
    await review.checkAndSendReviews();
    assert.ok(!enviados[0].texto.includes('Orising'), 'ofreció dos veces por la misma cita');
    // Pero la reseña SÍ sale: es lo que estaba pendiente.
    assert.ok(enviados[0].texto.includes('https://g.page/r/XYZ'));
});

// ─── San Remo ────────────────────────────────────────────────────────────────

test('CRÍTICO · San Remo recibe su reseña BYTE POR BYTE igual', async () => {
    // El texto se calcula con la función de siempre y se compara literal: cualquier cosa que
    // se cuele en el camino compartido sale aquí en rojo.
    const esperado = review.buildReviewMessage('Nora', 'Sante', 'https://g.page/r/XYZ', 'es');
    reset({ orgType: 'restaurant' });
    await review.checkAndSendReviews();
    assert.strictEqual(enviados[0].texto, esperado);
    assert.ok(!estado.marcados.includes('oferta'));
});

// ─── Lo accesorio no puede tumbar lo que ya funcionaba ───────────────────────

test('CRÍTICO · si la oferta revienta, la reseña sale igual', async () => {
    reset({ claimLanza: 'la tabla seguimientos no existe' });
    await review.checkAndSendReviews();
    assert.strictEqual(enviados.length, 1);
    assert.ok(enviados[0].texto.includes('https://g.page/r/XYZ'), 'se perdió la reseña');
    assert.ok(!enviados[0].texto.includes('Orising'));
    assert.ok(estado.marcados.includes('resena'), 'no se apuntó la reseña');
});

test('si la reserva la gana otro, la reseña sale sola', async () => {
    reset({ claimDevuelve: null });
    await review.checkAndSendReviews();
    assert.strictEqual(enviados.length, 1);
    assert.ok(!enviados[0].texto.includes('Orising'));
    assert.ok(estado.marcados.includes('resena'));
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
