/**
 * seguimiento.js — La propuesta que sale días o semanas después de una cita.
 *
 * "Hidratación a las 2-3 semanas de unas mechas", "matiz al mes", con un descuento si
 * reserva. Es lo único del sistema que le escribe a una clienta por algo que pasó hace
 * semanas, y esa es toda la diferencia: cuando sale, ya no queda conversación viva donde
 * corregirse.
 *
 * ── Este fichero decide; NO envía ────────────────────────────────────────────
 * `decidirSeguimiento` es puro y no toca ni la red ni la BD. Recibe la foto de una clienta
 * y devuelve `{envia, motivo}`. Se prueba entero sin Supabase, y el mismo veredicto lo usan
 * los dos consumidores: el worker (para mandar) y el preview (para enseñar la tanda sin
 * mandar nada). Un preview que calculara sus candidatas por su cuenta no serviría para lo
 * único que existe: comprobar qué va a salir ANTES de que salga.
 *
 * ── Por qué hay tantos "no" ──────────────────────────────────────────────────
 * Las tres primeras exclusiones son las de `getCompletedAppointmentsForReview`, copiadas a
 * propósito. Las demás salieron de preguntarle a cada una qué pasa si falta.
 */

const {
    categoriasDeServicio, splitServiceNames, findCatalogEntriesExact, serviceCatalogKey,
    resolveSeguimientoRegla, buildSeguimientoMensaje,
} = require('./helpers');

// Cuánto vive en el buzón de pending-outbound la nota del mensaje enviado (lo que hace
// que el bot SEPA lo que ofreció cuando la clienta conteste). Más largo que las 48 h del
// recordatorio a propósito: la oferta del -10 % caduca lenta y una respuesta a los 5 días
// sigue siendo una respuesta a la oferta.
const TTL_NOTA_SEGUIMIENTO_MS = 7 * 24 * 60 * 60 * 1000;

// Cuántos días DESPUÉS del día N sigue teniendo sentido el mensaje.
//
// Sin este tope, encender el interruptor mandaría de golpe un WhatsApp por cada cita
// histórica que cumpliera la regla — Sante tiene meses de citas completadas. Es la forma
// que tendría esto de repetir el incidente del `horas_recordatorio` a NaN, que mandó el
// recordatorio de TODAS las citas futuras de una vez porque la única guarda que las acotaba
// se había desarmado.
//
// Siete días y no más porque el mensaje dice "es buen momento": a las cinco semanas de unas
// mechas eso ya no es verdad, y una oferta a destiempo se lee como que no sabemos cuándo
// vino.
const VENTANA_MARGEN_DIAS = 7;

// Días mínimos entre dos seguimientos a la MISMA clienta.
//
// Una cita puede disparar dos reglas (hidratación a 18 días, matiz a 28): diez días de
// separación están bien. Lo que esto impide es que dos reglas mal puestas —a 19 y 20 días—
// le manden dos mensajes comerciales en 24 h. El tope está aquí y no en la regla porque
// protege a la clienta de la SUMA de las reglas, que es algo que ninguna regla puede ver.
const MIN_DIAS_ENTRE_ENVIOS = 7;

// Dígitos mínimos para que un teléfono sirva. Sante tiene 3 contactos con `wa_phone`
// inservible, dos de ellos con cita confirmada: no es hipotético.
const TELEFONO_DIGITOS_MIN = 9;

function diasDesde(iso, ahora) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return (ahora.getTime() - d.getTime()) / (24 * 60 * 60 * 1000);
}

function telefonoServible(telefono) {
    const digits = String(telefono || '').replace(/\D/g, '');
    return digits.length >= TELEFONO_DIGITOS_MIN;
}

// ¿Alguno de estos servicios YA guardados es el que le íbamos a ofrecer?
//
// Se compara por CLAVE de catálogo, no por texto: una cita con dos servicios se guarda como
// "A + B", así que buscar el nombre suelto con un `includes` fallaría justo en el caso más
// común —que se lo hiciera de paso, junto con otra cosa— y le mandaríamos una oferta de algo
// que acaba de hacerse.
function yaSeHizoElDestino(serviciosPosteriores, destinoKey, catalogo) {
    if (!destinoKey || !Array.isArray(serviciosPosteriores)) return false;
    for (const servicio of serviciosPosteriores) {
        for (const name of splitServiceNames(servicio, catalogo)) {
            const entradas = findCatalogEntriesExact(name, catalogo);
            if (entradas.some(e => serviceCatalogKey(e) === destinoKey)) return true;
        }
    }
    return false;
}

