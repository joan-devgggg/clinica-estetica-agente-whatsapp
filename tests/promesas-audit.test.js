// El barrido de promesas (tests/lib/promesas-audit.js): las promesas del bot de clase
// C1 (cita hecha/cancelada) y C7 (traspaso) contra las filas que las respaldan.
//
// Los fixtures son los SEIS casos de validación del plan (14/08/2026), con las frases y
// los tiempos REALES de producción: Tania («te apunto» → cita creada a mano 18 h
// después), Estefania (remisión al equipo evaporada), Celeste (oferta colgada + crear y
// cancelar respaldados), Daria (cancelación determinista respaldada), Giovanna (control
// de falsos positivos) y Mafe (acuse de escalada con fila 1,7 s antes).
//
// Visto fallar sin lo que protege (sabotajes con cp previo, la misma noche):
//   · ventana de turno quitada → Tania pasa a respaldada (rojo);
//   · remisionAlEquipo quitada → Estefania desaparece (rojo);
//   · brazo de UPDATE de C1 quitado → Daria pasa a rota (rojo).
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');
const { auditPromesas, clasificarSaliente, remisionAlEquipo, nucleosCancelacion, nucleosConfirmacion, nucleosTraspaso } = require('./lib/promesas-audit');

const AHORA = Date.parse('2026-08-14T12:00:00Z');

const CONTACTOS = [
    { id: 'ct-tania', full_name: 'Tania Daza', wa_phone: '34652903713', bot_mode: 'auto', escalation_reason: null },
    { id: 'ct-estefania', full_name: 'Estefania Sanz', wa_phone: '34670388651', bot_mode: 'auto', escalation_reason: null },
    { id: 'ct-celeste', full_name: 'Celeste González', wa_phone: '34603734833', bot_mode: 'auto', escalation_reason: null },
    { id: 'ct-daria', full_name: 'Daria', wa_phone: '34672061008', bot_mode: 'auto', escalation_reason: null },
    { id: 'ct-giovanna', full_name: 'Giovanna Garcia', wa_phone: '34634829746', bot_mode: 'auto', escalation_reason: null },
    { id: 'ct-mafe', full_name: 'Mafe Alayon', wa_phone: '34656332064', bot_mode: 'auto', escalation_reason: null },
];

// Salientes del bot, literales de producción (recortados donde el original seguía).
const SALIENTES = [
    { id: 'm-tania-c1', contactId: 'ct-tania', createdAt: '2026-08-02T20:32:06.997Z',
        content: 'Disculpa, no me llega ese historial 😊 Pero perfecto, te apunto para el lunes al mediodía. ¿Qué servicio te gustaría hacerte?' },
    { id: 'm-tania-c7', contactId: 'ct-tania', createdAt: '2026-08-02T20:33:04.597Z',
        content: 'Lamento mucho lo que me cuentas 😔 Entiendo tu frustración. Voy a pasar tu caso a nuestro equipo para que te atiendan personalmente y lo solucionen.' },
    { id: 'm-estefania', contactId: 'ct-estefania', createdAt: '2026-08-03T10:00:25.071Z',
        content: '¡Hola Estefanía! Qué me alegra saber que tu madre está en casa recuperándose 💚 Lamento no poder hacer servicios a domicilio, pero te recomiendo que hables directamente con nuestro equipo — ellos podrán valorar tu situación.' },
    { id: 'm-celeste-crea', contactId: 'ct-celeste', createdAt: '2026-08-06T11:04:01.954Z',
        content: '✅ Perfecto, Celeste González. Cita reservada:\n\n📅 Miércoles 12 de agosto a las 13:00\n✂️ Consulta de valoración (20 min) con Natalia' },
    { id: 'm-celeste-cancela', contactId: 'ct-celeste', createdAt: '2026-08-06T11:05:02.940Z',
        content: 'Tu cita ha sido cancelada ✅ Si quieres reservar otra, dímelo cuando quieras 😊' },
    { id: 'm-celeste-oferta', contactId: 'ct-celeste', createdAt: '2026-08-06T11:12:16.736Z',
        content: 'Entiendo, eso requiere una valoración personalizada para ver el estado de tu cabello 😊 ¿Quieres que te ponga en contacto con una especialista para que valore tu caso?' },
    { id: 'm-daria', contactId: 'ct-daria', createdAt: '2026-08-12T10:49:22.369Z',
        content: 'Запись отменена ✅ Если захочешь записаться снова, напиши мне 😊' },
    { id: 'm-mafe-acuse', contactId: 'ct-mafe', createdAt: '2026-08-12T11:29:11.433Z',
        content: 'Perfecto 🙏 En breve una de nuestras especialistas se pondrá en contacto contigo.' },
    // Giovanna, los cuatro de su conversación real: NINGUNO es una promesa.
    { id: 'm-gio-1', contactId: 'ct-giovanna', createdAt: '2026-08-12T10:53:25.634Z',
        content: '¡Hola Giovanna! 😊 Tenemos dos opciones de reconstrucción: la Pro Miracle y la K18. Ambas cuestan 60€ y duran una hora. ¿Cuál te interesa?' },
    { id: 'm-gio-2', contactId: 'ct-giovanna', createdAt: '2026-08-12T10:59:20.577Z',
        content: 'Perfecto, Giovanna 😊 Cuando estés lista para septiembre u octubre, nos escribes y te asesoramos sin problema. ¿Hay algo más que necesites ahora?' },
    { id: 'm-gio-3', contactId: 'ct-giovanna', createdAt: '2026-08-12T11:02:44.775Z',
        content: '¡De nada, guapa! Nos vemos pronto 😊❤️' },
    { id: 'm-gio-4', contactId: 'ct-giovanna', createdAt: '2026-08-12T11:03:44.887Z',
        content: '¡Gracias! 😊 Cuéntame en un mensaje qué necesitas y te ayudo a reservar.' },
];

