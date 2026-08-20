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

// Horizonte por defecto: cuántos días de calendario recorre el motor. Es el valor que usa
// el BOT, y por eso 14 sigue siendo el default: una conversación propone dos o tres huecos
// próximos, no un calendario. El ENLACE público pide 90 (tres meses, decisión de Yulia,
// 19/08/2026) y lo pasa por parámetro. Que el bot no lo pase es lo que garantiza que no se
// entera de este cambio.
//
// NO tiene nada que ver con el «CALENDARIO DE REFERENCIA (próximos 14 días)» del prompt
// (providers/openai.js): aquello es una tabla de consulta para que el modelo no calcule
// fechas de cabeza, y subirla metería 90 líneas en cada turno de las DOS organizaciones
// para siempre, además de invitarle a proponer fechas lejanas sin datos detrás. Son dos
// catorces distintos y solo se mueve este.
const HORIZONTE_DIAS_DEFAULT = 14;
// Techo del horizonte. No es una política del salón —eso lo decide quien llama— sino el
// límite a partir del cual un valor deja de ser una decisión y es un bug: un año de
// calendario ya cubre cualquier cosa que un salón pueda querer decir. Se ASERTA, no se
// recorta en silencio (regla 3): recortar 100000 a 366 devolvería huecos correctos para una
// pregunta que nadie hizo.
const HORIZONTE_DIAS_MAX = 366;

// Valida el horizonte. LANZA, y eso es deliberado: es un contrato de programación, como
// assertDuracion. Solo puede dispararlo un llamador que PASE el parámetro — los del bot no
// lo pasan, así que para ellos es inalcanzable. Los dos call sites del bot envuelven la
// llamada en try/catch (`error_slots` / `error_reload_confirmacion`), así que ni siquiera un
// llamador nuevo equivocado tumba el turno: sale como fallo, que es lo que es.
function resolverHorizonte(horizonteDias) {
    if (horizonteDias === undefined || horizonteDias === null) return HORIZONTE_DIAS_DEFAULT;
    // Número de verdad, no una cadena: un query param llega como texto y convertirlo AQUÍ
    // sería adivinar por quien lo leyó — `Number('')` es 0 y `Number(true)` es 1, y los dos
    // pasarían como horizontes plausibles. Quien lee el parámetro es quien sabe qué
    // significa que venga vacío.
    if (!Number.isInteger(horizonteDias) || horizonteDias < 1 || horizonteDias > HORIZONTE_DIAS_MAX) {
        throw new TypeError(`horizonteDias invalido: ${JSON.stringify(horizonteDias)} (entero entre 1 y ${HORIZONTE_DIAS_MAX})`);
    }
    return horizonteDias;
}

/**
 * Prepara el motor UNA vez: estilistas elegibles, rango de fechas y prefetch de
 * horarios/bloqueos/citas. Devuelve un contexto con `buildSlots(pref)`, que genera las filas
 * (estilista × día × hora) sin volver a la base de datos.
 *
 * Existe para que `getAvailableSlots` (el bot) y `getAvailableDays` (el enlace) salgan del
 * MISMO sitio. Con dos motores, la vista de mes del enlace acabaría enseñando un día en
 * verde que al abrirlo no tiene huecos, y nadie sabría cuál de los dos miente. Lo que cada
 * uno hace con esas filas SÍ es distinto —el bot deduplica, ordena, tiene fallbacks y un
 * tope; el enlace solo quiere saber qué días tienen algo— y por eso la raya está aquí.
 *
 * @returns {{causa: string}|{buildSlots: Function, diagnosticarCero: Function,
 *            eligible: Array, weekPreferenceRelaxed: boolean}}
 */
