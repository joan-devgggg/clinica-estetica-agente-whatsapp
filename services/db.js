/**
 * db.js — Supabase storage (multi-tenant schema)
 * Capa de datos del bot — todas las funciones reciben orgId como primer parámetro.
 */

const supabase = require('./supabase');
const logger = require('../lib/logger');
const { NO_STYLIST_KEY, computeServiceBilling } = require('./helpers');

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
        wa_jid:                (row.metadata && typeof row.metadata === 'object') ? (row.metadata.wa_jid || null) : null,
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
    };
    const updates = { updated_at: now() };
    for (const [oldKey, newKey] of Object.entries(fieldMap)) {
        if (campos[oldKey] !== undefined) updates[newKey] = campos[oldKey];
    }
    resetRecordatorioIfConfirmado(updates, campos.estado_cita);
    normalizeContactUpdates(updates);
    // El error de Supabase se PROPAGA: devolver la fila releída sin mirarlo hacía que un
    // UPDATE fallido se viese como un guardado correcto (200 con los valores viejos).
    const { error } = await supabase.from('contacts').update(updates).eq('id', id).eq('organization_id', oid);
    if (error) throw new Error(`No se pudo guardar el contacto: ${error.message}`);
    return findById(oid, id);
}

async function deleteLead(orgId, id) {
    const oid = resolveOrg(orgId);
    await supabase.from('contacts').delete().eq('id', id).eq('organization_id', oid);
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

async function marcarRecordatorioSent(orgId, id) {
    const oid = resolveOrg(orgId);
    await supabase
        .from('contacts')
        .update({ recordatorio_enviado: true, updated_at: now() })
        .eq('id', id)
        .eq('organization_id', oid);
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

async function setConfigValue(orgId, clave, valor) {
    const oid = resolveOrg(orgId);
    const valorStr = typeof valor === 'string' ? valor : JSON.stringify(valor);
    await supabase
        .from('config')
        .upsert(
            { organization_id: oid, clave, valor: valorStr, updated_at: now() },
            { onConflict: 'organization_id,clave' }
        );
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

async function saveMessage(orgId, { telefono, contenido, direccion, esManual = false }) {
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

    const { data } = await supabase
        .from('messages')
        .insert({
            conversation_id: convId,
            organization_id: oid,
            direction,
            sender,
            content: contenido,
            created_at: now(),
        })
        .select('id')
        .single();

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

async function saveAppointment(orgId, contactId, { servicio, fecha, hora, duracionMin, estado = 'confirmed', notas, personas, ocasion, bizumStatus = 'not_required', bizumAmount, stylistId, source = 'bot' } = {}) {
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
    const durationMs = (Number.isFinite(durMin) && durMin > 0 ? durMin : 120) * 60 * 1000;
    const endsAt = new Date(startsAt.getTime() + durationMs);

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
    if (campos.resenaEnviada !== undefined) updates.resena_enviada = campos.resenaEnviada;
    if (campos.recordatorioEnviado !== undefined) updates.recordatorio_enviado = campos.recordatorioEnviado;
    if (campos.endsAt !== undefined) updates.ends_at = campos.endsAt;
    if (campos.fecha !== undefined && campos.hora !== undefined) {
        const startsAt = buildStartsAt(campos.fecha, campos.hora);
        if (!startsAt) {
            console.error('[updateAppointment] fecha/hora inválida — no se actualiza el horario', { appointmentId, fecha: campos.fecha, hora: campos.hora });
            return null;
        }
        const durMin = Number(campos.duracionMin);
        const durationMs = (Number.isFinite(durMin) && durMin > 0 ? durMin : 120) * 60 * 1000;
        updates.starts_at = startsAt.toISOString();
        updates.ends_at   = new Date(startsAt.getTime() + durationMs).toISOString();
    }
    if (!Object.keys(updates).length) return null;
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
    const { data } = await supabase
        .from('appointments')
        .select('*, contacts!contact_id(id, full_name, wa_phone, origen, bot_mode, is_vip, is_blacklisted), stylists!stylist_id(id, name)')
        .eq('organization_id', oid)
        .gte('starts_at', desdeTs)
        .lte('starts_at', hastaTs)
        .neq('status', 'cancelled')
        .order('starts_at', { ascending: true });

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
        .select('id, service, stylist_id, starts_at, precio_facturado, iva_rate, facturado_at, stylist_name_facturado, contacts!contact_id(full_name), stylists!stylist_id(id, name)')
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
    }));
}

// Congela el importe de las citas indicadas. Se llama en la ÚNICA transición que importa: el
// paso a 'completed'. A partir de ahí el informe lee este valor y deja de recalcular, así que
// subir un precio en el catálogo —o que alguien edite el `service` de una cita pasada— ya no
// reescribe la facturación de un periodo cerrado.
// No pisa un snapshot existente (facturado_at != null): completar dos veces no revaloriza.
// Si el servicio no es calculable (nombre ambiguo, sin precio, sin match) NO se inventa nada:
// precio_facturado se queda a null y el informe la sigue contando como "sin poder calcular".
async function stampBillingSnapshot(orgId, appointmentIds, { ivaRate = 0.21 } = {}) {
    const ids = (appointmentIds || []).filter(Boolean);
    if (!ids.length) return 0;
    const oid = resolveOrg(orgId);

    const { data: citas, error } = await supabase
        .from('appointments')
        .select('id, service, facturado_at, stylists!stylist_id(name)')
        .eq('organization_id', oid)
        .in('id', ids)
        .is('facturado_at', null);
    assertRead(error, 'appointments');
    if (!citas?.length) return 0;

    const cfg = await getAgentConfig(oid);
    const catalogo = cfg?.services || [];
    const sellado = now();
    let n = 0;

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
            })
            .eq('id', cita.id)
            .eq('organization_id', oid);
        if (errUpd) {
            // No se propaga: el snapshot es un extra sobre una cita que YA está completada.
            // Sin él el informe recalcula como siempre, así que perderlo no rompe nada.
            logger.error('db_write_error', { tabla: 'appointments', op: 'stampBillingSnapshot', error: errUpd.message, code: errUpd.code });
            continue;
        }
        n++;
    }
    return n;
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

