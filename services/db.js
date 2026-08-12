/**
 * db.js — Supabase storage (multi-tenant schema)
 * Capa de datos del bot — todas las funciones reciben orgId como primer parámetro.
 */

const supabase = require('./supabase');
const logger = require('../lib/logger');
const { NO_STYLIST_KEY, computeServiceBilling, IDIOMAS_SOPORTADOS, resolveLanguageSource, LANGUAGE_SOURCES, motivoNoEnviable } = require('./helpers');
// date-utils es PURO (solo Intl/Date) y no arrastra la capa de datos, así que se puede
// requerir aquí sin ciclo. Aporta toLocalDateStr, que es lo único que debe decidir el día de
// caja: BUSINESS_TZ = Europe/Madrid, nunca UTC.
const { toLocalDateStr } = require('./date-utils');

const DEFAULT_ORG = process.env.ORGANIZATION_ID || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── Helpers internos ─────────────────────────────────────────────────────────

function resolveOrg(orgId) { return orgId || DEFAULT_ORG; }

// Lecturas del camino de DISPONIBILIDAD de Sante: un error de Supabase (RLS denegado,
// timeout, corte de red) NO puede degradarse a "sin datos".
//
// Antes, el patrón `const { data } = await …; return data || []` descartaba `error` y
// convertía un fallo de infraestructura en "no hay huecos" — cita perdida y escalada
// anunciando una avería inexistente. Y en la dirección contraria era peor: si la que
// fallaba era la lectura de CITAS, el motor creía que la agenda estaba vacía y ofrecía
// horas ya reservadas (disponibilidad fantasma → doble reserva).
//
// Lanzar deja que el llamador distinga "falló la BD" de "no hay hueco", que es justo lo
// que el bot necesita para decir la verdad. Auditoría 28/07/2026.
function assertRead(error, tabla) {
    if (!error) return;
    logger.error('db_read_error', { tabla, error: error.message || String(error), code: error.code });
    throw new Error(`Lectura de ${tabla} falló: ${error.message || error}`);
}

// Gemelo de assertRead para las ESCRITURAS del camino de escalada. Mismo bug, otra
// dirección: `await supabase.from(…).insert(…)` sin mirar `error` convierte un INSERT
// fallido (FK rota sobre contact_id, RLS, timeout, CHECK sobre type) en un `null` que el
// llamante lee como "ya está". Una escalada la componen TRES escrituras —la fila en
// pending_actions, bot_mode='manual' y escalation_reason— y si cualquiera se pierde en
// silencio la promesa que se le hizo al cliente ("en breve te atiende nuestro equipo") no
// tiene nada detrás: ni fila en el panel, y con bot_mode intacto la reconciliación revive
// al bot encima de alguien que ya está esperando a un humano.
//
// OJO con el límite: un UPDATE cuyos .eq() no casan ninguna fila devuelve error=null. Esto
// atrapa fallos de infraestructura, NO un "ese teléfono no existe en contacts".
function assertWrite(error, tabla, op) {
    if (!error) return;
    logger.error('db_write_error', { tabla, op, error: error.message || String(error), code: error.code });
    throw new Error(`Escritura (${op}) en ${tabla} falló: ${error.message || error}`);
}

// Cierra justo el límite que documenta assertWrite: una escritura DIRIGIDA a una fila
// concreta cuyos .eq() no casan nada devuelve error=null, y el llamante lo leía como éxito.
// Así, `POST /api/lista-vip/<id inexistente o de otra org>` respondía 200 {ok:true} y el
// panel cantaba "Añadido a VIP" sin haber escrito nada — la misma clase de fallo que el bug
// de la ficha de cliente. Requiere que la sentencia lleve `.select('id')` para saber cuántas
// filas tocó. Auditoría de integridad 29-30/07/2026.
function assertRowsAffected(error, data, tabla, op) {
    assertWrite(error, tabla, op);
    const filas = Array.isArray(data) ? data.length : (data ? 1 : 0);
    if (filas === 0) {
        logger.error('db_write_sin_efecto', { tabla, op });
        throw new Error(`Escritura (${op}) en ${tabla} no encontró la fila: nada guardado`);
    }
    return filas;
}

// Móvil español escrito sin prefijo internacional: 9 dígitos empezando por 6 o 7.
// Se deja fuera a los fijos (8…/9…) A PROPÓSITO: WhatsApp es móvil, y un 9 dígitos que
// empieza por 9 choca con numeraciones de otros países — prefijar mal mandaría el mensaje
// a un número ajeno, que es peor que no prefijar.
const MOVIL_ES_SIN_PREFIJO = /^[67]\d{8}$/;

// Normaliza a E.164 sin '+': solo dígitos, con prefijo de país.
//
// La clave de identidad de un contacto es `contacts.wa_phone` y findByPhone hace un
// .eq() EXACTO. Sin este prefijado, "611209542" (tecleado en el panel) y "34611209542"
// (el que llega por WhatsApp) son dos personas distintas: el 01/08/2026 eso creó un
// contacto duplicado con la cita colgando de él, invisible para el bot.
//
// COMPARTIDO CON SAN REMO. La normalización es un no-op para todo lo que existe hoy en
// la base de datos (San Remo 2/2 y Sante 701/705 ya son '34' + 9 dígitos) y para los JID
// y LID del pipeline de entrada. Cubierto por tests/sanitize-phone.test.js, cuya primera
// mitad es un candado de regresión sobre esas formas.
function sanitizePhone(phone) {
    if (!phone || typeof phone !== 'string') return '';
    const digits = phone.replace(/["'\s]/g, '').replace(/@c\.us$|@lid$/g, '').replace(/\D/g, '').trim();
    return MOVIL_ES_SIN_PREFIJO.test(digits) ? `34${digits}` : digits;
}

// Todas las formas con las que un MISMO teléfono puede estar escrito en `contacts.wa_phone`.
//
// sanitizePhone arregló el problema hacia delante, pero las filas duplicadas que creó antes
// siguen en producción y UNIQUE (organization_id, wa_phone) no las detecta: compara el string
// literal, así que '611209542' y '34611209542' son dos claves distintas. Cuando la cita cuelga
// del duplicado, buscarla por el contact_id "bueno" no la encuentra y el bot le dice a la
// clienta que no tiene ninguna cita teniéndola. Ese fue el incidente del 01/08/2026.
//
// Se enumeran variantes EXPLÍCITAS en vez de un `ilike '%sufijo'`: el sufijo colisiona entre
// países (un número extranjero acabado en los mismos 9 dígitos casaría) y devolver el contacto
// de otra persona es infinitamente peor que no encontrar el propio.
//
// SOLO PARA LECTURA. El camino de escritura (findByPhone → saveLead) sigue usando únicamente
// la forma canónica: ampliarlo cambiaría a qué fila escribe San Remo.
function phoneVariants(telefono) {
    const canonico = sanitizePhone(telefono);
    if (!canonico) return [];
    const digitos = new Set([canonico]);
    // '34611209542' → '611209542' (la forma que teclea el panel sin prefijo).
    if (canonico.startsWith('34') && MOVIL_ES_SIN_PREFIJO.test(canonico.slice(2))) {
        digitos.add(canonico.slice(2));
    }
    // updateLeadById escribe `campos.telefono` tal cual, sin pasar por sanitizePhone, así que
    // un '+34…' tecleado en la ficha del panel puede haber llegado con el '+' incluido.
    return [...digitos].flatMap(d => [d, `+${d}`]);
}

// Ids de TODOS los contactos que comparten teléfono, no solo el canónico. El primero es el
// que devolvería findByPhone (misma forma y desempate por created_at), y detrás van los
// duplicados; quien lea citas debe mirarlos todos.
async function findContactIdsByPhone(orgId, telefono) {
    const oid = resolveOrg(orgId);
    const variantes = phoneVariants(telefono);
    if (!variantes.length) return [];
    const canonico = variantes[0];
    const { data, error } = await supabase
        .from('contacts')
        .select('id, wa_phone, created_at')
        .eq('organization_id', oid)
        .in('wa_phone', variantes);
    assertRead(error, 'contacts');
    return (data || [])
        .sort((a, b) => {
            const ca = a.wa_phone === canonico ? 0 : 1;
            const cb = b.wa_phone === canonico ? 0 : 1;
            if (ca !== cb) return ca - cb;
            return String(b.created_at || '').localeCompare(String(a.created_at || ''));
        })
        .map(r => r.id);
}

function now() { return new Date().toISOString(); }

function rowToPublic(row) {
    if (!row) return null;
    return {
        id:                    row.id,
        nombre:                row.full_name,
        telefono:              row.wa_phone,
        personas:              row.party_size,
        ocasion:               row.occasion,
        fecha_cita:            row.fecha_cita,
        hora_cita:             row.hora_cita,
        estado_cita:           row.estado || 'pendiente',
        bot_mode:              row.bot_mode || 'auto',
        recordatorio_enviado:  !!row.recordatorio_enviado,
        origen:                row.origen,
        notas:                 row.notas,
        appointment_id:        row.appointment_id,
        is_blacklisted:        !!row.is_blacklisted,
        blacklist_reason:      row.blacklist_reason,
        is_vip:                !!row.is_vip,
        escalation_reason:     row.escalation_reason || null,
        visit_count:           row.visit_count || 0,
        allergies:             row.allergies,
        preferences:           row.preferences,
        formula_coloracion:    row.formula_coloracion,
        preferred_stylist_id:  row.preferred_stylist_id || null,
        last_stylist:          row.last_stylist || null,
        language:              row.language || 'es',
        // ¿El idioma es una CONJETURA por el nombre (script de clasificación) o se observó en
        // conversación? Sin distinguirlo, el selector de la ficha es inútil: 184 de las 720
        // fichas de Sante llevan un idioma inferido y son indistinguibles de las verificadas,
        // así que nadie sabe cuál merece la pena revisar.
        language_inferred:     !!(row.metadata && typeof row.metadata === 'object' && row.metadata.language_inferred),
        // La misma pregunta, con las tres respuestas posibles en vez de un booleano:
        // 'observed' | 'inferred' | 'default'. El booleano de arriba solo separaba la
        // conjetura por nombre; dejaba juntos el idioma que la clienta demostró y el 'es'
        // del INSERT que no eligió nadie, que son justo los dos que hay que distinguir para
        // decidir si el bot puede fiarse de la columna. Ver resolveLanguageSource (helpers).
        language_source:       resolveLanguageSource(row),
        wa_jid:                (row.metadata && typeof row.metadata === 'object') ? (row.metadata.wa_jid || null) : null,
        // Trato que la clienta PIDIÓ ('formal' | 'informal'), o null si nunca lo dijo. Null
        // no es "de tú": es que no consta, y el bot sigue con su registro por defecto.
        tratamiento:           (row.metadata && typeof row.metadata === 'object') ? (row.metadata.tratamiento || null) : null,
        // Traza del retorno automático a 'auto' (opción C). Sin esto, en el panel un
        // contacto devuelto por el barrido y uno devuelto a mano son la misma fila: nadie
        // podría saber si el bot volvió a hablar porque alguien lo decidió o porque pasaron
        // siete días. La escribe devolverContactoAAuto; aquí solo se expone.
        auto_return:           (row.metadata && typeof row.metadata === 'object') ? (row.metadata.auto_return || null) : null,
        created_at:            row.created_at,
        updated_at:            row.updated_at,
    };
}

// ─── Leads / Contacts ────────────────────────────────────────────────────────

async function findByPhone(orgId, telefono) {
    const oid = resolveOrg(orgId);
    const phone = sanitizePhone(telefono);
    if (!phone) return null;
    const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', oid)
        .eq('wa_phone', phone)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return rowToPublic(data);
}

// Persiste el JID de WhatsApp canónico del contacto (p.ej. "<lid>@lid" o "<num>@c.us") en
// metadata.wa_jid. Necesario para enviar mensajes manuales al chat correcto cuando el wa_phone
// es un LID: construir "<lid>@c.us" apunta a un chat inexistente y desadjunta el frame de
// puppeteer. Solo escribe si el valor cambia, para no actualizar en cada mensaje entrante.
async function setContactJid(orgId, telefono, jid) {
    const oid = resolveOrg(orgId);
    const phone = sanitizePhone(telefono);
    if (!phone || !jid) return;
    const { data: row } = await supabase
        .from('contacts')
        .select('id, metadata')
        .eq('organization_id', oid)
        .eq('wa_phone', phone)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (!row) return;
    const meta = (row.metadata && typeof row.metadata === 'object') ? row.metadata : {};
    if (meta.wa_jid === jid) return; // sin cambios → no escribimos
    await supabase
        .from('contacts')
        .update({ metadata: { ...meta, wa_jid: jid }, updated_at: now() })
        .eq('id', row.id)
        .eq('organization_id', oid);
}

// Devuelve el JID canónico persistido (metadata.wa_jid) del contacto, o null.
async function getContactWaJid(orgId, telefono) {
    const oid = resolveOrg(orgId);
    const phone = sanitizePhone(telefono);
    if (!phone) return null;
    const { data: row } = await supabase
        .from('contacts')
        .select('metadata')
        .eq('organization_id', oid)
        .eq('wa_phone', phone)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    const meta = row?.metadata;
    return (meta && typeof meta === 'object' && typeof meta.wa_jid === 'string') ? meta.wa_jid : null;
}

async function findById(orgId, id) {
    const oid = resolveOrg(orgId);
    if (!id) return null;
    const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', oid)
        .eq('id', id)
        .maybeSingle();
    return rowToPublic(data);
}

async function getAllLeads(orgId, { limit = 200, offset = 0, estado, search, hasConversation } = {}) {
    const oid = resolveOrg(orgId);
    let query = supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', oid);

    if (estado) query = query.eq('estado', estado);
    if (search) {
        query = query.or(
            `full_name.ilike.%${search}%,wa_phone.ilike.%${search}%`
        );
    }

    if (hasConversation) {
        const { data: convRows } = await supabase
            .from('conversations')
            .select('contact_id')
            .eq('organization_id', oid);
        const ids = [...new Set((convRows || []).map(c => c.contact_id))];
        if (ids.length === 0) return [];
        query = query.in('id', ids);
    }

    const { data } = await query
        .order('updated_at', { ascending: false })
        .range(offset, offset + limit - 1);
    return (data || []).map(rowToPublic);
}

async function getLeadsByDateRange(orgId, desde, hasta) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', oid)
        .not('fecha_cita', 'is', null)
        .gte('fecha_cita', desde)
        .lte('fecha_cita', hasta)
        .not('estado', 'eq', 'cancelado')
        .order('fecha_cita', { ascending: true })
        .order('hora_cita', { ascending: true });
    return (data || []).map(rowToPublic);
}

async function saveLead(orgId, datos) {
    const oid = resolveOrg(orgId);
    if (!datos.telefono) return null;
    const phone = sanitizePhone(datos.telefono);

    if (datos.leadId) {
        await updateLead(oid, datos);
        return datos.leadId;
    }

    const existing = await findByPhone(oid, phone);
    if (existing) {
        await updateLead(oid, { ...datos, leadId: existing.id });
        return existing.id;
    }

    // allergies/preferences/formula_coloracion se descartaban en este INSERT (sí estaban en
    // los dos UPDATE): el LLM tiene instrucción de extraer alergias y preferencias, y si el
    // contacto se creaba en ese mismo turno se perdían sin rastro. Son datos clínicos.
    const { data, error } = await supabase
        .from('contacts')
        .insert({
            organization_id:    oid,
            wa_phone:           phone,
            full_name:          datos.nombre || null,
            party_size:         datos.personas || null,
            occasion:           datos.ocasion || null,
            fecha_cita:         datos.fecha_cita || null,
            hora_cita:          datos.hora_cita || null,
            estado:             datos.estado_cita || 'pendiente',
            origen:             datos.origen || 'whatsapp',
            notas:              datos.notas || null,
            allergies:          datos.allergies || null,
            preferences:        datos.preferences || null,
            formula_coloracion: datos.formula_coloracion || null,
            appointment_id:     datos.appointment_id || null,
            language:           datos.language || 'es',
            // De dónde sale ese idioma, marcado EN EL MISMO INSERT que lo escribe. Sin esto
            // el 'es' de arriba —que es un valor de relleno, no una observación— queda en la
            // columna con el mismo aspecto que uno detectado en conversación, y aguas abajo
            // se usa igual: el prompt se lo presenta al LLM como "último idioma detectado" y
            // la campaña le manda la plantilla española. `datos.language` solo llega relleno
            // cuando la clienta YA ha escrito algo en este turno, así que ahí sí es observado.
            metadata:           { language_source: datos.language ? 'observed' : 'default' },
            updated_at:         now(),
        })
        .select('id')
        .single();
    assertWrite(error, 'contacts', 'insert saveLead');
    return data?.id ?? null;
}

// Columnas de `contacts` que NO son text: un '' que llegue de un <input> vacío del panel
// (date/number sin valor devuelven cadena vacía) hace que Postgres rechace la sentencia
// ENTERA — p.ej. 22007 «invalid input syntax for type date: ""» — y con ella se pierden
// también las alergias, preferencias y notas que sí venían rellenas. Se normaliza a null.
const CONTACT_NON_TEXT_COLUMNS = new Set([
    'fecha_cita',            // date
    'party_size',            // integer
    'preferred_stylist_id',  // uuid
]);

function normalizeContactUpdates(updates) {
    for (const col of Object.keys(updates)) {
        if (CONTACT_NON_TEXT_COLUMNS.has(col) && updates[col] === '') updates[col] = null;
    }
    return updates;
}

// Una cita que pasa a 'confirmado' es, por definición, una que aún no ha recibido su
// recordatorio. Sin este reset, recordatorio_enviado se queda en true para siempre tras el
// primer aviso (nunca se pone a false en ningún otro sitio) y reminder.js — que lee esta
// columna, no la de `appointments` — deja de avisar a esa clienta en TODAS sus visitas
// siguientes. Afecta a los tres caminos que confirman una cita: bot.js (Sante y Bizum de
// San Remo) y el confirm manual del panel (webhook.js).
function resetRecordatorioIfConfirmado(updates, estadoCita) {
    if (estadoCita === 'confirmado') updates.recordatorio_enviado = false;
}

async function updateLead(orgId, datos) {
    const oid = resolveOrg(orgId);
    if (!datos.telefono && !datos.leadId) return false;
    const phone = sanitizePhone(datos.telefono);

    let existing = null;
    if (datos.leadId) {
        existing = await findById(oid, datos.leadId);
    } else {
        existing = await findByPhone(oid, phone);
    }

    // El leadId apunta a una fila que ya no existe (p.ej. el contacto se borró desde el panel
    // con la sesión del bot aún viva). Se crea de nuevo, pero SIN reenviar el leadId muerto:
    // saveLead delega en updateLead cuando recibe uno, y updateLead volvía a no encontrarlo →
    // bucle asíncrono infinito entre las dos, machacando Supabase a lecturas para siempre.
    // (No revienta la pila porque cada await cede el turno, así que no hay traza que lo delate.)
    if (!existing) {
        const { leadId: _muerto, ...sinLeadId } = datos;
        return !!await saveLead(oid, sinLeadId);
    }

    const updates = { updated_at: now() };
    if (datos.nombre !== undefined)              updates.full_name = datos.nombre;
    if (datos.telefono !== undefined)            updates.wa_phone = phone;
    if (datos.personas !== undefined)            updates.party_size = datos.personas;
    if (datos.ocasion !== undefined)             updates.occasion = datos.ocasion;
    if (datos.fecha_cita !== undefined)          updates.fecha_cita = datos.fecha_cita;
    if (datos.hora_cita !== undefined)           updates.hora_cita = datos.hora_cita;
    if (datos.estado_cita !== undefined)         updates.estado = datos.estado_cita;
    if (datos.notas !== undefined)               updates.notas = datos.notas;
    if (datos.appointment_id !== undefined)      updates.appointment_id = datos.appointment_id;
    if (datos.allergies !== undefined)           updates.allergies = datos.allergies;
    if (datos.preferences !== undefined)         updates.preferences = datos.preferences;
    // formula_coloracion faltaba aquí (sí está en updateLeadById): los dos escritores de la
    // misma columna tienen que aceptar los mismos campos o uno de ellos los tira en silencio.
    if (datos.formula_coloracion !== undefined)  updates.formula_coloracion = datos.formula_coloracion;

    resetRecordatorioIfConfirmado(updates, datos.estado_cita);
    normalizeContactUpdates(updates);
    // Mismo patrón que updateLeadById: sin mirar `error` este UPDATE devolvía `true` con la
    // escritura perdida — el bug de la ficha de cliente, en el camino del bot.
    const { data, error } = await supabase
        .from('contacts')
        .update(updates)
        .eq('id', existing.id)
        .eq('organization_id', oid)
        .select('id');
    assertRowsAffected(error, data, 'contacts', 'updateLead');
    return true;
}

async function updateLeadById(orgId, id, campos) {
    const oid = resolveOrg(orgId);
    const fieldMap = {
        nombre:         'full_name',
        telefono:       'wa_phone',
        personas:       'party_size',
        ocasion:        'occasion',
        fecha_cita:     'fecha_cita',
        hora_cita:      'hora_cita',
        estado_cita:    'estado',
        notas:          'notas',
        origen:         'origen',
        allergies:      'allergies',
        preferences:    'preferences',
        formula_coloracion: 'formula_coloracion',
        appointment_id: 'appointment_id',
        // `language` decide qué plantilla de Meta recibe cada clienta en las campañas, y hasta
        // ahora NADIE podía corregirlo desde fuera del bot: no estaba en este mapa ni en el de
        // updateLead, así que la única escritura era updateContactLanguage (detección
        // automática). Una dueña que SABE que una clienta es ucraniana no tenía forma de
        // decirlo — y por la vía automática 'uk' es casi inalcanzable.
        language:       'language',
    };
    const updates = { updated_at: now() };
    for (const [oldKey, newKey] of Object.entries(fieldMap)) {
        if (campos[oldKey] !== undefined) updates[newKey] = campos[oldKey];
    }
    // Un idioma fuera de lista no es un campo mal rellenado que se pueda normalizar: se
    // usaría como clave contra `config.plantilla_*` y la campaña omitiría a esa clienta
    // ('sin_plantilla') sin que nadie relacione una cosa con la otra.
    if (updates.language !== undefined && !IDIOMAS_SOPORTADOS.includes(updates.language)) {
        throw new Error(`Idioma no soportado: '${updates.language}'. Válidos: ${IDIOMAS_SOPORTADOS.join(', ')}`);
    }
    // Lo ha elegido una PERSONA mirando la ficha: es la fuente más fiable que puede tener esta
    // columna y tiene que quedar dicho. Sin la marca, un idioma corregido a mano conserva la de
    // 'default' o 'inferred' y el bot sigue sin fiarse de él — la dueña corrige y no pasa nada.
    // Solo entra por aquí el salón (el selector está gateado con isSalon), así que San Remo no
    // paga esta lectura extra. La fusión es obligatoria: un UPDATE de jsonb sustituye el objeto
    // entero y se llevaría wa_jid y auto_return por delante.
    if (updates.language !== undefined) {
        const { data: row, error: readError } = await supabase
            .from('contacts')
            .select('metadata')
            .eq('id', id)
            .eq('organization_id', oid)
            .maybeSingle();
        if (readError) {
            // Se guarda el idioma sin la marca antes que arriesgar el resto de metadata con un
            // objeto incompleto: el dato que la dueña acaba de escribir no se pierde.
            logger.warn('idioma_fuente_no_marcada', { orgId: oid, contactId: id, error: readError.message });
        } else {
            const meta = (row?.metadata && typeof row.metadata === 'object') ? row.metadata : {};
            updates.metadata = {
                ...meta,
                language_source: 'observed',
                language_observed_at: now(),
                language_inferred: false,
            };
        }
    }
    resetRecordatorioIfConfirmado(updates, campos.estado_cita);
    normalizeContactUpdates(updates);
    // El error de Supabase se PROPAGA: devolver la fila releída sin mirarlo hacía que un
    // UPDATE fallido se viese como un guardado correcto (200 con los valores viejos).
    const { error } = await supabase.from('contacts').update(updates).eq('id', id).eq('organization_id', oid);
    if (error) throw new Error(`No se pudo guardar el contacto: ${error.message}`);
    return findById(oid, id);
}

// Borra un contacto. Y borra en CASCADA sus citas, sus conversaciones y sus mensajes
// (contacts es padre ON DELETE CASCADE de las tres) — que es mucho más de lo que sugiere
// "eliminar cliente", pero es el comportamiento que ya había.
//
// El `error` NO se miraba, así que un DELETE rechazado devolvía undefined y el endpoint
// respondía 200 {ok:true}: el panel decía "borrado" sobre un contacto que seguía ahí. Antes
// era improbable; desde la migración 035 es un camino REAL — si alguna de sus citas tiene un
// cobro registrado, el RESTRICT de cobros.appointment_id aborta la cascada entera y el
// borrado falla. Ese fallo tiene que llegar arriba para poder explicarse.
async function deleteLead(orgId, id) {
    const oid = resolveOrg(orgId);
    const { error } = await supabase.from('contacts').delete().eq('id', id).eq('organization_id', oid);
    assertWrite(error, 'contacts', 'deleteLead');
    return true;
}

async function marcarCitaCompletada(orgId, telefono) {
    const oid = resolveOrg(orgId);
    const phone = sanitizePhone(telefono);
    await supabase
        .from('contacts')
        .update({ estado: 'completado', updated_at: now() })
        .eq('organization_id', oid)
        .eq('wa_phone', phone);
    return true;
}

// Devolvía `true` sin mirar el error NI cuántas filas tocó, y esa es la parte que hace daño:
// el mensaje ya ha salido al móvil de la clienta y `recordatorio_enviado` se queda en false,
// así que el tic siguiente (5 min) la vuelve a encontrar pendiente y le manda OTRO
// recordatorio. Y otro. Sin un solo log, porque nada lo detectaba.
//
// Con assertRowsAffected el fallo por fin existe, y quien llama puede reintentarlo en vez de
// reenviar (ver `marcarRecordatorioConReintentos` en reminder.js). Requiere `.select('id')`.
async function marcarRecordatorioSent(orgId, id) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('contacts')
        .update({ recordatorio_enviado: true, updated_at: now() })
        .eq('id', id)
        .eq('organization_id', oid)
        .select('id');
    assertRowsAffected(error, data, 'contacts', 'marcar recordatorio_enviado=true');
    return true;
}