async function prepararMotor(orgId, { serviceDuration = 60, serviceCategory, preferredStylistId, horizonteDias, asap = false, lang = null, sinTexto = false } = {}) {
    const dias = resolverHorizonte(horizonteDias);
    const allStylists = await db.getStylistsByOrg(orgId);
    // Las dos salidas tempranas devuelven SOLO la causa, sin contexto: quien llama no puede
    // confundirlas con "hay motor y no ha salido ningún hueco", que es un estado distinto y
    // se diagnostica al final, con diagnosticarCero().
    if (!allStylists.length) return { causa: CAUSAS_CERO.SIN_ESTILISTAS };

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
            return { causa: CAUSAS_CERO.SIN_SKILL };
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
    // recorrido se hace sobre strings YYYY-MM-DD, independiente de la TZ del proceso.
    const startDateStr = asap ? todayStr : addDaysStr(todayStr, 1);
    const endDateStr = addDaysStr(startDateStr, dias);
    const fromDateStr = startDateStr;
    const toDateStr = endDateStr;

    // Rango para las consultas a BD: cubre los días de negocio del horizonte con ±1 día de holgura
    // (el filtrado fino se hace luego re-agrupando cada cita/bloqueo por su fecha de negocio).
    const fromStr = new Date(new Date(startDateStr + 'T00:00:00Z').getTime() - 24 * 3600 * 1000).toISOString();
    const toStr = new Date(new Date(endDateStr + 'T00:00:00Z').getTime() + 24 * 3600 * 1000).toISOString();
    // Prefetch del horario/bloqueos/citas de cada estilista UNA sola vez. Así podemos recorrer
    // los días dos veces (con el filtro de día pedido y, si no hay nada, sin él) sin volver a
    // pegarle a la base de datos.
    //
    // ── D7, y por qué la respuesta es PARALELIZAR y no agrupar ──────────────────────────
    // Esto eran 3 lecturas EN SERIE por estilista más la de días bloqueados: con las cuatro
    // generalistas de Sante, 14 viajes encadenados. Medido el 20/08/2026 contra la Supabase
    // real (`npm run medir:prefetch -- sante`): 14 tandas, 1027 ms de mediana, de los cuales
    // 993 eran ESPERA — o sea, el coste era la PROFUNDIDAD (viajes encadenados), no el
    // volumen. Encadenar catorce esperas de ~71 ms se disimula en una conversación, donde
    // ya se está esperando al modelo; en un formulario público que llama a esto en cada
    // clic, y a 90 días, no.
    //
    // La alternativa era agrupar las tres lecturas en tres consultas con `.in(stylist_id)`.
    // Se descartó y conviene no reabrirlo sin releer esto: bajaría de 14 viajes a 5 pero
    // seguirían siendo las mismas 2 tandas, o sea prácticamente el mismo reloj — y a cambio
    // (a) rompería los dobles de ~25 ficheros de test que stubean estas tres funciones por
    // estilista, unos ruidosamente y otros dejando al motor hablar con la Supabase REAL, y
    // (b) metería una lectura sin trocear cuyo truncado por límite de filas se leería como
    // "esta estilista no tiene citas", que es la lectura más peligrosa de las cinco.
    //
    // El abanico está acotado por el tamaño del equipo del salón (hoy 8, y 4 tras el filtro
    // de skill): no es una fan-out que crezca con los datos.
    const [allBlockedDays, stylistData] = await Promise.all([
        db.getBlockedDays(orgId, { from: fromDateStr, to: toDateStr }),
        // Promise.all CONSERVA EL ORDEN de entrada, y eso aquí no es un detalle: `eligible`
        // viene ordenado por nombre desde getStylistsByOrg y de ese orden depende quién gana
        // cada empate en el dedupe por (fecha,hora). Con un `for await` que fuera resolviendo
        // por llegada, la ganadora la decidiría la latencia de la red.
        Promise.all(eligible.map(async (stylist) => {
            const [schedule, blocks, appointments] = await Promise.all([
                db.getStylistSchedule(orgId, stylist.id),
                db.getScheduleBlocks(orgId, stylist.id, fromStr, toStr),
                db.getAppointmentsByStylistAndRange(orgId, stylist.id, fromStr, toStr),
            ]);
            const scheduleByDay = new Map();
            for (const s of schedule) scheduleByDay.set(s.day_of_week, s);
            return { stylist, scheduleByDay, blocks, appointments };
        })),
    ]);
    const salonBlockedDates = new Set(allBlockedDays.filter(b => !b.stylist_id).map(b => b.fecha));
    const stylistBlockedDates = new Map();
    for (const b of allBlockedDays) {
        if (!b.stylist_id) continue;
        if (!stylistBlockedDates.has(b.stylist_id)) stylistBlockedDates.set(b.stylist_id, new Set());
        stylistBlockedDates.get(b.stylist_id).add(b.fecha);
    }

    // Recorre los días del horizonte y construye los huecos reales según horario, citas y
    // bloqueos. `pref` puede traer filtros de día/semana/franja. NUNCA inventa huecos:
    // si la estilista no trabaja ese día (no hay daySchedule), simplemente no se generan.
    // Los días de calendario a recorrer, en TZ de negocio, con su día de la semana
    // (0=lunes). Aritmética pura de fechas → idéntico en cualquier TZ del proceso.
    const calendarDays = [];
    for (let d = 0; d < dias; d++) {
        const dateStr = addDaysStr(startDateStr, d);
        calendarDays.push({ dateStr, dayOfWeek: mondayDow(dateStr) });
    }
    const todayDow = mondayDow(todayStr);

    // ¿Se ha tenido que soltar (total o parcialmente) el filtro de semana que pidió la
    // clienta? El bot lo usa para DECIRLO en voz alta en vez de proponer en silencio días de
    // otra semana. Lo escribe buildSlots (ventana blanda) y la ETAPA A del fallback.
    // Vive en el contexto y no en una local: buildSlots la ESCRIBE y el llamador la LEE
    // después, y los dos llamadores (huecos y días) están ya fuera de esta función.
    const ctx = { weekPreferenceRelaxed: false };

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
                ctx.weekPreferenceRelaxed = true;
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
                for (const t of starts) addSlot(out, dateStr, t, diaNombre, stylist, serviceDuration, pref, lang, sinTexto);
            }
        }
        return out;
    }

    // Por qué el motor daría CERO. Se calcula sobre lo que ya está en memoria y lo usan los
    // DOS llamadores: si el enlace tuviera su propio diagnóstico, una agenda llena podría
    // salir como "sin horario" en la web y como "agenda llena" en el bot, y la clienta que
    // pregunta las dos cosas recibiría dos verdades distintas.
    function diagnosticarCero() {
        let hayAlgunaJornada = false;    // ¿alguien trabaja algún día del rango?
        let cabeEnAlgunaJornada = false; // ¿el servicio cabe en alguna de esas jornadas?
        for (const { scheduleByDay } of stylistData) {
            for (const { dayOfWeek } of calendarDays) {
                const ds = scheduleByDay.get(dayOfWeek);
                if (!ds) continue;
                hayAlgunaJornada = true;
                const [sH, sM] = ds.start_time.split(':').map(Number);
                const [eH, eM] = ds.end_time.split(':').map(Number);
                // MISMO criterio que computeFreeSlots, y por eso es `<=` desde el arreglo de
                // D3: con `<` estricto, un servicio que llena la jornada justa (una jornada
                // de 5 h y un alisado de 5 h) produciría huecos y a la vez se diagnosticaría
                // como «no cabe». El diagnóstico tiene que medir lo mismo que el motor o
                // explica un cero que no es el que ha pasado.
                if ((sH * 60 + sM) + serviceDuration <= (eH * 60 + eM)) { cabeEnAlgunaJornada = true; break; }
            }
            if (cabeEnAlgunaJornada) break;
        }
        return !hayAlgunaJornada ? CAUSAS_CERO.SIN_HORARIO
            : !cabeEnAlgunaJornada ? CAUSAS_CERO.NO_CABE
            : CAUSAS_CERO.AGENDA_LLENA;
    }

    // Lo que sale del motor es lo MÍNIMO para construir filas y explicar un cero. Ni
    // `stylistData` ni `calendarDays` se exponen a propósito: quien los tuviera podría
    // montarse su propio recorrido de días a mano, que es exactamente el segundo motor que
    // este contexto existe para evitar.
    ctx.buildSlots = buildSlots;
    ctx.diagnosticarCero = diagnosticarCero;
    ctx.eligible = eligible;
    return ctx;
}

