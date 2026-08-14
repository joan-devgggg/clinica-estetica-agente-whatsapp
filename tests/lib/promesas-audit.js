/**
 * tests/lib/promesas-audit.js — La lógica PURA del barrido de promesas (barrido:promesas).
 *
 * Cruza lo que el BOT dijo (clase C1: cita hecha/cancelada · clase C7: traspaso a una
 * persona) contra las filas que lo respaldan (appointments, pending_actions). Es el
 * punto 1 del contrato: las promesas de Tania («te apunto» sin apuntar), Estefania y
 * Celeste (traspasos ofrecidos/remitidos que se evaporaron) se descubrieron en
 * auditorías semanas después; este barrido las habría dicho esa misma noche.
 *
 * INMUNE A COEXISTENCE POR CONSTRUCCIÓN: solo mira salientes con sender='bot' (que
 * están SIEMPRE enteros en messages) contra filas de estado. Ningún desenlace se apoya
 * en un silencio ni en la ausencia de un saliente humano; los textos de los desenlaces
 * afirman que una FILA no existe, jamás que nadie atendió.
 *
 * VOCABULARIO: no se copia ningún literal. Los detectores de prosa vienen de
 * bot._internals (llmClaimsBooked, asksForBookingApproval, announcesHumanHandover,
 * offersHumanHandover) y los núcleos de plantilla se GENERAN llamando a sus fuentes
 * (CANCEL_OK_MSGS, CONFIRM_YES, HANDOVER_ACUSE*, buildCancelFalloMsg,
 * buildAmpliacionSolapaMsg, buildSanteConfirmationMessage) — si una plantilla cambia,
 * el barrido la sigue solo. Lo ÚNICO nuevo aquí es `remisionAlEquipo` (la remisión de
 * Estefania: «habla con nuestro equipo, ellos podrán valorar»), vocabulario que no
 * existía en ninguna parte. Solo castellano, y la cobertura lo declara.
 */

const {
    llmClaimsBooked, asksForBookingApproval, announcesHumanHandover, offersHumanHandover,
    HANDOVER_ACUSE, HANDOVER_ACUSE_FORMAL, CANCEL_OK_MSGS, CONFIRM_YES, CONFIRM_YES_LEGACY,
} = require('../../bot')._internals;
const {
    normalizeText, buildCancelFalloMsg, buildAmpliacionSolapaMsg,
    buildSanteConfirmationMessage, IDIOMAS_SOPORTADOS, TEST_PHONE_PREFIX, detectLanguage,
} = require('../../services/helpers');

// ─── Ventanas (calibradas el 14/08/2026 contra producción) ───────────────────
//
// En los cinco eventos bot-escribe-y-acusa medidos con reloj fino, la escritura precede
// al acuse en 1,5–2,5 s, y el código lo garantiza (finalizarCitaSante guarda y SOLO
// entonces el llamante envía; ejecutarCancelacion igual). El contraejemplo real —la
// cita de Tania Daza, creada a mano tras su «te apunto»— llegó 18 HORAS después: tres
// órdenes de magnitud de separación. Los −120 s absorben reintentos y relojes; los
// +30 s cubren que el saveMessage del saliente es fire-and-forget y su created_at
// puede aterrizar después del envío.
const VENTANA_TURNO_ANTES_MS = 120 * 1000;
const VENTANA_TURNO_DESPUES_MS = 30 * 1000;
// «Salvada a mano»: la fila que aparece después, creada por una persona. 14 días cubre
// el patrón real (18 h) con margen; más allá, una cita nueva ya no es «la prometida».
const VENTANA_SALVADA_MS = 14 * 24 * 3600 * 1000;
// Oferta/remisión → escalada: la aceptación llega en minutos (Mafe: oferta→fila en
// 96 s); 24 h da margen a la aceptación tardía sin cazar escaladas de OTRA conversación.
const VENTANA_OFERTA_MS = 24 * 3600 * 1000;
// El desenlace «parcial» que mira la FICHA (bot_mode/escalation_reason) solo tiene
// sentido para promesas recientes: la ficha es estado ACTUAL y una escalada bien
// resuelta lo limpia. Más allá de 48 h no afirma nada sobre aquel turno.
const VENTANA_PARCIAL_FICHA_MS = 48 * 3600 * 1000;

