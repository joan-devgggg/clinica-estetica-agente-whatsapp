// El worker: apagado por defecto, y cuando envía lo hace en el orden que no se puede alterar.
//
// RESERVAR → ENVIAR → APUNTAR. Los tres pasos y su orden son toda la protección contra el
// único fallo que aquí no tiene vuelta atrás: que la misma clienta reciba el mismo mensaje
// dos veces. Reservar después de enviar deja un hueco por el que cabe un segundo tic.
process.env.TZ = 'Europe/Madrid';
process.env.SANTE_360_API_KEY = 'test-key-360';
process.env.SANTE_360_PHONE_NUMBER_ID = '111222333';

const assert = require('assert');
const CATALOGO = require('./fixtures/sante-catalog.json');

const AHORA = new Date();
const haceDias = n => new Date(AHORA.getTime() - n * 864e5).toISOString();

// ─── Stubs ───────────────────────────────────────────────────────────────────

const pasos = [];          // la traza del orden real
const estado = {
    claimDevuelve: 'seg-1',
    modoEnvio: 'texto',    // 'texto' | 'template' | 'sin_plantilla'
    envioLanza: null,
    orgType: 'salon',
};

const dbStub = {
    getAgentConfig: async () => ({ services: CATALOGO }),
    getConfigValue: async (_o, k) => (k === 'seguimientos' ? [REGLA] : k === 'bot_activo' ? true : null),
    getCitasParaSeguimiento: async () => [CITA],
    getCitasDeContactosDesde: async () => [{ id: 'a1', contact_id: 'c1', service: 'Cabello corto', starts_at: haceDias(18), status: 'completed' }],
    getContactIdsConAccionPendiente: async () => new Set(),
    getSeguimientosDeContactos: async () => [],
    liberarSeguimientosFallidos: async () => { pasos.push('liberar_fallidos'); return 0; },
    getSeguimientosPendientesAntiguos: async () => [],
    claimSeguimiento: async (_o, d) => { pasos.push('claim'); estado.ultimoClaim = d; return estado.claimDevuelve; },
    marcarSeguimientoEnviado: async (_o, id, { mensaje }) => { pasos.push('marcar_enviado'); estado.mensajeApuntado = mensaje; return true; },
    marcarSeguimientoFallido: async (_o, id, motivo) => { pasos.push(`marcar_fallido:${motivo}`); return true; },
};

const outboundStub = {
    resolveOutboundClient: () => ({
        sendMessage: async (chatId, texto) => {
            pasos.push('enviar_texto');
            estado.enviado = { chatId, texto };
            if (estado.envioLanza) throw new Error(estado.envioLanza);
        },
        sendTemplate: async (chatId, t) => {
            pasos.push('enviar_plantilla');
            estado.enviado = { chatId, template: t };
            if (estado.envioLanza) throw new Error(estado.envioLanza);
        },
    }),
    resolveAutomatedSend: async () => (
        estado.modoEnvio === 'sin_plantilla' ? { mode: 'sin_plantilla' }
            : estado.modoEnvio === 'template' ? { mode: 'template', template: { name: 'sante_seguimiento', language: 'es' } }
                : { mode: 'texto' }
    ),
};

