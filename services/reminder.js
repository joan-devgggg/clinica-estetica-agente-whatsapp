/**
 * Reminder Worker — Multi-org
 * Cada 5 minutos: para cada org, envía recordatorios 24h antes de la cita
 * y auto-completa citas cuya hora de fin ya pasó.
 */

const { getAppointmentsPendientesRecordatorio, marcarRecordatorioSent, marcarRecordatorioCitaSent, getConfigValue, getAgentConfig, autoCompleteAppointments } = require('./db');
const { notePendingOutboundTurn } = require('./pending-outbound');
const { resolveOutboundClient, resolveAutomatedSend } = require('./outbound');
const { isUsableName, resolveReminderWindowMin, formatReminderWhen } = require('./helpers');
const { getOrgType } = require('./org-registry');
const { alertOnce } = require('./admin-alerts');
const { noteSendResult } = require('./channel-health');
const logger = require('../lib/logger');

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
let waClients = null; // Map<orgId, { client, orgId, ... }>

// Mismo patrón que REVIEW_TEMPLATES en review.js: la clienta habla en su idioma durante
// toda la conversación (bot.js detecta ES/EN/RU/UK), así que el recordatorio no puede ser
// el único mensaje que le llega siempre en español.
//
// El parámetro se llama `cuando` y no `hora` porque desde el 10/08/2026 puede ser las dos
// cosas: la hora sola («17:30») o la hora con su fecha detrás («17:30 del miércoles 12 de
// agosto»). Quien llama lo decide —ver `resolveCuando`—; aquí solo se interpola, y por eso
// estas cuatro frases son literalmente el texto fijo de las plantillas aprobadas de Meta
// alrededor de `{{2}}`. Cambiar una de estas cuatro sin cambiar su plantilla las separa.
const REMINDER_TEMPLATES = {
    es: (nombre, salon, cuando) =>
        `Hola ${nombre || ''} 😊 Te recordamos tu cita en ${salon} a las ${cuando || ''}. ¡Te esperamos!`,
    en: (nombre, salon, cuando) =>
        `Hi ${nombre || ''} 😊 Just a reminder of your appointment at ${salon} at ${cuando || ''}. See you soon!`,
    ru: (nombre, salon, cuando) =>
        `Привет ${nombre || ''} 😊 Напоминаем о вашей записи в ${salon} в ${cuando || ''}. Ждём вас!`,
    uk: (nombre, salon, cuando) =>
        `Привіт ${nombre || ''} 😊 Нагадуємо про ваш запис у ${salon} о ${cuando || ''}. Чекаємо на вас!`,
};

function buildReminderMessage(nombre, salon, cuando, language) {
    const template = REMINDER_TEMPLATES[language] || REMINDER_TEMPLATES.es;
    return template(nombre, salon, cuando);
}

/**
 * Qué se pone donde antes iba la hora: «17:30» o «17:30 del miércoles 12 de agosto».
 *
 * **Solo el salón lleva fecha.** San Remo no la ha pedido y su recordatorio tiene que quedar
 * byte por byte como estaba: la regla de oro no admite cambiarle el mensaje por comodidad
 * nuestra. Se gatea por `getOrgType`, no por UUID, para que un salón futuro la herede sin
 * tocar nada — la fecha es útil para cualquier salón, no para esta org en concreto.
 *
 * Si la fecha no se entiende sale la hora sola, que es el mensaje de siempre, y lo sabe una
 * persona. Nunca se inventa un día. Puede pasar de verdad: `minutosHastaCita` no descarta una
 * `fecha_cita` malformada —`new Date('basura')` da NaN y `NaN > minutos` es false—, así que
 * una fila así llega hasta aquí.
 */
async function resolveCuando(orgId, record) {
    if (getOrgType(orgId) !== 'salon') return record.hora_cita;

    const cuando = formatReminderWhen(record.fecha_cita, record.hora_cita, record.language);
    if (cuando) return cuando;

    await avisarFechaNoFormateable(orgId, record);
    return record.hora_cita;
}