// ─── Lo único nuevo: la remisión al equipo (Estefania Sanz, 03/08/2026) ──────
//
// «te recomiendo que hables directamente con nuestro equipo — ellos podrán valorar tu
// situación»: no es «te paso con» (announcesHumanHandover no la ve: 'hablar' no es un
// verbo de traspaso) ni una oferta con «¿?» (offersHumanHandover tampoco). Es una
// REMISIÓN: el bot manda a la clienta al equipo y promete que allí la valoran — y ella
// contestó «Claro ☺️» a una promesa detrás de la cual no se escribió nada.
// Solo castellano, sobre texto normalizado (sin acentos). Sin cirílico: si algún día
// lo lleva, por buildCyrillicRe (helpers), nunca a mano.
const REMISION_RE = /habl(?:a|as|es|ar|ad|en) (?:directamente )?con (?:nuestro|el) equipo/;
function remisionAlEquipo(texto) {
    return REMISION_RE.test(normalizeText(texto));
}

// ─── Núcleos de plantilla, GENERADOS de sus fuentes ──────────────────────────

// El acuse de cancelación efectiva. La variante de San Remo comparte todo menos el
// sustantivo («Tu reserva ha sido cancelada…»), así que se deriva cita→reserva en vez
// de copiar el literal del restaurante.
function nucleosCancelacion() {
    const nucleos = new Set();
    for (const texto of Object.values(CANCEL_OK_MSGS)) {
        const prefijo = normalizeText(String(texto).split('✅')[0]);
        if (prefijo) {
            nucleos.add(prefijo);
            nucleos.add(prefijo.replace('cita', 'reserva'));
        }
    }
    return [...nucleos];
}

// La primera línea de la confirmación determinista, sin el nombre: se genera con un
// centinela y se recorta. Cubre «Appointment booked:» (en), que la prosa de
// llmClaimsBooked no casa; es/ru/uk ya las casa el detector, pero se generan igual —
// la fuente es una, no tres.
function nucleosConfirmacion() {
    const CENTINELA = 'XNOMBREX';
    const nucleos = new Set();
    for (const lang of IDIOMAS_SOPORTADOS) {
        const msg = buildSanteConfirmationMessage({
            nombre: CENTINELA, fecha: '2026-01-05', hora: '10:00',
            servicio: 'X', language: lang,
        });
        const primeraLinea = String(msg).split('\n')[0] || '';
        const trasNombre = primeraLinea.split(`${CENTINELA}.`)[1];
        const nucleo = normalizeText(trasNombre || '');
        if (nucleo) nucleos.add(nucleo);
    }
    return [...nucleos];
}

// Los acuses fijos que PROMETEN traspaso. CONFIRM_YES es la razón de exportarlo: sus
// verbos («se pondrá en contacto») no casan HANDOVER_TRASPASO, así que sin la plantilla
// este acuse era invisible.
function nucleosTraspaso() {
    const fuentes = [
        ...Object.values(HANDOVER_ACUSE),
        ...Object.values(HANDOVER_ACUSE_FORMAL),
        ...Object.values(CONFIRM_YES),
        // El «En breve…» que se envió hasta el 14/08/2026: ya no sale de ningún flujo,
        // pero los salientes HISTÓRICOS lo llevan (el acuse de Mafe del 12/08) y sin esta
        // fuente el barrido los dejaría de ver como promesas de traspaso.
        ...Object.values(CONFIRM_YES_LEGACY),
        ...IDIOMAS_SOPORTADOS.map(l => buildCancelFalloMsg(l)),
        ...IDIOMAS_SOPORTADOS.map(l => buildAmpliacionSolapaMsg(l)),
    ];
    return [...new Set(fuentes.map(normalizeText).filter(Boolean))];
}

// ─── Clasificación de un saliente ────────────────────────────────────────────

const CLASES = {
    C1_HECHA: 'C1 · cita afirmada como hecha',
    C1_CANCELADA: 'C1 · cita afirmada como cancelada',
    C7_AFIRMACION: 'C7 · traspaso afirmado o acusado',
    C7_OFERTA: 'C7 · traspaso ofrecido',
    C7_REMISION: 'C7 · remisión al equipo',
};

