/**
 * agenda-audit.js — Coherencia entre las citas y el horario REAL de cada estilista.
 *
 * Por qué existe: la dueña edita horarios y skills desde el panel de Configuración, así que
 * `stylist_schedules` y `stylists.skills` son datos vivos. Cuando quita un día o recorta una
 * franja, las citas YA reservadas en ese hueco no se mueven ni avisan — se quedan colgando y
 * la clienta se presenta un día que el salón no la espera. Nada en el sistema lo detectaba.
 *
 * Este módulo es la contrapartida de comparar la BD contra una lista fija de horarios (que es
 * lo que hacía la Fase 6 de verify-sante-catalog y que caducaba cada vez que la dueña tocaba
 * el panel): aquí NO hay ningún horario esperado escrito a mano. Se comprueba que las citas
 * sean coherentes con el horario que haya HOY, sea cual sea.
 *
 * Función PURA: recibe los datos ya leídos y devuelve hallazgos. Sin `db`, sin red, sin
 * `new Date()` implícito — así los tests herméticos pueden ejercerla con fixtures y el runner
 * `verify:sante:agenda` con Supabase real.
 */

const { splitServiceNames, resolveServiceCatalogEntry, normalizeText } = require('../../services/helpers');
const { mondayDow, toLocalDateStr, toMinutes } = require('../../services/date-utils');

const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

// 'error'  → la clienta se lleva el golpe (nadie la atiende, o hay dos citas a la vez).
// 'aviso'  → incoherencia real pero que puede ser una decisión deliberada de la dueña
//            (dar un complemento a quien no tiene esa skill) o un renombrado de catálogo.
const SEVERIDAD = {
    'dia-no-laborable': 'error',
    'fuera-de-franja': 'error',
    'dentro-de-bloqueo': 'error',
    'solape': 'error',
    'sin-horario': 'error',
    'sin-skill': 'aviso',
    'servicio-irresoluble': 'aviso',
    'sin-estilista': 'aviso',
    'estilista-inactiva': 'aviso',
};

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// 'HH:MM' o 'HH:MM:SS' → minuto del día. Las franjas se guardan como hora de PARED local
// (columna `time`), no como instante, así que no hay TZ que convertir aquí.
function timeToMin(t) {
    const [h, m] = String(t || '').split(':').map(Number);
    if (!Number.isFinite(h)) return null;
    return h * 60 + (Number.isFinite(m) ? m : 0);
}

/**
 * @param {object}   input
 * @param {Array}    input.citas      Citas futuras confirmed/pending: { id, starts_at, ends_at,
 *                                    stylist_id, service, clienta, telefono }
 * @param {Array}    input.stylists   { id, name, skills, active }
 * @param {Map|object} input.schedules  stylistId → [{ day_of_week, start_time, end_time }]
 * @param {Map|object} input.blocks     stylistId → [{ starts_at, ends_at, reason }]
 * @param {Array}    input.catalog    Catálogo de servicios (agent_configs.services)
 * @returns {Array} hallazgos ordenados por fecha: { tipo, severidad, detalle, cita:{...} }
 */