/**
 * Devuelve huecos disponibles para un servicio dentro del horizonte (14 días por defecto).
 * @param {string} orgId
 * @param {object} options
 * @param {number} options.serviceDuration — duración en minutos
 * @param {string} options.serviceCategory — categoría del servicio (para filtrar estilistas por skill)
 * @param {string} [options.preferredStylistId] — si la clienta pide una estilista concreta
 * @param {object} [options.preferencia] — { periodo: 'mañana'|'tarde', semana: 'esta'|'siguiente' }
 * @param {string|null} [options.lang] — idioma de la clienta ('es'|'en'|'ru'|'uk'); decide el
 *   idioma de `texto`. Null o desconocido caen a castellano (mismo criterio que el
 *   recordatorio). Los llamadores que no lo pasan (scripts de verificación) reciben es.
 * @param {number} [options.horizonteDias] — días de calendario a recorrer. Default 14, que es
 *   lo que pide el bot; el enlace público pasa 90. Ver HORIZONTE_DIAS_DEFAULT.
 * @returns {Array} — top slots con { fecha, hora, diaNombre, stylistId, stylistName, texto }
 */
async function getAvailableSlots(orgId, { serviceDuration = 60, serviceCategory, preferredStylistId, preferencia = {}, lang = null, horizonteDias } = {}) {
    const motor = await prepararMotor(orgId, {
        serviceDuration, serviceCategory, preferredStylistId, lang,
        horizonteDias,
        asap: !!preferencia.asap,
    });
    if (motor.causa) return conCausa([], motor.causa);
    const { buildSlots, eligible } = motor;

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
            if (slots.length) motor.weekPreferenceRelaxed = true;
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
    unique.weekPreferenceRelaxed = motor.weekPreferenceRelaxed && unique.length > 0;

    if (unique.length) return conCausa(unique, null);

    // Cero real tras haberlo intentado todo (incluidas ETAPA A y B). El PORQUÉ lo calcula
    // el motor, sin volver a la BD, para que el bot pueda decir la verdad ("está completo" /
    // "no cabe en la jornada") en vez del "no hay huecos cargados" genérico que el LLM
    // interpreta como avería.
    const causa = motor.diagnosticarCero();

    logger.warn('sante_cero_huecos_diagnosticado', {
        orgId, causa, serviceCategory, serviceDuration,
        estilistasElegibles: eligible.length,
        preferencia,
    });
    return conCausa(unique, causa);
}

