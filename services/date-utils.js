/**
 * date-utils.js — Aritmética de fecha/hora del salón, PURA y sin dependencias.
 *
 * Extraído de calendar-sante.js para que la resolución "día+semana → fecha" pueda compartirse
 * con el reducer de preferencia (date-preference.js) SIN arrastrar la capa de datos (db →
 * supabase, que exige env y crea cliente al requerirse). Solo usa `Intl` y `Date`.
 *
 * Modelo de tiempo: los horarios se guardan como texto de pared local ("10:00") y las citas
 * como timestamps UTC. Para compararlos en el MISMO reloj hay que interpretar toda hora de
 * pared en la TZ del NEGOCIO (BUSINESS_TZ), nunca en la del proceso.
 */

const BUSINESS_TZ = process.env.SALON_TZ || 'Europe/Madrid';
const _dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const _timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// Minuto-del-día (0..1439) de un instante, medido en la TZ de negocio (no la del proceso).
// Así una cita guardada como 08:00 UTC se lee como 600 (10:00 Madrid) en cualquier servidor.
function toMinutes(date) {
    const p = Object.fromEntries(_timeFmt.formatToParts(date).map(x => [x.type, x.value]));
    return Number(p.hour) * 60 + Number(p.minute);
}

// Formatea un instante como YYYY-MM-DD en la TZ de negocio (no UTC ni la del proceso).
// Imprescindible: toISOString() da UTC y, en zonas adelantadas (España, UTC+1/+2), la
// medianoche local cae el día anterior → desfase de un día. Y getFullYear/getDate usan la
// TZ del proceso, que en un servidor no-Madrid también desfasa.
function toLocalDateStr(date) {
    const p = Object.fromEntries(_dateFmt.formatToParts(date).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
}

// Suma n días de CALENDARIO a un 'YYYY-MM-DD' con aritmética pura en UTC (sin TZ, sin DST).
// Devuelve otro 'YYYY-MM-DD'. Como YYYY-MM-DD ordena lexicográficamente igual que
// cronológicamente, los strings resultantes se pueden comparar con < y >.
function addDaysStr(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// Día de la semana (0=lunes … 6=domingo) de un 'YYYY-MM-DD', TZ-free.
function mondayDow(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=domingo
    return jsDay === 0 ? 6 : jsDay - 1;
}

// Resuelve un día de la semana (0=lunes…6=domingo) + un contexto de semana ('esta' |
// 'siguiente' | undefined) a una FECHA absoluta 'YYYY-MM-DD', usando EXACTAMENTE la misma
// aritmética de ventana que buildSlots en calendar-sante.js. Fuente ÚNICA de la resolución
// "día+semana → fecha" que comparten el motor y el reducer de preferencia.
//   - 'siguiente' → el día dentro de [lunes..domingo de la próxima semana]
//   - 'esta'      → el día dentro de [mañana..domingo de la semana de inicio]
//   - undefined   → el próximo día de esa clase dentro de la ventana de 14 días (más cercano)
// Devuelve null si no cae ninguna fecha válida en la ventana (p.ej. 'esta' con un día ya
// pasado) — el llamador conserva entonces el combo día+semana y deja que el motor decida.
function resolveWeekdayToDate(now, diaSemana, semana) {
    const todayStr = toLocalDateStr(now);
    const startDateStr = addDaysStr(todayStr, 1); // la búsqueda arranca mañana (flujo no-asap)
    let lo, hi;
    if (semana === 'siguiente') {
        const todayDow = mondayDow(todayStr);
        lo = addDaysStr(todayStr, (6 - todayDow) + 1); // lunes próxima semana
        hi = addDaysStr(lo, 6);                        // domingo próxima semana
    } else if (semana === 'esta') {
        lo = startDateStr;
        hi = addDaysStr(startDateStr, 6 - mondayDow(startDateStr)); // domingo de la semana de inicio
    } else {
        lo = startDateStr;
        hi = addDaysStr(startDateStr, 13); // el más cercano dentro de la ventana de 14 días
    }
    for (let d = lo; d <= hi; d = addDaysStr(d, 1)) { // strings YYYY-MM-DD comparables lexicográficamente
        if (mondayDow(d) === diaSemana) return d;
    }
    return null;
}

module.exports = { BUSINESS_TZ, toMinutes, toLocalDateStr, addDaysStr, mondayDow, resolveWeekdayToDate };