/**
 * ¿Se le manda este seguimiento a esta clienta, y si no, por qué?
 *
 * El `motivo` no es un log: es lo que imprime el preview al lado de cada nombre, y es lo que
 * permite mirar una tanda y decir "esta lista está bien". Por eso hay un motivo distinto por
 * cada razón, y no un booleano.
 *
 * @returns {{envia: boolean, motivo: string, diasTranscurridos: number|null}}
 */
function decidirSeguimiento(entrada) {
    const {
        cita, contacto, reglaResuelta, catalogo, ahora,
        citasFuturas = [], serviciosPosteriores = [],
        yaEnviado = false, ultimoEnvioAt = null,
        tieneAccionPendiente = false, botActivo = true,
    } = entrada || {};

    const no = (motivo, dias = null) => ({ envia: false, motivo, diasTranscurridos: dias });

    if (!cita || !contacto || !reglaResuelta || !ahora) return no('datos_incompletos');

    // Una regla que no resolvió no envía NADA, pase lo que pase con la clienta. Va la
    // primera para que ningún camino nuevo pueda saltársela.
    if (!reglaResuelta.ok) return no('regla_no_resuelve');

    // ¿Esta cita es de la familia que dispara la regla? Por categoría resuelta contra el
    // catálogo, nunca por lo que ponga el texto: una cita de Balayage se guarda como
    // "Cabello corto".
    const categorias = categoriasDeServicio(cita.service, catalogo);
    if (!categorias.includes(reglaResuelta.origen)) return no('no_dispara');

    // `new Date('lo que sea')` es Invalid Date y TODA comparación con él es false, así que
    // sin esta guarda una fecha rota caería por el lado de "sí, envía". Es la misma trampa
    // que `minutosHastaCita` con una `fecha_cita` malformada.
    const dias = diasDesde(cita.ends_at || cita.starts_at, ahora);
    if (dias == null) return no('fecha_ilegible');
    const diasEnteros = Math.floor(dias);

    if (yaEnviado) return no('ya_enviado', diasEnteros);
    if (dias < reglaResuelta.dias) return no('no_toca_aun', diasEnteros);
    if (dias > reglaResuelta.dias + VENTANA_MARGEN_DIAS) return no('ventana_pasada', diasEnteros);

    // El bot apagado excluye AQUÍ y no en la reseña, y la diferencia es lo que se espera de
    // vuelta: un enlace de reseña con el bot apagado sigue sirviendo, una pregunta no. Le
    // estaríamos ofreciendo un hueco que nadie va a poder darle.
    if (!botActivo) return no('bot_apagado', diasEnteros);

    if (contacto.is_blacklisted) return no('lista_negra', diasEnteros);
    if (contacto.escalation_reason) return no('escalada_abierta', diasEnteros);
    if (tieneAccionPendiente) return no('accion_pendiente', diasEnteros);
    // Hay una persona llevando esa conversación. Meterle una oferta automática por debajo es
    // como hablarle por encima.
    if (contacto.bot_mode === 'manual') return no('bot_en_manual', diasEnteros);
    if (!telefonoServible(contacto.telefono)) return no('telefono_inservible', diasEnteros);

    // ── Ya volvió, en sus dos formas ─────────────────────────────────────────
    if (Array.isArray(citasFuturas) && citasFuturas.length) return no('tiene_cita_futura', diasEnteros);
    if (yaSeHizoElDestino(serviciosPosteriores, reglaResuelta.destino?.key, catalogo)) {
        return no('ya_se_lo_hizo', diasEnteros);
    }

    const desdeUltimo = diasDesde(ultimoEnvioAt, ahora);
    if (desdeUltimo != null && desdeUltimo < MIN_DIAS_ENTRE_ENVIOS) return no('demasiado_reciente', diasEnteros);

    return { envia: true, motivo: 'ok', diasTranscurridos: diasEnteros };
}

