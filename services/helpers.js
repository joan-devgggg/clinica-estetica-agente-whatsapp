function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

// ─── Detección de idioma (heurística, salón) ────────────────────────────────
// Defensa para BUG 4: fija el idioma a partir del texto de la clienta ANTES de llamar
// al LLM, para que los mensajes de fallback/límite salgan en su idioma aunque OpenAI
// falle o tarde. El LLM sigue siendo la fuente autoritativa (idioma_detectado) y puede
// corregir esto en el mismo turno. Devuelve 'es'|'en'|'ru'|'uk' o null si no es seguro.
function detectLanguage(text) {
    if (!text || typeof text !== 'string') return null;
    const raw = text.trim();
    if (!raw) return null;

    // Cirílico → ucraniano si tiene letras propias del ucraniano, si no ruso.
    if (/[а-яёіїєґ]/i.test(raw)) {
        if (/[іїєґ]/i.test(raw)) return 'uk';
        return 'ru';
    }

    const t = raw.toLowerCase();
    // Marcadores claros de español (signos, ñ, palabras frecuentes).
    if (/[ñ¿¡]/.test(raw)) return 'es';
    const esWords = /\b(hola|buenas|quiero|quería|cita|gracias|por favor|cuánto|cuanto|para|reservar|reserva|qué|que tal|cómo|como estas|necesito|tengo|disponible|mañana|hoy|día|dia|tarde)\b/;
    const enWords = /\b(hi|hello|hey|i'?d|i'?m|i want|i would|i need|please|thanks|thank you|appointment|book|booking|available|tomorrow|today|morning|afternoon|how much|can i|could i|would like|my name)\b/;
    const hasEs = esWords.test(t);
    const hasEn = enWords.test(t);
    if (hasEn && !hasEs) return 'en';
    if (hasEs && !hasEn) return 'es';
    return null; // ambiguo (p.ej. solo un nombre): que decida el LLM
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
        'de acuerdo', 'confirmo', 'confirmado', 'genial', 'claro',
        'dale', 'venga', 'listo', 'bueno', 'adelante', 'eso', 'ese', 'esa',
        'me viene bien', 'me va bien', 'quiero ese',
        'that works', 'sounds good', 'да', 'давай', 'так'].some(w => t.includes(w));
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