// Excluye lista negra: un contacto bloqueado no recibe mensajes del negocio. El guard de
// bot.js solo cubre la CONVERSACIÓN (lo que la clienta escribe); los salientes automáticos
// —recordatorio 24 h y petición de reseña— salían igual porque nadie miraba is_blacklisted.
async function getLeadsPendientesRecordatorio(orgId) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', oid)
        .eq('estado', 'confirmado')
        .eq('recordatorio_enviado', false)
        .not('fecha_cita', 'is', null)
        .or('is_blacklisted.is.null,is_blacklisted.eq.false');
    return (data || []).map(rowToPublic);
}

// ─── Config ───────────────────────────────────────────────────────────────────

async function getConfigValue(orgId, clave) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('config')
        .select('valor')
        .eq('organization_id', oid)
        .eq('clave', clave)
        .maybeSingle();
    if (!data) return null;
    try { return JSON.parse(data.valor); } catch { return data.valor; }
}

/**
 * Como getConfigValue, pero además con el `updated_at` de la fila.
 *
 * Lo necesita el vigilante de "bot pausado demasiado tiempo": el instante en que se pausó es
 * exactamente ese `updated_at` —setConfigValue lo escribe en cada upsert—, así que no hace
 * falta ninguna columna nueva para saber desde cuándo dura la pausa.
 *
 * @returns {Promise<{valor: any, updated_at: string} | null>}
 */
async function getConfigEntry(orgId, clave) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('config')
        .select('valor, updated_at')
        .eq('organization_id', oid)
        .eq('clave', clave)
        .maybeSingle();
    assertRead(error, 'config');
    if (!data) return null;
    let valor = data.valor;
    try { valor = JSON.parse(data.valor); } catch { /* texto plano */ }
    return { valor, updated_at: data.updated_at };
}

// Devolvía `true` sin mirar el error NI cuántas filas tocó, y de aquí cuelga todo lo que la
// dueña configura: `bot_activo`, la ventana del recordatorio, las horas de la reseña, las
// plantillas. El panel decía "guardado" y el toggle se quedaba puesto en pantalla sobre una
// escritura que no había ocurrido; al recargar volvía el valor viejo y no había forma de saber
// si es que no se intentó o es que falló.
//
// `.select('clave')` es lo que permite contar filas: sin él, un upsert que no casa nada
// devuelve error=null y se leía como éxito (es justo el límite que documenta assertWrite).
// `config` no tiene `id` — su PK es (organization_id, clave) —, por eso se pide `clave`.
//
// LANZA. Los dos call sites lo saben: `PUT /api/config/:clave` lo convierte en 500, y
// `setBotActivo` (bot.js) no puede esperarlo y lo recoge con un catch que loguea.
async function setConfigValue(orgId, clave, valor) {
    const oid = resolveOrg(orgId);
    const valorStr = typeof valor === 'string' ? valor : JSON.stringify(valor);
    const { data, error } = await supabase
        .from('config')
        .upsert(
            { organization_id: oid, clave, valor: valorStr, updated_at: now() },
            { onConflict: 'organization_id,clave' }
        )
        .select('clave');
    assertRowsAffected(error, data, 'config', `upsert ${clave}`);
    return true;
}

async function getAllConfig(orgId) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('config')
        .select('clave, valor')
        .eq('organization_id', oid);
    const result = {};
    for (const row of (data || [])) {
        try { result[row.clave] = JSON.parse(row.valor); } catch { result[row.clave] = row.valor; }
    }
    return result;
}

// ─── Messages ────────────────────────────────────────────────────────────────

async function findOrCreateConversation(orgId, contactId) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('conversations')
        .upsert(
            { organization_id: oid, contact_id: contactId, last_message_at: new Date().toISOString() },
            { onConflict: 'organization_id,contact_id', ignoreDuplicates: false }
        )
        .select('id')
        .single();
    if (data) return data.id;
    if (error) {
        const { data: existing } = await supabase
            .from('conversations')
            .select('id')
            .eq('organization_id', oid)
            .eq('contact_id', contactId)
            .limit(1)
            .single();
        return existing?.id ?? null;
    }
    return null;
}

// Violación de UNIQUE en Postgres. `messages.wa_message_id` lo es, así que este código
// significa "ese mensaje ya está guardado", no "ha fallado la escritura".
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Guarda un mensaje.
 *
 * `waMessageId` y `raw` existían en el esquema desde 001 y NADIE los rellenaba. Costaba dos
 * cosas concretas:
 *
 *   · Sin `wa_message_id` no hay red contra la reentrega del webhook de Cloud API. Meta
 *     reintenta si tardamos en responder 200, y el único dedupe era `TTLMessageDedupe`: un
 *     Map en RAM, 60 s, por proceso. Un reinicio, un reintento tardío o un segundo proceso
 *     y el mismo mensaje se guardaba dos veces. La columna es UNIQUE: la base de datos lo
 *     rechaza sola, sobreviva o no el proceso.
 *   · Sin `raw` no queda el payload del proveedor. Cuando un mensaje llega raro (un tipo de
 *     media inesperado, un `type` que no sabíamos que existía) no hay NADA que mirar
 *     después: el log tiene lo que decidimos loguear, y eso ya es una interpretación.
 *
 * El duplicado NO es un error: se registra y se devuelve null, que es lo que el llamante ya
 * trataba como "no se guardó nada nuevo". El resto de errores sí se registran — antes se
 * descartaban en silencio y un INSERT fallido era indistinguible de uno correcto.
 */
async function saveMessage(orgId, { telefono, contenido, direccion, esManual = false, waMessageId = null, raw = null }) {
    const oid = resolveOrg(orgId);
    const phone = sanitizePhone(telefono);
    if (!phone || !contenido) return null;

    let contact = await findByPhone(oid, phone);
    if (!contact) {
        const newId = await saveLead(oid, { telefono: phone });
        contact = await findById(oid, newId);
    }
    if (!contact) return null;

    const convId = await findOrCreateConversation(oid, contact.id);
    if (!convId) return null;

    const direction = direccion === 'entrante' ? 'inbound' : 'outbound';
    const sender    = direction === 'inbound' ? 'contact' : (esManual ? 'human' : 'bot');

    const { data, error } = await supabase
        .from('messages')
        .insert({
            conversation_id: convId,
            organization_id: oid,
            wa_message_id: waMessageId || null,
            direction,
            sender,
            content: contenido,
            raw: raw || null,
            created_at: now(),
        })
        .select('id')
        .single();

    if (error) {
        if (error.code === PG_UNIQUE_VIOLATION) {
            logger.info('mensaje_duplicado_ignorado', { orgId: oid, waMessageId, direction });
            return null;
        }
        logger.error('db_write_error', { tabla: 'messages', op: 'insert', error: error.message, code: error.code });
        return null;
    }

    await supabase
        .from('conversations')
        .update({ last_message_at: now() })
        .eq('id', convId);

    return data?.id ?? null;
}

async function getMessages(orgId, telefono, { limit = 200 } = {}) {
    const oid = resolveOrg(orgId);
    const phone = sanitizePhone(telefono);
    if (!phone) return [];

    const contact = await findByPhone(oid, phone);
    if (!contact) return [];

    const { data: conv } = await supabase
        .from('conversations')
        .select('id')
        .eq('organization_id', oid)
        .eq('contact_id', contact.id)
        .maybeSingle();
    if (!conv) return [];

    // Traemos los N mensajes MÁS RECIENTES (no los más antiguos). Antes se ordenaba
    // ascending + limit, que devolvía los primeros N y nunca los nuevos en conversaciones
    // largas (>N mensajes) — ni recargando. Pedimos descending y revertimos a orden
    // cronológico para mostrar.
    const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: false })
        .limit(limit);

    return (data || []).reverse().map(m => ({
        id:         m.id,
        lead_id:    contact.id,
        telefono:   phone,
        direccion:  m.direction === 'inbound' ? 'entrante' : 'saliente',
        contenido:  m.content,
        es_manual:  m.sender === 'human',
        timestamp:  m.created_at,
    }));
}

// Ventana de servicio de WhatsApp Cloud API: 24 h desde el último mensaje ENTRANTE.
const VENTANA_24H_MS = 24 * 60 * 60 * 1000;

/**
 * Timestamp (ISO) del último mensaje ENTRANTE de un contacto, o null si nunca escribió.
 *
 * No existe ningún `last_inbound_at` persistido: el webhook de Cloud API descarta el
 * `timestamp` de Meta, así que la única fuente es messages.direction='inbound'. Ojo:
 * `conversations.last_message_at` NO sirve — no distingue dirección, y un saliente
 * nuestro lo refrescaría, reabriendo una ventana que Meta considera cerrada.
 *
 * Usa assertRead: si la BD falla, debe reventar. Devolver null aquí haría creer que el
 * contacto está fuera de ventana y mandaría plantilla de más (coste real por conversación).
 */
async function getLastInboundAt(orgId, telefono) {
    const oid = resolveOrg(orgId);
    const phone = sanitizePhone(telefono);
    if (!phone) return null;

    const contact = await findByPhone(oid, phone);
    if (!contact) return null;

    const { data: conv, error: convErr } = await supabase
        .from('conversations')
        .select('id')
        .eq('organization_id', oid)
        .eq('contact_id', contact.id)
        .maybeSingle();
    assertRead(convErr, 'conversations');
    if (!conv) return null;

    const { data, error } = await supabase
        .from('messages')
        .select('created_at')
        .eq('conversation_id', conv.id)
        .eq('direction', 'inbound')
        .order('created_at', { ascending: false })
        .limit(1);
    assertRead(error, 'messages');

    return data?.[0]?.created_at || null;
}

/**
 * Versión EN BLOQUE de getLastInboundAt: Map<wa_phone normalizado, ISO|null>.
 *
 * getLastInboundAt cuesta 3 consultas secuenciales por contacto (findByPhone +
 * conversations + messages). Una tanda de campaña de 250 destinatarios serían ~750
 * round-trips —medio minuto largo solo en DECIDIR el modo de envío, antes de mandar
 * nada— y la petición HTTP del panel se cae antes. Aquí son 3 consultas en total.
 *
 * Los teléfonos que no existan como contacto, o que no tengan ningún entrante, no
 * aparecen en el Map: el llamador los trata como `null` → fuera de ventana, el mismo
 * lado seguro que la función unitaria.
 */
