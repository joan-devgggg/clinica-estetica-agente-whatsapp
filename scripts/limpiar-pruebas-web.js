#!/usr/bin/env node
/**
 * limpiar:pruebas-web — borra la ficha de una PRUEBA del enlace público y todo lo que
 * cuelga de ella.
 *
 *   npm run limpiar:pruebas-web -- 600000001              ← INVENTARIO. No escribe nada.
 *   npm run limpiar:pruebas-web -- 600000001 --borrar     ← enseña, pregunta, y borra.
 *
 * Es lo ÚNICO de este repo que borra un contacto a propósito, y borrar un contacto no es
 * borrar una fila: `conversations`, `messages`, `appointments`, `pending_actions` y
 * `seguimientos` cuelgan de `contacts` con ON DELETE CASCADE y se van **en silencio** — no
 * se emite un solo DELETE sobre ellas y no queda rastro salvo el log HTTP del edge, que
 * caduca en días. Así desapareció la conversación de Olga Yarmak, 30 mensajes auditados
 * enteros dos días antes, el 11/08/2026 (CLAUDE.md, hecho 7). Por eso este script:
 *
 *   1. exige el teléfono como ARGUMENTO y no tiene ninguno por defecto;
 *   2. tiene una lista de números que NUNCA borra, empezando por el del dueño;
 *   3. solo mira Sante — San Remo no es un argumento que se pueda pasar mal;
 *   4. ABORTA en cuanto ve algo que no venga del enlace público (`evaluarBloqueos`);
 *   5. ENSEÑA el inventario entero —con cuántos mensajes se va a llevar— y pide que
 *      teclees el teléfono para seguir;
 *   6. y al acabar RELEE y dice si quedó algo.
 *
 * LO QUE NO PUEDE PASAR, y es el motivo de la mitad del código: que una lectura ROTA se
 * lea como «aquí no hay nada raro» y el borrado siga adelante. Un cero no es una ausencia
 * (CLAUDE.md, hecho 2). Todas las lecturas van por `leer()`, que LANZA con el error de
 * Supabase delante; ninguna devuelve `[]` por su cuenta.
 *
 * La DECISIÓN vive en `evaluarBloqueos`, una función pura y exportada, y no dentro del
 * flujo: así la prueba de que cada guardián dispara —y de que TODOS pueden estar
 * apagados a la vez, que es lo que hace que el script sirva para algo— no depende de que
 * haya una ficha de prueba en producción. La conduce `tests/limpiar-pruebas-web.test.js`.
 * Los requires de Supabase van DENTRO de `main()` por lo mismo: requerir este fichero para
 * la función pura no puede exigir un `.env`.
 */

