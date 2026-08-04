/**
 * verify-sante-catalog.js — Verificación exhaustiva del sistema de reservas de Sante.
 *
 * Objetivo: dejar de encontrar bugs uno a uno por WhatsApp. Recorre el catálogo REAL
 * completo (leído de Supabase, no hardcodeado) y, para CADA servicio, verifica de golpe:
 *
 *   Fase 1  Resolución por nombre + nombre completo que se guardaría en appointments.service.
 *   Fase 2  Variantes de largo: cada variante se resuelve, incluso tras cambiar de opinión
 *           2-3 veces sobre el largo (como pasó con Balayage).
 *   Fase 3  Al menos una estilista activa tiene la skill de cada categoría.
 *   Fase 4  getAvailableSlots NO devuelve totalSlots:0 injustificado — probando los 7 días de
 *           la semana como "hoy", con/sin estilista, y pidiendo asap/mañana/esta semana/
 *           semana que viene/fecha concreta. Sobre un horario sintético abierto (10–19 los 7
 *           días, sin citas ni bloqueos) un 0 es SIEMPRE un bug (falso 0), no ruido de agenda.
 *   Fase 5  El upselling asociado (si lo hay) cabe antes del cierre de 19:00.
 *
 * Todo se ejecuta contra las funciones internas (extractServiceFromText, calendar-sante.js,
 * buildFullServiceName…) simulando fechas con un mock de `Date` y mockeando la capa `db` —
 * SIN WhatsApp real ni tokens de LLM. Corre en segundos.
 *
 * Uso:  npm run verify:sante   (necesita SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY reales)
 *
 * NOTA: no forma parte de `npm test` (que es hermético y corre en CI sin credenciales);
 * es una verificación bajo demanda contra la org de Sante. No toca San Remo.
 */

require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Madrid';

const { SANTE_ORG_ID } = require('../services/org-registry');
const db = require('../services/db');
const {
    extractServiceFromText,
    buildFullServiceName,
    classifyLargoVariant,
    detectLargoCategory,
    extractLargoPelo,
    matchUpsellSuggestion,
    normalizeText,
    extractStylistFromText,
} = require('../services/helpers');
const calendarSante = require('../services/calendar-sante');

// ─── Mini-runner: silencioso salvo fallos, con resumen por fase ──────────────────────
const stats = {};
const failures = [];
const warnings = [];

function check(phase, ok, label, detail) {
    const s = (stats[phase] ||= { pass: 0, fail: 0 });
    if (ok) { s.pass++; return true; }
    s.fail++;
    failures.push(`[${phase}] ${label}${detail ? ' — ' + detail : ''}`);
    process.exitCode = 1;
    return false;
}
function warn(phase, label) { warnings.push(`[${phase}] ${label}`); }

// ─── Mock de `Date` (copiado de tests/calendar-sante-slots.test.js) ──────────────────
// getAvailableSlots usa `new Date()` directo; esta es la ÚNICA vía para fijar "hoy".
async function withMockedNow(isoString, fn) {
    const RealDate = Date;
    class MockDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) { super(isoString); return; }
            super(...args);
        }
        static now() { return new RealDate(isoString).getTime(); }
    }
    global.Date = MockDate;
    try { return await fn(); } finally { global.Date = RealDate; }
}

const HARD_CUTOFF = 19 * 60;   // 19:00 — tope de salón (mismo valor que bot.js)
const WORK_START = 10 * 60;    // 10:00 — apertura sintética

// Mismo criterio de skill que calendar-sante.js:46 (lowercase exacto, sin quitar acentos).
const skillMatches = (skills, categoria) =>
    (Array.isArray(skills) ? skills : []).some(sk => String(sk).toLowerCase() === String(categoria).toLowerCase());

// Nombre "genérico" según buildFullServiceName: "Largo N" o un nombre repetido en el catálogo.
const esNombreGenerico = (nombre, catalog) => {
    const norm = normalizeText(nombre || '');
    return /^largo\s*\d+$/.test(norm) || catalog.filter(s => normalizeText(s.nombre) === norm).length > 1;
};