// Lo que se le enseña a quien lee el preview. Sin jerga: la lista la lee la dueña.
const MOTIVO_TEXTO = {
    ok:                  'se le enviaría',
    datos_incompletos:   'faltan datos para decidir',
    regla_no_resuelve:   'la regla no está lista',
    no_dispara:          'su servicio no es de los que disparan esta regla',
    fecha_ilegible:      'la fecha de su cita no se entiende',
    ya_enviado:          'ya se le envió',
    no_toca_aun:         'todavía es pronto',
    ventana_pasada:      'ya pasó el momento',
    bot_apagado:         'el bot está apagado y no podría contestarle',
    lista_negra:         'está en la lista negra',
    escalada_abierta:    'tiene algo sin resolver',
    accion_pendiente:    'tiene una acción pendiente en el panel',
    bot_en_manual:       'la está atendiendo una persona',
    telefono_inservible: 'su teléfono no sirve para escribirle',
    tiene_cita_futura:   'YA VOLVIÓ: tiene otra cita',
    ya_se_lo_hizo:       'YA VOLVIÓ: ya se hizo ese servicio',
    demasiado_reciente:  'se le escribió hace muy poco',
    sin_mensaje:         'no se pudo escribir el mensaje (falta el precio)',
};

// ─── La tanda ───────────────────────────────────────────────────────────────

// El valor de `config.bot_activo` con la MISMA semántica que server.js: la clave ausente NO
// significa apagado, significa que nadie la ha tocado y el bot está en marcha. Leerlo como
// `!!valor` dejaría a San Remo —que no tiene la clave— sin seguimientos para siempre y sin
// que nadie entendiera por qué.
function interpretarBotActivo(valor) {
    if (valor === null || valor === undefined) return true;
    return valor === true || valor === 'true' || valor === 1;
}

/**
 * Calcula la tanda ENTERA sin enviar nada: qué reglas están listas, a quién se le enviaría y
 * a quién no con su motivo.
 *
 * Es la única función que construye candidatas. El preview y el worker la llaman igual, y esa
 * es la razón de que exista: un preview que calculara la lista por su cuenta no probaría lo
 * único que se le pide, que es enseñar lo que va a salir de verdad.
 */
