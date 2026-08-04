/**
 * classify-sante-language-by-name.js — Clasifica por heurística de nombre los contactos de
 * Sante importados (origen='importado_shortcuts') cuyo `language` sigue en el valor por
 * defecto ('es') SIN haberse verificado nunca por conversación real.
 *
 * "Verificado" = tiene al menos un mensaje inbound registrado. Esos contactos NO se tocan:
 * si detectLanguage() (services/helpers.js) ya vio un mensaje real, confiamos en ese valor
 * aunque sea 'es' — pisarlo con una heurística de nombre sería ir hacia atrás, no hacia
 * adelante. Solo se reclasifican los que jamás han escrito.
 *
 * La heurística (services/language-name-heuristic.js) es conservadora a propósito: nombres/
 * apellidos ambiguos con uso real en España se quedan en 'es' sin cambios (punto 4 del
 * encargo). Cuando SÍ hay señal clara, el valor sugerido es 'ru' — no porque se sepa que es
 * ruso y no ucraniano (no se puede distinguir de forma fiable por nombre), sino como valor
 * por defecto razonable para la comunidad — y se marca explícitamente como inferencia, nunca
 * como dato confirmado (contacts.metadata.language_inferred).
 *
 * Por defecto es DRY-RUN: solo informa cuántos contactos cambiarían y con qué señal, sin
 * escribir nada. Solo aplica los cambios con --apply.
 *
 * Uso:
 *   node scripts/classify-sante-language-by-name.js            # dry-run (informe)
 *   node scripts/classify-sante-language-by-name.js --apply    # aplica los cambios
 */

require('dotenv').config();

const path = require('path');
const XLSX = require('xlsx');
const { SANTE_ORG_ID } = require('../services/org-registry');
const db = require('../services/db');
const { classifyLanguageByName } = require('../services/language-name-heuristic');

const ORIGEN_IMPORTADO = 'importado_shortcuts';
const FILE = path.join(__dirname, '..', 'data', 'clientes_sante_espana.xlsx');
const APPLY = process.argv.includes('--apply');

function pick(row, ...keys) {
    for (const k of keys) {
        if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
    }
    return '';
}

function sanitizePhone(phone) {
    if (!phone) return '';
    return String(phone).replace(/["'\s]/g, '').replace(/@c\.us$|@lid$/g, '').replace(/\D/g, '').trim();
}

// Nombre/Apellidos por separado desde el Excel origen (más preciso que partir full_name a
// ciegas: evita que un apellido compuesto de dos palabras se confunda con el nombre).
function loadExcelNamesByPhone() {
    const wb = XLSX.readFile(FILE);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const byPhone = new Map();
    for (const row of rows) {
        const telefono = sanitizePhone(pick(row, 'Móvil (+34)', 'Movil (+34)', 'Móvil (nacional)', 'Movil (nacional)'));
        if (!telefono) continue;
        byPhone.set(telefono, {
            nombre: pick(row, 'Nombre'),
            apellidos: pick(row, 'Apellidos'),
        });
    }
    return byPhone;
}

// Fallback cuando el contacto no aparece en el Excel (p.ej. se editó desde el panel):
// primer token = nombre, resto = apellidos.
function splitFullName(fullName) {
    const tokens = (fullName || '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { nombre: '', apellidos: '' };
    return { nombre: tokens[0], apellidos: tokens.slice(1).join(' ') };
}

async function getAllSanteContacts() {
    const all = [];
    const limit = 500;
    let offset = 0;
    for (;;) {
        const page = await db.getAllLeads(SANTE_ORG_ID, { limit, offset });
        all.push(...page);
        if (page.length < limit) break;
        offset += limit;
    }
    return all;
}

async function main() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('❌ Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.');
        process.exit(1);
    }

    console.log(`Modo: ${APPLY ? 'APLICAR CAMBIOS' : 'DRY-RUN (solo informe, no escribe nada)'}\n`);

    const excelNames = loadExcelNamesByPhone();
    const contacts = await getAllSanteContacts();
    const imported = contacts.filter(c => c.origen === ORIGEN_IMPORTADO);
    console.log(`📄 Contactos totales de Sante: ${contacts.length}`);
    console.log(`📥 Contactos con origen='${ORIGEN_IMPORTADO}': ${imported.length}\n`);

    const candidates = imported.filter(c => (c.language || 'es') === 'es');
    const alreadyNonEs = imported.length - candidates.length;
    if (alreadyNonEs > 0) {
        console.log(`⏭️  ${alreadyNonEs} ya tienen language != 'es' (ya corregido por conversación real) — no se tocan.`);
    }

    const toChange = [];
    const verifiedSkipped = [];
    const staysEs = [];

    for (const c of candidates) {
        const lastInbound = await db.getLastInboundAt(SANTE_ORG_ID, c.telefono);
        if (lastInbound) {
            // Ya hay un mensaje real de la clienta: el 'es' actual es (o fue) un valor
            // verificado por detectLanguage, no el default sin tocar. No se toca.
            verifiedSkipped.push(c);
            continue;
        }

        const fromExcel = excelNames.get(sanitizePhone(c.telefono));
        const { nombre, apellidos } = fromExcel || splitFullName(c.nombre);
        const { suggested, matched } = classifyLanguageByName(nombre, apellidos);

        if (suggested) {
            toChange.push({ contact: c, suggested, matched });
        } else {
            staysEs.push(c);
        }
    }

    console.log(`✅ Verificados por conversación real (con inbound, no se tocan): ${verifiedSkipped.length}`);
    console.log(`🟦 Se quedan en 'es' (heurística sin señal eslava): ${staysEs.length}`);
    console.log(`🟨 Cambiarían de 'es' a inferido por nombre: ${toChange.length}\n`);

    if (toChange.length > 0) {
        console.log('─── Contactos que cambiarían ─────────────────────────');
        for (const { contact, suggested, matched } of toChange) {
            console.log(`  ${contact.telefono}  "${contact.nombre || '(sin nombre)'}"  es → ${suggested}  [${matched.join(', ')}]`);
        }
        console.log('────────────────────────────────────────────────────\n');
    }

    if (!APPLY) {
        console.log(`Esto era un DRY-RUN: no se ha escrito nada. Revisa la lista de arriba y vuelve a lanzar con --apply si estás de acuerdo.`);
        return;
    }

    console.log('Aplicando cambios…');
    let applied = 0;
    let errores = 0;
    for (const { contact, suggested, matched } of toChange) {
        try {
            await db.setInferredContactLanguage(SANTE_ORG_ID, contact.id, suggested, matched);
            applied++;
        } catch (e) {
            errores++;
            console.warn(`  ⚠️  ${contact.telefono}: ${e.message}`);
        }
    }
    console.log(`\n✅ Aplicados: ${applied}`);
    if (errores) console.log(`❌ Errores: ${errores}`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
