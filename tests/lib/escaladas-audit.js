/**
 * tests/lib/escaladas-audit.js — La lógica PURA de `informe:escaladas`.
 *
 * Responde a una pregunta que hasta el 18/08/2026 se pensaba que hacía falta un contador
 * nuevo para contestar: ¿qué escaladas pasaron por el protocolo de DOS TURNOS (ofrecer y
 * esperar el «sí») y cuáles se dispararon en el acto?
 *
 * NO HACE FALTA ESCRIBIR NADA NUEVO. El discriminador ya está en la fila:
 * `pending_actions.payload.motivo` lleva el prefijo `consulta_` si y solo si la escalada la
 * resolvió el bloque de `pendingEscalation` (`consulta_${pendingEscalationService}`). Un
 * motivo pelado significa que la escribió el despacho de acciones, o sea inmediata. Cruzando
 * eso con el último ENTRANTE anterior a la fila —y los entrantes están siempre enteros en
 * `messages`, Coexistence solo pierde salientes— sale la clasificación completa, retroactiva
 * y sobre cualquier ventana.
 *
 * POR QUÉ ESTO Y NO CONTADORES: la medida tiene que sobrevivir a un deploy. Medido sobre el
 * reflog de origin/main, en los últimos 30 días el hueco MAYOR entre dos pushes fue de 1,88
 * días y en 90 días el mayor de todos fue de 7,00 — nunca ha habido 14 días sin desplegar.
 * Como `metrics.json` vive en el disco efímero del contenedor y se pone a cero en cada
 * deploy, cualquier umbral con ventana de dos semanas era inalcanzable POR CONSTRUCCIÓN.
 * Supabase es durable por definición, así que la ventana pasa a ser de días naturales.
 *
 * LO QUE ESTE INFORME NO VE, y por eso no se lee solo: mide las filas que EXISTEN. La
 * dirección contraria —el bot ofreció, la clienta aceptó y no hay fila— no deja fila que
 * mirar, y la mide `barrido:promesas` con sus desenlaces `aceptada_sin_escalada` y
 * `oferta_sin_respuesta`. Son dos instrumentos del mismo aparato y por eso corren juntos.
 */

const { isAffirmative } = require('../../services/helpers');

// `isAffirmative` casa por SUBCADENA y está pensada para una respuesta CORTA a una pregunta
// directa. Sobre un mensaje largo miente, y aquí lo hizo en tres de las siete filas reales al
// escribir este informe: «confu-SI-ón» y «повре-ЖДА-ются» la ponían a true, así que una queja
// entera se leía como «ella ya había dicho que sí». Por eso un afirmativo SOLO cuenta si el
// bot venía de OFRECER algo — que es la pregunta de verdad: ¿estaba contestando a una oferta?
function contestaAUnaOferta(salientePrevio, entrante, esOferta) {
    if (!salientePrevio || !entrante) return false;
    if (!esOferta(salientePrevio.content)) return false;
    return isAffirmative(entrante.content);
}

// Ventana por defecto para el bloque de decisión. Días NATURALES: ya no depende del uptime.
const VENTANA_DECISION_DIAS = 14;

const LECTURAS = {
    protocolo_completo: 'ofreció y esperó el «sí»',
    tras_si: 'inmediata, pero ella ya había dicho que sí',
    sin_preguntar: 'inmediata SIN preguntar',
    sin_entrante: 'inmediata, y no hay entrante anterior que leer',
};

/**
 * @param {object[]} pendingActions — filas de getPendingActionsBarrido (type/payload/created_at)
 * @param {object[]} entrantes      — getEntrantesBarrido ({contactId, content, createdAt})
 * @param {object[]} contactos      — getContactosBarrido ({id, full_name, wa_phone, language?})
 * @param {number}   [desdeMs]      — solo se clasifican las filas posteriores; null = todo
 */
function auditEscaladas({
    pendingActions = [], entrantes = [], contactos = [], salientes = [],
    esOferta = () => false, desdeMs = null,
} = {}) {
    const porContacto = new Map();
    for (const c of contactos) porContacto.set(c.id, c);

    // Entrantes por contacto, ya ordenados ascendentemente por la consulta.
    const entrantesPorContacto = new Map();
    for (const e of entrantes) {
        if (!e.contactId) continue;
        if (!entrantesPorContacto.has(e.contactId)) entrantesPorContacto.set(e.contactId, []);
        entrantesPorContacto.get(e.contactId).push(e);
    }
    const salientesPorContacto = new Map();
    for (const s of salientes) {
        if (!s.contactId) continue;
        if (!salientesPorContacto.has(s.contactId)) salientesPorContacto.set(s.contactId, []);
        salientesPorContacto.get(s.contactId).push(s);
    }

    const filas = [];
    for (const pa of pendingActions) {
        if (pa.type !== 'escalation') continue;
        const tMsg = new Date(pa.created_at).getTime();
        if (desdeMs && tMsg < desdeMs) continue;

        const motivo = (pa.payload && pa.payload.motivo) || null;
        const via = motivo && motivo.startsWith('consulta_') ? 'espera' : 'inmediata';
        const contacto = porContacto.get(pa.contact_id) || null;

        // El último entrante ANTERIOR a la fila. La escritura de la escalada va después de
        // procesar ese mensaje, así que es el que la provocó.
        const previos = (entrantesPorContacto.get(pa.contact_id) || [])
            .filter(e => new Date(e.createdAt).getTime() <= tMsg);
        const ultimo = previos.length ? previos[previos.length - 1] : null;
        // El último saliente del BOT anterior al entrante que provocó la escalada: es el que
        // habría llevado la oferta.
        const salientesPrevios = (salientesPorContacto.get(pa.contact_id) || [])
            .filter(s => ultimo && new Date(s.createdAt).getTime() < new Date(ultimo.createdAt).getTime());
        const salientePrevio = salientesPrevios.length ? salientesPrevios[salientesPrevios.length - 1] : null;

        let lectura;
        if (via === 'espera') {
            // El bloque de pendingEscalation solo escribe tras un isAffirmative: por
            // construcción, aquí hubo pregunta y hubo «sí».
            lectura = 'protocolo_completo';
        } else if (!ultimo) {
            lectura = 'sin_entrante';
        } else {
            lectura = contestaAUnaOferta(salientePrevio, ultimo, esOferta) ? 'tras_si' : 'sin_preguntar';
        }

        filas.push({
            id: pa.id,
            fecha: pa.created_at,
            motivo,
            via,
            lectura,
            status: pa.status || null,
            contactId: pa.contact_id,
            nombre: contacto?.full_name || null,
            telefono: contacto?.wa_phone || null,
            idioma: contacto?.language || null,
            ultimoEntrante: ultimo ? ultimo.content : null,
        });
    }

    return { filas, resumen: resumir(filas) };
}