// «No me consta ninguna cita reservada a tu nombre» NO es una promesa de cita: es su
// negación, y llmClaimsBooked casa el «cita reservada» de dentro. Cazado en la primera
// corrida real (Carolina, 09/08): sin esta guarda cada negación honesta saldría en el
// informe como promesa rota o salvada, que es exactamente el falso positivo que hace que
// se deje de leer. La clase inversa —negar una cita que SÍ existe, que fue el fallo real
// de Carolina— es otra clase del contrato, no esta, y la cobertura lo declara.
//
// LA GUARDA VA POR FRASE, no por mensaje entero (0a, 14/08/2026): probada sobre el
// mensaje completo se comía «No me consta ninguna cita. Pero hecho, te la he apuntado
// para el lunes» — una promesa DE VERDAD con una negación delante, la forma del «yes»
// dentro de «yesterday». Se descartan solo las frases negadas y el resto se clasifica;
// el separador de frases es el MISMO de announcesHumanHandover, no uno propio.
const NEGACION_CITA_RE = /no (?:me consta|te consta|encuentro|veo|hay|tienes|tenemos|tengo|aparece|figura)\b[^.!?\n]{0,40}\b(?:cita|reserva)/;
const SEPARADOR_FRASES = /(?<=[.!?])\s+|\n+/;

function sinFrasesNegadas(norm) {
    if (!NEGACION_CITA_RE.test(norm)) return norm;
    return norm.split(SEPARADOR_FRASES).filter(f => !NEGACION_CITA_RE.test(f)).join(' ');
}

function clasificarSaliente(content, nucleos) {
    const texto = String(content || '');
    const norm = normalizeText(texto);
    const clases = [];

    // normalizeText es idempotente: pasarle a llmClaimsBooked el texto ya normalizado y
    // sin las frases negadas clasifica igual que el original menos esas frases.
    const afirmable = sinFrasesNegadas(norm);
    if (nucleos.cancelacion.some(n => afirmable.includes(n))) {
        clases.push('C1_CANCELADA');
    } else if ((llmClaimsBooked(afirmable) && !asksForBookingApproval(texto))
        || nucleos.confirmacion.some(n => afirmable.includes(n))) {
        // La exención de Mariola: «¿te lo reservo?» es una pregunta, no una afirmación.
        clases.push('C1_HECHA');
    }

    if (announcesHumanHandover(texto) || nucleos.traspaso.some(n => norm.includes(n))) {
        clases.push('C7_AFIRMACION');
    } else if (offersHumanHandover(texto)) {
        clases.push('C7_OFERTA');
    } else if (remisionAlEquipo(texto)) {
        clases.push('C7_REMISION');
    }

    return clases;
}

// ─── El idioma de un saliente, para el denominador de la cobertura ───────────
//
// Un «0 promesas en ruso» puede significar dos cosas opuestas: que no las hay, o que el
// detector no las ve (C7 en prosa es solo castellano). Sin el DENOMINADOR por idioma,
// las dos se leen igual — y la segunda es justo el informe falso. Cirílico por rango
// Unicode sobre el texto CRUDO (una letra basta: los salientes del bot no mezclan
// alfabetos); el resto lo decide detectLanguage (helpers, el vocabulario que ya existe);
// null cae a 'es', que es el idioma por defecto del bot.
function grupoIdioma(texto) {
    if (/[Ѐ-ӿ]/.test(String(texto || ''))) return 'cirilico';
    return detectLanguage(texto) === 'en' ? 'en' : 'es';
}

// ─── Evaluación contra el estado ─────────────────────────────────────────────

const enVentanaTurno = (tFila, tMsg) =>
    tFila >= tMsg - VENTANA_TURNO_ANTES_MS && tFila <= tMsg + VENTANA_TURNO_DESPUES_MS;

const tocadaPorBot = cita =>
    cita.last_change?.by === 'bot' || cita.updated_by === 'bot';

