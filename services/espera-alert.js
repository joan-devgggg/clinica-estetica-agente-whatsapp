/**
 * espera-alert.js — Aviso de "hay una clienta esperando y nadie le ha contestado".
 *
 * ╔══════════════════════════════════════════════════════════════════════════════════════╗
 * ║  ESTE VIGILANTE ESTÁ DORMIDO A PROPÓSITO. NO LO ENCIENDAS SIN LEER ESTO.              ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════╝
 *
 * No está apagado porque falle, ni porque se olvidara encenderlo, ni porque haya que
 * calibrarlo mejor. Está apagado porque **mide otra cosa distinta de la que dice medir**, y
 * mientras siga así todos sus avisos son falsos. Decidido el 10/08/2026, un día después de
 * escribirlo.
 *
 * QUÉ PASA DE VERDAD CUANDO EL BOT ESCALA. La dueña ya recibe su Telegram, entra al WhatsApp
 * **desde el móvil** y contesta a la clienta. Ese circuito funciona y no necesita vigilancia.
 * Lo que NO ocurre nunca es que alguien entre al panel a cerrar la fila de `pending_actions`:
 * no hace falta para atender a nadie, así que no se hace.
 *
 * QUÉ MIDE ESTE MÓDULO, ENTONCES. No mide atención. Mide **si alguien cerró la
 * `pending_action` en el panel** — y no la cierra nadie. Cada aviso suyo sería sobre una
 * clienta que YA está atendida. La regla 2 (entrante sin salida) tiene el mismo agujero por
 * otra puerta: una respuesta enviada desde el móvil no se escribe en `messages`, así que lo
 * que mide es "el bot no contestó", que no es "nadie contestó".
 *
 * CÓMO SE DESTAPÓ. La auditoría del 09/08 leyó a Olga Yarmak (3 días) y a 34656332064 (33 h)
 * como dos clientas abandonadas, y el vigilante las tenía en la mira para su primer arranque.
 * La dueña confirmó que a las dos les había contestado desde el móvil. Los dos primeros
 * Telegrams del vigilante habrían sido falsos, y sobre sus dos casos estrella.
 *
 * QUÉ HARÍA FALTA PARA ENCENDERLO — y es una sola cosa: que las respuestas enviadas desde el
 * móvil de la dueña se registren en `messages` (los ECOS). Con eso, la regla 2 pasa a medir
 * de verdad "nadie ha contestado" y se sostiene sola. La regla 1 necesita además que cerrar
 * la escalada deje de depender de que alguien abra el panel — lo natural es resolverla con el
 * eco, no a mano. Sin ecos, ninguna de las dos mide nada útil y no hay umbral que lo arregle.
 *
 * Lo que sigue vivo y no depende de esto: los umbrales medidos, el texto del aviso y las
 * lecturas con assertRead. Cuando los ecos entren, esto se enciende y se vuelve a medir; el
 * código se deja entero a propósito para no tener que reescribirlo entonces.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Lo que se midió el 09/08 y que fijó los umbrales. Sigue siendo válido PARA EL BOT: dice
 * cuánto tarda el bot en contestar, y no dice nada de lo que pasa desde el móvil.
 *
 *  - De 213 entrantes, 199 se contestaron en **menos de 20 segundos** (p50 9,6 s · p95 13,1 s
 *    · p99 16,0 s · máximo 18 s). Los otros 14 no se contestaron nunca o tardaron horas.
 *    Entre 18 segundos y 236 minutos NO HAY NADA: la distribución no es una cola larga, son
 *    dos poblaciones separadas por cuatro órdenes de magnitud.
 *  - Las 4 escaladas del periodo tardaron 678, 2773, 678 y 532 minutos DE APERTURA. Dos
 *    seguían sin atender al cerrar la auditoría (Olga Yarmak, 3 días; 34656332064, 2 días,
 *    después de decirle "en breve se pondrá en contacto contigo").
 *
 * Consecuencia de la primera medición: **el umbral no lo decide la distribución**. Cualquier
 * valor entre 1 y ~200 minutos se comporta idéntico sobre los datos reales — 0 falsos
 * positivos y los 14 casos cazados. Así que el número tiene que salir de otro sitio, y el
 * sitio es la jornada: Sante abre 9 h (10:00–19:00, `config.horario`, dato editable). Con un
 * umbral de 2 h, toda espera que empiece después de las 17:00 se va al día siguiente sin
 * remedio. Con 1 h, solo la que empieza después de las 18:00. Ese es el argumento entero.
 *
 * Se mide en horario de ATENCIÓN y no de reloj por la misma razón que bot-pause-alert.js:
 * un Telegram a las 2 de la mañana por una clienta que escribió a las 23:00 es el camino
 * más corto a que se silencien los avisos.
 */