const CITAS = [
    // Tania: su única cita, creada A MANO 18 h después del «te apunto» (source manual).
    { id: 'apt-tania', contact_id: 'ct-tania', status: 'completed', service: 'Peinado ondas',
        starts_at: '2026-08-03T13:00:00Z', created_at: '2026-08-03T14:22:18.409Z',
        updated_at: '2026-08-03T14:22:18.409Z', updated_by: null, source: 'manual', last_change: null },
    // Celeste: creada por el bot 2,4 s ANTES del acuse; cancelada por el bot 2,5 s antes del suyo.
    { id: 'apt-celeste', contact_id: 'ct-celeste', status: 'cancelled', service: 'Consulta',
        starts_at: '2026-08-12T11:00:00Z', created_at: '2026-08-06T11:03:59.557Z',
        updated_at: '2026-08-06T11:05:00.887Z', updated_by: 'bot', source: 'bot',
        last_change: { a: { status: 'cancelled' }, at: '2026-08-06T11:05:00.430Z', by: 'bot', de: { status: 'confirmed' } } },
    // Daria: cita del panel, CANCELADA por el bot 2 s antes de su «Запись отменена».
    { id: 'apt-daria', contact_id: 'ct-daria', status: 'cancelled', service: 'Corte mujer y peinado Dyson',
        starts_at: '2026-08-12T16:00:00Z', created_at: '2026-08-10T13:14:11.751Z',
        updated_at: '2026-08-12T10:49:20.375Z', updated_by: 'bot', source: 'manual',
        last_change: { a: { status: 'cancelled' }, at: '2026-08-12T10:49:20.286Z', by: 'bot', de: { status: 'confirmed' } } },
];

const PENDING_ACTIONS = [
    // Tania: la escalada REAL, fila 1,7 s antes del acuse, resuelta en panel días después.
    { id: 'pa-tania', type: 'escalation', contact_id: 'ct-tania', status: 'resolved',
        resolution: 'resuelto_panel', created_at: '2026-08-02T20:33:02.921Z', resolved_at: '2026-08-08T09:13:22.260Z' },
    // Mafe: fila 1,7 s antes del acuse.
    { id: 'pa-mafe', type: 'escalation', contact_id: 'ct-mafe', status: 'resolved',
        resolution: 'resuelto_panel', created_at: '2026-08-12T11:29:09.693Z', resolved_at: '2026-08-12T14:42:36.628Z' },
];

const corre = (extra = {}) => auditPromesas({
    salientes: SALIENTES, citas: CITAS, pendingActions: PENDING_ACTIONS,
    contactos: CONTACTOS, ahora: AHORA, ...extra,
});

const hallazgoDe = (r, contactId, clase) =>
    r.hallazgos.find(h => h.contactId === contactId && h.clase === clase);

// ─── Los que tienen que SALIR ────────────────────────────────────────────────