function auditAgenda({ citas = [], stylists = [], schedules, blocks, catalog = [] } = {}) {
    const get = (src, key) => (src instanceof Map ? src.get(key) : (src || {})[key]) || [];
    const byId = new Map((stylists || []).map(s => [s.id, s]));
    const hallazgos = [];

    const add = (tipo, cita, detalle) => hallazgos.push({
        tipo,
        severidad: SEVERIDAD[tipo] || 'aviso',
        detalle,
        cita: {
            id: cita.id,
            fecha: toLocalDateStr(new Date(cita.starts_at)),
            hora: hhmm(toMinutes(new Date(cita.starts_at))),
            fin: hhmm(toMinutes(new Date(cita.ends_at))),
            clienta: cita.clienta || cita.telefono || '(sin nombre)',
            estilista: byId.get(cita.stylist_id)?.name || '(sin estilista)',
            servicio: cita.service,
        },
    });

    for (const cita of citas) {
        const sty = cita.stylist_id ? byId.get(cita.stylist_id) : null;
        if (!sty) {
            // Sin estilista no hay horario contra el que contrastar: el resto de comprobaciones
            // no aplica, pero la cita queda sin nadie asignado y eso hay que decirlo.
            add('sin-estilista', cita, 'la cita no tiene estilista asignada');
            continue;
        }
        if (sty.active === false) add('estilista-inactiva', cita, `${sty.name} está marcada como inactiva`);

        const ini = new Date(cita.starts_at);
        const fin = new Date(cita.ends_at);
        const dow = mondayDow(toLocalDateStr(ini));
        const iniMin = toMinutes(ini);
        const finMin = toMinutes(fin);

        // 1 · 2 — el día y la franja. Varias franjas el mismo día (turno partido) valen: basta
        // con que la cita quepa ENTERA dentro de una de ellas.
        const delDia = get(schedules, sty.id).filter(r => r.day_of_week === dow);
        const todasLasFranjas = get(schedules, sty.id);
        if (!todasLasFranjas.length) {
            add('sin-horario', cita, `${sty.name} no tiene ningún horario configurado`);
        } else if (!delDia.length) {
            const trabaja = [...new Set(todasLasFranjas.map(r => r.day_of_week))].sort()
                .map(d => DIAS[d]).join(', ');
            add('dia-no-laborable', cita, `${sty.name} ya no trabaja los ${DIAS[dow]} (hoy trabaja: ${trabaja})`);
        } else {
            const cabe = delDia.some(r => {
                const o = timeToMin(r.start_time), c = timeToMin(r.end_time);
                return o != null && c != null && iniMin >= o && finMin <= c; // ends_at incluido
            });
            if (!cabe) {
                const franjas = delDia.map(r => `${hhmm(timeToMin(r.start_time))}–${hhmm(timeToMin(r.end_time))}`).join(' / ');
                add('fuera-de-franja', cita,
                    `${hhmm(iniMin)}–${hhmm(finMin)} se sale del horario de ${sty.name} los ${DIAS[dow]} (${franjas})`);
            }
        }

        // 3 — bloqueos manuales (vacaciones, descansos) que se metieron DESPUÉS de la cita.
        for (const b of get(blocks, sty.id)) {
            const bi = new Date(b.starts_at), bf = new Date(b.ends_at);
            if (ini < bf && fin > bi) {
                add('dentro-de-bloqueo', cita,
                    `cae dentro del bloqueo de ${sty.name}${b.reason ? ` (${b.reason})` : ''}: ${b.starts_at} → ${b.ends_at}`);
            }
        }

        // 4 — skills. `service` puede llevar varios servicios unidos por " + ": se comprueba
        // cada segmento, porque la incoherencia suele estar en el complemento, no en el
        // servicio principal.
        const skills = new Set((Array.isArray(sty.skills) ? sty.skills : []).map(normalizeText));
        for (const nombre of splitServiceNames(cita.service, catalog)) {
            const entry = resolveServiceCatalogEntry(nombre, catalog);
            if (!entry) {
                add('servicio-irresoluble', cita, `el segmento "${nombre}" ya no casa con ningún servicio del catálogo`);
                continue;
            }
            if (entry.categoria && !skills.has(normalizeText(entry.categoria))) {
                add('sin-skill', cita, `${sty.name} no tiene la skill "${entry.categoria}" que pide el segmento "${nombre}"`);
            }
        }
    }

    // 5 — solapes entre citas de la MISMA estilista. Se compara por pares consecutivos tras
    // ordenar: si A acaba después de que empiece B, están la una encima de la otra.
    const porEstilista = new Map();
    for (const c of citas) {
        if (!c.stylist_id) continue;
        if (!porEstilista.has(c.stylist_id)) porEstilista.set(c.stylist_id, []);
        porEstilista.get(c.stylist_id).push(c);
    }
    for (const [sid, lista] of porEstilista) {
        lista.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
        for (let i = 1; i < lista.length; i++) {
            const prev = lista[i - 1], cur = lista[i];
            if (new Date(cur.starts_at) < new Date(prev.ends_at)) {
                add('solape', cur, `${byId.get(sid)?.name} ya tiene la cita de ${hhmm(toMinutes(new Date(prev.starts_at)))}` +
                    `–${hhmm(toMinutes(new Date(prev.ends_at)))} ("${prev.service}") a esa hora`);
            }
        }
    }

    return hallazgos.sort((a, b) =>
        (a.cita.fecha + a.cita.hora).localeCompare(b.cita.fecha + b.cita.hora));
}

module.exports = { auditAgenda, SEVERIDAD, DIAS };