const logger = require('../lib/logger');
const { alertOnce, clearAlert } = require('./admin-alerts');
const { minutosDeAperturaEntre, vieneDeAntesDeAbrir, estaAbierto } = require('./horario-apertura');
const { BUSINESS_TZ, toLocalDateStr } = require('./date-utils');

// Un solo umbral para las dos reglas, y es deliberado. Son la misma pregunta —«¿hay alguien
// esperando a una persona?»— por dos puertas distintas: la escalada es la promesa explícita y
// el entrante sin respuesta es la misma espera sin promesa. Dos constantes que siempre se
// ajustarían al mismo valor son una sola con cuerda de más. Si algún día divergen, aquí caben.
const MINUTOS_PARA_AVISAR = 60;

// Más allá de esto no hay nadie esperando: hay una conversación muerta. El número no es
// inventado, es el mismo que ya usa `auto-return.js` para dar una conversación por terminada
// y devolverla a 'auto'. Sin este tope, el primer arranque del vigilante desenterraría meses
// de conversaciones abandonadas de golpe.
const HORIZONTE_DIAS = 7;
const HORIZONTE_MS = HORIZONTE_DIAS * 24 * 60 * 60 * 1000;

const WATCHDOG_INTERVAL_MS = 10 * 60 * 1000;

// ─── La decisión, pura ───────────────────────────────────────────────────────

/**
 * ¿Toca avisar de esta espera? Función PURA: sin BD, sin reloj propio.
 *
 * @param {object} p
 * @param {Date|string} p.desde    Instante en que empezó la espera.
 * @param {Date}   p.ahora
 * @param {object} p.horario       config.horario (puede faltar: entonces cuenta reloj).
 * @returns {{avisar: boolean, motivo: string, minutosAbierto: number}}
 */
function decidirAvisoEspera({ desde, ahora, horario }) {
    if (!desde) return { avisar: false, motivo: 'sin_fecha', minutosAbierto: 0 };
    const ini = desde instanceof Date ? desde : new Date(desde);
    if (Number.isNaN(ini.getTime())) return { avisar: false, motivo: 'fecha_ilegible', minutosAbierto: 0 };

    if (ahora - ini > HORIZONTE_MS) return { avisar: false, motivo: 'fuera_de_horizonte', minutosAbierto: 0 };

    const { minutos } = minutosDeAperturaEntre(ini, ahora, horario);

    // Escribió anoche o el domingo y acabamos de abrir: no se le hace acumular una hora más.
    // Ya ha esperado toda la noche, y este es el primer instante en que alguien puede actuar.
    if (vieneDeAntesDeAbrir(ini, ahora, horario)) {
        return { avisar: true, motivo: 'abierto_con_espera_anterior', minutosAbierto: minutos };
    }
    if (minutos >= MINUTOS_PARA_AVISAR) {
        // Contar en horario de apertura no basta: hay que ENVIAR dentro de él. Mismo medio
        // arreglo que tenía bot-pause-alert — se protegía el contador y no el envío, que es
        // lo que suena en el móvil. Medido el 10/08/2026 a las 02:34 con el salón cerrado:
        // Olga acumulaba 618 minutos de apertura y 34656332064 otros 472, así que los dos
        // avisos habrían salido de madrugada. Retrasarlo no cuesta nada: si al abrir sigue
        // esperando, `vieneDeAntesDeAbrir` dispara a las 10:00 en punto.
        if (!estaAbierto(ahora, horario)) {
            return { avisar: false, motivo: 'cerrado_ahora', minutosAbierto: minutos };
        }
        return { avisar: true, motivo: 'acumulado', minutosAbierto: minutos };
    }
    return { avisar: false, motivo: 'aun_no', minutosAbierto: minutos };
}

// ─── El texto del aviso ──────────────────────────────────────────────────────
//
// Se escribe para que Yulia pueda actuar SIN abrir el panel: quién, desde cuándo, qué dijo, y
// un enlace de WhatsApp en el que tocar. Un aviso que obliga a abrir el panel para saber de
// quién habla es un aviso que se lee más tarde.