test('Tania: «te apunto» sin fila en el turno y cita del panel 18 h después → SALVADA A MANO', () => {
    const r = corre();
    const h = hallazgoDe(r, 'ct-tania', 'C1_HECHA');
    assert.ok(h, 'la promesa de Tania tiene que salir');
    assert.strictEqual(h.desenlace, 'salvada_a_mano',
        'fue mentira en el momento aunque una persona la hiciera verdad después');
    assert.ok(/persona \(panel\)/.test(h.detalle), `el detalle dice QUIÉN salvó: "${h.detalle}"`);
});

test('Estefania: la remisión al equipo sin ninguna escalada → SIN ESCALADA REGISTRADA', () => {
    const r = corre();
    const h = hallazgoDe(r, 'ct-estefania', 'C7_REMISION');
    assert.ok(h, 'la remisión de Estefania tiene que salir — es el caso que ningún detector veía');
    assert.strictEqual(h.desenlace, 'sin_escalada_registrada');
    // Redacción Coexistence-limpia: afirma que no hay FILA, nunca que nadie atendió.
    assert.ok(!/nadie|sin atender|abandon/i.test(h.detalle), h.detalle);
});

test('Celeste: la oferta de traspaso colgada sin fila → SIN ESCALADA REGISTRADA', () => {
    const r = corre();
    const h = hallazgoDe(r, 'ct-celeste', 'C7_OFERTA');
    assert.ok(h, 'la oferta de Celeste tiene que salir');
    assert.strictEqual(h.desenlace, 'sin_escalada_registrada');
});

// ─── Los que NO tienen que salir ─────────────────────────────────────────────

test('Daria: cancelación con last_change by=bot dos segundos antes → respaldada, no sale', () => {
    const r = corre();
    assert.ok(!hallazgoDe(r, 'ct-daria', 'C1_CANCELADA'),
        'el camino determinista con escritura verificada no puede salir como hallazgo');
    assert.strictEqual(r.resumen.C1_CANCELADA?.respaldada, 2, 'las dos cancelaciones (Daria y Celeste) respaldadas');
});

test('Celeste: crear y cancelar escritos por el bot en el turno → respaldadas, no salen', () => {
    const r = corre();
    assert.ok(!hallazgoDe(r, 'ct-celeste', 'C1_HECHA'));
    assert.ok(!hallazgoDe(r, 'ct-celeste', 'C1_CANCELADA'));
});

test('Tania C7 y Mafe: acuse con fila de escalada 1,7 s antes → respaldados, no salen', () => {
    const r = corre();
    assert.ok(!hallazgoDe(r, 'ct-tania', 'C7_AFIRMACION'));
    assert.ok(!hallazgoDe(r, 'ct-mafe', 'C7_AFIRMACION'));
});

test('Giovanna: cero promesas en sus cuatro salientes (control de falsos positivos)', () => {
    const r = corre();
    assert.ok(!r.hallazgos.some(h => h.contactId === 'ct-giovanna'),
        '«te ayudo a reservar» y «te asesoramos» no son promesas');
});

// ─── El código de salida y la cobertura ──────────────────────────────────────

test('hayMal se enciende por rota/parcial/sin-escalada, NO por salvada a mano', () => {
    const r = corre();
    assert.strictEqual(r.hayMal, true, 'Estefania y Celeste encienden el exit 1');
    // Sin las dos C7 huérfanas, lo único que queda de Tania es la salvada: exit 0.
    const soloSalvada = corre({
        salientes: SALIENTES.filter(m => !['m-estefania', 'm-celeste-oferta'].includes(m.id)),
    });
    assert.strictEqual(soloSalvada.hayMal, false,
        'una salvada a mano se imprime pero tiene fila: no es «promesa sin fila detrás»');
    assert.ok(soloSalvada.hallazgos.some(h => h.desenlace === 'salvada_a_mano'), 'y aun así se imprime');
});

test('la cobertura se declara siempre, con sus cegueras (prosa ru/uk/en de C7)', () => {
    const r = corre();
    assert.ok(Array.isArray(r.cobertura) && r.cobertura.length >= 5);
    assert.ok(r.cobertura.some(l => /ru\/uk\/en.*cieg|cieg.*ru\/uk\/en/i.test(l)),
        'la ceguera de C7 en prosa no castellana está DICHA, no implícita');
});