async function getLastInboundAtBulk(orgId, telefonos = []) {
    const oid = resolveOrg(orgId);
    const phones = [...new Set((telefonos || []).map(sanitizePhone).filter(Boolean))];
    const resultado = new Map();
    if (!phones.length) return resultado;

    const { data: contactos, error: contactosErr } = await supabase
        .from('contacts')
        .select('id, wa_phone')
        .eq('organization_id', oid)
        .in('wa_phone', phones);
    assertRead(contactosErr, 'contacts');
    if (!contactos?.length) return resultado;

    const phonePorContacto = new Map(contactos.map(c => [c.id, c.wa_phone]));

    const { data: convs, error: convsErr } = await supabase
        .from('conversations')
        .select('id, contact_id')
        .eq('organization_id', oid)
        .in('contact_id', [...phonePorContacto.keys()]);
    assertRead(convsErr, 'conversations');
    if (!convs?.length) return resultado;

    const phonePorConversacion = new Map(
        convs.map(cv => [cv.id, phonePorContacto.get(cv.contact_id)]).filter(([, p]) => p)
    );
    if (!phonePorConversacion.size) return resultado;

    // Sin .limit(1) por conversación (Supabase no hace DISTINCT ON): traemos los entrantes
    // ordenados y nos quedamos con el primero de cada hilo, que es el más reciente.
    const { data: mensajes, error: mensajesErr } = await supabase
        .from('messages')
        .select('conversation_id, created_at')
        .eq('organization_id', oid)
        .eq('direction', 'inbound')
        .in('conversation_id', [...phonePorConversacion.keys()])
        .order('created_at', { ascending: false });
    assertRead(mensajesErr, 'messages');

    for (const m of mensajes || []) {
        const phone = phonePorConversacion.get(m.conversation_id);
        if (phone && !resultado.has(phone)) resultado.set(phone, m.created_at);
    }
    return resultado;
}

/**
 * ¿Sigue abierta la ventana de 24 h? Pura y con `now` inyectable para el test.
 * Sin entrante conocido → false: fuera de ventana, que es el lado seguro (una plantilla
 * se entrega igual dentro de la ventana; el texto libre fuera se pierde en silencio).
 */
function isWithin24hWindow(lastInboundAt, now = Date.now()) {
    if (!lastInboundAt) return false;
    const ts = lastInboundAt instanceof Date ? lastInboundAt.getTime() : Date.parse(lastInboundAt);
    if (!Number.isFinite(ts)) return false;
    const transcurrido = now - ts;
    if (transcurrido < 0) return true; // desfase de reloj: cuenta como dentro
    return transcurrido < VENTANA_24H_MS;
}

async function deleteConversationMessages(orgId, telefono) {
    const oid = resolveOrg(orgId);
    const phone = sanitizePhone(telefono);
    if (!phone) {
        console.log('[deleteConversationMessages] phone vacío, skip');
        return false;
    }

    const contact = await findByPhone(oid, phone);
    if (!contact) {
        console.log('[deleteConversationMessages] contacto no encontrado', { orgId: oid, phone });
        return false;
    }

    const { data: conv } = await supabase
        .from('conversations')
        .select('id')
        .eq('organization_id', oid)
        .eq('contact_id', contact.id)
        .maybeSingle();
    if (!conv) {
        console.log('[deleteConversationMessages] conversación no encontrada', { orgId: oid, contactId: contact.id });
        return false;
    }

    const { data, error, count } = await supabase
        .from('messages')
        .delete()
        .eq('conversation_id', conv.id)
        .eq('organization_id', oid)
        .select('id');

    if (error) {
        console.error('[deleteConversationMessages] error Supabase', { orgId: oid, convId: conv.id, error: error.message, code: error.code });
        return false;
    }

    const deleted = data ? data.length : 0;
    console.log('[deleteConversationMessages] mensajes borrados', { orgId: oid, convId: conv.id, contactId: contact.id, phone, deletedCount: deleted });
    return true;
}

async function setLeadBotMode(orgId, telefono, mode) {
    const oid = resolveOrg(orgId);
    const phone = sanitizePhone(telefono);
    const update = { bot_mode: mode, updated_at: now() };
    if (mode === 'auto') update.escalation_reason = null;
    const { error } = await supabase
        .from('contacts')
        .update(update)
        .eq('organization_id', oid)
        .eq('wa_phone', phone);
    assertWrite(error, 'contacts', 'update bot_mode');
    return true;
}

// ─── Retorno automático a 'auto' tras silencio (opción C) ────────────────────

/**
 * Contactos en `bot_mode = 'manual'` con el instante de su ÚLTIMA ACTIVIDAD, en cualquier
 * dirección: `conversations.last_message_at`, que saveMessage refresca con cada mensaje
 * entrante y con cada saliente.
 *
 * Ojo con no confundirlo con la ventana de 24 h de Cloud API, que se mide SOLO sobre
 * entrantes (getLastInboundAt) porque un saliente nuestro no reabre nada para Meta. Aquí la
 * pregunta es la contraria —"¿ha hablado alguien, quien sea?"— y para eso last_message_at
 * es exactamente el dato: si la dueña escribió ayer, la conversación no está en silencio
 * aunque la clienta lleve un mes callada.
 */
async function getContactosEnManual(orgId) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('contacts')
        .select('id, wa_phone, full_name, bot_mode, escalation_reason, is_blacklisted, updated_at, conversations(last_message_at)')
        .eq('organization_id', oid)
        .eq('bot_mode', 'manual');
    assertRead(error, 'contacts');
    return (data || []).map(row => {
        // Un contacto debería tener un solo hilo, pero si tuviera varios vale el más
        // reciente: basta con que UNO tenga actividad para que no haya silencio.
        const fechas = (row.conversations || [])
            .map(c => c && c.last_message_at)
            .filter(Boolean)
            .sort();
        return {
            id:                 row.id,
            telefono:           row.wa_phone,
            nombre:             row.full_name,
            bot_mode:           row.bot_mode || 'auto',
            escalation_reason:  row.escalation_reason || null,
            is_blacklisted:     !!row.is_blacklisted,
            updated_at:         row.updated_at,
            ultima_actividad_at: fechas.length ? fechas[fechas.length - 1] : null,
        };
    });
}

// ─── Lecturas del vigilante de esperas (services/espera-alert.js) ────────────
//
// Las dos preguntan lo mismo por dos puertas: ¿hay alguien esperando a que le conteste una
// persona? Van aquí y no se reutiliza `getPendingActions` a propósito: aquella se traga el
// `error` de Supabase (`const { data } = await …`), así que una lectura fallida se leería
// como "no hay ninguna escalada pendiente" y el vigilante daría el parte de todo en orden
// justo cuando no puede ver nada. Es la regla 4 aplicada al sitio donde más duele: un
// vigilante ciego es peor que no tener vigilante, porque además tranquiliza.

/**
 * Escaladas todavía sin resolver, con lo necesario para escribir el aviso sin abrir el panel:
 * quién es, qué pidió y desde cuándo.
 */
async function getEscaladasPendientes(orgId) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('pending_actions')
        .select('id, type, payload, created_at, contacts!contact_id(id, wa_phone, full_name, is_blacklisted)')
        .eq('organization_id', oid)
        .eq('type', 'escalation')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });
    assertRead(error, 'pending_actions');
    return (data || []).map(row => ({
        id:          row.id,
        creadaAt:    row.created_at,
        motivo:      row.payload?.motivo || null,
        ultimoTexto: row.payload?.mensaje || null,
        contactId:   row.contacts?.id || null,
        telefono:    row.contacts?.wa_phone || null,
        nombre:      row.contacts?.full_name || null,
        blacklisted: !!row.contacts?.is_blacklisted,
    }));
}

/**
 * Conversaciones cuyo ÚLTIMO mensaje es entrante — es decir, nadie ha contestado desde
 * entonces, ni el bot ni una persona.
 *
 * `desde` acota por los dos lados y los dos importan:
 *  - por abajo (horizonte), porque una conversación muerta hace semanas no es alguien
 *    esperando, es arqueología;
 *  - por arriba (`quietoAntesDe`), porque solo interesan las ya calladas. Filtrar por
 *    reloj es seguro aunque el umbral se mida en horario de apertura: los minutos de
 *    apertura nunca superan los de reloj, así que este prefiltro deja pasar un superconjunto
 *    y nunca esconde una espera que debería avisar.
 */
async function getConversacionesSinResponder(orgId, { desde, quietoAntesDe }) {
    const oid = resolveOrg(orgId);
    const desdeISO = new Date(desde).toISOString();

    const { data: convs, error: eConv } = await supabase
        .from('conversations')
        .select('id, last_message_at, contacts!contact_id(id, wa_phone, full_name, is_blacklisted, bot_mode)')
        .eq('organization_id', oid)
        .gte('last_message_at', desdeISO)
        .lte('last_message_at', new Date(quietoAntesDe).toISOString());
    assertRead(eConv, 'conversations');
    if (!convs?.length) return [];

    // El último mensaje de cada candidata cae por fuerza dentro del horizonte (su
    // last_message_at ya lo está), así que el mismo `desde` acota esta lectura.
    const { data: msgs, error: eMsg } = await supabase
        .from('messages')
        .select('conversation_id, direction, content, created_at')
        .eq('organization_id', oid)
        .in('conversation_id', convs.map(c => c.id))
        .gte('created_at', desdeISO)
        .order('created_at', { ascending: false });
    assertRead(eMsg, 'messages');

    const ultimo = new Map();
    for (const m of msgs || []) if (!ultimo.has(m.conversation_id)) ultimo.set(m.conversation_id, m);

    return convs.reduce((acc, c) => {
        const m = ultimo.get(c.id);
        if (!m || m.direction !== 'inbound') return acc;   // contestada: no hay nadie esperando
        acc.push({
            conversationId: c.id,
            esperandoDesde: m.created_at,
            ultimoTexto:    m.content || null,
            contactId:      c.contacts?.id || null,
            telefono:       c.contacts?.wa_phone || null,
            nombre:         c.contacts?.full_name || null,
            blacklisted:    !!c.contacts?.is_blacklisted,
            botMode:        c.contacts?.bot_mode || 'auto',
        });
        return acc;
    }, []);
}

/** Ids de contacto con alguna acción todavía sin resolver en la cola de Telegram. */
async function getContactIdsConAccionPendiente(orgId) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('pending_actions')
        .select('contact_id')
        .eq('organization_id', oid)
        .eq('status', 'pending')
        .not('contact_id', 'is', null);
    assertRead(error, 'pending_actions');
    return new Set((data || []).map(r => r.contact_id));
}

/**
 * Devuelve un contacto a `auto` dejando constancia de que lo hizo el sistema, no una
 * persona: `metadata.auto_return` es la traza que pinta el Monitor.
 *
 * La escritura es un compare-and-set: solo toca la fila si SIGUE en manual y SIGUE sin
 * escalada. Entre la lectura del barrido y este UPDATE pueden pasar minutos, y en ese hueco
 * cabe que alguien tome el control a mano o que el bot escale — devolver la conversación al
 * bot por encima de cualquiera de las dos cosas es justo lo que no puede pasar.
 *
 * Por eso 0 filas NO es un error: es la carrera perdida, y se comunica como tal
 * (devuelve false) en vez de reventar como haría assertRowsAffected.
 *
 * @returns {Promise<boolean>} true si la fila cambió de verdad.
 */
async function devolverContactoAAuto(orgId, contactId, traza) {
    const oid = resolveOrg(orgId);

    const { data: row, error: readErr } = await supabase
        .from('contacts')
        .select('metadata')
        .eq('organization_id', oid)
        .eq('id', contactId)
        .maybeSingle();
    assertRead(readErr, 'contacts');

    // metadata ya guarda wa_jid: se fusiona, nunca se sustituye.
    const metadata = (row?.metadata && typeof row.metadata === 'object') ? row.metadata : {};

    const { data, error } = await supabase
        .from('contacts')
        .update({
            bot_mode: 'auto',
            metadata: { ...metadata, auto_return: traza },
            updated_at: now(),
        })
        .eq('organization_id', oid)
        .eq('id', contactId)
        .eq('bot_mode', 'manual')
        .is('escalation_reason', null)
        .select('id');
    assertWrite(error, 'contacts', 'retorno automático a auto');
    return Array.isArray(data) ? data.length > 0 : !!data;
}

async function setEscalationReason(orgId, telefono, reason) {
    const oid = resolveOrg(orgId);
    const phone = sanitizePhone(telefono);
    const { error } = await supabase
        .from('contacts')
        .update({ escalation_reason: reason, updated_at: now() })
        .eq('organization_id', oid)
        .eq('wa_phone', phone);
    assertWrite(error, 'contacts', 'update escalation_reason');
}

// ─── Agent Config ─────────────────────────────────────────────────────────────

const _agentConfigCache = new Map();

async function getAgentConfig(orgId) {
    const oid = resolveOrg(orgId);
    const cached = _agentConfigCache.get(oid);
    if (cached && Date.now() - cached.ts < 60000) return cached.data;

    const { data, error } = await supabase
        .from('agent_configs')
        .select('*')
        .eq('organization_id', oid)
        .maybeSingle();

    // Un error de lectura NO se cachea. Antes se guardaba `null` con timestamp fresco, así
    // que un fallo transitorio dejaba a la org sin catálogo durante 60 s: todas las
    // clientas recibían "¿qué servicio quieres?" hicieran lo que hicieran, y sin ningún
    // log que explicara por qué. Se devuelve la última copia buena si la hay (aunque esté
    // caducada: mejor catálogo viejo que ninguno) y se reintenta en la llamada siguiente.
    // Esta función la comparten Sante y San Remo, por eso NO lanza: se conserva el
    // contrato de devolver config-o-null.
    if (error) {
        logger.error('agent_config_read_error', { orgId: oid, error: error.message, stale: !!cached });
        return cached?.data ?? null;
    }

    const result = data || null;
    _agentConfigCache.set(oid, { data: result, ts: Date.now() });
    return result;
}

async function updateAgentConfig(orgId, campos) {
    const oid = resolveOrg(orgId);
    const allowed = ['system_prompt', 'tone', 'business_info', 'services', 'business_hours', 'handoff_message'];
    const updates = { updated_at: now() };
    for (const k of allowed) {
        if (campos[k] !== undefined) updates[k] = campos[k];
    }
    await supabase
        .from('agent_configs')
        .upsert(
            { organization_id: oid, ...updates },
            { onConflict: 'organization_id' }
        );
    _agentConfigCache.delete(oid);
    return getAgentConfig(oid);
}

// ─── Appointments ─────────────────────────────────────────────────────────────

// Construye el Date de inicio a partir de fecha (YYYY-MM-DD) y hora. Devuelve null si el
// resultado no es válido. Normaliza horas sin zero-pad ("9:00" → "09:00"): sin esto,
// new Date('2026-07-01T9:00:00') daba Invalid Date y toISOString() lanzaba un error que
// rompía la creación de citas desde el panel (bug 8). Sin hora usa 20:00 (cena San Remo).
function buildStartsAt(fecha, hora, defaultTime = '20:00') {
    if (!fecha) return null;
    let h = hora;
    if (h !== undefined && h !== null && String(h).trim() !== '') {
        const m = String(h).trim().replace(/\s*h$/i, '').trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
        if (hh > 23 || mm > 59) return null;
        h = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    } else {
        h = defaultTime;
    }
    const d = new Date(`${fecha}T${h}:00`);
    return isNaN(d.getTime()) ? null : d;
}

async function saveAppointment(orgId, contactId, { servicio, fecha, hora, duracionMin, estado = 'confirmed', notas, personas, ocasion, bizumStatus = 'not_required', bizumAmount, stylistId, source = 'bot', noFacturable = false } = {}) {
    const oid = resolveOrg(orgId);
    if (!contactId) {
        console.error('[saveAppointment] contactId nulo — reserva no guardada');
        return null;
    }
    if (!fecha) {
        console.error('[saveAppointment] fecha nula — reserva no guardada', { contactId });
        return null;
    }

    const contact = await findById(oid, contactId);
    if (!contact) {
        console.error('[saveAppointment] contacto no encontrado', { contactId });
        return null;
    }

    const startsAt = buildStartsAt(fecha, hora);
    if (!startsAt) {
        console.error('[saveAppointment] fecha/hora inválida — reserva no guardada', { contactId, fecha, hora });
        return null;
    }
    const durMin = Number(duracionMin);
    if (!Number.isFinite(durMin) || durMin <= 0) {
        logger.error('cita_sin_duracion', { orgId: oid, op: 'saveAppointment', contactId, servicio: servicio || null, duracionMin: duracionMin ?? null });
        console.error('[saveAppointment] duración ausente o inválida — reserva no guardada', { contactId, duracionMin });
        return null;
    }
    const endsAt = new Date(startsAt.getTime() + durMin * 60 * 1000);

    // Idempotencia: nunca crear DOS veces la misma cita. Si ya existe una cita activa
    // (no cancelada) para este contacto a la MISMA hora de inicio, devolvemos la existente
    // en vez de insertar un duplicado. Backstop a nivel de datos contra cualquier reintento,
    // race o red de seguridad que intente reservar el mismo hueco más de una vez.
    {
        const { data: existing, error: errExisting } = await supabase
            .from('appointments')
            .select('*')
            .eq('organization_id', oid)
            .eq('contact_id', contactId)
            .eq('starts_at', startsAt.toISOString())
            .neq('status', 'cancelled')
            .maybeSingle();
        // Si esta lectura falla en silencio damos por buena una agenda vacía y creamos el
        // duplicado que la guarda existe justamente para evitar. Mejor lanzar y reintentar.
        assertRead(errExisting, 'appointments');
        if (existing) {
            console.warn('[saveAppointment] cita duplicada evitada (ya existe activa)', { contactId, startsAt: startsAt.toISOString() });
            return existing;
        }
    }

    const { data, error } = await supabase
        .from('appointments')
        .insert({
            organization_id: oid,
            contact_id:      contactId,
            service:         servicio || 'Reserva',
            starts_at:       startsAt.toISOString(),
            ends_at:         endsAt.toISOString(),
            status:          estado,
            full_name:       contact.nombre || '',
            phone:           contact.telefono || '',
            notes:           notas || null,
            party_size:      personas ?? contact.personas ?? null,
            occasion:        ocasion || contact.ocasion || null,
            bizum_status:    bizumStatus,
            bizum_amount:    bizumAmount ?? null,
            stylist_id:      stylistId || null,
            source:          source || 'bot',
            no_facturable:   !!noFacturable,
        })
        .select()
        .single();

    // La ÚNICA creación de citas del sistema. Hasta la auditoría del 31/07/2026 hacía
    // `console.error` + `return null`, así que un fallo de Supabase (RLS, FK, timeout) era
    // indistinguible de "hueco inválido" para el llamante: `bookAppointment` los colapsaba
    // todos en `{success:false}` y el bot mandaba "no he podido fijar ese hueco" sin que
    // nadie supiera que la BD estaba caída. Ahora lanza, como el resto de escrituras.
    assertWrite(error, 'appointments', 'insert_cita');
    // error=null y data=null no debería ocurrir con .select().single(), pero si ocurre NO
    // es un éxito: devolver null aquí haría que el llamante lo trate como slot inválido.
    if (!data) {
        logger.error('db_write_sin_efecto', { tabla: 'appointments', op: 'insert_cita' });
        throw new Error('Escritura (insert_cita) en appointments no devolvió fila: nada guardado');
    }
    return data;
}

