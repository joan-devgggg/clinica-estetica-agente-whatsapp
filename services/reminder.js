/**
 * Reminder Worker — Multi-org
 * Cada 5 minutos: para cada org, envía recordatorios 24h antes de la cita
 * y auto-completa citas cuya hora de fin ya pasó.
 */

const { getAppointmentsPendientesRecordatorio, marcarRecordatorioSent, getConfigValue, getAgentConfig, autoCompleteAppointments } = require('./db');
const { resolveOutboundClient, resolveAutomatedSend } = require('./outbound');
const { isUsableName } = require('./helpers');
const { alertOnce } = require('./admin-alerts');
const logger = require('../lib/logger');

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
let waClients = null; // Map<orgId, { client, orgId, ... }>

// Mismo patrón que REVIEW_TEMPLATES en review.js: la clienta habla en su idioma durante
// toda la conversación (bot.js detecta ES/EN/RU/UK), así que el recordatorio no puede ser
// el único mensaje que le llega siempre en español.
const REMINDER_TEMPLATES = {
    es: (nombre, salon, hora) =>
        `Hola ${nombre || ''} 😊 Te recordamos tu cita en ${salon} a las ${hora || ''}. ¡Te esperamos!`,
    en: (nombre, salon, hora) =>
        `Hi ${nombre || ''} 😊 Just a reminder of your appointment at ${salon} at ${hora || ''}. See you soon!`,
    ru: (nombre, salon, hora) =>
        `Привет ${nombre || ''} 😊 Напоминаем о вашей записи в ${salon} в ${hora || ''}. Ждём вас!`,
    uk: (nombre, salon, hora) =>
        `Привіт ${nombre || ''} 😊 Нагадуємо про ваш запис у ${salon} о ${hora || ''}. Чекаємо на вас!`,
};

function buildReminderMessage(nombre, salon, hora, language) {
    const template = REMINDER_TEMPLATES[language] || REMINDER_TEMPLATES.es;
    return template(nombre, salon, hora);
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
function avisarRecordatorioBloqueado(orgId, record, motivo) {
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
    alertOnce(orgId, `recordatorio|${record.id}|${record.fecha_cita}|${record.hora_cita || ''}|${motivo}`, mensaje);
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
                params: templateParams, // [{{1}} nombre, {{2}} hora]
            });
            logger.info('recordatorio_por_plantilla', {
                orgId, telefono: record.telefono, plantilla: decision.template.name,
            });
        } else {
            await client.sendMessage(chatId, mensaje);
        }
        return 'enviado';
    } catch (e) {
        logger.error('reminder_error_envio', { orgId, telefono: record.telefono, chatId, error: e.message });
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
            const minutosDb = await getConfigValue(orgId, 'minutos_recordatorio');
            const horasDb   = minutosDb === null ? await getConfigValue(orgId, 'horas_recordatorio') : null;
            const minutosAntes = minutosDb !== null ? Number(minutosDb)
                               : horasDb !== null ? Number(horasDb) * 60
                               : 1440;

            const agentCfg = await getAgentConfig(orgId);
            const info = agentCfg?.business_info || {};
            const companyName = info.companyName || 'nuestro centro';
            const botName = info.botName || '';

            const pendientes = await getAppointmentsPendientesRecordatorio(orgId);

            for (const record of pendientes) {
                // Sin fecha no hay ventana que calcular, así que no hay nada que decidir ni
                // de qué avisar. El teléfono, en cambio, YA NO se descarta aquí: saltárselo en
                // silencio es precisamente cómo el contacto sin wa_phone (cita del 19/08) se
                // quedaba sin recordatorio sin que nadie se enterara. Cae en motivoNoEnviable,
                // después del filtro de ventana, para no avisar de citas que aún no tocan.
                if (!record.fecha_cita) continue;

                const minutosRestantes = minutosHastaCita(record.fecha_cita, record.hora_cita);
                if (minutosRestantes < 0 || minutosRestantes > minutosAntes) continue;

                // Si el recordatorio no puede salir BIEN, no sale: se avisa a una persona y
                // se deja PENDIENTE. Clave: no se marca `recordatorio_enviado`, así que en
                // cuanto le completen la ficha el siguiente tic lo manda solo — la puerta se
                // reevalúa en cada pasada, no cierra la cita para siempre.
                const motivo = motivoNoEnviable(record);
                if (motivo) {
                    avisarRecordatorioBloqueado(orgId, record, motivo);
                    continue;
                }

                const mensaje = buildReminderMessage(record.nombre, companyName, record.hora_cita, record.language);
                const resultado = await sendReminderMessage(orgId, record, {
                    mensaje,
                    templateParams: [record.nombre, record.hora_cita],
                });

                if (resultado === 'enviado') {
                    await marcarRecordatorioSent(orgId, record.id);
                    logger.info('recordatorio_enviado', { orgId, nombre: record.nombre, telefono: record.telefono, minutos_restantes: Math.round(minutosRestantes) });
                }
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
};