// El recordatorio SALE igual, con la hora sola: no mandarlo por no poder escribir la fecha
// sería cambiar un mensaje incompleto por ninguno, y por eso esto NO es un motivo de
// `motivoNoEnviable` — ahí caen las cosas que impiden el envío, y esta no lo impide.
//
// Pero tampoco puede pasar en silencio. Una `fecha_cita` ilegible no es solo un recordatorio
// más pobre: es una ficha rota, la cita se ve mal en la agenda y mañana sigue rota. Un fallo
// que solo deja rastro en el log es un fallo que no ve nadie.
//
// Throttle por CLAVE Y VALOR, como `avisarVentanaInvalida`: el worker tica cada 5 min dentro
// de una ventana de 24 h, así que sin throttle serían ~288 mensajes por cita; y si la fecha se
// corrige y vuelve a quedar mal de otra forma, el aviso tiene que volver a salir.
async function avisarFechaNoFormateable(orgId, record) {
    const cruda = String(record.fecha_cita ?? '').slice(0, 40);
    logger.warn('recordatorio_fecha_no_formateable', {
        orgId, contactId: record.id, fecha: record.fecha_cita ?? null, hora: record.hora_cita || null,
    });
    const digits = String(record.telefono || '').replace(/\D/g, '');
    const mensaje =
        '⚠️ <b>Recordatorio enviado SIN la fecha</b>\n\n'
        + `Le he mandado el recordatorio a ${record.nombre || 'una clienta'} `
        + `(${digits ? `+${digits}` : 'sin teléfono'}) con la hora, pero sin el día: la fecha de `
        + `la cita está guardada como «${cruda || '(vacía)'}» y no se entiende.\n\n`
        + `🕐 Ha salido: a las ${record.hora_cita || ''}\n\n`
        // Sin "se lo vuelvo a mandar": el recordatorio ya está marcado como enviado y no
        // vuelve a salir. Prometerlo sería prometer algo que no va a pasar.
        + 'El mensaje ha salido, no hay que reenviarlo. Revisa la fecha de esa cita en el '
        + 'panel: si está así de mal, la cita tampoco estará bien en la agenda.';
    // Se espera: si el aviso no llega a Telegram, alertOnce deja la clave libre y el siguiente
    // tic lo reintenta. El envío del recordatorio no depende de esto.
    await alertOnce(orgId, `recordatorio_fecha|${record.id}|${cruda}`, mensaje);
}

function minutosHastaCita(fechaStr, horaStr) {
    if (!fechaStr) return Infinity;
    try {
        const fechaHora = new Date(`${fechaStr}T${horaStr || '00:00'}:00`);
        return (fechaHora.getTime() - Date.now()) / 60000;
    } catch {
        return Infinity;
    }
}

// Resuelve el chatId de WhatsApp. Prioriza el JID canónico persistido (contacts.metadata.wa_jid);
// para un LID (~15 dígitos) usa @lid y para un número real @c.us. Evita "<lid>@c.us" (chat
// inexistente que hace fallar el envío).
function resolveChatId(telefono, waJid) {
    if (waJid && typeof waJid === 'string' && waJid.includes('@')) return waJid;
    const digits = String(telefono || '').replace(/@c\.us$|@lid$/g, '').replace(/\D/g, '');
    if (!digits) return null;
    return digits.length >= 14 ? `${digits}@lid` : `${digits}@c.us`;
}

// ─── Puerta de calidad: un automatismo sale BIEN o no sale ───────────────────
//
// Con full_name null salían dos cosas distintas, las dos malas: por texto libre
// "Hola  😊 Te recordamos…" (doble espacio, `${nombre || ''}`), y por plantilla un {{1}}
// vacío que Meta rechaza entera (132000) — el envío falla, no se marca enviado y el worker
// reintenta cada 5 minutos para siempre. Le tocaba el 04/08/2026 a una clienta con cita al
// día siguiente. Lo mismo con un contacto sin teléfono (hay uno con wa_phone = '').

/** Motivo por el que el recordatorio no puede salir bien, o null si sí puede. */
function motivoNoEnviable(record) {
    if (!resolveChatId(record.telefono, record.wa_jid)) return 'sin_telefono';
    // isUsableName (helpers.js) es la definición ÚNICA de "esto sirve para saludar".
    // No es isValidName: ver allí por qué la puerta de salida tiene que ser más laxa
    // que la de captura.
    if (!isUsableName(record.nombre)) return 'sin_nombre';
    if (!record.hora_cita) return 'sin_hora';   // {{2}} vacío = mismo rechazo de Meta
    return null;
}

