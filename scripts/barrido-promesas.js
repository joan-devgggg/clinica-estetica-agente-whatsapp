#!/usr/bin/env node
/**
 * barrido:promesas — ¿Qué promesas del BOT no tienen ninguna fila detrás?
 *
 *   npm run barrido:promesas                        (todas las orgs, sin ventana)
 *   npm run barrido:promesas -- sante               (una: alias, slug o UUID)
 *   npm run barrido:promesas -- sante --desde 2     (CRON: solo alarma lo de ≤2 días)
 *
 * `--desde <días>` es la ventana de ALARMA, no de lectura: se imprime TODO igual, pero
 * el exit code solo depende de los hallazgos cuyo saliente cae dentro. Sin ella, un
 * hallazgo histórico gritaría exit 1 todas las noches para siempre y en dos semanas
 * nadie miraría (caja_atribucion_desajustada). La corrida manual va sin ventana.
 *
 * SOLO LECTURA. Cruza los salientes del bot de clase C1 (cita hecha/cancelada) y C7
 * (traspaso a una persona) contra appointments y pending_actions. Inmune a Coexistence:
 * mide solo lo que el bot escribió (siempre entero en messages); ningún desenlace se
 * apoya en un silencio ni afirma nada sobre la atención humana.
 *
 * Códigos de salida:
 *   0  sin promesas sin respaldo (las «salvadas a mano» se imprimen pero tienen fila)
 *   1  ≥1 promesa ROTA, PARCIAL o ACEPTADA SIN ESCALADA (la oferta sin respuesta
 *      es INFO: no hay fila que deber)
 *   2  lectura rota o excepción — este resultado NO dice que haya 0 promesas
 *
 * Importa bot.js (por sus detectores, vía la lib): sus tres intervalos de módulo llevan
 * .unref() y no cuelgan el proceso; la trampa real es metrics.js, que en una salida
 * NATURAL escribe metrics.json desde `beforeExit`. Por eso este script termina SIEMPRE
 * con process.exit() explícito — ni cuelga, ni escribe nada.
 */
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Madrid';

const { resolverOrgArg } = require('../services/org-registry');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Configúralos en .env.');
    process.exit(2);
}

const db = require('../services/db');
const { auditPromesas, DESENLACES_MAL } = require('../tests/lib/promesas-audit');

const DESENLACE_LABEL = {
    rota: '❌ ROTA — promesa sin ninguna fila detrás',
    parcial: '⚠️  PARCIAL — la triple escritura quedó a medias',
    aceptada_sin_escalada: '❌ ACEPTADA SIN ESCALADA — la clienta dijo sí y no existe fila (tras el anillo 1, esto solo lo produce un bug)',
    oferta_sin_respuesta: 'ℹ️  OFERTA SIN RESPUESTA — se ofreció y no hubo aceptación; no hay fila que deber',
    remision_afirmativa_sin_respuesta: 'ℹ️  REMISIÓN AFIRMATIVA SIN RESPUESTA — la promesa se hizo en afirmativo y no hubo respuesta; sin fila (residuo en medición)',
    salvada_a_mano: '🖐  SALVADA A MANO — mentira en el momento; una persona la hizo verdad después',
    no_verificable: '❓ NO VERIFICABLE — la huella de aquel turno ya no existe',
};

const fmtFecha = iso => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso)
        : d.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
};

// Args: un posible org (posicional) y un posible `--desde <días>`, en cualquier orden.
// Un valor de --desde que no sea un número positivo es exit 2, no «sin ventana»: un typo
// en el cron no puede degradar la alarma en silencio.
function parseArgs(argv) {
    let orgArg = null;
    let desdeDias = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--desde') {
            desdeDias = Number(argv[i + 1]);
            i++;
            if (!Number.isFinite(desdeDias) || desdeDias <= 0) return { error: `--desde necesita un número de días positivo (recibí "${argv[i] ?? ''}")` };
        } else if (!orgArg) {
            orgArg = argv[i];
        } else {
            return { error: `argumento no reconocido: "${argv[i]}"` };
        }
    }
    return { orgArg, desdeDias };
}