function evaluarC1(clase, tMsg, citasContacto) {
    // Respaldo A: escrita o retocada por el bot EN ESTE TURNO (crear, cambiar, cancelar).
    for (const cita of citasContacto) {
        if (enVentanaTurno(Date.parse(cita.created_at), tMsg)) return { desenlace: 'respaldada' };
        if (enVentanaTurno(Date.parse(cita.updated_at), tMsg) && tocadaPorBot(cita)) {
            return { desenlace: 'respaldada' };
        }
    }
    if (clase === 'C1_HECHA') {
        // Respaldo B: recitar una cita FUTURA que ya existía es legítimo («queda
        // confirmada tu cita del jueves» sobre una cita real) — es la misma filosofía
        // de blockPhantomBookingClaim, que exonera lo que la BD respalda. Sin este
        // brazo, cada re-confirmación honesta saldría como rota.
        const existente = citasContacto.find(c =>
            Date.parse(c.created_at) < tMsg - VENTANA_TURNO_ANTES_MS
            && Date.parse(c.starts_at) > tMsg && c.status !== 'cancelled');
        if (existente) return { desenlace: 'respaldada', detalle: 'cita ya existente recitada' };

        const posterior = citasContacto.find(c => {
            const creada = Date.parse(c.created_at);
            return creada > tMsg + VENTANA_TURNO_DESPUES_MS && creada <= tMsg + VENTANA_SALVADA_MS;
        });
        if (posterior) {
            const quien = posterior.source === 'manual' ? 'una persona (panel)'
                : (posterior.source || 'origen sin constar');
            const horas = Math.round((Date.parse(posterior.created_at) - tMsg) / 3600000);
            return { desenlace: 'salvada_a_mano', detalle: `cita creada ${horas} h después por ${quien}` };
        }
        return { desenlace: 'rota', detalle: 'ninguna fila de cita, ni entonces ni después' };
    }

    // C1_CANCELADA
    const canceladas = citasContacto.filter(c => c.status === 'cancelled');
    if (!canceladas.length) return { desenlace: 'rota', detalle: 'el contacto no tiene ninguna cita cancelada' };
    const salvada = canceladas.find(c => {
        const t = Date.parse(c.updated_at);
        return t > tMsg + VENTANA_TURNO_DESPUES_MS && t <= tMsg + VENTANA_SALVADA_MS;
    });
    if (salvada) {
        const quien = salvada.last_change?.by || salvada.updated_by || 'sin constar';
        return { desenlace: 'salvada_a_mano', detalle: `cancelada después por ${quien}` };
    }
    // Hay cancelada pero su updated_at no casa la ventana: last_change solo guarda el
    // ÚLTIMO cambio, y una cita re-tocada después borra la huella de aquel turno. No se
    // puede afirmar rota — se dice tal cual (regla 3: lo que no se resuelve, se cuenta).
    return { desenlace: 'no_verificable', detalle: 'hay cita cancelada, pero la huella de aquel turno ya no existe (last_change pisado)' };
}

function evaluarC7Afirmacion(tMsg, pasContacto, contacto, ahora) {
    const enVentana = pasContacto.filter(pa =>
        pa.type === 'escalation' && enVentanaTurno(Date.parse(pa.created_at), tMsg));
    if (enVentana.length) {
        const fichaEscalada = contacto && (contacto.bot_mode === 'manual' || contacto.escalation_reason);
        const pendiente = enVentana.find(pa => pa.status === 'pending');
        // La «una o dos de las tres», comprobable solo mientras la escalada vive: fila
        // pendiente con la ficha ya limpia es una escalada que alguien deshizo a medias.
        if (pendiente && !fichaEscalada) {
            return { desenlace: 'parcial', detalle: 'fila de escalada aún pendiente, pero la ficha ya no está en manual ni escalada' };
        }
        return { desenlace: 'respaldada' };
    }
    // Sin fila. Si la promesa es reciente y la ficha está HOY escalada, puede que las
    // otras dos escrituras entraran y la fila fallara (el try/catch de escalateToHuman
    // permite el fallo parcial): también es «parcial», no «rota».
    const reciente = ahora - tMsg <= VENTANA_PARCIAL_FICHA_MS;
    if (reciente && contacto && (contacto.bot_mode === 'manual' || contacto.escalation_reason)) {
        return { desenlace: 'parcial', detalle: 'ficha en manual/escalada pero sin fila de escalada de aquel turno' };
    }
    return { desenlace: 'rota', detalle: 'ninguna fila en pending_actions en el turno de la promesa' };
}