test('el denominador por idioma sale en la cobertura, y el «NO MEDIDO» lleva su N (0b)', () => {
    const r = corre();
    // Daria escribe en ruso: hay al menos 1 saliente cirílico en los fixtures.
    assert.ok(r.idiomas.cirilico.salientes >= 1, 'el acuse ruso de Daria cuenta como cirílico');
    assert.ok(r.idiomas.es.salientes >= 8);
    assert.ok(r.cobertura.some(l => l.includes('Idiomas de los salientes')), 'el denominador se imprime');
    const noMedido = r.cobertura.find(l => /C7 NO MEDIDO en ru\/uk/.test(l));
    assert.ok(noMedido, 'con salientes cirílicos, la frase «C7 NO MEDIDO en ru/uk» es obligatoria');
    assert.ok(noMedido.includes(String(r.idiomas.cirilico.salientes)), 'y lleva el N de verdad, no una vaguedad');

    // Sin ningún saliente cirílico no hay nada que «no se esté midiendo»: la línea no sale.
    const soloEs = corre({ salientes: SALIENTES.filter(m => m.id !== 'm-daria') });
    assert.ok(!soloEs.cobertura.some(l => /C7 NO MEDIDO en ru\/uk/.test(l)));
});

// ─── Desenlaces con matices ──────────────────────────────────────────────────

test('promesa de cita SIN ninguna fila, nunca → ROTA', () => {
    const r = corre({ citas: CITAS.filter(c => c.contact_id !== 'ct-tania') });
    const h = hallazgoDe(r, 'ct-tania', 'C1_HECHA');
    assert.strictEqual(h.desenlace, 'rota');
    assert.strictEqual(r.hayMal, true);
});

test('recitar una cita futura que YA existía es legítimo (la filosofía de blockPhantom)', () => {
    // «Queda confirmada tu cita» tres días después de crearse la cita, con la cita futura.
    const r = corre({
        salientes: [{ id: 'm-recita', contactId: 'ct-celeste', createdAt: '2026-08-09T10:00:00Z',
            content: 'Queda confirmada tu cita del miércoles 😊' }],
        citas: [{ ...CITAS[1], status: 'confirmed', updated_at: '2026-08-06T11:03:59.557Z', last_change: null }],
    });
    assert.strictEqual(r.hallazgos.length, 0, 'una re-confirmación honesta no puede salir como rota');
});

test('escalada a medias: fila pendiente con la ficha ya limpia → PARCIAL', () => {
    const r = corre({
        pendingActions: [{ ...PENDING_ACTIONS[0], status: 'pending', resolution: null, resolved_at: null }],
    });
    const h = hallazgoDe(r, 'ct-tania', 'C7_AFIRMACION');
    assert.strictEqual(h?.desenlace, 'parcial');
});

// 0c (14/08): comprobado contra producción sobre los CINCO C7 respaldados de la corrida
// real — cuatro resueltas con ficha limpia (Tania, Mafe ×2, Nastya) y una viva coherente
// (Pelin Long: pending + manual + pedir_persona). Estos dos bloques congelan esa regla.
test('0c · fila RESUELTA con ficha limpia = respaldada, no parcial (la triple ocurrió y se deshizo al resolver)', () => {
    const r = corre(); // los fixtures de Tania y Mafe son exactamente ese caso
    assert.ok(!hallazgoDe(r, 'ct-tania', 'C7_AFIRMACION'));
    assert.ok(!hallazgoDe(r, 'ct-mafe', 'C7_AFIRMACION'));
});

test('0c · fila PENDIENTE con ficha aún escalada = respaldada (triple viva, el caso de Pelin)', () => {
    const r = corre({
        pendingActions: [{ ...PENDING_ACTIONS[0], status: 'pending', resolution: null, resolved_at: null }],
        contactos: CONTACTOS.map(c => c.id === 'ct-tania'
            ? { ...c, bot_mode: 'manual', escalation_reason: 'pedir_persona' } : c),
    });
    assert.ok(!hallazgoDe(r, 'ct-tania', 'C7_AFIRMACION'),
        'una escalada viva y coherente no es un hallazgo');
});

test('0d · la ventana de alarma: lo viejo se imprime pero no grita (el cron no puede vivir en rojo)', () => {
    // Estefania (03/08) y Celeste (06/08) son históricas: con ventana de 2 días desde
    // AHORA (14/08), no alarma nada — pero los hallazgos siguen TODOS en el informe.
    const conVentana = corre({ alarmaDesdeMs: AHORA - 2 * 24 * 3600 * 1000 });
    assert.strictEqual(conVentana.hayMal, false, 'lo de hace 11 días no puede hacer gritar al cron cada noche');
    assert.ok(conVentana.hallazgos.some(h => h.desenlace === 'sin_escalada_registrada' && !h.enVentanaAlarma),
        'y aun así se imprimen, marcados como fuera de ventana');

    // Un fallo DENTRO de la ventana sí alarma: la misma oferta de Celeste, fechada ayer.
    const reciente = corre({
        alarmaDesdeMs: AHORA - 2 * 24 * 3600 * 1000,
        salientes: [{ id: 'm-ayer', contactId: 'ct-celeste', createdAt: '2026-08-13T18:00:00Z',
            content: '¿Quieres que te ponga en contacto con una especialista para que valore tu caso?' }],
    });
    assert.strictEqual(reciente.hayMal, true, 'lo de ayer sí enciende el exit 1');

    // Sin ventana (la corrida manual), todo alarma como siempre.
    assert.strictEqual(corre().hayMal, true);
});

