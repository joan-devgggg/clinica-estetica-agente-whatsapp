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

// ─── Patrones cirílicos: cómo escribirlos para que casen ─────────────────────
//
// Un patrón cirílico escrito "como se escribe" no casa NUNCA contra texto normalizado. Hay
// dos causas independientes y las dos han mordido ya en producción:
//
//   1) normalizeText descompone en NFD y borra los diacríticos combinantes. En cirílico eso
//      no es un acento decorativo, es parte de la letra:
//        й = и + breve  → и      ё = е + diéresis → е
//        ї = і + diéresis → і    ў = у + breve   → у
//      Así que el texto de la clienta llega como 'посоветуите', y un patrón que diga
//      'посоветуйте' no lo encuentra jamás.
//
//   2) \b en JavaScript es ASCII: \b(любое время)\b no casa aunque el texto sea exactamente
//      "любое время", porque no hay frontera de palabra ASCII junto a una letra cirílica.
//      Esto mata también los literales BIEN escritos si están dentro de un \b(...)\b.
//
// Regla: todo patrón cirílico se compila con este helper, que normaliza cada literal y no
// pone \b. Nunca se escriben a mano en su forma descompuesta — sería ilegible y frágil.
//
// Recibe LITERALES, no fragmentos de regex: se escapan los metacaracteres. Sin eso, un
// '¿подійде?' colado en la lista convertiría la letra anterior en opcional en vez de buscar
// el signo, que es justo el tipo de fallo silencioso que este helper existe para evitar.
function buildCyrillicRe(literales) {
    const escapar = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const alternativas = [...new Set(literales.map(normalizeText).filter(Boolean))];
    return new RegExp(alternativas.map(escapar).join('|'));
}

// Prefijo de los teléfonos del ARNÉS DE PRUEBAS. Todo lo que empiece por aquí es de una
// conversación simulada y NO puede recibir un mensaje de campaña.
//
// `999` es un código de país SIN ASIGNAR en E.164: no es de nadie y no puede serlo, así que
// ningún número real puede colisionar con el rango. Ese es todo el criterio — el rango que se
// usaba antes (`3460099xxxx`) tenía la forma de un móvil español perfectamente plausible, y
// los residuos que dejaba el arnés entraban en la audiencia 'todos' como una clienta más.
// A 05/08/2026 quedaba uno en Sante (34600991016, del escenario de la ráfaga; reaparecía en
// cada corrida) y otro de una prueba vieja en San Remo (34600999999, de junio).
//
// Vive aquí, y no en el arnés, porque lo tienen que compartir DOS sitios que no se hablan: el
// que los genera (tests/verify-sante-robustez-llm.js) y el que los excluye de la audiencia
// (db.getBroadcastRecipients). Si cada uno lleva su copia, el día que uno cambie el otro deja
// de proteger sin que nada lo delate.
const TEST_PHONE_PREFIX = '999';

// Los cuatro idiomas que el salón sabe hablar. Es la lista que valida lo que entra por el
// panel y la que eligen los constructores de mensajes; vivía copiada en seis sitios.
const IDIOMAS_SOPORTADOS = ['es', 'en', 'ru', 'uk'];

// De dónde salió `contacts.language`. La columna mezcla tres calidades muy distintas y hasta
// ahora nada las separaba: a 05/08/2026, de 720 fichas de Sante, ~20 traían un idioma
// observado en conversación, 184 uno deducido del nombre y ~516 el 'es' del INSERT que nadie
// eligió. Las tres se usaban igual — para elegir plantilla de campaña y para decirle al LLM
// "último idioma detectado" —, así que un default se comportaba como una observación.
//
//   observed → la clienta escribió y se detectó (detectLanguage o el LLM), o lo fijó una
//              persona desde la ficha del panel. Es el único que se puede afirmar.
//   inferred → conjetura del script de heurística por nombre. Vale como punto de partida,
//              pero no distingue ruso de ucraniano y se equivoca con nombres neutros.
//   default  → el 'es' del INSERT. No es un idioma: es la ausencia de uno.
//
// Vive en `contacts.metadata.language_source`, no en una columna nueva, para que sea
// segmentable en SQL (`metadata->>'language_source'`) sin migrar el esquema.
const LANGUAGE_SOURCES = ['observed', 'inferred', 'default'];

// Fuente del idioma de una fila de `contacts`, con dos escalones de respaldo para las filas
// que aún no tienen la marca (todo lo escrito antes de 05/08/2026).
//
// El segundo escalón es el que importa: sin marca, un idioma que NO es 'es' no pudo salir del
// default —el default es siempre 'es'—, así que llegó por inferencia o por observación y se
// respeta. Un 'es' sin marca sí es indistinguible de un default, y estadísticamente casi
// siempre lo es (516 de 534 en Sante), así que se trata como tal. El coste de equivocarse ahí
// es un turno en el que el LLM decide el idioma leyendo el mensaje —que es lo que hace bien—
// y a partir de ese turno la ficha queda marcada 'observed'. Se corrige solo.
function resolveLanguageSource(row) {
    const meta = (row?.metadata && typeof row.metadata === 'object') ? row.metadata : {};
    if (LANGUAGE_SOURCES.includes(meta.language_source)) return meta.language_source;
    if (meta.language_inferred) return 'inferred';
    return (row?.language && row.language !== 'es') ? 'observed' : 'default';
}

// Ucraniano SIN ninguna de sus letras exclusivas (і ї є ґ).
//
// La regla de las letras es correcta pero asimétrica: cuando aparecen, acierta; cuando no,
// cae en 'ru' por defecto. Un 'uk' mal puesto no existe, un 'ru' mal puesto sí — y toca
// justo a las dos frases que más se escriben, el saludo y el gracias. Caso real: el
// contacto 34696073110 escribió «Доброго дня» y quedó marcado 'ru'.
//
// Se compila con buildCyrillicRe por las dos razones de siempre: normalizeText descompone
// (добрий → добрии, porque й = и + breve) y \b es ASCII, así que un \b(…)\b no casaría
// nunca contra cirílico. Por eso también se testea contra normalizeText(raw), no contra raw.
//
// La lista es corta a propósito: al no haber \b, cada literal casa como SUBCADENA, así que
// solo entran frases que no existen en ruso. Se dejan fuera las tentadoras pero ambiguas
// («на жаль», que contiene el «жаль» ruso).
//
// «доброго дня» es el único con solape real —el ruso lo usa, aunque su forma corriente es
// «добрый день»—. Entra igual porque el error se corrige solo: detectLanguage se ejecuta en
// CADA mensaje y manda el último, así que una rusa que salude así vuelve a 'ru' en cuanto
// escriba cualquier otra cosa.
const UCRANIANO_SIN_LETRAS_PROPIAS_RE = buildCyrillicRe([
    'дякую',            // gracias (ru: спасибо)
    'будь ласка',       // por favor (ru: пожалуйста)
    'будь-ласка',       // misma frase con guion: normalizeText no lo quita
    'вітаю',            // hola / enhorabuena — ya lo cazan las letras, aquí por claridad
    'гарного дня',      // que tengas buen día (ru: хорошего дня)
    'доброго дня',      // buenos días — ver nota de arriba
    'добрий день',      // buenos días (ru: добрый день — и frente a ы)
    'доброго ранку',    // buenos días (ru: доброе утро)
    'доброго вечора',   // buenas tardes (ru: добрый вечер)
    'до побачення',     // adiós (ru: до свидания)
    'вибачте',          // perdona (ru: извините)
    'перепрошую',       // disculpa (ru: прошу прощения)
    'гаразд',           // de acuerdo (ru: хорошо / ладно)
]);

