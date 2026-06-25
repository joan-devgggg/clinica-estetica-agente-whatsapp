/**
 * db.js — Supabase storage (multi-tenant schema)
 * Capa de datos del bot — todas las funciones reciben orgId como primer parámetro.
 */

const supabase = require('./supabase');

const DEFAULT_ORG = process.env.ORGANIZATION_ID || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── Helpers internos ─────────────────────────────────────────────────────────

function resolveOrg(orgId) { return orgId || DEFAULT_ORG; }

function sanitizePhone(phone) {
    if (!phone || typeof phone !== 'string') return '';
    return phone.replace(/["'\s]/g, '').replace(/@c\.us$|@lid$/g, '').replace(/\D/g, '').trim();
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
        visit_count:           row.visit_count || 0,
        allergies:             row.allergies,
        preferences:           row.preferences,
        preferred_stylist_id:  row.preferred_stylist_id || null,
        language:              row.language || 'es',
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

    const { data } = await supabase
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
            appointment_id:     datos.appointment_id || null,
            language:           datos.language || 'es',
            updated_at:         now(),
        })
        .select('id')
        .single();
    return data?.id ?? null;
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

    if (!existing) return !!await saveLead(oid, datos);

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

    await supabase.from('contacts').update(updates).eq('id', existing.id).eq('organization_id', oid);
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
        appointment_id: 'appointment_id',
    };
    const updates = { updated_at: now() };
    for (const [oldKey, newKey] of Object.entries(fieldMap)) {
        if (campos[oldKey] !== undefined) updates[newKey] = campos[oldKey];
    }
    await supabase.from('contacts').update(updates).eq('id', id).eq('organization_id', oid);
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

async function getLeadsPendientesRecordatorio(orgId) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', oid)
        .eq('estado', 'confirmado')
        .eq('recordatorio_enviado', false)
        .not('fecha_cita', 'is', null);
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
    const { data: existing } = await supabase
        .from('conversations')
        .select('id')
        .eq('organization_id', oid)
        .eq('contact_id', contactId)
        .maybeSingle();
    if (existing) return existing.id;

    const { data: created } = await supabase
        .from('conversations')
        .insert({ organization_id: oid, contact_id: contactId })
        .select('id')
        .single();
    return created?.id ?? null;
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

