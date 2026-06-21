function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

// ─── Detección de intención ───────────────────────────────────────────────────

function isBizumDone(text) {
    const t = normalizeText(text);
    const frases = [
        'hecho', 'ya esta', 'ya está', 'listo', 'ya lo he hecho', 'ya lo hice',
        'enviado', 'ya lo envie', 'ya lo envié', 'ya envie', 'ya envié',
        'pagado', 'ya pague', 'ya pagué', 'transferido', 'realizado', 'hecho ya'
    ];
    return frases.some(f => t === normalizeText(f) || t.includes(normalizeText(f)));
}

function detectIntent(text) {
    const t = normalizeText(text);

    if (t.includes('cancelar') || t.includes('anular') || t.includes('quiero cancelar')) return 'cancelar';
    if (t.includes('cambiar') || t.includes('mover') || t.includes('reagendar') || t.includes('cambio de reserva')) return 'cambiar';
    if (isBizumDone(text)) return 'bizum_hecho';
    if (t.includes('horario') || t.includes('a que hora abr') || t.includes('a que hora cierr') || t.includes('cuando abr') || t.includes('cuando cerr')) return 'horarios';
    if (t.includes('carta') || t.includes('menu') || t.includes('menú') || t.includes('platos') || t.includes('especialidad')) return 'carta';
    if (t.includes('parking') || t.includes('aparcar') || t.includes('aparcamiento') || t.includes('garaje')) return 'parking';
    if (t.includes('alerg') || t.includes('intoleran') || t.includes('celiac') || t.includes('gluten') || t.includes('vegano') || t.includes('vegetarian')) return 'alergias';
    if (t.includes('mesa') || t.includes('reserva') || t.includes('reservar') || t.includes('quiero')) return 'reserva';
    if (t.includes('comida') || t.includes('cena') || t.includes('comer') || t.includes('cenar') || t.includes('esta semana') || t.includes('la semana')) return 'preferencia_horaria';

    return 'general';
}

// ─── Extracción de preferencia horaria (turno de comida/cena) ────────────────

function extractPreferenciaHoraria(text) {
    const t = normalizeText(text);
    const pref = {};

    if (t.includes('comer') || t.includes('comida') || t.includes('almuerzo') || t.includes('mediodia') || t.includes('mediodía')) pref.periodo = 'comida';
    if (t.includes('cenar') || t.includes('cena') || t.includes('noche')) pref.periodo = 'cena';

    if (t.includes('esta semana') || t.includes('hoy') || t.includes('esta misma semana')) pref.semana = 'esta';
    if (t.includes('semana que viene') || t.includes('la semana siguiente') || t.includes('proxima semana') ||
        t.includes('semana proxima') || t.includes('siguiente semana') || t.includes('la proxima') ||
        t.includes('la siguiente') || t.match(/\bsiguiente\b/)) pref.semana = 'siguiente';
    if (t.includes('manana') && !pref.semana) pref.semana = 'esta'; // "mañana" como día siguiente

    return Object.keys(pref).length > 0 ? pref : null;
}

// ─── Extracción de número de personas ────────────────────────────────────────

const NUMEROS_TEXTO = {
    uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
    siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12
};

function extractPersonas(text) {
    const t = normalizeText(text);

    let m = t.match(/(?:para|somos|seremos)\s+(\d{1,2})\b/);
    if (!m) m = t.match(/(\d{1,2})\s*(?:personas?|comensales?|adultos?|pax)/);
    if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 1 && n <= 30) return n;
    }

    for (const [palabra, numero] of Object.entries(NUMEROS_TEXTO)) {
        if (new RegExp(`\\b${palabra}\\b`).test(t) && (t.includes('persona') || t.includes('somos') || t.includes('mesa'))) {
            return numero;
        }
    }

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
        'bien', 'genial', 'perfecto', 'entendido', 'reserva', 'mesa', 'personas', 'comida', 'cena',
        'recomiendame', 'ayudame', 'dime', 'explicame', 'cuentame', 'informame',
        'quiero', 'necesito', 'tengo', 'puedo', 'podria', 'gustaria',
        'manana', 'mañana', 'tarde', 'noche', 'semana'];
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
    const required = ['nombre', 'personas'];
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

    const personas = extractPersonas(text);
    if (personas) result.personas = personas;

    // Siempre intentar extraer preferencia horaria (permite actualizarla al reagendar)
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

// ─── Salon-specific: service extraction ─────────────────────────────────────

