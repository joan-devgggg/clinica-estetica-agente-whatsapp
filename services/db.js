/**
 * db.js — Supabase storage (multi-tenant schema)
 * Misma interfaz pública que la versión SQLite para compatibilidad con bot, review y reminder.
 *
 * Mapeo de tablas:
 *   leads (antigua)  →  contacts    (telefono→wa_phone, nombre→full_name, estado_cita→estado)
 *   messages         →  conversations + messages (direction/sender en lugar de direccion)
 *   appointments     →  appointments con contact_id
 *   config           →  config con organization_id
 *   agent_configs    →  agent_configs con organization_id
 */

const supabase = require('./supabase');

const ORG_ID = process.env.ORGANIZATION_ID || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── Helpers internos ─────────────────────────────────────────────────────────

function sanitizePhone(phone) {
    if (!phone || typeof phone !== 'string') return '';
    return phone.replace(/["'\s]/g, '').trim();
}

function now() { return new Date().toISOString(); }

function rowToPublic(row) {
    if (!row) return null;
    return {
        id:                    row.id,
        nombre:                row.full_name,
        telefono:              row.wa_phone,
        tratamiento:           row.tratamiento,
        preferencia_horaria:   row.preferencia_horaria,
        fecha_cita:            row.fecha_cita,
        hora_cita:             row.hora_cita,
        estado_cita:           row.estado || 'pendiente',
        bot_mode:              row.bot_mode || 'auto',
        resena_enviada:        !!row.resena_enviada,
        recordatorio_enviado:  !!row.recordatorio_enviado,
        origen:                row.origen,
        notas:                 row.notas,
        appointment_id:        row.appointment_id,
        created_at:            row.created_at,
        updated_at:            row.updated_at,
    };
}

function normalizePref(pref) {
    if (!pref) return null;
    if (typeof pref === 'object') return pref.periodo || JSON.stringify(pref);
    return pref;
}

// ─── Leads / Contacts ────────────────────────────────────────────────────────

async function findByPhone(telefono) {
    const phone = sanitizePhone(telefono);
    if (!phone) return null;
    const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', ORG_ID)
        .eq('wa_phone', phone)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return rowToPublic(data);
}

async function findById(id) {
    if (!id) return null;
    const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', ORG_ID)
        .eq('id', id)
        .maybeSingle();
    return rowToPublic(data);
}

async function getAllLeads({ limit = 200, offset = 0, estado, search } = {}) {
    let query = supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', ORG_ID);

    if (estado) query = query.eq('estado', estado);
    if (search) {
        query = query.or(
            `full_name.ilike.%${search}%,wa_phone.ilike.%${search}%,tratamiento.ilike.%${search}%`
        );
    }
    const { data } = await query
        .order('updated_at', { ascending: false })
        .range(offset, offset + limit - 1);
    return (data || []).map(rowToPublic);
}

async function getLeadsByDateRange(desde, hasta) {
    const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', ORG_ID)
        .not('fecha_cita', 'is', null)
        .gte('fecha_cita', desde)
        .lte('fecha_cita', hasta)
        .not('estado', 'eq', 'cancelado')
        .order('fecha_cita', { ascending: true })
        .order('hora_cita', { ascending: true });
    return (data || []).map(rowToPublic);
}

async function saveLead(datos) {
    if (!datos.telefono) return null;
    const phone = sanitizePhone(datos.telefono);

    if (datos.leadId) {
        await updateLead(datos);
        return datos.leadId;
    }

    // saveMessage creates contacts with just the phone before the bot flow assigns leadId.
    // Find that contact and update it instead of failing with a unique constraint violation.
    const existing = await findByPhone(phone);
    if (existing) {
        await updateLead({ ...datos, leadId: existing.id });
        return existing.id;
    }

    const { data } = await supabase
        .from('contacts')
        .insert({
            organization_id:    ORG_ID,
            wa_phone:           phone,
            full_name:          datos.nombre || null,
            tratamiento:        datos.tratamiento || null,
            preferencia_horaria: normalizePref(datos.preferencia_horaria),
            fecha_cita:         datos.fecha_cita || null,
            hora_cita:          datos.hora_cita || null,
            estado:             datos.estado_cita || 'pendiente',
            origen:             datos.origen || 'instagram_ads',
            notas:              datos.notas || null,
            appointment_id:     datos.appointment_id || null,
            updated_at:         now(),
        })
        .select('id')
        .single();
    return data?.id ?? null;
}

async function updateLead(datos) {
    if (!datos.telefono && !datos.leadId) return false;
    const phone = sanitizePhone(datos.telefono);

    let existing = null;
    if (datos.leadId) {
        existing = await findById(datos.leadId);
    } else {
        existing = await findByPhone(phone);
    }

    if (!existing) return !!await saveLead(datos);

    const updates = { updated_at: now() };
    if (datos.nombre !== undefined)              updates.full_name = datos.nombre;
    if (datos.telefono !== undefined)            updates.wa_phone = phone;
    if (datos.tratamiento !== undefined)         updates.tratamiento = datos.tratamiento;
    if (datos.preferencia_horaria !== undefined) updates.preferencia_horaria = normalizePref(datos.preferencia_horaria);
    if (datos.fecha_cita !== undefined)          updates.fecha_cita = datos.fecha_cita;
    if (datos.hora_cita !== undefined)           updates.hora_cita = datos.hora_cita;
    if (datos.estado_cita !== undefined)         updates.estado = datos.estado_cita;
    if (datos.notas !== undefined)               updates.notas = datos.notas;
    if (datos.appointment_id !== undefined)      updates.appointment_id = datos.appointment_id;

    await supabase.from('contacts').update(updates).eq('id', existing.id).eq('organization_id', ORG_ID);
    return true;
}

async function updateLeadById(id, campos) {
    const fieldMap = {
        nombre:             'full_name',
        telefono:           'wa_phone',
        tratamiento:        'tratamiento',
        preferencia_horaria:'preferencia_horaria',
        fecha_cita:         'fecha_cita',
        hora_cita:          'hora_cita',
        estado_cita:        'estado',
        notas:              'notas',
        origen:             'origen',
    };
    const updates = { updated_at: now() };
    for (const [oldKey, newKey] of Object.entries(fieldMap)) {
        if (campos[oldKey] !== undefined) updates[newKey] = campos[oldKey];
    }
    await supabase.from('contacts').update(updates).eq('id', id).eq('organization_id', ORG_ID);
    return findById(id);
}

async function deleteLead(id) {
    await supabase.from('contacts').delete().eq('id', id).eq('organization_id', ORG_ID);
}

async function marcarCitaCompletada(telefono) {
    const phone = sanitizePhone(telefono);
    await supabase
        .from('contacts')
        .update({ estado: 'completado', updated_at: now() })
        .eq('organization_id', ORG_ID)
        .eq('wa_phone', phone);
    return true;
}

async function marcarResenaSent(id) {
    await supabase
        .from('contacts')
        .update({ resena_enviada: true, updated_at: now() })
        .eq('id', id)
        .eq('organization_id', ORG_ID);
    return true;
}

async function marcarRecordatorioSent(id) {
    await supabase
        .from('contacts')
        .update({ recordatorio_enviado: true, updated_at: now() })
        .eq('id', id)
        .eq('organization_id', ORG_ID);
    return true;
}

async function getLeadsPendientesResena() {
    const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', ORG_ID)
        .eq('estado', 'completado')
        .eq('resena_enviada', false);
    return (data || []).map(rowToPublic);
}

async function getLeadsPendientesRecordatorio() {
    const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', ORG_ID)
        .eq('estado', 'confirmado')
        .eq('recordatorio_enviado', false)
        .not('fecha_cita', 'is', null);
    return (data || []).map(rowToPublic);
}

// ─── Config ───────────────────────────────────────────────────────────────────

async function getConfigValue(clave) {
    const { data } = await supabase
        .from('config')
        .select('valor')
        .eq('organization_id', ORG_ID)
        .eq('clave', clave)
        .maybeSingle();
    if (!data) return null;
    try { return JSON.parse(data.valor); } catch { return data.valor; }
}

async function setConfigValue(clave, valor) {
    const valorStr = typeof valor === 'string' ? valor : JSON.stringify(valor);
    await supabase
        .from('config')
        .upsert(
            { organization_id: ORG_ID, clave, valor: valorStr, updated_at: now() },
            { onConflict: 'organization_id,clave' }
        );
    return true;
}

async function getAllConfig() {
    const { data } = await supabase
        .from('config')
        .select('clave, valor')
        .eq('organization_id', ORG_ID);
    const result = {};
    for (const row of (data || [])) {
        try { result[row.clave] = JSON.parse(row.valor); } catch { result[row.clave] = row.valor; }
    }
    return result;
}

// ─── Messages (monitor WhatsApp) ─────────────────────────────────────────────

async function findOrCreateConversation(contactId) {
    const { data: existing } = await supabase
        .from('conversations')
        .select('id')
        .eq('organization_id', ORG_ID)
        .eq('contact_id', contactId)
        .maybeSingle();
    if (existing) return existing.id;

    const { data: created } = await supabase
        .from('conversations')
        .insert({ organization_id: ORG_ID, contact_id: contactId })
        .select('id')
        .single();
    return created?.id ?? null;
}

async function saveMessage({ telefono, contenido, direccion, esManual = false }) {
    const phone = sanitizePhone(telefono);
    if (!phone || !contenido) return null;

    let contact = await findByPhone(phone);
    if (!contact) {
        const newId = await saveLead({ telefono: phone });
        contact = await findById(newId);
    }
    if (!contact) return null;

    const convId = await findOrCreateConversation(contact.id);
    if (!convId) return null;

    const direction = direccion === 'entrante' ? 'inbound' : 'outbound';
    const sender    = direction === 'inbound' ? 'contact' : (esManual ? 'human' : 'bot');

    const { data } = await supabase
        .from('messages')
        .insert({
            conversation_id: convId,
            organization_id: ORG_ID,
            direction,
            sender,
            content: contenido,
            created_at: now(),
        })
        .select('id')
        .single();

    // Actualizar last_message_at en la conversación
    await supabase
        .from('conversations')
        .update({ last_message_at: now() })
        .eq('id', convId);

    return data?.id ?? null;
}

async function getMessages(telefono, { limit = 100 } = {}) {
    const phone = sanitizePhone(telefono);
    if (!phone) return [];

    const contact = await findByPhone(phone);
    if (!contact) return [];

    const { data: conv } = await supabase
        .from('conversations')
        .select('id')
        .eq('organization_id', ORG_ID)
        .eq('contact_id', contact.id)
        .maybeSingle();
    if (!conv) return [];

    const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: true })
        .limit(limit);

    return (data || []).map(m => ({
        id:         m.id,
        lead_id:    contact.id,
        telefono:   phone,
        direccion:  m.direction === 'inbound' ? 'entrante' : 'saliente',
        contenido:  m.content,
        es_manual:  m.sender === 'human',
        timestamp:  m.created_at,
    }));
}