(async () => {
    const { orgArg, desdeDias, error } = parseArgs(process.argv.slice(2));
    if (error) {
        console.error(`❌ ${error}\n   Uso: barrido:promesas [org] [--desde <días>]`);
        process.exit(2);
    }
    const orgs = resolverOrgArg(orgArg);
    if (!orgs) {
        console.error(`❌ No conozco la organización "${orgArg}". Prueba con: sante, sanremo, un slug o un UUID.`);
        process.exit(2);
    }
    const alarmaDesdeMs = desdeDias ? Date.now() - desdeDias * 24 * 3600 * 1000 : null;

    let hayMalTotal = false;

    for (const org of orgs) {
        const [salientes, citas, pendingActions, contactos, entrantes] = await Promise.all([
            db.getSalientesBotBarrido(org.orgId),
            db.getCitasBarrido(org.orgId),
            db.getPendingActionsBarrido(org.orgId),
            db.getContactosBarrido(org.orgId),
            db.getEntrantesBarrido(org.orgId),
        ]);

        const { hallazgos, resumen, cobertura, hayMal, clases } =
            auditPromesas({ salientes, citas, pendingActions, contactos, entrantes, alarmaDesdeMs });
        hayMalTotal = hayMalTotal || hayMal;

        console.log(`\n═══ ${org.sessionId.toUpperCase()} · barrido de promesas ═══`);
        console.log(`${salientes.length} salientes del bot revisados`);
        if (alarmaDesdeMs) {
            console.log(`⏰ Ventana de alarma: últimos ${desdeDias} día(s). Lo anterior se imprime igual, marcado, y NO cambia el exit code.`);
        }
        console.log('');

        // Resumen por clase (incluye lo respaldado: el denominador importa para leer el 0).
        for (const [clase, porDesenlace] of Object.entries(resumen)) {
            const partes = Object.entries(porDesenlace).map(([d, n]) => `${d}: ${n}`).join(' · ');
            console.log(`  ${clases[clase]} → ${partes}`);
        }

        if (!hallazgos.length) {
            console.log('\n✅ Todas las promesas detectadas tienen su fila detrás.');
        } else {
            // Agrupado clase → desenlace, una línea por hallazgo.
            const orden = ['rota', 'parcial', 'aceptada_sin_escalada', 'salvada_a_mano', 'no_verificable', 'remision_afirmativa_sin_respuesta', 'oferta_sin_respuesta'];
            for (const desenlace of orden) {
                const grupo = hallazgos.filter(h => h.desenlace === desenlace);
                if (!grupo.length) continue;
                console.log(`\n${DESENLACE_LABEL[desenlace] || desenlace} (${grupo.length}):`);
                for (const h of grupo) {
                    const quien = h.nombre ? `${h.telefono} (${h.nombre})` : h.telefono;
                    const marca = h.enVentanaAlarma ? '' : ' [fuera de la ventana de alarma]';
                    console.log(`  · ${quien} · ${fmtFecha(h.fecha)}${marca} · «${h.frase}…»`);
                    console.log(`      ${h.claseLabel} — ${h.detalle}`);
                }
            }
        }

        console.log('\n─── Cobertura declarada de este barrido ───');
        for (const linea of cobertura) console.log(`  · ${linea}`);
    }

    console.log('');
    process.exit(hayMalTotal ? 1 : 0);
})().catch(e => {
    // Una lectura rota (assertRead) cae aquí. Exit 2 y este texto, a propósito distintos
    // del «0 promesas»: la trampa histórica es publicar un informe falso porque un error
    // de lectura se disfrazó de resultado limpio.
    console.error(`\n❌ El barrido no pudo correr: ${e.message}`);
    console.error('   Este resultado NO dice que haya 0 promesas sin respaldo.');
    process.exit(2);
});