function extractServiceFromText(text, servicesCatalog) {
    if (!text || !servicesCatalog?.length) return null;
    const t = normalizeText(text);

    let bestMatch = null;
    let bestLen = 0;

    for (const svc of servicesCatalog) {
        const svcName = normalizeText(svc.nombre);
        const svcCat = normalizeText(svc.categoria);

        if (t.includes(svcName) && svcName.length > bestLen) {
            bestMatch = svc;
            bestLen = svcName.length;
        }
        if (t.includes(svcCat) && svcCat.length > bestLen) {
            bestMatch = svc;
            bestLen = svcCat.length;
        }
    }

    // Fuzzy: common keywords
    if (!bestMatch) {
        const keywordMap = [
            { keywords: ['corte', 'cortar', 'corto', 'corta', 'haircut', 'cut'], categoria: 'Cortes' },
            { keywords: ['color', 'tinte', 'teñir', 'raiz', 'raíz', 'dye'], categoria: 'Color Premium' },
            { keywords: ['mecha', 'mechas', 'highlights', 'balayage'], categoria: 'Mechas Airtouch' },
            { keywords: ['manicura', 'manicure', 'uñas', 'nails', 'pedicura', 'pedicure'], categoria: 'Manicura/Pedicura' },
            { keywords: ['masaje', 'massage', 'spa', 'relajante', 'relax'], categoria: 'Masajes y SPA' },
            { keywords: ['alisado', 'alisar', 'straighten', 'keratin'], categoria: 'Alisado vegano' },
            { keywords: ['peinar', 'peinado', 'secar', 'blow', 'brushing'], categoria: 'Lavar y peinar' },
            { keywords: ['tricolog', 'diagnostico', 'capilar', 'perdida', 'caida', 'hair loss'], categoria: 'Diagnóstico Capilar' },
            { keywords: ['dermapen'], categoria: 'Dermapen Hair Loss' },
            { keywords: ['k18', 'reconstruc', 'repair', 'pro-miracle', 'pro miracle'], categoria: 'Reconstrucción' },
            { keywords: ['exfolia', 'peeling', 'pilling', 'cuero cabelludo', 'scalp'], categoria: 'Exfoliación cabeza' },
            { keywords: ['brillo', 'glow', 'shine'], categoria: 'Brillo Glow' },
            { keywords: ['matiz', 'toner', 'violeta'], categoria: 'Matiz mujer' },
            { keywords: ['tratamiento', 'orising', 'hidrata'], categoria: 'Tratamiento Orgánico' },
        ];

        for (const { keywords, categoria } of keywordMap) {
            if (keywords.some(kw => t.includes(normalizeText(kw)))) {
                bestMatch = servicesCatalog.find(s => normalizeText(s.categoria) === normalizeText(categoria));
                if (bestMatch) break;
            }
        }
    }

    return bestMatch;
}

function extractStylistFromText(text, teamList) {
    if (!text || !teamList?.length) return null;
    const t = normalizeText(text);

    for (const member of teamList) {
        if (t.includes(normalizeText(member.nombre || member.name))) {
            return member;
        }
    }
    return null;
}

function getMissingFieldsSante(partialData) {
    const missing = [];
    if (!partialData?.nombre || partialData.nombre === 'desconocido') missing.push('nombre');
    return missing;
}

function extractQuickDataSante(text, partialData = {}, servicesCatalog = [], teamList = []) {
    const result = { ...partialData };

    // Name extraction (reuse existing logic)
    if (!result.nombre || result.nombre === 'desconocido') {
        const lower = normalizeText(text);
        const namePatterns = ['soy ', 'me llamo ', 'mi nombre es ', 'my name is ', 'i am ', 'i\'m '];
        for (const pattern of namePatterns) {
            const idx = lower.indexOf(pattern);
            if (idx !== -1) {
                const afterPattern = text.substring(idx + pattern.length).trim();
                const words = afterPattern.split(/\s+/).slice(0, 2).join(' ');
                if (isValidName(words)) { result.nombre = words; break; }
            }
        }
        if (!result.nombre && text.trim().split(/\s+/).length === 1) {
            const word = text.trim();
            if (isValidName(word) && word.length >= 3) result.nombre = word;
        }
    }

    // Time preference (semana: esta/siguiente). El periodo comida/cena del restaurante no
    // aplica al salón, así que lo descartamos y detectamos mañana/tarde, que es lo que el
    // motor de huecos (calendar-sante) sabe filtrar.
    const pref = extractPreferenciaHoraria(text);
    if (pref) {
        const { periodo, ...rest } = pref; // periodo de restaurante (comida/cena) no se usa aquí
        if (Object.keys(rest).length) result.preferencia_horaria = { ...(result.preferencia_horaria || {}), ...rest };
    }

    // Periodo del día (solo expresiones inequívocas; "mañana" a secas = día siguiente, no franja).
    const t = normalizeText(text);
    if (/\b(por la mañana|por la manana|en la mañana|en la manana|de mañana|de manana|la mañana|la manana|morning|утром|вранці)\b/.test(t)) {
        result.preferencia_horaria = { ...(result.preferencia_horaria || {}), periodo: 'mañana' };
    } else if (/\b(por la tarde|en la tarde|de tarde|la tarde|afternoon|evening|днем|днём|вдень|ввечері)\b/.test(t)) {
        result.preferencia_horaria = { ...(result.preferencia_horaria || {}), periodo: 'tarde' };
    }

    return result;
}

module.exports = {
    normalizeText,
    detectIntent,
    isBizumDone,
    getMissingFields,
    extractQuickData,
    extractTelefono,
    extractPersonas,
    extractPreferenciaHoraria,
    isAffirmative,
    isNegative,
    isValidName,
    // Salon-specific
    extractServiceFromText,
    extractStylistFromText,
    getMissingFieldsSante,
    extractQuickDataSante,
};
