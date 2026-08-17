#!/usr/bin/env node
/**
 * informe:escaladas — ¿Qué escaladas pasaron por el protocolo de dos turnos y cuáles no?
 *
 *   npm run informe:escaladas -- sante
 *   npm run informe:escaladas -- sante --desde 14      (ventana en días NATURALES)
 *
 * SOLO LECTURA. No escribe nada, ni en Supabase ni en disco.
 *
 * Corre además pegado al final de `barrido:promesas`, en la misma tanda y a propósito: un
 * informe de solo lectura que hay que acordarse de lanzar no lo lanza nadie, y los dos miden
 * las dos mitades del mismo aparato (este, las escaladas que EXISTEN; el barrido, las que se
 * prometieron y no llegaron a existir).
 *
 * Códigos de salida:
 *   0  siempre que se haya podido leer — este informe es INFORMATIVO y no alarma por sí solo.
 *      La alarma de promesas rotas es del barrido, y conflacionarlas emborronaría qué
 *      significa un exit 1.
 *   2  lectura rota o excepción — este resultado NO dice que haya 0 escaladas.
 */
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Madrid';

const { resolverOrgArg } = require('../services/org-registry');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Configúralos en .env.');
    process.exit(2);
}

const db = require('../services/db');
const { auditEscaladas, contarCodas, cobertura, LECTURAS, VENTANA_DECISION_DIAS } = require('../tests/lib/escaladas-audit');

const ICONO = {
    protocolo_completo: '✅',
    tras_si: '✅',
    sin_preguntar: '⚡',
    sin_entrante: '❔',
};

function parseArgs(argv) {
    let org = null;
    let desde = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--desde') {
            const n = Number(argv[++i]);
            if (!Number.isFinite(n) || n <= 0) return { error: '--desde requiere un número de días > 0' };
            desde = n;
        } else if (!org) {
            org = argv[i];
        } else {
            return { error: `argumento no reconocido: ${argv[i]}` };
        }
    }
    return { org, desde };
}

function fmt(iso) {
    return new Date(iso).toLocaleString('es-ES', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid',
    });
}

/**
 * El impresor, EXPORTADO: lo usa este script y lo usa `barrido:promesas`, que lo pega al final
 * de su tanda con las lecturas que ya tiene. Una sola implementación — si se copiara, en la
 * primera corrección se separarían y cada tanda contaría una cosa distinta.
 *
 * Recibe los datos ya leídos: no toca la BD.
 */