// Campos cuyo cambio le importa a alguien que audita una cita. Se dejan fuera a propósito
// los interruptores de los workers (recordatorio_enviado, resena_enviada): son ruido
// mecánico y taparían el último cambio de verdad, que es lo único que guarda `last_change`.
const CAMPOS_AUDITADOS = ['starts_at', 'ends_at', 'service', 'status', 'stylist_id', 'notes'];

/**
 * El "de → a" del cambio que se está a punto de escribir, o null si no cambia nada de lo
 * que se audita. Hace UNA lectura extra, y solo cuando toca: editar una cita es una acción
 * manual y rara, no un camino caliente.
 *
 * Si la lectura falla se devuelve null en vez de propagar: perder la traza es malo, pero
 * impedir que se guarde el cambio de hora de una clienta por no poder auditarlo es peor.
 */
async function buildLastChange(oid, appointmentId, updates, actor) {
    const campos = CAMPOS_AUDITADOS.filter(c => updates[c] !== undefined);
    if (!campos.length) return undefined;

    let previo = null;
    try {
        const { data, error } = await supabase
            .from('appointments')
            .select(campos.join(', '))
            .eq('organization_id', oid)
            .eq('id', appointmentId)
            .maybeSingle();
        if (error) throw error;
        previo = data;
    } catch (e) {
        logger.warn('auditoria_cita_sin_estado_previo', { appointmentId, error: e.message });
        return undefined;
    }
    if (!previo) return undefined;

    const de = {};
    const a = {};
    for (const campo of campos) {
        // Comparación laxa a propósito: null y undefined son "no había nada", y un id que
        // llega como string no es un cambio respecto al mismo id guardado.
        if (String(previo[campo] ?? '') === String(updates[campo] ?? '')) continue;
        de[campo] = previo[campo] ?? null;
        a[campo] = updates[campo] ?? null;
    }
    if (!Object.keys(a).length) return undefined;

    return { at: now(), by: actor, de, a };
}

async function updateAppointment(orgId, appointmentId, campos) {
    const oid = resolveOrg(orgId);
    const updates = {};
    if (campos.servicio    !== undefined) updates.service      = campos.servicio;
    if (campos.estado      !== undefined) updates.status       = campos.estado;
    if (campos.estado === 'no_show')     updates.no_show      = true;
    if (campos.notas       !== undefined) updates.notes        = campos.notas;
    if (campos.personas    !== undefined) updates.party_size   = campos.personas;
    if (campos.ocasion     !== undefined) updates.occasion     = campos.ocasion;
    if (campos.bizumStatus !== undefined) updates.bizum_status = campos.bizumStatus;
    if (campos.bizumAmount !== undefined) updates.bizum_amount = campos.bizumAmount;
    if (campos.noShow      !== undefined) updates.no_show      = campos.noShow;
    if (campos.stylistId   !== undefined) updates.stylist_id   = campos.stylistId;
    // Marcar/desmarcar una cita como no cobrable. Es la única forma de decir "esto no se
    // cobra": no se puede deducir de ninguna otra señal (ver migración 037).
    if (campos.noFacturable !== undefined) updates.no_facturable = !!campos.noFacturable;
    if (campos.resenaEnviada !== undefined) updates.resena_enviada = campos.resenaEnviada;
    if (campos.recordatorioEnviado !== undefined) updates.recordatorio_enviado = campos.recordatorioEnviado;
    if (campos.endsAt !== undefined) updates.ends_at = campos.endsAt;
    if (campos.fecha !== undefined && campos.hora !== undefined) {
        const startsAt = buildStartsAt(campos.fecha, campos.hora);
        if (!startsAt) {
            console.error('[updateAppointment] fecha/hora inválida — no se actualiza el horario', { appointmentId, fecha: campos.fecha, hora: campos.hora });
            return null;
        }
        // Mover una cita sin decir cuánto dura NO puede resolverse con un número por
        // defecto: aquí el 120 no creaba una cita nueva mal medida, REDIMENSIONABA una
        // existente. Un PUT con {fecha, hora} y sin duracionMin convertía las 5 h de un
        // alisado en 2 h y publicaba las otras 3 como libres. Quien mueve la cita sabe
        // cuánto dura (el panel la manda siempre); si no lo sabe, esto falla y se ve.
        const durMin = Number(campos.duracionMin);
        if (!Number.isFinite(durMin) || durMin <= 0) {
            logger.error('cita_sin_duracion', { orgId: oid, op: 'updateAppointment', appointmentId, duracionMin: campos.duracionMin ?? null });
            console.error('[updateAppointment] duración ausente o inválida — no se actualiza el horario', { appointmentId, duracionMin: campos.duracionMin });
            return null;
        }
        updates.starts_at = startsAt.toISOString();
        updates.ends_at   = new Date(startsAt.getTime() + durMin * 60 * 1000).toISOString();
    }
    if (!Object.keys(updates).length) return null;

    // Auditoría mínima (migración 033). `updated_at` lo pone el trigger; aquí van las dos
    // cosas que la base de datos no puede saber sola: QUIÉN escribe y QUÉ cambió.
    //
    // El actor NO se adivina. Sin `campos.actor` la columna queda a null —"no consta"— en
    // vez de atribuirle la escritura al bot por defecto, que es justo la clase de dato que
    // luego se lee como si fuera verdad.
    if (campos.actor !== undefined) updates.updated_by = campos.actor || null;
    const cambio = await buildLastChange(oid, appointmentId, updates, campos.actor || null);
    if (cambio) updates.last_change = cambio;

    const { data, error } = await supabase
        .from('appointments')
        .update(updates)
        .eq('id', appointmentId)
        .eq('organization_id', oid)
        .select()
        .single();
    // El `code` se propaga: PGRST116 (`.single()` sin filas) significa "esa cita no existe",
    // mientras que cualquier otro código es un fallo de escritura con la cita aún viva. Quien
    // reagenda necesita distinguirlos: crear una cita nueva es correcto en el primer caso y
    // duplica la reserva en el segundo.
    if (error) {
        const err = new Error(error.message);
        err.code = error.code;
        throw err;
    }
    return data || null;
}

// Devuelve { ok, deleted, error }. `deleted` es el nº de filas borradas (0 = no existía).
// Antes devolvía solo un booleano `!error`, que era `true` incluso cuando no se borraba
// nada (id inexistente) y ocultaba el error real de Supabase (p.ej. id malformado),
// dejando al panel sin saber por qué "fallaba" el borrado.
async function deleteAppointment(orgId, appointmentId) {
    const oid = resolveOrg(orgId);
    if (!appointmentId) return { ok: false, deleted: 0, error: 'appointmentId requerido' };
    const { data, error } = await supabase
        .from('appointments')
        .delete()
        .eq('id', appointmentId)
        .eq('organization_id', oid)
        .select('id');
    if (error) {
        console.error('[deleteAppointment] error Supabase', { appointmentId, error: error.message });
        return { ok: false, deleted: 0, error: error.message };
    }
    return { ok: true, deleted: (data || []).length };
}

async function getAppointmentsByDateRange(orgId, desde, hasta) {
    const oid = resolveOrg(orgId);
    const desdeTs = new Date(`${desde}T00:00:00`).toISOString();
    const hastaTs = new Date(`${hasta}T23:59:59`).toISOString();
    const { data, error } = await supabase
        .from('appointments')
        .select('*, contacts!contact_id(id, full_name, wa_phone, origen, bot_mode, is_vip, is_blacklisted), stylists!stylist_id(id, name)')
        .eq('organization_id', oid)
        .gte('starts_at', desdeTs)
        .lte('starts_at', hastaTs)
        // Lista BLANCA, no negra. Antes era `neq('cancelled')`, que deja pasar todo lo que no
        // se haya pensado: hoy `no_show` (sí está en el CHECK de la columna, comprobado en la
        // BD) y `pending` (el flujo Bizum de San Remo). Un estado nuevo entraría solo.
        .in('status', ['confirmed', 'completed'])
        // El no-show tiene DOS formas de expresarse —el estado y el booleano— y updateAppointment
        // escribe las dos (db.js: `estado === 'no_show'` pone también `no_show = true`). Mirar
        // solo una dejaba a una clienta que no vino en «pendientes de cobrar» PARA SIEMPRE:
        // nadie pagó, así que nadie la va a quitar de ahí.
        // `not(is true)` y no `eq(false)`: una fila con no_show NULL es "no consta que faltara",
        // y con eq(false) desaparecería de la caja sin que nadie entienda por qué.
        .not('no_show', 'is', true)
        // Marcada a mano como no cobrable (migración 037): un bloqueo, una cortesía, un hueco
        // reservado. Es lo único que distingue "esto no se cobra" de "esto está por cobrar",
        // porque no se puede deducir de ninguna otra señal.
        .eq('no_facturable', false)
        .order('starts_at', { ascending: true });

    // Es la agenda que pinta el panel (`GET /api/citas`): un fallo de lectura NO puede salir
    // como «no hay citas». Un día lleno y un día vacío se verían igual, y es la pantalla desde
    // la que se decide si cabe alguien más. Su gemela `getCitasDelDiaParaCaja` ya lo hacía
    // —mismos tres filtros, misma pregunta en otra pantalla— y esta se quedó atrás.
    assertRead(error, 'appointments');

    return (data || []).map(row => {
        const startsAt = new Date(row.starts_at);
        return {
            id:             row.contacts?.id,
            appointment_id: row.id,
            nombre:         row.contacts?.full_name,
            telefono:       row.contacts?.wa_phone,
            personas:       row.party_size,
            ocasion:        row.occasion,
            origen:         row.contacts?.origen,
            bot_mode:       row.contacts?.bot_mode,
            is_vip:         !!row.contacts?.is_vip,
            is_blacklisted: !!row.contacts?.is_blacklisted,
            fecha_cita:     startsAt.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }),
            hora_cita:      startsAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }),
            estado_cita:    row.status,
            notas:          row.notes,
            bizum_status:   row.bizum_status,
            bizum_amount:   row.bizum_amount,
            no_show:        !!row.no_show,
            stylist_id:     row.stylist_id,
            stylist_name:   row.stylists?.name || null,
            service:        row.service,
            starts_at:      row.starts_at,
            ends_at:        row.ends_at,
            // Solo LECTURA para la ficha de la cita: el importe se ve, no se edita ahí. Se
            // corrige desde Facturación (PATCH /api/citas/:id/precio) — tocar dinero en el
            // mismo formulario que edita el `service` es justo la confusión que causó el
            // desfase del snapshot.
            precio_facturado:     row.precio_facturado,
            precio_manual:        row.precio_manual,
            precio_manual_motivo: row.precio_manual_motivo,
        };
    });
}

// Citas COMPLETED de un rango de fechas, con estilista y cliente, para el informe de
// facturación por estilista. No devuelve precio (appointments no lo guarda): el importe
// se recalcula en helpers a partir de `service` contra el catálogo.
// stylistId opcional: UUID → solo esa estilista; NO_STYLIST_KEY → solo citas sin estilista
// asignada; null/undefined → todas. El importe NO cambia por filtrar: solo entran menos
// citas al mismo cálculo.
async function getCompletedAppointmentsForBilling(orgId, desde, hasta, stylistId = null) {
    const oid = resolveOrg(orgId);
    const desdeTs = new Date(`${desde}T00:00:00`).toISOString();
    const hastaTs = new Date(`${hasta}T23:59:59`).toISOString();
    let query = supabase
        .from('appointments')
        .select('id, service, stylist_id, starts_at, precio_facturado, iva_rate, facturado_at, stylist_name_facturado, servicio_facturado, precio_manual, precio_manual_motivo, precio_manual_at, contacts!contact_id(full_name), stylists!stylist_id(id, name)')
        .eq('organization_id', oid)
        .eq('status', 'completed')
        .gte('starts_at', desdeTs)
        .lte('starts_at', hastaTs);

    if (stylistId === NO_STYLIST_KEY) query = query.is('stylist_id', null);
    else if (stylistId) query = query.eq('stylist_id', stylistId);

    // Es dinero: si la consulta falla NO devolvemos [] (se leería como "0 € facturados").
    // Propagamos el error y el panel muestra el fallo.
    const { data, error } = await query.order('starts_at', { ascending: true });
    if (error) throw new Error(error.message);

    return (data || []).map(row => ({
        appointment_id: row.id,
        service:        row.service,
        stylist_id:     row.stylist_id,
        // El nombre congelado manda sobre el del JOIN: renombrar a una estilista no debe
        // reescribir su histórico de facturación.
        stylist_name:   row.stylist_name_facturado || row.stylists?.name || null,
        starts_at:      row.starts_at,
        cliente:        row.contacts?.full_name || null,
        precio_facturado: row.precio_facturado,
        iva_rate:         row.iva_rate,
        facturado_at:     row.facturado_at,
        // El `service` de cuando se congeló el importe: si hoy difiere, el operador editó la
        // cita después de facturarla y el congelado ya no describe lo que se hizo.
        servicio_facturado:   row.servicio_facturado,
        precio_manual:        row.precio_manual,
        precio_manual_motivo: row.precio_manual_motivo,
        precio_manual_at:     row.precio_manual_at,
    }));
}

// Congela el importe de las citas indicadas. Se llama en la ÚNICA transición que importa: el
// paso a 'completed'. A partir de ahí el informe lee este valor y deja de recalcular, así que
// subir un precio en el catálogo —o que alguien edite el `service` de una cita pasada— ya no
// reescribe la facturación de un periodo cerrado.
// No pisa un snapshot existente (facturado_at != null): completar dos veces no revaloriza.
// Si el servicio no es calculable (nombre ambiguo, sin precio, sin match) NO se inventa nada:
// precio_facturado se queda a null y el informe la sigue contando como "sin poder calcular".
//
// DEVUELVE {intentadas, selladas, fallidas}, no un número suelto. Devolvía `n` y los dos
// llamadores lo tiraban, así que "sellé 10 de 10" y "sellé 1 de 10" eran indistinguibles: la
// diferencia solo existía en un logger.error por fila que nadie lee. Ahora la propia función
// avisa a una persona cuando alguna fila se queda sin sellar (ver avisarSnapshotIncompleto).
async function stampBillingSnapshot(orgId, appointmentIds, { ivaRate = 0.21 } = {}) {
    const nada = { intentadas: 0, selladas: 0, fallidas: 0 };
    const ids = (appointmentIds || []).filter(Boolean);
    if (!ids.length) return nada;
    const oid = resolveOrg(orgId);

    const { data: citas, error } = await supabase
        .from('appointments')
        .select('id, service, facturado_at, stylists!stylist_id(name)')
        .eq('organization_id', oid)
        .in('id', ids)
        .is('facturado_at', null);
    assertRead(error, 'appointments');
    if (!citas?.length) return nada;

    const cfg = await getAgentConfig(oid);
    const catalogo = cfg?.services || [];
    const sellado = now();
    let n = 0;
    let fallidas = 0;
    let ultimoError = null;

    for (const cita of citas) {
        const { totalConIva, segments } = computeServiceBilling(cita.service, catalogo);
        const calculable = segments.length > 0 && segments.every(s => s.status === 'ok');
        const { error: errUpd } = await supabase
            .from('appointments')
            .update({
                precio_facturado: calculable ? Math.round(totalConIva * 100) / 100 : null,
                iva_rate: ivaRate,
                facturado_at: sellado,
                stylist_name_facturado: cita.stylists?.name || null,
                // El servicio que se está valorando AHORA. Si alguien lo edita después, el
                // informe lo compara con el actual y avisa en vez de seguir dando por bueno
                // un importe que ya no describe lo que se hizo (migración 031).
                servicio_facturado: cita.service,
            })
            .eq('id', cita.id)
            .eq('organization_id', oid);
        if (errUpd) {
            // No se propaga: el snapshot es un extra sobre una cita que YA está completada.
            // Sin él el informe recalcula como siempre, así que perderlo no rompe nada HOY —
            // pero es exactamente el escenario contra el que existe el snapshot, así que se
            // cuenta y se cuenta hacia arriba.
            logger.error('db_write_error', { tabla: 'appointments', op: 'stampBillingSnapshot', error: errUpd.message, code: errUpd.code });
            fallidas++;
            ultimoError = errUpd.message;
            continue;
        }
        n++;
    }

    if (fallidas) {
        logger.error('snapshot_facturacion_incompleto', {
            orgId: oid, intentadas: citas.length, selladas: n, fallidas, error: ultimoError,
        });
        await avisarSnapshotIncompleto(oid, { intentadas: citas.length, selladas: n, error: ultimoError });
    }
    return { intentadas: citas.length, selladas: n, fallidas };
}

// El único aviso al admin que sale de la capa de datos, y sale porque el fallo que describe
// es invisible por cualquier otro camino: la cita queda `completed`, el panel enseña un 200,
// el informe recalcula desde el catálogo y todo parece normal. Si alguien sube un precio
// antes de que nadie mire, ese periodo cerrado se factura al precio nuevo y no queda ni
// rastro de que el importe bueno se perdió.
//
// El require es PEREZOSO a propósito: admin-alerts arrastra telegram.js, que requiere este
// mismo módulo. Cargarlo arriba cerraría el ciclo y telegram.js se quedaría con las funciones
// de db a medio definir. Dentro de la rama de fallo el ciclo ya está resuelto.
async function avisarSnapshotIncompleto(orgId, { intentadas, selladas, error }) {
    try {
        const { alertOnce } = require('./admin-alerts');
        const dia = new Date().toISOString().slice(0, 10);
        const mensaje =
            '⚠️ <b>Importes sin congelar</b>\n\n'
            + `Al cerrar unas citas no he podido guardar su importe (${selladas} de ${intentadas}).\n\n`
            + 'Las citas están bien y el informe de facturación sigue saliendo, pero calculado '
            + 'con los precios de HOY: si alguien cambia una tarifa, ese periodo cambiará con ella.\n\n'
            + (error ? `Detalle técnico: ${error}` : '');
        // Throttle por DÍA y org: esto no es urgente por cita, es "el sellado está fallando".
        await alertOnce(orgId, `snapshot_facturacion|${dia}`, mensaje);
    } catch (e) {
        // Avisar de un problema no puede crear uno nuevo en el camino de escritura.
        logger.error('snapshot_aviso_error', { orgId, error: e.message });
    }
}

