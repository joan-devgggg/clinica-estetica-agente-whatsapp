/**
 * informe-seguimientos.js — La tanda de seguimientos, ENSEÑADA sin enviar nada.
 *
 * Uso:  npm run informe:seguimientos            (todas las orgs del registry)
 *       npm run informe:seguimientos -- sante   (una sola: sante | sanremo | <uuid>)
 *
 * SOLO LECTURA. No escribe ni una fila, no manda ni un mensaje, y no le importa el
 * interruptor SEGUIMIENTOS: esto se puede correr con el worker apagado, que es justo cuando
 * hace falta.
 *
 * ── Para qué existe ─────────────────────────────────────────────────────────
 * Dos cosas distintas, y la primera funciona aunque la tabla `seguimientos` no esté creada
 * todavía:
 *
 *   1. LAS REGLAS. Dice cuáles pueden enviar y cuáles no, y cuando a una le falta elegir el
 *      servicio, imprime las opciones REALES del catálogo con su precio. Esta parte es la que
 *      se le enseña a la dueña para que elija, así que está escrita para leerse sin saber
 *      nada del sistema.
 *
 *   2. LA TANDA. A quién se le enviaría, con el texto exacto, y a quién NO con su motivo.
 *      Sale de `construirTanda`, la MISMA función que usa el worker: si esto y lo que sale
 *      de verdad pudieran diferir, mirarlo antes no probaría nada.
 *
 * Código de salida 1 solo si hay reglas configuradas que NO pueden enviar. Una tanda vacía
 * no es un fallo; una regla rota que nadie arregla, sí.
 */

require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Madrid';

const { getAllOrgs } = require('../services/org-registry');
const db = require('../services/db');
const { construirTanda, MOTIVO_TEXTO } = require('../services/seguimiento');
const { formatPrecioEur, offerableCatalog } = require('../services/helpers');

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
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}

const tel = t => (String(t || '').replace(/\D/g, '') ? `+${String(t).replace(/\D/g, '')}` : '(sin teléfono)');

// ─── 1. Las reglas ──────────────────────────────────────────────────────────

function pintarReglas(reglas, { conTanda = true } = {}) {
    console.log('\n  ── LAS REGLAS ──────────────────────────────────────────────────');
    if (!reglas.length) {
        console.log('\n  No hay ninguna regla configurada todavía.');
        console.log('  (Se configuran en el panel, en Configuración → Seguimientos.)');
        return 0;
    }

    let rotas = 0;
    for (const { cruda, resuelta, esperando } of reglas) {
        if (resuelta.ok) {
            const ahorro = formatPrecioEur(resuelta.destino.precio - resuelta.precioFinal);
            console.log(`\n  ✓ Después de «${resuelta.origen}», a los ${resuelta.dias} días:`);
            console.log(`      ofrecer ${resuelta.destino.nombre}`);
            console.log(`      ${formatPrecioEur(resuelta.precioFinal)} en vez de ${formatPrecioEur(resuelta.destino.precio)}  (se le descuentan ${ahorro})`);
            continue;
        }

        rotas++;
        console.log(`\n  ✗ Después de «${cruda?.origen || '(sin categoría)'}»: NO PUEDE ENVIAR`);
        console.log(`      ${resuelta.mensaje}`);

        // Lo que convierte este informe en algo que la dueña puede usar para decidir: las
        // opciones de verdad, con su precio, en vez de un "revísalo".
        if (resuelta.opciones && resuelta.opciones.length) {
            console.log('');
            console.log('      Elige UNO de estos:');
            for (const o of resuelta.opciones) {
                console.log(`        · ${o.nombre.padEnd(34)} ${formatPrecioEur(o.precio)}`);
            }
        }

        // A cuánta gente le llegaría en cuanto se elija. Es la cifra que convierte esto en
        // una decisión informada: no es lo mismo elegir entre 45 € y 110 € para una clienta
        // que para treinta.
        if (conTanda && typeof esperando === 'number') {
            console.log('');
            console.log(esperando === 0
                ? '      Ahora mismo no hay ninguna clienta esperando esta regla.'
                : `      En cuanto elijas, le llegaría a ${esperando} clienta(s) que ya cumplen el plazo.`);
        }
    }
    return rotas;
}

