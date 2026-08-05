/**
 * horario-apertura.js — Cuánto tiempo de ATENCIÓN ha pasado entre dos instantes.
 *
 * Existe para que "lleva 2 horas pausado" signifique 2 horas con el salón abierto y no 2
 * horas de reloj. La diferencia no es cosmética: con horas de reloj, una pausa a las 23:00
 * dispara un Telegram a la 1:00 por algo que no ha costado nada, y ese es el camino más
 * corto a que la dueña silencie al bot — justo lo que admin-alerts.js documenta como el
 * fallo a evitar.
 *
 * Puro: solo `date-utils` (que solo usa Intl/Date). Sin BD, sin red, sin `new Date()` propio.
 *
 * Precisión: los solapes se calculan en minutos de pared locales día a día. Los dos días del
 * año en que cambia la hora, el resultado puede desviarse hasta 60 minutos. Para un umbral
 * de 2 horas es irrelevante, y se prefiere eso a arrastrar aritmética de instantes con DST.
 */

const { toLocalDateStr, toMinutes, addDaysStr, mondayDow } = require('./date-utils');

// Orden de `config.horario`: mondayDow devuelve 0=lunes … 6=domingo.
const DIAS = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'];

// Tope de días a recorrer. Una pausa de meses no necesita medirse con exactitud: pasado
// esto, el aviso ya tenía que haber salido hace mucho.
const MAX_DIAS = 60;

function hhmmAMin(txt) {
    const [h, m] = String(txt || '').split(':').map(Number);
    if (!Number.isFinite(h)) return null;
    return h * 60 + (Number.isFinite(m) ? m : 0);
}

/**
 * Franja de apertura de una fecha concreta, en minutos del día.
 * @returns {{apertura: number, cierre: number} | null} null = cerrado ese día.
 */
function franjaDelDia(horario, fechaStr) {
    if (!horario || typeof horario !== 'object') return null;
    const dia = horario[DIAS[mondayDow(fechaStr)]];
    if (!dia || dia.abierto === false) return null;
    const apertura = hhmmAMin(dia.apertura);
    const cierre = hhmmAMin(dia.cierre);
    if (apertura === null || cierre === null || cierre <= apertura) return null;
    return { apertura, cierre };
}

/**
 * Minutos de apertura entre dos instantes.
 *
 * Sin `horario` utilizable NO se inventa uno: se devuelve el tiempo de reloj y se avisa con
 * `sinHorario`. Es lo honesto — una org sin horario configurado (hoy San Remo) no tiene
 * jornada que medir, y suponerle una sería peor que contar reloj.
 *
 * @returns {{minutos: number, sinHorario: boolean}}
 */
function minutosDeAperturaEntre(desde, hasta, horario) {
    const ini = desde instanceof Date ? desde : new Date(desde);
    const fin = hasta instanceof Date ? hasta : new Date(hasta);
    if (Number.isNaN(ini.getTime()) || Number.isNaN(fin.getTime()) || fin <= ini) {
        return { minutos: 0, sinHorario: false };
    }

    const relojMin = Math.floor((fin.getTime() - ini.getTime()) / 60000);
    if (!horario || typeof horario !== 'object' || !Object.keys(horario).length) {
        return { minutos: relojMin, sinHorario: true };
    }

    const fechaIni = toLocalDateStr(ini);
    const fechaFin = toLocalDateStr(fin);
    const minIni = toMinutes(ini);
    const minFin = toMinutes(fin);

    let total = 0;
    let fecha = fechaIni;
    for (let i = 0; i <= MAX_DIAS && fecha <= fechaFin; i++) {
        const franja = franjaDelDia(horario, fecha);
        if (franja) {
            const desdeMin = fecha === fechaIni ? minIni : 0;
            const hastaMin = fecha === fechaFin ? minFin : 1440;
            total += Math.max(0, Math.min(hastaMin, franja.cierre) - Math.max(desdeMin, franja.apertura));
        }
        fecha = addDaysStr(fecha, 1);
    }
    return { minutos: total, sinHorario: false };
}

/** ¿Está el salón abierto en este instante? Sin horario, se considera siempre abierto. */
function estaAbierto(instante, horario) {
    if (!horario || typeof horario !== 'object' || !Object.keys(horario).length) return true;
    const franja = franjaDelDia(horario, toLocalDateStr(instante));
    if (!franja) return false;
    const min = toMinutes(instante);
    return min >= franja.apertura && min < franja.cierre;
}

/**
 * ¿La pausa venía de ANTES de que el salón abriera hoy?
 *
 * Es la pregunta que separa "se pausó esta mañana trabajando" de "lleva pausado desde ayer
 * y acabamos de abrir". El segundo caso no puede esperar a acumular dos horas: el daño
 * empieza con la primera clienta del día.
 */
function pausaVieneDeAntesDeAbrir(pausadoDesde, ahora, horario) {
    if (!estaAbierto(ahora, horario)) return false;
    const franja = franjaDelDia(horario, toLocalDateStr(ahora));
    if (!franja) return false;
    const mismaFecha = toLocalDateStr(pausadoDesde) === toLocalDateStr(ahora);
    if (!mismaFecha) return true;                       // se pausó otro día
    return toMinutes(pausadoDesde) < franja.apertura;   // hoy, pero antes de abrir
}

module.exports = { minutosDeAperturaEntre, franjaDelDia, estaAbierto, pausaVieneDeAntesDeAbrir, DIAS, MAX_DIAS };