// Fija (o limpia) el importe de una cita A MANO. Junto con stampBillingSnapshot son los
// ÚNICOS dos sitios que escriben columnas de facturación: uno es la máquina, este es la
// persona. updateAppointment no las toca, y por eso resellar nunca puede pisar una decisión
// humana ni al revés.
//
// precio null → limpia las cuatro columnas y la cita vuelve sola al importe congelado o al
// recálculo (el snapshot nunca se tocó, así que no hay nada que reconstruir).
// precio 0 → importe VÁLIDO (cortesía). Por eso el guard es `precio == null` y no `!precio`.
//
// userId sale del token ya verificado (req.authUserId), NUNCA del body: es dinero y la
// atribución tiene que ser del que de verdad ha entrado, no del que dice ser.
// Devuelve la fila actualizada, o null si no existe en esa org (el panel responde 404).
async function setManualPrice(orgId, appointmentId, { precio, motivo = null, userId = null } = {}) {
    if (!appointmentId) return null;
    const oid = resolveOrg(orgId);
    const limpiar = precio == null;
    const updates = limpiar
        ? { precio_manual: null, precio_manual_motivo: null, precio_manual_at: null, precio_manual_por: null }
        : {
            precio_manual: Math.round(Number(precio) * 100) / 100,
            precio_manual_motivo: motivo || null,
            precio_manual_at: now(),
            precio_manual_por: userId || null,
        };

    const { data, error } = await supabase
        .from('appointments')
        .update(updates)
        .eq('id', appointmentId)
        .eq('organization_id', oid)
        .select();
    // Es dinero: un fallo de escritura NO puede devolver null y leerse como "esa cita no
    // existe" — el panel diría 404 y nadie sabría que la corrección no llegó a guardarse.
    assertWrite(error, 'appointments', 'setManualPrice');
    if (!data?.length) return null;
    return data[0];
}

// ─── Caja: registro de cobros (migración 035) ───────────────────────────────
//
// Un cobro se escribe UNA vez y se congela (trigger cobros_congelar_importes). Corregirlo es
// escribir otro con `corrige_a`, nunca un UPDATE. Lo único que un UPDATE puede tocar es la
// anulación sin sustituto y la nota.

const COBRO_COLUMNS = 'id, organization_id, appointment_id, contact_id, cobrado_por, cobrado_por_nombre, '
    + 'fecha_caja, cobrado_at, metodo, importe_total, importe_efectivo, iva_rate, concepto, '
    + 'importe_referencia, motivo_diferencia, nota, estado, corrige_a, motivo_correccion, '
    + 'anulado_at, anulado_por, registrado_por, created_at, atribucion';

// El día de caja de HOY, en Europe/Madrid. Es la única forma de calcularlo en el código.
//
// `new Date().toISOString().slice(0,10)` da el día UTC, y la sesión de esta base corre en UTC:
// entre las 00:00 y las 02:00 de Madrid ese atajo devuelve el día ANTERIOR. Un cobro de las
// 00:30 mal fechado descuadra DOS cierres a la vez —le sobra a uno y le falta al otro— y es
// justo la hora de cerrar la caja.
function diaDeCajaHoy() { return toLocalDateStr(new Date()); }

// Registra un cobro. `fechaCaja` explícita solo para el caso deliberado de imputar un cobro de
// madrugada a la jornada anterior; si no viene, la decide diaDeCajaHoy().
//
// `cobradoPorNombre` se congela igual que `stylist_name_facturado` (migración 021): renombrar a
// una estilista no puede reescribir cierres de hace tres meses.
async function createCobro(orgId, {
    appointmentId = null, cobradoPor = null, fechaCaja = null,
    // De quién es la venta cuando NO hay cita (migración 038). Con cita se queda a null: la
    // clienta sale de la cita, y quien decide la precedencia es `resolveClienteDelCobro`, no
    // esta función. Guardar las dos sería tener dos respuestas a la misma pregunta.
    contactId = null,
    metodo, importeTotal, importeEfectivo = null,
    concepto = null, importeReferencia = null, motivoDiferencia = null, nota = null,
    corrigeA = null, motivoCorreccion = null, userId = null,
    // 'declarada' por defecto, y esa dirección es deliberada: un camino que se olvide de
    // declararla cae en la afirmación MÁS HUMILDE. Al revés, un olvido convertiría en "consta"
    // algo que nadie confirmó.
    atribucion = 'declarada',
} = {}) {
    const oid = resolveOrg(orgId);
    const { normalizeCobroImportes } = require('./helpers');
    const importes = normalizeCobroImportes({ metodo, importeTotal, importeEfectivo });

    // El nombre se resuelve AQUÍ y se guarda, no se deja para el JOIN del informe.
    let cobradoPorNombre = null;
    if (cobradoPor) {
        const { data: est, error: errEst } = await supabase
            .from('stylists').select('name').eq('id', cobradoPor).eq('organization_id', oid).maybeSingle();
        assertRead(errEst, 'stylists');
        if (!est) throw new Error('La estilista indicada no existe en esta organización');
        cobradoPorNombre = est.name || null;
    }

    // La clienta se comprueba contra la ORG, igual que la estilista de arriba. La FK sola no
    // basta: garantiza que el contacto existe, no que sea de este salón, así que un contactId
    // de otra organización entraría sin protestar y ataría dinero de aquí a una ficha de allí.
    const contactoDeLaVenta = (!appointmentId && contactId) ? contactId : null;
    if (contactoDeLaVenta) {
        const { data: cli, error: errCli } = await supabase
            .from('contacts').select('id').eq('id', contactoDeLaVenta).eq('organization_id', oid).maybeSingle();
        assertRead(errCli, 'contacts');
        if (!cli) throw new Error('La clienta indicada no existe en esta organización');
    }

    const { data, error } = await supabase
        .from('cobros')
        .insert({
            organization_id: oid,
            appointment_id: appointmentId || null,
            // Solo si NO hay cita (`contactoDeLaVenta` ya aplica esa regla y es lo que se ha
            // validado contra la org). Con cita, la clienta ya está en la cita y duplicarla
            // aquí abriría la puerta a que las dos dijeran cosas distintas.
            contact_id: contactoDeLaVenta,
            cobrado_por: cobradoPor || null,
            cobrado_por_nombre: cobradoPorNombre,
            fecha_caja: fechaCaja || diaDeCajaHoy(),
            metodo,
            importe_total: importes.importe_total,
            importe_efectivo: importes.importe_efectivo,
            concepto: concepto || null,
            importe_referencia: importeReferencia,
            motivo_diferencia: motivoDiferencia || null,
            nota: nota || null,
            corrige_a: corrigeA || null,
            motivo_correccion: motivoCorreccion || null,
            registrado_por: userId || null,
            atribucion: atribucion === 'confirmada' ? 'confirmada' : 'declarada',
        })
        .select(COBRO_COLUMNS);
    // Es dinero: un INSERT fallido no puede devolver null y leerse como "ya está".
    assertRowsAffected(error, data, 'cobros', 'createCobro');
    return data[0];
}

// Los cobros que CUENTAN. Sale de la VISTA `cobros_vigentes`, nunca de la tabla: el invariante
// "vigente y sin sucesor" está definido una sola vez, en la 035. Si esto leyera `cobros` y
// filtrara a mano, habría dos definiciones de qué cuenta y una acabaría sumando mal.
async function getCobrosVigentes(orgId, { desde = null, hasta = null, stylistId = null, appointmentId = null } = {}) {
    const oid = resolveOrg(orgId);
    let query = supabase.from('cobros_vigentes').select(COBRO_COLUMNS).eq('organization_id', oid);
    if (desde) query = query.gte('fecha_caja', desde);
    if (hasta) query = query.lte('fecha_caja', hasta);
    if (stylistId === NO_STYLIST_KEY) query = query.is('cobrado_por', null);
    else if (stylistId) query = query.eq('cobrado_por', stylistId);
    if (appointmentId) query = query.eq('appointment_id', appointmentId);

    const { data, error } = await query.order('cobrado_at', { ascending: true });
    // Es dinero: si la consulta falla NO devolvemos [] (se leería como "0 € en caja").
    assertRead(error, 'cobros_vigentes');
    return data || [];
}

// El HISTÓRICO, incluido lo anulado y lo rectificado. Lee la tabla a propósito: es justo lo
// que la vista esconde. No se usa para sumar caja, solo para auditar.
async function getCobrosHistorial(orgId, { desde = null, hasta = null, appointmentId = null } = {}) {
    const oid = resolveOrg(orgId);
    let query = supabase.from('cobros').select(COBRO_COLUMNS).eq('organization_id', oid);
    if (desde) query = query.gte('fecha_caja', desde);
    if (hasta) query = query.lte('fecha_caja', hasta);
    if (appointmentId) query = query.eq('appointment_id', appointmentId);
    const { data, error } = await query.order('cobrado_at', { ascending: true });
    assertRead(error, 'cobros');
    return data || [];
}

async function getCobroById(orgId, cobroId) {
    if (!cobroId) return null;
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('cobros').select(COBRO_COLUMNS).eq('id', cobroId).eq('organization_id', oid).maybeSingle();
    assertRead(error, 'cobros');
    return data || null;
}

// Rectifica un cobro: UNA sola escritura, el sucesor es la anulación del anterior.
//
// Los campos que no se pasan se HEREDAN del original, y eso importa sobre todo para
// `fecha_caja`: corregir hoy un cobro de ayer pertenece a la caja de AYER. Si se recalculara a
// hoy, la corrección movería dinero de un día cerrado a otro — descuadrando los dos, que es
// exactamente lo que este registro existe para evitar.
async function rectifyCobro(orgId, cobroId, cambios = {}) {
    const oid = resolveOrg(orgId);
    const original = await getCobroById(oid, cobroId);
    if (!original) return null;
    if (!cambios.motivoCorreccion) throw new Error('Una rectificación tiene que decir por qué');
    if (original.estado === 'anulado') {
        throw new Error('Ese cobro está anulado: no se rectifica, se registra uno nuevo');
    }

    const tomar = (nuevo, viejo) => (nuevo === undefined ? viejo : nuevo);
    return createCobro(oid, {
        appointmentId:  tomar(cambios.appointmentId,  original.appointment_id),
        // De quién era la venta se HEREDA, como el concepto: rectificar un importe mal tecleado
        // no cambia a quién se le vendió. Si de verdad era otra clienta, eso no es una
        // rectificación —se anula y se registra de nuevo—, que es la misma regla que ya impone
        // el trigger al prohibir reasignar contact_id sobre una fila viva.
        contactId:      tomar(cambios.contactId,      original.contact_id),
        cobradoPor:     tomar(cambios.cobradoPor,     original.cobrado_por),
        fechaCaja:      tomar(cambios.fechaCaja,      original.fecha_caja),
        metodo:         tomar(cambios.metodo,         original.metodo),
        importeTotal:   tomar(cambios.importeTotal,   Number(original.importe_total)),
        importeEfectivo: tomar(cambios.importeEfectivo, Number(original.importe_efectivo)),
        concepto:       tomar(cambios.concepto,       original.concepto),
        // La referencia es la de la cita, no la del cobro viejo: se hereda igual.
        importeReferencia: tomar(cambios.importeReferencia, original.importe_referencia),
        motivoDiferencia:  tomar(cambios.motivoDiferencia,  original.motivo_diferencia),
        nota:           tomar(cambios.nota, null),
        corrigeA:       original.id,
        motivoCorreccion: cambios.motivoCorreccion,
        userId:         cambios.userId || null,
        // La atribución NO se hereda: es una afirmación nueva sobre quién dice qué, y la hace
        // quien rectifica. Heredarla arrastraría el "confirmada" del original a una corrección
        // tecleada por otra persona sin meter ningún PIN.
        atribucion:     cambios.atribucion === 'confirmada' ? 'confirmada' : 'declarada',
    });
}

// Anula SIN sustituto ("esto no se llegó a cobrar", "lo registré por error"). Es el único
// UPDATE que la tabla permite, y por eso no toca ninguna columna de importe.
async function anularCobro(orgId, cobroId, { motivo = null, userId = null } = {}) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('cobros')
        .update({ estado: 'anulado', anulado_at: now(), anulado_por: userId || null, nota: motivo || null })
        .eq('id', cobroId)
        .eq('organization_id', oid)
        .eq('estado', 'vigente')   // anular dos veces no reescribe la fecha de la primera
        .select(COBRO_COLUMNS);
    assertWrite(error, 'cobros', 'anularCobro');
    return data?.[0] || null;
}

// Citas de UN día para la pantalla de caja: lo que puede cobrarse hoy.
//
// Devuelve las columnas de facturación en crudo porque quien llama resuelve el importe de
// referencia con `resolveImporteReferencia` — la MISMA precedencia que pinta Facturación. El
// panel no valora servicios: si lo hiciera, habría dos opiniones sobre lo que vale una cita.
//
// Incluye las ya completadas y las aún confirmadas: al cobrar, la clienta acaba de levantarse
// del sillón y el barrido de auto-completar puede no haber pasado todavía. Excluye las
// canceladas, que no se cobran.
//
// Los tres filtros de abajo son LOS MISMOS que los de `getAppointmentsByDateRange`, y por las
// mismas razones. Estuvieron solo allí desde el 07/08/2026 hasta que se vio el efecto: allí
// alimentan la lista de Reservas, y aquí es donde de verdad importaban. Mientras faltaron, un
// no-show y una cita marcada «no se cobra» seguían en «pendientes de cobrar» — la casilla del
// panel promete justo lo contrario ("No saldrá en Caja como pendiente de cobrar") y no lo
// cumplía. Si se tocan, hay que tocar las dos: son la misma pregunta hecha en dos pantallas.
async function getCitasDelDiaParaCaja(orgId, fecha) {
    const oid = resolveOrg(orgId);
    const desdeTs = new Date(`${fecha}T00:00:00`).toISOString();
    const hastaTs = new Date(`${fecha}T23:59:59`).toISOString();
    const { data, error } = await supabase
        .from('appointments')
        .select('id, service, starts_at, status, stylist_id, precio_facturado, facturado_at, '
              + 'servicio_facturado, precio_manual, contacts!contact_id(full_name), stylists!stylist_id(id, name)')
        .eq('organization_id', oid)
        .gte('starts_at', desdeTs)
        .lte('starts_at', hastaTs)
        // Lista BLANCA, no negra: `neq('cancelled')` dejaba pasar todo lo que no se hubiera
        // pensado, y un estado nuevo entraría solo. `pending` (Bizum de San Remo) queda fuera
        // aquí a propósito; el endpoint ya es solo de salón (`exigirSalon`), así que no llega.
        .in('status', ['confirmed', 'completed'])
        // El no-show se expresa de DOS formas —el estado y el booleano— y updateAppointment
        // escribe las dos. Mirar solo una dejaba a quien no vino en la lista PARA SIEMPRE:
        // nadie pagó, así que nadie la iba a quitar de ahí.
        // `not(is true)` y no `eq(false)`: la columna es NULLABLE, y un NULL es "no consta que
        // faltara" — con eq(false) esas citas desaparecerían de Caja sin motivo visible.
        .not('no_show', 'is', true)
        // Marcada a mano como no cobrable (migración 037): un bloqueo, una cortesía, un hueco
        // reservado. Es lo único que distingue "esto no se cobra" de "esto está por cobrar".
        // NOT NULL DEFAULT false, así que aquí sí vale el eq: no hay tercer estado.
        .eq('no_facturable', false)
        .order('starts_at', { ascending: true });
    // Es la lista de lo que hay que cobrar: un fallo NO puede leerse como "hoy no hay nada".
    assertRead(error, 'appointments');
    return data || [];
}

// ─── Acuse de revisión del día (migración 039) ──────────────────────────────

const CIERRE_COLUMNS = 'id, organization_id, fecha_caja, esperado_efectivo, esperado_tarjeta, '
    + 'esperado_total, num_cobros, contado_efectivo, tpv_declarado, diferencia_efectivo, '
    + 'diferencia_tarjeta, cerrado_at, cerrado_por, nota, estado, corrige_a, motivo_correccion, '
    + 'anulado_at, anulado_por, created_at';

/**
 * El acuse VIGENTE de un día, o null si nadie lo ha revisado todavía.
 *
 * Sale de la vista `cierres_vigentes`, nunca de la tabla: el invariante "vigente y sin sucesor"
 * está definido una sola vez, en la 039. Si esto filtrara a mano habría dos definiciones de qué
 * cuenta y una acabaría devolviendo el acuse viejo después de volver a revisar.
 */
async function getCierreDelDia(orgId, fecha) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('cierres_vigentes').select(CIERRE_COLUMNS)
        .eq('organization_id', oid).eq('fecha_caja', fecha)
        .maybeSingle();
    // Es dinero: un fallo de lectura NO puede leerse como "este día está sin revisar", porque
    // entonces la pantalla invitaría a revisarlo otra vez y saldría un acuse duplicado.
    assertRead(error, 'cierres_vigentes');
    return data || null;
}

/** Los acuses vigentes de un rango, para pintar qué días están ya revisados. */
async function getCierresVigentes(orgId, { desde = null, hasta = null } = {}) {
    const oid = resolveOrg(orgId);
    let query = supabase.from('cierres_vigentes').select(CIERRE_COLUMNS).eq('organization_id', oid);
    if (desde) query = query.gte('fecha_caja', desde);
    if (hasta) query = query.lte('fecha_caja', hasta);
    const { data, error } = await query.order('fecha_caja', { ascending: false });
    assertRead(error, 'cierres_vigentes');
    return data || [];
}

/**
 * Los días que TIENEN dinero y NADIE ha revisado, del más antiguo al más reciente.
 *
 * Es lo que de verdad sustituye al "¿me mandó el WhatsApp anoche?": si hay tres días en la cola
 * se ve de un vistazo. Solo entran días con cobros — un domingo cerrado no es una tarea
 * pendiente, y llenar la cola de días vacíos entrena a no mirarla.
 *
 * HOY se excluye a propósito: el día no ha terminado y el TPV no estará en el banco hasta
 * mañana, así que proponer revisarlo sería proponer hacerlo mal.
 */
