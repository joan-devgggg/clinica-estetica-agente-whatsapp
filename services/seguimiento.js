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

module.exports = {
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