async function setLeadBotMode(telefono, mode) {
    const phone = sanitizePhone(telefono);
    await supabase
        .from('contacts')
        .update({ bot_mode: mode, updated_at: now() })
        .eq('organization_id', ORG_ID)
        .eq('wa_phone', phone);
    return true;
}

// ─── Agent Config ─────────────────────────────────────────────────────────────

async function getAgentConfig() {
    const { data } = await supabase
        .from('agent_configs')
        .select('*')
        .eq('organization_id', ORG_ID)
        .maybeSingle();
    return data || null;
}

async function updateAgentConfig(campos) {
    const allowed = ['system_prompt', 'tone', 'services', 'business_hours', 'handoff_message'];
    const updates = { updated_at: now() };
    for (const k of allowed) {
        if (campos[k] !== undefined) updates[k] = campos[k];
    }
    await supabase
        .from('agent_configs')
        .upsert(
            { organization_id: ORG_ID, ...updates },
            { onConflict: 'organization_id' }
        );
    return getAgentConfig();
}

// ─── Appointments ─────────────────────────────────────────────────────────────

async function saveAppointment(contactId, { servicio, fecha, hora, estado = 'confirmed', notas } = {}) {
    if (!contactId) {
        console.error('[saveAppointment] contactId nulo — cita no guardada');
        return null;
    }
    if (!fecha) {
        console.error('[saveAppointment] fecha nula — cita no guardada', { contactId });
        return null;
    }

    const contact = await findById(contactId);
    if (!contact) {
        console.error('[saveAppointment] contacto no encontrado', { contactId });
        return null;
    }

    // Construir starts_at / ends_at desde fecha + hora
    const startsAt = hora ? new Date(`${fecha}T${hora}:00`) : new Date(`${fecha}T10:00:00`);
    const endsAt   = new Date(startsAt.getTime() + 60 * 60 * 1000); // 1h por defecto

    const { data, error } = await supabase
        .from('appointments')
        .insert({
            organization_id: ORG_ID,
            contact_id:      contactId,
            service:         servicio || contact.tratamiento || '',
            starts_at:       startsAt.toISOString(),
            ends_at:         endsAt.toISOString(),
            status:          estado,
            full_name:       contact.nombre || '',
            phone:           contact.telefono || '',
            notes:           notas || null,
        })
        .select()
        .single();

    if (error) {
        console.error('[saveAppointment] error Supabase', { contactId, fecha, hora, error: error.message, code: error.code });
        return null;
    }
    return data || null;
}