function evaluarC7Oferta(tMsg, pasContacto) {
    const atendida = pasContacto.some(pa =>
        pa.type === 'escalation'
        && Date.parse(pa.created_at) >= tMsg - VENTANA_TURNO_ANTES_MS
        && Date.parse(pa.created_at) <= tMsg + VENTANA_OFERTA_MS);
    if (atendida) return { desenlace: 'atendido' };
    return { desenlace: 'sin_escalada_registrada', detalle: 'ninguna fila de escalada en las 24 h siguientes a la oferta' };
}

// ─── El barrido entero ───────────────────────────────────────────────────────

const DESENLACES_MAL = new Set(['rota', 'parcial', 'sin_escalada_registrada']);

/**
 * `alarmaDesdeMs` (0d): la ventana del CRON. Sin ella, un hallazgo histórico (Estefania,
 * 03/08) haría gritar exit 1 todas las noches para siempre, y en dos semanas nadie mira
 * la alarma — es lo que pasó con caja_atribucion_desajustada. Con ventana, TODO se sigue
 * imprimiendo (el histórico no desaparece del informe), pero `hayMal` —y con él el exit
 * code— solo depende de los hallazgos cuyo saliente cae dentro. Null = sin ventana
 * (la corrida manual completa): todo alarma, como siempre.
 */