async function getDiasSinRevisar(orgId, { desde = null, hasta = null } = {}) {
    const oid = resolveOrg(orgId);
    const hoy = diaDeCajaHoy();
    const hastaReal = hasta && hasta < hoy ? hasta : addDiasStr(hoy, -1);
    const desdeReal = desde || addDiasStr(hoy, -60);

    const cobros = await getCobrosVigentes(oid, { desde: desdeReal, hasta: hastaReal });
    const porDia = new Map();
    for (const c of cobros) {
        const d = porDia.get(c.fecha_caja) || { fecha: c.fecha_caja, numCobros: 0, total: 0 };
        d.numCobros += 1;
        d.total += Number(c.importe_total) || 0;
        porDia.set(c.fecha_caja, d);
    }
    if (!porDia.size) return [];

    const cierres = await getCierresVigentes(oid, { desde: desdeReal, hasta: hastaReal });
    const revisados = new Set(cierres.map(c => c.fecha_caja));
    return [...porDia.values()]
        .filter(d => !revisados.has(d.fecha))
        .map(d => ({ ...d, total: Math.round(d.total * 100) / 100 }))
        .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/** Suma/resta días a un 'YYYY-MM-DD' sin pasar por Date local (que desplazaría por TZ). */
function addDiasStr(fecha, n) {
    const [y, m, d] = fecha.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
}

/**
 * Deja un día por revisado. Congela lo que suman sus cobros AHORA y guarda lo que dice la
 * persona; las diferencias las calcula `calcularDiferenciasCierre` y se escriben.
 *
 * `corrigeA` es lo que permite volver a revisar un día que se movió: sin él, el índice único
 * `cierres_un_acuse_por_dia` rechaza el segundo acuse, y esa es la conducta que se quiere —
 * revisar dos veces sin decir que se está corrigiendo sería duplicar el hecho.
 */
async function createCierre(orgId, {
    fecha, contadoEfectivo, tpvDeclarado, nota = null,
    corrigeA = null, motivoCorreccion = null, userId = null,
} = {}) {
    const oid = resolveOrg(orgId);
    const { buildCajaResumen, calcularDiferenciasCierre } = require('./helpers');

    // Lo esperado se lee AQUÍ, en el momento de revisar, y se congela. No se acepta del cliente:
    // si viniera del panel, el acuse afirmaría lo que la pantalla creía, no lo que hay.
    const cobros = await getCobrosVigentes(oid, { desde: fecha, hasta: fecha });
    const { totales } = buildCajaResumen(cobros);
    const dif = calcularDiferenciasCierre({
        esperadoEfectivo: totales.efectivo, esperadoTarjeta: totales.tarjeta,
        contadoEfectivo, tpvDeclarado,
    });

    const { data, error } = await supabase
        .from('cierres_caja')
        .insert({
            organization_id: oid,
            fecha_caja: fecha,
            esperado_efectivo: totales.efectivo,
            esperado_tarjeta: totales.tarjeta,
            esperado_total: totales.total,
            num_cobros: totales.numCobros,
            contado_efectivo: Number(contadoEfectivo),
            tpv_declarado: Number(tpvDeclarado),
            ...dif,
            nota: nota || null,
            corrige_a: corrigeA || null,
            motivo_correccion: motivoCorreccion || null,
            cerrado_por: userId || null,
        })
        .select(CIERRE_COLUMNS);
    assertRowsAffected(error, data, 'cierres_caja', 'createCierre');
    return data[0];
}

// ─── PIN de atribución por estilista (migración 036) ────────────────────────
//
// Lo pone y lo cambia la DUEÑA desde el panel. No hay autoservicio ni recuperación: si una
// estilista lo olvida, se le pone otro. Un flujo de recuperación sería aparato de seguridad y
// esto no es seguridad.

// Quién tiene PIN, SIN devolver hash ni salt. Es lo único que el panel necesita saber para
// pintar la configuración, y devolver los hashes "porque están ahí" es como acaban saliendo.
async function getStylistPinStatus(orgId) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('stylist_pins').select('stylist_id, actualizado_at').eq('organization_id', oid);
    assertRead(error, 'stylist_pins');
    return (data || []).map(r => ({ stylist_id: r.stylist_id, actualizado_at: r.actualizado_at }));
}

async function setStylistPin(orgId, stylistId, pin, { userId = null } = {}) {
    const oid = resolveOrg(orgId);
    const { hashPin } = require('./pin');
    const { hash, salt } = hashPin(pin);   // lanza si el formato no vale

    // La estilista tiene que existir EN ESTA ORG: sin esto, un id de otra organización crearía
    // una fila que su panel no ve pero que sí valida PINs.
    const { data: est, error: errEst } = await supabase
        .from('stylists').select('id').eq('id', stylistId).eq('organization_id', oid).maybeSingle();
    assertRead(errEst, 'stylists');
    if (!est) return null;

    const { data, error } = await supabase
        .from('stylist_pins')
        .upsert({
            organization_id: oid, stylist_id: stylistId,
            pin_hash: hash, pin_salt: salt,
            actualizado_at: now(), actualizado_por: userId || null,
        }, { onConflict: 'stylist_id' })
        .select('stylist_id, actualizado_at');
    assertRowsAffected(error, data, 'stylist_pins', 'setStylistPin');
    return data[0];
}

// Devuelve si de verdad retiró algún PIN.
//
// Tenía `assertWrite` —cubría un error de Supabase— pero no miraba las FILAS, y devolvía true
// fijo: un DELETE cuyos `.eq()` no casan nada (id que no existe, estilista de otra org) sale
// sin error, y el panel cantaba «PIN retirado» sobre un PIN que seguía puesto. Es el caso
// `deleteLead` del 07/08/2026, y sus hermanas de esta capa ya lo hacían bien.
//
// No lanza cuando no casa: aquí «no había PIN» es un desenlace posible y lo cuenta quien
// llama, con un 404. `assertRowsAffected` diría 500, que es otra cosa.
async function clearStylistPin(orgId, stylistId) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('stylist_pins').delete().eq('stylist_id', stylistId).eq('organization_id', oid)
        .select('stylist_id');
    assertWrite(error, 'stylist_pins', 'clearStylistPin');
    return (data?.length ?? 0) > 0;
}

// ¿Es el PIN de esa estilista? Devuelve solo true/false.
//
// Una estilista SIN PIN devuelve false, no "adelante": lo contrario convertiría a las que la
// dueña no ha dado de alta en confirmables por cualquiera. Sin PIN se cobra igual, pero la
// atribución queda declarada, que es lo honesto.
async function verifyStylistPin(orgId, stylistId, pin) {
    const oid = resolveOrg(orgId);
    if (!stylistId) return false;
    const { data, error } = await supabase
        .from('stylist_pins').select('pin_hash, pin_salt')
        .eq('stylist_id', stylistId).eq('organization_id', oid).maybeSingle();
    assertRead(error, 'stylist_pins');
    if (!data) return false;
    const { verifyPin } = require('./pin');
    return verifyPin(pin, data.pin_hash, data.pin_salt);
}

// Una cita concreta. Necesaria para no derivar su horario de la sesión del bot: al aceptar
// un upsell se recalculaba ends_at a partir de session.partialData.fecha_cita/hora_cita, que
// puede haberse quedado atrás si la cita se movió desde el panel — y ends_at acababa en otro
// día, rompiendo la disponibilidad y el worker de reseñas (que filtra por ends_at).
async function getAppointmentById(orgId, appointmentId) {
    if (!appointmentId) return null;
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('appointments')
        .select('*')
        .eq('id', appointmentId)
        .eq('organization_id', oid)
        .maybeSingle();
    assertRead(error, 'appointments');
    return data || null;
}

async function getAppointmentsByLead(orgId, contactId) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('appointments')
        .select('*')
        .eq('organization_id', oid)
        .eq('contact_id', contactId)
        .order('starts_at', { ascending: false });
    return data || [];
}

async function getAppointmentsPendientesRecordatorio(orgId) {
    return getLeadsPendientesRecordatorio(orgId);
}

async function getReservasBizumPendiente(orgId) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('appointments')
        .select('*, contacts!contact_id(id, full_name, wa_phone)')
        .eq('organization_id', oid)
        .eq('bizum_status', 'pending')
        .neq('status', 'cancelled')
        .order('starts_at', { ascending: true });
    return data || [];
}

// ─── Lista negra / VIP ────────────────────────────────────────────────────────

// Bloquear/desbloquear y marcar VIP son acciones sobre las que el panel da confirmación
// visual explícita ("Añadido a la lista negra"), así que no pueden fallar en silencio:
// assertRowsAffected lanza tanto si Supabase da error como si el UPDATE no tocó ninguna fila.
async function setBlacklist(orgId, contactId, reason) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('contacts')
        .update({ is_blacklisted: true, blacklist_reason: reason || null, updated_at: now() })
        .eq('id', contactId)
        .eq('organization_id', oid)
        .select('id');
    assertRowsAffected(error, data, 'contacts', 'update is_blacklisted=true');
    return true;
}

async function removeBlacklist(orgId, contactId) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('contacts')
        .update({ is_blacklisted: false, blacklist_reason: null, updated_at: now() })
        .eq('id', contactId)
        .eq('organization_id', oid)
        .select('id');
    assertRowsAffected(error, data, 'contacts', 'update is_blacklisted=false');
    return true;
}

async function setVip(orgId, contactId, value) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('contacts')
        .update({ is_vip: !!value, updated_at: now() })
        .eq('id', contactId)
        .eq('organization_id', oid)
        .select('id');
    assertRowsAffected(error, data, 'contacts', `update is_vip=${!!value}`);
    return true;
}

// Incremento ATÓMICO vía RPC: el read-modify-write anterior perdía visitas cuando dos
// escrituras coincidían (autoCompleteAppointments corre cada 5 min por org y el panel puede
// completar la misma cita a la vez), porque ambas leían el mismo valor y escribían el mismo +1.
// La función SQL hace `visit_count = coalesce(visit_count,0) + 1` en una sola sentencia.
async function incrementVisitCount(orgId, contactId) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase.rpc('increment_visit_count', {
        p_contact_id: contactId,
        p_organization_id: oid,
    });
    assertWrite(error, 'contacts', 'increment visit_count');
    // null = ninguna fila casó (contacto inexistente o de otra org). No es un fallo de
    // infraestructura: el llamante ya trataba ese caso devolviendo null.
    return data == null ? null : Number(data);
}

// El `[]` de esta lectura no es un hueco mudo: la pantalla lo pinta como «Lista negra vacía ·
// Los no-shows y rechazos de Bizum se añaden aquí automáticamente», o sea una afirmación de
// que el mecanismo funciona y no ha atrapado a nadie. Y Telegram contesta «La lista negra está
// vacía». Un fallo de lectura no puede decir ninguna de las dos cosas: es la capacidad que se
// abre el día del acosador (10/08/2026), y ese día llegar a creer que no hay nadie bloqueado
// es peor que no poder mirar.
//
// CUIDADO al añadir call sites: esto LANZA. El de Telegram (`list_blacklist`) cuelga de un
// `bot.on('message')` sin try/catch y por eso `ejecutarAccionSegura` lo envuelve.
async function getBlacklist(orgId) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', oid)
        .eq('is_blacklisted', true)
        .order('updated_at', { ascending: false });
    assertRead(error, 'contacts');
    return (data || []).map(rowToPublic);
}

// excludeBlacklisted: para los ENVÍOS (broadcast VIP). Un contacto puede ser VIP y estar en
// lista negra a la vez —el no-show de una clienta habitual la bloquea sin quitarle el VIP— y
// el broadcast le escribía igual, porque solo getBroadcastRecipients filtraba. El listado del
// panel NO lo filtra a propósito: ahí interesa ver que esa clienta está bloqueada.
async function getVipList(orgId, { excludeBlacklisted = false } = {}) {
    const oid = resolveOrg(orgId);
    let query = supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', oid)
        .eq('is_vip', true);
    if (excludeBlacklisted) query = query.or('is_blacklisted.is.null,is_blacklisted.eq.false');
    const { data } = await query.order('updated_at', { ascending: false });
    return (data || []).map(rowToPublic);
}

// Destinatarios para campañas masivas. SIEMPRE excluye lista negra.
// audience: 'todos' | 'no_vip' | 'nunca_reservado'
// phones: array opcional de teléfonos → allowlist explícito (para pruebas seguras);
//         si se pasa, IGNORA audience y apunta SOLO a esos números.
/**
 * La audiencia de una campaña, PARTIDA EN DOS: a quién se le puede entregar y a quién no, con
 * el motivo. Es el embudo único —los dos endpoints de campaña pasan por aquí—, así que
 * cualquier audiencia futura hereda las exclusiones sin que nadie tenga que acordarse.
 *
 * Devolver los excluidos, y no solo filtrarlos, es el punto entero de esta función. Un
 * destinatario que desaparece en silencio es el mismo fallo que llevamos días arreglando en
 * otras capas: la campaña sale, el número cuadra, y nadie se entera de que a tres clientas
 * REALES no les ha llegado nada porque su teléfono está mal escrito. El filtro evita el envío
 * inútil; la lista es la que hace que alguien las llame.
 *
 * Por eso los teléfonos del arnés se clasifican aquí y no se descartan en la consulta: lo que
 * la consulta tira no se puede enseñar después.
 */
async function getBroadcastAudience(orgId, { audience = 'todos', phones } = {}) {
    const oid = resolveOrg(orgId);
    let query = supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', oid)
        .or('is_blacklisted.is.null,is_blacklisted.eq.false');

    const allowlist = Array.isArray(phones)
        ? phones.map(sanitizePhone).filter(Boolean)
        : null;

    if (allowlist) {
        if (allowlist.length === 0) return { destinatarios: [], excluidos: [] };
        query = query.in('wa_phone', allowlist);
    } else if (audience === 'no_vip') {
        query = query.or('is_vip.is.null,is_vip.eq.false');
    } else if (audience === 'nunca_reservado') {
        query = query.eq('origen', 'importado_shortcuts');
    }

    const { data } = await query.order('updated_at', { ascending: false });

    const destinatarios = [];
    const excluidos = [];
    for (const contacto of (data || []).map(rowToPublic)) {
        const motivo = motivoNoEnviable(contacto.telefono);
        if (motivo) excluidos.push({ ...contacto, motivo });
        else destinatarios.push(contacto);
    }
    return { destinatarios, excluidos };
}

/**
 * Solo los que pueden recibir. Es lo que quiere el envío —runBroadcast no tiene nada que hacer
 * con una lista de excluidos—, así que la firma de siempre se conserva: un array de contactos.
 * Quien necesite saber a quién se ha dejado fuera y por qué llama a getBroadcastAudience.
 */
async function getBroadcastRecipients(orgId, opciones = {}) {
    return (await getBroadcastAudience(orgId, opciones)).destinatarios;
}

// ─── Broadcast sends (campañas por tandas) ───────────────────────────────────
//
// Registro de a quién se le mandó cada campaña. Existe por dos motivos que el resto del
// esquema no cubría: continuar una campaña al día siguiente sin repetir destinatarios, y
// contar los envíos de las últimas 24 h para no pasarse del tope del número.

const CLAIM_CADUCA_MS = 15 * 60 * 1000;

/** Teléfonos que YA recibieron esta campaña (solo 'sent'; un fallo debe poder reintentarse). */
async function getBroadcastSentPhones(orgId, campaignKey) {
    const oid = resolveOrg(orgId);
    if (!campaignKey) return new Set();
    const { data, error } = await supabase
        .from('broadcast_sends')
        .select('wa_phone')
        .eq('organization_id', oid)
        .eq('campaign_key', campaignKey)
        .eq('status', 'sent');
    assertRead(error, 'broadcast_sends');
    return new Set((data || []).map(r => r.wa_phone));
}

/**
 * Libera reservas que no llegaron a convertirse en envío, para que la siguiente tanda
 * pueda reintentarlas: las 'failed' y las 'pending' abandonadas (proceso caído a media
 * tanda). Sin esto el UNIQUE las bloquearía para siempre — getBroadcastSentPhones las
 * daría por no enviadas, pero el INSERT de reserva chocaría en cada intento.
 */
async function resetStaleBroadcastClaims(orgId, campaignKey) {
    const oid = resolveOrg(orgId);
    if (!campaignKey) return 0;
    const caducadas = new Date(Date.now() - CLAIM_CADUCA_MS).toISOString();
    const { data, error } = await supabase
        .from('broadcast_sends')
        .delete()
        .eq('organization_id', oid)
        .eq('campaign_key', campaignKey)
        .neq('status', 'sent')
        .or(`status.eq.failed,created_at.lt.${caducadas}`)
        .select('id');
    assertWrite(error, 'broadcast_sends', 'delete claims caducadas');
    return (data || []).length;
}

/**
 * RESERVA un destinatario antes de enviarle nada. Devuelve el id de la fila, o null si
 * otro proceso ya lo tenía (violación del UNIQUE, código 23505).
 *
 * El SELECT previo de getBroadcastSentPhones no basta como exclusión: dos pestañas del
 * panel pulsando "enviar" a la vez lo pasan las dos. Quien decide es este INSERT.
 */
async function claimBroadcastRecipient(orgId, { campaignKey, contactId = null, telefono }) {
    const oid = resolveOrg(orgId);
    const phone = sanitizePhone(telefono);
    if (!campaignKey || !phone) return null;
    const { data, error } = await supabase
        .from('broadcast_sends')
        .insert({
            organization_id: oid,
            campaign_key:    campaignKey,
            contact_id:      contactId,
            wa_phone:        phone,
            status:          'pending',
        })
        .select('id')
        .single();
    if (error) {
        if (error.code === '23505') return null; // ya reservado por otro → no es un fallo
        assertWrite(error, 'broadcast_sends', 'insert claim');
    }
    return data?.id ?? null;
}

/** Cierra una reserva: 'sent' (con el modo y la plantilla reales) o 'failed' (con el error). */
async function finishBroadcastSend(orgId, claimId, { status, mode = null, templateName = null, error: errMsg = null }) {
    const oid = resolveOrg(orgId);
    if (!claimId) return false;
    const { data, error } = await supabase
        .from('broadcast_sends')
        .update({
            status,
            mode,
            template_name: templateName,
            error:         errMsg ? String(errMsg).slice(0, 500) : null,
            sent_at:       status === 'sent' ? now() : null,
        })
        .eq('organization_id', oid)
        .eq('id', claimId)
        .select('id');
    assertRowsAffected(error, data, 'broadcast_sends', 'update finish');
    return true;
}

/**
 * Envíos EFECTIVOS de la org en las últimas 24 h, todas las campañas incluidas: el tope
 * lo impone Meta sobre el número, no sobre la campaña. Alimenta el recorte automático de
 * la tanda — el 01/08/2026 este número ya se llevó un bloqueo.
 */
async function countBroadcastSendsLast24h(orgId, now_ = Date.now()) {
    const oid = resolveOrg(orgId);
    const desde = new Date(now_ - VENTANA_24H_MS).toISOString();
    const { count, error } = await supabase
        .from('broadcast_sends')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', oid)
        .eq('status', 'sent')
        .gte('sent_at', desde);
    assertRead(error, 'broadcast_sends');
    return count || 0;
}

