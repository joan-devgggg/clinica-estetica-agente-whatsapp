/**
 * auditoria-snapshot-divergente.js — Busca citas cuyo importe CONGELADO (precio_facturado)
 * ya no cuadra con lo que hoy calcularía el catálogo a partir de su `service`.
 *
 * Por qué existe. `stampBillingSnapshot` solo sella en la transición → completed y se salta
 * las filas con facturado_at; `updateAppointment` nunca toca las columnas de facturación.
 * Editar el `service` de una cita YA sellada cambia el servicio y no el dinero: el informe
 * sigue mostrando el importe viejo como cifra buena, con "sin calcular: 0". Cero avisos.
 * Caso que lo destapó: la cita 7d32c9b0 congeló 220 € y luego se le añadió "Difuminado de
 * raíz" (40 €) desde el panel.
 *
 * NO puede ser una query SQL. El matcher vive en JS: splitServiceNames recompone por
 * longest-match los nombres de catálogo que llevan " + " dentro ("Reconstrucción K18 +
 * lavar y peinar"), buildFullServiceName desambigua las variantes genéricas ("Largo 2"
 * existe 4 veces con 4 precios) y el K18 se resuelve por contexto. Postgres no sabe nada
 * de eso.
 *
 * ⚠️ Una divergencia NO es necesariamente un error. Este script compara PRECIOS, y por eso
 * marca también las subidas legítimas del catálogo — que son justo lo que el snapshot
 * existe para absorber: si "Mechas Contouring" subió de 160 a 175 después de sellar, esta
 * cita aparecerá aquí y su congelado es CORRECTO. Distinguir un caso de otro requiere
 * mirar la fecha del cambio de precio en las migraciones. Por eso la salida se revisa a
 * mano y NUNCA se repara en bloque.
 *
 * SOLO LECTURA: no escribe absolutamente nada. No tiene --apply a propósito.
 *
 * Uso:
 *   npm run audit:snapshot
 *   node scripts/auditoria-snapshot-divergente.js --org=<uuid>   # por defecto, Sante
 */

require('dotenv').config();

const { SANTE_ORG_ID } = require('../services/org-registry');
const db = require('../services/db');
const { computeServiceBilling } = require('../services/helpers');

const argOrg = process.argv.find(a => a.startsWith('--org='));
const ORG_ID = argOrg ? argOrg.slice('--org='.length) : SANTE_ORG_ID;

const eur = n => `${Number(n).toFixed(2)} €`;

async function main() {
    if (!ORG_ID) {
        console.error('Sin org: define SANTE_ORG_ID o pasa --org=<uuid>.');
        process.exit(1);
    }

    const cfg = await db.getAgentConfig(ORG_ID);
    const catalogo = cfg?.services || [];
    if (!catalogo.length) {
        // Sin catálogo, computeServiceBilling deja TODO en 'unmatched' y el informe saldría
        // vacío de divergencias: un falso "todo correcto". Mejor no informar que mentir.
        console.error('El catálogo de la org vino vacío. Abortando: sin precios no se puede auditar.');
        process.exit(1);
    }

    // Rango deliberadamente amplio: la auditoría es del histórico completo, no de un mes.
    const citas = await db.getCompletedAppointmentsForBilling(ORG_ID, '2000-01-01', '2100-12-31');

    const selladas = citas.filter(c => c.facturado_at && c.precio_facturado != null);
    const sinSellar = citas.length - selladas.length;

    const divergentes = [];
    const noRecalculables = [];

    for (const cita of selladas) {
        const { totalConIva, segments } = computeServiceBilling(cita.service, catalogo);
        const recalculable = segments.length > 0 && segments.every(s => s.status === 'ok');
        const congelado = Number(cita.precio_facturado);

        if (!recalculable) {
            // No se puede comparar: hoy el catálogo no sabe valorar este servicio. No es
            // prueba de que el congelado esté mal (pudo sellarse cuando sí se sabía), pero
            // tampoco se puede confirmar. Se listan aparte, sin veredicto.
            noRecalculables.push({ cita, segments, congelado });
            continue;
        }
        if (Math.abs(totalConIva - congelado) > 0.01) {
            divergentes.push({ cita, congelado, calculado: totalConIva, delta: totalConIva - congelado });
        }
    }

    console.log('\n=== AUDITORÍA DE SNAPSHOTS DIVERGENTES ===');
    console.log(`org: ${ORG_ID}`);
    console.log(`citas completed: ${citas.length}  |  con snapshot: ${selladas.length}  |  sin snapshot: ${sinSellar}`);

    console.log(`\n--- DIVERGENTES: ${divergentes.length} ---`);
    if (!divergentes.length) {
        console.log('(ninguna: todo importe congelado coincide con el recálculo de hoy)');
    }
    for (const d of divergentes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
        console.log(`\n  cita ${d.cita.appointment_id}`);
        console.log(`    fecha      ${String(d.cita.starts_at).slice(0, 10)}   estilista: ${d.cita.stylist_name || '—'}   cliente: ${d.cita.cliente || '—'}`);
        console.log(`    service    ${d.cita.service}`);
        console.log(`    congelado  ${eur(d.congelado)}   (sellado ${String(d.cita.facturado_at).slice(0, 19)})`);
        console.log(`    calculado  ${eur(d.calculado)}`);
        console.log(`    delta      ${d.delta > 0 ? '+' : ''}${d.delta.toFixed(2)} €`);
    }

    console.log(`\n--- NO COMPARABLES (el catálogo de hoy no sabe valorar el servicio): ${noRecalculables.length} ---`);
    if (!noRecalculables.length) console.log('(ninguna)');
    for (const n of noRecalculables) {
        const malos = n.segments.filter(s => s.status !== 'ok').map(s => `${s.name} [${s.status}]`);
        console.log(`\n  cita ${n.cita.appointment_id}  ${String(n.cita.starts_at).slice(0, 10)}  congelado ${eur(n.congelado)}`);
        console.log(`    service   ${n.cita.service}`);
        console.log(`    problema  ${malos.join(' | ') || '(service vacío)'}`);
    }

    console.log('\n--- QUÉ HACER CON ESTO ---');
    console.log('Revisa CADA divergente a mano antes de reparar nada:');
    console.log('  · Si el precio del servicio cambió en el catálogo DESPUÉS de sellar → el congelado');
    console.log('    es CORRECTO. No tocar: el snapshot está haciendo justo su trabajo.');
    console.log('  · Si el `service` se editó después de sellar (y los precios no se han movido)');
    console.log('    → el congelado perdió su sujeto y toca repararlo.');
    console.log('Contrasta las fechas con supabase/migrations/ antes de decidir.\n');
}

main().catch(e => {
    console.error('ERROR:', e.message);
    process.exit(1);
});