const _fechaFmt = new Intl.DateTimeFormat('es-ES', { timeZone: BUSINESS_TZ, weekday: 'long', day: 'numeric', month: 'long' });
const _horaFmt = new Intl.DateTimeFormat('es-ES', { timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** "hoy a las 17:42" · "ayer a las 11:08" · "el sábado 8 de agosto a las 11:08" */
function cuandoTexto(instante, ahora) {
    const hora = _horaFmt.format(instante);
    const dIns = toLocalDateStr(instante);
    const dAhora = toLocalDateStr(ahora);
    if (dIns === dAhora) return `hoy a las ${hora}`;
    const ayer = toLocalDateStr(new Date(ahora.getTime() - 24 * 60 * 60 * 1000));
    if (dIns === ayer) return `ayer a las ${hora}`;
    // es-ES mete una coma tras el día de la semana ("sábado, 8 de agosto") que sobra dentro
    // de una frase corrida.
    return `el ${_fechaFmt.format(instante).replace(',', '')} a las ${hora}`;
}

/**
 * Cómo se encabeza a la clienta. Sin nombre en la ficha se usa el teléfono, pero UNA vez:
 * "+34 656 332 064 · +34 656 332 064" es lo que sale de concatenar sin mirar.
 */
function identidad(nombre, telefono) {
    const bonito = telefonoBonito(telefono);
    const n = String(nombre || '').trim();
    return n ? `<b>${escapeHtml(n)}</b> · ${bonito}` : `<b>${bonito}</b>`;
}

function duracionTexto(minutos) {
    if (minutos < 60) return `${minutos} min`;
    const h = Math.floor(minutos / 60);
    const m = minutos % 60;
    return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

/** +34 674 987 146 — para que se lea, no para parsearlo. */
function telefonoBonito(tel) {
    const d = String(tel || '').replace(/\D/g, '');
    if (!d) return 'sin teléfono';
    if (d.startsWith('34') && d.length === 11) return `+34 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
    return `+${d}`;
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** El texto de la clienta, recortado: el aviso da contexto, no transcribe. */
function recorte(texto, max = 160) {
    const t = String(texto || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return escapeHtml(t.length > max ? `${t.slice(0, max - 1)}…` : t);
}

// Los motivos de escalada tal como los escribe el bot, dichos en español corriente. Un motivo
// que no esté aquí se muestra tal cual: inventarle una traducción sería peor que enseñar la
// etiqueta cruda, y así un motivo nuevo se nota en vez de disfrazarse.
const MOTIVOS = {
    pedir_persona:       'pidió hablar con una persona',
    queja_cita:          'se ha quejado de un servicio',
    consulta_permanente: 'pregunta por un alisado permanente y hay que valorarlo',
    dato_no_disponible:  'preguntó un dato que el bot no tiene',
    fuera_de_catalogo:   'pide algo que no está en el catálogo',
};

const PIE = 'Cuando le contestes, este aviso se cierra solo. No se repite.';

function mensajeEscalada({ nombre, telefono, ultimoTexto, motivo }, desde, minutosAbierto, ahora) {
    const dijo = recorte(ultimoTexto);
    const porque = MOTIVOS[motivo] || (motivo ? escapeHtml(motivo) : null);
    const wa = String(telefono || '').replace(/\D/g, '');

    return '🔔 <b>Una clienta espera a que le escriba una persona</b>\n\n'
        + `${identidad(nombre, telefono)}\n`
        + `El bot se la pasó a una persona ${cuandoTexto(desde, ahora)} y desde entonces nadie le ha escrito.\n`
        + `Lleva <b>${duracionTexto(minutosAbierto)}</b> esperando, contando solo el tiempo con el salón abierto.\n\n`
        + (porque ? `Por qué se la pasó: ${porque}.\n` : '')
        + (dijo ? `Lo último que dijo: «${dijo}»\n` : '')
        + '\nEl bot ya no le contesta a esta clienta: tiene que hacerlo una persona.\n'
        + (wa ? `👉 Escríbele aquí: https://wa.me/${wa}\n\n` : '\n')
        + PIE;
}

function mensajeSinResponder({ nombre, telefono, ultimoTexto, botMode }, desde, minutosAbierto, ahora) {
    const dijo = recorte(ultimoTexto);
    const wa = String(telefono || '').replace(/\D/g, '');

    // Las dos causas posibles piden acciones distintas, y decirlo ahorra abrir el panel.
    const porque = botMode === 'manual'
        ? 'Esta conversación está en manual: el bot no le va a contestar.'
        : 'El bot debería haberle contestado en segundos y no lo ha hecho.';

    return '🔔 <b>Una clienta escribió y nadie le ha contestado</b>\n\n'
        + `${identidad(nombre, telefono)}\n`
        + `Escribió ${cuandoTexto(desde, ahora)} y no ha recibido respuesta.\n`
        + `Lleva <b>${duracionTexto(minutosAbierto)}</b> esperando, contando solo el tiempo con el salón abierto.\n\n`
        + (dijo ? `Lo que dijo: «${dijo}»\n\n` : '\n')
        + `${porque}\n`
        + (wa ? `👉 Escríbele aquí: https://wa.me/${wa}\n\n` : '\n')
        + PIE;
}

// ─── El vigilante ────────────────────────────────────────────────────────────

const claveEscalada = id => `espera_escalada|${id}`;
const claveSinResponder = convId => `espera_entrante|${convId}`;

// orgId → Set de claves por las que ya se avisó, para poder liberarlas al resolverse. Sin
// esto, una espera atendida dejaría su clave marcada para siempre y la SIGUIENTE espera de la
// misma conversación no avisaría nunca.
const _avisadas = new Map();

function _marcar(orgId, clave) {
    if (!_avisadas.has(orgId)) _avisadas.set(orgId, new Set());
    _avisadas.get(orgId).add(clave);
}

/** Libera las claves de esperas que ya no existen: alguien contestó. */
function _liberarResueltas(orgId, clavesVivas) {
    const previas = _avisadas.get(orgId);
    if (!previas) return;
    for (const clave of [...previas]) {
        if (clavesVivas.has(clave)) continue;
        previas.delete(clave);
        clearAlert(orgId, clave);
        logger.info('espera_atendida', { orgId, clave });
    }
}

/**
 * Una pasada del vigilante para una org. Se le inyectan los datos ya leídos para que sea
 * probable sin BD, igual que `revisarPausaProlongada`.
 *
 * @param {string} orgId
 * @param {object} estado
 * @param {boolean} estado.botActivo          Si el bot está pausado, el aviso lo da bot-pause-alert.
 * @param {object}  estado.horario            config.horario.
 * @param {Array}   estado.escaladas          De db.getEscaladasPendientes.
 * @param {Array}   estado.sinResponder       De db.getConversacionesSinResponder.
 * @param {Date}    ahora
 * @returns {Promise<number>} cuántos avisos se entregaron.
 */
async function revisarEsperas(orgId, { botActivo = true, horario, escaladas = [], sinResponder = [] }, ahora = new Date()) {
    // Con el bot pausado para toda la org, TODAS las conversaciones se quedan sin responder a
    // la vez. Avisar aquí sería inundar Telegram repitiendo lo que bot-pause-alert ya dice
    // mejor y una sola vez — y dos avisos por el mismo hecho es cómo se dejan de leer los dos.
    if (botActivo === false) {
        logger.info('espera_watchdog_omitido_bot_pausado', { orgId });
        return 0;
    }

    const clavesVivas = new Set();
    let entregados = 0;

    // ── Regla 1: escalada sin resolver ───────────────────────────────────────
    // Va primero porque es la promesa explícita («en breve te atiende una persona») y porque
    // su aviso es más informativo: lleva el motivo.
    const conEscalada = new Set();
    for (const esc of escaladas) {
        if (esc.blacklisted) continue;                     // silencio deliberado, no espera
        if (esc.contactId) conEscalada.add(esc.contactId);
        const clave = claveEscalada(esc.id);
        clavesVivas.add(clave);

        const d = decidirAvisoEspera({ desde: esc.creadaAt, ahora, horario });
        if (!d.avisar) continue;

        if (await alertOnce(orgId, clave, mensajeEscalada(esc, new Date(esc.creadaAt), d.minutosAbierto, ahora))) {
            _marcar(orgId, clave);
            entregados++;
            logger.warn('espera_escalada_sin_atender', {
                orgId, telefono: esc.telefono, motivo: d.motivo,
                minutosAbierto: d.minutosAbierto, pendingActionId: esc.id,
            });
        }
    }

    // ── Regla 2: entrante sin salida ─────────────────────────────────────────
    for (const conv of sinResponder) {
        if (conv.blacklisted) continue;
        // Ya tiene escalada abierta: la regla 1 acaba de avisar por ella. Dos Telegrams por
        // la misma clienta esperando es exactamente el ruido que hace que no se lea ninguno.
        if (conv.contactId && conEscalada.has(conv.contactId)) continue;

        const clave = claveSinResponder(conv.conversationId);
        clavesVivas.add(clave);

        const d = decidirAvisoEspera({ desde: conv.esperandoDesde, ahora, horario });
        if (!d.avisar) continue;

        if (await alertOnce(orgId, clave, mensajeSinResponder(conv, new Date(conv.esperandoDesde), d.minutosAbierto, ahora))) {
            _marcar(orgId, clave);
            entregados++;
            logger.warn('espera_entrante_sin_responder', {
                orgId, telefono: conv.telefono, botMode: conv.botMode,
                motivo: d.motivo, minutosAbierto: d.minutosAbierto,
            });
        }
    }

    _liberarResueltas(orgId, clavesVivas);
    return entregados;
}

// ─── Interruptor: por defecto DORMIDO ────────────────────────────────────────
//
// El PORQUÉ está entero en la cabecera del fichero. En una línea: esto no mide si a la
// clienta la han atendido, mide si alguien cerró la `pending_action` en el panel — y nadie
// la cierra, porque la dueña contesta desde el móvil y no le hace falta.
//
// Se apaga con el DEFAULT y no con un valor. Si la variable falta, viene vacía o está mal
// escrita, el vigilante duerme. Al revés —apagarlo con un `=off` explícito— cualquier
// despliegue que perdiera la variable devolvería los avisos falsos sin que nadie lo pidiera,
// que es exactamente el fallo que esto viene a evitar.
//
// NO lo pongas a 'on' hasta que los ecos registren en `messages` las respuestas del móvil.
// Es el único requisito, y no es de calibración: sin él no hay umbral que valga.
const VIGILANTE_VAR = 'VIGILANTE_ESPERAS';
function vigilanteActivado() {
    return String(process.env[VIGILANTE_VAR] || '').trim().toLowerCase() === 'on';
}

/**
 * Arranca el vigilante. La BD se lee aquí y solo aquí: `revisarEsperas` se queda sin I/O
 * para poder probarlo entero.
 *
 * @returns {boolean} true si ha quedado armado; false si duerme.
 */
function startEsperaWatchdog(orgIds) {
    if (!vigilanteActivado()) {
        // warn y no info: que se vea en el arranque que hay una red apagada a propósito.
        logger.warn('espera_watchdog_dormido', {
            motivo: `${VIGILANTE_VAR} != 'on'`,
            requisitoPrevio: 'los ecos del móvil de la dueña no llegan a messages',
        });
        return false;
    }

    const orgs = Array.isArray(orgIds) ? orgIds : [...(orgIds?.keys?.() || [])];
    const db = require('./db');

    async function tick() {
        const ahora = new Date();
        for (const orgId of orgs) {
            try {
                const entrada = await db.getConfigEntry(orgId, 'bot_activo');
                const horario = await db.getConfigValue(orgId, 'horario');
                const [escaladas, sinResponder] = await Promise.all([
                    db.getEscaladasPendientes(orgId),
                    db.getConversacionesSinResponder(orgId, {
                        desde: ahora.getTime() - HORIZONTE_MS,
                        quietoAntesDe: ahora.getTime() - MINUTOS_PARA_AVISAR * 60000,
                    }),
                ]);
                await revisarEsperas(orgId, {
                    botActivo: entrada?.valor !== false, horario, escaladas, sinResponder,
                }, ahora);
            } catch (e) {
                // Una lectura que falla NO se degrada a "no hay nadie esperando": se grita en
                // el log y se reintenta al tic siguiente. Es la diferencia entre un vigilante
                // caído y un vigilante que da el parte de todo en orden sin haber mirado.
                logger.error('espera_watchdog_error', { orgId, error: e.message });
            }
        }
    }

    logger.info('espera_watchdog_iniciado', { orgs: orgs.length, minutosParaAvisar: MINUTOS_PARA_AVISAR });
    setInterval(tick, WATCHDOG_INTERVAL_MS).unref();
    setTimeout(tick, 90 * 1000).unref();
    return true;
}

/** Solo para tests. */
function _resetWatchdog() { _avisadas.clear(); }

module.exports = {
    decidirAvisoEspera, revisarEsperas, startEsperaWatchdog, vigilanteActivado, VIGILANTE_VAR,
    mensajeEscalada, mensajeSinResponder, cuandoTexto, duracionTexto, telefonoBonito,
    MINUTOS_PARA_AVISAR, HORIZONTE_DIAS, WATCHDOG_INTERVAL_MS, _resetWatchdog,
};
