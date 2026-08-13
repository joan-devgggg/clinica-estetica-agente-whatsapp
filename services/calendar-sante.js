/**
 * calendar-sante.js — Motor de disponibilidad real para salón de belleza
 * Fuente de verdad: stylist_schedules - appointments - schedule_blocks
 */

const db = require('./db');
const logger = require('../lib/logger');
// Aritmética de fecha/hora del negocio (TZ-safe, pura). Compartida con date-preference.js:
// la resolución "día+semana → fecha" tiene que ser LA MISMA en el motor y en el reducer de
// preferencia, o el bot verbaliza una fecha y busca huecos en otra.
const { BUSINESS_TZ, toMinutes, toLocalDateStr, addDaysStr, mondayDow, resolveWeekdayToDate } = require('./date-utils');
// El texto de cada hueco se fabrica en el idioma de la clienta, con el MISMO formateador de
// día que el recordatorio de 24 h (formatReminderWhen por debajo): ver el comentario largo
// sobre formatSlotTexto en helpers.js. helpers es puro, no re-importa esta capa.
const { formatSlotTexto } = require('./helpers');

const DIAS_SEMANA = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const SLOT_OFFER_STEP_MIN = 30; // intervalo entre huecos ofrecidos dentro de una ventana libre (10:00, 10:30, 11:00...)
// Mínimo de días de calendario que debe cubrir la ventana de `semana:'esta'` para seguir
// siendo un filtro DURO. Por debajo, se relaja (ver buildSlots).
const MIN_DIAS_VENTANA_SEMANA = 2;

// Causas por las que el motor puede devolver CERO huecos. Antes las cinco eran
// indistinguibles —un `[]` pelado— y el bot acababa comunicando un salón lleno como si
// fuera una avería técnica ("problema técnico… paso tu solicitud al equipo"), que es
// exactamente lo que le pasó a una clienta real el 27/07/2026 con la agenda vacía.
// Un error de BD ya no llega hasta aquí: db.js lanza (ver assertRead).
const CAUSAS_CERO = {
    SIN_ESTILISTAS: 'sin_estilistas',                   // la org no tiene estilistas activas
    SIN_SKILL: 'sin_skill',                             // nadie sabe hacer ese servicio
    SIN_HORARIO: 'sin_horario',                         // nadie trabaja ningún día del rango
    NO_CABE: 'no_cabe_antes_del_cierre',                // el servicio no cabe en la jornada
    AGENDA_LLENA: 'agenda_llena',                       // hay hueco teórico, pero está todo cogido
};

// Marca la causa en el array de resultado. `causa` es null cuando SÍ hay huecos: el
// llamador distingue "no hay nada que decir" de cada motivo concreto.
function conCausa(slots, causa) {
    slots.causa = causa || null;
    return slots;
}

/**
 * Devuelve huecos disponibles para un servicio en los próximos 14 días.
 * @param {string} orgId
 * @param {object} options
 * @param {number} options.serviceDuration — duración en minutos
 * @param {string} options.serviceCategory — categoría del servicio (para filtrar estilistas por skill)
 * @param {string} [options.preferredStylistId] — si la clienta pide una estilista concreta
 * @param {object} [options.preferencia] — { periodo: 'mañana'|'tarde', semana: 'esta'|'siguiente' }
 * @param {string|null} [options.lang] — idioma de la clienta ('es'|'en'|'ru'|'uk'); decide el
 *   idioma de `texto`. Null o desconocido caen a castellano (mismo criterio que el
 *   recordatorio). Los llamadores que no lo pasan (scripts de verificación) reciben es.
 * @returns {Array} — top slots con { fecha, hora, diaNombre, stylistId, stylistName, texto }
 */