// Ventana en la que una respuesta se considera AUTOMÁTICA: la centralita de un negocio
// contesta en segundos, una persona no. Medido en la tanda 1 de `verano_tratamientos`
// (07/08/2026, 250 envíos, 6 respuestas): los tres autocontestadores tardaron 7,1 · 8,1 · 10,0 s
// y las tres personas 126 · 132 · 459 s. 30 s cae en mitad de ese hueco con margen por los dos
// lados. Es una HIPÓTESIS medida sobre n=3, no una ley: hay que recalibrarla con la tanda 2.
const RESPUESTA_AUTOMATICA_MS = 30 * 1000;

/**
 * ¿Este teléfono acaba de recibir un envío de campaña nuestro, hace menos de `dentroDeMs`?
 *
 * Existe para no dejar que un AUTOCONTESTADOR fije el idioma de una ficha. El 07/08/2026 tres
 * centralitas de otros negocios (DarYsol Events, Save Yourself y la de una videógrafa)
 * contestaron a la campaña en 7-10 s; el bot les leyó el idioma y escribió
 * `language_source: 'observed'` — la etiqueta que significa "se lo hemos leído a ELLA" y que
 * apaga todas las cautelas río abajo. Dos fichas acabaron en el idioma equivocado.
 *
 * La fuente es `broadcast_sends.sent_at` y NO `messages`, y esa parte importa: **la plantilla
 * de campaña no se escribe en `messages`**. Los cuatro contactos afectados tenían
 * `outbound_previos = 0` pese a haberla recibido, así que "tiempo desde nuestro último
 * saliente" calculado sobre `messages` habría dado null y la guarda no habría saltado nunca.
 *
 * Mira TODAS las campañas, no una: el riesgo es del envío, no de la clave.
 *
 * Devuelve el `sent_at` (ISO) si lo hay dentro de la ventana, o null. Un fallo de lectura NO
 * lanza: esto decide si se ESCRIBE una marca de confianza, y quedarse sin escribirla es la
 * dirección recuperable — al revés que en `getLastInboundAt`, donde un null manda plantilla de
 * más y cuesta dinero.
 */
async function getRecentBroadcastSendAt(orgId, telefono, dentroDeMs = RESPUESTA_AUTOMATICA_MS) {
    const oid = resolveOrg(orgId);
    const phone = sanitizePhone(telefono);
    if (!phone) return null;
    const desde = new Date(Date.now() - dentroDeMs).toISOString();
    const { data, error } = await supabase
        .from('broadcast_sends')
        .select('sent_at')
        .eq('organization_id', oid)
        .eq('wa_phone', phone)
        .eq('status', 'sent')
        .gte('sent_at', desde)
        .order('sent_at', { ascending: false })
        .limit(1);
    if (error) {
        logger.warn('broadcast_reciente_no_leido', { orgId: oid, telefono: phone, error: error.message });
        return null;
    }
    return data?.[0]?.sent_at || null;
}

// ─── Pending actions ─────────────────────────────────────────────────────────

async function createPendingAction(orgId, { type, contactId, appointmentId, payload }) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('pending_actions')
        .insert({
            organization_id: oid,
            type,
            contact_id: contactId || null,
            appointment_id: appointmentId || null,
            payload: payload || {},
        })
        .select()
        .single();
    assertWrite(error, 'pending_actions', 'insert');
    return data || null;
}

async function getPendingActions(orgId, type) {
    const oid = resolveOrg(orgId);
    let query = supabase
        .from('pending_actions')
        .select('*, contacts!contact_id(id, full_name, wa_phone), appointments!appointment_id(id, starts_at, party_size, occasion)')
        .eq('organization_id', oid)
        .eq('status', 'pending');
    if (type) query = query.eq('type', type);
    const { data, error } = await query.order('created_at', { ascending: true });
    // Un `[]` aquí AFIRMA que no hay nada pendiente, y de esa afirmación cuelga el primer paso
    // del desbloqueo: `PUT /api/leads/:id/bot-mode` con mode:'auto' busca la escalada en esta
    // lista y, si no la encuentra, no la resuelve — y responde `{ok:true}` igual, así que el
    // panel canta «Eliminado de la lista negra» sobre una `pending_action` que sigue abierta.
    // Con el error a la vista el endpoint da 500, el panel no encadena el DELETE y el contacto
    // se queda BLOQUEADO, que es el lado recuperable (la misma regla de orden del 10/08/2026).
    //
    // CUIDADO al añadir call sites: esto LANZA. `tryResolvePendingReply` (telegram.js) lo llama
    // desde un `bot.on('message')` sin try/catch y por eso lleva el suyo; sin él, una lectura
    // caída tumbaría el proceso —el bot de las dos orgs— por un rechazo sin manejar.
    assertRead(error, 'pending_actions');
    return data || [];
}

// Cerrar una acción pendiente. Devuelve la fila cerrada, o null si no había ninguna que cerrar.
//
// Se tragaba el `error` y devolvía null, que nadie miraba. El sitio donde duele es el primer
// paso del desbloqueo (`PUT /api/leads/:id/bot-mode` con mode:'auto'): la escalada se quedaba
// abierta y el panel cantaba «Eliminado de la lista negra» encima. Ahora un fallo de
// infraestructura LANZA, el endpoint da 500, el panel no encadena el DELETE y el contacto se
// queda BLOQUEADO — el lado recuperable, que es el orden fijado el 10/08/2026.
//
// `.select()` en forma de LISTA y no `.single()`: con `.single()`, cero filas es un `error`
// (PGRST116) y un assertWrite lo confundiría con una caída de la BD. Y cero filas aquí no es
// un fallo: significa que esa acción ya la había cerrado otro (el panel y Telegram cierran las
// mismas). Se devuelve null y quien llama decide, igual que `anularCobro`.
//
// CUIDADO al añadir call sites: esto LANZA. Los tres de webhook.js van dentro de su try; el de
// Telegram (`resolveBizumAction`/`resolveVipAction`) cuelga de un `bot.on('message')` sin
// try/catch y por eso `tryResolvePendingReply` es hoy un envoltorio con red.
async function resolvePendingAction(orgId, id, resolution) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('pending_actions')
        .update({ status: 'resolved', resolution, resolved_at: now() })
        .eq('id', id)
        .eq('organization_id', oid)
        .select();
    assertWrite(error, 'pending_actions', 'resolvePendingAction');
    return data?.[0] || null;
}

// ─── Stats dashboard ──────────────────────────────────────────────────────────

async function getStats(orgId) {
    const oid = resolveOrg(orgId);
    const ahora = new Date();
    const hoyInicio = new Date(ahora); hoyInicio.setHours(0, 0, 0, 0);
    const hoyFin = new Date(ahora); hoyFin.setHours(23, 59, 59, 999);
    const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

    const [
        { count: total },
        { count: reservasMes },
        { count: noShows },
        { count: bizumsPendientes },
        { count: resenasPendientes },
        { data: reservasHoy },
    ] = await Promise.all([
        supabase.from('contacts').select('*', { count: 'exact', head: true }).eq('organization_id', oid),
        supabase.from('appointments').select('*', { count: 'exact', head: true }).eq('organization_id', oid).neq('status', 'cancelled').gte('starts_at', inicioMes.toISOString()),
        supabase.from('appointments').select('*', { count: 'exact', head: true }).eq('organization_id', oid).eq('no_show', true).gte('starts_at', inicioMes.toISOString()),
        supabase.from('appointments').select('*', { count: 'exact', head: true }).eq('organization_id', oid).eq('bizum_status', 'pending').neq('status', 'cancelled'),
        supabase.from('appointments').select('*', { count: 'exact', head: true }).eq('organization_id', oid).eq('status', 'completed').eq('resena_enviada', false),
        supabase.from('appointments').select('full_name, party_size, starts_at, service, stylist_id').eq('organization_id', oid).neq('status', 'cancelled').gte('starts_at', hoyInicio.toISOString()).lte('starts_at', hoyFin.toISOString()).order('starts_at', { ascending: true }),
    ]);

    const proxima = (reservasHoy || []).find(r => new Date(r.starts_at) >= ahora) || (reservasHoy || [])[0];
    const proximaReserva = proxima ? {
        nombre: proxima.full_name,
        personas: proxima.party_size,
        hora: new Date(proxima.starts_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }),
    } : null;

    return {
        total,
        reservasMes,
        noShows,
        bizumsPendientes,
        resenasPendientes,
        citasHoy: (reservasHoy || []).length,
        proximaReserva,
    };
}

// ─── Stylists ─────────────────────────────────────────────────────────────────

async function getStylistsByOrg(orgId) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('stylists')
        .select('*')
        .eq('organization_id', oid)
        .eq('active', true)
        .order('name');
    assertRead(error, 'stylists');
    return data || [];
}

async function getStylist(orgId, stylistId) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('stylists')
        .select('*')
        .eq('organization_id', oid)
        .eq('id', stylistId)
        .maybeSingle();
    return data || null;
}

async function createStylist(orgId, { name, role, skills }) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('stylists')
        .insert({ organization_id: oid, name, role, skills: skills || [] })
        .select()
        .single();
    return data || null;
}

async function updateStylist(orgId, stylistId, campos) {
    const oid = resolveOrg(orgId);
    const updates = {};
    if (campos.name   !== undefined) updates.name   = campos.name;
    if (campos.role   !== undefined) updates.role   = campos.role;
    if (campos.skills !== undefined) updates.skills = campos.skills;
    if (campos.active !== undefined) updates.active = campos.active;
    if (!Object.keys(updates).length) return null;
    const { data } = await supabase
        .from('stylists')
        .update(updates)
        .eq('id', stylistId)
        .eq('organization_id', oid)
        .select()
        .single();
    return data || null;
}

async function getStylistSchedule(orgId, stylistId) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('stylist_schedules')
        .select('*')
        .eq('organization_id', oid)
        .eq('stylist_id', stylistId)
        .order('day_of_week');
    assertRead(error, 'stylist_schedules');
    return data || [];
}

async function getAllStylistSchedules(orgId) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('stylist_schedules')
        .select('*')
        .eq('organization_id', oid)
        .order('stylist_id')
        .order('day_of_week');
    return data || [];
}

async function upsertStylistSchedule(orgId, stylistId, schedules) {
    const oid = resolveOrg(orgId);
    // Reemplazo total: borramos el horario actual de la estilista y reinsertamos el nuevo.
    // Imprescindible para que un día desmarcado en el panel desaparezca de verdad — un
    // upsert por (stylist_id, day_of_week) dejaría los días eliminados colgados en la BD.
    await supabase
        .from('stylist_schedules')
        .delete()
        .eq('organization_id', oid)
        .eq('stylist_id', stylistId);
    const rows = (schedules || []).map(s => ({
        organization_id: oid,
        stylist_id: stylistId,
        day_of_week: s.day_of_week,
        start_time: s.start_time,
        end_time: s.end_time,
    }));
    if (rows.length) {
        await supabase.from('stylist_schedules').insert(rows);
    }
    return getStylistSchedule(oid, stylistId);
}

// ─── Schedule Blocks ──────────────────────────────────────────────────────────

async function getScheduleBlocks(orgId, stylistId, from, to) {
    const oid = resolveOrg(orgId);
    let query = supabase
        .from('schedule_blocks')
        .select('*')
        .eq('organization_id', oid);
    if (stylistId) query = query.eq('stylist_id', stylistId);
    if (from) query = query.gte('ends_at', from);
    if (to) query = query.lte('starts_at', to);
    const { data, error } = await query.order('starts_at');
    assertRead(error, 'schedule_blocks');
    return data || [];
}

async function createScheduleBlock(orgId, { stylistId, startsAt, endsAt, reason }) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('schedule_blocks')
        .insert({
            organization_id: oid,
            stylist_id: stylistId,
            starts_at: startsAt,
            ends_at: endsAt,
            reason: reason || null,
        })
        .select()
        .single();
    return data || null;
}

async function deleteScheduleBlock(orgId, blockId) {
    const oid = resolveOrg(orgId);
    await supabase.from('schedule_blocks').delete().eq('id', blockId).eq('organization_id', oid);
    return true;
}

// ─── Blocked days (full-day blocking per stylist or salon-wide) ──────────────

async function getBlockedDays(orgId, { from, to, stylistId } = {}) {
    const oid = resolveOrg(orgId);
    let query = supabase.from('blocked_days').select('*').eq('organization_id', oid);
    if (stylistId) query = query.or(`stylist_id.eq.${stylistId},stylist_id.is.null`);
    if (from) query = query.gte('fecha', from);
    if (to) query = query.lte('fecha', to);
    const { data, error } = await query.order('fecha');
    assertRead(error, 'blocked_days');
    return data || [];
}

async function createBlockedDay(orgId, { fecha, stylistId, motivo }) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase.from('blocked_days')
        .insert({
            organization_id: oid,
            fecha,
            stylist_id: stylistId || null,
            motivo: motivo || 'otro',
        })
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function deleteBlockedDay(orgId, blockId) {
    const oid = resolveOrg(orgId);
    await supabase.from('blocked_days').delete().eq('id', blockId).eq('organization_id', oid);
    return true;
}

// ─── Appointments by stylist (for availability) ──────────────────────────────

// Ésta es la lectura más peligrosa de las cinco: si falla y devuelve [], el motor cree
// que la estilista NO tiene ninguna cita y ofrece huecos ya reservados.
async function getAppointmentsByStylistAndRange(orgId, stylistId, from, to) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('appointments')
        .select('id, stylist_id, starts_at, ends_at, status, service')
        .eq('organization_id', oid)
        .eq('stylist_id', stylistId)
        .neq('status', 'cancelled')
        .gte('starts_at', from)
        .lte('starts_at', to)
        .order('starts_at');
    assertRead(error, 'appointments');
    return data || [];
}

// ─── Contact stats (CRM enrichment) ──────────────────────────────────────────

async function getContactStats(orgId) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase.rpc('get_contact_stats', { p_org_id: oid });
    return data || [];
}

// ─── Contact language / preferred stylist ─────────────────────────────────────

// Fija el idioma OBSERVADO en conversación. Lo llama bot.js en cada turno del salón, en
// fire-and-forget, así que aquí se hacen las dos comprobaciones que el llamador no puede:
//
//   1. El valor. detectLanguage solo devuelve los cuatro soportados, pero el otro call site
//      pasa `idioma_detectado` del LLM, que puede inventarse cualquier cosa. Un 'pt' escrito
//      aquí se usaría luego como clave contra `config.plantilla_*` y la campaña omitiría a
//      esa clienta en silencio. Se rechaza y se avisa; no se escribe nada.
//   2. Que la escritura ocurra. Esta función devolvía `true` sin mirar `error` NI cuántas
//      filas tocó: una escritura perdida era indistinguible de una correcta, y como los dos
//      call sites hacen `.catch()`, tampoco había traza. Ese vacío es lo que hizo imposible
//      saber por qué 34696073110 respondía en ruso con la ficha en 'es'.
async function updateContactLanguage(orgId, contactId, language) {
    const oid = resolveOrg(orgId);
    if (!IDIOMAS_SOPORTADOS.includes(language)) {
        logger.warn('idioma_no_soportado_descartado', { orgId: oid, contactId, language });
        return false;
    }
    // Lectura previa para poder FUSIONAR metadata: un UPDATE de jsonb sustituye el objeto
    // entero, así que escribir { language_source } a pelo se llevaría por delante wa_jid
    // (con el que el panel manda mensajes al chat correcto) y auto_return. Mismo patrón que
    // setContactJid y setInferredContactLanguage.
    const { data: row, error: readError } = await supabase
        .from('contacts')
        .select('language, metadata')
        .eq('id', contactId)
        .eq('organization_id', oid)
        .maybeSingle();

    if (readError) {
        // Degradación deliberada: se pierde la MARCA, nunca el idioma. Abortar aquí dejaría
        // al bot hablando en el idioma correcto con la ficha en el equivocado, que es
        // exactamente el fallo que esta función existe para no cometer.
        logger.warn('idioma_fuente_no_leida', { orgId: oid, contactId, language, error: readError.message });
        const { data, error } = await supabase
            .from('contacts')
            .update({ language, updated_at: now() })
            .eq('id', contactId)
            .eq('organization_id', oid)
            .select('id');
        assertRowsAffected(error, data, 'contacts', 'updateContactLanguage');
        return true;
    }

    const meta = (row?.metadata && typeof row.metadata === 'object') ? row.metadata : {};
    // Ni el idioma ni su procedencia cambian: no se escribe. Esto se llama en CADA turno del
    // salón en el que se detecta idioma, y hasta ahora hacía un UPDATE por mensaje para
    // dejar la fila igual que estaba.
    if (row && row.language === language && meta.language_source === 'observed' && !meta.language_inferred) {
        return true;
    }

    // ── 'observed' EXIGE CORROBORACIÓN: dos mensajes que coincidan ──────────────────────
    //
    // Hasta el 07/08/2026 bastaba UNO. Como 'observed' es la etiqueta que apaga todas las
    // cautelas río abajo (el prompt deja de anunciar el idioma como probable, y la campaña lo
    // usa para elegir plantilla de Meta), eso significaba que un solo mensaje podía silenciar
    // todas las reservas del sistema.
    //
    // Y un mensaje es prueba débil por motivos que no tienen nada que ver con los
    // autocontestadores que destaparon esto: el de DarYsol Events era **bilingüe** —español y
    // ucraniano en el mismo texto—, así que `detectLanguage` tuvo que elegir uno y eligió el
    // que no era. Un reenvío, un familiar usando el teléfono o un «spasibo» suelto producen
    // exactamente el mismo efecto.
    //
    // Qué cambia y qué NO:
    //   · `language` se sigue escribiendo SIEMPRE, en el primer mensaje. Es la dirección
    //     recuperable y es lo que hace que el bot le hable en su idioma cuanto antes; el
    //     comportamiento de conversación no se toca.
    //   · lo que espera a la corroboración es la MARCA. Hasta que un segundo mensaje coincide,
    //     la ficha conserva la fuente que tenía ('inferred' o 'default') y guarda el candidato.
    //   · una ficha que YA era 'observed' sigue siéndolo aunque cambie de idioma: ahí ya se ha
    //     leído a la clienta, y degradarla sería perder información buena.
    const yaObservada = meta.language_source === 'observed' && !meta.language_inferred;
    const candidatoCoincide = meta.language_candidate === language;
    const promociona = yaObservada || candidatoCoincide;

    const metaNueva = { ...meta };
    if (promociona) {
        metaNueva.language_source = 'observed';
        metaNueva.language_observed_at = now();
        // La conjetura por nombre queda superada: la clienta ha escrito y se ha visto
        // en qué idioma. Dejar la marca puesta haría que la ficha siguiera avisando
        // «deducido de su nombre» sobre un idioma ya observado — y que el prompt lo
        // tratara como una probabilidad cuando ya es un hecho.
        metaNueva.language_inferred = false;
        delete metaNueva.language_candidate;
        delete metaNueva.language_candidate_at;
    } else {
        // Primera observación, o una que contradice al candidato anterior: se anota y se
        // espera. `language_source` conserva lo que valía…
        metaNueva.language_candidate = language;
        metaNueva.language_candidate_at = now();
        // …pero si NO había marca explícita hay que escribirla ahora, congelando la que le
        // correspondía ANTES de tocar el idioma. Si no, `resolveLanguageSource` (helpers.js)
        // la deduciría de la columna ya cambiada por su última regla —«idioma distinto de 'es'
        // ⇒ observed»— y una ficha sin corroborar se leería como observada: exactamente lo que
        // esta corroboración existe para impedir. Caso real: ficha con metadata null y
        // `language: 'es'`, un «Thursday» la pasa a 'en' y sin esto pasaría a leerse observada.
        if (!LANGUAGE_SOURCES.includes(metaNueva.language_source)) {
            metaNueva.language_source = resolveLanguageSource({ language: row?.language, metadata: meta });
        }
    }

    const { data, error } = await supabase
        .from('contacts')
        .update({ language, metadata: metaNueva, updated_at: now() })
        .eq('id', contactId)
        .eq('organization_id', oid)
        .select('id');
    assertRowsAffected(error, data, 'contacts', 'updateContactLanguage');
    if (!promociona) {
        logger.info('idioma_candidato_sin_corroborar', {
            orgId: oid, contactId, language, fuenteActual: meta.language_source || null,
        });
    }
    return true;
}