/**
 * Qué DÍAS del horizonte tienen algún hueco para un servicio. Es lo que necesita la vista de
 * mes del enlace público: pintar el calendario sin pedir las horas de cada día.
 *
 * Sale del MISMO prefetch que `getAvailableSlots` (prepararMotor → buildSlots), y esa es toda
 * la garantía de paridad que hay: un día que aquí sale con huecos los tiene también al
 * abrirlo. Lo prueba `tests/paridad-motor-web-bot.test.js` por mutación.
 *
 * Tres diferencias con `getAvailableSlots`, y las tres son a propósito:
 *
 *   1. **NO hay tope.** El `MAX_TOTAL` de 20 (5 con asap) es una decisión de CONVERSACIÓN:
 *      no se le sueltan veinte horas a alguien por WhatsApp. Una rejilla de tres meses con
 *      tope se quedaría en los primeros días y pintaría el resto del calendario en gris,
 *      que es exactamente la mentira que este proyecto no puede permitirse.
 *   2. **NO hay fallback (ETAPA A/B).** Esos rescates existen para no dejar muda una
 *      conversación cuando la clienta pide un día imposible; una rejilla ya enseña los días
 *      buenos, así que "soltar el filtro y proponer otra cosa" no significa nada aquí.
 *   3. **NO se deduplica por hora.** El dedupe es presentación (una estilista por hueco); un
 *      día se cuenta por sus horas distintas y por TODAS las estilistas libres en él, que es
 *      lo que luego permite reintentar con otra cuando el claim pierda la carrera.
 *
 * `causa` viaja igual que en getAvailableSlots: una lista vacía nunca es un `[]` pelado.
 *
 * @param {string} orgId
 * @param {object} options — mismos que getAvailableSlots salvo `lang` (aquí no hay texto que
 *   traducir: un día no se verbaliza, se pinta).
 * @returns {Array} — [{ fecha, diaSemana, huecos, estilistas: [{id, name}] }], en orden
 *   cronológico y solo con los días que tienen algo.
 */
async function getAvailableDays(orgId, { serviceDuration = 60, serviceCategory, preferredStylistId, preferencia = {}, horizonteDias } = {}) {
    const motor = await prepararMotor(orgId, {
        serviceDuration, serviceCategory, preferredStylistId,
        horizonteDias,
        asap: !!preferencia.asap,
        // Sin idioma y sin texto: aquí se descartarían miles de cadenas formateadas para
        // nada. Ver `sinTexto` en prepararMotor.
        sinTexto: true,
    });
    if (motor.causa) return conCausa([], motor.causa);

    const filas = motor.buildSlots(preferencia);

    const porDia = new Map();
    for (const s of filas) {
        let dia = porDia.get(s.fecha);
        if (!dia) {
            dia = { fecha: s.fecha, diaSemana: mondayDow(s.fecha), horas: new Set(), estilistas: new Map() };
            porDia.set(s.fecha, dia);
        }
        dia.horas.add(s.hora);
        // Map y no Set para conservar el nombre; la primera vez gana, y como `eligible` viene
        // ordenado por nombre desde db.getStylistsByOrg, el orden es alfabético y estable.
        if (!dia.estilistas.has(s.stylistId)) dia.estilistas.set(s.stylistId, s.stylistName);
    }

    // Orden cronológico por la cadena YYYY-MM-DD, que se compara como texto sin construir ni
    // una Date — el mismo criterio que usa todo el recorrido de días de este fichero.
    const dias = [...porDia.values()]
        .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0))
        .map(d => ({
            fecha: d.fecha,
            diaSemana: d.diaSemana,
            huecos: d.horas.size,
            estilistas: [...d.estilistas].map(([id, name]) => ({ id, name })),
        }));

    if (dias.length) return conCausa(dias, null);

    const causa = motor.diagnosticarCero();
    logger.warn('sante_cero_dias_diagnosticado', {
        orgId, causa, serviceCategory, serviceDuration,
        horizonteDias: horizonteDias ?? HORIZONTE_DIAS_DEFAULT,
        estilistasElegibles: motor.eligible.length,
        preferencia,
    });
    return conCausa(dias, causa);
}