const MOTIVO_TEXTO = {
    sin_telefono: 'no tiene teléfono guardado',
    sin_nombre: 'no tiene nombre en la ficha',
    sin_hora: 'no tiene hora guardada',
};

// "2026-08-05" + "17:30" → "miércoles 5 de agosto a las 17:30". El aviso lo lee una persona
// que no es técnica ni hispanohablante nativa: una fecha ISO obliga a descifrarla.
// Mediodía local a propósito: evita que un cambio de huso mueva el día.
function fechaEnCastellano(fecha, hora) {
    if (!fecha) return 'sin fecha';
    const d = new Date(`${fecha}T12:00:00`);
    if (Number.isNaN(d.getTime())) return hora ? `${fecha} a las ${hora}` : fecha;
    // toLocaleDateString mete coma tras el día de la semana ("miércoles, 5 de agosto").
    const dia = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })
        .replace(',', '');
    return hora ? `${dia} a las ${hora}` : dia;
}

// El aviso se throttlea por CITA (contacto + fecha + hora), no por intento: el worker tica
// cada 5 min y la ventana dura 24 h, así que sin throttle serían ~288 mensajes a Yulia.
async function avisarRecordatorioBloqueado(orgId, record, motivo) {
    logger.warn('recordatorio_bloqueado', {
        orgId, motivo, contactId: record.id,
        telefono: record.telefono || null,
        fecha: record.fecha_cita, hora: record.hora_cita || null,
    });
    const digits = String(record.telefono || '').replace(/\D/g, '');
    const telefono = digits ? `+${digits}` : '(sin teléfono guardado)';
    const mensaje =
        '⚠️ <b>Recordatorio sin enviar</b>\n\n'
        + `No he podido mandar el recordatorio de una cita porque ${MOTIVO_TEXTO[motivo]}.\n\n`
        + `📅 Cita: ${fechaEnCastellano(record.fecha_cita, record.hora_cita)}\n`
        + `📱 Teléfono: ${telefono}\n\n`
        // Sin "y te lo mando yo": si completa la ficha después de la hora de la cita ya no
        // sale nada (minutosRestantes < 0), y sería prometerle algo que no va a pasar.
        + 'Escríbele tú, o completa la ficha en el panel.';
    // Se espera: si el aviso no llega a Telegram, alertOnce deja la clave libre y el
    // siguiente tic (5 min) lo reintenta. Sin await, el reintento no serviría de nada porque
    // el worker seguiría adelante sin saber si salió.
    await alertOnce(orgId, `recordatorio|${record.id}|${record.fecha_cita}|${record.hora_cita || ''}|${motivo}`, mensaje);
}

// La ventana no se entiende → no sale ningún recordatorio de esa org, y lo sabe una persona.
// Throttle por CLAVE Y VALOR: si Yulia corrige el campo y vuelve a equivocarse con otra cosa,
// el aviso tiene que volver a salir. Si lo deja igual, no se repite cada cinco minutos.
async function avisarVentanaInvalida(orgId, ventana) {
    logger.error('recordatorio_config_invalida', {
        orgId, clave: ventana.clave, valor: String(ventana.valor).slice(0, 40),
    });
    const mensaje =
        '⚠️ <b>Recordatorios parados</b>\n\n'
        + `El campo <b>${ventana.clave}</b> tiene el valor «${String(ventana.valor).slice(0, 40)}», `
        + 'que no es un número.\n\n'
        + `${ventana.mensaje}\n\n`
        + 'Mientras siga así no sale ningún recordatorio de 24 h. Corrígelo en Configuración y '
        + 'volverán a salir solos: las citas siguen pendientes, no se ha perdido ninguna.';
    await alertOnce(orgId, `recordatorio_config|${ventana.clave}|${ventana.valor}`, mensaje);
}