async function getAvailableSlots(orgId, { serviceDuration = 60, serviceCategory, preferredStylistId, preferencia = {}, lang = null } = {}) {
    const allStylists = await db.getStylistsByOrg(orgId);
    if (!allStylists.length) return conCausa([], 'sin_estilistas');

    // Filtrar por skill: SOLO estilistas cuyo `skills` incluye exactamente la categoría
    // del servicio. Antes había un fallback a TODAS las estilistas si ninguna hacía match,
    // y eso colaba a Larisa (solo masajes) o a Olgha (solo uñas) en cortes/color. Ahora,
    // si nadie tiene la skill, devolvemos lista vacía (sin huecos) en vez de ofrecer a
    // quien no sabe hacer el servicio — preferimos "no hay hueco" antes que asignar mal.
    let eligible = allStylists;
    if (serviceCategory) {
        eligible = allStylists.filter(s => {
            const skills = Array.isArray(s.skills) ? s.skills : [];
            return skills.some(skill => String(skill).toLowerCase() === String(serviceCategory).toLowerCase());
        });
        if (!eligible.length) {
            logger.warn('sante_sin_estilista_para_categoria', { orgId, serviceCategory });
            return conCausa([], 'sin_skill');
        }
    }

    // Si la clienta eligió una estilista concreta, FILTRAMOS a ella (no solo ordenar).
    // Antes se ordenaba preferida-primero pero se conservaban las demás como fallback;
    // tras el dedup por fecha-hora eso dejaba huecos de OTRA estilista en horas donde la
    // preferida no trabajaba, y un match por hora podía guardar la estilista equivocada
    // (BUG 2). Si la preferida no tiene NINGÚN hueco, caemos al resto elegible para no
    // dejar a la clienta sin opciones.
    if (preferredStylistId) {
        const onlyPreferred = eligible.filter(s => s.id === preferredStylistId);
        if (onlyPreferred.length) eligible = onlyPreferred;
    }

    const now = new Date();
    const todayStr = toLocalDateStr(now);   // fecha de HOY en TZ de negocio
    const nowMinutes = toMinutes(now);      // minuto-del-día de AHORA en TZ de negocio

    // Fecha-calendario de inicio (TZ de negocio): hoy si asap, mañana por defecto. Todo el
    // recorrido de 14 días se hace sobre strings YYYY-MM-DD, independiente de la TZ del proceso.
    const startDateStr = preferencia.asap ? todayStr : addDaysStr(todayStr, 1);
    const endDateStr = addDaysStr(startDateStr, 14);
    const fromDateStr = startDateStr;
    const toDateStr = endDateStr;

    // Rango para las consultas a BD: cubre los 14 días de negocio con ±1 día de holgura
    // (el filtrado fino se hace luego re-agrupando cada cita/bloqueo por su fecha de negocio).
    const fromStr = new Date(new Date(startDateStr + 'T00:00:00Z').getTime() - 24 * 3600 * 1000).toISOString();
    const toStr = new Date(new Date(endDateStr + 'T00:00:00Z').getTime() + 24 * 3600 * 1000).toISOString();
    const allBlockedDays = await db.getBlockedDays(orgId, { from: fromDateStr, to: toDateStr });
    const salonBlockedDates = new Set(allBlockedDays.filter(b => !b.stylist_id).map(b => b.fecha));
    const stylistBlockedDates = new Map();
    for (const b of allBlockedDays) {
        if (!b.stylist_id) continue;
        if (!stylistBlockedDates.has(b.stylist_id)) stylistBlockedDates.set(b.stylist_id, new Set());
        stylistBlockedDates.get(b.stylist_id).add(b.fecha);
    }

    // Prefetch del horario/bloqueos/citas de cada estilista UNA sola vez. Así podemos
    // recorrer los días dos veces (con el filtro de día pedido y, si no hay nada, sin él)
    // sin volver a pegarle a la base de datos.
    const stylistData = [];
    for (const stylist of eligible) {
        const schedule = await db.getStylistSchedule(orgId, stylist.id);
        const blocks = await db.getScheduleBlocks(orgId, stylist.id, fromStr, toStr);
        const appointments = await db.getAppointmentsByStylistAndRange(orgId, stylist.id, fromStr, toStr);
        const scheduleByDay = new Map();
        for (const s of schedule) scheduleByDay.set(s.day_of_week, s);
        stylistData.push({ stylist, scheduleByDay, blocks, appointments });
    }

    // Recorre los próximos 14 días y construye los huecos reales según horario, citas y
    // bloqueos. `pref` puede traer filtros de día/semana/franja. NUNCA inventa huecos:
    // si la estilista no trabaja ese día (no hay daySchedule), simplemente no se generan.
    // Los 14 días de calendario a recorrer, en TZ de negocio, con su día de la semana
    // (0=lunes). Aritmética pura de fechas → idéntico en cualquier TZ del proceso.
    const calendarDays = [];
    for (let d = 0; d < 14; d++) {
        const dateStr = addDaysStr(startDateStr, d);
        calendarDays.push({ dateStr, dayOfWeek: mondayDow(dateStr) });
    }
    const todayDow = mondayDow(todayStr);

    // ¿Se ha tenido que soltar (total o parcialmente) el filtro de semana que pidió la
    // clienta? El bot lo usa para DECIRLO en voz alta en vez de proponer en silencio días de
    // otra semana. Lo escribe buildSlots (ventana blanda) y la ETAPA A del fallback.
    let weekPreferenceRelaxed = false;

    function buildSlots(pref) {
        // Límites de semana como strings YYYY-MM-DD (comparables con < y >).
        let startOfNextWeekStr = null, endOfNextWeekStr = null, endOfThisWeekStr = null;
        // La ventana de 'esta' se encoge un día por jornada: un viernes deja 2 días y un
        // sábado deja 1 (domingo, cerrado). Por debajo de MIN_DIAS_VENTANA_SEMANA deja de
        // tener sentido como filtro DURO — solo produce falsos "no hay huecos" — y pasa a ser
        // preferencia blanda: no acota, y se avisa a la clienta (weekPreferenceRelaxed).
        let ventanaSemanaBlanda = false;
        if (pref.semana === 'siguiente') {
            const daysToSunday = 6 - todayDow;              // días hasta el domingo de esta semana
            startOfNextWeekStr = addDaysStr(todayStr, daysToSunday + 1); // lunes próxima semana
            endOfNextWeekStr = addDaysStr(startOfNextWeekStr, 6);        // domingo próxima semana
            console.log('rango semana siguiente:', startOfNextWeekStr, endOfNextWeekStr);
        } else if (pref.semana === 'esta') {
            // Se ancla a la semana de INICIO de la búsqueda (startDateStr = mañana, o
            // hoy si asap), no a la de HOY. Si hoy es domingo, todayDow=6 y "6-6=0"
            // daba endOfThisWeekStr = hoy mismo → un rango [hoy,hoy] que dejaba fuera
            // TODO el calendario futuro, incluido el lunes que la clienta pedía
            // (root cause del bug totalSlots:0 con Veronika/Balayage). Anclarlo al
            // inicio real de la búsqueda cubre siempre la semana que corresponde.
            const startDow = mondayDow(startDateStr);
            endOfThisWeekStr = addDaysStr(startDateStr, 6 - startDow); // domingo de la semana de inicio
            const diasEnVentana = (6 - startDow) + 1;
            if (diasEnVentana < MIN_DIAS_VENTANA_SEMANA) {
                ventanaSemanaBlanda = true;
                weekPreferenceRelaxed = true;
                logger.info('sante_ventana_semana_relajada', { orgId, startDateStr, endOfThisWeekStr, diasEnVentana });
            }
        }

        const out = [];
        for (const { stylist, scheduleByDay, blocks, appointments } of stylistData) {
            for (const { dateStr, dayOfWeek } of calendarDays) {
                const daySchedule = scheduleByDay.get(dayOfWeek);
                if (!daySchedule) continue; // la estilista NO trabaja este día → sin huecos

                // Skip entire day if blocked (salon-wide or stylist-specific)
                if (salonBlockedDates.has(dateStr)) continue;
                if (stylistBlockedDates.get(stylist.id)?.has(dateStr)) continue;
                const diaNombre = DIAS_SEMANA[dayOfWeek];

                // Filtro por fecha concreta ("el 24") o día de la semana ("el miércoles").
                // La fecha exacta manda sobre el día de la semana si ambas vienen dadas.
                if (pref.fecha) {
                    if (dateStr !== pref.fecha) continue;
                } else if (Number.isInteger(pref.diaSemana)) {
                    if (dayOfWeek !== pref.diaSemana) continue;
                }

                // Filter by week preference: 'siguiente' → solo lunes-domingo de la próxima
                // semana (rango explícito, no open-ended). 'esta' → hasta el domingo actual.
                // BLINDAJE: una `fecha` absoluta ya filtró a un único día arriba y determina la
                // semana por sí sola; el filtro de semana NO debe re-acotar y excluirla (un
                // 'semana' heredado de un turno anterior daría un falso totalSlots:0 para la
                // fecha pedida). La limpieza en origen vive en resolveStickyWeek/extractQuickDataSante.
                if (!pref.fecha) {
                    if (pref.semana === 'siguiente') {
                        if (dateStr < startOfNextWeekStr || dateStr > endOfNextWeekStr) continue;
                    } else if (pref.semana === 'esta' && !ventanaSemanaBlanda) {
                        if (dateStr > endOfThisWeekStr) continue;
                    }
                }

                // Working hours for this day
                const [startH, startM] = daySchedule.start_time.split(':').map(Number);
                const [endH, endM] = daySchedule.end_time.split(':').map(Number);
                const workStart = startH * 60 + startM;
                const workEnd = endH * 60 + endM;

                // Filter by period preference
                if (pref.periodo === 'mañana' || pref.periodo === 'manana') {
                    if (workStart >= 14 * 60) continue; // skip if starts after 14:00
                }

                // Citas y bloqueos de ESTE día, recortados al día (ver recortarAlDia).
                // Las dos listas pasan por el mismo recorte a propósito: una cita y un
                // bloqueo que cruzan la medianoche fallan igual, y con dos criterios
                // distintos solo se arreglaría uno.
                const dayAppts = appointments
                    .map(a => recortarAlDia(a.starts_at, a.ends_at, dateStr))
                    .filter(Boolean);
                const dayBlocks = blocks
                    .map(b => recortarAlDia(b.starts_at, b.ends_at, dateStr))
                    .filter(Boolean);

                // ASAP + hoy: saltar huecos que ya han pasado (buffer de 60 min).
                const minStart = (pref.asap && dateStr === todayStr) ? nowMinutes + 60 : 0;
                // Ventanas libres + barrido en pasos → varios huecos (12:00, 12:30...), no
                // solo el inicio. Lógica pura en computeFreeSlots (fijada por tests).
                const starts = computeFreeSlots({
                    workStart, workEnd,
                    occupied: [...dayAppts, ...dayBlocks],
                    serviceDuration, minStart,
                });
                for (const t of starts) addSlot(out, dateStr, t, diaNombre, stylist, serviceDuration, pref, lang);
            }
        }
        return out;
    }

    let slots = buildSlots(preferencia);

    // Fallback anti-invención (BUG 1/2/3): si se pidió un DÍA concreto en el que la(s)
    // estilista(s) no trabaja(n), buildSlots devuelve [] y antes el LLM acababa inventando
    // fechas. En vez de eso, recalculamos los huecos REALES más cercanos de esa misma
    // estilista/servicio ignorando solo el filtro de día (conservando semana/franja),
    // para proponer alternativas verídicas y próximas, nunca inventadas.
    let pedidoDiaSinHueco = false;
    if (!slots.length && (preferencia.semana || preferencia.fecha || Number.isInteger(preferencia.diaSemana))) {
        // ETAPA A — soltar SOLO el filtro de semana, CONSERVANDO el día pedido. La ventana de
        // 'esta'/'siguiente' es la restricción que más falsos vacíos produce: cerca del fin de
        // semana "esta semana" se queda en 1-2 días y excluye el día que la clienta acaba de
        // pedir (bug real del 24/07: viernes + "el más cercano" → "mañana" → "lunes" daba 0
        // huecos del lunes teniendo 16 libres). Si con el día intacto SÍ hay huecos, el día
        // pedido está disponible y no hay nada que advertir → pedidoDiaSinHueco sigue false.
        if (preferencia.semana) {
            const { semana, ...sinSemana } = preferencia;
            slots = buildSlots(sinSemana);
            // Si estos huecos salen de haber soltado la semana, la clienta pidió una semana
            // que no podemos honrar: hay que decírselo, no proponer otra en silencio.
            if (slots.length) weekPreferenceRelaxed = true;
        }
        // ETAPA B — si sigue vacío, es el DÍA pedido el que no tiene hueco. Soltamos también
        // día/fecha para proponer las alternativas reales más cercanas, nunca inventadas, y
        // marcamos la bandera para que el bot lo avise. Cuerpo idéntico al anterior.
        if (!slots.length && (preferencia.fecha || Number.isInteger(preferencia.diaSemana))) {
            const { fecha, diaSemana, semana, ...resto } = preferencia;
            slots = buildSlots(resto);
            pedidoDiaSinHueco = slots.length > 0;
        }
    }

    // Sort: preferred stylist first, then by date
    if (preferredStylistId) {
        slots.sort((a, b) => {
            if (a.stylistId === preferredStylistId && b.stylistId !== preferredStylistId) return -1;
            if (b.stylistId === preferredStylistId && a.stylistId !== preferredStylistId) return 1;
            return new Date(`${a.fecha}T${a.hora}`) - new Date(`${b.fecha}T${b.hora}`);
        });
    } else {
        slots.sort((a, b) => new Date(`${a.fecha}T${a.hora}`) - new Date(`${b.fecha}T${b.hora}`));
    }

    // Deduplicar por fecha-hora (una estilista por hueco).
    // Cuando hay un día concreto CON huecos reales devolvemos TODOS los de ese día;
    // sin día concreto (o en fallback de día sin hueco), cap generoso para no saturar.
    //
    // El dedupe es una decisión de PRESENTACIÓN: en una conversación no se le sueltan a la
    // clienta cuatro veces las mismas 10:00 con cuatro nombres distintos. Pero hasta el
    // 13/08/2026 la fila que sobraba se TIRABA, y con ella el dato de que había más gente
    // libre a esa hora. Dos efectos, los dos medidos:
    //   1. `getStylistsByOrg` ordena por nombre, así que en cada empate ganaba SIEMPRE la
    //      alfabéticamente primera: con las cuatro generalistas de Sante libres, Irina se
    //      llevaba el 100 % de las ofertas y las otras tres eran invisibles.
    //   2. bot.js contaba las estilistas distintas SOBRE ESTA LISTA para decidir si
    //      saltarse la pregunta de preferencia ("solo hay una posible, p.ej. masajes →
    //      Larisa"). Colapsadas a una, el bot fijaba a Irina sin preguntar nunca.
    // Ahora la fila repetida se guarda como ALTERNATIVA del hueco que sobrevive. La lista
    // devuelta no cambia —mismas horas, mismo orden, misma ganadora— y quien necesite saber
    // quién más está libre (bot.js para contar, y el día de mañana un enlace público para
    // reintentar con otra) lo tiene sin volver a la BD.
    const diaConcreto = !pedidoDiaSinHueco && !!(preferencia.fecha || Number.isInteger(preferencia.diaSemana));
    const MAX_TOTAL = diaConcreto ? Infinity : (preferencia.asap ? 5 : 20);
    const seen = new Map();
    const unique = [];
    for (const s of slots) {
        const key = `${s.fecha}-${s.hora}`;
        const yaEsta = seen.get(key);
        if (yaEsta) {
            // Misma hora, otra estilista: capacidad, no ruido.
            if (!yaEsta.alternativas.some(a => a.id === s.stylistId)) {
                yaEsta.alternativas.push({ id: s.stylistId, name: s.stylistName });
            }
            continue;
        }
        // Al llegar al tope dejamos de aceptar horas NUEVAS. Aquí `break` daría hoy el
        // mismo resultado —el sort agrupa las filas de una misma (fecha,hora), así que la
        // última hora aceptada ya ha recogido sus alternativas antes de que aparezca una
        // hora nueva—, pero eso es una propiedad del ORDEN, no de este bucle. Con
        // `continue` la recogida de alternativas no depende de cómo esté ordenado.
        // Comprobado por mutación: cambiarlo por `break` NO tumba ningún test, y por eso
        // ningún test afirma que lo haga.
        if (unique.length >= MAX_TOTAL) continue;
        const conAlternativas = { ...s, alternativas: [{ id: s.stylistId, name: s.stylistName }] };
        seen.set(key, conAlternativas);
        unique.push(conAlternativas);
    }

    // Banderas para que el bot avise al LLM en vez de callarse:
    //  - requestedDayUnavailable: el DÍA pedido no tenía disponibilidad real y estos son los
    //    huecos más cercanos (alternativas verídicas, no inventadas).
    //  - weekPreferenceRelaxed: la SEMANA pedida no se ha podido honrar (ventana agotada o
    //    sin huecos) y estos huecos caen fuera de ella.
    unique.requestedDayUnavailable = pedidoDiaSinHueco;
    unique.weekPreferenceRelaxed = weekPreferenceRelaxed && unique.length > 0;

    if (unique.length) return conCausa(unique, null);

    // Cero real tras haberlo intentado todo (incluidas ETAPA A y B). Se diagnostica el
    // PORQUÉ recorriendo lo que ya está en memoria — sin volver a la BD — para que el bot
    // pueda decir la verdad ("está completo" / "no cabe en la jornada") en vez del
    // "no hay huecos cargados" genérico que el LLM interpreta como avería.
    let hayAlgunaJornada = false;   // ¿alguien trabaja algún día del rango?
    let cabeEnAlgunaJornada = false; // ¿el servicio cabe en alguna de esas jornadas?
    for (const { scheduleByDay } of stylistData) {
        for (const { dayOfWeek } of calendarDays) {
            const ds = scheduleByDay.get(dayOfWeek);
            if (!ds) continue;
            hayAlgunaJornada = true;
            const [sH, sM] = ds.start_time.split(':').map(Number);
            const [eH, eM] = ds.end_time.split(':').map(Number);
            // Mismo criterio estricto que computeFreeSlots: la cita debe TERMINAR antes del
            // cierre, no justo al cierre.
            if ((sH * 60 + sM) + serviceDuration < (eH * 60 + eM)) { cabeEnAlgunaJornada = true; break; }
        }
        if (cabeEnAlgunaJornada) break;
    }

    const causa = !hayAlgunaJornada ? CAUSAS_CERO.SIN_HORARIO
        : !cabeEnAlgunaJornada ? CAUSAS_CERO.NO_CABE
        : CAUSAS_CERO.AGENDA_LLENA;

    logger.warn('sante_cero_huecos_diagnosticado', {
        orgId, causa, serviceCategory, serviceDuration,
        estilistasElegibles: eligible.length,
        preferencia,
    });
    return conCausa(unique, causa);
}