function isServiceName(name, servicesCatalog) {
    if (!name || !servicesCatalog?.length) return false;
    const norm = normalizeText(name);
    if (norm.length < 3) return false;
    for (const svc of servicesCatalog) {
        const svcName = normalizeText(svc.nombre);
        const svcCat = normalizeText(svc.categoria);
        if (norm === svcName || norm === svcCat) return true;
        if (svcName.split(/\s+/).some(w => w === norm && w.length >= 3)) return true;
        if (svcCat.split(/\s+/).some(w => w === norm && w.length >= 3)) return true;
    }
    return false;
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

// Palabras vacías (normalizadas, sin acentos) que NO deben puntuar al emparejar la
// variante concreta de un servicio dentro de una categoría. Incluye artículos y
// preposiciones frecuentes; "una" colisiona con "uña" tras quitar acentos.
const SERVICE_MATCH_STOPWORDS = new Set([
    'una', 'uno', 'con', 'del', 'los', 'las', 'para', 'por', 'que', 'mas',
    'sus', 'tus', 'mis', 'este', 'esta', 'esto', 'esa', 'ese',
]);

function extractServiceFromText(text, servicesCatalog) {
    if (!text || !servicesCatalog?.length) return null;
    const t = normalizeText(text);

    let bestMatch = null;
    let bestLen = 0;

    // Pre-compute: services sharing the same normalized name (for disambiguation)
    const nameGroups = {};
    for (const svc of servicesCatalog) {
        const key = normalizeText(svc.nombre);
        if (!nameGroups[key]) nameGroups[key] = [];
        nameGroups[key].push(svc);
    }

    // Pre-compute: how many services each category has
    const catCounts = {};
    for (const svc of servicesCatalog) {
        const key = normalizeText(svc.categoria);
        catCounts[key] = (catCounts[key] || 0) + 1;
    }

    // Pass 1a: exact service name match
    for (const svc of servicesCatalog) {
        const svcName = normalizeText(svc.nombre);
        if (!t.includes(svcName) || svcName.length <= bestLen) continue;

        if (nameGroups[svcName].length === 1) {
            bestMatch = svc;
            bestLen = svcName.length;
        } else {
            // Shared name across categories (e.g. "Largo 1" in Alisado/Mechas/Deco) —
            // pick the one whose category words also appear in the text.
            let bestCatScore = 0;
            let bestCatSvc = null;
            for (const candidate of nameGroups[svcName]) {
                const catWords = normalizeText(candidate.categoria).split(/\s+/);
                const score = catWords.filter(w => w.length >= 4 && t.includes(w)).length;
                if (score > bestCatScore) {
                    bestCatScore = score;
                    bestCatSvc = candidate;
                }
            }
            if (bestCatScore > 0) {
                bestMatch = bestCatSvc;
                bestLen = svcName.length;
            }
        }
    }

    // Pass 1b: category name match — ONLY for single-service categories.
    // Multi-service categories (e.g. "Alisado vegano" with Largo 1/2/3) are ambiguous
    // and must NOT pick the first service arbitrarily.
    if (!bestMatch) {
        for (const svc of servicesCatalog) {
            const svcCat = normalizeText(svc.categoria);
            if (t.includes(svcCat) && svcCat.length > bestLen && catCounts[svcCat] === 1) {
                bestMatch = svc;
                bestLen = svcCat.length;
            }
        }
    }

    // Fuzzy: common keywords
    if (!bestMatch) {
        const keywordMap = [
            { keywords: ['corte', 'cortar', 'corto', 'corta', 'haircut', 'cut'], categoria: 'Cortes' },
            { keywords: ['color', 'tinte', 'teñir', 'raiz', 'raíz', 'dye'], categoria: 'Color Premium' },
            { keywords: ['contouring'], categoria: 'Mechas Contouring' },
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
                const catNorm = normalizeText(categoria);
                const inCat = servicesCatalog.filter(s => normalizeText(s.categoria) === catNorm);
                if (!inCat.length) continue;

                // Buscar el servicio CONCRETO cuyas palabras aparezcan en el texto.
                // Excluimos stopwords y dígitos: tras quitar acentos, "una" (artículo)
                // colisionaba con "uña" → matcheaba "Reparación 1 uña" para "quiero una
                // manicura". Solo cuentan palabras distintivas del nombre del servicio.
                let best = null;
                let bestScore = 0;
                let tiedCount = 0;
                for (const svc of inCat) {
                    const nameWords = normalizeText(svc.nombre).split(/\s+/);
                    const score = nameWords.filter(w =>
                        w.length > 2 && !SERVICE_MATCH_STOPWORDS.has(w) && !/^\d+$/.test(w) && t.includes(w)
                    ).length;
                    if (score > bestScore) {
                        bestScore = score;
                        best = svc;
                        tiedCount = 1;
                    } else if (score === bestScore && score > 0) {
                        tiedCount++;
                    }
                }
                if (bestScore > 0 && tiedCount === 1) { bestMatch = best; break; }
                if (bestScore > 0 && tiedCount > 1) {
                    // Multiple variants scored equally (e.g. "color completo" matches
                    // "Color completo largo 1/2/3" with same score). Try "largo N" number.
                    const numMatch = t.match(/\blargo\s+(\d)\b/);
                    if (numMatch) {
                        const byNum = inCat.find(s => normalizeText(s.nombre).includes(`largo ${numMatch[1]}`));
                        if (byNum) { bestMatch = byNum; break; }
                    }
                    break; // ambiguous — return null
                }
                if (inCat.length === 1) { bestMatch = inCat[0]; break; }
                // categoría ambigua sin variante nombrada → seguimos sin match (null)
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

// ─── Segunda reserva en la misma conversación (Sante) ───────────────────────
// Tras confirmar una cita, la clienta puede querer reservar OTRA (para ella o para
// un acompañante). Detectamos esa intención para reiniciar el flujo de reserva.

// Palabras que indican que la cita es para OTRA persona, no para el titular del WA.
const GUEST_NOT_NAMES = ['amigo', 'amiga', 'madre', 'padre', 'hija', 'hijo', 'hermana',
    'hermano', 'pareja', 'marido', 'mujer', 'novia', 'novio', 'prima', 'primo', 'persona',
    'otra', 'otro', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
    'manana', 'tarde', 'noche', 'hoy', 'semana', 'dia', 'cita', 'reserva', 'corte', 'color'];

// La cita es para un acompañante ("para mi amiga", "para mi madre", "para otra persona").
function detectGuestBooking(text) {
    const t = normalizeText(text);
    const markers = [
        'para un amigo', 'para una amiga', 'para mi amigo', 'para mi amiga',
        'para mi madre', 'para mi padre', 'para mi hija', 'para mi hijo',
        'para mi hermana', 'para mi hermano', 'para mi pareja', 'para mi marido',
        'para mi mujer', 'para mi novia', 'para mi novio', 'para mi prima', 'para mi primo',
        'para otra persona', 'para una persona', 'es para otra', 'no es para mi',
        'for a friend', 'for my friend', 'for my mother', 'for my sister', 'for my daughter',
        'for someone', 'for another person',
        'для друга', 'для подруги', 'для мамы', 'для сестры',
    ];
    return markers.some(p => t.includes(normalizeText(p)));
}

// La clienta pide OTRA cita. Solo debe consultarse cuando ya hay una confirmada en sesión.
// Coincidencia por frases (no por palabras sueltas) para no confundir "otra duda sobre
// mi cita" con una segunda reserva.
function wantsAnotherBooking(text) {
    const t = normalizeText(text);
    if (detectGuestBooking(text)) return true;
    const phrases = [
        'otra cita', 'otra reserva', 'una cita mas', 'una reserva mas', 'otra mas',
        'segunda cita', 'segunda reserva', 'reservar otra', 'reservar tambien',
        'tambien quiero reservar', 'tambien reservar', 'tambien una cita',
        'tambien quiero una cita', 'quiero otra', 'reservar para', 'reservame otra',
        'apuntar otra', 'agendar otra', 'pedir otra cita',
        'another appointment', 'another booking', 'book another', 'one more appointment',
        'also book', 'second appointment', 'second booking',
        'еще одну запись', 'ещё одну запись', 'ще один запис',
    ];
    return phrases.some(p => t.includes(normalizeText(p)));
}

// Intenta extraer el nombre del acompañante ("para mi amiga María", "es para Ana").
// Conservador: descarta palabras de relación/tiempo para no tomarlas por nombre.
function extractGuestName(text) {
    if (!text) return null;
    const patterns = [
        /para\s+(?:mi|un|una|el|la)\s+\w+[\s,]+([a-záéíóúñ]{2,})/i,
        /es para\s+([a-záéíóúñ]{2,})/i,
        /se llama\s+([a-záéíóúñ]{2,})/i,
        /^para\s+([a-záéíóúñ]{2,})\s*$/i,
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m && m[1]) {
            const cand = m[1].trim();
            if (GUEST_NOT_NAMES.includes(normalizeText(cand))) continue;
            if (isValidName(cand)) return cand.charAt(0).toUpperCase() + cand.slice(1).toLowerCase();
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

    // Día de la semana ("el miércoles") y fecha concreta ("el 24", "24 de junio").
    // El motor (calendar-sante) filtra por diaSemana (0=Lunes) o por fecha (YYYY-MM-DD).
    const datePref = extractDatePreferenceSante(t);
    if (datePref) {
        result.preferencia_horaria = { ...(result.preferencia_horaria || {}), ...datePref };
    }

    return result;
}

// Día de la semana → 0=Lunes…6=Domingo (misma convención que stylist_schedules).
const DIA_SEMANA_MAP = {
    lunes: 0, monday: 0, martes: 1, tuesday: 1, miercoles: 2, wednesday: 2,
    jueves: 3, thursday: 3, viernes: 4, friday: 4, sabado: 5, saturday: 5,
    domingo: 6, sunday: 6,
};
const MESES_MAP = {
    enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6,
    agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
};

// Extrae preferencia de FECHA del salón a partir de texto ya normalizado (sin tildes).
// Devuelve { diaSemana } y/o { fecha: 'YYYY-MM-DD' }, o null. Para no chocar con la
// selección de hueco por número ("el 2" = opción 2), solo tomamos día del mes suelto
// si es >= 10; los días 1-9 requieren mes explícito ("3 de julio").
function extractDatePreferenceSante(t) {
    const pref = {};

    for (const [nombre, idx] of Object.entries(DIA_SEMANA_MAP)) {
        if (new RegExp(`\\b${nombre}\\b`).test(t)) { pref.diaSemana = idx; break; }
    }

    // "24 de junio" / "3 de julio" — día + mes explícito.
    const conMes = t.match(/\b(\d{1,2})\s+de\s+([a-z]+)\b/);
    if (conMes && MESES_MAP[conMes[2]] !== undefined) {
        const dom = parseInt(conMes[1], 10);
        const f = resolveUpcomingDate(dom, MESES_MAP[conMes[2]]);
        if (f) pref.fecha = f;
    } else {
        // "el 24" — día del mes suelto, solo >= 10 para no confundir con opciones 1-9.
        const soloDia = t.match(/\bel\s+(\d{1,2})\b/);
        if (soloDia) {
            const dom = parseInt(soloDia[1], 10);
            if (dom >= 10 && dom <= 31) {
                const f = resolveUpcomingDate(dom, null);
                if (f) pref.fecha = f;
            }
        }
    }

    return Object.keys(pref).length ? pref : null;
}

// Resuelve un día del mes (y mes opcional) a la próxima fecha YYYY-MM-DD a partir de hoy.
function resolveUpcomingDate(dom, month) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (let i = 0; i < 366; i++) {
        const d = new Date(now);
        d.setDate(now.getDate() + i);
        if (d.getDate() !== dom) continue;
        if (month !== null && d.getMonth() !== month) continue;
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${dd}`;
    }
    return null;
}

// ─── Confirmación de cita (salón): extras deterministas ──────────────────────
// BUG2/BUG3: tras confirmar una cita SIEMPRE garantizamos en el mensaje (a) una
// sugerencia de servicio complementario si aplica (upselling), (b) la dirección del
// salón y (c) la política de cancelación de 48h. Se hace de forma determinista (no
// dependemos del LLM) y multi-idioma (es/en/ru/uk) para que NUNCA falte.

// Devuelve la primera sugerencia de upselling cuyo "servicio" case con el servicio
// elegido (por nombre o categoría), o null si no hay regla aplicable.
function matchUpsellSuggestion(selectedService, upsellingRules) {
    if (!selectedService || !Array.isArray(upsellingRules) || !upsellingRules.length) return null;
    const name = normalizeText(selectedService.nombre);
    const cat = normalizeText(selectedService.categoria);
    for (const rule of upsellingRules) {
        const r = normalizeText(rule.servicio);
        if (!r) continue;
        if (name.includes(r) || cat.includes(r) || r.includes(name)) {
            const sug = (rule.sugerencias || [])[0];
            if (sug) return sug;
        }
    }
    return null;
}

// Construye el bloque de texto que se añade al mensaje de confirmación.
function _serviceEmoji(categoria) {
    const cat = normalizeText(categoria || '');
    if (['manicura', 'pedicura', 'unas'].some(k => cat.includes(k))) return '💅';
    if (['masaje', 'spa', 'relax'].some(k => cat.includes(k))) return '💆';
    return '✂️';
}

function _formatFechaHora(fecha, hora, lang) {
    const d = new Date(`${fecha}T${hora}:00`);
    if (isNaN(d)) return `${fecha} ${hora}`;
    const locale = { es: 'es-ES', en: 'en-GB', ru: 'ru-RU', uk: 'uk-UA' }[lang] || 'es-ES';
    const dayStr = d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Madrid' });
    const cap = (dayStr.charAt(0).toUpperCase() + dayStr.slice(1)).replace(/,\s*/, ' ');
    const T = { es: 'a las', en: 'at', ru: 'в', uk: 'о' };
    return `${cap} ${T[lang] || T.es} ${hora}`;
}

function buildSanteConfirmationMessage({ nombre, fecha, hora, servicio, stylistNombre, precio, duracion, categoria, direccion, language, upsellSuggestion } = {}) {
    const lang = ['es', 'en', 'ru', 'uk'].includes(language) ? language : 'es';
    const dir = (direccion || '').trim();
    const emoji = _serviceEmoji(categoria);
    const fechaStr = _formatFechaHora(fecha, hora, lang);
    const svcLine = stylistNombre ? `${servicio} con ${stylistNombre}` : servicio;
    const priceLine = (precio != null && duracion != null)
        ? `${precio}€ · ${duracion} minutos`
        : precio != null ? `${precio}€` : duracion != null ? `${duracion} minutos` : null;

    const T = {
        es: {
            header: n => `✅ Perfecto, ${n}. Cita reservada:`,
            cancel: '🙏 Si necesitas cancelar o cambiar, avísanos con 48h de antelación.',
            more: '¿Algo más en lo que pueda ayudarte?',
            upsell: s => `Por cierto, mientras estás aquí podrías aprovechar para ${s.toLowerCase()}. ¿Te lo añado?`,
        },
        en: {
            header: n => `✅ Perfect, ${n}. Appointment booked:`,
            cancel: '🙏 If you need to cancel or change, please let us know 48h in advance.',
            more: 'Anything else I can help you with?',
            upsell: s => `By the way, while you're here you could also add ${s.toLowerCase()}. Want me to include it?`,
        },
        ru: {
            header: n => `✅ Отлично, ${n}. Запись подтверждена:`,
            cancel: '🙏 Если нужно отменить или изменить, предупредите нас за 48ч.',
            more: 'Могу ещё чем-то помочь?',
            upsell: s => `Кстати, пока вы у нас, можно добавить ${s.toLowerCase()}. Добавить?`,
        },
        uk: {
            header: n => `✅ Чудово, ${n}. Запис підтверджено:`,
            cancel: '🙏 Якщо потрібно скасувати або змінити, попередьте нас за 48год.',
            more: 'Чим ще можу допомогти?',
            upsell: s => `До речі, поки ви у нас, можна додати ${s.toLowerCase()}. Додати?`,
        },
    };
    const t = T[lang] || T.es;

    const lines = [t.header(nombre || ''), ''];
    lines.push(`📅 ${fechaStr}`);
    lines.push(`${emoji} ${svcLine}`);
    if (priceLine) lines.push(`💰 ${priceLine}`);
    if (dir) lines.push(`📍 ${dir}`);
    lines.push('');
    lines.push(t.cancel);
    if (upsellSuggestion) {
        lines.push('');
        lines.push(t.upsell(upsellSuggestion));
    } else {
        lines.push('');
        lines.push(t.more);
    }
    return lines.join('\n');
}

// Detects if text mentions a service category with hair-length variants (Largo 1/2/3/4).
// Returns the original category name or null.
function detectLargoCategory(text, servicesCatalog) {
    if (!text || !servicesCatalog?.length) return null;
    const t = normalizeText(text);

    const catMap = {};
    for (const svc of servicesCatalog) {
        const catNorm = normalizeText(svc.categoria);
        if (!catMap[catNorm]) catMap[catNorm] = { name: svc.categoria, services: [] };
        catMap[catNorm].services.push(svc);
    }

    const largoCats = Object.values(catMap).filter(({ services }) =>
        services.filter(s => /\d+\s*$/.test(normalizeText(s.nombre))).length >= 2
    );
    if (!largoCats.length) return null;

    for (const { name } of largoCats) {
        if (t.includes(normalizeText(name))) return name;
    }

    const largoKeywords = [
        { kw: ['alisado', 'alisar', 'straighten', 'keratin'], cat: 'alisado vegano' },
        { kw: ['airtouch'], cat: 'mechas airtouch' },
        { kw: ['clasica', 'clasicas'], cat: 'mechas clasicas' },
        { kw: ['total blond', 'decoloracion', 'decolorar', 'deco'], cat: 'deco total blond' },
        { kw: ['antifrizz', 'anti frizz', 'encrespamiento', 'anti-encrespamiento'], cat: 'anti-encrespamiento' },
        { kw: ['color completo'], cat: 'color premium' },
    ];

    for (const { kw, cat: catKey } of largoKeywords) {
        if (kw.some(k => t.includes(normalizeText(k)))) {
            const match = largoCats.find(c => normalizeText(c.name) === catKey);
            if (match) return match.name;
        }
    }

    return null;
}

// Extracts Mechas clásicas type from user response.
// Returns 1 (delante/puntas/rostro), 2 (media cabeza), 3 (cabeza completa), or null.
function extractMechasClasicasTipo(text) {
    if (!text) return null;
    const t = normalizeText(text);
    if (/\b(la\s+)?primera\b/.test(t) || /\bdelante\b/.test(t) || /\bpuntas\b/.test(t) || /\brostro\b/.test(t)) return 1;
    if (/\b(la\s+)?segunda\b/.test(t) || /\bmedia\s*cabeza\b/.test(t)) return 2;
    if (/\b(la\s+)?tercera\b/.test(t) || /\bcompleta\b/.test(t) || /\btoda\b/.test(t) || /\bentera\b/.test(t) || /\bcabeza\s+completa\b/.test(t)) return 3;
    const numMatch = t.match(/\b([123])\b/);
    if (numMatch) return parseInt(numMatch[1], 10);
    return null;
}

// Detects services that require manual consultation (no fixed price).
// Returns { type, message } or null.
function detectConsultaService(text) {
    if (!text) return null;
    const t = normalizeText(text);
    if (/\b(extension|extensiones)\b/.test(t)) {
        return { type: 'extensiones' };
    }
    if (/\b(permanente|permanent)\b/.test(t)) {
        return { type: 'permanente' };
    }
    if (/salida de negro|arrastre de color|quitar tinte negro|subir tono desde negro|quitar el negro|salir del negro/.test(t)) {
        return { type: 'salida_negro' };
    }
    return null;
}

// Extracts hair length from user response.
// Returns 1 (short/hombros), 2 (medium/espalda), 3 (long/cintura), 4 (very long), or null.
function extractLargoPelo(text) {
    if (!text) return null;
    const t = normalizeText(text);
    if (/\blargo\s+\d\b/.test(t)) return null;
    if (/\b(muy largo|very long|mas de cintura|por debajo de la cintura)\b/.test(t)) return 4;
    if (/(очень длинн|дуже довг)/.test(t)) return 4;
    if (/\b(largo|long|cintura)\b/.test(t)) return 3;
    if (/(до пояса|до талі|длинн|довг[іе])/.test(t)) return 3;
    if (/\b(medio|medium|espalda|escapula|mid)\b/.test(t)) return 2;
    if (/(до лопаток|средн|середн)/.test(t)) return 2;
    if (/\b(corto|short|hombros)\b/.test(t)) return 1;
    if (/(до плечей|коротк)/.test(t)) return 1;
    return null;
}

module.exports = {
    normalizeText,
    detectLanguage,
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
    isServiceName,
    // Salon-specific
    extractServiceFromText,
    extractStylistFromText,
    getMissingFieldsSante,
    extractQuickDataSante,
    wantsAnotherBooking,
    detectGuestBooking,
    extractGuestName,
    matchUpsellSuggestion,
    buildSanteConfirmationMessage,
    detectLargoCategory,
    extractLargoPelo,
    extractMechasClasicasTipo,
    detectConsultaService,
};