// ─── Enviar y APUNTAR son dos cosas, y entre las dos cabe un recordatorio repetido ───────
//
// Gemelo exacto del hallazgo 🟠 3 de docs/auditoria-afirmar-sin-verificar.md, que se arregló
// en las reseñas y quedó apuntado aquí. Con una diferencia que lo hacía MÁS silencioso:
// `marcarRecordatorioSent` no lanzaba, devolvía `true` sin mirar nada. O sea que un marcado
// perdido no abortaba nada —parecía ir bien— y el tic siguiente (5 min) volvía a encontrar la
// cita pendiente y le mandaba OTRO recordatorio. Y otro. Sin un solo log.
//
// Ahora `marcarRecordatorioSent` lanza (assertRowsAffected), y aquí se aplica la misma regla
// que en reseñas y en el registro de campañas: **después de un envío entregado, el marcado se
// reintenta y su fallo NUNCA puede convertirse en un segundo envío.**
//
// La estructura es deliberadamente la misma que la de review.js —reintentos, memoria de lo
// entregado-sin-apuntar, aviso— y no se ha factorizado a un módulo común: son dos identidades
// distintas (contacto vs cita), dos textos distintos para Yulia y dos ritmos distintos. Igual
// que `resolveChatId`, que ya vive duplicado en los dos ficheros por el mismo motivo.
const REINTENTOS_MARCADO = 3;

// `${orgId}|${contactId}` → { desde }. En RAM y a propósito: un reinicio la pierde y esa
// clienta podría recibir un segundo recordatorio. Se asume porque persistirlo es escribir la
// fila, que es justo lo que no se ha podido hacer.
const enviadosSinMarcar = new Map();
const claveMarcado = (orgId, contactId) => `${orgId}|${contactId}`;

const MENSAJE_SIN_MARCAR = (nombre, telefono) =>
    '⚠️ <b>Recordatorio enviado y sin apuntar</b>\n\n'
    + `Le he mandado el recordatorio a ${nombre || 'una clienta'} (${telefono || 'sin teléfono'}) `
    + 'y salió bien, pero no he podido dejar constancia en su ficha.\n\n'
    + 'No se lo voy a volver a mandar. Si el problema sigue, márcalo a mano en el panel.';

/**
 * Marca `recordatorio_enviado` de un contacto cuyo mensaje YA salió. Nunca lanza.
 *
 * @returns {Promise<boolean>} true si quedó apuntado.
 */
async function marcarRecordatorioConReintentos(orgId, record) {
    const clave = claveMarcado(orgId, record.id);
    let ultimoError = null;

    for (let intento = 0; intento < REINTENTOS_MARCADO; intento++) {
        if (intento > 0) await new Promise(r => setTimeout(r, 200 * intento));
        try {
            // Los records del salón vienen de appointments (esCita) y su marca vive en la
            // CITA; los de San Remo siguen marcando la ficha. record.id ya es el id de la
            // tabla que toca en cada caso (lo puso construirPendientesDesdeCitas).
            if (record.esCita) await marcarRecordatorioCitaSent(orgId, record.id);
            else await marcarRecordatorioSent(orgId, record.id);
            enviadosSinMarcar.delete(clave);
            return true;
        } catch (e) {
            ultimoError = e;
        }
    }

    if (!enviadosSinMarcar.has(clave)) enviadosSinMarcar.set(clave, { desde: Date.now() });
    logger.error('recordatorio_enviado_sin_registrar', {
        orgId, contactId: record.id, telefono: record.telefono || null,
        error: ultimoError?.message || null,
    });
    await alertOnce(orgId, `recordatorio_sin_marcar|${record.id}`,
        MENSAJE_SIN_MARCAR(record.nombre, record.telefono));
    return false;
}

/** Solo para tests: olvida lo entregado-sin-apuntar. */
function _resetPendientesDeMarcar() { enviadosSinMarcar.clear(); }

// Cuánto tiempo sigue explicando la conversación un recordatorio ya enviado, a efectos
// del historial del prompt. 48 h cubre cualquier `horas_recordatorio` sensato (hoy 24);
// pasada la cita, la nota caduca sola en el drenaje.
const TTL_NOTA_RECORDATORIO_MS = 48 * 60 * 60 * 1000;