async function construirTanda(orgId, { ahora = new Date() } = {}) {
    // `require` perezoso, y no es cosmético: `db` arrastra el cliente de Supabase, que revienta
    // al cargarse sin SUPABASE_URL. Con él arriba, la mitad pura de este fichero —que es la
    // que decide a quién se le escribe— dejaría de poder probarse sin entorno, y ese test es
    // justamente el que no debe depender de nada.
    const db = require('./db');

    const agentConfig = await db.getAgentConfig(orgId);
    const catalogo = Array.isArray(agentConfig?.services) ? agentConfig.services : [];

    // El catálogo va COMPLETO a los dos sitios, y aquí eso no es un descuido de la regla del
    // filtro-en-el-call-site: es que el filtro ya está puesto más adentro, y puesto mejor.
    //
    // `resolveSeguimientoRegla` comprueba `isServiceActive` sobre la entrada ya localizada, y
    // `opcionesDeSeguimiento` filtra las suyas. Pasar el catálogo ya filtrado no añadía
    // ninguna protección —probado por mutación: quitarlo no rompe ningún test— y sí
    // EMPEORABA el aviso: la entrada dada de baja desaparecía antes de que nadie la buscara,
    // así que la dueña leía «ya no está en el catálogo, puede que se haya renombrado» cuando
    // la verdad era «está dado de baja». Dos arreglos distintos.
    //
    // Y resolver una cita PASADA necesita el catálogo entero de todas formas: un servicio de
    // baja tiene que seguir resolviendo, o la cita que lo disparó deja de reconocerse.
    const reglasCrudas = await db.getConfigValue(orgId, 'seguimientos');
    const lista = Array.isArray(reglasCrudas) ? reglasCrudas : [];
    const reglas = lista.map(r => ({ cruda: r, resuelta: resolveSeguimientoRegla(r, catalogo) }));
    const listas = reglas.filter(r => r.resuelta.ok);

    // Reglas a las que SOLO les falta elegir el servicio. No pueden enviar, pero sí pueden
    // decir a cuánta gente le llegarían — y eso es justo lo que hace falta para elegir entre
    // un tratamiento de 45 € y uno de 110 €. Sin esto, con las dos reglas aún sin destino
    // (que es como nacen) el informe no enseñaba a NADIE, y la decisión se tomaba a ciegas.
    const pendientes = reglas.filter(r => r.resuelta.motivo === 'sin_destino' && r.resuelta.dias);

    const base = { reglas, enviables: [], excluidas: [], ventana: null };
    if (!listas.length && !pendientes.length) return base;

    const botActivo = interpretarBotActivo(await db.getConfigValue(orgId, 'bot_activo'));

    // La ventana que hay que leer: desde la regla más tardía (+ margen) hasta la más
    // temprana. Sale de las reglas y no de una constante — si mañana hay una regla a 90 días,
    // la consulta la sigue sin que nadie se acuerde de ampliarla.
    const conDias = [...listas, ...pendientes].map(r => r.resuelta.dias);
    const minDias = Math.min(...conDias);
    const maxDias = Math.max(...conDias) + VENTANA_MARGEN_DIAS;
    const dia = 24 * 60 * 60 * 1000;
    const desdeIso = new Date(ahora.getTime() - maxDias * dia).toISOString();
    const hastaIso = new Date(ahora.getTime() - minDias * dia).toISOString();
    const ventana = { desdeIso, hastaIso, minDias, maxDias };

    const citas = await db.getCitasParaSeguimiento(orgId, { desdeIso, hastaIso });

    // A cuánta gente le llegaría cada regla que solo espera a que elijan el servicio. Se
    // cuenta con el MISMO criterio de categoría y ventana que usa el envío; lo único que no
    // se comprueba son las exclusiones por clienta, porque sin destino no hay mensaje que
    // decidir. Es una cifra para elegir, no una lista de destinatarios.
    for (const p of pendientes) {
        p.esperando = citas.filter(c => {
            const d = diasDesde(c.ends_at || c.starts_at, ahora);
            if (d == null || d < p.resuelta.dias || d > p.resuelta.dias + VENTANA_MARGEN_DIAS) return false;
            return categoriasDeServicio(c.service, catalogo).includes(p.resuelta.origen);
        }).length;
    }

    if (!citas.length || !listas.length) return { ...base, ventana };

    const contactIds = [...new Set(citas.map(c => c.contacts?.id || c.contact_id).filter(Boolean))];
    const [agenda, conAccionPendiente, seguimientos] = await Promise.all([
        db.getCitasDeContactosDesde(orgId, contactIds, desdeIso),
        db.getContactIdsConAccionPendiente(orgId),
        db.getSeguimientosDeContactos(orgId, contactIds),
    ]);

    // Índices en memoria. La foto de la agenda es UNA, tomada de una vez: recalcular por
    // clienta dejaría a dos candidatas de la misma tanda mirando agendas distintas.
    const agendaPorContacto = new Map();
    for (const a of agenda) {
        if (!agendaPorContacto.has(a.contact_id)) agendaPorContacto.set(a.contact_id, []);
        agendaPorContacto.get(a.contact_id).push(a);
    }
    const yaEnviados = new Set(
        seguimientos.filter(s => s.estado === 'enviado' || s.estado === 'pendiente')
            .map(s => `${s.appointment_origen_id}|${s.regla_key}`),
    );
    const ultimoEnvioPorContacto = new Map();
    for (const s of seguimientos) {
        if (s.estado !== 'enviado' || !s.enviado_at) continue;
        const prev = ultimoEnvioPorContacto.get(s.contact_id);
        if (!prev || s.enviado_at > prev) ultimoEnvioPorContacto.set(s.contact_id, s.enviado_at);
    }

    const enviables = [];
    const excluidas = [];
    for (const cita of citas) {
        const contactoRow = cita.contacts || null;
        const contactId = contactoRow?.id || cita.contact_id;
        const contacto = contactoRow ? {
            id: contactoRow.id,
            nombre: contactoRow.full_name,
            telefono: contactoRow.wa_phone,
            language: contactoRow.language || 'es',
            is_blacklisted: !!contactoRow.is_blacklisted,
            escalation_reason: contactoRow.escalation_reason || null,
            bot_mode: contactoRow.bot_mode || 'auto',
            wa_jid: contactoRow.metadata?.wa_jid || null,
        } : null;

        const suAgenda = agendaPorContacto.get(contactId) || [];
        const citasFuturas = suAgenda.filter(a => a.starts_at > ahora.toISOString() && a.id !== cita.id);
        const serviciosPosteriores = suAgenda
            .filter(a => a.id !== cita.id && a.starts_at > (cita.ends_at || cita.starts_at))
            .map(a => a.service);

        for (const { resuelta } of listas) {
            const decision = decidirSeguimiento({
                cita, contacto, reglaResuelta: resuelta, catalogo, ahora,
                citasFuturas, serviciosPosteriores,
                yaEnviado: yaEnviados.has(`${cita.id}|${resuelta.key}`),
                ultimoEnvioAt: ultimoEnvioPorContacto.get(contactId) || null,
                tieneAccionPendiente: conAccionPendiente.has(contactId),
                botActivo,
            });

            // `no_dispara` y `no_toca_aun` no son exclusiones: son el 90 % de las filas y no
            // dicen nada de nadie. Meterlas en la lista la haría ilegible justo para lo que
            // existe, que es mirarla entera.
            if (!decision.envia && (decision.motivo === 'no_dispara' || decision.motivo === 'no_toca_aun')) continue;

            const fila = {
                citaId: cita.id,
                contactId,
                nombre: contacto?.nombre || null,
                telefono: contacto?.telefono || null,
                language: contacto?.language || 'es',
                waJid: contacto?.wa_jid || null,
                servicioOrigen: cita.service,
                categoriaOrigen: resuelta.origen,
                citaOrigenAt: cita.ends_at || cita.starts_at,
                diasTranscurridos: decision.diasTranscurridos,
                regla: resuelta,
                motivo: decision.motivo,
            };

            if (!decision.envia) { excluidas.push(fila); continue; }

            // El mensaje se construye AQUÍ, en el mismo sitio para el preview y para el
            // envío. Es lo que hace que lo que se lee antes sea literalmente lo que sale.
            const mensaje = buildSeguimientoMensaje({
                nombre: contacto.nombre,
                servicio: resuelta.destino.nombre,
                precio: resuelta.destino.precio,
                precioFinal: resuelta.precioFinal,
                language: contacto.language,
            });
            // Sin mensaje no hay envío: regla 3. Y se dice, no se descarta en silencio.
            if (!mensaje) { excluidas.push({ ...fila, motivo: 'sin_mensaje' }); continue; }
            enviables.push({ ...fila, mensaje });
        }
    }

    return { reglas, enviables, excluidas, ventana };
}

