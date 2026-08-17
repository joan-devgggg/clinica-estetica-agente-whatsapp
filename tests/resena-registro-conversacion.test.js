// La petición de reseña deja su nota en el buzón de pending-outbound: cuando la clienta
// conteste («gracias» / «¿dónde la dejo?»), el turno siguiente drena la nota al historial
// y el bot sabe a qué contesta. Es el arreglo del recordatorio (a741fd5, H1) aplicado al
// segundo worker que escribe sin conversación viva. Sin la nota, el bot contestaba a
// ciegas — la misma ceguera de Barbora, con la reseña en vez del recordatorio.
//
// Visto fallar sin el arreglo (17/08/2026): review.js sin la llamada a
// notePendingOutboundTurn pone en rojo el test 1 («la nota no está en el buzón»).
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');

const estado = {
    orgType: 'salon',
    modoEnvio: 'texto',
    envioLanza: null,
    enviado: null,
};

function stub(ruta, exports) {
    const p = require.resolve(ruta);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
const APT = {
    id: 'apt-1',
    contacts: { wa_phone: '34600111222', full_name: 'Nora', language: 'es', metadata: {} },
};
stub('../services/db', {
    getAgentConfig: async () => ({ business_info: { googleReviewLink: 'https://g.page/r/sante', companyName: 'Sante' } }),
    getConfigValue: async (_o, k) => (k === 'horas_resena' ? 2 : null),
    getCompletedAppointmentsForReview: async () => [APT],
    updateAppointment: async () => ({ id: 'apt-1' }),
});
stub('../services/outbound', {
    resolveOutboundClient: () => null,
    resolveAutomatedSend: async () => (
        estado.modoEnvio === 'template'
            ? { mode: 'template', template: { name: 'sante_solicitud_resena', language: 'es' } }
            : { mode: 'texto' }
    ),
});
stub('../services/channel-health', { noteSendResult: async () => {} });
stub('../services/admin-alerts', { alertOnce: async () => {} });
stub('../services/org-registry', { getOrgType: () => estado.orgType, SANTE_ORG_ID: 'org-sante' });
stub('../services/seguimiento', { prepararOfertaTrasResena: async () => null, confirmarOfertaTrasResena: async () => {} });

const review = require('../services/review');
const po = require('../services/pending-outbound');

const clienteFalso = {
    sendMessage: async (chatId, texto) => {
        if (estado.envioLanza) throw new Error(estado.envioLanza);
        estado.enviado = { chatId, texto };
    },
    sendTemplate: async (chatId, t) => {
        if (estado.envioLanza) throw new Error(estado.envioLanza);
        estado.enviado = { chatId, template: t };
    },
};

function reset(parches = {}) {
    po._resetPendingOutbound();
    Object.assign(estado, { orgType: 'salon', modoEnvio: 'texto', envioLanza: null, enviado: null }, parches);
}

let fallos = 0;
async function test(nombre, fn) {
    try { await fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`fail - ${nombre}\n   ${e.message}`); }
}

(async () => {
    await test('el envío de la reseña deja su nota en el buzón, con el texto EXACTO que salió', async () => {
        reset();
        const r = await review.sendReviewForAppointment('org-sante', 'apt-1', { client: clienteFalso });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        const turnos = po.drainPendingOutboundTurns('org-sante', '34600111222', 60000);
        assert.strictEqual(turnos.length, 1, 'la nota de la reseña no está en el buzón');
        assert.strictEqual(turnos[0].role, 'assistant');
        assert.strictEqual(turnos[0].content, estado.enviado.texto, 'la nota tiene que ser lo que salió, byte a byte');
        assert.ok(!/^\[/.test(turnos[0].content), 'sin prefijo técnico: despistaría al modelo');
    });

    await test('en modo plantilla la nota lleva el texto libre equivalente (el mismo criterio que el recordatorio)', async () => {
        reset({ modoEnvio: 'template' });
        const r = await review.sendReviewForAppointment('org-sante', 'apt-1', { client: clienteFalso });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        const turnos = po.drainPendingOutboundTurns('org-sante', '34600111222', 60000);
        assert.strictEqual(turnos.length, 1);
        assert.ok(/Nora/.test(turnos[0].content) && /g\.page/.test(turnos[0].content),
            `la nota no es el texto libre de la reseña: ${turnos[0].content}`);
    });

    await test('CONTROL San Remo: mismo envío, ninguna nota (regla de oro)', async () => {
        reset({ orgType: 'restaurant' });
        const r = await review.sendReviewForAppointment('org-sante', 'apt-1', { client: clienteFalso });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.strictEqual(po.drainPendingOutboundTurns('org-sante', '34600111222', 60000).length, 0,
            'San Remo no anota: su historial no cambia ni un byte');
    });

    await test('CONTROL honestidad: si el envío revienta, no queda nota (no se anota lo que no salió)', async () => {
        reset({ envioLanza: 'canal caído' });
        const r = await review.sendReviewForAppointment('org-sante', 'apt-1', { client: clienteFalso });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(po.drainPendingOutboundTurns('org-sante', '34600111222', 60000).length, 0,
            'quedó nota de un mensaje que nunca salió');
    });

    if (fallos) { console.error(`\n${fallos} tests en rojo`); process.exit(1); }
    console.log('\nTODO OK');
})();
