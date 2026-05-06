const axios = require('axios');
require('dotenv').config();
const config = require('../config.json');

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const airtableConfig = config.storage?.airtable || {};
const LEADS_TABLE = airtableConfig.leadsTable || '💅 Leads';
const CONFIG_TABLE = airtableConfig.configTable || '⚙️ Configuración';

// Mapping: internal bot values → Airtable display values
const ESTADO_MAP = {
    'pendiente':       '🆕 Nuevo Lead',
    'en_conversacion': '💬 En conversación',
    'confirmado':      '📅 Cita confirmada',
    'completado':      '✅ Completado',
    'cancelado':       '❌ Cancelado',
    'abandonado':      '⏰ No show',
};

// Mapping: preferencia interna → opción Select de Airtable
const PREFERENCIA_MAP = {
    'mañana': 'Mañana (10h-14h)',
    'manana': 'Mañana (10h-14h)',
    'tarde':  'Tarde (16h-20h)',
};

// Opciones válidas de tratamiento en Airtable (singleSelect)
const TRATAMIENTO_VALIDOS = new Set([
    'Consulta inicial', 'Botox', 'Relleno de labios', 'Limpieza facial',
    'Mesoterapia', 'Peeling químico', 'Lifting de pestañas', 'Microblading',
    'Depilación láser', 'Hilos tensores', 'Ácido hialurónico',
]);

// Alias para valores que el bot puede extraer pero no coinciden exactamente con Airtable
const TRATAMIENTO_ALIAS = {
    'relleno':              'Relleno de labios',
    'laser':                'Depilación láser',
    'láser':                'Depilación láser',
    'depilacion laser':     'Depilación láser',
    'depilacion láser':     'Depilación láser',
    'peeling':              'Peeling químico',
    'hidratacion facial':   'Limpieza facial',
    'hidratación facial':   'Limpieza facial',
    'hidratacion':          'Limpieza facial',
    'tratamiento manchas':  'Consulta inicial',
    'tratamiento acne':     'Consulta inicial',
    'tratamiento acné':     'Consulta inicial',
    'acido hialuronico':    'Ácido hialurónico',
};

function normalizeTratamiento(tratamiento) {
    if (!tratamiento) return null;
    const t = String(tratamiento);
    if (TRATAMIENTO_VALIDOS.has(t)) return t;
    const key = t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    return TRATAMIENTO_ALIAS[key] || t;
}

// Campos Select opcionales: si su valor no está en la lista de Airtable se eliminan al reintentar
// para que el resto del lead siempre se guarde.
const OPTIONAL_SELECT_FIELDS = ['✨ Tratamiento', '☀️ Preferencia horaria'];

function headers() {
    return {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
    };
}

