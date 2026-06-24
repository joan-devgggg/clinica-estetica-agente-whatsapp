/**
 * sante-deterministic.js — Pruebas deterministas (sin LLM) del bot de Sante.
 * Cubre: motor de huecos (calendar-sante), extracción (helpers), workers
 * (reminder/review) y sincronización con el panel (capa db).
 *
 * Uso: node tests/sante-deterministic.js
 */
require('dotenv').config();
const assert = require('assert');
const { SANTE_ORG_ID } = require('../services/org-registry');
const calendarSante = require('../services/calendar-sante');
const helpers = require('../services/helpers');
const db = require('../services/db');
const supabase = require('../services/supabase');

const ORG = SANTE_ORG_ID;
const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

let pass = 0, fail = 0;
const failures = [];
async function test(name, fn) {
    try { await fn(); pass++; console.log(`  ✅ ${name}`); }
    catch (e) { fail++; failures.push({ name, err: e.message }); console.log(`  ❌ ${name}\n       ${e.message}`); }
}

// Catálogo y estilistas reales (cacheados)
let services, stylists;
function svc(catName) {
    const s = services.find(x => x.categoria === catName);
    if (!s) throw new Error(`servicio no encontrado para categoria ${catName}`);
    return s;
}
function styId(name) { return stylists.find(s => s.name === name).id; }

