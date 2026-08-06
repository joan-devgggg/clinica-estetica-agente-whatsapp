// Sin servicio resuelto no se escribe una cita. Por ninguno de los tres caminos.
//
// Viene del diagnóstico del escenario 3 (docs/escenario-3-servicio-sin-resolver.md, §2):
// la conclusión de que aquello era "molesto, no cita fantasma" descansa entera en que los
// TRES puntos de entrada a la escritura de una cita de Sante están gateados por
// `session.selectedService` — y el propio diagnóstico termina diciendo que **eso lo
// sostienen tres `if` y ni un solo test**. Esto es ese test.
//
// Por qué importa que no se relaje ninguno: `finalizarCitaSante` NO comprueba el servicio
// por su cuenta. Si una de las tres guardas cayera, el camino existe entero hasta el INSERT
// y lo que se escribiría está medido en el bloque C de aquí abajo.
//
//   ┌ camino ───────────────────────────────┬ guarda ─────────────────────────────────┐
//   │ resolveSalonConfirmation              │ if (!session.selectedService) return null│
//   │ reload dirigido tras "LLM dijo sí"    │ … && session.selectedService             │
//   │ red de seguridad (texto afirma haber  │ session.selectedService && safetySlots…  │
//   │   reservado)                          │                                          │
//   └───────────────────────────────────────┴──────────────────────────────────────────┘
//
// El cuarto camino (`finalizarReservaPendiente`) solo se alcanza desde
// `session.pendingNameForBooking`, que únicamente pone `finalizarCitaSante` — o sea después
// de haber pasado ya por una de las tres. No puede originar nada, y por eso no está aquí.
//
// ── QUÉ AFIRMA CADA BLOQUE, QUE NO ES LO MISMO ──────────────────────────────────────────
// A · CONDUCTA. `resolveSalonConfirmation` está exportado, así que se ejecuta de verdad,
//     con su sesión, y se comprueba además el CONTROL (con servicio sí resuelve) — sin él
//     el bloque pasaría igual con la función devolviendo null siempre.
// B · ESTRUCTURA. Las otras dos guardas viven dentro de `processMessageCore`, que no está
//     exportado y no se puede ejercitar sin LLM ni Supabase. Se leen del fuente y se exige
//     que la condición siga nombrando `selectedService`. Es un cable trampa, no una prueba
//     de conducta: se dice aquí para que nadie lo lea como más de lo que es. Mismo recurso
//     que usa tests/servicio-desactivado.test.js con el cuerpo de stampBillingSnapshot.
// C · LA CONSECUENCIA. Qué se escribiría si una guarda cayera. Es lo que convierte a B en
//     algo que merece la pena vigilar.
//
// Hermético: sin red, sin LLM, sin Supabase.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    buildFullServiceName, resolveAppointmentDurationMin, computeServiceBilling,
} = require('../services/helpers');
const { resolveSalonConfirmation } = require('../bot')._internals;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Recorte del catálogo real de Sante.
const CATALOGO = [
    { nombre: 'Cabello medio', categoria: 'Mechas Balayage', precio: 190, duracion: 240 },
    { nombre: 'Cabello largo', categoria: 'Mechas Balayage', precio: 200, duracion: 240 },
    { nombre: 'Corte mujer', categoria: 'Cortes', precio: 40, duracion: 45 },
];

const SLOT = { fecha: '2026-08-07', hora: '10:00', stylistId: 'sty-1', stylistName: 'Irina' };

// Sesión de una clienta a punto de confirmar: ha visto huecos, el LLM dice que confirma y
// además contesta que sí. Todo lo necesario para reservar MENOS el servicio.
function sesionAPuntoDeConfirmar(over = {}) {
    return {
        orgId: 'org', orgType: 'salon', leadId: 'L1', language: 'es',
        reservaConfirmada: false,
        selectedService: null,          // ← lo único que falta
        selectedStylist: null,
        availableSlots: [SLOT],
        slotsProposed: true,
        currentSlotIndex: 0,
        upsellingAccepted: [],
        partialData: { nombre: 'Ana', telefono: '34600000001' },
        ...over,
    };
}

