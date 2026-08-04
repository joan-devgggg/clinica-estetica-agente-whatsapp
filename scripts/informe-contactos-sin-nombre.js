/**
 * informe-contactos-sin-nombre.js — ¿A quién no sabemos cómo llamar?
 *
 * Uso:  npm run informe:nombres            (todas las orgs del registry)
 *       npm run informe:nombres -- sante   (una sola: sante | sanremo | <uuid>)
 *
 * SOLO LECTURA. No escribe absolutamente nada: ni rellena nombres, ni marca filas, ni deja
 * rastro. Rellenar automáticamente sería tentador —la mitad de los casos son "el nombre
 * está en la otra columna"— pero eso es una decisión con consecuencias visibles para la
 * clienta (el bot la saludaría con ese nombre) y la toma una persona, no un informe.
 *
 * Mira las DOS columnas, que fallan distinto:
 *   · contacts.full_name — NULLABLE. Es la que bloquea el recordatorio de 24 h.
 *   · appointments.full_name — NOT NULL: cuando falta es CADENA VACÍA, no null. Ningún
 *     `IS NULL` la encuentra.
 *
 * Sale con código 1 solo si hay hallazgos de severidad 'error' (cita futura de por medio:
 * hay algo que se va a romper con fecha). Los avisos se listan y no rompen nada.
 */

require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Madrid';

const { getAllOrgs } = require('../services/org-registry');
const db = require('../services/db');
const { auditNombres } = require('../tests/lib/nombres-audit');

// Acepta el alias corto del registry ('sante', 'sanremo'), el slug o el UUID: quien lanza
// esto a mano no se sabe los UUID de memoria.
function resolverOrgs(arg) {
    const orgs = getAllOrgs();
    if (!arg) return orgs;
    const q = String(arg).toLowerCase();
    const encontrada = orgs.find(o => o.orgId === arg || o.slug === q || o.sessionId === q);
    if (!encontrada) {
        console.error(`❌ No conozco la organización "${arg}". Opciones: ${orgs.map(o => o.sessionId).join(', ')}`);
        process.exit(1);
    }
    return [encontrada];
}

function fechaCorta(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function telefonoLegible(t) {
    const digits = String(t || '').replace(/\D/g, '');
    return digits ? `+${digits}` : '(sin teléfono)';
}

function pintar(h) {
    const marca = h.severidad === 'error' ? '✗' : '⚠️ ';
    if (h.columna === 'contacts.full_name') {
        console.log(`  ${marca} [${h.tipo}] ${telefonoLegible(h.telefono)} · guardado: ${h.guardado}`);
        if (h.proxima_cita) console.log(`      próxima cita: ${fechaCorta(h.proxima_cita)} (${h.citas_futuras} futura/s)`);
    } else {
        console.log(`  ${marca} [${h.tipo}] ${telefonoLegible(h.telefono)} · cita ${fechaCorta(h.starts_at)} · ${h.servicio || 'sin servicio'}`);
        console.log(`      appointments.full_name = ${h.guardado}`);
    }
    console.log(`      → ${h.detalle}`);
    if (h.rellenable_con) console.log(`      ↳ se puede copiar: "${h.rellenable_con}"`);
}

(async () => {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('❌ Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Configúralos en .env.');
        process.exit(1);
    }

    const orgs = resolverOrgs(process.argv[2]);
    const ahora = new Date();
    let erroresTotales = 0;

    for (const org of orgs) {
        const contactos = await db.getContactosParaInformeNombres(org.orgId);
        const citas = await db.getCitasParaInformeNombres(org.orgId);
        const { hallazgos, resumen } = auditNombres({ contactos, citas, ahora });

        console.log(`\n══ ${org.slug} ══`);
        console.log(`Contactos: ${resumen.contactos_totales} · Citas no canceladas: ${resumen.citas_totales}`);

        if (!hallazgos.length) {
            console.log('✅ Todos los contactos y todas las citas tienen un nombre con el que saludar.');
            continue;
        }

        const errores = hallazgos.filter(h => h.severidad === 'error');
        const avisos = hallazgos.filter(h => h.severidad === 'aviso');
        erroresTotales += errores.length;

        if (errores.length) {
            console.log(`\n── Con cita por delante: hay que arreglarlo antes (${errores.length}) ──`);
            errores.forEach(pintar);
        }
        if (avisos.length) {
            console.log(`\n── Huecos sin nada pendiente (${avisos.length}) ──`);
            avisos.forEach(pintar);
        }

        console.log(
            `\nResumen: ${resumen.contactos_sin_nombre} contacto(s) sin nombre · `
            + `${resumen.citas_sin_nombre} cita(s) sin nombre · `
            + `${resumen.rellenables} se arreglan copiando de la otra columna.`
        );
    }

    console.log('');
    process.exit(erroresTotales ? 1 : 0);
})().catch(e => {
    console.error('Error fatal en el informe de nombres:', e);
    process.exit(1);
});