// `sinTexto` lo pone SOLO getAvailableDays, y no es una micro-optimización caprichosa: a 90
// días son unos cuantos miles de cadenas formateadas que nadie va a leer, porque un día de la
// rejilla se pinta con un número, no con «el miércoles a las 10:00 con Irina». Todo lo demás
// —qué horas existen, de quién son, qué filtros se aplican— es IDÉNTICO en los dos caminos:
// si el texto decidiera algo, este flag sería una divergencia y no un ahorro.
function addSlot(slots, dateStr, minuteOfDay, diaNombre, stylist, serviceDuration, preferencia, lang = null, sinTexto = false) {
    const hora = `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;
    const hourNum = Math.floor(minuteOfDay / 60);

    if (preferencia.periodo === 'mañana' || preferencia.periodo === 'manana') {
        if (hourNum >= 14) return;
    } else if (preferencia.periodo === 'tarde') {
        if (hourNum < 14) return;
    }

    if (sinTexto) {
        slots.push({ fecha: dateStr, hora, diaNombre, stylistId: stylist.id, stylistName: stylist.name, texto: null });
        return;
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

    // `t + serviceDuration <= winEnd`, y NADA MÁS. No hace falta comparar también contra
    // `workEnd`: las ventanas ya vienen capadas ahí arriba —`Math.min(occ.start, workEnd)` y
    // la última es `[cursor, workEnd]`—, así que la condición de la ventana ya garantiza que
    // la cita cabe en la jornada.
    //
    // ── D3, arreglado el 20/08/2026 ─────────────────────────────────────────────────────
    // Aquí había además `&& t + serviceDuration < workEnd`, estricto, y lo único que hacía
    // era tirar el hueco cuya cita termina EXACTAMENTE al cierre: uno por jornada, por
    // estilista y por servicio. En una conversación lo tapaba una persona; en una página
    // pública es dinero todos los días.
    //
    // Y el sistema llevaba desde el 19/08 desalineado consigo mismo a propósito:
    // `reservar_hueco()` (migración 043, APLICADA) valida con `v_fin <= end_time` y su
    // comentario dice, con estas palabras, que se dejó permisiva esperando este arreglo —
    // «al revés, función estricta y motor permisivo, sería una reserva ofrecida y luego
    // rechazada con un mensaje incomprensible». `tests/lib/agenda-audit.js` también lo tiene
    // inclusivo («ends_at incluido»). El motor era el único que decía `<`.
    //
    // MEDIDO contra la agenda real antes de tocarlo (`npm run medir:borde -- sante`, 90
    // días): 9.380 filas de más y 4.405 horas visibles de más en el catálogo entero; un
    // servicio de 30′ gana UNA hora al final de 76 de los próximos 90 días. Y las tres
    // comprobaciones a cero: ninguno empieza antes de abrir, ninguno pasa del cierre,
    // ninguno pisa una cita ni un bloqueo. Los 9.380 terminan JUSTO al cierre, que es
    // exactamente lo que se estaba tirando.
    const starts = [];
    for (const [winStart, winEnd] of freeWindows) {
        for (let t = winStart; t + serviceDuration <= winEnd; t += step) {
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

module.exports = { getAvailableSlots, getAvailableDays, bookAppointment, cancelAppointment, rescheduleAppointment, formatSlotForMessage, CAUSAS_CERO, HORIZONTE_DIAS_DEFAULT, HORIZONTE_DIAS_MAX };
// Expuesto para tests de regresión (huecos + TZ-independencia + idioma del texto del
// hueco), no para uso en producción.
module.exports._internals = { computeFreeSlots, recortarAlDia, addSlot, toLocalDateStr, toMinutes, addDaysStr, mondayDow, resolveWeekdayToDate, BUSINESS_TZ };