// ─── Camino A: la oferta que viaja DENTRO del mensaje de reseña ─────────────
//
// La dueña lo pidió así —"junto con el enlace de reseña"— y tiene razón en lo que importa:
// a las 2 h de salir del salón es cuando más dispuesta está, y el -10 % es lo que convierte
// un "ya me lo pensaré" en una fecha. Además no cuesta un WhatsApp: el mensaje ya salía.
//
// Lo que NO puede ser es el único camino, y por una razón medida: la reseña sale 2 h después
// de la cita, así que en Cloud API casi siempre está FUERA de la ventana de 24 h y se manda
// por plantilla — y una plantilla de Meta no admite un párrafo de más. Por eso esto solo se
// engancha cuando el envío va por texto libre, y quien rescata al resto es el worker del
// día N.
//
// La `regla_key` lleva el sufijo `#resena` para que la del día N siga siendo suya: son dos
// momentos distintos (uno siembra, otro rescata) y la clienta puede recibir los dos, con 18
// días en medio. Si reserva por el primero, el segundo la excluye sola (`tiene_cita_futura`).

const SUFIJO_RESENA = '#resena';

/**
 * Prepara la oferta para enganchar al mensaje de reseña, YA RESERVADA.
 *
 * Devuelve `{ seguimientoId, mensaje }` o null. Cuando devuelve algo, la fila ya está en
 * 'pendiente': quien llama tiene que enviar y luego confirmar con
 * `confirmarOfertaTrasResena`. Si el envío falla, la fila se queda reservada y el tic
 * siguiente NO vuelve a ofrecer — la reseña sale sola y la oferta cae al camino del día N.
 * Degradar así es deliberado: la alternativa es arriesgar un mensaje repetido.
 */