// ─── (4) Los guardianes ──────────────────────────────────────────────────────────────────
//
// Todos responden a la misma pregunta: ¿hay aquí algo que NO haya puesto el enlace público?
// Si lo hay, esto no es una prueba y no se borra. Devuelve la lista de motivos; vacía = vía
// libre.
//
// `origen === 'web'` NO basta él solo, y conviene saber por qué: `procesarReservaWeb` llama
// a `saveLead({origen:'web'})` también cuando la ficha YA existía, así que una clienta de
// verdad que reservara por el enlace se queda con origen 'web' encima de toda su historia.
// Lo que la distingue son las filas de al lado, no esa columna.
function evaluarBloqueos(inv) {
    const {
        contacto, citas = [], mensajes = [], pendientes = [], seguimientos = [],
        campanas = [], cobros = [], ajenas = [], permitirConversacion = false,
    } = inv;
    const bloqueos = [];

    if (!contacto) return ['no hay ficha que evaluar'];

    if (contacto.origen !== 'web') {
        bloqueos.push(`la ficha tiene origen='${contacto.origen ?? 'null'}', no 'web'`);
    }
    if (contacto.is_vip) bloqueos.push('la ficha está marcada como VIP');
    if (Number(contacto.visit_count) > 0) {
        bloqueos.push(`la ficha tiene visit_count=${contacto.visit_count}`);
    }

    const citasNoWeb = citas.filter(c => c.source !== 'web');
    if (citasNoWeb.length) {
        bloqueos.push(`${citasNoWeb.length} cita(s) con source distinto de 'web': `
            + citasNoWeb.map(c => `${c.starts_at} [${c.source ?? 'null'}]`).join(', '));
    }

    // `cobros.appointment_id` es ON DELETE **RESTRICT** (035_cobros.sql:46): un solo cobro,
    // aunque esté anulado, hace fallar el borrado del contacto ENTERO por cascada. Mejor
    // decirlo aquí que recibir un 23503 sin contexto.
    if (cobros.length) {
        bloqueos.push(`hay ${cobros.length} cobro(s). Además \`cobros.appointment_id\` es `
            + 'ON DELETE RESTRICT: el borrado fallaría entero.');
    }
    if (campanas.length) {
        bloqueos.push(`${campanas.length} envío(s) de campaña: a esta ficha se le ha escrito de verdad`);
    }
    if (pendientes.length) {
        bloqueos.push(`${pendientes.length} fila(s) en pending_actions: el bot o el panel actuaron sobre esta ficha`);
    }
    if (seguimientos.length) bloqueos.push(`${seguimientos.length} fila(s) en seguimientos`);

    // Filas de OTRA persona que apuntan a estas citas. No bloquean el DELETE (SET NULL /
    // CASCADE), y justo por eso hay que verlas: se modificarían sin decir nada.
    if (ajenas.length) bloqueos.push(`${ajenas.length} fila(s) de OTRO contacto apuntan a estas citas`);

    // Los mensajes son el único bloqueo con salida, y tiene un motivo real: el recordatorio
    // de 24 h y la reseña SÍ escriben en `messages`
    // (tests/recordatorio-registro-conversacion.test.js), así que una cita de prueba que
    // llegue a su víspera deja rastro legítimo. La salida exige teclear otra bandera, y solo
    // después de haber visto el número por pantalla.
    if (mensajes.length && !permitirConversacion) {
        bloqueos.push(`${mensajes.length} mensaje(s) en la conversación. Si son nuestros `
            + '(recordatorio/reseña) y aun así quieres tirarlos, repite con --con-conversacion.');
    }

    return bloqueos;
}

module.exports = { evaluarBloqueos };

// ─────────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) main();

