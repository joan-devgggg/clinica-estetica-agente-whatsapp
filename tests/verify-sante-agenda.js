/**
 * verify-sante-agenda.js — ¿Las citas futuras siguen siendo coherentes con el horario REAL?
 *
 * Contrapartida de verify-sante-catalog: aquel verifica el motor de reservas (offline, con
 * horario sintético); este verifica los DATOS de producción. No hay ningún horario esperado
 * escrito a mano — se contrasta cada cita contra el horario, los bloqueos y las skills que
 * haya HOY en Supabase, los edite la dueña como los edite.
 *
 * Detecta lo que hoy no detectaba nadie: la dueña quita un día o recorta una franja en el
 * panel y las citas ya reservadas en ese hueco se quedan colgando en silencio.
 *
 * Uso:  npm run verify:sante:agenda   (necesita SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 *
 * SOLO LECTURA: no escribe nada. Sale con código 1 si hay hallazgos de severidad 'error'
 * (la clienta se lleva el golpe); los 'aviso' se listan pero no rompen el build.
 * No forma parte de `npm test` (que es hermético): la lógica pura se prueba en
 * tests/agenda-audit.test.js, que sí corre en CI.
 */

require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Madrid';

const { SANTE_ORG_ID } = require('../services/org-registry');
const db = require('../services/db');
const { toLocalDateStr } = require('../services/date-utils');
const { auditAgenda } = require('./lib/agenda-audit');

const HORIZONTE_DIAS = 365; // ninguna cita real se reserva más allá; evita escanear de más.

(async () => {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('❌ Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Configúralos en .env.');
        process.exit(1);
    }

    const orgId = SANTE_ORG_ID;
    const ahora = new Date();
    const desde = toLocalDateStr(ahora);
    const hasta = toLocalDateStr(new Date(ahora.getTime() + HORIZONTE_DIAS * 86400000));

    const cfg = await db.getAgentConfig(orgId);
    const catalog = Array.isArray(cfg?.services) ? cfg.services : [];
    if (!catalog.length) { console.error('❌ Catálogo de servicios vacío.'); process.exit(1); }

    const stylists = await db.getStylistsByOrg(orgId);
    if (!stylists.length) { console.error('❌ Sin estilistas activas.'); process.exit(1); }

    // Citas FUTURAS pendientes de atender. Las pasadas no se auditan: ya ocurrieron, y un
    // horario cambiado después no las convierte en un problema accionable.
    const citas = (await db.getAppointmentsByDateRange(orgId, desde, hasta))
        .filter(c => ['confirmed', 'pending'].includes(c.estado_cita))
        .filter(c => new Date(c.starts_at) >= ahora)
        .map(c => ({
            id: c.appointment_id,
            starts_at: c.starts_at,
            ends_at: c.ends_at,
            stylist_id: c.stylist_id,
            service: c.service,
            clienta: c.nombre,
            telefono: c.telefono,
        }));

    const schedules = new Map();
    const blocks = new Map();
    for (const s of stylists) {
        schedules.set(s.id, await db.getStylistSchedule(orgId, s.id));
        blocks.set(s.id, await db.getScheduleBlocks(orgId, s.id, `${desde}T00:00:00.000Z`, `${hasta}T23:59:59.999Z`));
    }

    const hallazgos = auditAgenda({ citas, stylists, schedules, blocks, catalog });
    const errores = hallazgos.filter(h => h.severidad === 'error');
    const avisos = hallazgos.filter(h => h.severidad === 'aviso');

    console.log(`\nCitas futuras confirmed/pending: ${citas.length} · Estilistas: ${stylists.length} · Ventana: ${desde} → ${hasta}`);

    const pinta = (h) => {
        console.log(`  ${h.severidad === 'error' ? '✗' : '⚠️ '} [${h.tipo}] ${h.cita.fecha} ${h.cita.hora}–${h.cita.fin} · ${h.cita.clienta} · ${h.cita.estilista}`);
        console.log(`      servicio: ${h.cita.servicio}`);
        console.log(`      → ${h.detalle}`);
    };

    if (errores.length) {
        console.log(`\n── Citas que hay que reubicar (${errores.length}) ──`);
        errores.forEach(pinta);
    }
    if (avisos.length) {
        console.log(`\n── Avisos (${avisos.length}) ──`);
        avisos.forEach(pinta);
    }

    if (!hallazgos.length) {
        console.log('\n✅ Todas las citas futuras encajan en el horario actual de su estilista.\n');
    } else {
        console.log(`\n${errores.length ? '❌' : '⚠️ '} ${errores.length} error(es) · ${avisos.length} aviso(s)\n`);
    }
    process.exit(errores.length ? 1 : 0);
})().catch(e => {
    console.error('Error fatal en la auditoría de agenda:', e);
    process.exit(1);
});