const AI_CONFIRMA = {
    reserva_confirmada: true,
    respuesta: '¡Perfecto! Te he reservado el viernes 7 a las 10:00 con Irina ✅',
    datos: { fecha_cita: '2026-08-07', hora_cita: '10:00' },
};

// ─── A · CONDUCTA · resolveSalonConfirmation ────────────────────────────────────────────

test('A1 · sin servicio NO resuelve, por mucho que el LLM diga que ha reservado', () => {
    const r = resolveSalonConfirmation(sesionAPuntoDeConfirmar(), AI_CONFIRMA, 'sí, perfecto', [SLOT]);
    assert.strictEqual(r, null, 'esto es lo único que separa "molesto" de "cita fantasma"');
});

test('A2 · CONTROL · con el servicio resuelto SÍ resuelve (el A1 no pasa por vacío)', () => {
    const sesion = sesionAPuntoDeConfirmar({ selectedService: CATALOGO[0] });
    const r = resolveSalonConfirmation(sesion, AI_CONFIRMA, 'sí, perfecto', [SLOT]);
    assert.ok(r && r.slot, 'con servicio tiene que devolver hueco: si no, A1 no demuestra nada');
    assert.strictEqual(r.slot.hora, '10:00');
});

test('A3 · tampoco por la puerta del "slot directo" (sin propuesta previa)', () => {
    // La excepción de slot directo se salta el requisito de haber visto huecos. No se salta
    // el del servicio: la guarda va antes que todo lo demás en la función.
    const sesion = sesionAPuntoDeConfirmar({ slotsProposed: false });
    assert.strictEqual(resolveSalonConfirmation(sesion, AI_CONFIRMA, 'mañana a las 10 con Irina', []), null);

    const conServicio = sesionAPuntoDeConfirmar({ slotsProposed: false, selectedService: CATALOGO[0] });
    const r = resolveSalonConfirmation(conServicio, AI_CONFIRMA, 'mañana a las 10 con Irina', []);
    assert.ok(r && r.motivo === 'slot_directo_sin_propuesta', 'el control del camino directo');
});

test('A4 · ni por afirmación, ni por hora suelta, ni porque el texto del LLM lo cante', () => {
    for (const [caso, ai, texto] of [
        ['afirmativo tras propuesta', { reserva_confirmada: false, respuesta: 'Genial', datos: {} }, 'sí'],
        ['match por hora',            { reserva_confirmada: false, respuesta: 'Vale', datos: { hora_cita: '10:00' } }, 'a las 10'],
        ['el texto afirma reserva',   { reserva_confirmada: false, respuesta: 'Te he reservado el viernes a las 10:00 ✅', datos: {} }, 'ok'],
    ]) {
        assert.strictEqual(
            resolveSalonConfirmation(sesionAPuntoDeConfirmar(), ai, texto, [SLOT]), null,
            `entró por "${caso}" sin servicio resuelto`);
    }
});

// ─── B · ESTRUCTURA · las dos guardas que no se pueden ejercitar ────────────────────────

const BOT_SRC = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');

// Localiza la línea que contiene `ancla` y devuelve esa línea más las `extra` siguientes.
// Se busca por un texto ESTABLE del propio código, no por número de línea: un número se
// desplaza con el primer cambio de arriba y el test empezaría a mirar a otro sitio.
function bloqueTras(ancla, extra = 0) {
    const lineas = BOT_SRC.split('\n');
    const i = lineas.findIndex(l => l.includes(ancla));
    assert.notStrictEqual(i, -1, `ancla desaparecida de bot.js: "${ancla}" — revisa este test, no lo borres`);
    return lineas.slice(i, i + 1 + extra).join('\n');
}

