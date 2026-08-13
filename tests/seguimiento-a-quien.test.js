// A quién se le manda un seguimiento, y —sobre todo— a quién NO.
//
// Este fichero es la mitad seria del asunto. La otra mitad (atar la regla al catálogo) ya
// está en seguimiento-post-visita.test.js; aquí se prueba la decisión de ENVIAR, que es la
// que acaba en el teléfono de una clienta.
//
// Las tres primeras exclusiones son las mismas que ya aplica
// `getCompletedAppointmentsForReview` y se copian a propósito: ese camino ya resolvió este
// problema y tener dos criterios distintos para "a quién no se le escribe" es cómo se
// acaba mandando una campaña a alguien que puso una queja.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { decidirSeguimiento, VENTANA_MARGEN_DIAS, MIN_DIAS_ENTRE_ENVIOS } = require('../services/seguimiento');
const { resolveSeguimientoRegla } = require('../services/helpers');

const CATALOGO = require('./fixtures/sante-catalog.json').services;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const AHORA = new Date('2026-08-13T12:00:00+02:00');
const haceDias = n => new Date(AHORA.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
const enDias   = n => new Date(AHORA.getTime() + n * 24 * 60 * 60 * 1000).toISOString();

const REGLA = resolveSeguimientoRegla({
    key: 'hidratacion_post_color',
    origen: 'Mechas Balayage',
    destino: 'Tratamiento Orgánico|Orising hidratación intensa',
    dias: 18,
    descuentoPct: 10,
    activa: true,
}, CATALOGO);

// Una candidata de manual: Balayage hace 18 días, todo en orden.
function caso(parches = {}) {
    return {
        cita: { id: 'a1', service: 'Cabello corto', ends_at: haceDias(18), status: 'completed' },
        contacto: {
            id: 'c1', telefono: '34600111222', nombre: 'Nora', language: 'en',
            is_blacklisted: false, escalation_reason: null, bot_mode: 'auto',
        },
        reglaResuelta: REGLA,
        catalogo: CATALOGO,
        ahora: AHORA,
        citasFuturas: [],
        serviciosPosteriores: [],
        yaEnviado: false,
        ultimoEnvioAt: null,
        tieneAccionPendiente: false,
        botActivo: true,
        ...parches,
    };
}

const motivoDe = parches => decidirSeguimiento(caso(parches)).motivo;

// ─── El caso que SÍ sale ─────────────────────────────────────────────────────

test('la candidata de manual se envía', () => {
    const d = decidirSeguimiento(caso());
    assert.strictEqual(d.envia, true, `no envía por: ${d.motivo}`);
    assert.strictEqual(d.motivo, 'ok');
    assert.strictEqual(d.diasTranscurridos, 18);
});

// ─── Ya volvió: las dos formas ───────────────────────────────────────────────

test('YA VOLVIÓ · con una cita futura no se le ofrece nada', () => {
    assert.strictEqual(motivoDe({ citasFuturas: [{ id: 'f1', starts_at: enDias(3) }] }), 'tiene_cita_futura');
});

test('YA VOLVIÓ · una cita futura CANCELADA no cuenta como haber vuelto', () => {
    // Quien filtra las canceladas es la consulta; si un día se le olvidara, esto lo dice:
    // una cita cancelada es justo la clienta a la que sí hay que escribirle.
    assert.strictEqual(motivoDe({ citasFuturas: [] }), 'ok');
});

test('YA VOLVIÓ · si ya se hizo el servicio que le íbamos a ofrecer, tampoco', () => {
    assert.strictEqual(
        motivoDe({ serviciosPosteriores: ['Orising hidratación intensa'] }),
        'ya_se_lo_hizo',
    );
});

test('el "ya se lo hizo" se mide contra el CATÁLOGO, no contra el texto', () => {
    // Se lo hizo dentro de una cita con dos servicios: el nombre no está suelto.
    assert.strictEqual(
        motivoDe({ serviciosPosteriores: ['Corte mujer y secado + Orising hidratación intensa'] }),
        'ya_se_lo_hizo',
    );
    // Y un servicio parecido pero DISTINTO no cuenta: "Fresh Hidratación" no es el que se
    // le ofreció, así que la oferta sigue en pie.
    assert.strictEqual(motivoDe({ serviciosPosteriores: ['Fresh Hidratación'] }), 'ok');
});

// ─── Lista negra, escaladas y quien está siendo atendido ─────────────────────

test('lista negra: silencio, como en todo lo demás', () => {
    assert.strictEqual(motivoDe({ contacto: { ...caso().contacto, is_blacklisted: true } }), 'lista_negra');
});

test('escalada sin resolver: no se mete una oferta encima de algo abierto', () => {
    assert.strictEqual(
        motivoDe({ contacto: { ...caso().contacto, escalation_reason: 'queja' } }),
        'escalada_abierta',
    );
});

test('acción pendiente en el panel: igual', () => {
    assert.strictEqual(motivoDe({ tieneAccionPendiente: true }), 'accion_pendiente');
});

test('bot en manual: lleva la conversación una persona, no se le inyecta comercial', () => {
    assert.strictEqual(motivoDe({ contacto: { ...caso().contacto, bot_mode: 'manual' } }), 'bot_en_manual');
});

test('bot apagado en la org: le ofreceríamos algo que nadie podría contestarle', () => {
    // A diferencia de la reseña, esto ESPERA respuesta. Un enlace de reseña con el bot
    // apagado sigue sirviendo; una pregunta, no.
    assert.strictEqual(motivoDe({ botActivo: false }), 'bot_apagado');
});

test('teléfono inservible: no se intenta', () => {
    assert.strictEqual(motivoDe({ contacto: { ...caso().contacto, telefono: '' } }), 'telefono_inservible');
    assert.strictEqual(motivoDe({ contacto: { ...caso().contacto, telefono: '123' } }), 'telefono_inservible');
});

// ─── La ventana: ni antes de tiempo ni al cabo de los meses ──────────────────

test('antes del día N no toca', () => {
    assert.strictEqual(motivoDe({ cita: { ...caso().cita, ends_at: haceDias(17) } }), 'no_toca_aun');
});

test('el día N justo, sí', () => {
    assert.strictEqual(motivoDe({ cita: { ...caso().cita, ends_at: haceDias(18) } }), 'ok');
});

test('CRÍTICO · pasada la ventana NO se envía, aunque nunca se le enviara', () => {
    // Sin este tope, encender el interruptor mandaría de golpe un WhatsApp por cada cita
    // histórica que cumpla la regla. Es la forma que tendría este worker de repetir el
    // incidente del `horas_recordatorio` a NaN, que mandó el recordatorio de TODAS las citas
    // futuras de una vez.
    assert.strictEqual(motivoDe({ cita: { ...caso().cita, ends_at: haceDias(18 + VENTANA_MARGEN_DIAS + 1) } }), 'ventana_pasada');
    assert.strictEqual(motivoDe({ cita: { ...caso().cita, ends_at: haceDias(200) } }), 'ventana_pasada');
    // El último día de la ventana todavía entra.
    assert.strictEqual(motivoDe({ cita: { ...caso().cita, ends_at: haceDias(18 + VENTANA_MARGEN_DIAS) } }), 'ok');
});

test('una fecha ilegible no se envía y se dice — no se cuenta como "hoy"', () => {
    // `new Date('lo que sea')` es Invalid Date y toda comparación con él es false: sin esta
    // guarda, una cita con fecha rota caería por el lado de "sí, envía".
    assert.strictEqual(motivoDe({ cita: { ...caso().cita, ends_at: 'martes que viene' } }), 'fecha_ilegible');
    assert.strictEqual(motivoDe({ cita: { ...caso().cita, ends_at: null } }), 'fecha_ilegible');
});

// ─── No repetir, y no atosigar ───────────────────────────────────────────────

test('lo ya enviado no se reenvía', () => {
    assert.strictEqual(motivoDe({ yaEnviado: true }), 'ya_enviado');
});

test('CRÍTICO · dos reglas seguidas no le mandan dos WhatsApps casi seguidos', () => {
    // Una cita puede disparar hidratación (18 d) y matiz (28 d). Diez días de separación
    // están bien; dos reglas mal puestas a 19 y 20 días serían dos mensajes en 24 h.
    assert.strictEqual(motivoDe({ ultimoEnvioAt: haceDias(1) }), 'demasiado_reciente');
    assert.strictEqual(motivoDe({ ultimoEnvioAt: haceDias(MIN_DIAS_ENTRE_ENVIOS - 1) }), 'demasiado_reciente');
    assert.strictEqual(motivoDe({ ultimoEnvioAt: haceDias(MIN_DIAS_ENTRE_ENVIOS) }), 'ok');
});

// ─── La regla misma ──────────────────────────────────────────────────────────

test('una cita que no toca la categoría de origen no dispara', () => {
    assert.strictEqual(motivoDe({ cita: { ...caso().cita, service: 'Corte mujer y secado' } }), 'no_dispara');
});

test('las cuatro familias de mechas disparan su regla, incluida la que no se llama así', () => {
    for (const [servicio, origen] of [
        ['Cabello corto',          'Mechas Balayage'],
        ['Mechas 1',               'Mechas clásicas'],
        ['Mechas Airtouch Corto',  'Mechas Airtouch'],
        ['Deco Total Blond Medio', 'Deco Total Blond'],
    ]) {
        const regla = resolveSeguimientoRegla({
            key: 'k', origen, destino: 'Tratamiento Orgánico|Orising hidratación intensa',
            dias: 18, descuentoPct: 10, activa: true,
        }, CATALOGO);
        const d = decidirSeguimiento(caso({ cita: { ...caso().cita, service: servicio }, reglaResuelta: regla }));
        assert.strictEqual(d.envia, true, `${servicio} → ${origen} no disparó: ${d.motivo}`);
    }
});

test('una regla que no resolvió NO envía nada, pase lo que pase con la clienta', () => {
    const rota = resolveSeguimientoRegla(
        { key: 'k', origen: 'Mechas Balayage', destino: null, sugerencia: 'hidratación', dias: 18, descuentoPct: 10 },
        CATALOGO,
    );
    assert.strictEqual(rota.ok, false);
    const d = decidirSeguimiento(caso({ reglaResuelta: rota }));
    assert.strictEqual(d.envia, false);
    assert.strictEqual(d.motivo, 'regla_no_resuelve');
});

// ─── El orden de las comprobaciones no puede colarse ─────────────────────────

test('con VARIOS motivos a la vez, sigue sin enviar', () => {
    const d = decidirSeguimiento(caso({
        contacto: { ...caso().contacto, is_blacklisted: true, bot_mode: 'manual' },
        citasFuturas: [{ id: 'f1', starts_at: enDias(2) }],
        yaEnviado: true,
    }));
    assert.strictEqual(d.envia, false);
});

test('una entrada vacía no revienta ni envía', () => {
    for (const malo of [undefined, {}, { cita: null }]) {
        const d = decidirSeguimiento(malo);
        assert.strictEqual(d.envia, false, JSON.stringify(malo));
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