async function prepararOfertaTrasResena(orgId, cita, { nombre, language } = {}) {
    const db = require('./db');
    const logger = require('../lib/logger');

    const agentConfig = await db.getAgentConfig(orgId);
    const catalogo = Array.isArray(agentConfig?.services) ? agentConfig.services : [];
    const crudas = await db.getConfigValue(orgId, 'seguimientos');
    const listas = (Array.isArray(crudas) ? crudas : [])
        .map(r => resolveSeguimientoRegla(r, catalogo))
        .filter(r => r.ok);
    if (!listas.length) return null;

    const categorias = categoriasDeServicio(cita.service, catalogo);
    // La PRIMERA regla que case. Con varias, ofrecer dos cosas en el mismo mensaje sería
    // pedirle a la clienta que elija justo cuando lo que se busca es que diga que sí.
    const regla = listas.find(r => categorias.includes(r.origen));
    if (!regla) return null;

    const contactId = cita.contacts?.id || cita.contact_id;
    if (!contactId) return null;

    // ¿Ya se le ofreció por esta cita? Cubre el reintento tras un envío fallido y el segundo
    // tic del mismo minuto.
    const previos = await db.getSeguimientosDeContactos(orgId, [contactId]);
    const claveRegla = `${regla.key}${SUFIJO_RESENA}`;
    if (previos.some(s => s.appointment_origen_id === cita.id && s.regla_key === claveRegla)) return null;

    const mensaje = buildSeguimientoMensaje({
        nombre, servicio: regla.destino.nombre,
        precio: regla.destino.precio, precioFinal: regla.precioFinal, language,
    });
    if (!mensaje) return null;   // regla 3: sin las dos cifras no hay oferta

    const seguimientoId = await db.claimSeguimiento(orgId, {
        contactId,
        citaId: cita.id,
        servicioOrigen: cita.service,
        categoriaOrigen: regla.origen,
        citaOrigenAt: cita.ends_at || cita.starts_at,
        reglaKey: claveRegla,
        destinoKey: regla.destino.key,
        destinoNombre: regla.destino.nombre,
        destinoPrecio: regla.destino.precio,
        descuentoPct: regla.descuentoPct,
        precioConDescuento: regla.precioFinal,
        via: 'resena_2h',
        caducaAt: new Date(Date.now() + (regla.dias + 30) * 24 * 60 * 60 * 1000).toISOString(),
    });
    if (!seguimientoId) return null;

    logger.info('seguimiento_oferta_tras_resena_reservada', {
        orgId, citaId: cita.id, regla: regla.key, precio: regla.precioFinal,
    });
    return { seguimientoId, mensaje };
}

/** El mensaje de reseña con la oferta SALIÓ. Nunca lanza: la reseña ya está entregada. */
async function confirmarOfertaTrasResena(orgId, seguimientoId, textoCompleto) {
    const db = require('./db');
    const logger = require('../lib/logger');
    try {
        await db.marcarSeguimientoEnviado(orgId, seguimientoId, { mensaje: textoCompleto });
        return true;
    } catch (e) {
        // La fila se queda en 'pendiente', que es el lado bueno: bloquea el reintento y por
        // tanto el mensaje repetido. Lo que se pierde es la constancia del descuento, y eso
        // lo recoge el vigilante de claims atascados.
        logger.error('seguimiento_oferta_sin_apuntar', { orgId, seguimientoId, error: e.message });
        return false;
    }
}

// ─── El worker ──────────────────────────────────────────────────────────────
//
// Apagado POR DEFECTO. `SEGUIMIENTOS=on` es lo único que lo enciende, y hasta entonces el
// tic corre, calcula y registra en el log lo que HABRÍA mandado — sin mandarlo. Es el mismo
// interruptor que `VIGILANTE_ESPERAS`, y por el mismo motivo: la diferencia entre este worker
// y todos los demás es que este empieza conversaciones, en vez de continuarlas.
//
// Que apague en vez de encender es deliberado: producción arranca con `pm2 start server.js`,
// y un fallo al leer una variable de entorno tiene que dejar esto callado, no hablando.

const CHECK_INTERVAL_MS = 30 * 60 * 1000;   // media hora: esto no corre contra reloj
const PRIMER_BARRIDO_MS = 5 * 60 * 1000;
const CLAIM_ANTIGUO_MS = 30 * 60 * 1000;

// Tope de envíos por tic y por org. No lo impone Meta —de eso ya se encarga el tope de
// broadcast—: lo impone que la primera tanda de verdad no pueda ser grande sin que alguien lo
// haya decidido. `SEGUIMIENTOS_LIMITE=3` para estrenar.
const LIMITE_POR_TIC_DEFECTO = 25;

let waClients = null;

function seguimientosEncendidos() {
    return String(process.env.SEGUIMIENTOS || '').toLowerCase() === 'on';
}

function limitePorTic() {
    const n = Number(process.env.SEGUIMIENTOS_LIMITE);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : LIMITE_POR_TIC_DEFECTO;
}

const MENSAJE_CLAIM_ATASCADO = n =>
    '⚠️ <b>Seguimientos a medias</b>\n\n'
    + `Hay ${n} seguimiento(s) reservados hace rato que no constan como enviados.\n\n`
    + 'Puede que el mensaje saliera y no se apuntara, o que no saliera. <b>No los voy a '
    + 'reintentar solos</b>: reintentar a ciegas puede mandarle el mismo mensaje dos veces a '
    + 'la misma clienta.';

