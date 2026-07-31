// Reducer puro de preferencia de fecha/hora (salón). Requiere solo date-utils (aritmética
// pura), así que NO arrastra la capa de datos/Supabase al requerir helpers en tests.
const { applyDatePreference } = require('./date-preference');

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

// ─── Mensajes entrantes que no son texto ─────────────────────────────────────
// El bot no "ve" imágenes ni abre documentos, pero callarse es peor que decirlo: una foto
// sin caption dejaba el turno en silencio absoluto. Estas dos funciones son puras y
// normalizan las DOS superficies de entrada (whatsapp-web.js y el adaptador de Cloud API),
// que usan los mismos nombres de tipo salvo el audio ('ptt' en wwebjs).

// Eventos de sistema de whatsapp-web.js: el aviso de cifrado, un mensaje aún no descifrado,
// un registro de llamada, una notificación de grupo… No los ha escrito la clienta, así que
// responderlos sería spam. Estos SÍ deben seguir en silencio.
const SYSTEM_MESSAGE_TYPES = new Set([
    'e2e_notification', 'notification', 'notification_template', 'group_notification',
    'gp2', 'ciphertext', 'protocol', 'revoked', 'call_log',
]);

// Familias de mensaje que comparten respuesta. 'unknown' cubre cualquier tipo futuro que
// traiga un adjunto: preferimos un texto genérico a volver al silencio. Un tipo desconocido
// SIN adjunto se trata como evento de sistema (ahí el silencio es lo correcto).
function classifyIncomingMedia(message) {
    const type = String(message?.type || '').toLowerCase();
    if (SYSTEM_MESSAGE_TYPES.has(type)) return 'system';
    switch (type) {
        case 'ptt':
        case 'audio':
        case 'voice':
            return 'audio';
        case 'image':
            return 'image';
        case 'video':
            return 'video';
        case 'sticker':
            return 'sticker';
        case 'document':
            return 'document';
        case 'location':
            return 'location';
        case 'contacts':
        case 'vcard':
        case 'multi_vcard':
            return 'contacts';
        default:
            return message?.hasMedia ? 'unknown' : 'system';
    }
}

