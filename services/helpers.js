const config = require('../config.json');

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

// ─── Detección de intención ───────────────────────────────────────────────────

function detectIntent(text) {
    const t = normalizeText(text);

    if (t.includes('cancelar') || t.includes('anular') || t.includes('quiero cancelar')) return 'cancelar';
    if (t.includes('cambiar') || t.includes('mover') || t.includes('reagendar') || t.includes('cambio de cita')) return 'cambiar';
    if (t.includes('precio') || t.includes('cuanto') || t.includes('cuesta') || t.includes('coste')) return 'precio';
    if (t.includes('quiero') || t.includes('necesito') || t.includes('me interesa') || t.includes('cita')) return 'cita';
    if (t.includes('info') || t.includes('como funciona') || t.includes('en que consiste') || t.includes('que es')) return 'info';
    if (t.includes('caro') || t.includes('mucho dinero') || t.includes('me lo pienso') || t.includes('no estoy seguro')) return 'objecion';
    if (t.includes('mañana') || t.includes('tarde') || t.includes('esta semana') || t.includes('la semana')) return 'preferencia_horaria';

    return 'general';
}

function detectPostLeadIntent(text) {
    if (!text) return 'small_talk';
    const t = normalizeText(text);

    const serviceKeywords = [
        'tratamiento', 'cita', 'precio', 'coste', 'botox', 'relleno', 'laser',
        'tiempo', 'tarda', 'cuando', 'plazo', 'resultado', 'efecto', 'recuperacion',
        'urgente', 'prisa', 'cancelar', 'cambiar', 'reagendar'
    ];
    if (serviceKeywords.some(k => t.includes(k))) return 'servicio';

    const smallTalk = ['hola', 'buenas', 'ok', 'vale', 'perfecto', 'genial', 'bien', 'gracias',
        'adios', 'hasta luego', 'si', 'no', 'claro', 'entendido', 'de acuerdo'];
    if (smallTalk.some(k => t.includes(k))) return 'small_talk';

    return 'small_talk';
}

// ─── Extracción de preferencia horaria ───────────────────────────────────────

function extractPreferenciaHoraria(text) {
    const t = normalizeText(text);
    const pref = {};

    if (t.includes('mañana') || t.includes('manana') || t.includes('por la mañana')) pref.periodo = 'mañana';
    if (t.includes('tarde') || t.includes('por la tarde')) pref.periodo = 'tarde';
    if (t.includes('esta semana') || t.includes('hoy') || t.includes('esta misma semana')) pref.semana = 'esta';
    if (t.includes('semana que viene') || t.includes('la semana siguiente') || t.includes('proxima semana') ||
        t.includes('semana proxima') || t.includes('siguiente semana') || t.includes('la proxima') ||
        t.includes('la siguiente') || t.match(/\bsiguiente\b/)) pref.semana = 'siguiente';
    if (t.includes('manana') && !pref.semana) pref.semana = 'esta'; // "mañana" como día siguiente

    return Object.keys(pref).length > 0 ? pref : null;
}

// ─── Extracción de tratamiento ────────────────────────────────────────────────

function extractTratamiento(text) {
    const t = normalizeText(text);
    const servicios = config.servicios || [];

    for (const servicio of servicios) {
        const nombre = normalizeText(servicio.nombre);
        if (t.includes(nombre)) return servicio.nombre;
    }

    // Patrones comunes de clínica estética
    if (t.includes('botox') || t.includes('toxico')) return 'Botox';
    if (t.includes('relleno') && t.includes('labio')) return 'Relleno de labios';
    if (t.includes('relleno')) return 'Relleno';
    if (t.includes('limpieza') && t.includes('facial')) return 'Limpieza facial';
    if (t.includes('mesoter')) return 'Mesoterapia';
    if (t.includes('laser') || t.includes('láser')) return 'Láser';
    if (t.includes('hidratacion') || t.includes('hidratación')) return 'Hidratación facial';
    if (t.includes('peeling')) return 'Peeling';
    if (t.includes('manchas')) return 'Tratamiento manchas';
    if (t.includes('acne') || t.includes('acné')) return 'Tratamiento acné';

    return null;
}

// ─── Extracción de teléfono ───────────────────────────────────────────────────

function extractTelefono(text) {
    if (!text) return null;
    const digits = text.replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 12) return digits;
    return null;
}