function imprimirEscaladas({ pendingActions, entrantes, contactos, salientes, desdeDias = null, titulo = 'escaladas' }) {
    const desdeMs = desdeDias ? Date.now() - desdeDias * 24 * 3600 * 1000 : null;

    // detectaOfertaTraspaso es la MISMA función que arma la espera en bot.js y la que usa el
    // barrido de promesas: una oferta que este informe ve es una oferta que el bot armó.
    const bot = require('../bot');
    const { detectaOfertaTraspaso } = bot._internals;

    const { filas, resumen } = auditEscaladas({
        pendingActions, entrantes, contactos, salientes,
        esOferta: detectaOfertaTraspaso, desdeMs,
    });

    console.log(`\n═══ ${titulo.toUpperCase()} ═══`);
    console.log(desdeDias
        ? `ventana: últimos ${desdeDias} días naturales · ${filas.length} escalada(s)`
        : `histórico completo · ${filas.length} escalada(s)`);

    if (!filas.length) {
        console.log('\nNinguna escalada en la ventana. OJO: un cero aquí puede ser que no las haya, '
            + 'o que la ventana sea corta — no dice nada sobre las que se prometieron y no se escribieron.');
    } else {
        console.log('');
        for (const f of filas) {
            const quien = f.nombre || '(sin nombre)';
            console.log(`  ${ICONO[f.lectura]} ${fmt(f.fecha)} · ${f.motivo || '(sin motivo)'} · ${quien} · ${f.idioma || '?'}`);
            console.log(`      vía ${f.via} — ${LECTURAS[f.lectura]}`);
            if (f.ultimoEntrante) {
                console.log(`      último entrante antes: «${f.ultimoEntrante.slice(0, 70).replace(/\n/g, ' ')}»`);
            }
        }

        console.log('\n  ── por motivo ──');
        for (const [motivo, r] of Object.entries(resumen.porMotivo).sort()) {
            const partes = [];
            if (r.espera) partes.push(`${r.espera} con espera`);
            if (r.tras_si) partes.push(`${r.tras_si} tras un sí`);
            if (r.sin_preguntar) partes.push(`${r.sin_preguntar} SIN preguntar`);
            if (r.sin_entrante) partes.push(`${r.sin_entrante} sin entrante`);
            console.log(`     ${motivo.padEnd(30)} ${String(r.total).padStart(3)} · ${partes.join(' · ')}`);
        }

        const sp = resumen.sinPreguntarPorIdioma;
        if (Object.keys(sp).length) {
            console.log('\n  ── «sin preguntar», por idioma (el reparto que decide, no el agregado) ──');
            for (const [motivo, porIdioma] of Object.entries(sp).sort()) {
                const detalle = Object.entries(porIdioma).sort().map(([i, n]) => `${i}:${n}`).join(' · ');
                console.log(`     ${motivo.padEnd(30)} ${detalle}`);
            }
        }
    }

    // ─── El anillo 2, medido sobre `messages` ────────────────────────────────
    const { PREGUNTA_TRASPASO, PREGUNTA_TRASPASO_FORMAL } = bot._internals;
    const salientesVentana = desdeMs
        ? salientes.filter(s => new Date(s.createdAt).getTime() >= desdeMs)
        : salientes;
    const codas = contarCodas(salientesVentana, PREGUNTA_TRASPASO, PREGUNTA_TRASPASO_FORMAL);
    console.log('\n  ── anillo 2: el modelo declaró y su prosa no ofrecía ──');
    console.log(`     ${codas.total} saliente(s) llevan la pregunta de traspaso pegada por la máquina.`);
    console.log('     Cada uno es una divergencia declaración/prosa, y queda en messages para siempre:');
    console.log('     esta cuenta NO depende de metrics.json (que se borra en cada deploy).');
    for (const s of codas.salientes.slice(0, 5)) {
        console.log(`       · ${fmt(s.createdAt)} «${String(s.content).slice(0, 60).replace(/\n/g, ' ')}…»`);
    }

    // ─── El umbral, escrito ANTES de mirar el número ─────────────────────────
    console.log('\n  ── umbral para decidir si se cablean pedir_persona y queja_cita ──');
    const quejaSinPreguntar = resumen.porMotivo.queja_cita?.sin_preguntar || 0;
    console.log(`     queja_cita «sin preguntar»: ${quejaSinPreguntar}`
        + `  (≥5 en 30 días naturales abre la conversación de si el caso 5 debe preguntar antes,`
        + ` que es decisión de trato y no de código)`);
    console.log('     pedir_persona «sin preguntar» NO cuenta: ahí lo correcto es escalar en el acto.');
    console.log('     La condición que SÍ cablea —ofreció, ella aceptó y no hay fila— la mide el');
    console.log(`     barrido de promesas (aceptada_sin_escalada): ≥2 en ${VENTANA_DECISION_DIAS} días naturales,`);
    console.log('     o 1 sola en ru/uk, donde no hay backstop ninguno.');

    console.log('\n─── Cobertura declarada de este informe ───');
    for (const linea of cobertura()) console.log(`  · ${linea}`);

    return { filas, resumen, codas };
}

async function informarOrg(orgId, nombreOrg, desdeDias) {
    const [pendingActions, entrantes, contactos, salientes] = await Promise.all([
        db.getPendingActionsBarrido(orgId),
        db.getEntrantesBarrido(orgId),
        db.getContactosBarrido(orgId),
        db.getSalientesBotBarrido(orgId),
    ]);
    return imprimirEscaladas({
        pendingActions, entrantes, contactos, salientes, desdeDias,
        titulo: `${nombreOrg} · escaladas`,
    });
}

async function main() {
    const { org, desde, error } = parseArgs(process.argv.slice(2));
    if (error) {
        console.error(`❌ ${error}`);
        console.error('Uso: npm run informe:escaladas -- <org> [--desde <días>]');
        process.exit(2);
    }

    const orgs = resolverOrgArg(org);
    if (!orgs) {
        console.error(`❌ No conozco la organización "${org}". Prueba con: sante, sanremo, un slug o un UUID.`);
        process.exit(2);
    }

    for (const o of orgs) {
        await informarOrg(o.orgId, o.sessionId, desde);
    }
    console.log('');
}

module.exports = { imprimirEscaladas };

// Solo cuando se lanza a mano. Requerido desde barrido-promesas.js no arranca nada.
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch(e => {
            console.error(`❌ ${e.message}`);
            console.error('   Este resultado NO dice que haya 0 escaladas: la lectura falló.');
            process.exit(2);
        });
}