async function getBlacklist(orgId) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', oid)
        .eq('is_blacklisted', true)
        .order('updated_at', { ascending: false });
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
async function getBroadcastRecipients(orgId, { audience = 'todos', phones } = {}) {
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
        if (allowlist.length === 0) return [];
        query = query.in('wa_phone', allowlist);
    } else if (audience === 'no_vip') {
        query = query.or('is_vip.is.null,is_vip.eq.false');
    } else if (audience === 'nunca_reservado') {
        query = query.eq('origen', 'importado_shortcuts');
    }

    const { data } = await query.order('updated_at', { ascending: false });
    return (data || []).map(rowToPublic);
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
    const { data } = await query.order('created_at', { ascending: true });
    return data || [];
}

async function resolvePendingAction(orgId, id, resolution) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('pending_actions')
        .update({ status: 'resolved', resolution, resolved_at: now() })
        .eq('id', id)
        .eq('organization_id', oid)
        .select()
        .single();
    return data || null;
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

async function updateContactLanguage(orgId, contactId, language) {
    const oid = resolveOrg(orgId);
    await supabase
        .from('contacts')
        .update({ language, updated_at: now() })
        .eq('id', contactId)
        .eq('organization_id', oid);
    return true;
}

// Fija un idioma INFERIDO por heurística de nombre (scripts/classify-sante-language-by-name.js),
// no confirmado por conversación real. Se marca en metadata.language_inferred para que quede
// distinguible de un idioma verificado — updateContactLanguage (llamado por detectLanguage en
// cada turno real) lo pisa en cuanto la clienta escribe, pero no borra la marca; por eso el
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

async function updateContactPreferredStylist(orgId, contactId, stylistId) {
    const oid = resolveOrg(orgId);
    await supabase
        .from('contacts')
        .update({ preferred_stylist_id: stylistId, updated_at: now() })
        .eq('id', contactId)
        .eq('organization_id', oid);
    return true;
}

async function updateContactLastStylist(orgId, contactId, stylistName) {
    const oid = resolveOrg(orgId);
    await supabase
        .from('contacts')
        .update({ last_stylist: stylistName, updated_at: now() })
        .eq('id', contactId)
        .eq('organization_id', oid);
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

// ─── Review worker helpers ────────────────────────────────────────────────────

async function getCompletedAppointmentsForReview(orgId, horasAfter) {
    const oid = resolveOrg(orgId);
    const cutoff = new Date(Date.now() - horasAfter * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
        .from('appointments')
        .select('*, contacts!contact_id(id, full_name, wa_phone, language, metadata, is_blacklisted)')
        .eq('organization_id', oid)
        .eq('status', 'completed')
        .eq('resena_enviada', false)
        .lte('ends_at', cutoff)
        .order('ends_at', { ascending: true });
    // El filtro va en JS y no en la query porque is_blacklisted vive en la tabla unida:
    // pedirle una reseña de Google a alguien a quien acabas de bloquear no tiene sentido.
    return (data || []).filter(row => !row.contacts?.is_blacklisted);
}

async function autoCompleteAppointments(orgId) {
    const oid = resolveOrg(orgId);
    const ahora = now();
    // El error se comprobaba: sin él, un UPDATE fallido dejaba `data` undefined, el bucle
    // recorría [] y el worker informaba "0 citas completadas" — indistinguible de una tarde
    // sin citas. Esas citas no se completan nunca y por tanto no llegan a facturarse.
    const { data, error } = await supabase
        .from('appointments')
        .update({ status: 'completed' })
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
    if (data?.length) {
        try {
            await stampBillingSnapshot(oid, data.map(a => a.id));
        } catch (e) {
            logger.error('error_snapshot_facturacion', { orgId: oid, error: e.message });
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
    getBroadcastSentPhones,
    resetStaleBroadcastClaims,
    claimBroadcastRecipient,
    finishBroadcastSend,
    countBroadcastSendsLast24h,
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
    setInferredContactLanguage,
    updateContactPreferredStylist,
    updateContactLastStylist,
    getContactStats,
    // Review worker
    getCompletedAppointmentsForReview,
    autoCompleteAppointments,
    // Agent memory
    getLastCompletedAppointment,
};