// ¿El nombre completo refleja su categoría? Por TOKENS y sin plural, no por subcadena.
//
// Un `includes()` sobre el texto crudo daba un fallo fantasma: buildFullServiceName prefija
// "Corte" en SINGULAR a los servicios de la categoría "Cortes" (helpers.js:903, deliberado —
// el prefijo natural es "Corte hombre", no "Cortes hombre"), así que "corte hombre" no
// contiene "cortes" y el check llevaba días en rojo por un servicio perfectamente correcto.
// Un fallo permanente que no hay que arreglar enseña a ignorar el informe entero.
// El separador tampoco puede ser el espacio: "Manicura/Pedicura Hombre" parte por la barra.
const stems = (texto) => normalizeText(texto)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(t => t.replace(/s$/, '')); // cortes→corte, mechas→mecha; aplicado a AMBOS lados

const reflejaCategoria = (nombre, categoria) => {
    const necesarios = stems(categoria);
    const presentes = new Set(stems(nombre));
    return necesarios.length > 0 && necesarios.every(t => presentes.has(t));
};

// Aritmética pura de fechas YYYY-MM-DD (idéntica a addDaysStr de calendar-sante).
const addDays = (dateStr, n) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};

(async () => {
    // ─── Fase 0: carga de datos reales (Supabase, una sola vez) ──────────────────────
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('❌ Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Configúralos en .env.');
        process.exit(1);
    }
    const cfg = await db.getAgentConfig(SANTE_ORG_ID);
    if (!cfg) {
        console.error(`❌ No hay agent_config para Sante (org ${SANTE_ORG_ID}). ¿Credenciales/ORG correctas?`);
        process.exit(1);
    }
    const catalog = Array.isArray(cfg.services) ? cfg.services : [];
    const upsellingRules = cfg.business_info?.upselling || [];
    const realStylists = await db.getStylistsByOrg(SANTE_ORG_ID);
    if (!catalog.length) { console.error('❌ Catálogo de servicios vacío.'); process.exit(1); }
    if (!realStylists.length) { console.error('❌ Sin estilistas activas.'); process.exit(1); }

    console.log(`\nCatálogo: ${catalog.length} servicios · Estilistas activas: ${realStylists.length} · Reglas upsell: ${upsellingRules.length}`);

    const categories = [...new Set(catalog.map(s => s.categoria).filter(Boolean))];
    const byCat = {};
    for (const svc of catalog) (byCat[svc.categoria] ||= []).push(svc);
    const eligibleByCat = {};
    for (const cat of categories) eligibleByCat[cat] = realStylists.filter(s => skillMatches(s.skills, cat));

    // Horarios REALES de cada estilista, leídos una vez. Los usan la Fase 3 (tener la skill
    // no basta: una estilista sin horario es invisible para el motor de huecos, así que su
    // categoría es irreservable aunque figure cubierta) y la Fase 6.
    const horarioPorEstilista = new Map();
    for (const s of realStylists) horarioPorEstilista.set(s.id, await db.getStylistSchedule(SANTE_ORG_ID, s.id));
    const conHorario = (lista) => (lista || []).filter(s => (horarioPorEstilista.get(s.id) || []).length > 0);

    // ─── Fase 1: resolución por nombre exacto + nombre completo (offline) ─────────────
    for (const svc of catalog) {
        const label = `${svc.categoria} / ${svc.nombre}`;
        const fullName = buildFullServiceName(svc, catalog);
        if (!check('1-resolucion', !!fullName, label, 'buildFullServiceName devolvió null')) continue;

        // Nombre genérico ("Largo N" / repetido) → el nombre completo DEBE prefijar la categoría.
        if (esNombreGenerico(svc.nombre, catalog) && svc.categoria &&
            !reflejaCategoria(svc.nombre, svc.categoria)) {
            check('1-resolucion', reflejaCategoria(fullName, svc.categoria),
                label, `nombre completo "${fullName}" no refleja la categoría "${svc.categoria}"`);
        }

        // El nombre completo debe resolver de vuelta a la MISMA categoría.
        const res = extractServiceFromText(fullName, catalog);
        if (check('1-resolucion', !!res, `resolver "${fullName}"`, 'extractServiceFromText devolvió null') && res) {
            check('1-resolucion', normalizeText(res.categoria) === normalizeText(svc.categoria),
                `resolver "${fullName}"`, `resolvió a "${res.categoria}" en vez de "${svc.categoria}"`);
        }
    }

    // ─── Fase 2: variantes de largo + cambio de opinión (offline) ─────────────────────
    // Texto natural del cliente por nivel de largo (mismo vocabulario que extractLargoPelo).
    const largoText = {
        1: 'hasta los hombros',
        2: 'por media espalda',
        3: 'por la cintura',
        4: 'muy largo, por debajo de la cintura',
    };
    for (const cat of categories) {
        const variantSvcs = (byCat[cat] || []).filter(s => classifyLargoVariant(s.nombre) != null);
        if (variantSvcs.length < 2) continue; // no es categoría multi-largo

        check('2-largo', !!detectLargoCategory(cat, catalog), `detectLargoCategory("${cat}")`,
            'no detectó la categoría con variantes de largo');

        for (const svc of variantSvcs) {
            const L = classifyLargoVariant(svc.nombre);
            // Simular que el cliente cambia de opinión: 2 niveles señuelo y acaba en L.
            const decoys = [1, 2, 3, 4].filter(n => n !== L).slice(0, 2);
            const secuencia = [...decoys.map(n => largoText[n]), largoText[L]];
            const finalLevel = secuencia.map(extractLargoPelo).filter(x => x != null).pop();
            check('2-largo', finalLevel === L, `${cat}: cambio de opinión → L${L}`,
                `la última señal ("${largoText[L]}") dio L${finalLevel}`);

            // La variante final debe existir dentro de la categoría y tener nombre completo válido.
            const resolved = (byCat[cat] || []).find(s => classifyLargoVariant(s.nombre) === finalLevel);
            if (check('2-largo', !!resolved, `${cat}: resolver variante L${L}`,
                `no hay variante de nivel ${finalLevel} en la categoría`) && resolved) {
                const full = buildFullServiceName(resolved, catalog);
                if (check('2-largo', !!full, `${cat}: nombre completo L${L}`, 'buildFullServiceName null') &&
                    esNombreGenerico(resolved.nombre, catalog) &&
                    !reflejaCategoria(resolved.nombre, cat)) {
                    check('2-largo', reflejaCategoria(full, cat),
                        `${cat}: prefijo de categoría L${L}`, `"${full}" no refleja la categoría`);
                }
            }
        }
    }

    // ─── Fase 3: cobertura de skill + horario (estilistas reales) ─────────────────────
    for (const cat of categories) {
        const elegibles = eligibleByCat[cat] || [];
        if (!check('3-skill', elegibles.length >= 1, `categoría "${cat}"`,
            'ninguna estilista activa tiene esa skill')) continue;
        // Con la skill pero sin horario el servicio no se puede reservar: el motor no la
        // considera ningún día. Es indistinguible de "no tiene la skill" para la clienta.
        check('3-skill', conHorario(elegibles).length >= 1, `categoría "${cat}": alguien con horario`,
            `tienen la skill [${elegibles.map(s => s.name)}] pero ninguna tiene horario configurado`);
    }

    // Y la cobertura al revés: ninguna estilista activa puede ser un fantasma. Si sus skills
    // no casan con NINGUNA categoría del catálogo, el motor no la propone jamás: figura en el
    // panel, la dueña cuenta con ella, y para las clientas no existe. Es el mismo desenlace
    // que no tener horario, y hasta ahora salía verde.
    //
    // Sustituye al `skillsIguales: 'Irina'` que se le exigía a Natalia. Aquello comparaba dos
    // conjuntos de skills que la dueña edita por separado desde el panel: el día que tocara
    // las de cualquiera de las dos, el check se ponía en rojo sin que nada estuviera roto — la
    // misma bomba que los horarios de la Fase 6, y sin verificar nada útil de paso, porque a
    // Natalia lo que hay que exigirle es que el bot pueda usarla, no que sea el clon de otra.
    //
    // La excepción se declara por SKILL y no por nombre: "Extensiones de cabello" no está en
    // el catálogo a propósito (la cita se gestiona a mano, se afirma en la Fase 6), así que
    // quien solo tenga skills de esas debe ser inelegible. Nombrar a la persona en cambio
    // sería otro dato editable más: la dueña puede renombrarla mañana.
    const SKILLS_NO_RESERVABLES = ['Extensiones de cabello'];
    const soloHaceLoNoReservable = (s) => {
        const skills = Array.isArray(s.skills) ? s.skills : [];
        return skills.length > 0 && skills.every(sk =>
            SKILLS_NO_RESERVABLES.some(nr => normalizeText(nr) === normalizeText(sk)));
    };
    for (const s of realStylists) {
        if (soloHaceLoNoReservable(s)) continue; // agenda manual por diseño
        const suyas = categories.filter(cat => skillMatches(s.skills, cat));
        check('3-skill', suyas.length >= 1, `${s.name}: el bot puede usarla`,
            `sus skills [${(s.skills || []).join(', ')}] no casan con ninguna categoría del catálogo`);
    }

    // Centinela: Consulta debe seguir en el catálogo y con alguien que pueda atenderla, para
    // que la matriz de Fase 4 (abajo) la ejerza de verdad y no la salte por falta de elegibles.
    //
    // Antes exigía EXACTAMENTE 4 estilistas. Era la misma trampa que los horarios fijos de la
    // Fase 6: un número copiado de la migración que la dueña puede cambiar desde el panel en
    // cualquier momento, y que habría puesto el check en rojo el día que diera Consulta a una
    // quinta o se la quitara a una — sin que nada estuviera roto. Lo que el centinela necesita
    // de verdad es que la categoría NO se quede sin nadie.
    check('4-huecos', categories.includes('Consulta'), 'Consulta en catálogo',
        'la categoría Consulta desapareció del catálogo');
    check('4-huecos', conHorario(eligibleByCat['Consulta']).length >= 1, 'Consulta con estilista y horario',
        `elegibles con horario=${conHorario(eligibleByCat['Consulta']).length} (hacen falta ≥1)`);

    // ─── Fase 4: matriz de huecos (offline, horario sintético abierto) ────────────────
    const realFns = {
        getStylistsByOrg: db.getStylistsByOrg,
        getStylistSchedule: db.getStylistSchedule,
        getBlockedDays: db.getBlockedDays,
        getScheduleBlocks: db.getScheduleBlocks,
        getAppointmentsByStylistAndRange: db.getAppointmentsByStylistAndRange,
    };
    db.getStylistsByOrg = async () => realStylists; // skills reales, para el filtro de categoría
    db.getStylistSchedule = async () => [0, 1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d, start_time: '10:00:00', end_time: '19:00:00' }));
    db.getBlockedDays = async () => [];
    db.getScheduleBlocks = async () => [];
    db.getAppointmentsByStylistAndRange = async () => [];

    // 7 anclas de "hoy": Lun..Dom de una semana conocida (13/07/2026 es lunes).
    const anchors = [
        ['lunes', '2026-07-13'], ['martes', '2026-07-14'], ['miércoles', '2026-07-15'],
        ['jueves', '2026-07-16'], ['viernes', '2026-07-17'], ['sábado', '2026-07-18'], ['domingo', '2026-07-19'],
    ];

    // Combos únicos (categoría | duración): el comportamiento de huecos depende solo de la
    // categoría (→ estilistas elegibles) y la duración, no del nombre exacto. Dedup para no
    // repetir 70 veces lo mismo, sin perder cobertura de los bordes de duración.
    const combos = new Map();
    for (const svc of catalog) {
        const dur = svc.duracion || 60;
        const key = `${svc.categoria}|${dur}`;
        if (!combos.has(key)) combos.set(key, { categoria: svc.categoria, dur });
    }

    // Silenciar los logs de depuración de calendar-sante (p.ej. "rango semana siguiente")
    // durante las ~2.000 llamadas de la matriz.
    const silenced = ['log', 'info', 'warn', 'debug'];
    const origConsole = {};
    for (const m of silenced) { origConsole[m] = console[m]; console[m] = () => {}; }
    try {
        for (const { categoria, dur } of combos.values()) {
            const eligible = eligibleByCat[categoria] || [];
            if (!eligible.length) continue;            // sin skill → ya reportado en Fase 3; 0 aquí es legítimo
            if (dur >= 540) { warn('4-huecos', `${categoria} (${dur}min) no cabe en un día 10–19`); continue; }

            const stylistModes = [
                ['sin estilista', undefined],
                [`estilista concreta (${eligible[0].name})`, eligible[0].id],
            ];
            for (const [diaN, anchorDate] of anchors) {
                const prefs = [
                    ['hueco más cercano (asap)', { asap: true }],
                    ['mañana', { fecha: addDays(anchorDate, 1) }],
                    ['esta semana', { semana: 'esta' }],
                    ['semana que viene', { semana: 'siguiente' }],
                    ['fecha concreta', { fecha: addDays(anchorDate, 3) }],
                    // Combinaciones asap + semana (cliente dice "el más cercano" y luego una
                    // semana). asap NO puede vaciar el rango de la semana (su buffer solo toca
                    // HOY, que "siguiente" excluye), así que sobre horario abierto deben dar ≥1
                    // igual que las versiones sueltas. Candado contra regresiones en el
                    // anclaje del rango de semana cuando asap está presente.
                    ['asap + esta semana', { asap: true, semana: 'esta' }],
                    ['asap + semana que viene', { asap: true, semana: 'siguiente' }],
                ];
                await withMockedNow(`${anchorDate}T06:00:00Z`, async () => {
                    for (const [prefN, preferencia] of prefs) {
                        for (const [modeN, stylistId] of stylistModes) {
                            const slots = await calendarSante.getAvailableSlots(SANTE_ORG_ID, {
                                serviceDuration: dur,
                                serviceCategory: categoria,
                                preferredStylistId: stylistId,
                                preferencia,
                            });
                            check('4-huecos', slots.length > 0, `${categoria} (${dur}min)`,
                                `HOY=${diaN} · pref="${prefN}" · ${modeN} → 0 huecos (falso 0)`);
                        }
                    }
                });
            }
        }
    } finally {
        for (const m of silenced) console[m] = origConsole[m];
        Object.assign(db, realFns); // restaurar la capa db real
    }

    // ─── Fase 5: upselling dentro del cierre de 19:00 (offline) ───────────────────────
    // Réplica de la aritmética de bot.js:2712-2718: apptEnd = inicio + servicio + upsell.
    // Comprobamos que EXISTE un inicio temprano (10:00) donde el upsell aún cabe; si ni a las
    // 10:00 cabe, la regla de upsell nunca se podría ofrecer.
    for (const svc of catalog) {
        const sug = matchUpsellSuggestion(svc, upsellingRules);
        if (!sug) continue;
        const upsellDef = catalog.find(s => normalizeText(s.nombre) === normalizeText(sug));
        const upsellDur = upsellDef?.duracion || 30;
        const svcDur = svc.duracion || 60;
        const minEnd = WORK_START + svcDur + upsellDur; // empezando a las 10:00
        const hhmm = `${Math.floor(minEnd / 60)}:${String(minEnd % 60).padStart(2, '0')}`;
        check('5-upsell', minEnd <= HARD_CUTOFF, `${svc.categoria} / ${svc.nombre} → upsell "${sug}"`,
            `ni empezando a las 10:00 cabe: ${svcDur}min + ${upsellDur}min terminaría a las ${hhmm} (>19:00)`);
    }

    // ─── Fase 6: roster de estilistas (datos reales de Supabase) ──────────────────────
    // db real ya restaurada (finally de Fase 4). Verifica horarios, skills exactas,
    // elegibilidad y la distinción de nombre de las estilistas añadidas hoy.
    const skillSet = (skills) => new Set((Array.isArray(skills) ? skills : []).map(x => normalizeText(x)));
    const setsEqual = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
    const findStylist = (name) => realStylists.find(s => normalizeText(s.name) === normalizeText(name));

    // Especificación declarativa. `skillsIguales` compara el set con el de otra estilista.
    //
    // Aquí había también un `dias: [...]` por estilista, copiado de las migraciones 013/014 el
    // 14/07/2026. No verificaba nada: comparaba la BD contra la foto del INSERT que la creó.
    // La dueña edita los horarios desde el panel de Configuración (upsertStylistSchedule
    // borra y reinserta), así que la expectativa caducaba en cuanto tocaba un día — y eso ya
    // había pasado con las tres. Tres fallos permanentes que no había que arreglar, arrastrados
    // durante días, entrenando a todo el mundo a ignorar el informe entero.
    // Lo sustituye la Fase 7: invariantes que se sostienen con CUALQUIER horario.
    //
    // Natalia estaba aquí con `skillsIguales: 'Irina'` y ya no: exigir que dos estilistas
    // tengan el MISMO conjunto de skills ata dos datos que la dueña edita por separado, y no
    // afirma nada que le importe a una clienta. Lo que hay que exigirle —que el bot pueda
    // usarla en alguna categoría real— lo cubre ahora la Fase 3, para ella y para todas.
    const ROSTER = [
        { name: 'Tetiana', skills: ['Extensiones de cabello'] },
        { name: 'Yulia-Tricóloga', skills: ['Dermapen Hair Loss', 'Diagnóstico Capilar'] },
    ];

    for (const spec of ROSTER) {
        const sty = findStylist(spec.name);
        if (!check('6-roster', !!sty, `${spec.name} existe`, 'no está en stylists activas')) continue;

        // Skills: exactas, o iguales a las de otra estilista (Natalia == Irina).
        const got = skillSet(sty.skills);
        if (spec.skillsIguales) {
            const ref = findStylist(spec.skillsIguales);
            if (check('6-roster', !!ref, `${spec.name}: referencia ${spec.skillsIguales}`, 'no encontrada') && ref) {
                check('6-roster', setsEqual(got, skillSet(ref.skills)), `${spec.name}: skills == ${spec.skillsIguales}`,
                    `[${[...got]}] vs ${spec.skillsIguales} [${[...skillSet(ref.skills)]}]`);
            }
        } else {
            check('6-roster', setsEqual(got, skillSet(spec.skills)), `${spec.name}: skills exactas`,
                `[${[...got]}] esperado [${spec.skills.map(normalizeText)}]`);
        }
        for (const must of (spec.incluye || [])) {
            check('6-roster', got.has(normalizeText(must)), `${spec.name}: incluye "${must}"`, 'skill ausente');
        }

        // El horario de esta estilista ya no se compara contra una lista fija: lo cubre la
        // Fase 7, que lo juzga contra el horario del salón y contra sí mismo.
    }

    // Tetiana: extensiones escala a humano → nunca candidata en getAvailableSlots.
    const tetiana = findStylist('Tetiana');
    if (tetiana) {
        check('6-roster', categories.every(cat => !skillMatches(tetiana.skills, cat)),
            'Tetiana nunca elegible', 'su skill casa con alguna categoría del catálogo');
    }
    check('6-roster', !catalog.some(s => normalizeText(s.categoria) === normalizeText('Extensiones de cabello')),
        'Extensiones no es servicio reservable', 'hay un servicio con categoría Extensiones de cabello');

    // Aquí se exigía además que Natalia fuese elegible en "Cortes" y "Mechas Balayage". Misma
    // trampa por partida doble: fijaba a una persona (la dueña puede darle de baja o cambiarle
    // las skills mañana) contra dos categorías escritas a mano. Que ninguna categoría del
    // catálogo se quede sin nadie lo comprueba la Fase 3 sobre TODAS, sin nombrar a nadie.

    // Yulia-Tricóloga: distinta de Yulia, no elegible para generales, y sin confusión de nombre.
    const yulia = findStylist('Yulia');
    const yuliaTri = findStylist('Yulia-Tricóloga');
    if (yulia && yuliaTri) {
        check('6-roster', yulia.id !== yuliaTri.id, 'Yulia ≠ Yulia-Tricóloga', 'comparten id');
        for (const cat of ['Cortes', 'Color Premium', 'Mechas Balayage']) {
            check('6-roster', !skillMatches(yuliaTri.skills, cat), `Yulia-Tricóloga NO hace "${cat}"`, 'casa la skill');
        }
        check('6-roster', extractStylistFromText('quiero con yulia tricologa', realStylists)?.id === yuliaTri.id,
            'nombre real: "yulia tricologa" → tricóloga', 'resolvió a otra estilista');
        check('6-roster', extractStylistFromText('quiero con yulia', realStylists)?.id === yulia.id,
            'nombre real: "yulia" → Yulia de pelo', 'resolvió a otra estilista');
    }

    // ─── Fase 7: coherencia de los horarios (sin ninguna lista de horarios esperados) ──
    //
    // Sustituye a las expectativas `dias`/franja que la Fase 6 comparaba contra la foto de la
    // migración. Aquí NADA se compara contra una constante: cada franja se juzga contra sí
    // misma y contra el horario del salón (agent_configs.business_hours), que la dueña edita
    // desde el mismo panel. Así el 10:00–18:00 de Yulia-Tricóloga o el 10:00–16:00 de Larisa
    // pasan —son decisiones suyas, perfectamente legítimas— y en cambio saltaría un 09:00, un
    // 21:00, un día con el salón cerrado o una franja invertida, que son dedazos de verdad.
    const businessHours = cfg.business_hours || {};
    // Convención del proyecto (date-utils.mondayDow): 0=lunes … 6=domingo.
    const BH_KEYS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
    const toMin = (t) => {
        const [h, m] = String(t || '').split(':').map(Number);
        return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null;
    };
    const asHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    // Duración del servicio más corto del catálogo: por debajo de eso, una franja no da ni
    // para una cita y es un error de tecleo, no un horario.
    const servicioMasCorto = Math.min(...catalog.map(s => Number(s.duracion) || 60));

    for (const sty of realStylists) {
        const sched = horarioPorEstilista.get(sty.id) || [];
        // Una estilista sin horario no la propone el motor NINGÚN día: existe en el panel y es
        // invisible para las clientas, que es la peor combinación posible.
        if (!check('7-horarios', sched.length > 0, `${sty.name}: tiene horario`,
            'no tiene ninguna franja configurada — el motor no la propondrá nunca')) continue;

        const vistos = new Set();
        for (const r of sched) {
            const dow = r.day_of_week;
            const etiqueta = `${sty.name} ${BH_KEYS[dow] || `día ${dow}`}`;

            check('7-horarios', Number.isInteger(dow) && dow >= 0 && dow <= 6,
                `${etiqueta}: día válido`, `day_of_week=${dow} fuera de 0..6`);
            check('7-horarios', !vistos.has(dow), `${etiqueta}: día sin duplicar`,
                'hay dos franjas para el mismo día');
            vistos.add(dow);

            const ini = toMin(r.start_time), fin = toMin(r.end_time);
            if (!check('7-horarios', ini != null && fin != null, `${etiqueta}: horas legibles`,
                `start=${r.start_time} end=${r.end_time}`)) continue;
            check('7-horarios', ini < fin, `${etiqueta}: franja no invertida`,
                `${asHHMM(ini)}–${asHHMM(fin)} empieza después de acabar`);
            check('7-horarios', fin - ini >= servicioMasCorto, `${etiqueta}: franja utilizable`,
                `${asHHMM(ini)}–${asHHMM(fin)} son ${fin - ini}min y el servicio más corto dura ${servicioMasCorto}min`);

            // Contra el horario del salón: ni antes de abrir, ni después de cerrar, ni un día
            // en el que el salón no abre.
            const bh = businessHours[BH_KEYS[dow]];
            if (!check('7-horarios', !!bh, `${etiqueta}: el salón abre ese día`,
                `hay horario de ${sty.name} un ${BH_KEYS[dow] || dow} y el salón no abre`)) continue;
            const abre = toMin(bh.apertura), cierra = toMin(bh.cierre);
            check('7-horarios', ini >= abre && fin <= cierra, `${etiqueta}: dentro del horario del salón`,
                `${asHHMM(ini)}–${asHHMM(fin)} se sale de ${bh.apertura}–${bh.cierre}`);
        }
    }

    // ─── Reporte final ────────────────────────────────────────────────────────────────
    console.log('\n── Resumen por fase ──');
    for (const [phase, s] of Object.entries(stats).sort()) {
        console.log(`  ${s.fail ? '❌' : '✅'} ${phase}: ${s.pass} ok, ${s.fail} fallos`);
    }
    if (warnings.length) {
        console.log(`\n── Avisos (${warnings.length}) ──`);
        for (const w of warnings) console.log('  ⚠️  ' + w);
    }
    if (failures.length) {
        console.log(`\n── Fallos (${failures.length}) ──`);
        for (const f of failures) console.log('  ✗ ' + f);
        console.log(`\n❌ ${failures.length} fallo(s) — revisa el mapa de arriba.`);
    } else {
        console.log('\n✅ Todo el catálogo de Sante verificado sin fallos.');
    }
    process.exit(process.exitCode || 0);
})().catch(e => {
    console.error('Error fatal en la verificación:', e);
    process.exit(1);
});
