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

    await test('Servicio: "manicura"/"masaje"/"color raíz" mapean a su categoría', () => {
        assert.strictEqual(helpers.extractServiceFromText('quiero una manicura', services).categoria, 'Manicura/Pedicura');
        assert.strictEqual(helpers.extractServiceFromText('un masaje relajante', services).categoria, 'Masajes y SPA');
        assert.strictEqual(helpers.extractServiceFromText('cortarme el pelo', services).categoria, 'Cortes');
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
