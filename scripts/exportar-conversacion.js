#!/usr/bin/env node
/**
 * exportar:conversacion — el esqueleto de un fixture del CORPUS DE ORO, desde la BD real.
 *
 *   npm run exportar:conversacion -- sante 34652903713          (org + teléfono)
 *   npm run exportar:conversacion -- sante 34652903713 > tests/fixtures/corpus/slug.json
 *
 * SOLO LECTURA. Imprime por stdout un fixture con:
 *   · los turnos emparejados por timestamp desde `messages` (entrantes agrupados hasta el
 *     siguiente saliente; los entrantes SIN saliente quedan como turno con saliente:null),
 *   · las anclas: TODAS las citas del contacto (getAppointmentsByLead) y sus
 *     pending_actions, con created_at/source/status para poder anclar veredictos,
 *   · cada turno con "clase": "sin_clasificar" — CLASIFICAR ES TRABAJO DE LA AUDITORÍA,
 *     este script no emite veredictos. La regla de admisión está en el _meta que genera.
 *
 * Lo que este export NO contiene, y hay que recordar al clasificar (hecho 1 de CLAUDE.md):
 * las respuestas de la dueña desde el móvil no están en messages (Coexistence), ni las
 * plantillas de campaña, ni los recordatorios. Un hueco sin saliente NO es un silencio.
 */
// quiet: el banner de dotenv sale por STDOUT y este script imprime JSON por stdout —
// sin esto, `> fixture.json` produce un fichero que JSON.parse rechaza.
require('dotenv').config({ quiet: true });
process.env.TZ = process.env.TZ || 'Europe/Madrid';

const { resolverOrgArg } = require('../services/org-registry');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Configúralos en .env.');
    process.exit(2);
}

const db = require('../services/db');

const [orgArg, telefono] = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!orgArg || !telefono) {
    console.error('Uso: npm run exportar:conversacion -- <org> <telefono>');
    process.exit(2);
}

(async () => {
    // resolverOrgArg devuelve un ARRAY de orgs que casan con el alias/slug/UUID.
    const orgs = resolverOrgArg(orgArg) || [];
    if (orgs.length !== 1) {
        console.error(`❌ Org ${orgs.length ? 'ambigua' : 'desconocida'}: ${orgArg}`);
        process.exit(2);
    }
    const orgId = orgs[0].orgId;

    const contact = await db.findByPhone(orgId, telefono);
    if (!contact) { console.error(`❌ Sin contacto para ${telefono}`); process.exit(2); }

    const mensajes = await db.getMessages(orgId, telefono, { limit: 500 });
    if (!mensajes.length) { console.error(`❌ El contacto existe pero no tiene mensajes en messages`); process.exit(2); }

    const citas = await db.getAppointmentsByLead(orgId, contact.id);
    const pendientes = (await db.getPendingActionsBarrido(orgId))
        .filter(p => (p.contact_id || p.contactId) === contact.id);

    // Turnos: entrantes acumulados hasta el siguiente saliente. Salientes consecutivos
    // van cada uno en su turno (con entrante []). Entrantes finales sin saliente → un
    // turno con saliente:null, que la clasificación casi siempre excluirá (hecho 1).
    const turnos = [];
    let entrantes = [];
    for (const m of mensajes) {
        if (m.direccion === 'entrante') { entrantes.push(m); continue; }
        turnos.push({
            n: turnos.length + 1,
            ts: m.timestamp,
            entrante: entrantes.map(e => e.contenido),
            saliente: m.contenido,
            es_manual: m.es_manual || undefined,
            clase: 'sin_clasificar',
        });
        entrantes = [];
    }
    if (entrantes.length) {
        turnos.push({
            n: turnos.length + 1,
            ts: entrantes[entrantes.length - 1].timestamp,
            entrante: entrantes.map(e => e.contenido),
            saliente: null,
            clase: 'sin_clasificar',
            nota: 'Entrantes sin saliente registrado: puede ser Coexistence (móvil de la dueña), no un silencio. Casi seguro excluido.',
        });
    }

    const hoy = new Date().toISOString().slice(0, 10);
    const fixture = {
        _meta: {
            NO_ES_LA_CONVERSACION_VIVA: `Foto de messages tomada el ${hoy}. No se sincroniza.`,
            que_es: 'Esqueleto de fixture del corpus de oro (tests/corpus-oro.test.js). CLASIFICAR es trabajo de la auditoría: clase por turno (fallo_anclado / correcto_anclado / neutro / excluido con motivo), espera con detectores reales, y CADA ancla verificada contra la BD antes de congelarla.',
            regla_de_admision: 'Solo entra lo comprobable contra estado positivo: los textos congelados, filas de appointments/pending_actions (sin agujero de Coexistence), snapshots de catálogo/business_hours. Todo veredicto que descanse en un silencio de messages o en estado de sesión irrecuperable (availableSlots de un instante pasado, datos del LLM) va a excluido, con motivo.',
            contacto: contact.nombre || null,
            wa_phone: telefono,
            contact_id: contact.id,
            rango: [mensajes[0].timestamp, mensajes[mensajes.length - 1].timestamp],
            auditoria_origen: 'RELLENAR: el informe del que sale el veredicto',
            idioma: contact.language || contact.idioma || 'es',
            verificado_el: 'RELLENAR al clasificar',
            verificado_como: 'RELLENAR: qué se releyó contra la BD',
        },
        business_hours: 'RELLENAR: snapshot de agent_configs.business_hours del día del export',
        anclas: {
            citas: citas.map(c => ({
                service: c.service, starts_at: c.starts_at, ends_at: c.ends_at || undefined,
                status: c.status, source: c.source || undefined, created_at: c.created_at,
                stylist: c.stylists?.name || null,
            })),
            pending_actions: pendientes.map(p => ({
                type: p.type, status: p.status, created_at: p.created_at,
                payload_motivo: p.payload?.motivo || undefined,
            })),
        },
        turnos,
    };

    console.log(JSON.stringify(fixture, null, 2));
    process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(2); });