// ─── Detección de idioma (heurística, salón) ────────────────────────────────
// Defensa para BUG 4: fija el idioma a partir del texto de la clienta ANTES de llamar
// al LLM, para que los mensajes de fallback/límite salgan en su idioma aunque OpenAI
// falle o tarde. El LLM sigue siendo la fuente autoritativa (idioma_detectado) y puede
// corregir esto en el mismo turno. Devuelve 'es'|'en'|'ru'|'uk' o null si no es seguro.
function detectLanguage(text) {
    if (!text || typeof text !== 'string') return null;
    const raw = text.trim();
    if (!raw) return null;

    // Cirílico → ucraniano si tiene letras propias del ucraniano; si no, si usa una palabra
    // que solo existe en ucraniano; y solo entonces, ruso.
    if (/[а-яёіїєґ]/i.test(raw)) {
        if (/[іїєґ]/i.test(raw)) return 'uk';
        if (UCRANIANO_SIN_LETRAS_PROPIAS_RE.test(normalizeText(raw))) return 'uk';
        return 'ru';
    }

    const t = raw.toLowerCase();
    // Marcadores claros de español (signos, ñ, palabras frecuentes).
    if (/[ñ¿¡]/.test(raw)) return 'es';
    // Los días de la semana entran en las DOS listas. Caso real (05/08/2026): 19542240982,
    // teléfono de EEUU, escribió "Thursday" a secas —el día de su cita— y aquí se devolvía
    // null. Con null el idioma lo decide el LLM… al que se le pasa el idioma que ya tiene la
    // ficha, y esa ficha llevaba el 'es' por defecto del INSERT que nadie eligió: contestó en
    // castellano. La lista tenía tomorrow/today/morning/afternoon pero ningún día, y un día
    // suelto es de las respuestas más frecuentes que hay ("¿qué día te viene bien?").
    // Van los siete en los dos idiomas por simetría: "jueves" a secas tenía el mismo agujero
    // en la dirección contraria (una clienta marcada 'ru' que responde en español).
    // No hay solape entre las dos listas —ningún día español es subcadena de uno inglés ni al
    // revés—, así que ninguno puede activar hasEs y hasEn a la vez.
    const esWords = /\b(hola|buenas|quiero|quería|cita|gracias|por favor|cuánto|cuanto|para|reservar|reserva|qué|que tal|cómo|como estas|necesito|tengo|disponible|mañana|hoy|día|dia|tarde|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/;
    const enWords = /\b(hi|hello|hey|i'?d|i'?m|i want|i would|i need|please|thanks|thank you|appointment|book|booking|available|tomorrow|today|morning|afternoon|how much|can i|could i|would like|my name|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;
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

// Palabras que NUNCA identifican a una persona. Se comprueban TOKEN A TOKEN porque el
// bug de "rubia pero" (03/08/2026) existía justamente por lo contrario: isValidName
// comparaba `invalidWords.includes(lower)` contra la CADENA ENTERA, así que un candidato
// de dos palabras no podía chocar jamás con la lista. La clienta escribió "Soy rubia pero
// me han hecho mechas..." y "rubia pero" acabó en contacts.full_name.
//
// No incluye nombres propios reales que también son palabras comunes (Rosa, Alba, Mar,
// Sol, Luz, Consuelo...): esos deben seguir pasando.
const NAME_STOPWORDS = new Set([
    // artículos, preposiciones, conjunciones, pronombres
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'lo', 'de', 'del', 'al',
    'y', 'e', 'o', 'u', 'pero', 'sino', 'porque', 'pues', 'que', 'si', 'no', 'ni',
    'con', 'sin', 'para', 'por', 'en', 'a', 'ante', 'bajo', 'desde', 'hasta', 'hacia',
    'sobre', 'tras', 'entre', 'segun', 'como', 'cuando', 'donde', 'cual', 'quien',
    'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'me', 'te', 'se', 'le', 'les', 'nos', 'os',
    'yo', 'ella', 'ellos', 'ellas', 'usted', 'ustedes', 'nosotros', 'nosotras',
    'vosotros', 'vosotras', 'este', 'esta', 'esto', 'ese', 'esa', 'eso', 'aquel',
    'muy', 'mas', 'menos', 'tan', 'tanto', 'todo', 'toda', 'todos', 'todas', 'algo',
    'nada', 'alguien', 'nadie', 'otro', 'otra', 'otros', 'otras', 'mismo', 'misma',
    // auxiliares y verbos frecuentes en 1ª persona (los que siguen a "soy"/"me llamo")
    'soy', 'eres', 'es', 'somos', 'sois', 'son', 'era', 'fue', 'sera', 'sido', 'ser',
    'estoy', 'estas', 'esta', 'estamos', 'estan', 'estaba', 'estuve', 'estar',
    'he', 'has', 'ha', 'hemos', 'habeis', 'han', 'habia', 'hubo', 'haber',
    'hago', 'haces', 'hace', 'hacen', 'hacer', 'hecho', 'hice', 'hicieron',
    'tengo', 'tienes', 'tiene', 'tenemos', 'tienen', 'tener', 'tenia',
    'quiero', 'quieres', 'quiere', 'queria', 'querer', 'necesito', 'necesita',
    'puedo', 'puede', 'pueden', 'podria', 'poder', 'gustaria', 'gusta', 'encanta',
    'voy', 'vas', 'va', 'vamos', 'van', 'ir', 'vine', 'vino', 'venir', 'vengo',
    'llevo', 'llevar', 'busco', 'buscar', 'pedir', 'pido', 'dar', 'doy',
    'ver', 'veo', 've', 'saber', 'se', 'sabe', 'digo', 'dice', 'decir', 'dijeron',
    // tiempo
    'hoy', 'ayer', 'manana', 'tarde', 'noche', 'madrugada', 'ano', 'anos', 'mes',
    'meses', 'semana', 'semanas', 'dia', 'dias', 'hora', 'horas', 'minuto', 'minutos',
    'ahora', 'antes', 'despues', 'luego', 'pronto', 'siempre', 'nunca', 'vez', 'veces',
    'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
    // descripción capilar y de la clienta — el dominio que produjo "rubia"
    'rubia', 'rubio', 'morena', 'moreno', 'castana', 'castano', 'pelirroja', 'pelirrojo',
    'canas', 'cana', 'pelo', 'cabello', 'melena', 'raiz', 'raices', 'puntas', 'flequillo',
    'largo', 'larga', 'corto', 'corta', 'medio', 'media', 'liso', 'lisa', 'rizado',
    'rizada', 'ondulado', 'ondulada', 'seco', 'seca', 'graso', 'grasa', 'danado',
    'danada', 'tenido', 'tenida', 'decolorado', 'decolorada', 'natural', 'oscuro',
    'oscura', 'claro', 'clara', 'brillante', 'suave', 'tieso', 'tiesa', 'desastre',
    // cortesía y conversación
    'hola', 'buenas', 'buenos', 'gracias', 'vale', 'ok', 'perfecto', 'genial', 'bien',
    'mal', 'adios', 'porfa', 'favor', 'disculpa', 'perdona', 'perdon', 'oye', 'mira',
    'espana', 'cita', 'reserva', 'precio', 'euros',
]);

// ─── Stopwords RU/UK ─────────────────────────────────────────────────────────
//
// Sacadas de los mensajes REALES de Sante (los 19 en cirílico del historial), no inventadas
// de cabeza: es lo que las clientas escriben de verdad cuando se les pregunta algo.
//
// Van como FRASES aquí y se tokenizan abajo, porque NAME_STOPWORDS se compara token a token
// (isNameToken recibe UNA palabra). Una entrada con espacio dentro del Set sería una entrada
// muerta — el mismo fallo silencioso que el \b ASCII sobre cirílico.
//
// Y se normalizan con normalizeText al construir el Set, nunca a mano: normalizeText
// descompone NFD y borra los diacríticos combinantes, que en cirílico son parte de la letra
// (й→и, ё→е, ї→і). Escribir 'мой' a mano dejaría una entrada que no casa nunca.
const CYRILLIC_STOPWORD_FRASES = [
    // saludos — "Доброго дня", "Добрый день", "День добрый", "Привет"
    'привет', 'здравствуйте', 'добрый день', 'доброго дня', 'день добрый', 'добрий день',
    'добрый вечер', 'доброе утро', 'вітаю',
    // cortesía — "Спасибо большое", "пожалуйста"
    'спасибо', 'спасибо большое', 'пожалуйста', 'дякую', 'будь ласка', 'прошу',
    // sí / no / conformidad — "Ок", "Нет", "Отлично", "конечно"
    'да', 'нет', 'ок', 'окей', 'конечно', 'отлично', 'хорошо', 'так', 'ні', 'добре', 'гаразд',
    // intención — "хочу записаться", "Прошу записать меня", "Перенести", "Можно предложить"
    'хочу', 'хотела', 'записаться', 'записать', 'запишите', 'записатися',
    'можно', 'можете', 'можу', 'перенести', 'предложить', 'нужно', 'треба',
    'буду', 'будет', 'есть', 'подойдет', 'удобно',
    // tiempo — "послеобеденное время", "если есть окошки"
    'сегодня', 'завтра', 'время', 'послеобеденное', 'окошки', 'окно',
    'понедельник', 'вторник', 'среда', 'среду', 'четверг', 'пятница', 'суббота', 'воскресенье',
    // servicios — "мужскую стрижку", "прикорневое окрашивание + мелирование"
    'стрижка', 'стрижку', 'мужскую', 'женскую', 'окрашивание', 'прикорневое',
    'мелирование', 'процедура', 'мастер', 'мастеру', 'волосы', 'волос',
    // pronombres y partículas — "у меня", "я Светлана", "Мой сын будет"
    'я', 'мне', 'меня', 'мой', 'моя', 'мою', 'у', 'это', 'этот', 'эта',
    'всегда', 'только', 'больше', 'очень', 'сын', 'дочь',
];

// Meses en GENITIVO, que es la forma que se usa al decir una fecha ("27 августа"). Estos
// nueve no colisionan con ningún nombre, así que son stopwords sin más.
const MESES_RU_UK_SIN_COLISION = [
    'января', 'февраля', 'апреля', 'июня', 'июля', 'сентября', 'октября', 'ноября', 'декабря',
    'січня', 'лютого', 'квітня', 'червня', 'липня', 'вересня', 'жовтня', 'листопада', 'грудня',
];

// Meses que SÍ colisionan con un nombre de mujer real: Августа, Марта, Майя. No pueden ser
// stopwords fijas — descartarían a una clienta que se presenta. Se tratan como fecha SOLO
// cuando el turno va de elegir día (ver extractQuickDataSante). Medido: "5 августа" ya no se
// capturaba (el fallback exige una sola palabra), pero "августа" a secas sí.
const MESES_RU_UK_AMBIGUOS = new Set(['августа', 'марта', 'мая', 'серпня', 'березня', 'травня']);

// ⚠️ CANDADO. Muchos nombres de mujer rusos y ucranianos SON palabras comunes: Вера (fe),
// Надежда (esperanza), Любовь (amor), Слава (gloria), Злата (oro), Роза, Лилия, Майя,
// Виктория (victoria), Мила, Лада... Meter cualquiera de ellas como stopword haría que el
// bot descartara el nombre de una clienta que se ha presentado bien.
//
// Es la misma disciplina que arriba con Rosa, Alba, Mar, Sol o Luz en español, pero aquí en
// forma de lista comprobable: el test recorre NAME_STOPWORDS y falla si alguna aparece.
const NOMBRES_RU_UK_NUNCA_STOPWORD = [
    'вера', 'надежда', 'любовь', 'слава', 'злата', 'роза', 'лилия', 'майя', 'мила',
    'лада', 'виктория', 'светлана', 'мир', 'віра', 'надія', 'любов', 'квітка', 'оксана',
];

for (const frase of [...CYRILLIC_STOPWORD_FRASES, ...MESES_RU_UK_SIN_COLISION]) {
    for (const token of normalizeText(frase).split(/\s+/)) {
        if (token) NAME_STOPWORDS.add(token);
    }
}

// Alfabeto de un nombre, YA normalizado (normalizeText colapsa й→и, ё→е, ї→і, así que
// esas formas no llegan aquí; se listan igualmente por si alguien salta la normalización).
// El rango а-я cubre ь, ъ, ы y э; і, ї, є y ґ son ucranianas y caen fuera de él.
const LETRAS_NOMBRE = 'a-zñа-яёіїєґ';
// Guion y apóstrofo solo INTERNOS: "Dubois-Moiseaux", "O'Brien", "Гнатюк-Іванова".
const NAME_TOKEN_RE = new RegExp(`^[${LETRAS_NOMBRE}]+(?:['-][${LETRAS_NOMBRE}]+)*$`);
// Sin vocal no es un nombre pronunciable. Las cirílicas hacen falta o "Наталья" se cae.
const NAME_VOWEL_RE = /[aeiouаеиоуыэюяіє]/;
// Signos que ENVUELVEN un token del CRM (".IGHOUBA", "(Blond)") y no son parte del nombre.
const BORDE_PUNTUACION_RE = /^[.,;:()[\]'"«»¡!¿?-]+|[.,;:()[\]'"«»¡!¿?-]+$/g;

// Un token individual plausible como nombre o apellido.
function isNameToken(word) {
    const w = normalizeText(word).replace(BORDE_PUNTUACION_RE, '');
    if (w.length < 2 || w.length > 20) return false;
    if (!NAME_TOKEN_RE.test(w)) return false;
    if (!NAME_VOWEL_RE.test(w)) return false;
    if (NAME_STOPWORDS.has(w)) return false;
    if (w.length > 8 && w.endsWith('me')) return false;   // "recomiendame", "ayudame"
    return true;
}

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
    // \p{L} en vez de una lista de letras latinas: el alfabeto cerrado descartaba cualquier
    // nombre cirílico ("Наталья" nunca se capturaba, y hasApellido decía false sobre
    // "Наталія Зінченко" → el bot pedía un apellido que ya tenía). Guion y apóstrofo se
    // admiten porque son parte de apellidos reales ("Dubois-Moiseaux", "Гнатюк-Іванова").
    // Esto NO afloja la defensa contra "rubia pero": quien filtra es tokens.every(isNameToken)
    // con NAME_STOPWORDS; aquí solo se rechazan dígitos y símbolos.
    if (!/^[\p{L}\s'-]+$/u.test(cleaned)) return false;

    // \p{L}: con la clase latina, "Наталья" contaba 0 letras y se descartaba aquí mismo,
    // después de haber pasado todos los filtros anteriores.
    const letterCount = (cleaned.match(/\p{L}/gu) || []).length;
    if (letterCount < 2) return false;

    const garbagePatterns = [/^[a-z]{1,2}$/, /^([a-z])\1+$/, /^[a-z]{15,}$/];
    if (garbagePatterns.some(p => p.test(lower))) return false;

    // Rechazar verbos con clítico "-me" (ej: "recomiéndame", "ayúdame")
    if (lower.length > 8 && lower.endsWith('me')) return false;

    // Vocales cirílicas incluidas: sin ellas "Наталья" no tiene ninguna vocal "válida".
    if (!NAME_VOWEL_RE.test(normalizeText(cleaned))) return false;

    // Cada palabra debe ser plausible POR SEPARADO. La lista `invalidWords` de arriba
    // sólo mira la cadena entera, así que "rubia pero" la esquivaba entera.
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every(isNameToken);
}

// Rellenos que acaban en `contacts.full_name` y con los que no se puede saludar.
const NOMBRE_RELLENO = new Set(['null', 'undefined', 'cliente', 'clienta', 'sin nombre',
    'n/a', 'na', '-', '?', 'hola']);

/**
 * ¿Hay aquí algo con lo que dirigirse a la clienta? Definición ÚNICA en el repo para la
 * pregunta de SALIDA: "¿puedo poner esto después de Hola?".
 *
 * Cuidado: NO es la misma pregunta que isValidName, y confundirlas rompe algo en los dos
 * sentidos.
 *
 *   · isValidName responde "¿esto que ha ESCRITO la clienta es un nombre?" y tiene que ser
 *     estricto, porque un falso positivo guarda basura como nombre (el bug de "rubia pero").
 *   · isUsableName responde "¿lo que TENGO guardado sirve para saludar?" y tiene que ser
 *     laxo, porque un falso negativo deja a una clienta real sin su recordatorio.
 *
 * Usar isValidName como puerta de salida descartaría 8 nombres reales del CRM de Sante
 * ("Tiffany Dubois-Moiseaux", "Marina Lyon (Blond)", "Karima .IGHOUBA": su regex no admite
 * guion, punto ni paréntesis) y todo el cirílico.
 *
 * Y al revés: usar ESTA como puerta de entrada capturaría "хочу", "привет" o "спасибо" como
 * nombre. Para capturar, isValidName; para saludar, isUsableName.
 */
function isUsableName(nombre) {
    if (typeof nombre !== 'string') return false;
    const limpio = nombre.trim();
    if (limpio.length < 2) return false;
    if (NOMBRE_RELLENO.has(limpio.toLowerCase())) return false;
    if (isValidName(limpio)) return true;                       // atajo: nombre latino limpio
    return (limpio.match(/\p{L}/gu) || []).length >= 2;         // \p{L} → cirílico incluido
}

// Presentación ("soy X", "me llamo X") anclada al inicio del mensaje o de una frase
// dentro de él, admitiendo un saludo delante ("Hola, buenas tardes, soy Ana").
//
// El anclaje es la mitad del arreglo: `indexOf('soy ')` encontraba el patrón en cualquier
// posición, así que "Soy rubia pero me han hecho mechas" y "yo no soy la titular" entraban
// igual. La otra mitad es no calcular índices: antes `idx` se medía sobre
// normalizeText(text) —que colapsa espacios— pero el substring se aplicaba al text CRUDO,
// así que "Hola   ,   me llamo   Lucia" devolvía "amo Lucia". Una sola regex sobre el texto
// crudo elimina los dos sistemas de coordenadas que podían divergir.
const NAME_INTRO_RE = new RegExp(
    '(?:^|[.!?;\\n,])\\s*'
    + '(?:(?:hola|buenas|buenos)\\s*(?:tardes|noches|dias|días)?[\\s,.!¡]*)?'
    // Presentaciones RU/UK, sacadas de cómo escriben las clientas: "Меня зовут X",
    // "Мене звати X", y el "я X" de "( я Светлана)". El literal va SIN \b (es ASCII y no
    // casaría) y sin normalizar, porque este patrón se aplica al texto CRUDO — ninguna de
    // estas formas lleva й ni ё, así que no le afecta la descomposición NFD.
    // "я" solo, anclado a principio de frase, es seguro: "я хочу" produce el candidato
    // "хочу", que ahora es stopword y muere en isValidName.
    + '(?:soy|me\\s+llamo|mi\\s+nombre\\s+es|ll[aá]mame|my\\s+name\\s+is|i\\s*am|i\'m'
    + '|меня\\s+зовут|мене\\s+звати|мене\\s+звуть|моё\\s+имя|моя\\s+ім\'я|я)\\s+'
    + '(.+)',
    'i'
);

// Conectores que CIERRAN el nombre: "Soy Ana y quiero mechas", "Soy rubia pero…".
const NAME_TAIL_BREAK = /\s+(?:y|e|o|pero|sino|porque|aunque|que|para|con|de|desde|hace|cuando|si|and|but)\s+/i;

function extractNameAfterIntro(text) {
    if (!text) return null;
    const m = String(text).match(NAME_INTRO_RE);
    if (!m) return null;
    const clause = m[1].split(/[.,;:!?¡¿\n()]/)[0].split(NAME_TAIL_BREAK)[0];
    const words = clause.trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (!words.length) return null;
    // Si la 2ª palabra no es plausible nos quedamos con la 1ª: así "Soy Ana mañana" da
    // "Ana" (sin apellido → el bot lo pide) en vez de descartar un nombre bueno.
    const kept = (words.length === 2 && !isNameToken(words[1])) ? words.slice(0, 1) : words;
    const cand = kept.join(' ');
    return isValidName(cand) ? cand : null;
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
        const cand = extractNameAfterIntro(text);
        if (cand) result.nombre = cand;
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

// Partición en palabras completas de un texto YA normalizado. Vive a nivel de módulo
// porque lo usan dos pasadas de extractServiceFromText (la de especificidad y la de
// último recurso) y deben partir exactamente igual.
const tokenizeService = s => String(s || '').split(/[^a-z0-9]+/).filter(Boolean);

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

    // Pasada 1a-bis: ESPECIFICIDAD. Un nombre de catálogo que es prefijo de otro más largo
    // ("Consulta" ⊂ "Consulta tricológica con Yulia") gana siempre en la pasada 1a, porque es
    // literalmente un substring de casi cualquier frase que pida el largo — y las pasadas que
    // sí saben distinguirlos (1b y el fuzzy por CATEGORY_KEYWORDS) sólo corren `if (!bestMatch)`,
    // así que nunca se alcanzan. Eso reservaba el bloque de 300 min sin precio en vez de la
    // consulta tricológica de 85€/60min, y de paso excluía a la única tricóloga del salón,
    // porque el filtro de skills pasaba a ser la categoría equivocada (incidente 02/08/2026).
    //
    // Regla general, no caso especial: promovemos el nombre largo sólo si el texto trae su
    // DISCRIMINADOR — el primer token distintivo de la cola, o una palabra coloquial que
    // apunte a su categoría cuando esa categoría tiene un único servicio. Si la clienta no ha
    // dicho la parte que los distingue, gana el corto (que es lo que hay hoy).
    //
    // Sólo PREFIJO, nunca contención genérica: los pares sufijo del catálogo real
    // ("largo" ⊂ "cabello largo") harían saltar de categoría, que es el error que la pasada
    // de último recurso documenta como inaceptable.
    if (bestMatch) {
        const textTokens = new Set(tokenizeService(t));
        const base = normalizeService(bestMatch.nombre);
        const masEspecificos = [];
        for (const svc of servicesCatalog) {
            const n = normalizeService(svc.nombre);
            if (n === base || !n.startsWith(base + ' ')) continue;
            if (nameGroups[n].length !== 1) continue;   // nombre compartido → ya es ambiguo
            const cola = tokenizeService(n.slice(base.length)).filter(w =>
                w.length >= 4 && !SERVICE_MATCH_STOPWORDS.has(w) && !/^\d+$/.test(w));
            if (!cola.length) continue;
            let discrimina = textTokens.has(cola[0]);
            if (!discrimina) {
                const catN = normalizeText(svc.categoria || '');
                if (catCounts[catN] === 1) {
                    const kw = CATEGORY_KEYWORDS.find(k => normalizeText(k.categoria) === catN);
                    if (kw && kw.keywords.some(k2 => t.includes(normalizeText(k2)))) discrimina = true;
                }
            }
            if (discrimina) masEspecificos.push(svc);
        }
        // Más de uno → ambiguo, mejor quedarse con lo que ya había que arriesgar el precio.
        if (masEspecificos.length === 1) {
            bestMatch = masEspecificos[0];
            bestLen = normalizeService(bestMatch.nombre).length;
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
        const tokenize = tokenizeService;
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
            const conMatch = [];
            for (const svc of candidatos) {
                const distintivos = tokenize(normalizeService(svc.nombre)).filter(w =>
                    w.length >= MIN_DISTINCTIVE_TOKEN && !SERVICE_MATCH_STOPWORDS.has(w) && !/^\d+$/.test(w)
                );
                const matched = distintivos.filter(w => textTokens.has(w));
                if (!matched.length) continue;
                conMatch.push({
                    svc,
                    score: matched.length,
                    // Un token que ENCABEZA el nombre identifica el servicio mucho mejor que
                    // uno accesorio: "masaje relajante" debe caer en "Relajante completo",
                    // no en "Holistic relajante Premium". Es el desempate, no el criterio.
                    isPrefix: matched.includes(distintivos[0]),
                    clave: [...new Set(matched)].sort().join('|'),
                    cat: normalizeText(svc.categoria || ''),
                });
            }
            const maxScore = Math.max(0, ...conMatch.map(c => c.score));
            const top = conMatch.filter(c => c.score === maxScore);

            // Empate entre CATEGORÍAS distintas casando EXACTAMENTE los mismos tokens: aquí
            // el desempate por prefijo no está identificando el servicio, sólo está premiando
            // el orden de las palabras dentro del nombre. Y con precios de categorías
            // distintas eso se traduce en dinero: "hidratación" casaba igual de bien con tres
            // servicios (45 / 85 / 110 €) y ganaba el de 110 € por empezar por esa palabra;
            // "detox" elige entre 35 € y 115 € por lo mismo. Preguntar es más barato que
            // cobrar de más en silencio — y desde la fase E un null se recupera con el menú
            // de rescate en vez de convertirse en bucle de repregunta.
            //
            // Dentro de UNA categoría el desempate sigue vivo: ahí las variantes comparten
            // precio y duración de forma razonable, y es el caso que la pasada rescata.
            const mismosTokens = top.length > 1 && top.every(c => c.clave === top[0].clave);
            const variasCategorias = new Set(top.map(c => c.cat)).size > 1;

            if (top.length === 1) {
                bestMatch = top[0].svc;
            } else if (!(mismosTokens && variasCategorias)) {
                // Empate que el prefijo no rompe → mejor seguir sin match que arriesgar
                // un servicio equivocado (precio y duración distintos).
                const conPrefijo = top.filter(c => c.isPrefix);
                if (conPrefijo.length === 1) bestMatch = conPrefijo[0].svc;
            }
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
    // Se parte por espacios Y por los signos que separan partes de un nombre en la ficha del
    // CRM: "Alina Kirsanova(Kashuba)" y "Nataliia ZINCHENKO(newton)" son filas reales. Con un
    // split solo por espacios, "Kirsanova(Kashuba)" era UN token con paréntesis dentro, no lo
    // aceptaba isNameToken, y el bot le pedía a esa clienta un apellido que ya tenía.
    // isNameToken se queda estricto a propósito: aquí la pregunta es "¿este nombre YA
    // guardado trae apellido?", no "¿esto que ha escrito la clienta es un nombre?".
    const tokens = nombre.trim().split(/[\s()[\].,;/]+/).filter(Boolean);
    if (tokens.length < 2) return false;
    // No basta con contar palabras: "rubia pero" tenía dos, así que el bot daba el nombre
    // por completo, dejaba de pedir el apellido Y bot.js impedía al LLM corregirlo con un
    // nombre real de una sola palabra. Dos candados que se abren aquí a la vez.
    // Se exige la PRIMERA plausible y ALGUNA posterior también, para que "María del
    // Carmen Ruiz" siga contando pese al "del".
    return isNameToken(tokens[0]) && tokens.slice(1).some(isNameToken);
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
        const cand = extractNameAfterIntro(text);
        if (cand) result.nombre = cand;
        if (!result.nombre && text.trim().split(/\s+/).length === 1) {
            const word = text.trim();
            // "августа" / "марта" / "мая" son a la vez mes en genitivo y nombre de mujer real
            // (Августа, Марта, Майя), así que no pueden ser stopwords fijas. Se descartan por
            // CONTEXTO: si acabamos de preguntarle qué día le viene bien, una palabra suelta
            // que es un mes es la respuesta a esa pregunta, no cómo se llama.
            // ("5 августа" no llega aquí: este fallback exige una sola palabra.)
            const esMesEnTurnoDeFecha = opts.datePreferenceAsked
                && MESES_RU_UK_AMBIGUOS.has(normalizeText(word));
            if (!esMesEnTurnoDeFecha && isValidName(word) && word.length >= 3) result.nombre = word;
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
const ASAP_TEMPORAL_RE = /\b(lo antes posible|cuanto antes|cu[aá]nto antes|el primer hueco|primer hueco|primera disponibilidad|lo m[aá]s pronto|lo mas pronto|lo m[aá]s r[aá]pido|lo mas rapido|cuando antes|cuanto antes puedas|lo antes que puedas|antes posible|el primero disponible|primer disponible|cualquier hueco|lo m[aá]s pronto posible|lo antes posible que puedas|as soon as possible|asap|earliest)\b/;
const SIN_PREFERENCIA_RE = /\b(el m[aá]s cercano|la m[aá]s cercana|mas cercano disponible|hueco m[aá]s cercano|el hueco m[aá]s cercano|me da igual|me es igual|cualquiera|la que sea|el que sea|no tengo preferencia|sin preferencia|whoever|anyone|any of them)\b/;
// Las alternativas RU/UK vivían dentro de los \b(...)\b de arriba, así que NINGUNA casaba:
// unas por la й descompuesta y las demás por el \b ASCII (ver buildCyrillicRe). Una clienta
// rusa que contestaba "любой" o "как можно скорее" a la pregunta de estilista no activaba
// ni sinPreferencia ni asapTemporal, y el bot volvía a preguntarle a quién quería.
const ASAP_TEMPORAL_CIRILICO_RE = buildCyrillicRe(['как можно скорее', 'якомога швидше']);
const SIN_PREFERENCIA_CIRILICO_RE = buildCyrillicRe([
    'любой', 'любую', 'любое время', 'ближайшее время', 'ближайший', 'будь-хто', 'будь-який',
]);
// Franja del día en RU/UK. Mismo problema y mismo arreglo: "утром" ("por la mañana") no
// fijaba la franja, así que a una clienta que pedía mañana se le ofrecían huecos de tarde.
const PERIODO_MANANA_CIRILICO_RE = buildCyrillicRe(['утром', 'вранці', 'зранку']);
const PERIODO_TARDE_CIRILICO_RE = buildCyrillicRe(['днем', 'днём', 'вдень', 'ввечері', 'увечері', 'вечером']);

// Devuelve { asapTemporal, sinPreferencia } para un texto libre. Ambos flags se evalúan
// SIEMPRE sobre texto normalizado (sin tildes, minúsculas), que es lo que arregla el bug.
function detectNoPreferenceSignal(text) {
    const t = normalizeText(text);
    return {
        asapTemporal: ASAP_TEMPORAL_RE.test(t) || ASAP_TEMPORAL_CIRILICO_RE.test(t),
        sinPreferencia: SIN_PREFERENCIA_RE.test(t) || SIN_PREFERENCIA_CIRILICO_RE.test(t),
    };
}

// ─── "No tengo estilista": la respuesta LITERAL a la pregunta de estilista ────
// El bot pregunta "¿Tienes estilista de confianza o prefieres que te busque el hueco más
// cercano?" y la clienta contesta "No tengo estilista". El 01/08/2026 eso no lo reconocía
// nadie: SIN_PREFERENCIA_RE cubre "no tengo preferencia" pero no "no tengo estilista".
//
// Va SEPARADO de SIN_PREFERENCIA_RE a propósito. Ese flag lo consume también
// extractDateSignalSante para emitir `asapWeak`, y "no tengo estilista" no dice NADA sobre
// cuándo: responde a QUIÉN. Meterlo allí convertiría "no tengo estilista" en una señal
// temporal de "lo antes posible" y contaminaría la preferencia de fecha.
//
// Por eso este detector no lo usa extractDateSignalSante, y en bot.js solo se consulta
// cuando el turno anterior dejó la pregunta de estilista abierta
// (session.stylistQuestionPending): fuera de ese contexto, "es mi primera vez" o "ninguna"
// pueden estar contestando a otra cosa.
// Los patrones se pasan por normalizeText antes de compilar porque el texto de entrada
// también va normalizado, y NFD descompone la «й» cirílica (и + breve combinante, que el
// filtro de diacríticos borra): "первый" acaba siendo "первыи". Escribirlos a mano en su
// forma descompuesta sería ilegible y frágil.
const SIN_ESTILISTA_RE = new RegExp([
    // ES
    'no tengo (?:una |un |a )?(?:estilista|peluquer[ao]|manicurista|masajista|chica|persona)',
    'no tengo (?:ningun[ao]|nadie|a nadie)',
    'ningun[ao] en (?:particular|concreto|especial)',
    'no conozco a (?:nadie|ningun[ao])',
    'primera vez',
    'nunca he (?:venido|estado|ido)',
    'soy nueva',
    // EN
    "(?:don'?t|do not) have (?:a )?(?:stylist|hairdresser)",
    'no stylist',
    'first time',
    "(?:don'?t|do not) know anyone",
    // RU
    'нет мастера', 'без мастера', 'первый раз', 'никого не знаю',
    // UK
    'немає майстра', 'без майстра', 'перший раз', 'вперше',
].map(normalizeText).join('|'));

/**
 * ¿Este mensaje dice "no tengo estilista de confianza"? Solo tiene sentido preguntarlo
 * cuando la pregunta de estilista está pendiente. Devuelve boolean; NO toca fecha ni hora.
 */
function detectNoStylistPreference(text) {
    return SIN_ESTILISTA_RE.test(normalizeText(text));
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
    // Las franjas RU/UK van fuera del \b(...)\b: dentro no casaba ninguna (ver buildCyrillicRe).
    if (/\b(por la manana|en la manana|de manana|la manana|morning)\b/.test(t) || PERIODO_MANANA_CIRILICO_RE.test(t)) {
        signal.periodo = 'mañana';
    } else if (/\b(por la tarde|en la tarde|de tarde|la tarde|afternoon|evening)\b/.test(t) || PERIODO_TARDE_CIRILICO_RE.test(t)) {
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

// ─── La duración que se escribe en ends_at ───────────────────────────────────
// ends_at es lo que el motor de huecos lee para saber qué parte de la agenda está
// ocupada. Escribirlo corto no deja una cita "un poco mal": deja hueco declarado
// donde hay clienta. Un `duracion || 60` sobre un servicio de 240 min publica tres
// horas libres que no lo están, el motor las ofrece y dos clientas coinciden con la
// misma estilista. Por eso el número no se decide en cada punto de escritura: se
// decide UNA vez, aquí, y se dice si se ha resuelto o se está adivinando.
//
//   via 'servicio' → el objeto de sesión ya traía duracion (caso normal)
//   via 'catalogo' → no la traía; se recupera por nombre contra agent_configs.services
//                    (el camino de `selectedService_incompleto_sin_match`, donde queda
//                    un {nombre, categoria} suelto sin duración)
//   via 'fallback' → NO resuelta. `resuelto:false` para que quien escribe lo registre
//                    y lo deje visible, en vez de que el 60 pase por un dato.
const DURACION_CITA_FALLBACK_MIN = 60;

function resolveAppointmentDurationMin(svc, catalog = [], fallback = DURACION_CITA_FALLBACK_MIN) {
    const propia = Number(svc?.duracion);
    if (Number.isFinite(propia) && propia > 0) {
        return { minutos: propia, resuelto: true, via: 'servicio' };
    }
    // Sin fallback interno (null): aquí necesitamos distinguir "resuelta a 60" de
    // "no resuelta y el 60 me lo he inventado".
    const candidatos = [buildFullServiceName(svc, catalog), svc?.nombre].filter(Boolean);
    for (const nombre of candidatos) {
        const porNombre = Number(resolveServiceDurationMin(nombre, catalog, null));
        if (Number.isFinite(porNombre) && porNombre > 0) {
            return { minutos: porNombre, resuelto: true, via: 'catalogo' };
        }
    }
    return { minutos: fallback, resuelto: false, via: 'fallback' };
}

// Nuevo fin de una cita YA guardada cuando la clienta acepta un upselling.
// Se mide sobre la cita REAL de la BD —su ends_at actual + lo que dura el upsell
// NUEVO— y no recalculando desde la duración del servicio de la sesión. El recálculo
// es el que muerde: si esa duración falta y vale 60 por defecto, aceptar un K18 de
// 15 min sobre unas mechas de 240 escribe un ends_at 165 minutos ANTES del real.
// Aceptar un extra ACORTABA la cita y liberaba media tarde ocupada.
// Solo cuando la cita no trae un ends_at usable se recalcula desde el inicio.
//   via 'ends_at_real' → extendido sobre el fin guardado (camino normal)
//   via 'recalculo'    → sin ends_at fiable; depende de totalMin, que puede ser una
//                        estimación — quien llama debe registrarlo
//   via 'sin_base'     → no hay ni inicio válido: no hay nada que escribir
function computeAmpliacionEndsAt({ startsAt, endsAt, extraMin = 0, totalMin = 0 } = {}) {
    // El inicio se compone a veces como `${fecha}T${hora}:00` con datos de sesión que
    // pueden faltar, y `new Date('undefinedTundefined:00')` NO da Invalid Date: el
    // parser laxo de V8 devuelve el año 2000. Un fin en el año 2000 se escribe sin
    // protestar y deja la cita fuera de cualquier agenda. Por eso se exige la forma.
    const toDate = v => {
        if (!v) return null;
        if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v.trim())) return null;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
    };
    const inicio = toDate(startsAt);
    const fin = toDate(endsAt);
    if (inicio && fin && fin > inicio) {
        return { endsAt: new Date(fin.getTime() + extraMin * 60000), via: 'ends_at_real' };
    }
    if (inicio) {
        return { endsAt: new Date(inicio.getTime() + totalMin * 60000), via: 'recalculo' };
    }
    return { endsAt: null, via: 'sin_base' };
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
    // Quien llama resuelve la duración (resolveAppointmentDurationMin) y la pasa ya
    // decidida; esto es solo la red de una función pura, con el MISMO fallback declarado
    // que el resto de la cadena en vez de un 60 suelto que parezca otra decisión.
    const apptEnd = apptStart + (serviceDurMin || DURACION_CITA_FALLBACK_MIN) + upsellDurMin;
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
    const lang = IDIOMAS_SOPORTADOS.includes(language) ? language : 'es';
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
    // Aquí iba la nota "si tras la consulta decides el servicio, ya tendrás tiempo reservado a
    // continuación sin esperar". Se retiró con 029_consulta_60min.sql: era cierta cuando la
    // Consulta bloqueaba 300 min (20 de consulta + la tarde por delante), pero con 60 min quedan
    // 40 de margen, que no dan para un color ni un balayage. Prometerlo generaba en el salón la
    // expectativa exacta que provoca la queja. Lo que sigue siendo cierto —20 min y precio a
    // confirmar— ya está en svcLine y priceLine.
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
    const lang = IDIOMAS_SOPORTADOS.includes(language) ? language : 'es';
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

// ─── Citas que YA existen: consultar y referirse ─────────────────────────────
//
// Hasta el 03/08/2026 el bot no tenía forma de mirar una cita ya reservada: "¿a qué hora
// tengo la cita?" y "es para mi cita de las 6" caían en el flujo de reserva y acababan
// abriendo una cita NUEVA. El segundo caso es el peligroso (incidente Valeria, 01/08) y es
// el que obliga a que estos detectores sean deterministas: si la decisión de "esto habla de
// una cita que ya existe" la toma el LLM, vuelve a poder equivocarse hacia el lado caro.
//
// Regla de diseño de los dos detectores: exigen SIEMPRE una marca de cita EXISTENTE
// ("mi cita", "tengo cita", "la cita que tengo"). Sin esa marca no disparan, y por eso
// "quiero pedir cita" o "quiero una cita a las 6" siguen su camino de reserva normal.
// El gating (que solo se llamen cuando la clienta tiene citas de verdad) vive en bot.js.

// SEGUNDA trampa de los patrones cirílicos, además de la NFD que documenta buildCyrillicRe:
// `\b` en JavaScript es ASCII, así que un `/\bкогда\b/` NO casa NUNCA contra texto cirílico
// (ni el espacio ni la к son "word characters" para el motor, luego no hay frontera entre
// ellos). Es el mismo fallo silencioso del commit 902bf0c. Aquí la frontera se escribe a
// mano con la clase de letras cirílicas, para que 'коли' no se lleve el 'коли' de 'ніколи'.
const CIR_LETRA = 'а-яёієґ';
function _cirWord(literal) {
    return new RegExp(`(?:^|[^${CIR_LETRA}])${literal}(?:[^${CIR_LETRA}]|$)`);
}

// Habla de una cita SUYA que ya existe. Deliberadamente NO incluye "pedir/reservar cita".
const MARCA_CITA_EXISTENTE = [
    // ES — posesivo o verbo de posesión pegado a cita/reserva/hora
    /\b(mi|la|esa|esta) (cita|reserva)\b/,
    /\btengo (una |la )?(cita|reserva|hora)\b/,
    /\b(cita|reserva) que (tengo|teniamos|tenia)\b/,
    /\bmis citas\b/,
    // EN
    /\b(my|the) (appointment|booking)\b/,
    /\bi have (an? )?(appointment|booking)\b/,
    // RU / UK — 'моя запись', 'мій запис', 'у меня запись'. El posesivo se escribe como
    // "м + о/і + lo que sea" y no enumerado: 'мій' se normaliza a 'міи' (la й se descompone)
    // y 'мої' a 'моі', así que ninguna de las dos formas literales casaría.
    /м[оі]\S* (запис|запись)/,
    /у мене (є )?запис/,
    /у меня (есть )?запись/,
    /(запись|запис) (яка|которая|що|которую)/,
];
// Contraseñal: pide una cita NUEVA. Gana sobre la marca de existencia.
const MARCA_CITA_NUEVA = [
    /\b(pedir|reservar|coger|sacar|hacer|solicitar) (una |la )?cita\b/,
    /\b(quiero|queria|querria|necesito|busco|me gustaria|puedo) (pedir|reservar|coger|sacar|hacer)\b/,
    /\b(book|make|get) (an? )?(appointment|booking)\b/,
    /(записаться|записатися)/,
];
function _hablaDeCitaExistente(t) {
    if (MARCA_CITA_NUEVA.some(re => re.test(t))) return false;
    return MARCA_CITA_EXISTENTE.some(re => re.test(t));
}

// Preguntas por un campo concreto de la cita. El campo solo decide el encabezado del
// mensaje: la respuesta enumera la cita entera, así que clasificar de menos nunca deja a
// la clienta sin el dato que pedía.
const CAMPO_PATTERNS = [
    ['hora', [/\ba (que|qu) hora\b/, /\bque hora\b/, /\bwhat time\b/, /во сколько/, /о котр\S+ годин/]],
    ['dia', [/\b(que|qu) dia\b/, /\bcuando\b/, /\bwhat day\b/, /\bwhen\b/, /(какой|який) день/, _cirWord('когда'), _cirWord('коли')]],
    ['estilista', [/\bcon (quien|qui)\b/, /\b(quien|qui) me (atiende|lo hace|hace)\b/, /\bwho (is|will be|am i)\b/, _cirWord('с кем'), _cirWord('з ким')]],
    ['servicio', [/\b(que|qu) (me )?(tengo|voy a|me van a) (hacer|hacerme)\b/, /\bwhat (service|am i getting)\b/, /(что|що) (мне |мені )?(делают|роблять|будут делать)/]],
];

// ¿Está preguntando POR una cita que ya tiene? Devuelve { campo } o null.
function detectAppointmentQuery(text) {
    if (!text) return null;
    const t = normalizeText(text);
    if (!_hablaDeCitaExistente(t)) return null;
    for (const [campo, patterns] of CAMPO_PATTERNS) {
        if (patterns.some(re => re.test(t))) return { campo };
    }
    // "mi cita?" / "¿tengo cita el jueves?" — pregunta sin campo concreto. Se exige señal
    // interrogativa para no confundirla con una referencia ("es para mi cita de las 6").
    if (/\?/.test(text) || /^(tengo|sigue|esta|confirmame|confirma)\b/.test(t) || /\bsigue en pie\b/.test(t)) {
        return { campo: 'general' };
    }
    return null;
}

const DIA_SEMANA_CONSULTA = {
    ...DIA_SEMANA_MAP,
    понедельник: 0, вторник: 1, среда: 2, четверг: 3, пятница: 4, суббота: 5, воскресенье: 6,
    понедiлок: 0, вiвторок: 1, середа: 2, четвер: 3, пятниця: 4, субота: 5, недiля: 6,
};

// Horas candidatas de un "de las 6": la clienta casi nunca escribe el formato de 24h y el
// salón trabaja mañana y tarde, así que se devuelven AMBAS lecturas ordenadas por
// probabilidad. Quien casa contra las citas reales elige la que exista de verdad — que es
// mejor que adivinar aquí y equivocarse de cita.
function _horasCandidatas(t) {
    const explicita = t.match(/\b(\d{1,2})[:.](\d{2})\b/);
    const pad = n => String(n).padStart(2, '0');
    if (explicita) {
        const h = Number(explicita[1]); const m = Number(explicita[2]);
        if (h > 23 || m > 59) return [];
        return [`${pad(h)}:${pad(m)}`];
    }
    const suelta = t.match(/\b(?:a las|las|at|в|о)\s+(\d{1,2})\b/);
    if (!suelta) return [];
    const h = Number(suelta[1]);
    if (h === 12) return ['12:00'];
    if (h >= 13 && h <= 23) return [`${pad(h)}:00`];
    if (h < 1 || h > 11) return [];
    const esManana = /\b(manana|morning|утра|ранку)\b/.test(t);
    return esManana ? [`${pad(h)}:00`, `${pad(h + 12)}:00`] : [`${pad(h + 12)}:00`, `${pad(h)}:00`];
}

// Pistas para LOCALIZAR una cita entre las que la clienta tiene: hora(s) y día de la semana.
// Sin la marca de "cita existente" a propósito — también resuelve la respuesta a "¿cuál de
// las dos?" ("la del jueves"), donde ya no repite "mi cita".
function extractCitaPistas(text) {
    const t = normalizeText(text);
    let diaSemana = null;
    for (const [nombre, idx] of Object.entries(DIA_SEMANA_CONSULTA)) {
        if (new RegExp(`(?:^|[^${CIR_LETRA}a-z])${nombre}(?:[^${CIR_LETRA}a-z]|$)`).test(t)) {
            diaSemana = idx; break;
        }
    }
    return { horas: _horasCandidatas(t), diaSemana };
}

// ¿Se está refiriendo a una cita que ya tiene ("es para mi cita de las 6")? Devuelve
// { horas, diaSemana } —las pistas para localizarla— o null. NO resuelve la cita: eso lo
// hace bot.js contra Supabase, porque la verdad está en la agenda y no en el mensaje.
function detectExistingAppointmentReference(text) {
    if (!text) return null;
    const t = normalizeText(text);
    if (!_hablaDeCitaExistente(t)) return null;
    return extractCitaPistas(text);
}

// Pide cancelar. `fuerza` separa dos cosas que no merecen la misma confianza:
//   'explicita' — nombra la cancelación ("cancela mi cita"). Inequívoco.
//   'implicita' — "no puedo ir el miércoles". Puede ser eso… o el rechazo de un hueco que
//                 acabamos de proponer, que es una conversación completamente distinta. Por
//                 eso bot.js la ignora si hay huecos sobre la mesa (slotsProposed).
// En ningún caso cancela nada por sí sola: siempre se recita la cita y se espera un sí.
function detectCancelRequest(text) {
    if (!text) return null;
    const t = normalizeText(text);
    if (/\b(cancelar|cancela|cancelame|anular|anula|anulame|cancelo)\b/.test(t)
        || /\bcancel\b/.test(t) || /отмен/.test(t) || /скасу/.test(t)) {
        return { fuerza: 'explicita' };
    }
    if (/\bno (puedo|podre|voy a poder) (ir|venir|asistir|acudir|llegar|estar)\b/.test(t)
        || /\bno me viene bien\b.*\b(cita|reserva)\b/.test(t)
        || /can.?(no)?t make it/.test(t) || /\bnot able to come\b/.test(t)
        || /не смогу/.test(t) || /не зможу/.test(t)) {
        return { fuerza: 'implicita' };
    }
    return null;
}

// Pide mover la cita. Exige que el verbo vaya PEGADO a la cita: detectIntent devuelve
// 'cambiar' con un `includes('cambiar')` a secas, y sobre eso no se puede tocar la agenda
// ("quiero cambiar de look" no es un reagendado).
function detectRescheduleRequest(text) {
    if (!text) return false;
    const t = normalizeText(text);
    return [
        /\b(cambiar|cambia|cambiarme|mover|mueve|reagendar|aplazar|posponer|adelantar|retrasar|cambio)\b[^.!?]{0,25}\b(cita|reserva|hora|dia|fecha)\b/,
        /\b(cita|reserva)\b[^.!?]{0,25}\b(cambiar|cambiarla|mover|moverla|reagendar|otro dia|otra hora)\b/,
        /\b(change|move|reschedule)\b[^.!?]{0,25}\b(appointment|booking)\b/,
        /перенести/, /перенести (запис|запись)/,
    ].some(re => re.test(t));
}

function _lineaCita(c, lang) {
    const con = { es: 'con', en: 'with', ru: 'у', uk: 'у' }[lang] || 'con';
    const estilista = c.estilista ? ` (${con} ${c.estilista})` : '';
    return `📅 ${_formatFechaHora(c.fecha, c.hora, lang)} — ${c.servicio || ''}${estilista}`.trim();
}

// Respuesta determinista a "¿a qué hora tengo la cita?" y familia. Enumera SIEMPRE la cita
// completa (fecha, hora, servicio y estilista) sea cual sea el campo preguntado: el dato
// viene de Supabase y darlo entero cuesta lo mismo que darlo a medias.
function buildCitasVivasMsg({ citas = [], campo = 'general', language } = {}) {
    const lang = IDIOMAS_SOPORTADOS.includes(language) ? language : 'es';
    const T = {
        es: {
            una: 'Tienes esta cita reservada:', varias: 'Tienes estas citas reservadas:',
            ninguna: 'No me consta ninguna cita reservada a tu nombre. ¿Quieres que te busque hueco?',
            noCasa: 'No encuentro ninguna cita que encaje con eso. Lo que tengo apuntado es:',
            cierre: 'Si necesitas cambiar algo, dímelo 😊',
        },
        en: {
            una: 'You have this appointment booked:', varias: 'You have these appointments booked:',
            ninguna: "I don't have any appointment booked under your name. Would you like me to find you a time?",
            noCasa: "I can't find an appointment matching that. What I have booked is:",
            cierre: 'If you need to change anything, just tell me 😊',
        },
        ru: {
            una: 'У тебя записано:', varias: 'У тебя записано:',
            ninguna: 'На твоё имя нет ни одной записи. Подобрать тебе время?',
            noCasa: 'Не нахожу запись на это время. Вот что у меня записано:',
            cierre: 'Если нужно что-то изменить, напиши 😊',
        },
        uk: {
            una: 'У тебе записано:', varias: 'У тебе записано:',
            ninguna: 'На твоє ім\'я немає жодного запису. Підібрати тобі час?',
            noCasa: 'Не знаходжу запис на цей час. Ось що в мене записано:',
            cierre: 'Якщо потрібно щось змінити, напиши 😊',
        },
    };
    const t = T[lang] || T.es;
    if (!citas.length) return t.ninguna;
    const intro = campo === 'no_casa' ? t.noCasa : (citas.length === 1 ? t.una : t.varias);
    return [intro, '', ...citas.map(c => _lineaCita(c, lang)), '', t.cierre].join('\n');
}

// Cancelar es irreversible y libera un hueco facturable, así que NUNCA se ejecuta sobre una
// intención inferida: se recita la cita concreta leída de Supabase y se espera un sí. Sin
// esto, un "no puedo ir el miércoles" dicho de cualquier otra cosa borraba la cita.
function buildCancelConfirmMsg({ cita, language } = {}) {
    const lang = IDIOMAS_SOPORTADOS.includes(language) ? language : 'es';
    const T = {
        es: { intro: 'Antes de cancelar, confírmame que es esta:', pregunta: '¿La cancelo?' },
        en: { intro: 'Before I cancel, let me check it\'s this one:', pregunta: 'Shall I cancel it?' },
        ru: { intro: 'Прежде чем отменить, уточню — эта запись:', pregunta: 'Отменяю?' },
        uk: { intro: 'Перш ніж скасувати, уточню — цей запис:', pregunta: 'Скасовую?' },
    };
    const t = T[lang] || T.es;
    return [t.intro, '', _lineaCita(cita, lang), '', t.pregunta].join('\n');
}

// Con dos citas vivas y un "cancela mi cita" a secas NO se adivina: adivinar mal cancela la
// cita equivocada, que es el peor resultado posible de toda esta funcionalidad.
function buildElegirCitaMsg({ citas = [], accion = 'cancelar', language } = {}) {
    const lang = IDIOMAS_SOPORTADOS.includes(language) ? language : 'es';
    const T = {
        es: { cancelar: '¿Cuál de estas quieres cancelar?', cambiar: '¿Cuál de estas quieres cambiar?', referir: '¿A cuál de estas te refieres?' },
        en: { cancelar: 'Which one would you like to cancel?', cambiar: 'Which one would you like to change?', referir: 'Which one do you mean?' },
        ru: { cancelar: 'Какую из них отменить?', cambiar: 'Какую из них перенести?', referir: 'Какую из них ты имеешь в виду?' },
        uk: { cancelar: 'Який із них скасувати?', cambiar: 'Який із них перенести?', referir: 'Який із них ти маєш на увазі?' },
    };
    const t = T[lang] || T.es;
    return [t[accion] || t.cancelar, '', ...citas.map(c => _lineaCita(c, lang))].join('\n');
}

// Añadir un servicio alarga la cita y la nueva duración pisaría la cita siguiente de esa
// estilista. No se escribe: se dice la verdad y lo cuadra una persona. La alternativa
// —escribir igual— crea un solape invisible que solo se descubre el día de la cita.
function buildAmpliacionSolapaMsg(language) {
    const T = {
        es: 'Puedo añadírtelo, pero con ese servicio la cita se alarga y se junta con la siguiente 😅 Aviso al salón para que te cuadren el horario y te confirmen.',
        en: "I can add it, but that service makes the appointment run into the next one 😅 I'm letting the salon know so they can sort the timing and confirm.",
        ru: 'Могу добавить, но с этой услугой запись удлиняется и накладывается на следующую 😅 Сообщаю в салон, чтобы согласовали время и подтвердили.',
        uk: 'Можу додати, але з цією послугою запис подовжується й накладається на наступний 😅 Повідомляю салон, щоб узгодили час і підтвердили.',
    };
    return T[language] || T.es;
}

// La cancelación NO se pudo escribir. Gemelo de la red anti-cita-fantasma en la otra
// dirección: antes el bot decía "cancelada ✅" con la cita viva en la agenda, y la clienta
// no aparecía el día de su cita creyéndola anulada.
function buildCancelFalloMsg(language) {
    const T = {
        es: 'Perdona, no he podido cancelarla desde aquí 😔 Aviso al salón ahora mismo para que la anulen y te confirmen.',
        en: "Sorry, I couldn't cancel it from here 😔 I'm letting the salon know right now so they cancel it and confirm.",
        ru: 'Извини, я не смогла отменить запись 😔 Сообщаю в салон, чтобы отменили и подтвердили тебе.',
        uk: 'Вибач, я не змогла скасувати запис 😔 Повідомляю салон, щоб скасували та підтвердили тобі.',
    };
    return T[language] || T.es;
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

// Categorías REACTIVAS: están en el catálogo (hay que poder reservarlas) pero el bot NUNCA
// las ofrece por iniciativa propia — sólo las selecciona el detector determinista.
//
// Hasta el 03/08/2026 esto era sólo prosa del prompt, y el modelo la ignoró: vio
// "Consulta de valoración — 20 min" en el menú del catálogo, la ofreció, y además la FUSIONÓ
// con la "Consulta tricológica con Yulia" (85€/60min, otra fila, otra categoría, otra
// profesional) inventando un híbrido que no existe. Ahora es un dato: openai.js excluye estas
// categorías del catálogo que ve el modelo, y bot.js descarta el servicio si llega por la vía
// del LLM sin que el detector haya disparado.
const REACTIVE_ONLY_CATEGORIES = new Set(['consulta']);

function isReactiveOnlyCategory(categoria) {
    return REACTIVE_ONLY_CATEGORIES.has(normalizeText(categoria || ''));
}

function isReactiveOnlyService(svc) {
    return !!svc && isReactiveOnlyCategory(svc.categoria);
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
        // ES — "que me evalúen / valoren / vean el pelo". Faltaban por completo: la clienta
        // del 02/08/2026 lo pidió dos veces ("Me gustaría que me evaluarán bien y me dijeran
        // que necesito", "Me tienen que evaluar"), selectedService se quedó en null y el bot
        // le repitió "primero necesito saber qué servicio quieres" hasta que se rindió.
        // Ojo al orden con extractServiceFromText en bot.js: corre ANTES que este gate, así
        // que una señal capilar ("caída", "diagnóstico", "capilar") ya se lleva la consulta
        // tricológica de 85€ y aquí sólo cae lo genérico. Esa bifurcación es deliberada.
        /\b(evaluar|evaluarme|evaluame|evaluen|evaluenme|evalue|evaluaran|evaluacion)\b/,
        /\b(valorar|valorarme|valorame|valoren|valorenme|valoraran|valoracion)\b/,
        /me (tienen|teneis|tienes|hay) que (evaluar|valorar|ver|mirar|revisar)/,
        /que me (vean|veais|miren|mireis|revisen|reviseis|echen un vistazo)/,
        /(me digan|decirme|me digais|que me diga) (que|qu) (necesito|me hace falta|me conviene)/,
        // ES — que lo valoren en persona
        /ver(lo)? en persona/,
        /que lo ve(ais|an)/,
        // EN
        /don.?t know what to (do|get)/,
        /not sure what i (want|need)/,
        /can you (recommend|advise|suggest)/,
        /\b(recommend me|need advice|a consultation)\b/,
        /\b(evaluate|assess) my hair\b/,
        /\b(look at|check) my hair\b/,
        // RU
        /не знаю что (мне )?(сделать|выбрать|хочу)/,
        // 'посовету', no 'посоветуйте': la й se descompone al normalizar (ver buildCyrillicRe)
        // y el literal completo no casaba nunca. El resto de la familia sí funcionaba, así que
        // una clienta rusa que escribía sólo "Посоветуйте, пожалуйста" no activaba la consulta.
        /(посовету|консультаци|порекоменд)/,
        // Pronombre posesivo opcional como "una palabra que empieza por мо-", no enumerado:
        // 'мой' y 'мої' se descomponen al normalizar (й, ї) y como alternativas literales
        // estaban muertas. Cubre мой/мои/моє/мої/моего… sin depender de la ortografía.
        /(оцените|оценить|посмотрите)( мо\S+)? волос/,
        // UK
        /не знаю що (мені )?(зробити|вибрати|хочу)/,
        /(порадьте|консультаці|порекоменд)/,
        /(оцініть|оцінити|подивіться)( мо\S+)? волосс/,
    ];
    return patterns.some(re => re.test(t));
}

// ─── Descripción del ESTADO del cabello (03/08/2026, petición de Yulia) ──────
//
// La clienta describe su problema ("tengo el pelo seco y sin brillo") sin nombrar ningún
// servicio. El bot NO debe adivinar el tratamiento: contesta con el rango de precios y
// recomienda la consulta (ver salonHairTreatmentRangeMsg en bot.js).
//
// Por qué un detector propio y no más patrones en detectConsultaValoracion: esa función
// significa "pídeme asesoramiento" y su consumidor selecciona la Consulta DIRECTAMENTE, sin
// pronunciar precios. Aquí hace falta lo contrario: hablar primero (muchos tratamientos,
// 45-115 €) y ofrecer la consulta después.
//
// Por qué no basta con el prompt: el daño ocurre ANTES del LLM. "sin brillo" contiene
// 'brillo', que es palabra de categoría (CATEGORY_KEYWORDS → Brillo Glow, con un único
// servicio), así que extractServiceFromText resolvía "tengo el pelo sin brillo" a
// "Brillo intensivo" — 120 € — y lo reservaba sin preguntar. Los síntomas que no chocan con
// ninguna categoría ("seco y estropeado", "apagado y sin vida") caían al otro extremo:
// null → salonNoSlotsMsg → bucle. Las dos mitades del fallo de anoche.
//
// La CAÍDA del pelo queda fuera a propósito: 'caida'/'anticaida'/'alopecia' siguen yendo a
// Diagnóstico Capilar / consulta tricológica, la bifurcación deliberada que documenta el
// comentario de detectConsultaValoracion.
//
// Ojo con el cirílico: normalizeText descompone en NFD y borra los diacríticos, así que
// й→и y ё→е. Los patrones RU/UK de aquí se escriben YA normalizados ('поврежденные', no
// 'повреждённые') porque si no nunca casan.
const HAIR_PROBLEM_NOUN_RE = /(pelo|cabello|melena|puntas|hair|волос)/;

// Cada patrón describe UN síntoma. Además de decidir el disparo, sus coincidencias se borran
// del texto para construir el `residual` con el que se comprueba si la clienta nombró de
// verdad un servicio (ver detectHairProblemDescription).
const HAIR_PROBLEM_PATTERNS = [
    // ES — sequedad / deshidratación
    /\b(muy |bastante |super |bien |tan )*(seco|seca|secos|secas|reseco|reseca|resecos|resecas|deshidratado|deshidratada|deshidratados|deshidratadas)\b/,
    /\bsin hidratacion\b/,
    // ES — daño
    /\b(estropeado|estropeada|estropeados|estropeadas|danado|danada|danados|danadas|maltratado|maltratada|maltratados|maltratadas|quemado|quemada|quemados|quemadas|castigado|castigada|castigados|castigadas)\b/,
    // ES — falta de brillo. Es el patrón que desactiva el falso 'brillo' de Brillo Glow.
    /\b(sin|poco|poca|falta de|nada de) brillo\b/,
    /\b(apagado|apagada|apagados|apagadas|opaco|opaca|opacos|opacas|sin luz)\b/,
    // ES — falta de fuerza / vida
    /\bsin (vida|fuerza|cuerpo|volumen)\b/,
    /\b(debil|debiles|fino y|finito|sin densidad)\b/,
    // ES — rotura
    /\b(quebradizo|quebradiza|quebradizos|quebradizas)\b/,
    /\bse me (rompe|parte|quiebra|rompen|parten|quiebran)\b/,
    /\b(puntas) (abiertas|rotas|estropeadas|dobles)\b/,
    // ES — encrespamiento / porosidad
    /\b(encrespado|encrespada|encrespados|encrespadas|encrespamiento|frizz|poroso|porosa|porosos|porosas)\b/,
    // ES — valoraciones genéricas (solo cuentan junto al sustantivo capilar, ver el guard)
    /\b(hecho polvo|un desastre|fatal|horrible|un asco|muy mal|fatalmente)\b/,
    // EN
    /\b(very |really |super )*(dry|damaged|brittle|dull|lifeless|frizzy|straw ?like)\b/,
    /\bsplit ends\b/,
    /\b(no|lacks?|lacking|without) (shine|life|body)\b/,
    // RU (ya normalizado: sin й ni ё)
    /(сухие|сухая|сухое|пересушен|поврежден|ломкие|ломкое|тусклые|тусклое|безжизненн|секутся|пушатся|испорчен)/,
    // UK (ya normalizado: sin й ni ї)
    /(сухе|сухи|пошкоджен|ламке|ламки|тьмяне|тьмяни|безживн|сiчеться|січеться|пухнасте|зiпсован|зіпсован)/,
];

// Palabras de LARGO. Se ignoran al comprobar si el residual nombra un servicio: 'corto' es
// palabra de la categoría Cortes en CATEGORY_KEYWORDS, así que sin esto un "tengo el pelo
// corto y seco" contaría como "ha pedido un corte" y se comería el caso. El largo ya tiene
// su propia maquinaria (detectLargoCategory / pendingLargoCategory).
const LARGO_WORDS_RE = /\b(corto|corta|cortos|cortas|largo|larga|largos|largas|medio|media|medios|medias)\b/g;

// ¿El texto nombra un servicio o categoría CONCRETOS del catálogo? Deliberadamente laxo: usa
// extractServiceCategoriesFromText además de extractServiceFromText, porque una categoría
// ambigua ("hidratación", que existe a 45/85/110 €) devuelve null en la primera pero SÍ es
// un servicio nombrado — ahí la clienta debe seguir el flujo normal de reserva, que le
// preguntará cuál de las tres quiere.
function namesConcreteService(text, servicesCatalog) {
    if (!text || !servicesCatalog?.length) return false;
    const t = normalizeText(text).replace(LARGO_WORDS_RE, ' ');
    if (extractServiceFromText(t, servicesCatalog)) return true;
    return extractServiceCategoriesFromText(t, servicesCatalog).length > 0;
}

// Devuelve null, o { residual } con el texto normalizado y los tramos de síntoma borrados.
// El residual es lo que se pasa a namesConcreteService: así "tengo el pelo seco, quiero una
// hidratación" sigue el flujo de reserva (queda "quiero una hidratacion"), mientras que
// "quiero algo para el pelo seco y sin brillo" dispara (no queda ningún servicio).
function detectHairProblemDescription(text) {
    if (!text) return null;
    const t = normalizeText(text);
    // Exigir el sustantivo capilar es lo que impide que "está fatal" o "es un desastre"
    // conviertan cualquier queja de la conversación en una descripción del cabello.
    if (!HAIR_PROBLEM_NOUN_RE.test(t)) return null;
    let residual = t;
    let matched = false;
    for (const re of HAIR_PROBLEM_PATTERNS) {
        const rx = new RegExp(re.source, 'g');
        const limpio = residual.replace(rx, ' ');
        if (limpio !== residual) matched = true;
        residual = limpio;
    }
    if (!matched) return null;
    return { residual: residual.replace(/\s+/g, ' ').trim() };
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
    // 'до плеч', no 'до плечей': la й se descompone al normalizar. Sin esto, "до плечей"
    // ("hasta los hombros") no daba largo y el bot repreguntaba — y el largo fija el precio.
    if (/(до плеч|коротк)/.test(t)) return 1;
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

// Categorías de decoloración tras las que el K18 se aplica como complemento (15 min: solo
// aplicar producto, porque el lavado y peinado ya van incluidos en el color) en vez de como
// tratamiento suelto (60 min: lavar + aplicar + secar + peinar). Mismo listado que las reglas
// de upselling "cuidado_decoloracion" (migración 018/024).
const K18_COLOR_CONTEXT_CATEGORIES = [
    'mechas balayage', 'mechas airtouch', 'mechas contouring', 'mechas clasicas', 'deco total blond',
];

// Nombres de catálogo de las dos variantes de K18 (migración 026). El complemento son solo
// los 15 min de aplicar producto; el suelto incluye lavar y peinar (60 min).
const K18_COMPLEMENTO_NOMBRE = 'Reconstrucción K18';
const K18_SUELTO_NOMBRE = 'Reconstrucción K18 + lavar y peinar';

// ¿Es una mención GENÉRICA de K18? La clienta no conoce la distinción complemento/suelto:
// escribe "k18", "k-18" o "reconstrucción k18" y quiere "el K18". Solo el nombre completo
// del suelto (lleva "lavar y peinar") es una elección explícita que NO se reinterpreta.
// Tras la migración 026 ya no hay entrada llamada exactamente "K18", así que sin esta
// detección extractServiceFromText devuelve null para "k18" y devuelve el complemento de
// 15 min para "reconstrucción k18" — cobrar 35€ y reservar 15 min para una hora de trabajo.
function isBareK18Mention(value) {
    const t = normalizeText(value || '');
    if (t.includes('lavar y peinar')) return false;
    const compact = t.replace(/[\s-]/g, '');
    return compact === 'k18' || compact === 'reconstruccionk18';
}

// Decide CUÁL de las dos entradas de K18 quiere la clienta, a partir de la categoría del
// servicio PRINCIPAL ya elegido en la sesión. Con un color ya seleccionado el lavado y el
// peinado van incluidos, así que lo que se añade es el complemento (35€/15min); sin color
// no hay nada donde engancharlo y el K18 es el suelto (60€/60min).
// El default sin contexto es el SUELTO a propósito: es el lado seguro — reservar 60 min y
// cobrar 60€ para un trabajo de 15 min se corrige en el salón, pero reservar 15 min para
// una hora de trabajo descuadra la agenda del día y cobra de menos.
// Un nombre que NO sea una mención genérica se devuelve intacto.
function resolveK18ComplementIfNeeded(nombreServicio, mainCategoria, catalog) {
    if (!isBareK18Mention(nombreServicio)) return nombreServicio;
    const conColor = K18_COLOR_CONTEXT_CATEGORIES.includes(normalizeText(mainCategoria || ''));
    const target = conColor ? K18_COMPLEMENTO_NOMBRE : K18_SUELTO_NOMBRE;
    const entry = (catalog || []).find(s => normalizeText(s.nombre) === normalizeText(target));
    return entry ? entry.nombre : nombreServicio;
}

// Misma decisión que resolveK18ComplementIfNeeded pero devolviendo la ENTRADA de catálogo,
// para la resolución del servicio PRINCIPAL (que necesita precio y duración, no solo el
// nombre). Devuelve null si el texto no es una mención genérica de K18.
function resolveK18ServiceFromText(text, mainCategoria, catalog) {
    if (!isBareK18Mention(text)) return null;
    const nombre = resolveK18ComplementIfNeeded('k18', mainCategoria, catalog);
    return (catalog || []).find(s => normalizeText(s.nombre) === normalizeText(nombre)) || null;
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

// ¿Cambió el `service` DESPUÉS de congelarse el importe? Es el detector del agujero que
// dejaba la 021: stampBillingSnapshot solo sella en la transición → completed y se salta
// las filas ya selladas, y updateAppointment nunca toca las columnas de facturación. Editar
// el servicio de una cita sellada movía el servicio y no el dinero, y el informe seguía
// dando el importe viejo por bueno.
//
// Se compara el STRING del servicio, NUNCA el precio. Comparar el congelado contra el
// recálculo marcaría cada subida legítima del catálogo — justo lo que el snapshot existe
// para absorber (la cita "…+ Matiz plus + K18" de la BD real es ese caso: hoy no se puede
// recalcular porque las migraciones 024/026 renombraron "K18" después de sellarla, y su
// congelado es correcto). Solo el string distingue "el catálogo cambió" de "el operador
// corrigió lo que se hizo".
//
// normalizeText evita falsas alarmas por mayúsculas/acentos/espacios; un cambio real de
// servicio siempre difiere a ese nivel. El `!= null` lo hace null-safe para toda cita
// sellada antes de la 031 (y para el hueco entre migración y backfill): sin él, todo el
// histórico se marcaría en bloque el día del despliegue.
function isBillingServiceDiverged(appt) {
    return appt?.servicio_facturado != null
        && normalizeText(appt.servicio_facturado) !== normalizeText(appt.service);
}

// Construye el informe agregado por estilista a partir de las citas COMPLETED del
// periodo (ya filtradas y con { appointment_id, service, stylist_id, stylist_name,
// starts_at, cliente }) y el catálogo. Los precios del catálogo incluyen IVA → base sin
// IVA = total / (1 + ivaRate), y el importe manual sigue la MISMA convención.
//
// Precedencia del importe, gana la primera que casa (`origen` la nombra para el panel):
//   1. 'manual'       precio_manual != null  → cuenta SIEMPRE, aunque los segmentos fallen.
//   2. 'divergente'   snapshot + el `service` cambió tras sellar → NO cuenta, hay que revisar.
//   2b.'congelado'    snapshot intacto → el importe congelado.
//   3. 'calculado'    sin snapshot y todos los segmentos 'ok' → recálculo del catálogo.
//   4. 'sin_calcular' ni lo uno ni lo otro → NO cuenta (unpriced/unmatched/ambiguous/vacío).
//
// 'divergente' y 'sin_calcular' se cuentan en contadores SEPARADOS (numDivergentes /
// sinCalcular) y nunca se fusionan: son hechos distintos ("el servicio cambió después de
// facturarse" vs "no supe calcularlo") y unirlos haría mentir a los dos avisos del panel.
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
                numDivergentes: 0,
                numManuales: 0,
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
        const recalculable = segments.length > 0 && segments.every(s => s.status === 'ok');

        // El importe CONGELADO al completar la cita manda sobre el recálculo. Sin él, subir un
        // precio en el catálogo reescribía la facturación de un periodo ya cerrado. Solo se
        // recalcula cuando no hay snapshot: citas anteriores a la auditoría, o servicios que
        // no se pudieron valorar.
        // precio_facturado null NO es un snapshot: stampBillingSnapshot sella facturado_at
        // igualmente cuando el servicio no se pudo valorar, para no reintentar. Sin el
        // `!= null`, Number(null) → 0 pasaba el isFinite y esa cita se presentaba como
        // calculada a 0,00 € en vez de caer al contador de "sin poder calcular" — un
        // importe inventado comunicado como cifra buena.
        const congelado = Number(appt.precio_facturado);
        const tieneSnapshot = !!appt.facturado_at
            && appt.precio_facturado != null
            && Number.isFinite(congelado);

        // Misma trampa que arriba, y por eso la misma comprobación: precio_manual = 0 es un
        // importe legítimo (cortesía, 100 % de descuento). Con truthiness se leería como
        // "sin corrección manual" y la cita volvería a facturarse al precio de catálogo,
        // cobrando lo que alguien decidió no cobrar.
        const manual = Number(appt.precio_manual);
        const tieneManual = appt.precio_manual != null && Number.isFinite(manual);

        // Solo puede divergir lo que está congelado; y un importe manual ya es la resolución
        // humana de la divergencia, así que la apaga.
        const divergente = !tieneManual && tieneSnapshot && isBillingServiceDiverged(appt);

        let origen, totalConIva, calculable;
        if (tieneManual) {
            // Cuenta aunque los segmentos sean unmatched/ambiguous: rescatar una cita que el
            // catálogo no sabe valorar es el uso más valioso del importe manual. No rompe el
            // "una cifra dudosa se comunica como dudosa" — la cifra ya no es dudosa, la
            // afirmó una persona identificada con fecha y motivo, y el panel la etiqueta.
            origen = 'manual'; totalConIva = manual; calculable = true;
        } else if (divergente) {
            origen = 'divergente'; totalConIva = 0; calculable = false;
        } else if (tieneSnapshot) {
            origen = 'congelado'; totalConIva = congelado; calculable = true;
        } else if (recalculable) {
            origen = 'calculado'; totalConIva = recalculado; calculable = true;
        } else {
            origen = 'sin_calcular'; totalConIva = 0; calculable = false;
        }

        bucket.numCitas += 1;
        if (calculable) bucket.totalConIva += totalConIva;
        if (origen === 'manual') bucket.numManuales += 1;
        if (origen === 'divergente') bucket.numDivergentes += 1;
        if (origen === 'sin_calcular') bucket.sinCalcular += 1;

        bucket.citas.push({
            appointment_id: appt.appointment_id,
            cliente: appt.cliente || null,
            service: appt.service || null,
            starts_at: appt.starts_at || null,
            precio: calculable ? _round2(totalConIva) : null,
            calculable,
            congelado: tieneSnapshot,
            origen,
            // Va SIEMPRE, gane la rama que gane (null si no se puede recalcular). Alimenta el
            // tooltip "manual vs calculado", el de divergencia y la vista previa de "a esto
            // volverías" al limpiar el importe manual — para que el panel no tenga que
            // calcular dinero en cliente a partir del catálogo que ya tiene cargado.
            precio_calculado: recalculable ? _round2(recalculado) : null,
            precio_manual_motivo: appt.precio_manual_motivo || null,
            precio_manual_at: appt.precio_manual_at || null,
            servicio_facturado: appt.servicio_facturado || null,
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
    const divergentesTotal = estilistas.reduce((s, e) => s + e.numDivergentes, 0);
    const manualesTotal = estilistas.reduce((s, e) => s + e.numManuales, 0);

    return {
        estilistas,
        totales: {
            totalConIva,
            totalSinIva,
            iva,
            numCitas,
        },
        sinCalcularTotal,
        divergentesTotal,
        manualesTotal,
        ivaRate,
    };
}

module.exports = {
    normalizeText,
    detectLanguage,
    IDIOMAS_SOPORTADOS,
    LANGUAGE_SOURCES,
    resolveLanguageSource,
    TEST_PHONE_PREFIX,
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
    isNameToken,
    isUsableName,
    NAME_STOPWORDS,
    NOMBRES_RU_UK_NUNCA_STOPWORD,
    extractNameAfterIntro,
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
    detectNoStylistPreference,
    wantsAnotherBooking,
    wantsRestart,
    detectGuestBooking,
    extractGuestName,
    matchUpsellSuggestion,
    matchUpsellRule,
    resolveServiceDurationMin,
    resolveAppointmentDurationMin,
    computeAmpliacionEndsAt,
    DURACION_CITA_FALLBACK_MIN,
    shouldDiscardUpsellForClosing,
    buildSanteConfirmationMessage,
    buildCitaFantasmaMsg,
    // Citas que ya existen: consultar / referirse / cancelar con confirmación
    detectAppointmentQuery,
    detectExistingAppointmentReference,
    extractCitaPistas,
    detectCancelRequest,
    detectRescheduleRequest,
    buildCitasVivasMsg,
    buildCancelConfirmMsg,
    buildElegirCitaMsg,
    buildCancelFalloMsg,
    buildAmpliacionSolapaMsg,
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
    detectHairProblemDescription,
    namesConcreteService,
    // Todo patrón cirílico se compila con esto (ver su comentario): normaliza los literales
    // y no pone \b. Escribirlos a mano es el bug que ha reaparecido tres veces.
    buildCyrillicRe,
    isReactiveOnlyCategory,
    isReactiveOnlyService,
    // Facturación por estilista
    resolveServiceCatalogEntry,
    findCatalogEntriesExact,
    resolveK18ComplementIfNeeded,
    resolveK18ServiceFromText,
    isBareK18Mention,
    // Exportado para el test de paridad con la copia del panel (dashboard-app/src/lib/service-names.ts).
    splitServiceNames,
    computeServiceBilling,
    isBillingServiceDiverged,
    buildStylistBillingReport,
    filterAppointmentsByStylist,
    buildBillingStylistOptions,
    NO_STYLIST_KEY,
};