/**
 * Deja constancia de un recordatorio YA ENVIADO en los dos sitios que hasta ahora no lo
 * veían — causa de que el bot contestara a ciegas «¿Qué día o semana te viene mejor?» a un
 * «Hola, si confirmado» (Barbora Jalova, 13/08/2026) y de que el Monitor enseñara esa
 * respuesta como primer mensaje de la nada:
 *
 *   1. `messages` (panel, y con él `last_message_at`). La plantilla aprobada de Meta no
 *      tiene texto local que copiar: se guarda `mensaje` — que lleva EL MISMO contenido
 *      por diseño («un solo valor para los dos caminos»: nombre y cuándo salen de
 *      resolveCuando) — prefijado con el nombre de la plantilla, para no afirmar bytes
 *      que no vimos. Efecto lateral asumido y anotado: `saveMessage` refresca
 *      `conversations.last_message_at`, que auto-return usa como «última actividad»; un
 *      recordatorio nuestro retrasa hasta 24 h un retorno a auto de 7 días. La ventana de
 *      24 h de Meta NO se toca (se calcula sobre entrantes, nunca sobre ese campo).
 *   2. El historial de la conversación, vía pending-outbound: el prompt del LLM se
 *      construye SOLO de session.history (bloque 1b del nocturno 14/08), así que
 *      escribirlo en `messages` no cura la ceguera. bot.js lo drena al siguiente turno,
 *      ANTES del mensaje de la clienta, que es el orden real.
 *
 * Solo salón, gateado por tipo de org: San Remo no ha pedido ver sus recordatorios en el
 * panel ni en el prompt, y la regla de oro manda dejarlo byte por byte como está.
 * Nunca lanza: el mensaje ya salió; no poder registrarlo se loguea y no bloquea nada.
 */
async function registrarRecordatorioEnviado(orgId, record, { mensaje, decision }) {
    if (getOrgType(orgId) !== 'salon') return;
    try {
        // require perezoso: el destructure de arriba se congela al cargar el módulo, y los
        // tests herméticos del worker reemplazan db entero en require.cache.
        const { saveMessage } = require('./db');
        if (typeof saveMessage === 'function') {
            const contenido = decision?.mode === 'template'
                ? `[plantilla ${decision.template?.name || 'recordatorio'}] ${mensaje}`
                : mensaje;
            await saveMessage(orgId, { telefono: record.telefono, contenido, direccion: 'saliente' });
        }
    } catch (e) {
        logger.error('recordatorio_registro_mensaje_fallido', { orgId, telefono: record.telefono, error: e.message });
    }
    try {
        // Al historial va `mensaje` a secas: es lo que la clienta leyó (la plantilla dice
        // lo mismo con el texto fijo aprobado), y un prefijo técnico solo despistaría al modelo.
        notePendingOutboundTurn(orgId, record.telefono, mensaje, { ttlMs: TTL_NOTA_RECORDATORIO_MS });
    } catch (e) {
        logger.error('recordatorio_registro_historial_fallido', { orgId, telefono: record.telefono, error: e.message });
    }
}

/**
 * Envía el recordatorio por la vía que corresponda.
 *
 * En Cloud API (Sante) el texto libre SOLO se entrega dentro de las 24 h desde el último
 * mensaje entrante de la clienta, y entre reservar y la visita pasan días: el recordatorio
 * cae fuera casi siempre. Antes se mandaba igual, Meta respondía 200, y el worker marcaba
 * `recordatorio_enviado = true` sobre un mensaje que nadie recibió — y ya no se reintentaba.
 * Fuera de ventana va por plantilla aprobada.
 *
 * @returns {'enviado'|'fallo'|'sin_plantilla'}
 */