function auditPromesas({ salientes, citas, pendingActions, contactos, ahora = Date.now(), alarmaDesdeMs = null }) {
    const nucleos = {
        cancelacion: nucleosCancelacion(),
        confirmacion: nucleosConfirmacion(),
        traspaso: nucleosTraspaso(),
    };

    const citasPorContacto = new Map();
    for (const c of citas || []) {
        if (!c.contact_id) continue;
        (citasPorContacto.get(c.contact_id) || citasPorContacto.set(c.contact_id, []).get(c.contact_id)).push(c);
    }
    const pasPorContacto = new Map();
    for (const pa of pendingActions || []) {
        if (!pa.contact_id) continue;
        (pasPorContacto.get(pa.contact_id) || pasPorContacto.set(pa.contact_id, []).get(pa.contact_id)).push(pa);
    }
    const contactoPorId = new Map((contactos || []).map(c => [c.id, c]));

    const hallazgos = [];
    const resumen = {};
    const anota = (clase, desenlace) => {
        resumen[clase] = resumen[clase] || {};
        resumen[clase][desenlace] = (resumen[clase][desenlace] || 0) + 1;
    };
    const idiomas = {
        es: { salientes: 0, conPromesa: 0 },
        cirilico: { salientes: 0, conPromesa: 0 },
        en: { salientes: 0, conPromesa: 0 },
    };

    for (const msg of salientes || []) {
        const contacto = msg.contactId ? contactoPorId.get(msg.contactId) : null;
        // Los teléfonos 999… son el arnés de pruebas (TEST_PHONE_PREFIX): sus promesas
        // no son de ninguna clienta y sus filas se limpian — fuera del barrido.
        if (contacto?.wa_phone && String(contacto.wa_phone).startsWith(TEST_PHONE_PREFIX)) continue;

        const grupo = idiomas[grupoIdioma(msg.content)];
        grupo.salientes++;

        const clases = clasificarSaliente(msg.content, nucleos);
        if (!clases.length) continue;
        grupo.conPromesa++;
        const tMsg = Date.parse(msg.createdAt);
        const citasContacto = (msg.contactId && citasPorContacto.get(msg.contactId)) || [];
        const pasContacto = (msg.contactId && pasPorContacto.get(msg.contactId)) || [];

        for (const clase of clases) {
            let r;
            if (clase === 'C1_HECHA' || clase === 'C1_CANCELADA') r = evaluarC1(clase, tMsg, citasContacto);
            else if (clase === 'C7_AFIRMACION') r = evaluarC7Afirmacion(tMsg, pasContacto, contacto, ahora);
            else r = evaluarC7Oferta(tMsg, pasContacto);

            anota(clase, r.desenlace);
            if (r.desenlace === 'respaldada' || r.desenlace === 'atendido') continue;
            hallazgos.push({
                clase,
                claseLabel: CLASES[clase],
                desenlace: r.desenlace,
                detalle: r.detalle || '',
                contactId: msg.contactId || null,
                telefono: contacto?.wa_phone || 'sin teléfono',
                nombre: contacto?.full_name || null,
                fecha: msg.createdAt,
                frase: String(msg.content || '').replace(/\s+/g, ' ').slice(0, 60),
                enVentanaAlarma: alarmaDesdeMs == null || tMsg >= alarmaDesdeMs,
            });
        }
    }

    const hayMal = hallazgos.some(h => DESENLACES_MAL.has(h.desenlace) && h.enVentanaAlarma);

    // La cobertura se DECLARA siempre, y CON EL DENOMINADOR por idioma (0b): un «0
    // promesas en ruso» sin su N de salientes se leería como «no hay promesas rotas»
    // cuando lo cierto puede ser «el detector no las ve». Las líneas de «NO MEDIDO»
    // salen solo cuando ese grupo tiene salientes de verdad — con N=0 no hay nada que
    // no se esté midiendo.
    const cobertura = [
        `Idiomas de los salientes revisados: castellano ${idiomas.es.salientes} (con promesa: ${idiomas.es.conPromesa}) · cirílico ${idiomas.cirilico.salientes} (con promesa: ${idiomas.cirilico.conPromesa}) · inglés ${idiomas.en.salientes} (con promesa: ${idiomas.en.conPromesa}).`,
        ...(idiomas.cirilico.salientes > 0 ? [
            `⚠️ C7 NO MEDIDO en ru/uk sobre prosa: hay ${idiomas.cirilico.salientes} salientes cirílicos y la detección de traspaso en prosa es solo castellana — su ${idiomas.cirilico.conPromesa} de promesas detectadas (plantillas fijas) NO significa que no haya promesas rotas en ruso/ucraniano.`,
        ] : []),
        ...(idiomas.en.salientes > 0 ? [
            `⚠️ C7 NO MEDIDO en inglés sobre prosa (C1 sí se mide): ${idiomas.en.salientes} salientes ingleses revisados solo con plantillas fijas para traspaso.`,
        ] : []),
        'C1 afirmada: prosa en es/en/ru/uk (llmClaimsBooked, con la exención de oferta) + cabeceras fijas de confirmación de los 4 idiomas.',
        'C1 cancelada: SOLO los acuses de plantilla (4 idiomas + variante «reserva» de San Remo); una cancelación afirmada en prosa libre no se ve.',
        'C7 afirmado: prosa SOLO en castellano (announcesHumanHandover) + los acuses fijos de los 4 idiomas (HANDOVER_ACUSE, CONFIRM_YES, fallos de cancelación/ampliación). Prosa libre ru/uk/en: ciega.',
        'C7 ofrecido: preguntas de traspaso, castellano + «подойдёт/підійде» de la pareja verbo-destino; destinos tipo «con ellas» no casan.',
        'C7 remisión: solo castellano («habla con nuestro equipo»).',
        'Negar una cita («no me consta ninguna cita reservada») no es una promesa y no se cuenta; la clase inversa —negar una cita que SÍ existe (Carolina, 09/08)— es del contrato y este barrido no la mide.',
        'Excluido a propósito: el mensaje del tope de sesión y la retención de lista negra de San Remo prometen atención POR DISEÑO y ningún detector los cuenta.',
        'Los teléfonos 999… (arnés de pruebas) quedan fuera.',
    ];

    return { hallazgos, resumen, cobertura, hayMal, idiomas, clases: CLASES };
}

module.exports = {
    auditPromesas, clasificarSaliente, remisionAlEquipo,
    nucleosCancelacion, nucleosConfirmacion, nucleosTraspaso,
    VENTANA_TURNO_ANTES_MS, VENTANA_TURNO_DESPUES_MS, VENTANA_SALVADA_MS, VENTANA_OFERTA_MS,
    CLASES, DESENLACES_MAL,
};