function stub(ruta, exports) {
    const p = require.resolve(ruta);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('../services/db', dbStub);
stub('../services/outbound', outboundStub);
stub('../services/channel-health', { noteSendResult: async () => {} });
stub('../services/admin-alerts', { alertOnce: async () => {} });
stub('../services/org-registry', { getOrgType: () => estado.orgType, SANTE_ORG_ID: 'org-sante' });

const seguimiento = require('../services/seguimiento');

const REGLA = {
    key: 'hidratacion', origen: 'Mechas Balayage',
    destino: 'Tratamiento Orgánico|Orising hidratación intensa',
    dias: 18, descuentoPct: 10, activa: true,
};
const CONTACTO = {
    id: 'c1', full_name: 'Nora', wa_phone: '34600111222', language: 'es',
    metadata: {}, is_blacklisted: false, escalation_reason: null, bot_mode: 'auto',
};
const CITA = {
    id: 'a1', contact_id: 'c1', service: 'Cabello corto',
    starts_at: haceDias(18), ends_at: haceDias(18), status: 'completed', contacts: CONTACTO,
};

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function reset(parches = {}) {
    pasos.length = 0;
    Object.assign(estado, {
        claimDevuelve: 'seg-1', modoEnvio: 'texto', envioLanza: null, orgType: 'salon',
        enviado: null, mensajeApuntado: null, ultimoClaim: null,
    }, parches);
    seguimiento.setClients(new Map([['org-sante', { client: {} }]]));
}

// ─── El interruptor ──────────────────────────────────────────────────────────

test('APAGADO por defecto: calcula, registra y NO envía', async () => {
    delete process.env.SEGUIMIENTOS;
    reset();
    assert.strictEqual(seguimiento.seguimientosEncendidos(), false);
    await seguimiento.procesarSeguimientos();
    assert.ok(!pasos.includes('claim'), 'no debería reservar nada');
    assert.ok(!pasos.includes('enviar_texto'), 'no debería enviar nada');
});

test('un valor que no es exactamente "on" NO enciende', async () => {
    for (const v of ['1', 'true', 'sí', 'ON ', 'yes', '']) {
        process.env.SEGUIMIENTOS = v;
        assert.strictEqual(seguimiento.seguimientosEncendidos(), false, `"${v}" no debería encender`);
    }
    process.env.SEGUIMIENTOS = 'on';
    assert.strictEqual(seguimiento.seguimientosEncendidos(), true);
    process.env.SEGUIMIENTOS = 'ON';
    assert.strictEqual(seguimiento.seguimientosEncendidos(), true);
    delete process.env.SEGUIMIENTOS;
});

// ─── El orden ────────────────────────────────────────────────────────────────

test('CRÍTICO · el orden es reservar → enviar → apuntar', async () => {
    process.env.SEGUIMIENTOS = 'on';
    reset();
    await seguimiento.procesarSeguimientos();
    const i = p => pasos.indexOf(p);
    assert.ok(i('claim') >= 0, `no reservó: ${pasos}`);
    assert.ok(i('enviar_texto') > i('claim'), `envió antes de reservar: ${pasos}`);
    assert.ok(i('marcar_enviado') > i('enviar_texto'), `apuntó antes de enviar: ${pasos}`);
});

test('si la reserva la gana otro, NO se envía', async () => {
    process.env.SEGUIMIENTOS = 'on';
    reset({ claimDevuelve: null });
    await seguimiento.procesarSeguimientos();
    assert.ok(pasos.includes('claim'));
    assert.ok(!pasos.includes('enviar_texto'), `envió pese a perder la reserva: ${pasos}`);
    assert.ok(!pasos.includes('marcar_enviado'));
});

test('lo que se apunta es el texto EXACTO que salió', async () => {
    process.env.SEGUIMIENTOS = 'on';
    reset();
    await seguimiento.procesarSeguimientos();
    assert.strictEqual(estado.mensajeApuntado, estado.enviado.texto);
    assert.ok(estado.enviado.texto.includes('76,50 €'), estado.enviado.texto);
    assert.ok(estado.enviado.texto.includes('85 €'), estado.enviado.texto);
    assert.ok(!estado.enviado.texto.includes('%'), estado.enviado.texto);
});

test('la reserva congela el precio con descuento, no solo el porcentaje', async () => {
    process.env.SEGUIMIENTOS = 'on';
    reset();
    await seguimiento.procesarSeguimientos();
    const c = estado.ultimoClaim;
    assert.strictEqual(c.destinoPrecio, 85);
    assert.strictEqual(c.precioConDescuento, 76.5);
    assert.strictEqual(c.descuentoPct, 10);
    assert.strictEqual(c.destinoKey, 'Tratamiento Orgánico|Orising hidratación intensa');
    assert.strictEqual(c.via, 'seguimiento_dias');
    // Y la promesa caduca: sin fecha, un -10 % de hace ocho meses reaparece en el mostrador.
    assert.ok(c.caducaAt > new Date().toISOString(), 'caduca_at tiene que ser futura');
});

// ─── Fuera de ventana de 24 h ────────────────────────────────────────────────

test('sin plantilla aprobada NO se manda, y la reserva se libera para reintentar', async () => {
    process.env.SEGUIMIENTOS = 'on';
    reset({ modoEnvio: 'sin_plantilla' });
    await seguimiento.procesarSeguimientos();
    assert.ok(!pasos.includes('enviar_texto'));
    assert.ok(pasos.includes('marcar_fallido:sin_plantilla_configurada'), pasos.join(' '));
});

test('con plantilla, el texto viaja como parámetro {{2}}', async () => {
    process.env.SEGUIMIENTOS = 'on';
    reset({ modoEnvio: 'template' });
    await seguimiento.procesarSeguimientos();
    assert.ok(pasos.includes('enviar_plantilla'));
    const [p1, p2] = estado.enviado.template.params;
    assert.strictEqual(p1, 'Nora');
    assert.ok(p2.includes('76,50 €'), p2);
});

// ─── El fallo que no se puede reintentar a ciegas ────────────────────────────

test('CRÍTICO · si el envío revienta, la fila NO se marca fallida', async () => {
    // Marcarla fallida la devolvería a la cola, y si el error saltó DESPUÉS de que Meta
    // aceptara el mensaje, la clienta lo recibiría dos veces. Se queda en 'pendiente' —que
    // bloquea el reintento— y el vigilante de claims atascados lo saca a la luz.
    process.env.SEGUIMIENTOS = 'on';
    reset({ envioLanza: 'timeout de red' });
    await seguimiento.procesarSeguimientos();
    assert.ok(pasos.includes('enviar_texto'));
    assert.ok(!pasos.some(p => p.startsWith('marcar_fallido')), `marcó fallido: ${pasos}`);
    assert.ok(!pasos.includes('marcar_enviado'));
});

// ─── San Remo ────────────────────────────────────────────────────────────────

test('San Remo no entra: el gate es por tipo de org, no por config vacía', async () => {
    process.env.SEGUIMIENTOS = 'on';
    reset({ orgType: 'restaurant' });
    await seguimiento.procesarSeguimientos();
    assert.deepStrictEqual(pasos, [], `tocó algo de San Remo: ${pasos}`);
});

// ─── El tope ─────────────────────────────────────────────────────────────────

test('el tope por tic corta la tanda', async () => {
    process.env.SEGUIMIENTOS = 'on';
    process.env.SEGUIMIENTOS_LIMITE = '1';
    reset();
    // Tres citas de tres clientas distintas, todas candidatas.
    const tres = ['c1', 'c2', 'c3'].map((cid, i) => ({
        ...CITA, id: `a${i}`, contact_id: cid,
        contacts: { ...CONTACTO, id: cid, wa_phone: `3460011122${i}` },
    }));
    const orig = dbStub.getCitasParaSeguimiento;
    dbStub.getCitasParaSeguimiento = async () => tres;
    dbStub.getCitasDeContactosDesde = async () => [];
    await seguimiento.procesarSeguimientos();
    dbStub.getCitasParaSeguimiento = orig;
    delete process.env.SEGUIMIENTOS_LIMITE;
    assert.strictEqual(pasos.filter(p => p === 'enviar_texto').length, 1, `envió de más: ${pasos}`);
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { fallos++; console.error(`FALLO - ${name}\n   ${e.message}`); }
    }
    delete process.env.SEGUIMIENTOS;
    console.log(fallos ? `\n❌ ${fallos} fallo(s)` : `\n✅ ${tests.length} en verde`);
    process.exit(fallos ? 1 : 0);
})();