// ─── 2. La tanda ────────────────────────────────────────────────────────────

function pintarTanda({ enviables, excluidas, ventana }) {
    console.log('\n  ── LA TANDA DE HOY ─────────────────────────────────────────────');
    if (ventana) {
        console.log(`  (citas terminadas entre el ${fechaCorta(ventana.desdeIso)} y el ${fechaCorta(ventana.hastaIso)})`);
    }

    console.log(`\n  SE ENVIARÍA A ${enviables.length}:`);
    if (!enviables.length) console.log('    (a nadie)');
    for (const e of enviables) {
        console.log(`\n    · ${e.nombre || '(sin nombre)'} · ${tel(e.telefono)} · idioma ${e.language}`);
        console.log(`      se hizo «${e.servicioOrigen}» el ${fechaCorta(e.citaOrigenAt)} (hace ${e.diasTranscurridos} días)`);
        console.log(`      le llegaría, tal cual:`);
        console.log(`        "${e.mensaje}"`);
    }

    // Agrupadas por motivo: una lista plana de 40 nombres no se lee, y lo que interesa de
    // los excluidos es el reparto — si de pronto hay 30 "está en manual", eso es un hallazgo.
    const porMotivo = new Map();
    for (const x of excluidas) {
        if (!porMotivo.has(x.motivo)) porMotivo.set(x.motivo, []);
        porMotivo.get(x.motivo).push(x);
    }
    console.log(`\n  NO SE LE ENVÍA A ${excluidas.length}:`);
    if (!excluidas.length) console.log('    (a nadie)');
    for (const [motivo, filas] of [...porMotivo].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`\n    ${filas.length} porque ${MOTIVO_TEXTO[motivo] || motivo}:`);
        for (const f of filas.slice(0, 8)) {
            console.log(`      · ${f.nombre || '(sin nombre)'} · ${tel(f.telefono)} · «${f.servicioOrigen}» hace ${f.diasTranscurridos} días`);
        }
        if (filas.length > 8) console.log(`      … y ${filas.length - 8} más`);
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────

(async () => {
    const orgs = resolverOrgs(process.argv[2]);
    let reglasRotas = 0;

    for (const org of orgs) {
        console.log(`\n${'═'.repeat(70)}`);
        console.log(`  ${org.slug || org.sessionId}`);
        console.log('═'.repeat(70));

        let tanda;
        try {
            tanda = await construirTanda(org.orgId, { ahora: new Date() });
        } catch (e) {
            // El caso normal antes de aplicar la 041: la tabla no existe. Se dice con esas
            // palabras en vez de escupir el error de Postgres, porque la parte 1 —la que hace
            // falta para elegir los servicios— sí se puede enseñar igual.
            const faltaTabla = /seguimientos/.test(e.message) && /does not exist|no existe|schema cache/i.test(e.message);
            if (!faltaTabla) throw e;

            const cfg = await db.getAgentConfig(org.orgId);
            const catalogo = offerableCatalog(Array.isArray(cfg?.services) ? cfg.services : []);
            const crudas = await db.getConfigValue(org.orgId, 'seguimientos');
            const { resolveSeguimientoRegla } = require('../services/helpers');
            const reglas = (Array.isArray(crudas) ? crudas : [])
                .map(r => ({ cruda: r, resuelta: resolveSeguimientoRegla(r, catalogo) }));
            reglasRotas += pintarReglas(reglas, { conTanda: false });
            console.log('\n  ── LA TANDA DE HOY ─────────────────────────────────────────────');
            console.log('\n  Todavía no se puede calcular: falta aplicar la migración 041,');
            console.log('  que es la que crea la tabla donde se anota lo que se promete.');
            continue;
        }

        reglasRotas += pintarReglas(tanda.reglas);
        pintarTanda(tanda);
    }

    console.log(`\n${'═'.repeat(70)}`);
    if (reglasRotas) {
        console.log(`  ⚠️  ${reglasRotas} regla(s) configurada(s) que NO pueden enviar (ver arriba).`);
    }
    console.log('  Este informe no ha enviado nada ni ha escrito nada.\n');
    process.exit(reglasRotas ? 1 : 0);
})().catch(e => {
    console.error(`\n❌ ${e.message}\n`);
    process.exit(2);
});