test('los teléfonos 999… (arnés de pruebas) quedan fuera del barrido', () => {
    const r = corre({
        contactos: [...CONTACTOS, { id: 'ct-test', full_name: 'Test', wa_phone: '9996001000', bot_mode: 'auto', escalation_reason: null }],
        salientes: [...SALIENTES, { id: 'm-test', contactId: 'ct-test', createdAt: '2026-08-13T10:00:00Z',
            content: 'Tu cita ha sido cancelada ✅' }],
    });
    assert.ok(!r.hallazgos.some(h => h.contactId === 'ct-test'));
});

test('negar una cita no es prometerla: el literal de Carolina no clasifica (FP de la 1ª corrida real)', () => {
    // Cazado el 14/08 en la primera corrida contra producción: llmClaimsBooked casa el
    // «cita reservada» de DENTRO de la negación y el barrido la contaba como promesa.
    const r = corre({
        salientes: [{ id: 'm-carolina', contactId: 'ct-celeste', createdAt: '2026-08-09T17:44:06Z',
            content: 'No me consta ninguna cita reservada a tu nombre. ¿Quieres que te reserve una?' }],
    });
    assert.strictEqual(r.hallazgos.length, 0, 'una negación honesta no puede salir como promesa rota ni salvada');
});

test('la guarda de negación va por FRASE, no por mensaje: una promesa real con un «no» delante clasifica', () => {
    // 0a (14/08): la forma del «yes» dentro de «yesterday». Probada sobre el mensaje
    // entero, la guarda se comía la promesa compuesta; acotada a la frase negada, no.
    const promesas = [
        // Negación inocua delante de la promesa (el literal del encargo).
        'No te preocupes, ya te la he apuntado para el lunes a las 10',
        // Negación DE CITA en una frase y promesa real en la siguiente.
        'No me consta ninguna cita reservada a tu nombre. Pero hecho, te la he apuntado para el lunes a las 10 😊',
    ];
    for (const content of promesas) {
        const r = corre({ salientes: [{ id: 'm-x', contactId: 'ct-estefania', createdAt: '2026-08-09T17:44:06Z', content }] });
        const h = r.hallazgos.find(x => x.clase === 'C1_HECHA');
        assert.ok(h, `tiene que clasificar como promesa: "${content.slice(0, 50)}"`);
        assert.strictEqual(h.desenlace, 'rota', 'y sin fila detrás, salir como rota');
    }
    // Y la negación en la MISMA frase sigue fuera.
    const r = corre({ salientes: [{ id: 'm-y', contactId: 'ct-estefania', createdAt: '2026-08-09T17:44:06Z',
        content: 'No veo tu cita reservada en el sistema' }] });
    assert.strictEqual(r.hallazgos.length, 0);
});

test('remisionAlEquipo: positivos y negativos', () => {
    assert.ok(remisionAlEquipo('te recomiendo que hables directamente con nuestro equipo'));
    assert.ok(remisionAlEquipo('Lo mejor es que hables con el equipo del salón'));
    assert.ok(!remisionAlEquipo('nuestro equipo abre a las 10'), 'mencionar al equipo no es remitir');
    assert.ok(!remisionAlEquipo('¿qué servicio necesitas hoy?'));
});

test('los núcleos se generan de sus fuentes y no están vacíos', () => {
    assert.ok(nucleosCancelacion().some(n => n.includes('ha sido cancelada')));
    assert.ok(nucleosCancelacion().some(n => n.includes('reserva')), 'la variante de San Remo, derivada');
    assert.ok(nucleosConfirmacion().some(n => n.includes('appointment booked')), 'el inglés que la prosa no casa');
    assert.ok(nucleosTraspaso().some(n => n.includes('se pondra en contacto contigo')), 'CONFIRM_YES, el acuse invisible a los verbos');
});