async function procesarSeguimientos() {
    if (!waClients) return;
    const db = require('./db');
    const { getOrgType } = require('./org-registry');
    const { resolveOutboundClient, resolveAutomatedSend } = require('./outbound');
    const { noteSendResult } = require('./channel-health');
    const { alertOnce } = require('./admin-alerts');
    const logger = require('../lib/logger');

    const encendido = seguimientosEncendidos();
    const limite = limitePorTic();

    for (const [orgId, entry] of waClients) {
        try {
            // San Remo fuera, y estructuralmente en vez de por config vacía. Hoy no tiene
            // reglas y no pasaría nada igualmente; el gate existe para que añadirle una por
            // error no le cambie la conducta a la org que no se toca.
            if (getOrgType(orgId) !== 'salon') continue;

            await db.liberarSeguimientosFallidos(orgId);

            const atascados = await db.getSeguimientosPendientesAntiguos(
                orgId, new Date(Date.now() - CLAIM_ANTIGUO_MS).toISOString());
            if (atascados.length) {
                logger.error('seguimiento_claim_atascado', { orgId, n: atascados.length });
                await alertOnce(orgId, `seguimiento_atascado|${atascados.length}`,
                    MENSAJE_CLAIM_ATASCADO(atascados.length));
            }

            const tanda = await construirTanda(orgId, { ahora: new Date() });

            for (const { cruda, resuelta } of tanda.reglas) {
                if (resuelta.ok) continue;
                // Una regla rota no se arregla sola y deja de enviar en silencio. Un aviso por
                // asunto, que es lo que hace alertOnce.
                logger.warn('seguimiento_regla_invalida', {
                    orgId, regla: cruda?.key || null, motivo: resuelta.motivo,
                });
            }

            if (!encendido) {
                // El simulacro. Cuenta y no manda — y lo dice, para que "0 enviados" no se
                // pueda confundir con "no había nadie".
                logger.info('seguimiento_simulacro', {
                    orgId, habria_enviado: tanda.enviables.length, excluidas: tanda.excluidas.length,
                });
                continue;
            }

            const client = resolveOutboundClient(orgId, entry?.client);
            if (!client) {
                logger.warn('seguimiento_wa_no_disponible', { orgId });
                continue;
            }

            let enviados = 0;
            for (const cand of tanda.enviables) {
                if (enviados >= limite) {
                    logger.info('seguimiento_limite_por_tic', { orgId, limite, restantes: tanda.enviables.length - enviados });
                    break;
                }
                // El try va por CANDIDATA. Fuera del bucle, un fallo en una se llevaría por
                // delante a todas las siguientes de esa org en ese tic — la lección de
                // review.js, que lo tenía al nivel de la org.
                try {
                    // 1. RESERVAR. Antes de tocar la red: si el INSERT choca con el UNIQUE,
                    //    otro proceso ya la tiene y aquí no se manda nada.
                    const caducaAt = new Date(Date.now() + diasDeCaducidad(cand) * 24 * 60 * 60 * 1000).toISOString();
                    const seguimientoId = await db.claimSeguimiento(orgId, {
                        contactId: cand.contactId,
                        citaId: cand.citaId,
                        servicioOrigen: cand.servicioOrigen,
                        categoriaOrigen: cand.categoriaOrigen,
                        citaOrigenAt: cand.citaOrigenAt,
                        reglaKey: cand.regla.key,
                        destinoKey: cand.regla.destino.key,
                        destinoNombre: cand.regla.destino.nombre,
                        destinoPrecio: cand.regla.destino.precio,
                        descuentoPct: cand.regla.descuentoPct,
                        precioConDescuento: cand.regla.precioFinal,
                        via: 'seguimiento_dias',
                        caducaAt,
                    });
                    if (!seguimientoId) {
                        logger.info('seguimiento_ya_reservado', { orgId, citaId: cand.citaId, regla: cand.regla.key });
                        continue;
                    }

                    // 2. ENVIAR, por la vía que toque (ventana de 24 h o plantilla). La regla
                    //    NO se reimplementa: es la misma resolveAutomatedSend de reminder y
                    //    review.
                    const decision = await resolveAutomatedSend(orgId, {
                        telefono: cand.telefono,
                        language: cand.language || 'es',
                        plantillaClave: 'plantilla_seguimiento',
                    });

                    if (decision.mode === 'sin_plantilla') {
                        // Fuera de ventana y sin plantilla aprobada: Meta no lo entregaría. Se
                        // libera la reserva para que se reintente cuando la haya.
                        await db.marcarSeguimientoFallido(orgId, seguimientoId, 'sin_plantilla_configurada');
                        logger.warn('seguimiento_sin_plantilla_configurada', { orgId, telefono: cand.telefono, language: cand.language });
                        continue;
                    }

                    const chatId = cand.waJid || `${String(cand.telefono).replace(/\D/g, '')}@c.us`;
                    if (decision.mode === 'template') {
                        await client.sendTemplate(chatId, {
                            name: decision.template.name,
                            language: decision.template.language,
                            params: [cand.nombre || '', cand.mensaje],
                        });
                    } else {
                        await client.sendMessage(chatId, cand.mensaje);
                    }
                    await noteSendResult(orgId, { ok: true });
                    // El bot VE lo que salió (el arreglo del recordatorio, a741fd5): esto es
                    // lo ÚNICO que EMPIEZA conversación, así que sin la nota el bot contesta
                    // a la respuesta del -10 % sin saber qué ofreció ni a qué precio — y
                    // cotizaría el precio completo. TTL = el de la promesa (7 días): la
                    // oferta caduca lenta. Nunca lanza: el mensaje ya salió.
                    try {
                        const { notePendingOutboundTurn } = require('./pending-outbound');
                        notePendingOutboundTurn(orgId, cand.telefono, cand.mensaje, { ttlMs: TTL_NOTA_SEGUIMIENTO_MS });
                    } catch (e2) {
                        logger.error('seguimiento_registro_historial_fallido', { orgId, telefono: cand.telefono, error: e2.message });
                    }

                    // 3. APUNTAR lo que salió, con el texto exacto.
                    await db.marcarSeguimientoEnviado(orgId, seguimientoId, { mensaje: cand.mensaje });
                    enviados++;
                    logger.info('seguimiento_enviado', {
                        orgId, telefono: cand.telefono, regla: cand.regla.key,
                        destino: cand.regla.destino.nombre, precio: cand.regla.precioFinal,
                    });
                } catch (e) {
                    // Aquí NO se marca fallido a ciegas: si el error saltó después del envío,
                    // marcarlo fallido lo reintentaría y la clienta lo recibiría dos veces. La
                    // fila se queda en 'pendiente', que bloquea el reintento, y el vigilante de
                    // claims atascados lo saca a la luz.
                    logger.error('seguimiento_error_candidata', {
                        orgId, citaId: cand.citaId, regla: cand.regla?.key, error: e.message,
                    });
                    await noteSendResult(orgId, { ok: false, error: e, contexto: 'seguimiento post-visita' });
                }
            }
        } catch (e) {
            logger.error('seguimiento_error_org', { orgId, error: e.message });
        }
    }
}