function main() {
    require('dotenv').config({ quiet: true });
    process.env.TZ = process.env.TZ || 'Europe/Madrid';

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('❌ Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Configúralos en .env.');
        process.exit(2);
    }

    const supabase = require('../services/supabase');
    const db = require('../services/db');
    const { SANTE_ORG_ID, getOrgType, getAllOrgs } = require('../services/org-registry');

    // ─── Los números que este script NO borra jamás ──────────────────────────────────────
    //
    // El del dueño está el primero porque es el que más veces va a estar en la terminal al
    // lado de este comando. Los dos de las organizaciones están porque un WhatsApp de
    // empresa puede tener ficha en su propia org, y borrarla se llevaría por delante la
    // conversación consigo misma.
    //
    // Se comparan ya saneados, o '644610120' y '+34 644 610 120' serían dos cosas distintas
    // para la lista y una de las dos pasaría.
    const PROHIBIDOS = new Set([
        '34644610120',   // Joan (dueño)
        ...getAllOrgs().map(o => db.sanitizePhone(o.waPhone)),
    ]);

    const ORG_ID = SANTE_ORG_ID;

    const argv = process.argv.slice(2);
    const flags = new Set(argv.filter(a => a.startsWith('--')));
    const posicionales = argv.filter(a => !a.startsWith('--'));
    const BORRAR = flags.has('--borrar');
    const CON_CONVERSACION = flags.has('--con-conversacion');

    function uso(motivo) {
        if (motivo) console.error(`❌ ${motivo}\n`);
        console.error('Uso: npm run limpiar:pruebas-web -- <telefono> [--borrar] [--con-conversacion]');
        console.error('');
        console.error('  <telefono>            OBLIGATORIO. No hay valor por defecto, a propósito.');
        console.error('  --borrar              sin esta bandera solo se imprime el inventario.');
        console.error('  --con-conversacion    permite borrar aunque haya mensajes en `messages`.');
        console.error('                        Se pide a mano DESPUÉS de haber visto cuántos son.');
        process.exit(2);
    }

    // ─── Lecturas que no mienten ─────────────────────────────────────────────────────────
    //
    // Gemelo de `assertRead` (db.js), que no se exporta. Un `.select()` que falla devuelve
    // `data: null` con el error al lado; sin este envoltorio, cada consulta de abajo se
    // leería como «no hay ninguna fila de esto» y el guardián que cuelga de ella daría
    // permiso.
    async function leer(tabla, query) {
        const { data, error } = await query;
        if (error) {
            console.error(`❌ Lectura de ${tabla} falló: ${error.message || error}`);
            console.error('   NO se ha borrado nada. Un cero aquí no es una ausencia: es una lectura rota.');
            process.exit(4);
        }
        return data || [];
    }

    const fila = (...cols) => cols.join('  ');
    const corta = (s, n) => {
        const t = String(s ?? '').replace(/\s+/g, ' ').trim();
        return t.length > n ? `${t.slice(0, n - 1)}…` : t;
    };

    async function preguntar(texto) {
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        return new Promise(resolve => rl.question(texto, r => { rl.close(); resolve(r); }));
    }

    (async () => {
        if (!posicionales.length) uso('Falta el teléfono.');
        if (posicionales.length > 1) uso(`Sobran argumentos: ${posicionales.slice(1).join(' ')}`);

        const crudo = posicionales[0];
        const telefono = db.sanitizePhone(crudo);
        if (!telefono || telefono.length < 9) uso(`Teléfono no utilizable: '${crudo}' → '${telefono}'`);

        // (2) La lista de prohibidos. Antes de leer nada: si está aquí, no hay inventario que
        // valga y tampoco quiero enseñar por pantalla lo que cuelga de esa ficha.
        if (PROHIBIDOS.has(telefono)) {
            console.error(`⛔ ${telefono} está en la lista de números que este script NO borra nunca.`);
            console.error('   Si de verdad hay que borrar esa ficha, se hace a mano y mirándola.');
            process.exit(3);
        }

        // (3) Solo Sante. No es un argumento: es una constante del registry, y encima se
        // comprueba que sigue siendo un salón. San Remo no puede llegar aquí ni por un typo.
        if (getOrgType(ORG_ID) !== 'salon') {
            console.error(`❌ ${ORG_ID} no es un salón. Este script solo corre contra Sante.`);
            process.exit(3);
        }

        console.log('══════════════════════════════════════════════════════════════════');
        console.log(`  LIMPIEZA DE PRUEBA WEB · ${telefono}  (org: Sante)`);
        console.log(`  Modo: ${BORRAR ? 'BORRAR (con confirmación)' : 'INVENTARIO — no escribe nada'}`);
        console.log('══════════════════════════════════════════════════════════════════\n');

        // ─── La ficha ────────────────────────────────────────────────────────────────────
        // Se buscan TODAS las variantes del número, no solo la canónica: en producción hay
        // filas antiguas escritas sin el 34 delante y UNIQUE(org, wa_phone) no las ve
        // iguales. Si salen dos, se para: no me invento cuál era la de la prueba.
        const ids = await db.findContactIdsByPhone(ORG_ID, telefono);
        if (!ids.length) {
            console.log('✅ No hay ninguna ficha con ese teléfono en Sante. Nada que limpiar.');
            process.exit(0);
        }
        if (ids.length > 1) {
            console.error(`❌ ${ids.length} fichas casan con ese teléfono (variantes del número): ${ids.join(', ')}`);
            console.error('   Ambigüedad = parada. Míralas y decide tú cuál es la de la prueba.');
            process.exit(3);
        }
        const contactId = ids[0];

        const [contacto] = await leer('contacts', supabase
            .from('contacts')
            .select('id, wa_phone, full_name, origen, is_vip, visit_count, is_blacklisted, language, created_at')
            .eq('organization_id', ORG_ID)
            .eq('id', contactId));
        if (!contacto) {
            console.error('❌ La ficha desapareció entre dos lecturas. Vuelve a lanzarlo.');
            process.exit(4);
        }

        // ─── Todo lo que cuelga ──────────────────────────────────────────────────────────
        const citas = await leer('appointments', supabase
            .from('appointments')
            .select('id, service, starts_at, ends_at, status, source, stylist_id, full_name, created_at')
            .eq('organization_id', ORG_ID).eq('contact_id', contactId));
        const citaIds = citas.map(c => c.id);

        const convs = await leer('conversations', supabase
            .from('conversations').select('id, created_at, last_message_at')
            .eq('organization_id', ORG_ID).eq('contact_id', contactId));

        const mensajes = convs.length
            ? await leer('messages', supabase
                .from('messages').select('id, direction, content, created_at')
                .eq('organization_id', ORG_ID)
                .in('conversation_id', convs.map(c => c.id))
                .order('created_at', { ascending: true }))
            : [];

        const pendientes = await leer('pending_actions', supabase
            .from('pending_actions').select('id, type, status, created_at')
            .eq('organization_id', ORG_ID).eq('contact_id', contactId));

        const seguimientos = await leer('seguimientos', supabase
            .from('seguimientos').select('id, regla_key, estado, created_at')
            .eq('organization_id', ORG_ID).eq('contact_id', contactId));

        const campanas = await leer('broadcast_sends', supabase
            .from('broadcast_sends').select('id, campaign_key, status, sent_at')
            .eq('organization_id', ORG_ID).eq('contact_id', contactId));

        // `cobros` por los DOS lados: cuelga del contacto (SET NULL) y de la cita (RESTRICT).
        const cobros = [
            ...await leer('cobros', supabase
                .from('cobros').select('id, estado, importe_total, fecha_caja')
                .eq('organization_id', ORG_ID).eq('contact_id', contactId)),
            ...(citaIds.length ? await leer('cobros', supabase
                .from('cobros').select('id, estado, importe_total, fecha_caja, appointment_id')
                .eq('organization_id', ORG_ID).in('appointment_id', citaIds)) : []),
        ];

        const ajenas = citaIds.length ? [
            ...(await leer('pending_actions', supabase
                .from('pending_actions').select('id, contact_id, appointment_id')
                .eq('organization_id', ORG_ID).in('appointment_id', citaIds))),
            ...(await leer('seguimientos', supabase
                .from('seguimientos').select('id, contact_id, appointment_origen_id')
                .eq('organization_id', ORG_ID).in('appointment_origen_id', citaIds))),
            ...(await leer('seguimientos', supabase
                .from('seguimientos').select('id, contact_id, appointment_destino_id')
                .eq('organization_id', ORG_ID).in('appointment_destino_id', citaIds))),
        ].filter(r => r.contact_id !== contactId) : [];

        // ─── El inventario, tal cual ─────────────────────────────────────────────────────
        console.log('FICHA');
        console.log(fila('  id         ', contacto.id));
        console.log(fila('  wa_phone   ', contacto.wa_phone));
        console.log(fila('  nombre     ', contacto.full_name ?? '(sin nombre)'));
        console.log(fila('  origen     ', contacto.origen ?? '(null)'));
        console.log(fila('  creada     ', contacto.created_at));
        console.log(fila('  vip/visitas', `${contacto.is_vip ? 'VIP' : 'no'} · ${contacto.visit_count ?? 0} visitas`));
        console.log('');

        console.log(`CITAS (${citas.length})`);
        for (const c of citas) {
            console.log(fila('  ', c.starts_at, `[source=${c.source ?? 'null'}]`, `[${c.status}]`, corta(c.service, 50)));
        }
        if (!citas.length) console.log('  (ninguna)');
        console.log('');

        // El número que hay que ver ANTES de tirar nada. Va en su propia línea y se imprime
        // incluso cuando es 0: un 0 dicho es una comprobación; un 0 callado es un hueco
        // donde nadie sabe si se miró.
        console.log(`CONVERSACIÓN: ${convs.length} hilo(s) · ⚠️  ${mensajes.length} MENSAJE(S) que se irían por cascada`);
        for (const m of mensajes.slice(0, 10)) {
            console.log(fila('  ', m.created_at, m.direction === 'inbound' ? '←' : '→', corta(m.content, 60)));
        }
        if (mensajes.length > 10) console.log(`  … y ${mensajes.length - 10} más`);
        console.log('');

        console.log(`OTRAS FILAS  pending_actions: ${pendientes.length} · seguimientos: ${seguimientos.length} · `
            + `broadcast_sends: ${campanas.length} · cobros: ${cobros.length} · ajenas: ${ajenas.length}`);
        console.log('');

        const bloqueos = evaluarBloqueos({
            contacto, citas, mensajes, pendientes, seguimientos, campanas, cobros, ajenas,
            permitirConversacion: CON_CONVERSACION,
        });

        if (bloqueos.length) {
            console.log('⛔ ABORTADO. Esto no parece solo una prueba del enlace:\n');
            for (const b of bloqueos) console.log(`   · ${b}`);
            console.log('\n   No se ha escrito nada.');
            process.exit(3);
        }

        console.log('✅ Todo lo que hay aquí viene del enlace público.\n');

        if (!BORRAR) {
            console.log('Inventario y nada más: no se ha escrito nada.');
            console.log(`Para borrarlo:  npm run limpiar:pruebas-web -- ${crudo} --borrar`
                + (CON_CONVERSACION ? ' --con-conversacion' : ''));
            process.exit(0);
        }

        // ─── (5) La confirmación ─────────────────────────────────────────────────────────
        // Se teclea el teléfono, no «sí»: un «sí» se contesta sin leer. Y sin terminal
        // interactiva no se borra — si nadie está mirando, esta pantalla no ha servido de
        // nada.
        if (!process.stdin.isTTY) {
            console.error('❌ Sin terminal interactiva no hay confirmación posible, y sin confirmación no se borra.');
            process.exit(3);
        }
        console.log('Se van a borrar, sin vuelta atrás:');
        console.log(`   1 ficha · ${citas.length} cita(s) · ${convs.length} hilo(s) · ${mensajes.length} mensaje(s)`);
        const respuesta = await preguntar(`\nEscribe el teléfono (${telefono}) para confirmar, o cualquier otra cosa para salir: `);
        if (String(respuesta).trim() !== telefono) {
            console.log('\nCancelado. No se ha escrito nada.');
            process.exit(0);
        }

        // El DELETE. Una sola sentencia sobre `contacts`; el resto se va por cascada, que es
        // exactamente lo que hace falta decir en voz alta antes de mirar el resultado.
        console.log('\nBorrando…');
        await db.deleteLead(ORG_ID, contactId);

        // ─── (6) Releer. `deleteLead` mira el `error` pero NO cuántas filas tocó, así que un
        // DELETE que no casó nada devuelve `true` igual. Lo único que prueba el borrado es
        // volver a preguntar. ─────────────────────────────────────────────────────────────
        const restos = [];
        const fichaQueda = await leer('contacts', supabase
            .from('contacts').select('id').eq('organization_id', ORG_ID).eq('id', contactId));
        if (fichaQueda.length) restos.push('la ficha SIGUE ahí');

        const porVariantes = await db.findContactIdsByPhone(ORG_ID, telefono);
        if (porVariantes.length) restos.push(`quedan ${porVariantes.length} ficha(s) con ese teléfono`);

        const citasQuedan = await leer('appointments', supabase
            .from('appointments').select('id').eq('organization_id', ORG_ID).eq('contact_id', contactId));
        if (citasQuedan.length) restos.push(`quedan ${citasQuedan.length} cita(s)`);

        const convsQuedan = await leer('conversations', supabase
            .from('conversations').select('id').eq('organization_id', ORG_ID).eq('contact_id', contactId));
        if (convsQuedan.length) restos.push(`quedan ${convsQuedan.length} hilo(s)`);

        if (convs.length) {
            const msQuedan = await leer('messages', supabase
                .from('messages').select('id').eq('organization_id', ORG_ID)
                .in('conversation_id', convs.map(c => c.id)));
            if (msQuedan.length) restos.push(`quedan ${msQuedan.length} mensaje(s)`);
        }
        for (const tabla of ['pending_actions', 'seguimientos']) {
            const q = await leer(tabla, supabase
                .from(tabla).select('id').eq('organization_id', ORG_ID).eq('contact_id', contactId));
            if (q.length) restos.push(`quedan ${q.length} fila(s) en ${tabla}`);
        }

        if (restos.length) {
            console.error('\n❌ El borrado NO quedó limpio:');
            for (const r of restos) console.error(`   · ${r}`);
            process.exit(4);
        }

        console.log('\n✅ Borrado y comprobado: no queda ficha, ni citas, ni conversación, ni mensajes,');
        console.log('   ni pending_actions, ni seguimientos con ese teléfono en Sante.');
        process.exit(0);
    })().catch(e => {
        console.error('❌', e.message);
        console.error('   Si esto salió ANTES del DELETE, no se ha escrito nada. Si salió después,');
        console.error('   vuelve a lanzarlo sin --borrar para ver qué quedó.');
        process.exit(4);
    });
}