function resumir(filas) {
    const porMotivo = {};
    const sinPreguntarPorIdioma = {};
    for (const f of filas) {
        const clave = f.motivo || '(sin motivo)';
        porMotivo[clave] = porMotivo[clave] || { total: 0, espera: 0, tras_si: 0, sin_preguntar: 0, sin_entrante: 0 };
        porMotivo[clave].total++;
        porMotivo[clave][f.lectura === 'protocolo_completo' ? 'espera' : f.lectura]++;
        if (f.lectura === 'sin_preguntar') {
            const idioma = f.idioma || 'sin_idioma';
            sinPreguntarPorIdioma[clave] = sinPreguntarPorIdioma[clave] || {};
            sinPreguntarPorIdioma[clave][idioma] = (sinPreguntarPorIdioma[clave][idioma] || 0) + 1;
        }
    }
    return { porMotivo, sinPreguntarPorIdioma, total: filas.length };
}

/**
 * Los salientes que llevan el CODA pegado: cada uno es una divergencia entre lo que el
 * modelo DECLARÓ (ofrecía) y lo que escribió (no ofrecía nada). Es el registro durable del
 * anillo 2 — vive en `messages` y sobrevive a los deploys, al revés que metrics.json.
 *
 * Los núcleos se GENERAN de las plantillas exportadas por bot._internals, nunca se copian:
 * si la pregunta cambia, esto la sigue solo. Misma regla que nucleosTraspaso.
 */
// El coda se PEGA con un salto de línea detrás de la respuesta del modelo, y ese salto es lo
// único que lo distingue de las plantillas fijas que hacen la misma pregunta en una sola
// línea (CONSULTA_ASK, el menú de rescate). Sin esa precisión, la primera versión de este
// contador dio un falso positivo con la plantilla de la permanente de Mafe (08/08) y habría
// inflado el número del anillo 2 con mensajes que no tienen nada que ver.
function contarCodas(salientes = [], preguntas = {}, preguntasFormal = {}) {
    const nucleos = [...Object.values(preguntas), ...Object.values(preguntasFormal)]
        .filter(Boolean)
        .map(s => String(s).trim());
    const conCoda = salientes.filter(s => {
        const t = String(s.content || '').trim();
        return nucleos.some(n => t.endsWith(`\n${n}`));
    });
    return { total: conCoda.length, salientes: conCoda };
}

function cobertura() {
    return [
        'Mide las filas de pending_actions que EXISTEN. La dirección contraria —ofreció, ella '
        + 'aceptó y no hay fila— no deja fila que mirar: la mide barrido:promesas '
        + '(aceptada_sin_escalada / oferta_sin_respuesta). Por eso corren juntos.',
        'El prefijo `consulta_` es el discriminador, y es fiable por construcción: solo lo '
        + 'escribe el bloque que resuelve una espera de dos turnos, y solo tras un isAffirmative.',
        '«inmediata SIN preguntar» NO es siempre un fallo: para `pedir_persona` es lo correcto '
        + '—preguntarle «¿quieres una persona?» a quien acaba de escribir «I wanna speak with a '
        + 'person» sería absurdo— y para `tono_agresivo` lo manda el prompt. Donde importa es en '
        + '`queja_cita`, que según el prompt debería preguntar antes.',
        'Un afirmativo solo cuenta como «ella ya había dicho que sí» si el saliente ANTERIOR '
        + 'era una oferta. isAffirmative casa por subcadena y sobre un mensaje largo miente '
        + '(«confu-SI-ón», «повре-ЖДА-ются»): sin ese gate, tres de las siete filas reales se '
        + 'leían al revés y una queja entera pasaba por un «sí».',
        'El coda se cuenta por el SALTO DE LÍNEA que lo pega, no por la pregunta suelta: las '
        + 'plantillas fijas (CONSULTA_ASK, menú de rescate) hacen la misma pregunta en una '
        + 'sola línea y si no, se cuelan.',
        'El idioma sale de contacts.language, que mezcla observado, deducido y el «es» por '
        + 'defecto del INSERT (ver metadata.language_source). Un reparto por idioma de esta '
        + 'tabla es orientativo, no una medida del idioma real de la clienta.',
        'Los entrantes están enteros en messages (Coexistence solo pierde salientes), así que '
        + '«el último entrante antes de la fila» es un dato completo, no una inferencia.',
    ];
}

module.exports = { auditEscaladas, contarCodas, cobertura, LECTURAS, VENTANA_DECISION_DIAS };