// Cuánto dura la promesa. El plazo de la regla otra vez, más un mes de cortesía: si le
// ofrecemos algo "a las tres semanas", tiene un margen holgado para venir a por ello. Sin
// caducidad, un -10 % de hace ocho meses reaparece en el mostrador y nadie sabe si sigue en
// pie.
function diasDeCaducidad(cand) {
    return (cand?.regla?.dias || 30) + 30;
}

function setClients(clients) { waClients = clients; }

function startSeguimientoWorker(clients) {
    setClients(clients);
    const logger = require('../lib/logger');
    logger.info('seguimiento_worker_iniciado', {
        encendido: seguimientosEncendidos(), limite_por_tic: limitePorTic(),
    });
    // `.unref()` en los dos: importar este módulo no puede ser la razón de que un proceso
    // siga vivo (ver CLAUDE.md, los timers de arranque).
    setInterval(procesarSeguimientos, CHECK_INTERVAL_MS).unref();
    setTimeout(procesarSeguimientos, PRIMER_BARRIDO_MS).unref();
}

module.exports = {
    startSeguimientoWorker,
    prepararOfertaTrasResena,
    confirmarOfertaTrasResena,
    SUFIJO_RESENA,
    procesarSeguimientos,
    setClients,
    seguimientosEncendidos,
    limitePorTic,
    construirTanda,
    interpretarBotActivo,
    decidirSeguimiento,
    yaSeHizoElDestino,
    diasDesde,
    telefonoServible,
    MOTIVO_TEXTO,
    VENTANA_MARGEN_DIAS,
    MIN_DIAS_ENTRE_ENVIOS,
    TELEFONO_DIGITOS_MIN,
};