function baseUrl(table) {
    return `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
}

function sanitizePhone(phone) {
    if (!phone || typeof phone !== 'string') return '';
    return phone.replace(/["']/g, '').trim();
}

function buildLeadFields(datos) {
    const fields = {};
    if (datos.nombre)             fields['👤 Nombre']              = String(datos.nombre);
    if (datos.telefono)           fields['📱 Teléfono']             = String(datos.telefono);
    if (datos.tratamiento)        fields['✨ Tratamiento']           = normalizeTratamiento(datos.tratamiento);
    if (datos.preferencia_horaria) {
        const pref = datos.preferencia_horaria;
        const periodo = typeof pref === 'object' ? pref.periodo : String(pref);
        fields['☀️ Preferencia horaria'] = PREFERENCIA_MAP[periodo] || 'Cualquier hora';
    }
    if (datos.fecha_cita)         fields['📅 Fecha de cita']        = String(datos.fecha_cita);
    if (datos.hora_cita)          fields['🕐 Hora de cita']         = String(datos.hora_cita);
    if (datos.estado_cita)        fields['🎯 Estado']               = ESTADO_MAP[datos.estado_cita] || datos.estado_cita;
    if (datos.appointment_id)     fields['🔖 Appointment_id']       = String(datos.appointment_id);
    if (datos.notas)              fields['📝 Notas']                = String(datos.notas).slice(0, 1000);
    if (datos.origen)             fields['📸 Origen']               = String(datos.origen);
    return fields;
}

async function findByPhone(telefono) {
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return null;
    try {
        const formula = `{📱 Teléfono} = "${sanitizePhone(telefono)}"`;
        const res = await axios.get(baseUrl(LEADS_TABLE), {
            headers: headers(),
            params: { filterByFormula: formula }
        });
        return res.data?.records?.[0] || null;
    } catch (e) {
        console.error('Airtable findByPhone error:', e.message);
        return null;
    }
}

async function _airtableUpsert(url, fields, existingId) {
    const doRequest = async (f) => existingId
        ? axios.patch(`${url}/${existingId}`, { fields: f }, { headers: headers() })
        : axios.post(url, { records: [{ fields: f }] }, { headers: headers() });

    let current = { ...fields };

    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            return await doRequest(current);
        } catch (e) {
            const errType = e.response?.data?.error?.type;
            const errMsg  = e.response?.data?.error?.message || '';

            if (errType === 'INVALID_MULTIPLE_CHOICE_OPTIONS') {
                const removed = OPTIONAL_SELECT_FIELDS.filter(k => k in current);
                if (removed.length > 0) {
                    removed.forEach(k => delete current[k]);
                    console.warn(`⚠️ Airtable: valor Select inválido (${removed.join(', ')}), reintentando sin ellos`);
                    continue;
                }
            }

            if (errType === 'UNKNOWN_FIELD_NAME') {
                const match = errMsg.match(/Unknown field name: "(.+?)"/);
                if (match && match[1] in current) {
                    console.warn(`⚠️ Airtable: campo desconocido "${match[1]}", reintentando sin él`);
                    delete current[match[1]];
                    continue;
                }
            }

            throw e;
        }
    }
    throw new Error('Airtable: máximo de reintentos alcanzado');
}

async function guardarLeadEnAirtable(datos) {
    if (airtableConfig.enabled === false) return null;
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
        console.warn('Credenciales Airtable no configuradas');
        return null;
    }
    if (!datos.telefono) {
        console.warn('Falta teléfono para guardar lead');
        return null;
    }

    try {
        const fields = buildLeadFields({ ...datos, origen: datos.origen || airtableConfig.origen || 'Instagram Ads' });
        // If we already have a record ID for this session, update that row.
        // Otherwise always CREATE a new row — never upsert by phone, so each new
        // conversation produces a separate Airtable record even for returning clients.
        const recordId = datos.airtableRecordId || null;
        const response = await _airtableUpsert(baseUrl(LEADS_TABLE), fields, recordId);
        if (!(response.status >= 200 && response.status < 300)) return null;
        if (recordId) return recordId;
        return response.data?.records?.[0]?.id || null;
    } catch (e) {
        console.error('Airtable guardarLead error:', e.response?.data || e.message);
        return null;
    }
}

async function updateLeadInAirtable(datos) {
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !datos.telefono) return false;
    try {
        const recordId = datos.airtableRecordId || (await findByPhone(datos.telefono))?.id;
        if (!recordId) return !!(await guardarLeadEnAirtable(datos));
        const fields = buildLeadFields(datos);
        const response = await _airtableUpsert(baseUrl(LEADS_TABLE), fields, recordId);
        return response.status >= 200 && response.status < 300;
    } catch (e) {
        console.error('Airtable updateLead error:', e.response?.data || e.message);
        return false;
    }
}

async function marcarCitaCompletada(telefono) {
    return updateLeadInAirtable({ telefono, estado_cita: 'completado' });
}

async function marcarResenaSent(recordId) {
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return false;
    try {
        await axios.patch(`${baseUrl(LEADS_TABLE)}/${recordId}`, {
            fields: { '⭐ Reseña enviada': true }
        }, { headers: headers() });
        return true;
    } catch (e) {
        console.error('Airtable marcarResenaSent error:', e.message);
        return false;
    }
}

async function getLeadsPendientesResena() {
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return [];
    try {
        const formula = `AND({🎯 Estado} = "${ESTADO_MAP['completado']}", {⭐ Reseña enviada} = FALSE())`;
        const res = await axios.get(baseUrl(LEADS_TABLE), {
            headers: headers(),
            params: { filterByFormula: formula }
        });
        return res.data?.records || [];
    } catch (e) {
        console.error('Airtable getLeadsPendientesResena error:', e.message);
        return [];
    }
}

async function getLeadsPendientesRecordatorio() {
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return [];
    try {
        const formula = `AND({🎯 Estado} = "${ESTADO_MAP['confirmado']}", {🔔 Recordatorio enviado} = FALSE())`;
        const res = await axios.get(baseUrl(LEADS_TABLE), {
            headers: headers(),
            params: { filterByFormula: formula }
        });
        return res.data?.records || [];
    } catch (e) {
        console.error('Airtable getLeadsPendientesRecordatorio error:', e.message);
        return [];
    }
}

async function marcarRecordatorioSent(recordId) {
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return false;
    try {
        await axios.patch(`${baseUrl(LEADS_TABLE)}/${recordId}`, {
            fields: { '🔔 Recordatorio enviado': true }
        }, { headers: headers() });
        return true;
    } catch (e) {
        console.error('Airtable marcarRecordatorioSent error:', e.message);
        return false;
    }
}

// ─── Tabla de Configuración ───────────────────────────────────────────────────

async function getConfigValue(clave) {
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return null;
    try {
        const formula = `{🔑 Clave} = "${clave}"`;
        const res = await axios.get(baseUrl(CONFIG_TABLE), {
            headers: headers(),
            params: { filterByFormula: formula }
        });
        const record = res.data?.records?.[0];
        if (!record) return null;
        const valor = record.fields['📋 Valor'];
        try { return JSON.parse(valor); } catch { return valor; }
    } catch (e) {
        console.error(`Airtable getConfigValue(${clave}) error:`, e.message);
        return null;
    }
}

async function setConfigValue(clave, valor) {
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return false;
    try {
        const formula = `{🔑 Clave} = "${clave}"`;
        const res = await axios.get(baseUrl(CONFIG_TABLE), {
            headers: headers(),
            params: { filterByFormula: formula }
        });
        const existing = res.data?.records?.[0];
        const valorStr = typeof valor === 'string' ? valor : JSON.stringify(valor);

        if (existing) {
            await axios.patch(`${baseUrl(CONFIG_TABLE)}/${existing.id}`, {
                fields: { '🔑 Clave': clave, '📋 Valor': valorStr }
            }, { headers: headers() });
        } else {
            await axios.post(baseUrl(CONFIG_TABLE), {
                records: [{ fields: { '🔑 Clave': clave, '📋 Valor': valorStr } }]
            }, { headers: headers() });
        }
        return true;
    } catch (e) {
        console.error(`Airtable setConfigValue(${clave}) error:`, e.message);
        return false;
    }
}

module.exports = {
    guardarLeadEnAirtable,
    updateLeadInAirtable,
    findByPhone,
    marcarCitaCompletada,
    marcarResenaSent,
    getLeadsPendientesResena,
    getLeadsPendientesRecordatorio,
    marcarRecordatorioSent,
    getConfigValue,
    setConfigValue
};