async function getMessages(orgId, telefono, { limit = 100 } = {}) {
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

async function setLeadBotMode(orgId, telefono, mode) {
    const oid = resolveOrg(orgId);
    const phone = sanitizePhone(telefono);
    await supabase
        .from('contacts')
        .update({ bot_mode: mode, updated_at: now() })
        .eq('organization_id', oid)
        .eq('wa_phone', phone);
    return true;
}

// ─── Agent Config ─────────────────────────────────────────────────────────────

const _agentConfigCache = new Map();

async function getAgentConfig(orgId) {
    const oid = resolveOrg(orgId);
    const cached = _agentConfigCache.get(oid);
    if (cached && Date.now() - cached.ts < 60000) return cached.data;

    const { data } = await supabase
        .from('agent_configs')
        .select('*')
        .eq('organization_id', oid)
        .maybeSingle();
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

    const startsAt = hora ? new Date(`${fecha}T${hora}:00`) : new Date(`${fecha}T20:00:00`);
    const durationMs = (duracionMin || 120) * 60 * 1000;
    const endsAt = new Date(startsAt.getTime() + durationMs);

    // Idempotencia: nunca crear DOS veces la misma cita. Si ya existe una cita activa
    // (no cancelada) para este contacto a la MISMA hora de inicio, devolvemos la existente
    // en vez de insertar un duplicado. Backstop a nivel de datos contra cualquier reintento,
    // race o red de seguridad que intente reservar el mismo hueco más de una vez.
    {
        const { data: existing } = await supabase
            .from('appointments')
            .select('*')
            .eq('organization_id', oid)
            .eq('contact_id', contactId)
            .eq('starts_at', startsAt.toISOString())
            .neq('status', 'cancelled')
            .maybeSingle();
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

    if (error) {
        console.error('[saveAppointment] error Supabase', { contactId, fecha, hora, error: error.message });
        return null;
    }
    return data || null;
}

async function updateAppointment(orgId, appointmentId, campos) {
    const oid = resolveOrg(orgId);
    const updates = {};
    if (campos.servicio    !== undefined) updates.service      = campos.servicio;
    if (campos.estado      !== undefined) updates.status       = campos.estado;
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
        const startsAt = new Date(`${campos.fecha}T${campos.hora}:00`);
        const durationMs = (campos.duracionMin || 120) * 60 * 1000;
        updates.starts_at = startsAt.toISOString();
        updates.ends_at   = new Date(startsAt.getTime() + durationMs).toISOString();
    }
    if (!Object.keys(updates).length) return null;
    const { data } = await supabase
        .from('appointments')
        .update(updates)
        .eq('id', appointmentId)
        .eq('organization_id', oid)
        .select()
        .single();
    return data || null;
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

async function setBlacklist(orgId, contactId, reason) {
    const oid = resolveOrg(orgId);
    await supabase
        .from('contacts')
        .update({ is_blacklisted: true, blacklist_reason: reason || null, updated_at: now() })
        .eq('id', contactId)
        .eq('organization_id', oid);
    return true;
}

async function removeBlacklist(orgId, contactId) {
    const oid = resolveOrg(orgId);
    await supabase
        .from('contacts')
        .update({ is_blacklisted: false, blacklist_reason: null, updated_at: now() })
        .eq('id', contactId)
        .eq('organization_id', oid);
    return true;
}

async function setVip(orgId, contactId, value) {
    const oid = resolveOrg(orgId);
    await supabase
        .from('contacts')
        .update({ is_vip: !!value, updated_at: now() })
        .eq('id', contactId)
        .eq('organization_id', oid);
    return true;
}

async function incrementVisitCount(orgId, contactId) {
    const oid = resolveOrg(orgId);
    const contact = await findById(oid, contactId);
    if (!contact) return null;
    const visitCount = (contact.visit_count || 0) + 1;
    await supabase
        .from('contacts')
        .update({ visit_count: visitCount, updated_at: now() })
        .eq('id', contactId)
        .eq('organization_id', oid);
    return visitCount;
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

async function getVipList(orgId) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('organization_id', oid)
        .eq('is_vip', true)
        .order('updated_at', { ascending: false });
    return (data || []).map(rowToPublic);
}

// ─── Pending actions ─────────────────────────────────────────────────────────

async function createPendingAction(orgId, { type, contactId, appointmentId, payload }) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
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
    const { data } = await supabase
        .from('stylists')
        .select('*')
        .eq('organization_id', oid)
        .eq('active', true)
        .order('name');
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
    const { data } = await supabase
        .from('stylist_schedules')
        .select('*')
        .eq('organization_id', oid)
        .eq('stylist_id', stylistId)
        .order('day_of_week');
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
    const { data } = await query.order('starts_at');
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

// ─── Appointments by stylist (for availability) ──────────────────────────────

async function getAppointmentsByStylistAndRange(orgId, stylistId, from, to) {
    const oid = resolveOrg(orgId);
    const { data } = await supabase
        .from('appointments')
        .select('id, stylist_id, starts_at, ends_at, status, service')
        .eq('organization_id', oid)
        .eq('stylist_id', stylistId)
        .neq('status', 'cancelled')
        .gte('starts_at', from)
        .lte('starts_at', to)
        .order('starts_at');
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

async function updateContactPreferredStylist(orgId, contactId, stylistId) {
    const oid = resolveOrg(orgId);
    await supabase
        .from('contacts')
        .update({ preferred_stylist_id: stylistId, updated_at: now() })
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
        .select('*, contacts!contact_id(id, full_name, wa_phone, language)')
        .eq('organization_id', oid)
        .eq('status', 'completed')
        .eq('resena_enviada', false)
        .lte('ends_at', cutoff)
        .order('ends_at', { ascending: true });
    return data || [];
}

async function autoCompleteAppointments(orgId) {
    const oid = resolveOrg(orgId);
    const ahora = now();
    const { data } = await supabase
        .from('appointments')
        .update({ status: 'completed' })
        .eq('organization_id', oid)
        .eq('status', 'confirmed')
        .lte('ends_at', ahora)
        .select('id, contact_id');

    // Mantener contacts.visit_count en sync con el COUNT de citas completadas
    // (el display usa total_visitas, pero la lógica VIP lee visit_count).
    // Una llamada por cita completada (incrementVisitCount es +1 secuencial).
    for (const apt of data || []) {
        if (apt.contact_id) await incrementVisitCount(oid, apt.contact_id);
    }
    return data || [];
}

module.exports = {
    saveLead,
    updateLead,
    findByPhone,
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
    saveAppointment,
    updateAppointment,
    getAppointmentsByLead,
    getAppointmentsByDateRange,
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
    // Availability
    getAppointmentsByStylistAndRange,
    // Contact extensions
    updateContactLanguage,
    updateContactPreferredStylist,
    getContactStats,
    // Review worker
    getCompletedAppointmentsForReview,
    autoCompleteAppointments,
    // Agent memory
    getLastCompletedAppointment,
};
