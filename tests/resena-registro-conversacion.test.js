// La petición de reseña deja rastro en los DOS sitios que la ven, igual que el
// recordatorio (registrarRecordatorioEnviado, a741fd5 · H1):
//
//   · `messages`, que es el PANEL. Auditoría del 20/08/2026: 60 reseñas marcadas
//     `resena_enviada` desde el 01/08 y CERO filas en `messages` — ni una en toda la
//     historia de la tabla. Se enviaron de verdad, así que eran 60 WhatsApps que la
//     clienta recibió y que no existían para quien abría su ficha.
//   · el buzón de pending-outbound, para que el turno siguiente lo drene al historial y
//     el bot no conteste a ciegas a un «gracias» / «¿dónde la dejo?». Esta mitad ya
//     estaba desde el 17/08.
//
// Visto fallar sin el arreglo (cp previo, 20/08/2026), dos sabotajes MEDIDOS:
//   · quitar la llamada a registrarResenaEnviada → 5 bloques en rojo (las dos mitades);
//   · dejar la llamada y quitar solo el `saveMessage` de dentro → 3 bloques en rojo,
//     todos de `messages`, y ninguno de la nota. Es lo que demuestra que las dos mitades
//     se prueban por separado: con una sola de las dos, el sabotaje que faltaba no se ve.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');

const estado = {
    orgType: 'salon',
    modoEnvio: 'texto',
    envioLanza: null,
    enviado: null,
    guardados: [],
    saveLanza: null,
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
    saveMessage: async (orgId, msg) => {
        if (estado.saveLanza) throw new Error(estado.saveLanza);
        estado.guardados.push({ orgId, ...msg });
        return 1;
    },
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

// El logger se envuelve, no se sustituye: solo hace falta capturar los `error` para poder
// afirmar que un fallo de registro NO es silencioso.
const loggerPath = require.resolve('../lib/logger');
const loggerReal = require(loggerPath);
require.cache[loggerPath].exports = {
    ...loggerReal,
    info: () => {}, warn: () => {},
    error: (evento, datos) => { estado.errores.push({ evento, datos }); },
};
estado.errores = [];

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
    Object.assign(estado, {
        orgType: 'salon', modoEnvio: 'texto', envioLanza: null, enviado: null,
        guardados: [], saveLanza: null, errores: [],
    }, parches);
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

    // ── El PANEL: `messages`. Las 60 que no existían (auditoría 20/08/2026) ────────────

    await test('texto libre: el saliente queda en messages con el LITERAL que salió', async () => {
        reset();
        const r = await review.sendReviewForAppointment('org-sante', 'apt-1', { client: clienteFalso });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.strictEqual(estado.guardados.length, 1, 'la petición de reseña no se escribió en messages');
        assert.strictEqual(estado.guardados[0].direccion, 'saliente');
        assert.strictEqual(estado.guardados[0].telefono, '34600111222');
        assert.strictEqual(estado.guardados[0].contenido, estado.enviado.texto,
            'texto libre: se guarda EL LITERAL enviado, como en el recordatorio');
    });

    await test('plantilla: messages lleva el prefijo [plantilla …] y la nota NO (mismo formato que el recordatorio)', async () => {
        reset({ modoEnvio: 'template' });
        const r = await review.sendReviewForAppointment('org-sante', 'apt-1', { client: clienteFalso });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.strictEqual(estado.guardados.length, 1);
        assert.ok(estado.guardados[0].contenido.startsWith('[plantilla sante_solicitud_resena] '),
            `no afirmamos los bytes de Meta: ${estado.guardados[0].contenido}`);
        const turnos = po.drainPendingOutboundTurns('org-sante', '34600111222', 60000);
        assert.ok(!turnos[0].content.startsWith('[plantilla'),
            'al historial del modelo va el contenido a secas: el prefijo es para el panel');
    });

    await test('CONTROL San Remo: mismo envío, nada en messages (regla de oro)', async () => {
        reset({ orgType: 'restaurant' });
        const r = await review.sendReviewForAppointment('org-sante', 'apt-1', { client: clienteFalso });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.strictEqual(estado.guardados.length, 0, 'su panel no cambia ni un byte');
    });

    await test('CONTROL honestidad: si el envío revienta, tampoco se escribe en messages', async () => {
        reset({ envioLanza: 'canal caído' });
        const r = await review.sendReviewForAppointment('org-sante', 'apt-1', { client: clienteFalso });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(estado.guardados.length, 0,
            'quedó en el panel un mensaje que nunca salió');
    });

    await test('si messages está caída, la reseña sigue contando como ENVIADA — y el fallo se loguea', async () => {
        reset({ saveLanza: 'messages caída' });
        const r = await review.sendReviewForAppointment('org-sante', 'apt-1', { client: clienteFalso });
        assert.strictEqual(r.ok, true, 'desmarcar sería reenviarle la reseña dentro de 5 minutos');
        assert.strictEqual(estado.guardados.length, 0);
        assert.ok(estado.errores.some(x => x.evento === 'resena_registro_mensaje_fallido'),
            'y no es silencioso: queda logueado');
        assert.strictEqual(po.drainPendingOutboundTurns('org-sante', '34600111222', 60000).length, 1,
            'el fallo de una mitad no puede llevarse la otra: la nota del buzón sigue');
    });

    if (fallos) { console.error(`\n${fallos} tests en rojo`); process.exit(1); }
    console.log('\nTODO OK');
})();
