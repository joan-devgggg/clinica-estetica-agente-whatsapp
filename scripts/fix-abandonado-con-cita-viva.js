#!/usr/bin/env node
/**
 * fix-abandonado-con-cita-viva.js — corrección PUNTUAL, de una sola ejecución.
 *
 * Contexto (04/08/2026). Al recargar una sesión, bot.js:2535 solo reconoce el estado
 * `pendiente_bizum` (el flujo Bizum de San Remo). Sante escribe `confirmado`, así que toda
 * recarga de una clienta de Sante caía en la rama "cliente recurrente": `reservaConfirmada`
 * se quedaba en false y el barrido de abandono (bot.js:4633) la marcaba `abandonado`
 * teniendo cita confirmada viva.
 *
 * El daño no es cosmético: `getLeadsPendientesRecordatorio` (db.js:475) filtra
 * `.eq('estado','confirmado')`, así que un contacto `abandonado` NO recibe el recordatorio
 * de 24 h. Tres clientas se quedaron fuera.
 *
 * Este script NO arregla la causa (eso va en bot.js, commit aparte). Solo repara las tres
 * filas para que el worker de recordatorios vuelva a verlas.
 *
 * Por qué no usa db.updateLeadById: escribe `updated_at`, toca `recordatorio_enviado` vía
 * resetRecordatorioIfConfirmado, y no comprueba las filas afectadas (solo `if (error)`), así
 * que un UPDATE que no case ninguna fila se vería como un guardado correcto. Aquí hace falta
 * precisión de columna y verificación de filas afectadas.
 *
 * Uso:
 *   node scripts/fix-abandonado-con-cita-viva.js            → SIMULACRO, no escribe nada
 *   node scripts/fix-abandonado-con-cita-viva.js --apply    → escribe
 */
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Madrid';

const supabase = require('../services/supabase');
const { SANTE_ORG_ID } = require('../services/org-registry');

const APPLY = process.argv.includes('--apply');

// Lista CERRADA. Cualquier UPDATE va contra uno de estos ids, nunca contra un criterio
// amplio: un `where estado='abandonado'` tocaría también a quien sí abandonó de verdad.
const OBJETIVOS = [
    { id: '68626a42-27e7-4e35-a02a-dade283cf7a3', phone: '34672023822',  nota: 'Gabriela Completo — cita HOY 17:30' },
    { id: '27927eec-dca2-4e92-8f72-46a74eb4dfbf', phone: '34624184532',  nota: 'sin nombre — cita 05/08 17:30' },
    { id: 'c91394e7-e78d-47ca-a655-e004f8175580', phone: '380674482502', nota: 'Ludmila Zarahovich — cita 28/08' },
];

const CAMPOS = 'id, wa_phone, full_name, estado, recordatorio_enviado, fecha_cita, hora_cita';

// Mismo invariante que assertRowsAffected en db.js (que es interno y no se exporta): un
// UPDATE cuyos .eq() no casan ninguna fila devuelve error=null. Sin esto, "corregido" sería
// indistinguible de "no tocó nada".
function assertRowsAffected(error, data, accion) {
    if (error) throw new Error(`${accion}: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`${accion}: el UPDATE no afectó a ninguna fila`);
    }
    if (data.length > 1) {
        throw new Error(`${accion}: el UPDATE afectó a ${data.length} filas, se esperaba 1`);
    }
}

function fmt(row) {
    if (!row) return '(no existe)';
    return `estado=${row.estado} · recordatorio_enviado=${row.recordatorio_enviado}`
        + ` · cita=${row.fecha_cita || '—'} ${row.hora_cita || ''} · nombre=${row.full_name ?? 'NULL'}`;
}

async function leerContacto(id) {
    const { data, error } = await supabase
        .from('contacts').select(CAMPOS)
        .eq('organization_id', SANTE_ORG_ID).eq('id', id).maybeSingle();
    if (error) throw new Error(`lectura de contacts: ${error.message}`);
    return data;
}

// Requisito: NO escribir si la cita ya no está viva. Se relee en el momento, no se confía
// en lo que se vio al preparar el script.
async function citasVivas(contactId) {
    const { data, error } = await supabase
        .from('appointments').select('id, service, starts_at, status')
        .eq('organization_id', SANTE_ORG_ID).eq('contact_id', contactId)
        .neq('status', 'cancelled').gt('starts_at', new Date().toISOString())
        .order('starts_at', { ascending: true });
    if (error) throw new Error(`lectura de appointments: ${error.message}`);
    return data || [];
}

(async () => {
    console.log(`\n${APPLY ? '⚠️  MODO ESCRITURA (--apply)' : '🔍 SIMULACRO — no se escribe nada'}`);
    console.log(`org: ${SANTE_ORG_ID}\n${'─'.repeat(78)}`);

    let corregidos = 0, saltados = 0, fallidos = 0;

    for (const obj of OBJETIVOS) {
        console.log(`\n▸ ${obj.phone} — ${obj.nota}`);
        try {
            const antes = await leerContacto(obj.id);
            if (!antes) { console.log('  SALTADO · el contacto no existe'); saltados++; continue; }
            if (antes.wa_phone !== obj.phone) {
                console.log(`  SALTADO · el teléfono no coincide (BD: ${antes.wa_phone})`); saltados++; continue;
            }
            console.log(`  ANTES:   ${fmt(antes)}`);

            const citas = await citasVivas(obj.id);
            if (citas.length === 0) {
                console.log('  SALTADO · ya NO tiene cita futura sin cancelar — no se toca'); saltados++; continue;
            }
            for (const c of citas) console.log(`  cita viva: ${c.starts_at} · ${c.service} · ${c.status}`);

            if (antes.estado !== 'abandonado') {
                console.log(`  SALTADO · estado ya es '${antes.estado}', no hay nada que corregir`); saltados++; continue;
            }

            if (!APPLY) {
                console.log("  SIMULACRO · escribiría estado='confirmado' (y NADA más)");
                corregidos++; continue;
            }

            // Solo la columna `estado`. Ni updated_at (dejarlo intacto evita, además, que la
            // fila vuelva a flotar al principio de "Actividad reciente"), ni recordatorio_enviado.
            // El .eq('estado','abandonado') hace el UPDATE idempotente y evita pisar un cambio
            // que haya entrado entre la lectura y la escritura.
            const { data, error } = await supabase
                .from('contacts').update({ estado: 'confirmado' })
                .eq('organization_id', SANTE_ORG_ID).eq('id', obj.id).eq('estado', 'abandonado')
                .select('id');
            assertRowsAffected(error, data, `UPDATE contacts ${obj.phone}`);

            const despues = await leerContacto(obj.id);
            console.log(`  DESPUÉS: ${fmt(despues)}`);
            if (despues?.estado !== 'confirmado') throw new Error('la relectura no confirma el cambio');
            console.log('  ✅ corregido');
            corregidos++;
        } catch (e) {
            console.error(`  ❌ FALLO · ${e.message}`);
            fallidos++;
        }
    }

    console.log(`\n${'─'.repeat(78)}`);
    console.log(`${APPLY ? 'corregidos' : 'se corregirían'}: ${corregidos} · saltados: ${saltados} · fallidos: ${fallidos}`);
    if (!APPLY) console.log('\nVuelve a lanzarlo con --apply para escribir.');
    process.exit(fallidos > 0 ? 1 : 0);
})();