async function sendReminderMessage(orgId, record, { mensaje, templateParams }) {
    const entry = waClients?.get(orgId);
    if (!entry?.client) {
        logger.warn('reminder_wa_no_disponible', { orgId });
        return 'fallo';
    }
    const chatId = resolveChatId(record.telefono, record.wa_jid);
    if (!chatId) {
        logger.warn('reminder_sin_chatid', { orgId, telefono: record.telefono });
        return 'fallo';
    }

    const client = resolveOutboundClient(orgId, entry.client);
    if (!client) {
        logger.warn('reminder_wa_no_disponible', { orgId });
        return 'fallo';
    }

    try {
        const decision = await resolveAutomatedSend(orgId, {
            telefono: record.telefono,
            language: record.language || 'es',
            plantillaClave: 'plantilla_recordatorio',
        });

        if (decision.mode === 'sin_plantilla') {
            // No marcamos enviado: queda pendiente y saldrá solo en cuanto se configure.
            logger.warn('recordatorio_sin_plantilla_configurada', {
                orgId, telefono: record.telefono, language: record.language || 'es',
            });
            return 'sin_plantilla';
        }

        if (decision.mode === 'template') {
            await client.sendTemplate(chatId, {
                name: decision.template.name,
                language: decision.template.language,
                params: templateParams, // [{{1}} nombre, {{2}} cuándo — hora, y en el salón su fecha]
            });
            logger.info('recordatorio_por_plantilla', {
                orgId, telefono: record.telefono, plantilla: decision.template.name,
            });
        } else {
            await client.sendMessage(chatId, mensaje);
        }
        // A partir de aquí el mensaje EXISTE: se deja constancia donde la conversación y
        // el panel puedan verlo. Nunca lanza — un fallo del registro no puede deshacer un
        // envío ya hecho ni impedir el marcado (que es lo que evita el reenvío).
        await registrarRecordatorioEnviado(orgId, record, { mensaje, decision });
        // Salud del canal: este envío no pasa por waSendMessage, así que se reporta aquí.
        // 'sin_plantilla' no se reporta porque no llegó a intentarse ningún envío.
        // Se ESPERA: noteSendResult manda el aviso de canal caído (y el de recuperado) por
        // Telegram, y sin await el worker sigue adelante sin saber si salió.
        await noteSendResult(orgId, { ok: true });
        return 'enviado';
    } catch (e) {
        logger.error('reminder_error_envio', { orgId, telefono: record.telefono, chatId, error: e.message });
        await noteSendResult(orgId, { ok: false, error: e, contexto: 'recordatorio de 24 h' });
        return 'fallo';
    }
}

