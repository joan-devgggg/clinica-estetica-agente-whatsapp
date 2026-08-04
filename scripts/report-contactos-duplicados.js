/**
 * report-contactos-duplicados.js — Informe SOLO LECTURA de contactos duplicados por teléfono.
 *
 * Contexto (01/08/2026): al dar de alta una cita a mano en el panel se escribió el teléfono de
 * una clienta sin el prefijo 34. `UNIQUE (organization_id, wa_phone)` compara el string
 * literal, así que '611209542' y '34611209542' son dos claves distintas y se creó un contacto
 * duplicado con la cita colgando de él, invisible para el bot.
 *
 * sanitizePhone ya lo impide hacia delante, y las lecturas de citas del bot ahora miran todas
 * las variantes del número (db.findContactIdsByPhone), así que el bot ya no se queda ciego.
 * Lo que queda son las filas duplicadas que ya están en producción, y fusionarlas es una
 * decisión con el informe delante — no algo que deba hacer un script por su cuenta.
 *
 * ESTE SCRIPT NO ESCRIBE NADA. Solo agrupa, cuenta y vuelca un CSV.
 *
 * Uso:
 *   node scripts/report-contactos-duplicados.js              # todas las orgs
 *   node scripts/report-contactos-duplicados.js <ORG_UUID>   # una org concreta
 */

require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Madrid';

const fs = require('fs');
const path = require('path');
const supabase = require('../services/supabase');
const { phoneVariants } = require('../services/db');

const SALIDA = path.join(__dirname, '..', 'data', 'contactos-duplicados.csv');

// Clave de agrupación: la forma canónica que devuelve phoneVariants. Dos filas cuyo wa_phone
// difiere solo en el prefijo o en el '+' comparten canónica y por tanto son la misma persona.
function claveCanonica(waPhone) {
    const v = phoneVariants(waPhone);
    return v.length ? v[0] : null;
}

async function main() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('❌ Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.');
        process.exit(1);
    }
    const orgFiltro = process.argv[2] || null;

    let q = supabase
        .from('contacts')
        .select('id, organization_id, wa_phone, full_name, created_at')
        .order('created_at', { ascending: true });
    if (orgFiltro) q = q.eq('organization_id', orgFiltro);
    const { data: contactos, error } = await q;
    if (error) {
        console.error('❌ Error leyendo contacts:', error.message);
        process.exit(1);
    }

    // Agrupar por (org, teléfono canónico).
    const grupos = new Map();
    let sinClave = 0;
    for (const c of contactos || []) {
        const clave = claveCanonica(c.wa_phone);
        if (!clave) { sinClave++; continue; }
        const k = `${c.organization_id}|${clave}`;
        if (!grupos.has(k)) grupos.set(k, []);
        grupos.get(k).push(c);
    }

    const duplicados = [...grupos.entries()]
        .filter(([, filas]) => filas.length > 1)
        .sort((a, b) => b[1].length - a[1].length);

    console.log(`\n📇 Contactos leídos: ${contactos?.length || 0}${orgFiltro ? ` (org ${orgFiltro})` : ''}`);
    if (sinClave) console.log(`⚠️  ${sinClave} con wa_phone no normalizable (se ignoran)`);
    if (!duplicados.length) {
        console.log('✅ No hay contactos duplicados por teléfono.\n');
        return;
    }
    console.log(`⚠️  Grupos duplicados: ${duplicados.length}\n`);

    // Citas y mensajes por contacto, para saber cuál de las filas es la que "pesa".
    const idsAfectados = duplicados.flatMap(([, filas]) => filas.map(f => f.id));
    const conteo = async (tabla, ids) => {
        const acc = new Map();
        const TROZO = 200;   // el filtro .in() de PostgREST va en la URL: no cabe todo de golpe
        for (let i = 0; i < ids.length; i += TROZO) {
            const { data, error: e } = await supabase
                .from(tabla).select('contact_id, starts_at').in('contact_id', ids.slice(i, i + TROZO));
            if (e) { console.error(`❌ Error leyendo ${tabla}:`, e.message); process.exit(1); }
            for (const r of data || []) {
                const prev = acc.get(r.contact_id) || { total: 0, futuras: 0 };
                prev.total++;
                if (r.starts_at && new Date(r.starts_at) > new Date()) prev.futuras++;
                acc.set(r.contact_id, prev);
            }
        }
        return acc;
    };
    const citas = await conteo('appointments', idsAfectados);
    const mensajes = await conteo('messages', idsAfectados);

    const csv = ['organization_id,telefono_canonico,contact_id,wa_phone,full_name,created_at,citas,citas_futuras,mensajes'];
    for (const [k, filas] of duplicados) {
        const [orgId, canonico] = k.split('|');
        console.log(`── ${canonico}  (${filas.length} filas, org ${orgId.slice(0, 8)}…)`);
        for (const f of filas) {
            const c = citas.get(f.id) || { total: 0, futuras: 0 };
            const m = mensajes.get(f.id) || { total: 0 };
            const marca = f.wa_phone === canonico ? '★' : ' ';
            console.log(`   ${marca} ${f.id}  ${String(f.wa_phone).padEnd(14)} ${String(f.full_name || '—').padEnd(24)} citas:${c.total} (futuras:${c.futuras})  msgs:${m.total}  alta:${String(f.created_at).slice(0, 10)}`);
            csv.push([
                orgId, canonico, f.id, f.wa_phone,
                `"${String(f.full_name || '').replace(/"/g, '""')}"`,
                f.created_at, c.total, c.futuras, m.total,
            ].join(','));
        }
        console.log('');
    }

    fs.writeFileSync(SALIDA, csv.join('\n') + '\n', 'utf8');
    console.log(`📄 CSV: ${SALIDA}`);
    console.log('★ = la fila cuyo wa_phone ya está en forma canónica.\n');
    console.log('Nada se ha modificado. Fusionar (mover citas/mensajes a una fila y borrar la otra)');
    console.log('es una decisión aparte: hazla con backup y revisando este informe.\n');
}

main().catch(e => { console.error('❌', e); process.exit(1); });
