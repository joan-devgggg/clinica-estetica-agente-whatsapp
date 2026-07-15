/**
 * import-clientes-sante.js — Importación one-off de contactos a la tabla `contacts` de Sante.
 *
 * Lee data/clientes_sante_espana.xlsx (columnas: Nombre, Apellidos, Móvil (nacional),
 * Móvil (+34)) e inserta cada fila como contacto de Sante con origen='importado_shortcuts',
 * de forma que luego se puedan segmentar en Campañas como "nunca han reservado".
 *
 * Idempotente: reutiliza db.saveLead, que deduplica por teléfono (no duplica ni pisa
 * contactos reales; updateLead no toca `origen`).
 *
 * Uso:  node scripts/import-clientes-sante.js
 */

require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Madrid';

const path = require('path');
const XLSX = require('xlsx');
const { SANTE_ORG_ID } = require('../services/org-registry');
const db = require('../services/db');

const ORIGEN = 'importado_shortcuts';
const FILE = path.join(__dirname, '..', 'data', 'clientes_sante_espana.xlsx');

// Nombres de columna tolerantes a variaciones de tildes/espacios.
function pick(row, ...keys) {
    for (const k of keys) {
        if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
    }
    return '';
}

async function main() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('❌ Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.');
        process.exit(1);
    }

    const wb = XLSX.readFile(FILE);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    console.log(`📄 ${rows.length} filas leídas de ${path.basename(FILE)}`);
    console.log(`🏢 Org destino (Sante): ${SANTE_ORG_ID}\n`);

    let insertados = 0;
    let existentes = 0;
    let sinTelefono = 0;
    let errores = 0;

    for (const row of rows) {
        const nombre = [
            pick(row, 'Nombre'),
            pick(row, 'Apellidos'),
        ].filter(Boolean).join(' ').trim();

        // Móvil (+34) ya viene en E.164; fallback al nacional.
        const telefono = pick(row, 'Móvil (+34)', 'Movil (+34)', 'Móvil (nacional)', 'Movil (nacional)');
        if (!telefono) { sinTelefono++; continue; }

        try {
            const existing = await db.findByPhone(SANTE_ORG_ID, telefono);
            const id = await db.saveLead(SANTE_ORG_ID, {
                nombre: nombre || null,
                telefono,
                origen: ORIGEN,
            });
            if (!id) { sinTelefono++; continue; }
            if (existing) existentes++; else insertados++;
        } catch (e) {
            errores++;
            console.warn(`  ⚠️  ${telefono}: ${e.message}`);
        }
    }

    console.log('\n─── Resumen ─────────────────────');
    console.log(`  ✅ Insertados:      ${insertados}`);
    console.log(`  ↩️  Ya existentes:   ${existentes}`);
    console.log(`  ⏭️  Sin teléfono:    ${sinTelefono}`);
    if (errores) console.log(`  ❌ Errores:         ${errores}`);
    console.log('─────────────────────────────────');
}

main()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