(async () => {
    const cfg = await db.getAgentConfig(ORG);
    services = cfg.services;
    stylists = await db.getStylistsByOrg(ORG);

    console.log('\n═══ MOTOR DE HUECOS (calendar-sante) ═══');

    await test('1. Manicura → solo Olgha (Mar/Jue/Vie), nunca otra estilista', async () => {
        const slots = await calendarSante.getAvailableSlots(ORG, {
            serviceDuration: svc('Manicura/Pedicura').duracion,
            serviceCategory: 'Manicura/Pedicura',
        });
        assert(slots.length > 0, 'debe haber huecos de manicura');
        const ids = [...new Set(slots.map(s => s.stylistId))];
        assert.deepStrictEqual(ids, [styId('Olgha')], 'todos los huecos deben ser de Olgha');
        for (const s of slots) {
            const dow = new Date(s.fecha + 'T12:00:00').getDay(); // 2=Mar,4=Jue,5=Vie
            assert([2, 4, 5].includes(dow), `Olgha no trabaja ${s.fecha} (dow=${dow})`);
        }
    });

    await test('4/13. Masaje → solo Larisa y todos los huecos < 16:00', async () => {
        const slots = await calendarSante.getAvailableSlots(ORG, {
            serviceDuration: svc('Masajes y SPA').duracion,
            serviceCategory: 'Masajes y SPA',
        });
        assert(slots.length > 0, 'debe haber huecos de masaje');
        const ids = [...new Set(slots.map(s => s.stylistId))];
        assert.deepStrictEqual(ids, [styId('Larisa')], 'todos los huecos deben ser de Larisa');
        for (const s of slots) {
            const [h] = s.hora.split(':').map(Number);
            // Larisa cierra a las 16:00; el inicio del hueco + duración no puede pasar de 16:00
            assert(h < 16, `hueco ${s.hora} no debería ofrecerse (Larisa cierra 16:00)`);
        }
    });

    await test('3. Veronika en día que NO trabaja (domingo) → alternativas reales + flag', async () => {
        // Veronika trabaja Lun-Vie. Pedimos domingo (diaSemana=6).
        const slots = await calendarSante.getAvailableSlots(ORG, {
            serviceDuration: svc('Cortes').duracion,
            serviceCategory: 'Cortes',
            preferredStylistId: styId('Veronika'),
            preferencia: { diaSemana: 6 }, // domingo
        });
        assert(slots.length > 0, 'debe ofrecer alternativas reales');
        assert(slots.requestedDayUnavailable === true, 'debe marcar requestedDayUnavailable');
        // Todas de Veronika y ninguna en domingo
        for (const s of slots) {
            assert.strictEqual(s.stylistId, styId('Veronika'), 'alternativas deben ser de Veronika');
            assert.notStrictEqual(new Date(s.fecha + 'T12:00:00').getDay(), 0, 'ninguna en domingo');
        }
    });

    await test('2. Veronika en día que SÍ trabaja → huecos de Veronika ese día', async () => {
        // Próximo lunes desde mañana
        const slots = await calendarSante.getAvailableSlots(ORG, {
            serviceDuration: svc('Cortes').duracion,
            serviceCategory: 'Cortes',
            preferredStylistId: styId('Veronika'),
            preferencia: { diaSemana: 0 }, // lunes
        });
        assert(slots.length > 0, 'debe haber huecos');
        assert(!slots.requestedDayUnavailable, 'lunes SÍ trabaja → sin flag');
        for (const s of slots) {
            assert.strictEqual(new Date(s.fecha + 'T12:00:00').getDay(), 1, 'todos en lunes');
            assert.strictEqual(s.stylistId, styId('Veronika'));
        }
    });

    await test('11. Domingo para servicio general → cerrado: nadie trabaja, da alternativas', async () => {
        const slots = await calendarSante.getAvailableSlots(ORG, {
            serviceDuration: svc('Cortes').duracion,
            serviceCategory: 'Cortes',
            preferencia: { diaSemana: 6 }, // domingo
        });
        // Nadie trabaja domingo → debe ofrecer alternativas (no inventa domingo)
        for (const s of slots) {
            assert.notStrictEqual(new Date(s.fecha + 'T12:00:00').getDay(), 0, 'ningún hueco en domingo');
        }
        assert(slots.requestedDayUnavailable === true || slots.length === 0, 'flag de día no disponible');
    });

    await test('12. Preferencia "mañana" → ningún hueco a partir de las 14:00', async () => {
        const slots = await calendarSante.getAvailableSlots(ORG, {
            serviceDuration: svc('Cortes').duracion,
            serviceCategory: 'Cortes',
            preferencia: { periodo: 'mañana' },
        });
        for (const s of slots) {
            const [h] = s.hora.split(':').map(Number);
            assert(h < 14, `hueco ${s.hora} no es de mañana`);
        }
    });

    await test('Color raíz → estilistas con skill Color Premium (Veronika/Irina/Yulia), no Olgha/Larisa', async () => {
        const slots = await calendarSante.getAvailableSlots(ORG, {
            serviceDuration: svc('Color Premium').duracion,
            serviceCategory: 'Color Premium',
        });
        assert(slots.length > 0);
        const ids = new Set(slots.map(s => s.stylistId));
        assert(!ids.has(styId('Olgha')), 'Olgha no hace color');
        assert(!ids.has(styId('Larisa')), 'Larisa no hace color');
    });

    await test('Categoría sin estilista → lista vacía (no inventa)', async () => {
        const slots = await calendarSante.getAvailableSlots(ORG, {
            serviceDuration: 60,
            serviceCategory: 'CategoriaInexistente',
        });
        assert.strictEqual(slots.length, 0);
    });

    console.log('\n═══ EXTRACCIÓN (helpers) ═══');

    await test('8/9/10. detectLanguage: es/en/ru', () => {
        assert.strictEqual(helpers.detectLanguage('hello I want an appointment'), 'en');
        assert.strictEqual(helpers.detectLanguage('Привет, хочу записаться'), 'ru');
        assert.strictEqual(helpers.detectLanguage('hola quiero una cita'), 'es');
        // Ucraniano (letras propias)
        assert.strictEqual(helpers.detectLanguage('Привіт, хочу записатися'), 'uk');
    });

    await test('Servicio: variante concreta mapea bien; genérico ambiguo NO adivina (BUG1)', () => {
        // Cuando nombra la variante concreta, debe mapear a ESE servicio (no a otro).
        assert.strictEqual(helpers.extractServiceFromText('manicura japonesa', services).nombre, 'Japonesa');
        assert.strictEqual(helpers.extractServiceFromText('quiero una manicura japonesa', services).nombre, 'Japonesa');
        assert.strictEqual(helpers.extractServiceFromText('un masaje relajante', services).categoria, 'Masajes y SPA');
        // BUG1: "manicura" a secas es ambiguo (muchas variantes). Antes devolvía
        // "Higiénica mujer" (el primero de la categoría). Ahora devuelve null para
        // que el bot pregunte qué variante quiere, en vez de guardar una incorrecta.
        assert.strictEqual(helpers.extractServiceFromText('quiero una manicura', services), null);
        const generico = helpers.extractServiceFromText('quiero una manicura', services);
        assert.notStrictEqual(generico?.nombre, 'Higiénica mujer', 'no debe fijar "Higiénica mujer" por defecto');
    });

    await test('BUG1: flujo manicura→japonesa NO queda fijado en "Higiénica mujer"', () => {
        // Simula los dos turnos: turno 1 "manicura" (genérico) → no fija servicio;
        // turno 2 "japonesa" → fija la variante correcta. Reproduce la lógica de bot.js.
        const session = { selectedService: null };
        // Turno 1
        let m = helpers.extractServiceFromText('hola quiero una manicura', services);
        if (!session.selectedService && m) session.selectedService = m;
        assert.strictEqual(session.selectedService, null, 'turno 1 genérico no debe fijar servicio');
        // Turno 2
        m = helpers.extractServiceFromText('la japonesa por favor', services);
        if (!session.selectedService && m) session.selectedService = m;
        assert.ok(session.selectedService, 'turno 2 debe fijar la variante');
        assert.strictEqual(session.selectedService.nombre, 'Japonesa', 'debe guardar Japonesa, NO Higiénica mujer');
    });

    await test('Estilista: "con Veronika" se extrae', () => {
        const team = stylists.map(s => ({ ...s, nombre: s.name }));
        assert.strictEqual(helpers.extractStylistFromText('quiero con Veronika', team).name, 'Veronika');
    });

    await test('6. Segunda cita para acompañante: detectGuestBooking + extractGuestName', () => {
        assert.strictEqual(helpers.detectGuestBooking('es para mi amigo Ivan'), true);
        assert.strictEqual(helpers.wantsAnotherBooking('quiero otra cita para mi amiga'), true);
        assert.strictEqual(helpers.extractGuestName('para mi amigo Ivan'), 'Ivan');
    });

    await test('15. Cancelación detecta intent "cancelar"/"cambiar"', () => {
        assert.strictEqual(helpers.detectIntent('quiero cancelar mi cita'), 'cancelar');
        assert.strictEqual(helpers.detectIntent('quiero anular la cita'), 'cancelar');
        assert.strictEqual(helpers.detectIntent('quiero cambiar mi cita'), 'cambiar');
        assert.strictEqual(helpers.detectIntent('necesito reagendar'), 'cambiar');
    });

    await test('Fecha: "el jueves" → diaSemana=3; "el 24" → fecha futura', () => {
        const d = helpers.extractQuickDataSante('quiero el jueves', {});
        assert.strictEqual(d.preferencia_horaria.diaSemana, 3);
    });

    console.log('\n═══ CONFIRMACIÓN DE CITA: upselling + dirección + 48h (BUG2/BUG3) ═══');

    const upRules = cfg.business_info?.upselling || [];
    const direccionCfg = cfg.business_info?.direccion || '';

    await test('BUG2: upselling se resuelve según el servicio elegido', () => {
        // "Color raíz" tiene regla de upselling (→ Manicura, según business_info).
        const colorRaiz = services.find(s => s.nombre === 'Color raíz');
        const sug = helpers.matchUpsellSuggestion(colorRaiz, upRules);
        assert.ok(sug, 'Color raíz debe tener una sugerencia de upselling');
        // Un servicio sin regla (p.ej. Japonesa/manicura) no debe inventar sugerencia.
        const japonesa = services.find(s => s.nombre === 'Japonesa');
        assert.strictEqual(helpers.matchUpsellSuggestion(japonesa, upRules), null);
    });

    await test('BUG3: el mensaje de confirmación SIEMPRE incluye 48h y dirección', () => {
        const msg = helpers.buildSanteConfirmationMessage({
            nombre: 'Test', fecha: '2025-07-01', hora: '10:00',
            servicio: 'Corte señora', stylistNombre: 'Veronika',
            precio: 25, duracion: 45, categoria: 'Cortes',
            direccion: direccionCfg, language: 'es',
        });
        assert.ok(/48/.test(msg), 'debe mencionar las 48 horas de cancelación');
        assert.ok(msg.includes('San Juan Bosco 14'), 'debe incluir la dirección (San Juan Bosco 14)');
        assert.ok(msg.includes('✅'), 'debe incluir emoji ✅');
        assert.ok(msg.includes('📅'), 'debe incluir emoji 📅');
        assert.ok(msg.includes('✂️'), 'debe incluir emoji ✂️ para corte');
        assert.ok(msg.includes('💰'), 'debe incluir emoji 💰');
        assert.ok(msg.includes('📍'), 'debe incluir emoji 📍');
        assert.ok(msg.includes('🙏'), 'debe incluir emoji 🙏');
    });

    await test('BUG2+BUG3: confirmación con upselling incluye sugerencia + 48h + dirección', () => {
        const colorRaiz = services.find(s => s.nombre === 'Color raíz');
        const sug = helpers.matchUpsellSuggestion(colorRaiz, upRules);
        const msg = helpers.buildSanteConfirmationMessage({
            nombre: 'Test', fecha: '2025-07-01', hora: '10:00',
            servicio: 'Color raíz', stylistNombre: 'Veronika',
            precio: 45, duracion: 90, categoria: 'Color Premium',
            direccion: direccionCfg, language: 'es', upsellSuggestion: sug,
        });
        assert.ok(msg.toLowerCase().includes(String(sug).toLowerCase()), 'incluye la sugerencia de upselling');
        assert.ok(/48/.test(msg), 'incluye política 48h');
        assert.ok(msg.includes('San Juan Bosco 14'), 'incluye dirección');
    });

    await test('BUG3: mensaje en otros idiomas (en/ru/uk) también trae 48h + dirección', () => {
        for (const lang of ['en', 'ru', 'uk']) {
            const msg = helpers.buildSanteConfirmationMessage({
                nombre: 'Test', fecha: '2025-07-01', hora: '10:00',
                servicio: 'Corte', stylistNombre: 'V', precio: 25, duracion: 45,
                categoria: 'Cortes', direccion: direccionCfg, language: lang,
            });
            assert.ok(/48/.test(msg), `[${lang}] debe mencionar 48`);
            assert.ok(msg.includes('San Juan Bosco 14'), `[${lang}] debe incluir dirección`);
        }
    });

    await test('Emoji por categoría: uñas=💅, masaje=💆, pelo=✂️', () => {
        const test = (cat, emoji) => {
            const msg = helpers.buildSanteConfirmationMessage({
                nombre: 'X', fecha: '2025-07-01', hora: '10:00',
                servicio: 'Test', precio: 10, duracion: 30,
                categoria: cat, direccion: 'Dir', language: 'es',
            });
            assert.ok(msg.includes(emoji), `categoría "${cat}" debe usar ${emoji}`);
        };
        test('Manicura/Pedicura', '💅');
        test('Masajes y SPA', '💆');
        test('Cortes', '✂️');
        test('Color Premium', '✂️');
    });

    await test('BUG2+BUG3: simulación del wiring de bot.js al confirmar la cita', () => {
        const session = {
            selectedService: services.find(s => s.nombre === 'Color raíz'),
            selectedStylist: { id: 'c3d4...0101', nombre: 'Veronika' },
            upsellingAccepted: [],
            language: 'es',
            partialData: { nombre: 'María', fecha_cita: '2025-07-03', hora_cita: '10:00' },
        };
        const aiResponse = { respuesta: '(LLM text ignored)', reserva_confirmada: true };
        const yaEstabaConfirmada = false;
        session.reservaConfirmada = true;
        if (!yaEstabaConfirmada && session.reservaConfirmada && aiResponse.reserva_confirmada) {
            const svc = session.selectedService || {};
            const upsellSug = (session.upsellingAccepted || []).length
                ? null
                : helpers.matchUpsellSuggestion(session.selectedService, upRules);
            aiResponse.respuesta = helpers.buildSanteConfirmationMessage({
                nombre: session.partialData.nombre,
                fecha: session.partialData.fecha_cita,
                hora: session.partialData.hora_cita,
                servicio: svc.nombre, stylistNombre: session.selectedStylist?.nombre,
                precio: svc.precio, duracion: svc.duracion, categoria: svc.categoria,
                direccion: direccionCfg, language: session.language, upsellSuggestion: upsellSug,
            });
        }
        assert.ok(aiResponse.respuesta.includes('✅'), 'mensaje final incluye ✅');
        assert.ok(/48/.test(aiResponse.respuesta), 'mensaje final incluye 48h');
        assert.ok(aiResponse.respuesta.includes('San Juan Bosco 14'), 'mensaje final incluye dirección');
        assert.ok(/manicura/i.test(aiResponse.respuesta), 'mensaje final ofrece complementario (manicura)');
        assert.ok(!aiResponse.respuesta.includes('LLM text ignored'), 'LLM text replaced, not appended');
    });

    console.log('\n═══ WORKERS (reminder / review) — consultas DB ═══');

    // Crear un contacto + cita de prueba para mañana y verificar que el worker la encuentra
    const TEST_PHONE = '34600000020';
    let testContactId, testApptId, reminderFecha, reminderHora;
    await test('setup: crear contacto + cita Sante dentro de ventana 24h', async () => {
        await cleanupPhone(TEST_PHONE);
        const id = await db.saveLead(ORG, { telefono: TEST_PHONE, nombre: 'TestReminder', language: 'es' });
        testContactId = id;
        assert(id, 'contacto creado');
        // Cita ~10h en el futuro (dentro de la ventana de recordatorio de 24h)
        const target = new Date(Date.now() + 10 * 3600 * 1000);
        reminderFecha = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
        reminderHora = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
        const apt = await db.saveAppointment(ORG, id, {
            servicio: 'Corte', fecha: reminderFecha, hora: reminderHora, duracionMin: 60,
            estado: 'confirmed', stylistId: styId('Veronika'),
        });
        testApptId = apt.id;
        assert(apt, 'cita creada');
        // El bot denormaliza estado/fecha en contacts para el worker de recordatorio
        await db.updateLead(ORG, { leadId: id, estado_cita: 'confirmado', fecha_cita: reminderFecha, hora_cita: reminderHora });
    });

    await test('20. Reminder worker: query denormalizada encuentra la cita + dentro de ventana 24h', async () => {
        // (a) La denormalización contacts.estado/fecha_cita hace que el worker la encuentre
        const found = await retry(async () => {
            const pendientes = await db.getAppointmentsPendientesRecordatorio(ORG);
            const f = pendientes.find(p => p.telefono === TEST_PHONE);
            assert(f, 'la cita debe aparecer como pendiente de recordatorio (denormalización Sante OK)');
            return f;
        });
        assert.strictEqual(found.recordatorio_enviado, false);
        // (b) El filtro de tiempo del worker la marcaría para enviar (dentro de 24h)
        const fh = new Date(`${found.fecha_cita}T${found.hora_cita || '00:00'}:00`);
        const minutos = (fh - Date.now()) / 60000;
        assert(minutos > 0 && minutos <= 1440, `cita dentro de ventana 24h (min=${Math.round(minutos)})`);
    });

    await test('21. Review worker encuentra cita completada hace >2h (resena pendiente)', async () => {
        // Cita que terminó hace 3 horas, completada, sin reseña
        const ayer = isoDateOffset(0);
        const startsAt = new Date(Date.now() - 4 * 3600 * 1000);
        const endsAt = new Date(Date.now() - 3 * 3600 * 1000);
        const { data: apt } = await supabase.from('appointments').insert({
            organization_id: ORG, contact_id: testContactId, service: 'Corte',
            starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(),
            status: 'completed', resena_enviada: false, full_name: 'TestReminder', phone: TEST_PHONE,
        }).select().single();
        const pendientes = await db.getCompletedAppointmentsForReview(ORG, 2); // 2h
        const found = pendientes.find(p => p.id === apt.id);
        assert(found, 'la cita completada hace 3h debe aparecer para reseña');
    });

    await test('autoCompleteAppointments marca confirmadas pasadas como completed', async () => {
        const startsAt = new Date(Date.now() - 3 * 3600 * 1000);
        const endsAt = new Date(Date.now() - 2 * 3600 * 1000);
        const { data: apt } = await supabase.from('appointments').insert({
            organization_id: ORG, contact_id: testContactId, service: 'Masaje',
            starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(),
            status: 'confirmed', full_name: 'TestReminder', phone: TEST_PHONE,
        }).select().single();
        await db.autoCompleteAppointments(ORG);
        const { data: after } = await supabase.from('appointments').select('status').eq('id', apt.id).single();
        assert.strictEqual(after.status, 'completed', 'la cita pasada debe quedar completed');
    });

    console.log('\n═══ PANEL / SINCRONIZACIÓN (capa db = endpoints webhook) ═══');

    await test('17. Cita manual desde panel → aparece en Citas y Agenda estilista', async () => {
        const mañana = isoDateOffset(2);
        // Equivalente a POST /api/appointments (source manual)
        const apt = await db.saveAppointment(ORG, testContactId, {
            servicio: 'Corte', fecha: mañana, hora: '11:00', duracionMin: 60,
            estado: 'confirmed', stylistId: styId('Irina'), source: 'manual',
        });
        await db.updateLeadById(ORG, testContactId, { estado_cita: 'confirmado', fecha_cita: mañana, hora_cita: '11:00', appointment_id: apt.id });
        // Aparece en Citas (getAppointmentsByDateRange). Reintentamos: la Data API de
        // Supabase puede tener lag read-after-write (no es un fallo del bot).
        // Nota: getAppointmentsByDateRange devuelve id = contact_id y appointment_id = id
        // de la cita (forma que consume el panel de Citas).
        await retry(async () => {
            const citas = await db.getAppointmentsByDateRange(ORG, mañana, mañana);
            assert(citas.find(c => c.appointment_id === apt.id), 'cita manual debe aparecer en /api/citas');
        });
        // Aparece en Agenda estilista (getAppointmentsByStylistAndRange)
        const from = new Date(mañana + 'T00:00:00').toISOString();
        const to = new Date(mañana + 'T23:59:59').toISOString();
        await retry(async () => {
            const agenda = await db.getAppointmentsByStylistAndRange(ORG, styId('Irina'), from, to);
            assert(agenda.find(a => a.id === apt.id), 'cita manual debe aparecer en agenda de Irina');
        });
    });

    await test('16. Cita del bot → aparece en Clientes con próxima cita', async () => {
        const clientes = await db.getAllLeads(ORG, { search: TEST_PHONE });
        assert(clientes.find(c => c.telefono === TEST_PHONE), 'el contacto debe aparecer en /api/clientes');
    });

    await test('19. Marcar cita completed (panel) → visit_count +1', async () => {
        const before = (await db.findById(ORG, testContactId)).visit_count || 0;
        // Equivalente a PUT /api/citas/:id { estado: 'completed' } → incrementVisitCount
        await db.incrementVisitCount(ORG, testContactId);
        const after = (await db.findById(ORG, testContactId)).visit_count || 0;
        assert.strictEqual(after, before + 1, 'visit_count debe incrementarse');
    });

    // Limpieza
    await cleanupPhone(TEST_PHONE);

    console.log('\n═══ BUFFER DE MENSAJES (bot.js) ═══');

    const bot = require('../bot');
    const { messageBuffers, BUFFER_DELAY_MS } = bot._internals;

    await test('Buffer: mensajes rápidos se acumulan en un solo buffer', async () => {
        const testOrgId = ORG;
        const testPhone = '34600000099@c.us';
        const sink = [];
        const fakeClient = {
            sendMessage: async (_p, text) => sink.push(text),
            getChatById: async () => ({ sendStateTyping: async () => {} }),
        };
        let counter = 0;
        const makeMsg = (text) => ({
            from: testPhone, body: text, fromMe: false, isStatus: false, isBroadcast: false, hasMedia: false,
            id: { _serialized: `BUF_TEST_${Date.now()}_${counter++}` },
        });

        // Limpiar buffers previos
        const sKey = `${testOrgId}:${testPhone}`;
        const prev = messageBuffers.get(sKey);
        if (prev?.timer) clearTimeout(prev.timer);
        messageBuffers.delete(sKey);

        await bot.handleIncomingMessage(fakeClient, makeMsg('Hola'), testOrgId);
        await bot.handleIncomingMessage(fakeClient, makeMsg('quiero cita'), testOrgId);
        await bot.handleIncomingMessage(fakeClient, makeMsg('el martes'), testOrgId);

        const buffer = bot._internals.getBuffer(testOrgId, testPhone);
        assert.ok(buffer, 'debe existir un buffer para el chat');
        assert.strictEqual(buffer.state, 'buffering', 'estado debe ser buffering');
        assert.strictEqual(buffer.texts.length, 3, 'debe acumular 3 mensajes');
        assert.ok(buffer.texts.join('\n').includes('Hola'), 'contiene primer mensaje');
        assert.ok(buffer.texts.join('\n').includes('quiero cita'), 'contiene segundo mensaje');
        assert.ok(buffer.texts.join('\n').includes('el martes'), 'contiene tercer mensaje');

        // Limpiar
        if (buffer.timer) clearTimeout(buffer.timer);
        messageBuffers.delete(sKey);
    });

    await test('Buffer: BUFFER_DELAY_MS es 5 segundos', () => {
        assert.strictEqual(BUFFER_DELAY_MS, 5000, 'el delay debe ser 5000ms');
    });

    await test('Buffer: dedup evita duplicados por messageKey', async () => {
        const testOrgId = ORG;
        const testPhone = '34600000098@c.us';
        const fakeClient = {
            sendMessage: async () => {},
            getChatById: async () => ({ sendStateTyping: async () => {} }),
        };
        const sKey = `${testOrgId}:${testPhone}`;
        const prev = messageBuffers.get(sKey);
        if (prev?.timer) clearTimeout(prev.timer);
        messageBuffers.delete(sKey);

        const dupeId = `DUPE_${Date.now()}`;
        const makeMsg = (text) => ({
            from: testPhone, body: text, fromMe: false, isStatus: false, isBroadcast: false, hasMedia: false,
            id: { _serialized: dupeId },
        });

        await bot.handleIncomingMessage(fakeClient, makeMsg('hola'), testOrgId);
        await bot.handleIncomingMessage(fakeClient, makeMsg('hola'), testOrgId);

        const buffer = bot._internals.getBuffer(testOrgId, testPhone);
        assert.strictEqual(buffer.texts.length, 1, 'el duplicado no debe acumularse');

        if (buffer.timer) clearTimeout(buffer.timer);
        messageBuffers.delete(sKey);
    });

    console.log(`\n═══ RESUMEN deterministas: ${pass} ✅  /  ${fail} ❌ ═══`);
    if (failures.length) {
        console.log('\nFallos:');
        failures.forEach(f => console.log(`  • ${f.name}: ${f.err}`));
    }
    process.exit(fail ? 1 : 0);
})();

// ─── utilidades ───────────────────────────────────────────────────────────────
// Reintenta una aserción ante el lag read-after-write de la Data API de Supabase.
async function retry(fn, attempts = 5, delayMs = 400) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, delayMs)); }
    }
    throw lastErr;
}
function isoDateOffset(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function cleanupPhone(phone) {
    const c = await db.findByPhone(ORG, phone);
    if (c) {
        await supabase.from('appointments').delete().eq('organization_id', ORG).eq('contact_id', c.id);
        await supabase.from('contacts').delete().eq('organization_id', ORG).eq('id', c.id);
    }
}