test('B1 · el reload dirigido tras "el LLM dijo confirmada" sigue exigiendo servicio', () => {
    const linea = bloqueTras('} else if (aiResponse.reserva_confirmada && !session.reservaConfirmada');
    assert.ok(/session\.selectedService/.test(linea),
        'esta rama llama a confirmSlotConReverificacion → finalizarCitaSante, que NO comprueba '
        + 'el servicio por su cuenta:\n' + linea);
});

test('B2 · la red de seguridad sigue exigiendo servicio antes de elegir hueco', () => {
    const bloque = bloqueTras('const safetySlots = (frozenProposed && frozenProposed.length)', 2);
    assert.ok(/session\.selectedService\s*&&\s*safetySlots\.length/.test(bloque),
        'sin esa condición, un texto del LLM que diga "te he reservado" basta para escribir '
        + 'la cita:\n' + bloque);
});

test('B3 · los tres loadAvailableSlots del salón siguen gateados (no se proponen horas sin servicio)', () => {
    // Un piso por encima de la escritura: sin servicio no se consulta la agenda, así que no
    // hay huecos que ofrecer y ninguna de las tres guardas de arriba llega a tener candidato.
    const gate1 = bloqueTras('// Cargar huecos solo cuando ya no haya que preguntar estilista NI fecha.', 1);
    assert.ok(/if \(session\.selectedService &&/.test(gate1), gate1);

    const gate2 = bloqueTras('if (!session._slotsQueriedThisTurn && session.selectedService)');
    assert.ok(/session\.selectedService/.test(gate2), gate2);

    // El tercero es la rama de San Remo (restaurante): no tiene ni debe tener servicio.
    // Se afirma para que quede escrito por qué son tres sitios y solo dos guardas.
    const sanRemo = bloqueTras('const tieneBase = !missingFields.includes(\'nombre\')');
    assert.ok(!/selectedService/.test(sanRemo), 'la rama de restaurante no usa selectedService');
});

// ─── C · LA CONSECUENCIA · qué se escribiría si una guarda cayera ───────────────────────

test('C1 · sin servicio, el nombre de la cita sale vacío y acaba en el literal "Cita"', () => {
    const mainServiceName = buildFullServiceName(null, CATALOGO);
    assert.strictEqual(mainServiceName, null);

    const allServices = [mainServiceName, ...[]].filter(Boolean).join(' + ');
    assert.strictEqual(allServices, '');

    // Reproduce bookOpts.servicio de finalizarCitaSante con selectedService a null.
    const servicioQueSeEscribiria = allServices || (null)?.nombre || 'Cita';
    assert.strictEqual(servicioQueSeEscribiria, 'Cita');
    // Matiz sobre docs/escenario-3-servicio-sin-resolver.md §2, que dice 'Reserva': ese es
    // el fallback de db.js (`servicio || 'Reserva'`) y por este camino NO se alcanza, porque
    // bot.js ya manda el literal 'Cita', que es truthy. El daño es el mismo; el nombre no.
});

test('C2 · esa cita ocuparía 60 minutos inventados, y el sistema lo sabe', () => {
    const dur = resolveAppointmentDurationMin(null, CATALOGO);
    assert.strictEqual(dur.resuelto, false, 'al menos no se presenta como resuelta');
    assert.strictEqual(dur.minutos, 60);
    // 60 min de agenda para algo que, si era un balayage, son 240. Las tres horas que
    // sobran se publican como libres encima de esta misma clienta.
});

test('C3 · y no se podría facturar: "Cita" no resuelve contra el catálogo', () => {
    const { segments, totalConIva } = computeServiceBilling('Cita', CATALOGO);
    assert.ok(segments.length > 0);
    assert.ok(segments.some(s => s.status !== 'ok'),
        'si "Cita" resolviera, esta cita fantasma se facturaría como si fuera algo');
    assert.strictEqual(totalConIva, 0);
    // Cae en "sin poder calcular" del informe, que es la degradación buena — pero de una
    // cita que nunca debió existir, ocupando agenda a nombre de una clienta real.
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