async function updateAppointment(appointmentId, campos) {
    const updates = {};
    if (campos.servicio !== undefined) updates.service = campos.servicio;
    if (campos.estado   !== undefined) updates.status  = campos.estado;
    if (campos.notas    !== undefined) updates.notes   = campos.notas;
    if (campos.fecha !== undefined && campos.hora !== undefined) {
        const startsAt = new Date(`${campos.fecha}T${campos.hora}:00`);
        updates.starts_at = startsAt.toISOString();
        updates.ends_at   = new Date(startsAt.getTime() + 60 * 60 * 1000).toISOString();
    }
    if (!Object.keys(updates).length) return null;
    const { data } = await supabase
        .from('appointments')
        .update(updates)
        .eq('id', appointmentId)
        .eq('organization_id', ORG_ID)
        .select()
        .single();
    return data || null;
}

async function getAppointmentsByDateRange(desde, hasta) {
    const desdeTs = new Date(`${desde}T00:00:00`).toISOString();
    const hastaTs = new Date(`${hasta}T23:59:59`).toISOString();
    const { data } = await supabase
        .from('appointments')
        .select('*, contacts!contact_id(id, full_name, wa_phone, tratamiento, origen, bot_mode)')
        .eq('organization_id', ORG_ID)
        .gte('starts_at', desdeTs)
        .lte('starts_at', hastaTs)
        .neq('status', 'cancelled')
        .order('starts_at', { ascending: true });

    return (data || []).map(row => {
        const startsAt = new Date(row.starts_at);
        return {
            id:            row.contacts?.id,
            appointment_id: row.id,
            nombre:        row.contacts?.full_name,
            telefono:      row.contacts?.wa_phone,
            tratamiento:   row.contacts?.tratamiento || row.service,
            origen:        row.contacts?.origen,
            bot_mode:      row.contacts?.bot_mode,
            fecha_cita:    startsAt.toISOString().split('T')[0],
            hora_cita:     startsAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }),
            estado_cita:   row.status,
            notas:         row.notes,
        };
    });
}