function addSlot(slots, dateStr, minuteOfDay, diaNombre, stylist, serviceDuration, preferencia, lang = null) {
    const hora = `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;
    const hourNum = Math.floor(minuteOfDay / 60);

    if (preferencia.periodo === 'mañana' || preferencia.periodo === 'manana') {
        if (hourNum >= 14) return;
    } else if (preferencia.periodo === 'tarde') {
        if (hourNum < 14) return;
    }

    // En el idioma de la clienta, y con el día formateado EXACTAMENTE como en el
    // recordatorio (formatSlotTexto reutiliza formatReminderWhen — ver helpers.js). Hasta
    // el 11/08/2026 esto era un toLocaleDateString('es-ES') a secas y una clienta anglófona
    // recibía los huecos en castellano en mitad de su conversación en inglés.
    let texto = formatSlotTexto(dateStr, hora, lang, stylist.name);
    if (!texto) {
        // dateStr lo fabrica addDaysStr y siempre es YYYY-MM-DD, así que esto no debería
        // dispararse; si algún día una fecha no se entiende, sale el texto de siempre en
        // castellano en vez de un hueco sin texto (regla 3: se degrada, no se calla).
        const fechaDate = new Date(dateStr + 'T12:00:00');
        const fechaFormatted = fechaDate.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
        texto = `el ${fechaFormatted} a las ${hora} con ${stylist.name}`;
    }

    slots.push({
        fecha: dateStr,
        hora,
        diaNombre,
        stylistId: stylist.id,
        stylistName: stylist.name,
        texto,
    });
}

// Recorta un intervalo [startsAt, endsAt] al día de negocio `dateStr` y lo devuelve en
// minutos-del-día, o null si no lo toca.
//
// Por qué existe: `toMinutes` da el minuto del día y TIRA la fecha. Aplicado a los dos
// extremos de un intervalo que cruza la medianoche, el resultado no es el intervalo:
//   · un bloqueo del 14 a las 18:00 hasta el 15 a las 13:00 daba {start:1080, end:780} —
//     invertido. computeFreeSlots deja `cursor` sin avanzar y el día entero sigue libre:
//     el bloqueo NO bloquea ni siquiera su propio día de inicio.
//   · uno del 14 a las 12:00 hasta el 15 a las 16:00 daba {start:720, end:960} — no
//     invertido, y por eso más engañoso: se aplica como "de 12:00 a 16:00" en LOS DOS
//     días. El 14 se ofrece de 16:00 en adelante (la estilista no está) y el 15 se ofrece
//     de 10:00 a 12:00 (tampoco).
// Las dos formas están fijadas en tests/bloqueo-multidia.test.js.
//
// El recorte también es la red que impide que un intervalo invertido llegue a
// computeFreeSlots por cualquier otra vía: si tras recortar `end <= start`, no ocupa nada
// y se descarta, en vez de colarse y dejar el día abierto sin que nadie se entere.
function recortarAlDia(startsAt, endsAt, dateStr) {
    const ini = new Date(startsAt);
    const fin = new Date(endsAt);
    if (isNaN(ini.getTime()) || isNaN(fin.getTime())) return null;
    const diaIni = toLocalDateStr(ini);
    const diaFin = toLocalDateStr(fin);
    if (diaIni > dateStr || diaFin < dateStr) return null;   // no toca este día
    const start = diaIni < dateStr ? 0 : toMinutes(ini);      // venía de días anteriores
    const end = diaFin > dateStr ? 24 * 60 : toMinutes(fin);  // sigue días después
    if (end <= start) return null;
    return { start, end };
}

// Cálculo puro de huecos: resta los intervalos `occupied` del horario [workStart,workEnd] y
// barre cada ventana libre en pasos de `step`, devolviendo los minutos-de-día de inicio
// válidos para un servicio de `serviceDuration`. Sin dependencias de BD ni de reloj — esta
// es la lógica que los tests de regresión fijan para SIEMPRE (citas parciales, huecos entre
// varias citas, bordes del turno). El estado de la cita (confirmed/no_show) no interviene
// aquí: quien construye `occupied` decide qué bloquea (la capa db excluye solo 'cancelled').
function computeFreeSlots({ workStart, workEnd, occupied = [], serviceDuration, step = SLOT_OFFER_STEP_MIN, minStart = 0 }) {
    const sorted = [...occupied].sort((a, b) => a.start - b.start);
    const freeWindows = [];
    let cursor = workStart;
    for (const occ of sorted) {
        if (occ.start > cursor) freeWindows.push([cursor, Math.min(occ.start, workEnd)]);
        cursor = Math.max(cursor, occ.end);
    }
    if (cursor < workEnd) freeWindows.push([cursor, workEnd]);

    // t + serviceDuration <= winEnd: no solapar la siguiente cita ni salir de la ventana.
    // Además t + serviceDuration < workEnd: nunca ofrecer un hueco cuya cita terminaría
    // exactamente al cierre o después (sin margen).
    const starts = [];
    for (const [winStart, winEnd] of freeWindows) {
        for (let t = winStart; t + serviceDuration <= winEnd && t + serviceDuration < workEnd; t += step) {
            if (t < minStart) continue;
            starts.push(t);
        }
    }
    return starts;
}

function formatSlotForMessage(slot) {
    return slot.texto || `el ${slot.diaNombre} ${slot.fecha} a las ${slot.hora} con ${slot.stylistName}`;
}

// La duración se DECIDE arriba (helpers.resolveAppointmentDurationMin, que ya tiene su
// propio fallback y lo declara). Aquí abajo un `duracionMin || 60` no era una decisión:
// era un tercer valor por defecto —el bot ponía 60, esto 60 y db.js 120— tapando que
// nadie había resuelto la duración. Y taparlo cuesta caro: ends_at corto publica agenda
// libre encima de una clienta. Así que esto es una aserción del contrato, no un rescate.
// Con el bot resolviendo siempre un positivo, en producción nunca dispara; si dispara es
// un fallo de programación y sale como fallo, no como cita de 60 minutos.
function assertDuracion(duracionMin, fn, ctx) {
    const dur = Number(duracionMin);
    if (Number.isFinite(dur) && dur > 0) return null;
    logger.error('duracion_cita_invalida', { ...ctx, fn, duracionMin: duracionMin ?? null });
    return { success: false, reason: 'duracion_invalida' };
}

// Devuelve `reason` en el fallo, simétrico con rescheduleAppointment. Sin él, el bot no
// podía distinguir "el hueco no es válido" de "Supabase está caído" y ambos acababan en el
// mismo "no he podido fijar ese hueco", ocultando la avería:
//   'db_error'     → saveAppointment lanzó (RLS, FK, timeout). Reintentable.
//   'invalid_slot' → contacto/fecha/hora que saveAppointment rechaza. Reintentar no arregla.
//   'duracion_invalida' → ver assertDuracion.
async function bookAppointment(orgId, slot, contactId, { servicio, duracionMin, stylistId, notas } = {}) {
    const durErr = assertDuracion(duracionMin, 'bookAppointment', { orgId, contactId });
    if (durErr) return durErr;
    let apt;
    try {
        apt = await db.saveAppointment(orgId, contactId, {
            servicio,
            fecha: slot.fecha,
            hora: slot.hora,
            duracionMin,
            estado: 'confirmed',
            stylistId: stylistId || slot.stylistId,
            notas,
        });
    } catch (e) {
        return { success: false, reason: 'db_error', error: e?.message };
    }
    if (!apt) return { success: false, reason: 'invalid_slot' };
    return { success: true, appointmentId: apt.id, appointment: apt };
}

// `actor` por defecto 'bot' porque estas dos funciones son el camino del bot: aquí sí se
// sabe quién escribe, al revés que en updateAppointment, donde no consta si nadie lo dice.
async function cancelAppointment(orgId, appointmentId, { actor = 'bot' } = {}) {
    const result = await db.updateAppointment(orgId, appointmentId, { estado: 'cancelled', actor });
    return { success: !!result };
}

// Reagenda una cita EXISTENTE moviéndola al nuevo hueco (UPDATE in-place vía la rama
// {fecha,hora,duracionMin} de db.updateAppointment, que recalcula starts_at/ends_at). No crea
// una fila nueva: evita la cita huérfana/duplicada que dejaba el flujo anterior (creaba con
// bookAppointment y no cancelaba la vieja). Simétrica con book/cancel para poder mockearla.
// Devuelve `reason` cuando falla, porque no todos los fallos se arreglan igual:
//   'not_found'    → la cita ya no existe; crear una nueva es lo correcto.
//   'db_error'     → la escritura falló pero la cita vieja SIGUE VIVA; crear otra dejaría dos
//                    reservas para la misma clienta, las dos facturables.
//   'invalid_slot' → fecha/hora que updateAppointment rechaza; insertar no arregla nada.
//   'duracion_invalida' → ver assertDuracion. NO cae al INSERT de rescate: eso escribiría
//                    la misma duración inventada en una fila nueva.
async function rescheduleAppointment(orgId, appointmentId, slot, { servicio, duracionMin, stylistId, notas, actor = 'bot' } = {}) {
    const durErr = assertDuracion(duracionMin, 'rescheduleAppointment', { orgId, appointmentId });
    if (durErr) return durErr;
    let result;
    try {
        result = await db.updateAppointment(orgId, appointmentId, {
            servicio,
            fecha: slot.fecha,
            hora: slot.hora,
            duracionMin,
            stylistId: stylistId || slot.stylistId,
            notas,
            actor,
        });
    } catch (e) {
        // updateAppointment usa .single(): sin filas, Supabase devuelve PGRST116.
        const noExiste = e?.code === 'PGRST116';
        return { success: false, reason: noExiste ? 'not_found' : 'db_error', error: e?.message };
    }
    if (!result) return { success: false, reason: 'invalid_slot' };
    return { success: true, appointmentId: result.id, appointment: result };
}

module.exports = { getAvailableSlots, bookAppointment, cancelAppointment, rescheduleAppointment, formatSlotForMessage, CAUSAS_CERO };
// Expuesto para tests de regresión (huecos + TZ-independencia + idioma del texto del
// hueco), no para uso en producción.
module.exports._internals = { computeFreeSlots, recortarAlDia, addSlot, toLocalDateStr, toMinutes, addDaysStr, mondayDow, resolveWeekdayToDate, BUSINESS_TZ };
