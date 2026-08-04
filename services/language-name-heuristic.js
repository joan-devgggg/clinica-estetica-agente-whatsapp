/**
 * language-name-heuristic.js — Heurística de nombre para inferir "probablemente no español"
 * en contactos SIN conversación real (ver scripts/classify-sante-language-by-name.js).
 *
 * No distingue ruso de ucraniano de forma fiable (mismo alfabeto, nombres compartidos):
 * cuando hay señal, sugiere 'ru' como valor por defecto razonable, NUNCA como dato confirmado.
 * En cuanto la clienta escribe un mensaje real, detectLanguage() (services/helpers.js) corrige
 * el idioma en cada turno vía updateContactLanguage — esta heurística deja de tener efecto.
 *
 * Deliberadamente conservadora: fuera quedan nombres eslavos que también son de uso corriente
 * en España (Natalia, Marina, Elena, Valentina, Ivan, Diana, Kristina...) y sufijos de apellido
 * que colisionan con apellidos españoles reales (-ina choca con Molina/Medina/Urbina, -in con
 * Martín/Marín). Mejor no marcar que marcar mal un nombre español.
 */

// Nombres de pila (o su transliteración habitual) poco o nada usados en España, frecuentes
// en la comunidad rusoparlante/ucraniana. Incluye el equipo real de Sante (Irina, Veronika,
// Yulia, Tetiana, Larisa, Olgha).
const SLAVIC_FIRST_NAMES = new Set([
    // Femeninos
    'irina', 'veronika', 'yulia', 'iuliia', 'uliana', 'tetiana', 'tatiana', 'larisa',
    'olgha', 'olga', 'oksana', 'svetlana', 'lyudmila', 'ludmila', 'galina', 'halyna',
    'zoya', 'nadiya', 'nadezhda', 'anzhelika', 'alevtina', 'zinaida', 'raisa', 'taisiya',
    'snezhana', 'yaroslava', 'yevgenia', 'evgenia', 'yekaterina', 'ekaterina', 'polina',
    'yana', 'inna', 'alla', 'iryna', 'khrystyna', 'solomiya', 'oleksandra', 'viktoriya',
    'anastasiya', 'liliya', 'lilia', 'lesya', 'vira', 'nina',
    // Masculinos
    'ruslan', 'vitaliy', 'vitaly', 'bogdan', 'bohdan', 'mykola', 'andriy', 'dmytro',
    'yevhen', 'volodymyr', 'sergei', 'sergey', 'dmitri', 'dmitry', 'andrei', 'andrey',
    'igor', 'viktor', 'aleksey', 'alexei', 'yuriy', 'yuri', 'pavel', 'oleg', 'nikolai',
    'konstantin', 'stanislav', 'rostislav', 'taras', 'ihor', 'arkadiy', 'gennady', 'leonid',
    'maksym', 'vadym', 'roman',
]);

// Sufijos de apellido casi exclusivos del ámbito eslavo, elegidos para NO chocar con
// apellidos españoles habituales (se excluyen a propósito -in/-ina/-yna: Martín, Marín,
// Molina, Medina, Urbina son apellidos españoles reales que terminan así).
const SLAVIC_SURNAME_SUFFIXES = [
    /ova$/i, /eva$/i, /enko$/i, /chuk$/i, /huk$/i, /uk$/i,
    /ivna$/i, /ovna$/i, /sky$/i, /ski$/i, /ska$/i, /ov$/i, /ev$/i,
];

const MIN_SURNAME_LEN = 5;

// Apellidos españoles/catalanes reales que terminan en -ova y colarían por el sufijo
// (Casanova, Vilanova, Bonanova... "nova" = "nueva" en catalán, nada que ver con eslavo).
// Se comprueba antes de aplicar el sufijo, no reemplaza la lista de arriba.
const SPANISH_SURNAME_EXCEPTIONS = new Set([
    'casanova', 'vilanova', 'villanova', 'bonanova', 'cassanova',
]);

function stripDiacritics(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    return stripDiacritics(text.trim().toLowerCase()).split(/\s+/).filter(Boolean);
}

/**
 * Clasifica un nombre por heurística. `apellidos` es opcional: si no se separa de `nombre`,
 * se trata todo como una bolsa de tokens (más señal, algo menos preciso en la posición).
 * Devuelve { suggested: 'ru'|null, matched: string[] } — matched documenta qué disparó
 * la sugerencia, para dejar constancia de que es una inferencia y poder revisarla.
 */
function classifyLanguageByName(nombre, apellidos = '') {
    const nombreTokens = tokenize(nombre);
    const apellidoTokens = tokenize(apellidos);
    const matched = [];

    for (const t of nombreTokens) {
        if (SLAVIC_FIRST_NAMES.has(t)) matched.push(`nombre:${t}`);
    }
    for (const t of apellidoTokens) {
        if (t.length < MIN_SURNAME_LEN) continue;
        if (SPANISH_SURNAME_EXCEPTIONS.has(t)) continue;
        if (SLAVIC_SURNAME_SUFFIXES.some(re => re.test(t))) matched.push(`apellido:${t}`);
    }

    if (matched.length === 0) return { suggested: null, matched: [] };
    return { suggested: 'ru', matched };
}

module.exports = { classifyLanguageByName, SLAVIC_FIRST_NAMES, SLAVIC_SURNAME_SUFFIXES };