async function getAppointmentsByLead(contactId) {
    const { data } = await supabase
        .from('appointments')
        .select('*')
        .eq('organization_id', ORG_ID)
        .eq('contact_id', contactId)
        .order('starts_at', { ascending: false });
    return data || [];
}

async function getAppointmentsPendientesResena() {
    return getLeadsPendientesResena();
}

async function getAppointmentsPendientesRecordatorio() {
    return getLeadsPendientesRecordatorio();
}

// ─── Stats dashboard ──────────────────────────────────────────────────────────

async function getStats() {
    const hoy = new Date().toISOString().split('T')[0];
    const manana = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    const [
        { count: total },
        { count: confirmados },
        { count: enChat },
        { count: completados },
        { count: citasHoy },
        { count: citasManana },
    ] = await Promise.all([
        supabase.from('contacts').select('*', { count: 'exact', head: true }).eq('organization_id', ORG_ID),
        supabase.from('contacts').select('*', { count: 'exact', head: true }).eq('organization_id', ORG_ID).eq('estado', 'confirmado'),
        supabase.from('contacts').select('*', { count: 'exact', head: true }).eq('organization_id', ORG_ID).in('estado', ['pendiente', 'en_conversacion']),
        supabase.from('contacts').select('*', { count: 'exact', head: true }).eq('organization_id', ORG_ID).eq('estado', 'completado'),
        supabase.from('contacts').select('*', { count: 'exact', head: true }).eq('organization_id', ORG_ID).eq('fecha_cita', hoy).eq('estado', 'confirmado'),
        supabase.from('contacts').select('*', { count: 'exact', head: true }).eq('organization_id', ORG_ID).eq('fecha_cita', manana).eq('estado', 'confirmado'),
    ]);

    return { total, confirmados, enChat, completados, citasHoy, citasManana };
}

module.exports = {
    saveLead,
    updateLead,
    findByPhone,
    findById,
    marcarCitaCompletada,
    marcarResenaSent,
    marcarRecordatorioSent,
    getLeadsPendientesResena,
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
    saveAppointment,
    updateAppointment,
    getAppointmentsByLead,
    getAppointmentsByDateRange,
    getAppointmentsPendientesResena,
    getAppointmentsPendientesRecordatorio,
    getAgentConfig,
    updateAgentConfig,
};