// Guarda el TRATO que ha pedido la clienta ('formal' | 'informal'), en metadata.tratamiento.
// Va en jsonb y no en columna nueva a propósito: no hay migración de por medio y el dato es
// exactamente igual de consultable.
//
// Lo pide una persona explícitamente ("давай на вы"), así que se escribe sin corroborar —al
// revés que el idioma observado, que exige dos mensajes porque ahí lo estamos DEDUCIENDO.
// Aquí no se deduce nada: se ha pedido.
async function setContactTratamiento(orgId, contactId, tratamiento) {
    const oid = resolveOrg(orgId);
    if (!['formal', 'informal'].includes(tratamiento)) {
        logger.warn('tratamiento_no_soportado_descartado', { orgId: oid, contactId, tratamiento });
        return false;
    }
    // Lectura previa para FUSIONAR: un UPDATE de jsonb sustituye el objeto entero y escribir
    // { tratamiento } a pelo se llevaría wa_jid (con el que el panel manda al chat correcto),
    // language_source y auto_return. Mismo patrón que setContactJid y updateContactLanguage.
    const { data: row, error: readError } = await supabase
        .from('contacts')
        .select('metadata')
        .eq('id', contactId)
        .eq('organization_id', oid)
        .maybeSingle();
    if (readError) {
        logger.warn('tratamiento_no_leido', { orgId: oid, contactId, error: readError.message });
        return false;
    }
    const meta = (row?.metadata && typeof row.metadata === 'object') ? row.metadata : {};
    if (meta.tratamiento === tratamiento) return true; // sin cambios → no escribimos
    const { data, error } = await supabase
        .from('contacts')
        .update({
            metadata: { ...meta, tratamiento, tratamiento_at: new Date().toISOString() },
            updated_at: now(),
        })
        .eq('id', contactId)
        .eq('organization_id', oid)
        .select('id');
    // Un UPDATE cuyos .eq() no casan nada devuelve error=null: sin esto, "guardado" sería
    // una afirmación sin comprobar (regla 4).
    assertRowsAffected(error, data, 'contacts', 'setContactTratamiento');
    logger.info('tratamiento_guardado', { orgId: oid, contactId, tratamiento });
    return true;
}

// Fija un idioma INFERIDO por heurística de nombre (scripts/classify-sante-language-by-name.js),
// no confirmado por conversación real. Se marca en metadata (language_source:'inferred' y el
// booleano histórico language_inferred) para que quede distinguible de un idioma verificado.
// updateContactLanguage lo pisa —marca y todo— en cuanto la clienta escribe; aun así el
// caller del script solo debe usar esta función en contactos sin ningún inbound registrado.
async function setInferredContactLanguage(orgId, contactId, language, matched) {
    const oid = resolveOrg(orgId);
    const { data: row } = await supabase
        .from('contacts')
        .select('metadata')
        .eq('id', contactId)
        .eq('organization_id', oid)
        .maybeSingle();
    const meta = (row?.metadata && typeof row.metadata === 'object') ? row.metadata : {};
    const { error } = await supabase
        .from('contacts')
        .update({
            language,
            metadata: {
                ...meta,
                language_source: 'inferred',
                language_inferred: true,
                language_inference_source: 'name_heuristic',
                language_inference_matched: matched,
                language_inference_at: now(),
            },
            updated_at: now(),
        })
        .eq('id', contactId)
        .eq('organization_id', oid);
    assertWrite(error, 'contacts', 'setInferredContactLanguage');
    return true;
}

// Las dos de abajo tenían el mismo agujero que updateContactLanguage: `await supabase…` sin
// mirar `error` ni las filas tocadas, y `return true` pasara lo que pasara. Con el .catch()
// mudo de sus call sites, una escritura perdida no dejaba ni rastro — y lo que se pierde es
// la memoria del salón: la clienta vuelve y el bot no le ofrece su estilista de siempre,
// sin que nadie pueda saber por qué. `.select('id')` es lo que permite contar las filas.
async function updateContactPreferredStylist(orgId, contactId, stylistId) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('contacts')
        .update({ preferred_stylist_id: stylistId, updated_at: now() })
        .eq('id', contactId)
        .eq('organization_id', oid)
        .select('id');
    assertRowsAffected(error, data, 'contacts', 'updateContactPreferredStylist');
    return true;
}

async function updateContactLastStylist(orgId, contactId, stylistName) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('contacts')
        .update({ last_stylist: stylistName, updated_at: now() })
        .eq('id', contactId)
        .eq('organization_id', oid)
        .select('id');
    assertRowsAffected(error, data, 'contacts', 'updateContactLastStylist');
    return true;
}

// ─── Last completed appointment (agent memory) ──────────────────────────────

async function getLastCompletedAppointment(orgId, contactId) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('appointments')
        .select('service, stylist_id, starts_at, stylists!stylist_id(name)')
        .eq('organization_id', oid)
        .eq('contact_id', contactId)
        .eq('status', 'completed')
        .order('starts_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return data ? {
        service: data.service,
        stylist_name: data.stylists?.name || null,
        date: data.starts_at,
    } : null;
}

// ─── Informe de nombres que faltan (solo lectura) ────────────────────────────
//
// El nombre vive en DOS columnas que no se copian entre sí y que fallan distinto:
//
//   · `contacts.full_name` es NULLABLE. Es la que leen el bot para saludar y
//     getLeadsPendientesRecordatorio para el recordatorio de 24 h; sin ella el envío se
//     bloquea (motivoNoEnviable → 'sin_nombre').
//   · `appointments.full_name` es NOT NULL, así que cuando falta NO es null: saveAppointment
//     escribe `contact.nombre || ''`. Una cadena vacía no la detecta ningún `IS NULL`, y es
//     la que acaba en el KPI de "próxima cita" del panel como una fila sin nadie.
//
// De ahí que el informe mire las dos y las cruce: lo más frecuente es que una tenga el
// nombre y la otra no, y entonces no hay que preguntarle nada a la clienta.

async function getContactosParaInformeNombres(orgId) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('contacts')
        .select('id, wa_phone, full_name, estado, visit_count, is_blacklisted, created_at, updated_at')
        .eq('organization_id', oid)
        .order('created_at', { ascending: true });
    assertRead(error, 'contacts');
    return data || [];
}

async function getCitasParaInformeNombres(orgId) {
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('appointments')
        .select('id, contact_id, full_name, phone, service, starts_at, status')
        .eq('organization_id', oid)
        .neq('status', 'cancelled')
        .order('starts_at', { ascending: true });
    assertRead(error, 'appointments');
    return data || [];
}

// ─── Review worker helpers ────────────────────────────────────────────────────

// Citas que TOCA pedir reseña. Quién queda fuera y por qué:
//
//   · lista negra          — pedirle una reseña de Google a alguien a quien acabas de
//                            bloquear no tiene sentido.
//   · queja abierta        — `contacts.escalation_reason` sin resolver, o una
//                            `pending_actions` de tipo 'escalation' en 'pending'. Pedirle
//                            una reseña pública a una clienta que se ha quejado y todavía
//                            no ha sido atendida es la peor forma posible de rematar la
//                            queja. Detectado el 06/08/2026: el filtro solo miraba la lista
//                            negra, así que una clienta con `queja_cita` abierta recibía su
//                            petición de reseña 2 h después de la cita como cualquier otra.
//                            Lo único que lo impedía en ese momento era otro fallo (el
//                            botón del panel, que marcaba sin enviar).
//
// `bot_mode = 'manual'` NO excluye, y es deliberado: con Coexistence casi toda conversación
// atendida desde el móvil acaba en manual, así que excluirlo mataría las reseñas de casi
// todas las clientas. "La atiende una persona" no es "se ha quejado".
//
// Los dos filtros van en JS y no en la query porque viven en tablas distintas de
// `appointments`. La lectura de escaladas SÍ propaga su error (assertRead): si no se puede
// saber quién tiene una queja abierta, no se manda ninguna reseña en este tic. Una reseña de
// menos se recupera al tic siguiente; una reseña a quien se acaba de quejar, no.
async function getCompletedAppointmentsForReview(orgId, horasAfter) {
    const oid = resolveOrg(orgId);
    const cutoff = new Date(Date.now() - horasAfter * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
        .from('appointments')
        .select('*, contacts!contact_id(id, full_name, wa_phone, language, metadata, is_blacklisted, escalation_reason)')
        .eq('organization_id', oid)
        .eq('status', 'completed')
        .eq('resena_enviada', false)
        .lte('ends_at', cutoff)
        .order('ends_at', { ascending: true });

    const candidatas = (data || []).filter(row =>
        !row.contacts?.is_blacklisted && !row.contacts?.escalation_reason);
    if (!candidatas.length) return [];

    // Segunda vuelta solo sobre las candidatas: la cola de reseñas es de unas pocas filas,
    // así que sale más barato esto que arrastrar un join a pending_actions en la consulta.
    const contactIds = [...new Set(candidatas.map(r => r.contacts?.id || r.contact_id).filter(Boolean))];
    if (!contactIds.length) return candidatas;

    const { data: escaladas, error: errEsc } = await supabase
        .from('pending_actions')
        .select('contact_id')
        .eq('organization_id', oid)
        .eq('type', 'escalation')
        .eq('status', 'pending')
        .in('contact_id', contactIds);
    assertRead(errEsc, 'pending_actions');

    const conQueja = new Set((escaladas || []).map(e => e.contact_id));
    if (!conQueja.size) return candidatas;
    return candidatas.filter(row => !conQueja.has(row.contacts?.id || row.contact_id));
}

async function autoCompleteAppointments(orgId) {
    const oid = resolveOrg(orgId);
    const ahora = now();
    // El error se comprobaba: sin él, un UPDATE fallido dejaba `data` undefined, el bucle
    // recorría [] y el worker informaba "0 citas completadas" — indistinguible de una tarde
    // sin citas. Esas citas no se completan nunca y por tanto no llegan a facturarse.
    const { data, error } = await supabase
        .from('appointments')
        // updated_by va aquí porque este UPDATE no pasa por updateAppointment. Sin él, una
        // cita completada por el barrido y otra completada por una persona en el panel
        // serían indistinguibles (migración 033).
        .update({ status: 'completed', updated_by: 'worker:auto-complete' })
        .eq('organization_id', oid)
        .eq('status', 'confirmed')
        .lte('ends_at', ahora)
        .select('id, contact_id');
    assertWrite(error, 'appointments', 'autoComplete status=completed');

    // Mantener contacts.visit_count en sync con el COUNT de citas completadas
    // (el display usa total_visitas, pero la lógica VIP lee visit_count).
    // Una llamada por cita completada (incrementVisitCount es +1 secuencial).
    for (const apt of data || []) {
        if (apt.contact_id) await incrementVisitCount(oid, apt.contact_id);
    }
    // Congelar el importe en el mismo momento en que la cita entra en la facturación.
    // El catch sigue sin propagar (las citas YA están completadas y eso es lo que importaba),
    // pero ya no es mudo: un log que nadie lee no es un aviso, y aquí se pierden importes.
    if (data?.length) {
        try {
            await stampBillingSnapshot(oid, data.map(a => a.id));
        } catch (e) {
            logger.error('error_snapshot_facturacion', { orgId: oid, citas: data.length, error: e.message });
            await avisarSnapshotIncompleto(oid, { intentadas: data.length, selladas: 0, error: e.message });
        }
    }
    return data || [];
}

async function hasActiveAppointmentForSlot(orgId, contactId, fecha, hora) {
    if (!contactId || !fecha) return false;
    const oid = resolveOrg(orgId);
    const startsAt = buildStartsAt(fecha, hora);
    if (!startsAt) return false;
    const { data, error } = await supabase
        .from('appointments')
        .select('id')
        .eq('organization_id', oid)
        .eq('contact_id', contactId)
        .eq('starts_at', startsAt.toISOString())
        .neq('status', 'cancelled')
        .maybeSingle();
    assertRead(error, 'appointments');
    return !!data;
}

// Citas FUTURAS y vivas de un contacto. La usa la red anti-cita-fantasma de bot.js para
// contrastar lo que el mensaje del bot AFIRMA contra lo que hay realmente escrito: es la
// única fuente de verdad admisible: session.bookedSlots es memoria del proceso y no
// sobrevive a un reinicio ni al timeout de sesión.
// Con assertRead: si esta lectura fallara en silencio devolveríamos [] y la red concluiría
// que TODA cita anunciada es fantasma — reescribiendo mensajes correctos.
// Acepta un contactId suelto o un ARRAY de ids (los que devuelve findContactIdsByPhone): una
// clienta con contactos duplicados tiene sus citas repartidas entre varias filas de `contacts`
// y mirar solo la canónica es exactamente cómo el bot se quedó ciego ante la cita de Valeria.
async function getUpcomingAppointments(orgId, contactId) {
    const ids = (Array.isArray(contactId) ? contactId : [contactId]).filter(Boolean);
    if (!ids.length) return [];
    const oid = resolveOrg(orgId);
    const { data, error } = await supabase
        .from('appointments')
        .select('id, service, starts_at, ends_at, status, stylist_id, stylists!stylist_id(name)')
        .eq('organization_id', oid)
        .in('contact_id', ids)
        .neq('status', 'cancelled')
        .gte('starts_at', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
        .order('starts_at', { ascending: true });
    assertRead(error, 'appointments');
    return data || [];
}

// ─── Auth ───────────────────────────────────────────────────────────────────
// Verifica un access_token de Supabase Auth (JWT del usuario del dashboard) y
// deriva su organization_id desde `profiles`. Devuelve { userId, orgId } o null.
// La org NUNCA se toma de un header del cliente: se deriva del token verificado.
async function authenticateToken(accessToken) {
    if (!accessToken || typeof accessToken !== 'string') return null;
    const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
    const user = userData?.user;
    if (userErr || !user) return null;
    const { data: profile } = await supabase
        .from('profiles')
        .select('organization_id')
        .eq('id', user.id)
        .maybeSingle();
    if (!profile?.organization_id) return null;
    return { userId: user.id, orgId: profile.organization_id };
}

module.exports = {
    sanitizePhone,
    phoneVariants,
    authenticateToken,
    saveLead,
    updateLead,
    findByPhone,
    findContactIdsByPhone,
    setContactJid,
    getContactWaJid,
    findById,
    marcarCitaCompletada,
    marcarRecordatorioSent,
    getLeadsPendientesRecordatorio,
    getConfigValue,
    getConfigEntry,
    setConfigValue,
    getAllLeads,
    getLeadsByDateRange,
    updateLeadById,
    deleteLead,
    getAllConfig,
    getStats,
    saveMessage,
    getMessages,
    setLeadBotMode,
    setEscalationReason,
    getContactosParaInformeNombres,
    getCitasParaInformeNombres,
    getContactosEnManual,
    getContactIdsConAccionPendiente,
    devolverContactoAAuto,
    deleteConversationMessages,
    getLastInboundAt,
    getLastInboundAtBulk,
    isWithin24hWindow,
    saveAppointment,
    hasActiveAppointmentForSlot,
    getUpcomingAppointments,
    updateAppointment,
    deleteAppointment,
    getAppointmentById,
    getAppointmentsByLead,
    getAppointmentsByDateRange,
    getCompletedAppointmentsForBilling,
    stampBillingSnapshot,
    setManualPrice,
    createCobro,
    getCobrosVigentes,
    getCobrosHistorial,
    getCobroById,
    rectifyCobro,
    anularCobro,
    diaDeCajaHoy,
    getCitasDelDiaParaCaja,
    getCierreDelDia,
    getCierresVigentes,
    getDiasSinRevisar,
    createCierre,
    getStylistPinStatus,
    setStylistPin,
    clearStylistPin,
    verifyStylistPin,
    getAppointmentsPendientesRecordatorio,
    getReservasBizumPendiente,
    getAgentConfig,
    updateAgentConfig,
    setBlacklist,
    removeBlacklist,
    setVip,
    incrementVisitCount,
    getBlacklist,
    getVipList,
    getBroadcastRecipients,
    getBroadcastAudience,
    getBroadcastSentPhones,
    resetStaleBroadcastClaims,
    claimBroadcastRecipient,
    finishBroadcastSend,
    countBroadcastSendsLast24h,
    getRecentBroadcastSendAt,
    RESPUESTA_AUTOMATICA_MS,
    createPendingAction,
    getPendingActions,
    resolvePendingAction,
    // Stylists
    getStylistsByOrg,
    getStylist,
    createStylist,
    updateStylist,
    getStylistSchedule,
    getAllStylistSchedules,
    upsertStylistSchedule,
    // Schedule blocks
    getScheduleBlocks,
    createScheduleBlock,
    deleteScheduleBlock,
    getBlockedDays,
    createBlockedDay,
    deleteBlockedDay,
    // Availability
    getAppointmentsByStylistAndRange,
    // Contact extensions
    updateContactLanguage,
    setContactTratamiento,
    setInferredContactLanguage,
    updateContactPreferredStylist,
    updateContactLastStylist,
    getContactStats,
    // Review worker
    getCompletedAppointmentsForReview,
    autoCompleteAppointments,
    // Agent memory
    getLastCompletedAppointment,
    // Vigilante de esperas
    getEscaladasPendientes,
    getConversacionesSinResponder,
};