async function checkAndSendReminders() {
    if (!waClients) return;

    for (const [orgId] of waClients) {
        try {
            // Auto-completar citas pasadas
            await autoCompleteAppointments(orgId);

            // Recordatorios.
            // Se leen las DOS claves porque las orgs no las escriben igual: San Remo tiene
            // `minutos_recordatorio`, Sante `horas_recordatorio`. Mirando solo la primera, el
            // 24 de Sante era una config muerta —funcionaba por el default de 1440— y
            // cambiarla no habría surtido ningún efecto.
            //
            // Y se VALIDA antes de usarla. Aquí había un `Number(...)` a pelo, y con un valor
            // no numérico —«24 horas», «veinticuatro»— eso no daba un número corto: daba NaN,
            // y `minutosRestantes > NaN` es false, o sea que la guarda de abajo dejaba de
            // descartar nada. Un solo tic mandaba el recordatorio de TODAS las citas futuras
            // de la org, las marcaba como enviadas, y el día de antes ya no salía ninguna.
            // La consulta que las trae no acota por fecha: esa comparación es el único límite.
            const minutosDb = await getConfigValue(orgId, 'minutos_recordatorio');
            const horasDb   = minutosDb === null ? await getConfigValue(orgId, 'horas_recordatorio') : null;
            const ventana = resolveReminderWindowMin({ minutos: minutosDb, horas: horasDb });
            if (!ventana.ok) {
                // No se manda NADA con una ventana que no se entiende: la alternativa es
                // elegir por la dueña a cuántas clientas se escribe, y en la dirección mala.
                // El barrido de auto-completar ya ha corrido arriba, así que eso no se pierde.
                await avisarVentanaInvalida(orgId, ventana);
                continue;
            }
            const minutosAntes = ventana.minutos;

            const agentCfg = await getAgentConfig(orgId);
            const info = agentCfg?.business_info || {};
            const companyName = info.companyName || 'nuestro centro';
            const botName = info.botName || '';

            const pendientes = await getAppointmentsPendientesRecordatorio(orgId);

            for (const record of pendientes) {
                // El try va por CONTACTO, no por org. Estaba solo fuera del bucle: ahora que
                // marcarRecordatorioSent lanza, un fallo suyo se habría llevado por delante a
                // todas las clientas siguientes de esa org en ese tic, sin dejar rastro de
                // cuáles. Es el mismo cambio que se le hizo al bucle de reseñas.
                try {
                    // Sin fecha no hay ventana que calcular, así que no hay nada que decidir ni
                    // de qué avisar. El teléfono, en cambio, YA NO se descarta aquí: saltárselo en
                    // silencio es precisamente cómo el contacto sin wa_phone (cita del 19/08) se
                    // quedaba sin recordatorio sin que nadie se enterara. Cae en motivoNoEnviable,
                    // después del filtro de ventana, para no avisar de citas que aún no tocan.
                    if (!record.fecha_cita) continue;

                    const minutosRestantes = minutosHastaCita(record.fecha_cita, record.hora_cita);
                    if (minutosRestantes < 0 || minutosRestantes > minutosAntes) continue;

                    // Ya se le mandó y solo faltó apuntarlo: se reintenta el MARCADO, jamás el
                    // envío. Sin esto la ficha sigue "pendiente" en BD y la clienta recibe el
                    // recordatorio otra vez cada cinco minutos.
                    if (enviadosSinMarcar.has(claveMarcado(orgId, record.id))) {
                        await marcarRecordatorioConReintentos(orgId, record);
                        continue;
                    }

                    // Si el recordatorio no puede salir BIEN, no sale: se avisa a una persona y
                    // se deja PENDIENTE. Clave: no se marca `recordatorio_enviado`, así que en
                    // cuanto le completen la ficha el siguiente tic lo manda solo — la puerta se
                    // reevalúa en cada pasada, no cierra la cita para siempre.
                    const motivo = motivoNoEnviable(record);
                    if (motivo) {
                        await avisarRecordatorioBloqueado(orgId, record, motivo);
                        continue;
                    }

                    // UN solo valor para los dos caminos: el texto libre y el {{2}} de la
                    // plantilla. Resolverlo dos veces es cómo una clienta dentro de la ventana
                    // de 24 h y otra fuera acaban recibiendo mensajes distintos.
                    const cuando = await resolveCuando(orgId, record);
                    const mensaje = buildReminderMessage(record.nombre, companyName, cuando, record.language);
                    const resultado = await sendReminderMessage(orgId, record, {
                        mensaje,
                        templateParams: [record.nombre, cuando],
                    });

                    if (resultado === 'enviado') {
                        logger.info('recordatorio_enviado', { orgId, nombre: record.nombre, telefono: record.telefono, minutos_restantes: Math.round(minutosRestantes) });
                        await marcarRecordatorioConReintentos(orgId, record);
                    }
                } catch (e) {
                    logger.error('reminder_error_contacto', { orgId, contactId: record.id, error: e.message });
                }
            }

            // Poda: lo que ya no está pendiente en BD está apuntado (a mano o por un
            // reintento), así que su entrada sobra. Sin esto el Map crece con fichas muertas
            // en un proceso de vida larga.
            const idsPendientes = new Set(pendientes.map(r => r.id));
            for (const clave of enviadosSinMarcar.keys()) {
                const [org, contactId] = clave.split('|');
                if (org === orgId && !idsPendientes.has(contactId)) enviadosSinMarcar.delete(clave);
            }
        } catch (e) {
            logger.error('reminder_error_org', { orgId, error: e.message });
        }
    }
}

// Inyecta el Map de clientes. Separado de startReminderWorker para que el test pueda
// ejercitar el motor real (checkAndSendReminders) sin arrancar los timers.
function setClients(clients) {
    waClients = clients;
}

function startReminderWorker(clients) {
    setClients(clients);
    logger.info('reminder_worker_iniciado');
    setInterval(checkAndSendReminders, CHECK_INTERVAL_MS);
    setTimeout(checkAndSendReminders, 60 * 1000);
}

module.exports = {
    startReminderWorker, buildReminderMessage, checkAndSendReminders, setClients,
    // Expuestos para los tests de la puerta de calidad (tests/recordatorio-sin-nombre.test.js).
    motivoNoEnviable,
    _resetPendientesDeMarcar,
};