function isAffirmative(text) {
    const t = normalizeText(text);
    return ['si', 'sí', 'este', 'mismo', 'vale', 'correcto', 'perfecto', 'ok',
        'de acuerdo', 'confirmo', 'confirmado', 'genial', 'claro'].some(w => t.includes(w));
}

function isNegative(text) {
    const t = normalizeText(text);
    return ['no', 'nope', 'no me va', 'no puedo', 'no me viene', 'otro',
        'otra hora', 'otro dia', 'diferente', 'cambia'].some(w => t.includes(w));
}

// ─── Validación de nombre ─────────────────────────────────────────────────────

function isValidName(name) {
    if (!name || typeof name !== 'string') return false;
    const cleaned = name.replace(/^(soy|me llamo|mi nombre es|es|llámame)\s*/i, '').trim();
    const lower = cleaned.toLowerCase();

    const invalidWords = ['hola', 'buenas', 'ok', 'vale', 'gracias', 'adios', 'si', 'sí', 'no',
        'bien', 'genial', 'perfecto', 'entendido', 'tratamiento', 'cita', 'botox', 'laser',
        'recomiendame', 'ayudame', 'dime', 'explicame', 'cuentame', 'informame',
        'quiero', 'necesito', 'tengo', 'puedo', 'podria', 'gustaria',
        'manana', 'mañana', 'tarde', 'semana'];
    if (invalidWords.includes(lower)) return false;
    if (cleaned.length < 2 || cleaned.length > 40) return false;
    if (!/^[a-zA-ZáéíóúñüÁÉÍÓÚÑÜ\s]+$/.test(cleaned)) return false;

    const letterCount = cleaned.replace(/[^a-zA-ZáéíóúñüÁÉÍÓÚÑÜ]/g, '').length;
    if (letterCount < 2) return false;

    const garbagePatterns = [/^[a-z]{1,2}$/, /^([a-z])\1+$/, /^[a-z]{15,}$/];
    if (garbagePatterns.some(p => p.test(lower))) return false;

    // Rechazar verbos con clítico "-me" (ej: "recomiéndame", "ayúdame")
    if (lower.length > 8 && lower.endsWith('me')) return false;

    return /[aeiouáéíóú]/i.test(cleaned);
}

// ─── Campos faltantes ─────────────────────────────────────────────────────────

function getMissingFields(partialData) {
    const missing = [];
    const required = ['nombre', 'tratamiento'];
    for (const campo of required) {
        const val = partialData?.[campo];
        if (!val || val === '' || (typeof val === 'string' && val.toLowerCase() === 'desconocido')) {
            missing.push(campo);
        }
    }
    return missing;
}

// ─── Extracción rápida combinada ──────────────────────────────────────────────

function extractQuickData(text, partialData = {}) {
    const result = { ...partialData };

    if (!result.telefono || result.telefono === 'desconocido') {
        const tel = extractTelefono(text);
        if (tel) result.telefono = tel;
    }

    // Siempre sobreescribir tratamiento si encontramos uno válido en el catálogo
    const trat = extractTratamiento(text);
    if (trat) result.tratamiento = trat;

    // Siempre intentar extraer preferencia horaria (permite actualizarla al reagendar)
    // Mergeamos con la existente para no perder info (ej: semana ya definida + ahora añade periodo)
    const pref = extractPreferenciaHoraria(text);
    if (pref) result.preferencia_horaria = { ...(result.preferencia_horaria || {}), ...pref };

    // Nombre: solo si el usuario lo dice explícitamente
    if (!result.nombre || result.nombre === 'desconocido') {
        const lower = normalizeText(text);
        const namePatterns = ['soy ', 'me llamo ', 'mi nombre es ', 'llámame '];
        for (const pattern of namePatterns) {
            const idx = lower.indexOf(pattern);
            if (idx !== -1) {
                const afterPattern = text.substring(idx + pattern.length).trim();
                const words = afterPattern.split(/\s+/).slice(0, 2).join(' ');
                if (isValidName(words)) { result.nombre = words; break; }
            }
        }
        // Mensaje de una sola palabra que parece nombre
        if (!result.nombre && text.trim().split(/\s+/).length === 1) {
            const word = text.trim();
            if (isValidName(word) && word.length >= 3) result.nombre = word;
        }
    }

    return result;
}

module.exports = {
    normalizeText,
    detectIntent,
    detectPostLeadIntent,
    getMissingFields,
    extractQuickData,
    extractTelefono,
    extractTratamiento,
    extractPreferenciaHoraria,
    isAffirmative,
    isNegative,
    isValidName
};