// Respuesta al mensaje no soportado, en el idioma de la clienta (fallback español), siguiendo
// el patrón multiidioma del resto del salón (ver salonRetryMsg en bot.js).
function unsupportedMediaMsg(kind, language) {
    // Los eventos de sistema no llevan respuesta: cadena vacía = no enviar nada.
    if (kind === 'system') return '';
    const byKind = {
        image: {
            es: 'No puedo ver fotos ni vídeos 😅 ¿Me describes con palabras qué te quieres hacer (corte, color, largo)? Así te busco hueco.',
            en: "I can't see photos or videos 😅 Could you describe in words what you'd like done (cut, colour, length)? Then I'll find you a slot.",
            ru: 'Я не вижу фото и видео 😅 Опиши, пожалуйста, словами, что ты хочешь сделать (стрижка, цвет, длина) — и я подберу тебе окошко.',
            uk: 'Я не бачу фото та відео 😅 Опиши, будь ласка, словами, що ти хочеш зробити (стрижка, колір, довжина) — і я підберу тобі віконце.',
        },
        document: {
            es: 'No puedo abrir documentos 😅 ¿Me lo cuentas por aquí en un mensaje?',
            en: "I can't open documents 😅 Could you tell me here in a message?",
            ru: 'Я не могу открывать документы 😅 Напиши, пожалуйста, сообщением здесь.',
            uk: 'Я не можу відкривати документи 😅 Напиши, будь ласка, повідомленням тут.',
        },
        generic: {
            es: '¡Gracias! 😊 Cuéntame en un mensaje qué necesitas y te ayudo a reservar.',
            en: 'Thanks! 😊 Tell me in a message what you need and I\'ll help you book.',
            ru: 'Спасибо! 😊 Напиши сообщением, что тебе нужно, и я помогу записаться.',
            uk: 'Дякую! 😊 Напиши повідомленням, що тобі потрібно, і я допоможу записатися.',
        },
    };
    // El vídeo comparte el "no puedo ver"; sticker/ubicación/contacto/desconocido van al genérico.
    const set = byKind[kind === 'video' ? 'image' : kind] || byKind.generic;
    return (language && set[language]) || set.es;
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
    if (t.includes('semana que viene') || t.includes('semana q viene') || t.includes('la semana que viene') ||
        t.includes('la semana siguiente') || t.includes('proxima semana') || t.includes('la proxima semana') ||
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

const SERVICE_NAME_KEYWORDS = [
    'mechas', 'contouring', 'balayage', 'keratina', 'tinte', 'corte', 'peinado',
    'dyson', 'brushing', 'manicura', 'pedicura', 'masaje', 'spa', 'extensiones',
    'permanente', 'decapado', 'diagnostico', 'dermapen', 'highlights', 'babylights', 'ombre'
];

function filterServiceKeyword(name) {
    if (!name) return null;
    const words = normalizeText(name).split(/\s+/);
    for (const word of words) {
        for (const kw of SERVICE_NAME_KEYWORDS) {
            if (word === kw) return null;
            if (kw.length >= 4 && (word.includes(kw) || kw.includes(word))) return null;
        }
    }
    return name;
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

// Equivalencias ortográficas EN/ES de nombres de servicio. El catálogo guarda
// "Manicure + gel" (inglés) pero el LLM/clienta escriben "Manicura + gel": sin
// igualarlos, el match exacto falla y el fuzzy empata "gel" con "Fortalecimiento
// gel", devolviendo null (causa de selectedService=null para manicuras).
// Clave→valor canónico, ambos ya normalizados (sin acentos, minúsculas).
const SERVICE_SYNONYMS = [
    [/\bmanicure\b/g, 'manicura'],
];

// Longitud mínima para que una palabra cuente como "distintiva" de un servicio en la
// pasada de último recurso de extractServiceFromText. Con 5 caracteres entran los
// términos que de verdad identifican ("aromaterapia", "relajante", "deportivo",
// "espalda") y quedan fuera los conectores y las colas cortas de nombre.
const MIN_DISTINCTIVE_TOKEN = 5;

// normalizeText + canonicalización de sinónimos de servicio. Se aplica por igual
// al texto de consulta y a los nombres del catálogo dentro de extractServiceFromText
// para que ambos lados converjan a la misma forma.
function normalizeService(value) {
    let s = normalizeText(value);
    for (const [re, canon] of SERVICE_SYNONYMS) s = s.replace(re, canon);
    return s;
}

// Palabras coloquiales → categoría del catálogo. Vive a nivel de módulo (antes estaba
// dentro de extractServiceFromText) porque hay dos consumidores con necesidades distintas:
// extractServiceFromText quiere UN servicio concreto y devuelve null si la categoría es
// ambigua; extractServiceCategoriesFromText quiere saber QUÉ CATEGORÍAS se nombran aunque
// ninguna resuelva a un servicio. El orden importa: la primera coincidencia gana en la
// resolución de servicio, así que 'pedicura' antes que 'masaje' es intencionado.
const CATEGORY_KEYWORDS = [
    { keywords: ['corte', 'cortar', 'corto', 'corta', 'degradado', 'haircut', 'cut'], categoria: 'Cortes' },
    { keywords: ['color', 'tinte', 'teñir', 'raiz', 'raíz', 'dye'], categoria: 'Color Premium' },
    { keywords: ['contouring'], categoria: 'Mechas Contouring' },
    { keywords: ['balayage'], categoria: 'Mechas Balayage' },
    { keywords: ['mecha', 'mechas', 'highlights'], categoria: 'Mechas Airtouch' },
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

// TODAS las categorías del catálogo que el texto nombra, resueltas por palabra coloquial o
// por el nombre literal de la categoría. A diferencia de extractServiceFromText, NO exige
// que la categoría resuelva a un servicio único: "quiero un masaje antes de la pedicura"
// devuelve ['Manicura/Pedicura', 'Masajes y SPA'] aunque "Masajes y SPA" tenga 9 variantes.
//
// Existe por el bug del 30/07/2026: el detector de segunda reserva solo miraba
// extractServiceFromText, que ante una categoría ambigua devuelve null a propósito, así que
// "quiero un masaje antes de la pedicura" no disparaba el reset y la conversación siguió
// con la cita anterior confirmada y todas las redes anti-mentira apagadas.
function extractServiceCategoriesFromText(text, servicesCatalog) {
    if (!text || !servicesCatalog?.length) return [];
    const t = normalizeService(text);
    const catsCatalogo = new Set(servicesCatalog.map(s => normalizeText(s.categoria)).filter(Boolean));
    const encontradas = new Set();
    // Vía 1: el nombre literal de la categoría aparece en el texto ("spa hair").
    for (const svc of servicesCatalog) {
        const cat = normalizeText(svc.categoria);
        if (cat && t.includes(cat)) encontradas.add(svc.categoria);
    }
    // Vía 2: palabra coloquial → categoría, solo si esa categoría existe en el catálogo.
    for (const { keywords, categoria } of CATEGORY_KEYWORDS) {
        if (!catsCatalogo.has(normalizeText(categoria))) continue;
        if (keywords.some(kw => t.includes(normalizeText(kw)))) encontradas.add(categoria);
    }
    return [...encontradas];
}

function extractServiceFromText(text, servicesCatalog) {
    if (!text || !servicesCatalog?.length) return null;
    const t = normalizeService(text);

    let bestMatch = null;
    let bestLen = 0;

    // Pre-compute: services sharing the same normalized name (for disambiguation)
    const nameGroups = {};
    for (const svc of servicesCatalog) {
        const key = normalizeService(svc.nombre);
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
        const svcName = normalizeService(svc.nombre);
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
        for (const { keywords, categoria } of CATEGORY_KEYWORDS) {
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
                    const nameWords = normalizeService(svc.nombre).split(/\s+/);
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

    // Pasada 2 (último recurso): token distintivo del NOMBRE del catálogo presente en
    // el texto. Es la simétrica de la pasada 1a — allí buscamos el nombre completo
    // DENTRO del texto ("quiero aromaterapia relax"), aquí buscamos las palabras del
    // nombre cuando la clienta lo ABREVIA ("aromaterapia" → "Aromaterapia relax").
    // Solo corre si todo lo anterior falló, así que nunca cambia una resolución que
    // hoy funciona: únicamente rescata casos que hoy devuelven null. Y devolver null
    // aquí no es neutro — el bot ya le ha dicho al LLM que no vuelva a preguntar el
    // servicio, así que un null se convierte en bucle (ver salonNoSlotsMsg).
    if (!bestMatch) {
        // Palabras completas, no substring: las pasadas anteriores usan includes()
        // sobre la frase entera, demasiado laxo para un criterio tan permisivo como
        // "una sola palabra del nombre basta".
        const tokenize = s => s.split(/[^a-z0-9]+/).filter(Boolean);
        const textTokens = new Set(tokenize(t).filter(w => w.length >= MIN_DISTINCTIVE_TOKEN));
        // Si el texto nombra una CATEGORÍA del catálogo, la búsqueda no puede salirse de
        // ella: "Deco Total Blond" (categoría con variantes por largo, ambigua a
        // propósito) compartía el token "blond" con "Botanical Glow Pure Blond" y se lo
        // llevaba a otra categoría, otro precio y otra duración. Cruzar de categoría es
        // peor que no resolver: con null el bot pregunta, con el servicio equivocado
        // reserva mal en silencio.
        const catsMencionadas = servicesCatalog
            .map(s => normalizeText(s.categoria))
            .filter(c => c && t.includes(c));
        const candidatos = catsMencionadas.length
            ? servicesCatalog.filter(s => catsMencionadas.includes(normalizeText(s.categoria)))
            : servicesCatalog;
        if (textTokens.size) {
            let best = null;
            let bestScore = 0;
            let bestIsPrefix = false;
            let tied = false;
            for (const svc of candidatos) {
                const distintivos = tokenize(normalizeService(svc.nombre)).filter(w =>
                    w.length >= MIN_DISTINCTIVE_TOKEN && !SERVICE_MATCH_STOPWORDS.has(w) && !/^\d+$/.test(w)
                );
                const matched = distintivos.filter(w => textTokens.has(w));
                if (!matched.length) continue;
                // Un token que ENCABEZA el nombre identifica el servicio mucho mejor que
                // uno accesorio: "masaje relajante" debe caer en "Relajante completo",
                // no en "Holistic relajante Premium". Es el desempate, no el criterio.
                const isPrefix = matched.includes(distintivos[0]);
                if (matched.length > bestScore || (matched.length === bestScore && isPrefix && !bestIsPrefix)) {
                    bestScore = matched.length;
                    best = svc;
                    bestIsPrefix = isPrefix;
                    tied = false;
                } else if (matched.length === bestScore && isPrefix === bestIsPrefix) {
                    tied = true;
                }
            }
            // Empate que el prefijo no rompe → mejor seguir sin match que arriesgar
            // un servicio equivocado (precio y duración distintos).
            if (best && !tied) bestMatch = best;
        }
    }

    return bestMatch;
}

// Nombre COMPLETO del servicio para guardar en appointments.service y mostrar.
// En el catálogo las variantes por largo de pelo se guardan con un `nombre`
// genérico ("Largo 1") y la categoría real ("Mechas Airtouch") aparte. Ese nombre
// suelto es ambiguo —se comparte entre varias categorías— así que lo prefijamos
// con la categoría para obtener el nombre real: "Mechas Airtouch Largo 1".
// Los servicios con nombre propio (ej. "Color completo largo 1", "K18") se
// devuelven tal cual.
function buildFullServiceName(svc, servicesCatalog = []) {
    if (!svc || !svc.nombre) return svc?.nombre || null;
    if (!svc.categoria) return svc.nombre;
    const norm = normalizeText(svc.nombre);
    // Ya contiene la categoría → nombre propio completo, no duplicar.
    if (norm.includes(normalizeText(svc.categoria))) return svc.nombre;
    // Categoría "Cortes": en el catálogo los cortes se guardan con un `nombre`
    // genérico que NO menciona "corte" ("Hombre", "Niño", "Mujer y secado"…). Sin
    // prefijo el panel muestra "Niño"/"Hombre" en vez de "Corte niño"/"Corte hombre".
    // Prefijamos "Corte" (singular) + nombre en minúscula para leerse natural.
    // (No usamos la categoría literal "Cortes" porque el prefijo natural es "Corte".)
    if (normalizeText(svc.categoria) === 'cortes' && !norm.startsWith('corte')) {
        return `Corte ${svc.nombre.charAt(0).toLowerCase()}${svc.nombre.slice(1)}`;
    }
    const esVarianteGenerica =
        /^largo\s*\d+$/.test(norm) ||
        (servicesCatalog || []).filter(s => normalizeText(s.nombre) === norm).length > 1;
    return esVarianteGenerica ? `${svc.categoria} ${svc.nombre}` : svc.nombre;
}

// Capa de PRESENTACIÓN (solo texto al cliente). Traduce la nomenclatura interna
// "Largo N" al lenguaje natural que prefiere Yulia: "Mechas Airtouch Largo 2" →
// "Mechas Airtouch (cabello medio)". NO altera ningún valor guardado ni
// session.selectedService — llamar únicamente sobre strings mostrados a la clienta.
// Se auto-selecciona: los servicios sin token "Largo N" (Mechas clásicas "Mechas 2",
// Mechas Contouring, cortes…) se devuelven intactos.
const LARGO_LABELS = { '1': 'corto', '2': 'medio', '3': 'largo', '4': 'muy largo' };

function humanizeLargoLabel(text) {
    if (!text) return text;
    return text.replace(/\blargo\s*([1-4])\b/gi, (m, n) => `(cabello ${LARGO_LABELS[n]})`);
}

// ─── Reconocimiento de estilista ────────────────────────────────────────────
// Antes esto era un String.includes() puro: cualquier errata ("Iryna") o nombre
// inexistente ("Carmen") devolvía null. Y los tres call sites de bot.js son
// `if (matched && …)` SIN else → la petición se descartaba en silencio y el flujo
// seguía proponiendo huecos de otra estilista, como si la clienta no hubiera
// pedido nada. resolveStylistMention devuelve un VEREDICTO para que quien llama
// pueda distinguir los cuatro casos y responder a cada uno:
//   exact   → la nombró tal cual (comportamiento histórico, intacto)
//   fuzzy   → casi-acierto corregible ("Olga"→Olgha): se asigna Y se avisa
//   unknown → nombró a alguien que NO está en el equipo: hay que decírselo
//   none    → no nombró a nadie; aquí el silencio sí es lo correcto

const STYLIST_NAME_VERDICT_NONE = { status: 'none', stylist: null, mencion: null, sugerencia: null };

// Palabras que indican que la cita es para OTRA persona, no para el titular del WA.
// Se declara AQUÍ (y no en la sección de segunda reserva, que es quien la usaba en
// origen) porque STYLIST_NOT_NAMES la extiende: en orden de módulo tiene que estar
// inicializada antes.
const GUEST_NOT_NAMES = ['amigo', 'amiga', 'madre', 'padre', 'hija', 'hijo', 'hermana',
    'hermano', 'pareja', 'marido', 'mujer', 'novia', 'novio', 'prima', 'primo', 'persona',
    'otra', 'otro', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
    'manana', 'tarde', 'noche', 'hoy', 'semana', 'dia', 'cita', 'reserva', 'corte', 'color'];

// Palabras que siguen a "con/para" y NO son un nombre de persona. Sin esta lista,
// "con prisa" o "con mi hija" se anunciarían como estilistas inexistentes, que es
// un fallo peor que el silencio que venimos a arreglar.
const STYLIST_NOT_NAMES = new Set([
    ...GUEST_NOT_NAMES,
    'quien', 'quién', 'alguien', 'cualquiera', 'nadie', 'ella', 'ellas', 'ese', 'esa',
    'prisa', 'tiempo', 'urgencia', 'hora', 'horas', 'minutos', 'precio', 'descuento',
    'estilista', 'peluquera', 'chica', 'senora', 'señora', 'equipo', 'salon', 'salón',
    'preferencia', 'nombre', 'gusto', 'igual', 'cercano', 'disponible', 'libre',
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre',
    'anyone', 'someone', 'whoever', 'stylist', 'hairdresser', 'time', 'price',
]);

// Distancia de Levenshtein con corte temprano: en cuanto se sabe que supera `max`
// no interesa el valor exacto. Dos filas, sin matriz completa.
function levenshtein(a, b, max = Infinity) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    let curr = new Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        let rowMin = curr[0];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
            if (curr[j] < rowMin) rowMin = curr[j];
        }
        if (rowMin > max) return max + 1;
        [prev, curr] = [curr, prev];
    }
    return prev[b.length];
}

// Tolerancia a erratas proporcional al nombre: en "Irina" (5) una sola letra ya
// cambia mucho, en "Veronika" (8) caben dos sin acercarse a ningún otro nombre.
function stylistTypoTolerance(name) {
    return name.length <= 5 ? 1 : 2;
}

const stylistName = member => normalizeText(member?.nombre || member?.name).replace(/-/g, ' ');
const tokenizeName = s => String(s || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Varias candidatas a la misma distancia. Si todas comparten el nombre de pila
// ("Yulia" y "Yulia-Tricóloga") no hay ambigüedad real: gana el nombre simple,
// porque el compuesto solo debe ganar cuando la clienta lo nombra entero — y eso
// ya lo resuelve la pasada de token-set, antes de llegar aquí.
function collapseStylistTies(candidates) {
    if (candidates.length === 1) return candidates[0];
    const pila = new Set(candidates.map(m => tokenizeName(stylistName(m))[0]));
    if (pila.size !== 1) return null;
    return candidates.reduce((a, b) => (stylistName(a).length <= stylistName(b).length ? a : b));
}

function resolveStylistMention(text, teamList, opts = {}) {
    if (!text || !teamList?.length) return STYLIST_NAME_VERDICT_NONE;
    const t = normalizeText(text).replace(/-/g, ' ');
    const {
        servicesCatalog = [],
        excludeNames = [],
        guestBooking = false,
        expectingStylist = false,
        assumePersonName = false,
    } = opts;

    const textTokens = tokenizeName(t);
    if (!textTokens.length) return STYLIST_NAME_VERDICT_NONE;
    const textTokenSet = new Set(textTokens);

    // Pasada 1 — acierto. Nombres más largos primero, para que un nombre compuesto no
    // se lo lleve por inclusión de substring el nombre corto que lo prefija. Se acepta
    // de dos formas, y el orden importa: literal ("yulia-tricóloga") o con todas sus
    // palabras presentes en cualquier orden ("con la tricologa Yulia"). Sin la segunda
    // dentro de ESTE bucle, "yulia" a secas ganaría antes de llegar a comprobarla.
    const sorted = [...teamList].sort((a, b) => stylistName(b).length - stylistName(a).length);
    for (const member of sorted) {
        const name = stylistName(member);
        const partes = tokenizeName(name);
        const acierto = t.includes(name) || (partes.length > 1 && partes.every(p => textTokenSet.has(p)));
        if (acierto) {
            return { status: 'exact', stylist: member, mencion: member.nombre || member.name, sugerencia: null };
        }
    }

    // Candidatas del mensaje: palabras que podrían ser un nombre propio.
    const posiblesNombres = textTokens.filter(w => w.length >= 3 && !/^\d+$/.test(w) && !STYLIST_NOT_NAMES.has(w));

    // Pasada 3 — distancia de edición contra el nombre de pila de cada miembro.
    let mejorDist = Infinity;
    let mejores = [];
    let mencionFuzzy = null;
    for (const token of posiblesNombres) {
        if (token.length < 4) continue;
        for (const member of teamList) {
            const pila = tokenizeName(stylistName(member))[0];
            if (!pila) continue;
            const tol = stylistTypoTolerance(pila);
            const d = levenshtein(token, pila, tol);
            if (d > tol) continue;
            if (d < mejorDist) {
                mejorDist = d;
                mejores = [member];
                mencionFuzzy = token;
            } else if (d === mejorDist && !mejores.includes(member)) {
                mejores.push(member);
            }
        }
    }
    if (mejores.length) {
        const elegida = collapseStylistTies(mejores);
        // Empate entre personas distintas: mejor no adivinar. Mismo criterio que la
        // pasada de último recurso de extractServiceFromText.
        if (elegida) {
            return { status: 'fuzzy', stylist: elegida, mencion: mencionFuzzy, sugerencia: elegida.nombre || elegida.name };
        }
    }

    // Pasada 4 — hipocorísticos por prefijo: "Vero" → Veronika. Mínimo 4 letras y
    // una sola candidata, para que "Nat"/"Iri" no disparen nada.
    for (const token of posiblesNombres) {
        if (token.length < 4) continue;
        const prefijadas = teamList.filter(m => {
            const pila = tokenizeName(stylistName(m))[0] || '';
            return pila.length > token.length && pila.startsWith(token);
        });
        const elegida = collapseStylistTies(prefijadas);
        if (elegida) {
            return { status: 'fuzzy', stylist: elegida, mencion: token, sugerencia: elegida.nombre || elegida.name };
        }
    }

    // Pasada 5 — desconocida. Solo si el mensaje nombra de verdad a una PERSONA.
    // Es la pasada delicada: un falso positivo hace que el bot anuncie "no tengo a
    // ninguna Mechas", así que se exige señal explícita y se filtra con dureza.
    if (guestBooking) return STYLIST_NAME_VERDICT_NONE; // "para mi amiga Carmen" no pide estilista

    // `capitalizado` es la señal fuerte de nombre propio en WhatsApp. Sin ella, una
    // palabra corta y suelta tras "con" ("con gel", "con spa") se anunciaba como una
    // estilista inexistente — un falso positivo peor que el silencio original. Así que
    // se exige mayúscula O una longitud que ya no sea la de un término de servicio.
    const esNombreDePersona = (token, capitalizado = false) => {
        if (!token || token.length < 3) return false;
        if (!capitalizado && token.length < 5) return false;
        if (STYLIST_NOT_NAMES.has(token)) return false;
        if (excludeNames.some(n => normalizeText(n) === token)) return false;
        // No es un servicio ni una categoría del catálogo.
        if (servicesCatalog.length) {
            if (extractServiceFromText(token, servicesCatalog)) return false;
            if (servicesCatalog.some(s => normalizeText(s.categoria || '').includes(token))) return false;
        }
        return true;
    };

    // Origen de la mención. `assumePersonName` es para el campo estilista_preferida
    // del LLM: si el modelo lo rellenó es porque cree que la clienta nombró a
    // alguien, así que no hace falta heurística de marcador.
    const raw = String(text);
    // ¿Aparece esa palabra con inicial mayúscula en el texto tal cual lo escribió?
    const vieneCapitalizada = tok => new RegExp(`\\b\\p{Lu}${tok.slice(1)}`, 'u').test(raw);

    let mencion = null;
    if (assumePersonName) {
        // El campo del LLM es de alta precisión: si lo rellenó, cree que la clienta
        // nombró a alguien. No se le exige la señal de mayúscula.
        const cand = posiblesNombres.find(tok => esNombreDePersona(tok, true));
        if (cand) mencion = cand;
    } else {
        // Marcador explícito ("con Carmen", "cita con Carmen", "with Carmen").
        const re = /\b(?:con|para|with|hora\s+con|cita\s+con|reservar\s+con|pedir\s+con)\s+(?:la\s+|el\s+|mi\s+)?(\p{L}{3,})/giu;
        for (const m of raw.matchAll(re)) {
            const token = normalizeText(m[1]);
            if (esNombreDePersona(token, /^\p{Lu}/u.test(m[1]))) { mencion = m[1]; break; }
        }
        // Respuesta escueta a "¿tienes estilista de confianza?": un nombre suelto,
        // sin marcador ("Carmen"). Solo cuando la pregunta quedó abierta.
        if (!mencion && expectingStylist && textTokens.length <= 3) {
            const cand = posiblesNombres.find(tok => esNombreDePersona(tok, vieneCapitalizada(tok)));
            if (cand) mencion = cand;
        }
    }

    if (!mencion) return STYLIST_NAME_VERDICT_NONE;
    return { status: 'unknown', stylist: null, mencion, sugerencia: null };
}

// Compatibilidad: los flujos que solo necesitan "¿quién es?" y no el veredicto.
// Devuelve el miembro SOLO en los casos seguros (exacto o casi-acierto resuelto).
function extractStylistFromText(text, teamList, opts = {}) {
    return resolveStylistMention(text, teamList, opts).stylist;
}

// ─── Segunda reserva en la misma conversación (Sante) ───────────────────────
// Tras confirmar una cita, la clienta puede querer reservar OTRA (para ella o para
// un acompañante). Detectamos esa intención para reiniciar el flujo de reserva.

// GUEST_NOT_NAMES vive ahora en la sección de reconocimiento de estilista (arriba),
// porque STYLIST_NOT_NAMES la extiende y necesita que esté ya inicializada.

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
        // Añadir un servicio a lo ya reservado (bug 30/07/2026). Solo frases ADITIVAS
        // inequívocas: "además/aparte/de paso" no pueden leerse como reagendar ni cancelar.
        // Deliberadamente NO están aquí "antes de la"/"después de la": casan con "cambiar la
        // cita para antes de las 5" y reiniciarían el flujo en mitad de un reagendado,
        // perdiendo reagendarAppointmentId y duplicando la cita. El ancla temporal se usa
        // para FILTRAR huecos (extractAnchorConstraint), no para detectar segunda reserva;
        // quien detecta ese caso es la comparación de CATEGORÍAS en bot.js.
        'ademas quiero', 'ademas me gustaria', 'aparte quiero', 'y de paso', 'de paso quiero',
        'another appointment', 'another booking', 'book another', 'one more appointment',
        'also book', 'second appointment', 'second booking', 'i also want',
        'еще одну запись', 'ещё одну запись', 'ще один запис',
    ];
    return phrases.some(p => t.includes(normalizeText(p)));
}

// Ancla temporal de un servicio nuevo respecto a una cita YA confirmada: "un masaje ANTES
// de la pedicura", "algo DESPUÉS de mi corte". Devuelve 'before' | 'after' | null.
// Puro: la resolución de contra QUÉ cita ancla la hace bot.js con las citas reales.
function extractAnchorConstraint(text) {
    const t = normalizeText(text);
    // Sin \b en las alternativas cirílicas: en JS el límite de palabra es ASCII.
    if (/\bantes de\b|\bbefore\b|перед |до того/.test(t)) return 'before';
    if (/\bdespues de\b|\bluego de\b|\bafter\b|после |після /.test(t)) return 'after';
    return null;
}

// La clienta quiere reiniciar el flujo desde el principio ("empecemos desde 0",
// "empezar de nuevo", "start over"). Distinto de wantsAnotherBooking (segunda cita):
// aquí NO hay una nueva cita, sino que se descarta el servicio/estado a medio elegir.
// Coincidencia por frases explícitas de reinicio (NO "otra vez" a secas, que es ambiguo).
function wantsRestart(text) {
    const t = normalizeText(text);
    const phrases = [
        'desde cero', 'desde 0', 'empezar de nuevo', 'empecemos de nuevo',
        'empecemos desde', 'empezamos de nuevo', 'empieza de nuevo', 'empezemos de nuevo',
        'volver a empezar', 'volvamos a empezar', 'comenzar de nuevo', 'reiniciar',
        'start over', 'start again', 'from scratch', 'from the beginning',
        'заново', 'начнём заново', 'начнем заново', 'спочатку', 'почати заново',
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

// Sante exige nombre Y apellido (a diferencia de San Remo, que solo pide un
// nombre para la mesa). "Nombre completo" aquí es un heurístico simple: dos o
// más palabras. No intenta validar apellidos compuestos ni nombres de pila
// compuestos ("Maria José") — ese margen de error es aceptable frente a la
// alternativa de pedir explícitamente el apellido y fastidiar el flujo.
function hasApellido(nombre) {
    if (!nombre || typeof nombre !== 'string') return false;
    return nombre.trim().split(/\s+/).filter(Boolean).length >= 2;
}

function getMissingFieldsSante(partialData) {
    const missing = [];
    if (!partialData?.nombre || partialData.nombre === 'desconocido') missing.push('nombre');
    else if (!hasApellido(partialData.nombre)) missing.push('apellido');
    return missing;
}

function extractQuickDataSante(text, partialData = {}, servicesCatalog = [], teamList = [], opts = {}) {
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
        if (result.nombre && result.nombre !== 'desconocido') {
            result.nombre = filterServiceKeyword(result.nombre) || undefined;
        }
    } else if (!hasApellido(result.nombre) && !opts.stylistQuestionPending) {
        // Ya tenemos nombre de pila pero el bot le acaba de pedir el apellido
        // explícitamente (ver proximoPaso en openai.js). Si este turno es una
        // respuesta corta (1-2 palabras) que parece un apellido válido y no es
        // ni un servicio ni una estilista, se completa el nombre.
        const trimmed = text.trim();
        const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
        if (wordCount >= 1 && wordCount <= 2 && isValidName(trimmed)
                && !isServiceName(trimmed, servicesCatalog)
                && !resolveStylistMention(trimmed, teamList, { assumePersonName: true }).stylist) {
            const completado = filterServiceKeyword(trimmed);
            if (completado) result.nombre = `${result.nombre} ${completado}`;
        }
    }

    // Toda la señal de fecha/hora de ESTE mensaje (día, fecha, semana, periodo, asap) se
    // extrae en un objeto puro y se fusiona en el ÚNICO store (preferencia_horaria) vía el
    // reducer idempotente applyDatePreference. Esto sustituye el manejo disperso anterior
    // (merges condicionales + sticky en bot.js) y elimina la contaminación de 'semana' entre
    // turnos: en cuanto hay contexto de semana + un día, el combo se colapsa a una 'fecha'
    // absoluta, así repetir el turno (typo) recalcula la MISMA fecha (idempotente).
    //
    // `opts.stylistQuestionPending`: el turno anterior dejó abierta la pregunta de ESTILISTA
    // ("¿tienes estilista de confianza o prefieres el hueco más cercano?"). Ahí "el más
    // cercano" responde a QUIÉN, no a CUÁNDO: descartamos la señal asap débil para que no
    // contamine la preferencia de fecha (bug de producción del 28/07).
    const dateSignal = extractDateSignalSante(text);
    if (opts.stylistQuestionPending) delete dateSignal.asapWeak;
    if (Object.keys(dateSignal).length) {
        result.preferencia_horaria = applyDatePreference(result.preferencia_horaria, dateSignal, new Date());
    }

    return result;
}

// ─── "El más cercano / me da igual": UNA sola lectura ─────────────────────────
// La misma frase la consumen dos sitios (la preferencia de fecha aquí y la intención sticky
// de estilista en bot.js). Antes cada uno tenía su propia regex y sobre texto distinto: esta
// sobre `normalizeText` (sin tildes) y la de bot.js sobre el texto crudo (con tildes). Una
// clienta escribiendo "el mas cercano" sin tilde activaba SOLO la de fecha → la preferencia
// se contaminaba con asap y la pregunta de estilista no se cerraba nunca, dejando el flujo
// bloqueado sin cargar huecos ("problema técnico" del 28/07). Ahora hay un único detector,
// siempre sobre texto normalizado, y ambos consumidores leen su resultado.
//
// Se distinguen dos familias porque NO significan lo mismo:
//   - TEMPORAL     ("lo antes posible", "cuanto antes"): dice CUÁNDO → asap fuerte.
//   - SIN PREFERENCIA ("el más cercano", "cualquiera"): responde a una PREGUNTA DE ELECCIÓN.
//     Implica "me da igual quién", y solo implica "cuanto antes" si lo que se preguntaba era
//     la fecha. El reducer lo trata como asap DÉBIL (no borra un día ya pedido).
const ASAP_TEMPORAL_RE = /\b(lo antes posible|cuanto antes|cu[aá]nto antes|el primer hueco|primer hueco|primera disponibilidad|lo m[aá]s pronto|lo mas pronto|lo m[aá]s r[aá]pido|lo mas rapido|cuando antes|cuanto antes puedas|lo antes que puedas|antes posible|el primero disponible|primer disponible|cualquier hueco|lo m[aá]s pronto posible|lo antes posible que puedas|as soon as possible|asap|earliest|как можно скорее|якомога швидше)\b/;
const SIN_PREFERENCIA_RE = /\b(el m[aá]s cercano|la m[aá]s cercana|mas cercano disponible|hueco m[aá]s cercano|el hueco m[aá]s cercano|me da igual|me es igual|cualquiera|la que sea|el que sea|no tengo preferencia|sin preferencia|whoever|anyone|any of them|любой|любую|любое время|ближайшее время|ближайший|будь-хто|будь-який)\b/;

// Devuelve { asapTemporal, sinPreferencia } para un texto libre. Ambos flags se evalúan
// SIEMPRE sobre texto normalizado (sin tildes, minúsculas), que es lo que arregla el bug.
function detectNoPreferenceSignal(text) {
    const t = normalizeText(text);
    return {
        asapTemporal: ASAP_TEMPORAL_RE.test(t),
        sinPreferencia: SIN_PREFERENCIA_RE.test(t),
    };
}

// Extrae la SEÑAL de fecha/hora que expresa ESTE mensaje (sin estado previo, sin mutar nada).
// Devuelve un objeto plano con solo los campos detectados:
//   { asap?, asapWeak?, fecha?, diaSemana?, semana?, semanaWeak?, periodo? }
//   - `semana`     : semana EXPLÍCITA ("esta semana", "la semana que viene", "siguiente").
//   - `semanaWeak` : semana DÉBIL de "mañana" a secas (día siguiente); el reducer solo la
//                    asciende a semana si no hay ningún día concreto en juego.
//   - `asap`/`asapWeak` : ver detectNoPreferenceSignal + date-preference.js.
// El reducer (date-preference.js) decide cómo fusionarla con el store; aquí NO se resuelve
// prioridad ni herencia — solo se reporta lo que dice el texto.
function extractDateSignalSante(text) {
    const t = normalizeText(text);
    const signal = {};

    const { asapTemporal, sinPreferencia } = detectNoPreferenceSignal(text);
    if (asapTemporal) signal.asap = true;
    else if (sinPreferencia) signal.asapWeak = true;

    const datePref = extractDatePreferenceSante(t);
    if (datePref) {
        if (datePref.diaSemana !== undefined) signal.diaSemana = datePref.diaSemana;
        if (datePref.fecha) signal.fecha = datePref.fecha;
    }

    // Semana EXPLÍCITA (fuerte). "hoy" cuenta como 'esta' (comportamiento previo).
    if (/\besta semana\b/.test(t) || /\besta misma semana\b/.test(t) || /\bhoy\b/.test(t)) {
        signal.semana = 'esta';
    }
    // "que viene" (p.ej. "el martes que viene") = próxima; NO añadimos "proximo" a secas para
    // no capturar "el proximo hueco" (que es asap, no semana siguiente).
    // `\s*` tolera typos frecuentes SIN espacio o con espacios de más: "queviene", "q viene",
    // "qviene", "que  viene" — root cause del bug en el que "semana queviene" perdía la señal
    // de semana y dejaba un diaSemana pelado (el motor caía a la ocurrencia más cercana).
    if (/semana que\s*viene|semana q\s*viene|la semana siguiente|proxima semana|la proxima semana|semana proxima|siguiente semana|la proxima|la siguiente|que\s*viene|que\s*biene|q\s*viene|q\s*biene|\bsiguiente\b/.test(t)) {
        signal.semana = 'siguiente';
    }
    // Semana DÉBIL: "mañana" a secas (día siguiente) → 'esta'. Solo si no hay semana fuerte.
    if (!signal.semana && /\bmanana\b/.test(t)) signal.semanaWeak = 'esta';

    // Periodo del día (franja) — expresiones inequívocas (t va sin acentos).
    if (/\b(por la manana|en la manana|de manana|la manana|morning|утром|вранці)\b/.test(t)) {
        signal.periodo = 'mañana';
    } else if (/\b(por la tarde|en la tarde|de tarde|la tarde|afternoon|evening|днем|днём|вдень|ввечері)\b/.test(t)) {
        signal.periodo = 'tarde';
    }

    return signal;
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

    // "24 de junio" / "24 junio" — día + mes ("de" opcional; el filtro por MESES_MAP evita
    // falsos positivos como "24 horas" o "2 personas").
    const conMes = t.match(/\b(\d{1,2})\s+(?:de\s+)?([a-z]+)\b/);
    if (conMes && MESES_MAP[conMes[2]] !== undefined) {
        const dom = parseInt(conMes[1], 10);
        const f = resolveUpcomingDate(dom, MESES_MAP[conMes[2]]);
        if (f) pref.fecha = f;
    } else {
        // "el 24" (día del mes suelto) o "martes 24" (día de semana + número PEGADO): día del
        // mes >= 10 para no confundir con la selección de hueco por número (opciones 1-9). El
        // patrón "día+número" se exige adyacente para no capturar la hora ("martes a las 11").
        const diaWords = Object.keys(DIA_SEMANA_MAP).join('|');
        const soloDia = t.match(/\bel\s+(\d{1,2})\b/) ||
            t.match(new RegExp(`\\b(?:${diaWords})\\s+(\\d{1,2})\\b`));
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

// Devuelve la REGLA de upselling completa cuyo "servicio" case con el servicio
// elegido (por nombre o categoría), o null si no hay regla aplicable. Se expone
// aparte de matchUpsellSuggestion porque las reglas de decoloración llevan un campo
// `tono` que decide con qué redacción se ofrece la sugerencia (consejo de cuidado
// en vez de venta).
function matchUpsellRule(selectedService, upsellingRules) {
    if (!selectedService || !Array.isArray(upsellingRules) || !upsellingRules.length) return null;
    const name = normalizeText(selectedService.nombre);
    const cat = normalizeText(selectedService.categoria);
    for (const rule of upsellingRules) {
        const r = normalizeText(rule.servicio);
        if (!r) continue;
        if (name.includes(r) || cat.includes(r) || r.includes(name)) {
            const sug = (rule.sugerencias || [])[0];
            if (sug) return rule;
        }
    }
    return null;
}

// Devuelve la primera sugerencia de upselling cuyo "servicio" case con el servicio
// elegido (por nombre o categoría), o null si no hay regla aplicable.
function matchUpsellSuggestion(selectedService, upsellingRules) {
    const rule = matchUpsellRule(selectedService, upsellingRules);
    return rule ? (rule.sugerencias || [])[0] || null : null;
}

// Resuelve la duración (min) de un servicio a partir de un NOMBRE o ETIQUETA de
// upselling. Las reglas de upselling guardan frases de marketing ("Reconstrucción
// molecular K18 o Pro-Miracle") que NO casan por nombre exacto contra el catálogo,
// así que un `find(nombre === label)` caía a un fallback de 30 min e infra-estimaba
// la duración — causa del upsell ofrecido pasado el cierre. Estrategia: (1) match
// exacto de nombre; (2) resolución difusa vía extractServiceFromText (mapea la
// frase al servicio real: "…K18…" → K18 60 min); (3) fallback CONSERVADOR (60, no
// 30) para no volver a infra-estimar si la etiqueta fuese irresoluble.
function resolveServiceDurationMin(name, catalog, fallback = 60) {
    if (!name || !Array.isArray(catalog) || !catalog.length) return fallback;
    const target = normalizeText(name);
    const exact = catalog.find(s => normalizeText(s.nombre) === target);
    if (exact?.duracion) return exact.duracion;
    const fuzzy = extractServiceFromText(name, catalog);
    if (fuzzy?.duracion) return fuzzy.duracion;
    return fallback;
}

// Parte DETERMINISTA del guard anti-cierre del upselling: dada la hora de inicio de
// la cita, la duración del servicio principal y la ETIQUETA del upsell sugerido,
// decide si el upsell debe descartarse porque la cita ampliada cruzaría (1) el tope
// duro del salón (19:00 por defecto) o (2) el cierre de la estilista ese día. La
// comprobación async de bloqueos de agenda (blocked_days / schedule_blocks) se hace
// aparte en bot.js. Devuelve { discard, motivo, apptEnd } en minutos-del-día.
function shouldDiscardUpsellForClosing({ horaCita, serviceDurMin, upsellLabel, catalog, hardCutoffMin = 19 * 60, stylistCloseMin = null }) {
    // Nota: Number('') === 0, así que validamos con regex — una hora ausente o
    // malformada NO debe producir un apptEnd falso (arrancaría en 00:00).
    const m = /^(\d{1,2}):(\d{2})/.exec(String(horaCita || '').trim());
    if (!m) return { discard: false, motivo: null, apptEnd: null };
    const startH = Number(m[1]);
    const startM = Number(m[2]);
    const upsellDurMin = resolveServiceDurationMin(upsellLabel, catalog);
    const apptStart = startH * 60 + (startM || 0);
    const apptEnd = apptStart + (serviceDurMin || 60) + upsellDurMin;
    if (apptEnd > hardCutoffMin) return { discard: true, motivo: 'tope_19h', apptEnd };
    if (Number.isFinite(stylistCloseMin) && apptEnd >= stylistCloseMin) {
        return { discard: true, motivo: 'cierre_estilista', apptEnd };
    }
    return { discard: false, motivo: null, apptEnd };
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

// ─── Promo 10% primera visita a Spa Hair / Masajes ───────────────────────────
// Tras confirmar CUALQUIER cita el bot menciona los servicios nuevos con un 10% de
// descuento válido solo en la primera visita. Estas dos categorías del catálogo son
// las que cubre la promo.
const SPA_PROMO_CATEGORIES = ['spa hair', 'masajes y spa'];

function isSpaPromoCategory(categoria) {
    return SPA_PROMO_CATEGORIES.includes(normalizeText(categoria || ''));
}

// ¿La clienta ya ha estado en Spa Hair o Masajes? Si sí, no es su primera visita y
// la promo no aplica. Hay que resolverlo contra el catálogo porque
// appointments.service guarda el nombre de la VARIANTE ("Relax 45min"), no la
// categoría. `serviciosPasados` son los strings de appointments.service de citas
// anteriores (pueden venir fusionados con upsells: "Corte + K18").
function hasPreviousSpaOrMassage(serviciosPasados, catalog) {
    if (!Array.isArray(serviciosPasados) || !serviciosPasados.length) return false;
    const promoNames = (Array.isArray(catalog) ? catalog : [])
        .filter(s => isSpaPromoCategory(s.categoria))
        .map(s => normalizeText(s.nombre))
        .filter(Boolean);
    const promoCats = SPA_PROMO_CATEGORIES;
    return serviciosPasados.some(svc => {
        const t = normalizeText(svc || '');
        if (!t) return false;
        return promoCats.some(c => t.includes(c)) || promoNames.some(n => t.includes(n));
    });
}

// Marcador que se escribe en appointments.notes cuando se ofrece la promo, para que
// el personal del salón pueda comprobar en el panel si a una clienta que menciona el
// 10% ya se le ofreció (y por tanto era su primera visita en ese momento).
function buildSpaPromoNote(date = new Date()) {
    const fecha = date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Madrid' });
    return `[PROMO] 10% 1ª visita Spa Hair/Masajes ofrecido el ${fecha}`;
}

function buildSanteConfirmationMessage({ nombre, fecha, hora, servicio, stylistNombre, precio, duracion, categoria, direccion, language, upsellSuggestion, upsellTono, spaPromo } = {}) {
    const lang = ['es', 'en', 'ru', 'uk'].includes(language) ? language : 'es';
    const dir = (direccion || '').trim();
    const emoji = _serviceEmoji(categoria);
    const fechaStr = _formatFechaHora(fecha, hora, lang);
    const isConsulta = normalizeText(categoria || '') === 'consulta';

    const T = {
        es: {
            header: n => `✅ Perfecto, ${n}. Cita reservada:`,
            cancel: '🙏 Si necesitas cancelar o cambiar, avísanos con 48h de antelación.',
            more: '¿Algo más en lo que pueda ayudarte?',
            upsell: s => `Por cierto, mientras estás aquí podrías aprovechar para ${s.toLowerCase()}. ¿Te lo añado?`,
            upsellCuidado: s => `La decoloración es un proceso agresivo para el cabello, por eso te aconsejamos acompañarla con una ${s.toLowerCase()}: así tu pelo queda corregido y más fuerte 💛 ¿Te la añado a la cita?`,
            spaPromo: '✨ Y una novedad para nuestras clientas: ahora tenemos Spa Hair Capilar y Masajes. En tu primera visita a cualquiera de los dos tienes un 10% de descuento, por si te apetece probarlo algún día 💛',
            consultaSvc: 'Consulta de valoración (20 min)',
            consultaPrice: 'El precio se confirma en el salón según lo que decidas',
            consultaNote: 'Si tras la consulta decides hacerte el servicio que te recomiende, ya tendrás tiempo reservado a continuación sin esperar.',
        },
        en: {
            header: n => `✅ Perfect, ${n}. Appointment booked:`,
            cancel: '🙏 If you need to cancel or change, please let us know 48h in advance.',
            more: 'Anything else I can help you with?',
            upsell: s => `By the way, while you're here you could also add ${s.toLowerCase()}. Want me to include it?`,
            upsellCuidado: s => `Bleaching is a harsh process for your hair, so we recommend pairing it with a ${s.toLowerCase()}: your hair comes out corrected and stronger 💛 Shall I add it to your appointment?`,
            spaPromo: "✨ And something new for our clients: we now offer Spa Hair treatments and Massages. You get 10% off your first visit to either one, in case you'd like to try it someday 💛",
            consultaSvc: 'Assessment consultation (20 min)',
            consultaPrice: 'The price is confirmed at the salon based on what you decide',
            consultaNote: "If after the consultation you decide to get the recommended service, you'll already have time reserved right after, no waiting.",
        },
        ru: {
            header: n => `✅ Отлично, ${n}. Запись подтверждена:`,
            cancel: '🙏 Если нужно отменить или изменить, предупредите нас за 48ч.',
            more: 'Могу ещё чем-то помочь?',
            upsell: s => `Кстати, пока вы у нас, можно добавить ${s.toLowerCase()}. Добавить?`,
            upsellCuidado: s => `Осветление — агрессивный процесс для волос, поэтому советуем дополнить его услугой «${s}»: волосы будут восстановлены и станут крепче 💛 Добавить к записи?`,
            spaPromo: '✨ И новинка для наших клиенток: теперь у нас есть Spa Hair (уход за волосами) и Массажи. На первое посещение любого из них — скидка 10%, если захотите попробовать 💛',
            consultaSvc: 'Консультация-оценка (20 мин)',
            consultaPrice: 'Цена подтверждается в салоне в зависимости от вашего решения',
            consultaNote: 'Если после консультации вы решите сделать рекомендованную услугу, у вас уже будет зарезервировано время сразу после, без ожидания.',
        },
        uk: {
            header: n => `✅ Чудово, ${n}. Запис підтверджено:`,
            cancel: '🙏 Якщо потрібно скасувати або змінити, попередьте нас за 48год.',
            more: 'Чим ще можу допомогти?',
            upsell: s => `До речі, поки ви у нас, можна додати ${s.toLowerCase()}. Додати?`,
            upsellCuidado: s => `Освітлення — агресивний процес для волосся, тому радимо доповнити його послугою «${s}»: волосся буде відновлене й міцніше 💛 Додати до запису?`,
            spaPromo: '✨ І новинка для наших клієнток: тепер у нас є Spa Hair (догляд за волоссям) і Масажі. На перший візит до будь-якого з них — знижка 10%, якщо захочете спробувати 💛',
            consultaSvc: 'Консультація-оцінка (20 хв)',
            consultaPrice: 'Ціна підтверджується в салоні залежно від вашого рішення',
            consultaNote: 'Якщо після консультації ви вирішите зробити рекомендовану послугу, у вас вже буде зарезервовано час одразу після, без очікування.',
        },
    };
    const t = T[lang] || T.es;

    const svcBase = isConsulta ? t.consultaSvc : servicio;
    const svcLine = stylistNombre ? `${svcBase} con ${stylistNombre}` : svcBase;
    const priceLine = isConsulta
        ? t.consultaPrice
        : (precio != null && duracion != null)
            ? `${precio}€ · ${duracion} minutos`
            : precio != null ? `${precio}€` : duracion != null ? `${duracion} minutos` : null;

    const lines = [t.header(nombre || ''), ''];
    lines.push(`📅 ${fechaStr}`);
    lines.push(`${emoji} ${svcLine}`);
    if (priceLine) lines.push(`💰 ${priceLine}`);
    if (dir) lines.push(`📍 ${dir}`);
    if (isConsulta) {
        lines.push('');
        lines.push(t.consultaNote);
    }
    lines.push('');
    lines.push(t.cancel);
    // La promo va ANTES de la pregunta de upselling y redactada como afirmación (sin
    // interrogación) para que un "sí" de la clienta siga siendo, sin ambigüedad, la
    // respuesta al upselling.
    if (spaPromo) {
        lines.push('');
        lines.push(t.spaPromo);
    }
    if (upsellSuggestion) {
        lines.push('');
        lines.push(upsellTono === 'cuidado_decoloracion'
            ? t.upsellCuidado(upsellSuggestion)
            : t.upsell(upsellSuggestion));
    } else {
        lines.push('');
        lines.push(t.more);
    }
    return lines.join('\n');
}

// Mensaje de rectificación cuando la red anti-cita-fantasma pilla al bot afirmando una
// reserva que NO está escrita en Supabase (bug 30/07/2026: "Citas reservadas: 15:00 masaje,
// 16:00 pedicura" con solo la de las 16:00 guardada).
//
// Reglas de este mensaje: (1) enumera EXCLUSIVAMENTE las citas que existen de verdad en la
// BD, nunca las que el LLM creía tener; (2) dice sin rodeos que lo demás no ha quedado
// reservado; (3) reabre la conversación para apuntarlo bien. Nunca cancela ni toca la cita
// que sí está guardada.
// `citasReales`: [{ servicio, fecha, hora }] ya en hora local de negocio.
function buildCitaFantasmaMsg({ citasReales = [], language } = {}) {
    const lang = ['es', 'en', 'ru', 'uk'].includes(language) ? language : 'es';
    const T = {
        es: {
            conCitas: 'Perdona, me he explicado mal 😅 De momento lo único que tengo apuntado es:',
            sinCitas: 'Perdona, me he explicado mal 😅 Todavía no tengo ninguna cita apuntada a tu nombre.',
            resto: 'Lo demás NO ha quedado reservado. ¿Te busco hueco ahora y lo dejamos cerrado?',
        },
        en: {
            conCitas: "Sorry, I explained that badly 😅 Right now the only thing I have booked is:",
            sinCitas: "Sorry, I explained that badly 😅 I don't have any appointment booked under your name yet.",
            resto: "The rest was NOT booked. Shall I find you a time now and get it sorted?",
        },
        ru: {
            conCitas: 'Извините, я неточно выразилась 😅 Пока у меня записано только это:',
            sinCitas: 'Извините, я неточно выразилась 😅 Пока на ваше имя нет ни одной записи.',
            resto: 'Остальное НЕ забронировано. Подобрать время сейчас и всё оформить?',
        },
        uk: {
            conCitas: 'Вибач, я неточно висловилася 😅 Наразі записано лише це:',
            sinCitas: 'Вибач, я неточно висловилася 😅 Наразі на твоє ім\'я немає жодного запису.',
            resto: 'Решта НЕ заброньована. Підібрати час зараз і все оформити?',
        },
    };
    const t = T[lang] || T.es;
    const lines = [];
    if (citasReales.length) {
        lines.push(t.conCitas);
        lines.push('');
        for (const c of citasReales) {
            lines.push(`📅 ${_formatFechaHora(c.fecha, c.hora, lang)} — ${c.servicio || ''}`.trim());
        }
        lines.push('');
    } else {
        lines.push(t.sinCitas);
        lines.push('');
    }
    lines.push(t.resto);
    return lines.join('\n');
}

// Clasifica una variante de largo de pelo a partir del NOMBRE del servicio.
// Vía 1 (idéntica a la de siempre): sufijo numérico — "Largo 3", "Mechas 2",
// "Color completo largo 1" → nivel = el dígito final. Cero cambio de comportamiento
// para las categorías que ya usan esta convención (Airtouch, Alisado, Deco, Mechas
// clásicas, Color Premium).
// Vía 2 (solo si NO hay dígito): palabras descriptivas de longitud, mismo vocabulario
// que extractLargoPelo — cubre categorías como "Mechas Balayage" que en catálogo usan
// nombres humanos ("Cabello corto/medio/largo", "XL / cambio importante") en vez de
// "Largo N". Devuelve 1-4 o null si el nombre no clasifica en ningún nivel.
function classifyLargoVariant(nombre) {
    if (!nombre) return null;
    const norm = normalizeText(nombre);
    // El dígito debe ir separado por espacio (token propio: "Largo 3", "Mechas 2"),
    // no embebido en un código alfanumérico ("K18") — si no, "K18" clasificaría como
    // nivel 18.
    const digitMatch = norm.match(/(?:^|\s)(\d+)\s*$/);
    if (digitMatch) return parseInt(digitMatch[1], 10);
    if (/\b(muy largo|xl|cambio importante)\b/.test(norm)) return 4;
    if (/\blargo\b/.test(norm)) return 3;
    if (/\b(medio|media)\b/.test(norm)) return 2;
    if (/\bcorto\b/.test(norm)) return 1;
    return null;
}

// Detects if text mentions a service category with hair-length variants (Largo 1/2/3/4,
// o nombres descriptivos equivalentes como "Cabello corto/medio/largo").
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
        services.filter(s => classifyLargoVariant(s.nombre) != null).length >= 2
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

// ─── Cortes: árbol de género/tipo (Sante) ───────────────────────────────────
// El corte se pregunta en varios pasos (género → tipo) y cada respuesta suelta
// ("mujer", "con Dyson") no casa contra el catálogo por sí sola. Estos detectores
// deterministas permiten a bot.js resolver el servicio en el MISMO turno, sin el
// desfase de depender de que el LLM devuelva datos.servicio. Espejo de detectLargoCategory.

// "un corte" genérico SIN tipo especificado → dispara el árbol hombre/niño/mujer.
function detectCorteGenerico(text) {
    if (!text) return false;
    const t = normalizeText(text);
    const mencionaCorte = /\b(corte|cortar|cortarme|cortarte|cortarse|cortarlo|cortame|haircut|cut)\b/.test(t);
    if (!mencionaCorte) return false;
    // Si ya especifica el tipo, NO es genérico: lo resuelve extractServiceFromText.
    const tipoEspecificado = /\b(hombre|caballero|mujer|femenin|ni[ñn]o|ni[ñn]a|infantil|secado|dyson)\b/.test(t);
    return !tipoEspecificado;
}

// Paso 1 del árbol: ¿hombre, niño o mujer? Devuelve 'hombre' | 'nino' | 'mujer' | null.
// Se evalúa niño primero para que "para mi niño"/"para mi hijo" no caiga en la rama
// mujer por el marcador "para mi".
function detectCorteGenero(text) {
    if (!text) return null;
    const t = normalizeText(text);
    if (/\b(ni[ñn]o|ni[ñn]a|nino|nina|infantil|peque|hijo|hija)\b/.test(t)) return 'nino';
    if (/\b(hombre|caballero|chico|masculin|senor|varon)\b/.test(t)) return 'hombre';
    if (/\b(mujer|femenin|chica|soy yo|yo misma|para mi|es para mi|para mi misma)\b/.test(t)) return 'mujer';
    return null;
}

// Paso 2 (mujer): ¿secado o Dyson? Devuelve 'dyson' | 'secado' | null.
function detectCorteMujerTipo(text) {
    if (!text) return null;
    const t = normalizeText(text);
    if (/\bdyson\b/.test(t)) return 'dyson';
    if (/\b(secado|secar|secador|brushing)\b/.test(t)) return 'secado';
    return null;
}

// Paso 2 (niño): ¿infantil hasta 8 años o corte de niño normal? Devuelve 'infantil' | 'normal' | null.
function detectCorteNinoTipo(text) {
    if (!text) return null;
    const t = normalizeText(text);
    if (/\b(infantil|hasta 8|menor de 8|mas peque|el pequeno|el primero|primero|primera)\b/.test(t)) return 'infantil';
    if (/\b(normal|mayor|el otro|el segundo|segundo|segunda)\b/.test(t)) return 'normal';
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
    // "Eliminación del pigmento" es el nombre nuevo del servicio (las clientas
    // españolas no entendían "salida de negro"). Mantenemos las variantes antiguas:
    // muchas clientas siguen pidiéndolo con las palabras de siempre. La clave interna
    // ('salida_negro' → motivo 'consulta_salida_negro') NO cambia: ya está escrita en
    // contacts.escalation_reason y pending_actions de escaladas históricas.
    if (/salida de negro|arrastre de color|quitar tinte negro|subir tono desde negro|quitar el negro|salir del negro|eliminacion del pigmento|eliminar el pigmento|quitar el pigmento|quitar pigmento/.test(t)) {
        return { type: 'salida_negro' };
    }
    return null;
}

// Detecta la intención REACTIVA de "quiero que me asesoren / no sé qué servicio quiero".
// Solo intención de ELECCIÓN DE SERVICIO — NUNCA de largo de pelo. El gating (que solo
// se llame cuando no hay servicio concreto detectado ni flujo de largo/corte pendiente)
// vive en bot.js; aquí no se incluye ningún patrón basado solo en "corto/largo" ni en
// "no sé" a secas, para que "no sé si prefiero corto o largo" NO dispare.
function detectConsultaValoracion(text) {
    if (!text) return false;
    const t = normalizeText(text);
    const patterns = [
        // ES — no sé qué servicio / qué hacerme
        /no se (que|q) (hacerme|me hago|me pongo|ponerme|quiero|necesito|servicio|elegir|pedir)/,
        /no se (que|q) me (queda|favorece|sienta|va) (mejor|bien)/,
        /no tengo ni idea de (que|q)/,
        // ES — pedir recomendación / asesoramiento
        /que me (recom|asesor|aconsej)/,
        /me (podeis|podrian|pueden|podriais) (recom|asesor|aconsej)/,
        /(quiero|queria|necesito|busco|me gustaria) (que me )?(recom|asesor|aconsej|una consulta|la consulta|consulta|asesoramiento|valoracion)/,
        /\basesoramiento\b/,
        /me aconsej(en|eis|ais)\b/,
        /me ayud(en|eis|ais|e|as) a (decidir|elegir|escoger)/,
        /consulta de valoracion/,
        /pedir (una |la )?consulta/,
        // ES — que lo valoren en persona
        /ver(lo)? en persona/,
        /que lo ve(ais|an)/,
        // EN
        /don.?t know what to (do|get)/,
        /not sure what i (want|need)/,
        /can you (recommend|advise|suggest)/,
        /\b(recommend me|need advice|a consultation)\b/,
        // RU
        /не знаю что (мне )?(сделать|выбрать|хочу)/,
        /(посоветуйте|консультаци|порекоменд)/,
        // UK
        /не знаю що (мені )?(зробити|вибрати|хочу)/,
        /(порадьте|консультаці|порекоменд)/,
    ];
    return patterns.some(re => re.test(t));
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
    if (/\b(medio|media|normal|medium|espalda|escapula|mid)\b/.test(t)) return 2;
    if (/(до лопаток|средн|середн)/.test(t)) return 2;
    if (/\b(corto|short|hombros)\b/.test(t)) return 1;
    if (/(до плечей|коротк)/.test(t)) return 1;
    return null;
}

// ─── Facturación por estilista ────────────────────────────────────────────────
// El informe de facturación no puede leer un precio de appointments (no existe esa
// columna): lo RECALCULA cruzando appointments.service contra el catálogo de precios
// (agent_configs.services). El campo service se guardó con buildFullServiceName para
// el servicio principal y el nombre crudo de cada upsell, unidos por " + ".

// Match DETERMINISTA (sin difuso) de un nombre contra el catálogo: (a) nombre completo
// generado por buildFullServiceName (cubre el servicio principal, ej. "Mechas Airtouch
// Largo 2"); (b) nombre crudo de catálogo (cubre los upsells, ej. "K18"). Se usa aparte
// del difuso porque es lo único fiable para decidir si un tramo que contiene " + " es UN
// servicio de catálogo o dos servicios unidos por el separador.
// Devuelve TODAS las entradas de catálogo que casan de forma exacta con el nombre, en el
// mismo orden de preferencia que resolveCatalogEntryExact: primero las que casan por nombre
// completo, y solo si ninguna casa, las que casan por nombre crudo. Se separa de la
// resolución porque el nombre crudo NO es único en el catálogo real de Sante ("Largo 2"
// existe en 4 categorías con precios 145/160/220/260) y facturar necesita saberlo.
function findCatalogEntriesExact(name, catalog) {
    if (!name || !Array.isArray(catalog) || !catalog.length) return [];
    const target = normalizeText(name);
    // (a) nombre completo generado
    const byFull = catalog.filter(svc => normalizeText(buildFullServiceName(svc, catalog)) === target);
    if (byFull.length) return byFull;
    // (b) nombre crudo del catálogo
    return catalog.filter(svc => normalizeText(svc.nombre) === target);
}

function resolveCatalogEntryExact(name, catalog) {
    return findCatalogEntriesExact(name, catalog)[0] || null;
}

// Precios DISTINTOS entre varias entradas que casan con el mismo nombre. Si todas cuestan
// lo mismo ("Hombre" son 25 € tanto en Cortes como en Manicura/Pedicura) la ambigüedad no
// afecta al importe y no hay nada que avisar; solo importa cuando el precio difiere.
function distinctPrices(entries) {
    return [...new Set(
        (entries || [])
            .map(e => Number(e?.precio))
            .filter(n => Number.isFinite(n))
    )];
}

// Resuelve la entrada de catálogo de UN nombre de servicio ya guardado. Cascada
// determinista → difusa: primero resolveCatalogEntryExact (a/b) y, si falla, fallback
// difuso vía extractServiceFromText (separadores, sinónimos, variantes).
// Devuelve el objeto de catálogo o null.
function resolveServiceCatalogEntry(name, catalog) {
    if (!name || !Array.isArray(catalog) || !catalog.length) return null;
    return resolveCatalogEntryExact(name, catalog) || extractServiceFromText(name, catalog) || null;
}

// Parte el string de appointments.service en NOMBRES de servicio. No basta con partir por
// " + ": hay servicios de catálogo que llevan ese separador dentro del nombre ("Pedicura +
// esmaltado", "Manicura + gel"). Un split ciego los trocea, el trozo suelto queda unmatched
// y la cita entera cae a "sin poder calcular" → su importe DESAPARECE del informe.
// Recomponemos de izquierda a derecha con el tramo más largo que matchee de forma
// determinista ("longest match"), así "Pedicura + esmaltado + K18" da dos servicios y no tres.
function splitServiceNames(serviceString, catalog) {
    const parts = String(serviceString || '')
        .split(' + ')
        .map(s => s.trim())
        .filter(Boolean);

    const names = [];
    for (let i = 0; i < parts.length; i++) {
        let taken = 1;
        // De más largo a más corto; solo tramos de 2+ partes (1 parte es el caso por defecto).
        for (let j = parts.length; j > i + 1; j--) {
            if (resolveCatalogEntryExact(parts.slice(i, j).join(' + '), catalog)) {
                taken = j - i;
                break;
            }
        }
        names.push(parts.slice(i, i + taken).join(' + '));
        i += taken - 1;
    }
    return names;
}

// Descompone el string appointments.service en segmentos y clasifica cada uno.
// Devuelve { totalConIva, segments: [{ name, precio, status }] } donde status es
// 'ok' (precio numérico, suma), 'unpriced' (matchea pero precio null, ej. Consulta —
// NO suma), 'unmatched' (sin entrada de catálogo — NO suma) o 'ambiguous' (el nombre casa
// con varias entradas de PRECIOS DISTINTOS — NO suma). totalConIva es la suma
// de los segmentos 'ok' (el precio del catálogo ya incluye IVA).
//
// 'ambiguous' existe porque cobrar el primer match era peor que no cobrar: un "Largo 2"
// suelto casa con 4 entradas (145/160/220/260 €) y se facturaba la primera —hasta 115 € de
// desvío— marcada como cifra buena. Una cita con un segmento ambiguo cae al contador de
// "sin poder calcular", que el panel ya muestra: un importe dudoso se comunica como dudoso.
function computeServiceBilling(serviceString, catalog) {
    const segments = splitServiceNames(serviceString, catalog).map(name => {
        const exactas = findCatalogEntriesExact(name, catalog);
        const precios = distinctPrices(exactas);
        if (precios.length > 1) {
            return { name, precio: null, status: 'ambiguous', precios: precios.sort((a, b) => a - b) };
        }
        const entry = exactas[0] || extractServiceFromText(name, catalog) || null;
        if (!entry) return { name, precio: null, status: 'unmatched' };
        if (entry.precio == null || !Number.isFinite(Number(entry.precio))) {
            return { name, precio: null, status: 'unpriced' };
        }
        return { name, precio: Number(entry.precio), status: 'ok' };
    });
    const totalConIva = segments.reduce((sum, s) => s.status === 'ok' ? sum + s.precio : sum, 0);
    return { totalConIva, segments };
}

const _round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Centinela del grupo "citas sin estilista asignada". Es la clave del bucket del informe,
// el valor del filtro en el selector del panel y el valor aceptado por ?stylist= en la API:
// una sola constante para que las tres capas no se desincronicen.
const NO_STYLIST_KEY = '__sin_estilista__';

// Filtra las citas de UNA estilista antes de que entren al motor de cálculo. El filtro
// NUNCA recalcula importes: solo reduce el conjunto de entrada, así el informe filtrado
// sale de la misma aritmética que la fila de esa estilista en el informe de "todas".
// stylistId null/undefined/'' = sin filtro; NO_STYLIST_KEY = citas con stylist_id null.
function filterAppointmentsByStylist(appointments, stylistId) {
    const list = appointments || [];
    if (stylistId == null || stylistId === '') return [...list];
    if (stylistId === NO_STYLIST_KEY) return list.filter(a => !a.stylist_id);
    return list.filter(a => a.stylist_id === stylistId);
}

// Opciones del selector de estilista del informe. Unión de (a) las estilistas activas de
// la org y (b) las que aparecen en el informe — (b) cubre a una estilista desactivada que
// aún tenga citas facturables en el periodo, que si no desaparecería del selector y su
// dinero quedaría sin poder inspeccionarse. Siempre añade el grupo "sin estilista" al final
// para que la suma de las opciones individuales cuadre con el total de "todas".
function buildBillingStylistOptions(stylists, estilistasDelInforme) {
    const byId = new Map();
    for (const s of (stylists || [])) {
        if (!s || !s.id) continue;
        byId.set(s.id, { stylist_id: s.id, stylist_name: s.name || null });
    }
    for (const e of (estilistasDelInforme || [])) {
        if (!e || !e.stylist_id || byId.has(e.stylist_id)) continue;
        byId.set(e.stylist_id, { stylist_id: e.stylist_id, stylist_name: e.stylist_name || null });
    }
    const opciones = [...byId.values()].sort((a, b) =>
        String(a.stylist_name || '').localeCompare(String(b.stylist_name || ''), 'es')
    );
    opciones.push({ stylist_id: NO_STYLIST_KEY, stylist_name: 'Sin estilista asignada' });
    return opciones;
}

// Construye el informe agregado por estilista a partir de las citas COMPLETED del
// periodo (ya filtradas y con { appointment_id, service, stylist_id, stylist_name,
// starts_at, cliente }) y el catálogo. Cada cita cuenta como "sin poder calcular" si
// ALGÚN segmento suyo es unpriced/unmatched (su total sería incorrecto). Los precios
// del catálogo incluyen IVA → base sin IVA = total / (1 + ivaRate).
function buildStylistBillingReport(appointments, catalog, { ivaRate = 0.21 } = {}) {
    const NO_STYLIST = NO_STYLIST_KEY;
    const buckets = new Map();

    const getBucket = (key, name) => {
        if (!buckets.has(key)) {
            buckets.set(key, {
                stylist_id: key === NO_STYLIST ? null : key,
                stylist_name: name || (key === NO_STYLIST ? 'Sin estilista asignada' : null),
                numCitas: 0,
                sinCalcular: 0,
                totalConIva: 0,
                citas: [],
            });
        }
        return buckets.get(key);
    };

    for (const appt of (appointments || [])) {
        const key = appt.stylist_id || NO_STYLIST;
        const bucket = getBucket(key, appt.stylist_name);
        const { totalConIva: recalculado, segments } = computeServiceBilling(appt.service, catalog);

        // El importe CONGELADO al completar la cita manda sobre el recálculo. Sin él, subir un
        // precio en el catálogo —o editar el `service` de una cita pasada— reescribía la
        // facturación de un periodo ya cerrado. Solo se recalcula cuando no hay snapshot:
        // citas anteriores a la auditoría, o servicios que no se pudieron valorar.
        const congelado = Number(appt.precio_facturado);
        const tieneSnapshot = !!appt.facturado_at && Number.isFinite(congelado);
        const calculable = tieneSnapshot || (segments.length > 0 && segments.every(s => s.status === 'ok'));
        const totalConIva = tieneSnapshot ? congelado : recalculado;

        bucket.numCitas += 1;
        if (calculable) {
            bucket.totalConIva += totalConIva;
        } else {
            bucket.sinCalcular += 1;
        }
        bucket.citas.push({
            appointment_id: appt.appointment_id,
            cliente: appt.cliente || null,
            service: appt.service || null,
            starts_at: appt.starts_at || null,
            precio: calculable ? _round2(totalConIva) : null,
            calculable,
            congelado: tieneSnapshot,
            segments,
        });
    }

    const estilistas = [...buckets.values()].map(b => {
        const totalConIva = _round2(b.totalConIva);
        const totalSinIva = _round2(totalConIva / (1 + ivaRate));
        return {
            ...b,
            totalConIva,
            totalSinIva,
            iva: _round2(totalConIva - totalSinIva),
        };
    }).sort((a, b) => b.totalConIva - a.totalConIva);

    // Los totales globales son la SUMA de las filas ya redondeadas (no se rederivan del
    // total global): así el informe de "todas" cuadra al céntimo con la suma de los informes
    // individuales por estilista, y la tabla suma exactamente lo que muestran las KPI.
    const totalConIva = _round2(estilistas.reduce((s, e) => s + e.totalConIva, 0));
    const totalSinIva = _round2(estilistas.reduce((s, e) => s + e.totalSinIva, 0));
    const iva = _round2(estilistas.reduce((s, e) => s + e.iva, 0));
    const numCitas = estilistas.reduce((s, e) => s + e.numCitas, 0);
    const sinCalcularTotal = estilistas.reduce((s, e) => s + e.sinCalcular, 0);

    return {
        estilistas,
        totales: {
            totalConIva,
            totalSinIva,
            iva,
            numCitas,
        },
        sinCalcularTotal,
        ivaRate,
    };
}

module.exports = {
    normalizeText,
    detectLanguage,
    classifyIncomingMedia,
    unsupportedMediaMsg,
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
    extractServiceCategoriesFromText,
    extractAnchorConstraint,
    buildFullServiceName,
    humanizeLargoLabel,
    extractStylistFromText,
    resolveStylistMention,
    getMissingFieldsSante,
    hasApellido,
    extractQuickDataSante,
    extractDateSignalSante,
    detectNoPreferenceSignal,
    wantsAnotherBooking,
    wantsRestart,
    detectGuestBooking,
    extractGuestName,
    matchUpsellSuggestion,
    matchUpsellRule,
    resolveServiceDurationMin,
    shouldDiscardUpsellForClosing,
    buildSanteConfirmationMessage,
    buildCitaFantasmaMsg,
    isSpaPromoCategory,
    hasPreviousSpaOrMassage,
    buildSpaPromoNote,
    detectLargoCategory,
    extractLargoPelo,
    classifyLargoVariant,
    extractMechasClasicasTipo,
    detectCorteGenerico,
    detectCorteGenero,
    detectCorteMujerTipo,
    detectCorteNinoTipo,
    detectConsultaService,
    detectConsultaValoracion,
    // Facturación por estilista
    resolveServiceCatalogEntry,
    findCatalogEntriesExact,
    computeServiceBilling,
    buildStylistBillingReport,
    filterAppointmentsByStylist,
    buildBillingStylistOptions,
    NO_STYLIST_KEY,
};
