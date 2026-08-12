/**
 * Bot de Telegram — Panel de administración multi-org
 * Mismo bot token, cada admin está vinculado a una org via config.telegram_admins.
 * Fallback: TELEGRAM_ALLOWED_USERS del .env para el org por defecto.
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { getConfigValue, setConfigValue, getAgentConfig, updateAgentConfig, getAllLeads, setBlacklist, removeBlacklist, setVip, getPendingActions, resolvePendingAction, findByPhone, setLeadBotMode } = require('./db');
const { getAllOrgs } = require('./org-registry');
const logger = require('../lib/logger');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Fallback: env-based allowed users (linked to default org)
const ENV_ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USERS || '')
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(Boolean);

const telegramSessions = new Map();
let _userToOrg = new Map(); // telegramUserId → orgId

let getBotActivoFn = () => true;
// Default deliberadamente PESIMISTA: sin cablear (server.js pasa el real en startTelegramBot),
// el toggle no aplica nada ni guarda nada, así que devolver `true` haría que el admin leyera
// "Bot pausado" sobre algo que no ha ocurrido en ningún sitio. Devolver `false` le hace leer
// que no se ha podido guardar, que es lo más cercano a la verdad que se puede decir desde aquí.
let setBotActivoFn = async (orgId) => {
    logger.error('telegram_set_bot_activo_no_cableado', { orgId });
    return false;
};
let _botInstance = null;
let _isPolling = false;

// Escapa caracteres especiales de HTML para usar con parse_mode: 'HTML'
function esc(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function buildUserToOrgMap() {
    const orgs = getAllOrgs();
    const map = new Map();

    for (const org of orgs) {
        const admins = await getConfigValue(org.orgId, 'telegram_admins');
        if (Array.isArray(admins)) {
            for (const userId of admins) {
                map.set(Number(userId), org.orgId);
            }
        }
    }

    // Fallback: env-based users → default org
    const defaultOrg = process.env.ORGANIZATION_ID || orgs[0]?.orgId;
    for (const userId of ENV_ALLOWED_USERS) {
        if (!map.has(userId)) {
            map.set(userId, defaultOrg);
        }
    }

    _userToOrg = map;
}

function resolveOrgForUser(userId) {
    return _userToOrg.get(userId) || null;
}

function isAuthorized(userId) {
    return _userToOrg.has(userId);
}

// ─── Notificaciones ─────────────────────────────────────────────────────────

function getAdminIdsForOrg(orgId) {
    const ids = [];
    for (const [userId, oid] of _userToOrg) {
        if (oid === orgId) ids.push(userId);
    }
    return ids;
}

/**
 * Manda un mensaje a los admins de una org y dice **si de verdad salió**.
 *
 * Antes disparaba `.then/.catch` y volvía sin esperar, así que quien llamaba no podía
 * distinguir "entregado" de "no hay bot arrancado" ni de "Telegram lo rechazó". Eso es lo
 * que dejaba a `alertOnce` marcando una clave como avisada sobre un mensaje que no existía:
 * el aviso se perdía y, por el throttle, ya no se reintentaba nunca.
 *
 * Entregado = al menos un admin recibió el mensaje con `message_id`. Con varios admins basta
 * uno: el aviso ya está en manos de una persona, y bloquearlo porque a otro le falle el chat
 * lo repetiría eternamente a quien sí lo recibe.
 *
 * No lanza nunca: avisar de un fallo no puede provocar otro.
 *
 * @returns {Promise<boolean>} true solo si algún envío se confirmó.
 */
async function notifyOrgAdmin(orgId, mensaje) {
    if (!_botInstance) {
        logger.warn('telegram_no_iniciado_notify', { orgId });
        return false;
    }
    const admins = getAdminIdsForOrg(orgId);
    if (!admins.length) {
        // Sin destinatario no hay aviso posible. Callarlo es como se pierde: la org existe,
        // el fallo existe, y no hay nadie a quien contárselo.
        logger.error('telegram_sin_admins', { orgId });
        return false;
    }

    const resultados = await Promise.all(admins.map(userId =>
        _botInstance.sendMessage(userId, mensaje, { parse_mode: 'HTML' })
            .then(res => {
                logger.info('telegram_notify_ok', { userId, orgId, messageId: res?.message_id });
                return true;
            })
            .catch(e => {
                logger.error('telegram_notify_error', { error: e.message, userId, orgId });
                return false;
            })
    ));

    return resultados.some(Boolean);
}

// Instancia solo-envío (sin polling) para disparar notificaciones desde scripts
// puntuales sin competir por el long-polling con el proceso principal ya activo.
async function initSendOnlyBot() {
    if (!_botInstance) {
        if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN no configurado');
        _botInstance = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
    }
    await buildUserToOrgMap();
}

async function notifyBizumPending(orgId, reserva) {
    const msg = `💰 <b>Bizum pendiente de revisar</b>\n\n` +
        `👤 ${esc(reserva.nombre || 'Sin nombre')}\n` +
        `📞 ${esc(reserva.telefono)}\n` +
        `📅 ${esc(reserva.fecha)} a las ${esc(reserva.hora)}\n` +
        `👥 ${esc(reserva.personas || '?')} personas` +
        (reserva.ocasion ? `\n🎉 ${esc(reserva.ocasion)}` : '') +
        `\n\nResponde <b>confirmar</b> o <b>rechazar</b>.`;
    notifyOrgAdmin(orgId, msg);
}

const ESCALATION_LABELS = {
    escalado_bot: 'Escalado por el bot',
    lista_negra: 'Cliente en lista negra',
    consulta_extensiones: 'Consulta: extensiones de cabello',
    consulta_permanente: 'Consulta: permanente',
    consulta_salida_negro: 'Consulta: eliminación del pigmento (salida de negro / arrastre de color)',
    queja_cita: 'Queja sobre cita anterior',
    tono_agresivo: 'Tono agresivo o frustrado',
    pedir_persona: 'Pide hablar con una persona',
    pregunta_sin_respuesta: 'Pregunta que el bot no puede responder',
    limite_mensajes: 'Conversación muy larga: límite de mensajes alcanzado',
};

async function notifyEscalation(orgId, contacto, mensaje, reason) {
    const motivoLabel = ESCALATION_LABELS[reason] || reason || 'Requiere atención humana';
    const hora = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
    const msg = `⚠️ <b>ATENCIÓN REQUERIDA — Santé</b>\n\n` +
        `👤 Cliente: ${esc(contacto?.nombre || 'Sin nombre')}\n` +
        `📱 Teléfono: ${esc(contacto?.telefono || 'Sin teléfono')}\n` +
        `💬 Motivo: ${esc(motivoLabel)}\n` +
        `🕐 Hora: ${esc(hora)}\n\n` +
        (mensaje ? `📝 Último mensaje: "${esc(mensaje.slice(0, 200))}"\n\n` : '') +
        `👉 Entra al panel para responderle`;
    notifyOrgAdmin(orgId, msg);
}

async function notifyVipSuggestion(orgId, contacto) {
    const msg = `⭐ <b>Sugerencia VIP</b>\n\n` +
        `${esc(contacto.nombre || 'Este cliente')} (${esc(contacto.telefono)}) ha venido ya ${esc(contacto.visit_count)} veces.\n` +
        `¿Lo añadimos a la lista VIP? Responde <b>si</b> o <b>no</b>.`;
    notifyOrgAdmin(orgId, msg);
}

// DESBLOQUEAR DESDE AQUÍ CUESTA DOS TOQUES, Y NO ES BUROCRACIA.
//
// Hasta el 10/08/2026 este aviso traía un botón «✅ Sí, continuar» que, de un solo toque y sin
// confirmar nada, quitaba la lista negra Y le mandaba un WhatsApp («Hola 😊 Hemos revisado tu
// caso. ¿En qué puedo ayudarte?»). Ese mensaje llega a un móvil, entre notificaciones, y se
// pulsa sin querer. Con un no-show da igual; con alguien que está amenazando a la dueña, un
// dedo torcido le reabre la puerta y encima le invita a seguir.
//
// `bl_ok` ya NO ejecuta: PREGUNTA. Y es a propósito que conserve ese nombre — los avisos ya
// enviados siguen teniendo botones con `bl_ok` dentro, y así un toque en un mensaje viejo cae
// también en la confirmación en vez de desbloquear a la primera. Quien ejecuta es `bl_do`,
// que solo existe en el teclado que aparece DESPUÉS de preguntar.
//
// DICE SI DE VERDAD SALIÓ, y por eso se espera. Hasta el 12/08/2026 disparaba sin esperar y
// bot.js marcaba `blacklistNotified = true` ANTES de llamarla: la inversión exacta de la regla
// de `alertOnce`, que marca la clave DESPUÉS de que Telegram confirme. Con el bot caído, la
// org sin admins o un chat cerrado, el aviso se perdía para siempre — y no lo rescataba
// `rearmarSiLaFichaNoLoRefleja`, porque su desempate es `bot_mode !== 'manual'` y en ese camino
// el `setLeadBotMode` sí había funcionado: la ficha reflejaba el bloqueo perfectamente y lo
// único que faltaba era el empujón que hace que alguien lo MIRE.
//
// Entregado = al menos un admin lo recibió, mismo criterio que `notifyOrgAdmin`. No lanza
// nunca: avisar de un fallo no puede provocar otro.
//
// @returns {Promise<boolean>} true solo si algún envío se confirmó.
async function notifyBlacklistAlert(orgId, contacto) {
    if (!_botInstance) { logger.warn('telegram_no_iniciado_notify', { orgId }); return false; }
    const msg = `🚫 <b>Cliente en lista negra</b>\n\n` +
        `${esc(contacto.nombre || 'Cliente')} (${esc(contacto.telefono)}) está en la lista negra.\n` +
        `Motivo: ${esc(contacto.blacklist_reason || 'sin motivo')}\n\n` +
        `¿Qué hacemos?`;
    const phoneKey = String(contacto.telefono).replace(/\D/g, '');
    const admins = getAdminIdsForOrg(orgId);
    if (!admins.length) {
        // Sin destinatario no hay aviso posible, y callarlo es como se pierde.
        logger.error('telegram_sin_admins', { orgId });
        return false;
    }
    const resultados = await Promise.all(admins.map(userId =>
        _botInstance.sendMessage(userId, msg, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Desbloquear…',     callback_data: `bl_ok|${orgId}|${phoneKey}` },
                    { text: '🚫 Mantener bloqueado', callback_data: `bl_no|${orgId}|${phoneKey}` },
                ]]
            }
        })
            .then(res => {
                logger.info('telegram_notify_ok', { userId, orgId, messageId: res?.message_id });
                return true;
            })
            .catch(e => {
                logger.error('telegram_notify_error', { error: e.message, userId, orgId });
                return false;
            })
    ));
    return resultados.some(Boolean);
}

/**
 * Desbloquear: quita la marca y devuelve la conversación a 'auto'. **NO le escribe.**
 *
 * Hasta el 10/08/2026 esto mandaba además un «Hola 😊 Hemos revisado tu caso. ¿En qué puedo
 * ayudarte?». Dos motivos para separarlo, y el segundo se descubrió al arreglar el primero:
 *
 *  1. Desbloquear y escribir son dos decisiones. Juntas, un toque de más invita a seguir a
 *     quien acabas de bloquear; separadas, lo peor que pasa es que alguien vuelva a entrar en
 *     la cola normal. Para escribirle está el Monitor, que es donde se escribe a la gente.
 *  2. **Ese mensaje no se enviaba.** `sendDirectMessage` no está definido ni importado en este
 *     fichero: la llamada lanzaba `ReferenceError`, lo recogía el catch de la rama, y el admin
 *     leía «❌ Error al reactivar el cliente» sobre un contacto que SÍ había quedado
 *     desbloqueado (las dos escrituras van antes). O sea que el aviso mentía en la dirección
 *     peligrosa: te hace creer que el bloqueo aguanta. Quitar la línea no cambia nada de lo
 *     que le llega a nadie —hoy no le llega—; lo que cambia es que el parte diga la verdad.
 *
 * El orden importa y es el mismo que usa la ficha del panel: primero 'auto' (que además limpia
 * `escalation_reason`) y después la marca. Si falla el segundo paso, el contacto sigue
 * BLOQUEADO, que es el lado recuperable. Al revés, un fallo dejaría un "desbloqueado" mudo
 * para siempre, porque `auto-return` no devuelve a 'auto' nada con una escalada abierta.
 */
async function ejecutarDesbloqueo(orgId, phone) {
    const contact = await findByPhone(orgId, phone);
    if (!contact) return { ok: false, motivo: 'no_encontrado' };
    await setLeadBotMode(orgId, phone, 'auto');
    await removeBlacklist(orgId, contact.id);
    logger.info('blacklist_desbloqueo_ok', { orgId, telefono: phone, contactId: contact.id });
    return { ok: true, nombre: contact.nombre || null };
}

// ─── Resolución de pending_actions ──────────────────────────────────────────

function formatPendingBizum(pa, i) {
    const c = pa.contacts || {};
    const a = pa.appointments || {};
    const p = pa.payload || {};
    const fecha = p.fecha || (a.starts_at ? a.starts_at.split('T')[0] : '');
    const hora = p.hora || (a.starts_at ? a.starts_at.split('T')[1]?.slice(0, 5) : '');
    return `${i + 1}. ${c.full_name || p.nombre || 'Sin nombre'} — ${fecha} ${hora} — ${p.personas || a.party_size || '?'}p`;
}

function formatPendingVip(pa, i) {
    const c = pa.contacts || {};
    const p = pa.payload || {};
    return `${i + 1}. ${c.full_name || p.nombre || 'Sin nombre'} (${c.wa_phone || p.telefono || ''})`;
}

async function resolveBizumAction(orgId, pendingAction, confirmed, bot, chatId) {
    const { resolveBizumResult } = require('../bot');
    await resolveBizumResult(pendingAction, confirmed, { actor: `telegram:${chatId}` });
    await resolvePendingAction(orgId, pendingAction.id, confirmed ? 'confirmado' : 'rechazado');
    const nombre = pendingAction.contacts?.full_name || pendingAction.payload?.nombre || 'el cliente';
    bot.sendMessage(chatId, confirmed
        ? `✅ Reserva de <b>${esc(nombre)}</b> confirmada. Se le ha avisado por WhatsApp.`
        : `❌ Bizum de <b>${esc(nombre)}</b> rechazado. Reserva cancelada y cliente añadido a la lista negra.`,
        { parse_mode: 'HTML' });
}

async function resolveVipAction(orgId, pendingAction, accept, bot, chatId) {
    const nombre = pendingAction.contacts?.full_name || pendingAction.payload?.nombre || 'el cliente';
    if (accept && pendingAction.contact_id) {
        await setVip(orgId, pendingAction.contact_id, true);
    }
    await resolvePendingAction(orgId, pendingAction.id, accept ? 'aceptado' : 'rechazado');
    bot.sendMessage(chatId, accept
        ? `⭐ <b>${esc(nombre)}</b> añadido a la lista VIP.`
        : `Vale, <b>${esc(nombre)}</b> no se añade a la lista VIP.`,
        { parse_mode: 'HTML' });
}

/**
 * `tryResolvePendingReply` con red debajo, y es la que se llama.
 *
 * Todo lo de dentro puede lanzar: `getPendingActions` desde el 12/08/2026, y `resolvePendingAction`
 * y `setVip` porque verifican lo que escriben. Cuelga de `bot.on('message')`, que no tiene
 * try/catch, así que cualquiera de esos throws sale como rechazo sin manejar y tumba el
 * proceso — el bot de las DOS orgs.
 *
 * Devuelve `true` (mensaje consumido) y no `false`: dejarlo caer al intérprete del LLM con un
 * «sí» suelto lo leería fuera de contexto y podría ejecutar una acción de configuración. Y el
 * texto dice que NO se hizo nada, que es lo contrario de lo que decía el fallo: con la lectura
 * caída se contestaba como si no hubiera nada pendiente.
 */
async function tryResolvePendingReply(orgId, bot, chatId, userId, texto) {
    try {
        return await tryResolvePendingReplyInterno(orgId, bot, chatId, userId, texto);
    } catch (e) {
        logger.error('telegram_pendientes_error', { orgId, error: e.message });
        bot.sendMessage(chatId,
            '⚠️ No he podido completar eso ahora mismo, así que <b>no he tocado nada</b>. '
            + 'Vuelve a intentarlo en un momento.', { parse_mode: 'HTML' });
        return true;
    }
}

async function tryResolvePendingReplyInterno(orgId, bot, chatId, userId, texto) {
    const t = texto.toLowerCase().trim();
    const session = telegramSessions.get(userId);

    if (session?.pendingSelection) {
        const idx = parseInt(t, 10) - 1;
        const { type, items, confirmed } = session.pendingSelection;
        if (isNaN(idx) || idx < 0 || idx >= items.length) {
            bot.sendMessage(chatId, 'Responde con el número (ej: "1").');
            return true;
        }
        telegramSessions.delete(userId);
        if (type === 'bizum_review') await resolveBizumAction(orgId, items[idx], confirmed, bot, chatId);
        else await resolveVipAction(orgId, items[idx], confirmed, bot, chatId);
        return true;
    }

    const esConfirmar = ['confirmar', 'confirmo', 'confirma', 'si', 'sí', 'ok', 'vale'].includes(t);
    const esRechazar = ['rechazar', 'rechazo', 'rechaza', 'no'].includes(t);
    if (!esConfirmar && !esRechazar) return false;

    // Las dos LANZAN si la lectura falla. Lo que no se puede decir es «no hay nada pendiente»,
    // que es justo lo que no se ha podido comprobar; de eso se encarga el envoltorio de arriba.
    const bizums = await getPendingActions(orgId, 'bizum_review');
    const vips = await getPendingActions(orgId, 'vip_suggestion');

    if (bizums.length > 0) {
        if (bizums.length === 1) {
            await resolveBizumAction(orgId, bizums[0], esConfirmar, bot, chatId);
            return true;
        }
        telegramSessions.set(userId, { pendingSelection: { type: 'bizum_review', items: bizums, confirmed: esConfirmar } });
        bot.sendMessage(chatId, `Hay varios Bizums pendientes, ¿cuál ${esConfirmar ? 'confirmas' : 'rechazas'}?\n\n` +
            bizums.map(formatPendingBizum).join('\n') + '\n\nResponde con el número.');
        return true;
    }

    if (vips.length > 0) {
        if (vips.length === 1) {
            await resolveVipAction(orgId, vips[0], esConfirmar, bot, chatId);
            return true;
        }
        telegramSessions.set(userId, { pendingSelection: { type: 'vip_suggestion', items: vips, confirmed: esConfirmar } });
        bot.sendMessage(chatId, `Hay varias sugerencias VIP, ¿a cuál respondes?\n\n` +
            vips.map(formatPendingVip).join('\n') + '\n\nResponde con el número.');
        return true;
    }

    return false;
}

// ─── LLM — interpretar comandos del admin ───────────────────────────────────

async function interpretarComando(orgId, mensaje, contextoActual) {
    if (!OPENAI_KEY) return null;

    const agentCfg = await getAgentConfig(orgId);
    const info = agentCfg?.business_info || {};
    const companyName = info.companyName || 'el negocio';
    const orgType = info.equipo ? 'salón de belleza' : 'restaurante';

    const systemPrompt = `Eres el sistema de administración del bot de WhatsApp de ${companyName} (${orgType}).
El administrador te manda mensajes en lenguaje natural para gestionar la configuración.

CONFIGURACIÓN ACTUAL:
${contextoActual.faqs ? `- Horarios (FAQ): ${contextoActual.faqs.horarios || 'sin definir'}
- Carta/Servicios (FAQ): ${contextoActual.faqs.carta || 'sin definir'}
- Parking (FAQ): ${contextoActual.faqs.parking || 'sin definir'}
- Alérgenos (FAQ): ${contextoActual.faqs.alergias || 'sin definir'}` : ''}
${contextoActual.bizum ? `- Bizum: número ${contextoActual.bizum.numero || '?'}, importe ${contextoActual.bizum.importe || '?'}€` : ''}
- Bot de WhatsApp: ${getBotActivoFn() ? 'ACTIVO' : 'PAUSADO'}

ACCIONES POSIBLES (responde en JSON):
{
  "accion": "set_faq" | "set_bizum" | "set_vip_umbral" |
             "add_blacklist" | "remove_blacklist" | "list_blacklist" |
             "add_vip" | "remove_vip" | "list_vip" |
             "get_config" | "pause_bot" | "resume_bot" | "unknown",
  "datos": { ... },
  "respuesta": "mensaje confirmando lo que vas a hacer",
  "requiere_confirmacion": true | false
}

Si no entiendes el mensaje → accion: "unknown" con una respuesta pidiendo más detalle.`;

    try {
        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: mensaje }
            ],
            temperature: 0.2,
            max_tokens: 300,
            response_format: { type: 'json_object' }
        }, {
            headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' }
        });

        return JSON.parse(res.data.choices[0].message.content);
    } catch (e) {
        logger.error('telegram_llm_error', { error: e.message });
        return null;
    }
}

// ─── Ejecutar acciones ──────────────────────────────────────────────────────

async function buscarContacto(orgId, nombreOTelefono) {
    if (!nombreOTelefono) return null;
    const resultados = await getAllLeads(orgId, { search: nombreOTelefono, limit: 5 });
    return resultados[0] || null;
}

async function ejecutarAccion(orgId, accion, datos, bot, chatId) {
    switch (accion) {
        case 'set_faq': {
            const campo = datos.campo;
            if (!['horarios', 'carta', 'parking', 'alergias'].includes(campo)) {
                return '❌ No reconozco esa sección de FAQ.';
            }
            const agentCfg = await getAgentConfig(orgId);
            const businessInfo = { ...(agentCfg?.business_info || {}) };
            businessInfo.faqs = { ...(businessInfo.faqs || {}), [campo]: datos.valor };
            await updateAgentConfig(orgId, { business_info: businessInfo });
            return `✅ FAQ actualizada: <b>${esc(campo)}</b> → ${esc(datos.valor)}`;
        }

        case 'set_bizum': {
            const agentCfg = await getAgentConfig(orgId);
            const businessInfo = { ...(agentCfg?.business_info || {}) };
            businessInfo.bizum = { ...(businessInfo.bizum || {}) };
            if (datos.numero) businessInfo.bizum.numero = String(datos.numero);
            if (datos.importe !== undefined && datos.importe !== null) businessInfo.bizum.importe = Number(datos.importe);
            await updateAgentConfig(orgId, { business_info: businessInfo });
            return `✅ Datos de Bizum actualizados: ${esc(businessInfo.bizum.importe)}€ al ${esc(businessInfo.bizum.numero)}`;
        }

        case 'set_vip_umbral': {
            const umbral = parseInt(datos.umbral, 10);
            if (!umbral || umbral < 1) return '❌ El umbral debe ser un número mayor que 0.';
            const agentCfg = await getAgentConfig(orgId);
            const businessInfo = { ...(agentCfg?.business_info || {}) };
            businessInfo.vip = { ...(businessInfo.vip || {}), visitasParaSugerir: umbral };
            await updateAgentConfig(orgId, { business_info: businessInfo });
            return `✅ Ahora se sugerirá VIP a partir de <b>${esc(umbral)}</b> visitas.`;
        }

        case 'add_blacklist': {
            const contacto = await buscarContacto(orgId, datos.nombre || datos.telefono);
            if (!contacto) return `❌ No encontré a "${esc(datos.nombre || datos.telefono)}" en los clientes.`;
            await setBlacklist(orgId, contacto.id, datos.motivo || 'Añadido manualmente desde Telegram');
            return `🚫 <b>${esc(contacto.nombre || contacto.telefono)}</b> añadido a la lista negra.`;
        }

        case 'remove_blacklist': {
            const contacto = await buscarContacto(orgId, datos.nombre || datos.telefono);
            if (!contacto) return `❌ No encontré a "${esc(datos.nombre || datos.telefono)}" en los clientes.`;
            await removeBlacklist(orgId, contacto.id);
            return `✅ <b>${esc(contacto.nombre || contacto.telefono)}</b> eliminado de la lista negra.`;
        }

        case 'add_vip': {
            const contacto = await buscarContacto(orgId, datos.nombre || datos.telefono);
            if (!contacto) return `❌ No encontré a "${esc(datos.nombre || datos.telefono)}" en los clientes.`;
            await setVip(orgId, contacto.id, true);
            return `⭐ <b>${esc(contacto.nombre || contacto.telefono)}</b> añadido a la lista VIP.`;
        }

        case 'remove_vip': {
            const contacto = await buscarContacto(orgId, datos.nombre || datos.telefono);
            if (!contacto) return `❌ No encontré a "${esc(datos.nombre || datos.telefono)}" en los clientes.`;
            await setVip(orgId, contacto.id, false);
            return `✅ <b>${esc(contacto.nombre || contacto.telefono)}</b> eliminado de la lista VIP.`;
        }

        case 'list_blacklist': {
            const { getBlacklist } = require('./db');
            const lista = await getBlacklist(orgId);
            if (!lista.length) return 'La lista negra está vacía.';
            return `🚫 <b>Lista negra:</b>\n` + lista.map(c => `• ${esc(c.nombre || c.telefono)} — ${esc(c.blacklist_reason || 'sin motivo')}`).join('\n');
        }

        case 'list_vip': {
            const { getVipList } = require('./db');
            const lista = await getVipList(orgId);
            if (!lista.length) return 'No hay clientes VIP todavía.';
            return `⭐ <b>Lista VIP:</b>\n` + lista.map(c => `• ${esc(c.nombre || c.telefono)} (${esc(c.visit_count)} visitas)`).join('\n');
        }

        case 'get_config': {
            const agentCfg = await getAgentConfig(orgId);
            const info = agentCfg?.business_info || {};
            return `⚙️ <b>Configuración actual:</b>\n` +
                `• Bot WhatsApp: ${getBotActivoFn(orgId) ? '🟢 Activo' : '🔴 Pausado'}\n` +
                (info.bizum ? `• Bizum: ${esc(info.bizum.importe ?? '?')}€ al ${esc(info.bizum.numero ?? '?')}\n` : '') +
                `• Umbral VIP: ${esc(info.vip?.visitasParaSugerir ?? '?')} visitas`;
        }

        // Pausar y reactivar se ESPERAN, y la respuesta depende de si quedó guardado.
        //
        // Antes se llamaba sin `await` y se contestaba "Bot pausado" pasara lo que pasara.
        // `setBotActivo` aplica el estado en memoria siempre —el bot se calla al momento—,
        // pero si el `upsert` en `config` falla, `server.js` recarga `bot_activo` al arrancar
        // y **el primer reinicio revive el bot que el admin acababa de pausar**, con sus
        // clientas recibiendo respuestas automáticas otra vez. Decirle "pausado" a secas es
        // exactamente la clase de mentira que el resto del sistema ya no comete.
        //
        // `setBotActivo` resuelve a booleano y no rechaza nunca, así que este `await` no
        // necesita try/catch: el fallo llega como `false`, no como excepción.
        case 'pause_bot': {
            const guardado = await setBotActivoFn(orgId, false); // pausa SOLO la org de este admin
            if (!guardado) {
                return '⏸️ He pausado el bot, pero <b>no he podido guardarlo</b>.\n\n'
                     + 'Ahora mismo está pausado y no contesta a nadie. Pero si el sistema se '
                     + 'reinicia volverá a contestar solo, así que vuelve a pausarlo dentro de '
                     + 'un rato para comprobar que esta vez se guarda.';
            }
            return '⏸️ Bot de WhatsApp <b>pausado</b> para tu negocio.';
        }

        case 'resume_bot': {
            const guardado = await setBotActivoFn(orgId, true);
            if (!guardado) {
                return '▶️ He reactivado el bot, pero <b>no he podido guardarlo</b>.\n\n'
                     + 'Ahora mismo ya contesta. Pero si el sistema se reinicia volvería a '
                     + 'quedarse pausado, así que vuelve a reactivarlo dentro de un rato para '
                     + 'comprobar que esta vez se guarda.';
            }
            return '▶️ Bot de WhatsApp <b>reactivado</b> para tu negocio.';
        }

        default:
            return null;
    }
}

/**
 * `ejecutarAccion` con red debajo. Es la que llama el handler, y no es opcional.
 *
 * `bot.on('message')` NO tiene try/catch, así que cualquier cosa que lance aquí dentro sale
 * como rechazo sin manejar y en Node moderno eso tumba el proceso: el bot de las DOS orgs, por
 * un comando de admin. Y lanzar es lo NORMAL en esta capa desde julio —`setBlacklist`,
 * `setVip` y `setConfigValue` verifican filas afectadas y lanzan si no tocaron ninguna, y
 * `getBlacklist` lanza desde el 12/08/2026—, o sea que el agujero ya estaba abierto: un
 * bloqueo fallido desde Telegram se llevaba el proceso por delante.
 *
 * El mensaje dice que NO se hizo, y esa es la mitad importante. Lo que no puede pasar es lo
 * que pasaba con `list_blacklist`: un error de lectura contestando «La lista negra está
 * vacía», que es exactamente la afirmación contraria a la verdad.
 */
async function ejecutarAccionSegura(orgId, accion, datos, bot, chatId) {
    try {
        return await ejecutarAccion(orgId, accion, datos, bot, chatId);
    } catch (e) {
        logger.error('telegram_accion_error', { orgId, accion, error: e.message });
        return '⚠️ No he podido completar esa acción, así que <b>no he tocado nada</b>. '
             + 'Vuelve a intentarlo en un momento.';
    }
}

// ─── Inicialización ─────────────────────────────────────────────────────────

function startTelegramBot(options = {}) {
    if (!TELEGRAM_TOKEN) {
        logger.warn('telegram_token_no_configurado');
        return;
    }

    if (_isPolling) {
        logger.warn('telegram_polling_ya_activo');
        return;
    }

    if (options.getBotActivo) getBotActivoFn = options.getBotActivo;
    if (options.setBotActivo) setBotActivoFn = options.setBotActivo;

    // Parar instancia anterior si existe (PM2 restart, crash recovery)
    if (_botInstance) {
        try { _botInstance.stopPolling(); } catch (_) {}
        _botInstance = null;
    }

    _isPolling = true;
    const bot = new TelegramBot(TELEGRAM_TOKEN, {
        polling: { params: { timeout: 30 } },
    });
    _botInstance = bot;

    // Build user→org map at startup
    buildUserToOrgMap().then(() => {
        logger.info('telegram_iniciado', { admins: _userToOrg.size });
    });

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const texto = msg.text || '';

        // Refresh map periodically (in case admins change in config)
        if (Math.random() < 0.05) buildUserToOrgMap().catch(() => {});

        if (!isAuthorized(userId)) {
            bot.sendMessage(chatId, '⛔ No tienes acceso a este panel de administración.');
            return;
        }

        const orgId = resolveOrgForUser(userId);
        if (!orgId) {
            bot.sendMessage(chatId, '⛔ Tu usuario no está vinculado a ninguna organización.');
            return;
        }

        // Confirmaciones de acciones destructivas pendientes
        const session = telegramSessions.get(userId);
        if (session?.pendingAction) {
            if (['si', 'sí', 'confirmo', 'ok', 'vale'].includes(texto.toLowerCase().trim())) {
                const resultado = await ejecutarAccionSegura(orgId, session.pendingAction.accion, session.pendingAction.datos, bot, chatId);
                telegramSessions.delete(userId);
                bot.sendMessage(chatId, resultado || '✅ Hecho.', { parse_mode: 'HTML' });
            } else {
                telegramSessions.delete(userId);
                bot.sendMessage(chatId, '❌ Cancelado.');
            }
            return;
        }

        // Resolución de pending_actions
        if (await tryResolvePendingReply(orgId, bot, chatId, userId, texto)) return;

        // Cargar contexto actual de la org
        const agentCfg = await getAgentConfig(orgId);
        const info = agentCfg?.business_info || {};
        const contextoActual = {
            faqs: info.faqs || {},
            bizum: info.bizum || null,
            vip: info.vip || {},
        };

        const interpretacion = await interpretarComando(orgId, texto, contextoActual);

        if (!interpretacion || interpretacion.accion === 'unknown') {
            bot.sendMessage(chatId, interpretacion?.respuesta ||
                'No entendí bien. Puedes decirme cosas como:\n• "ver configuración"\n• "añade a X a la lista negra"\n• "para el bot"');
            return;
        }

        if (interpretacion.requiere_confirmacion) {
            telegramSessions.set(userId, { pendingAction: interpretacion });
            bot.sendMessage(chatId, `${interpretacion.respuesta}\n\n¿Confirmas? (sí / no)`, { parse_mode: 'HTML' });
            return;
        }

        const resultado = await ejecutarAccionSegura(orgId, interpretacion.accion, interpretacion.datos || {}, bot, chatId);
        bot.sendMessage(chatId, resultado || interpretacion.respuesta, { parse_mode: 'HTML' });
    });

    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const userId = query.from.id;
        const data = query.data || '';
        bot.answerCallbackQuery(query.id).catch(() => {});

        if (!/^bl_(ok|do|no)\|/.test(data)) return;
        if (!isAuthorized(userId)) return;

        const [action, orgId, phone] = data.split('|');

        // PRIMER TOQUE: pregunta y cambia el teclado. No escribe nada en ningún sitio.
        // El teclado NO se vacía aquí (por eso el return): si se vaciara, la confirmación se
        // quedaría sin botones y no habría forma de terminar lo que se acaba de empezar.
        if (action === 'bl_ok') {
            bot.editMessageReplyMarkup({
                inline_keyboard: [[
                    { text: '⚠️ Sí, desbloquear', callback_data: `bl_do|${orgId}|${phone}` },
                    { text: '← Cancelar',         callback_data: `bl_no|${orgId}|${phone}` },
                ]]
            }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
            bot.sendMessage(chatId,
                `⚠️ <b>Confirma el desbloqueo de ${esc(phone)}</b>\n\n` +
                `El bot volverá a atenderle con normalidad y volverá a entrar en campañas, ` +
                `recordatorios y peticiones de reseña.\n\n` +
                `<b>No se le envía ningún mensaje.</b> Si quieres escribirle, hazlo desde el ` +
                `Monitor de WhatsApp.`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
            return;
        }

        if (action === 'bl_do') {
            try {
                const r = await ejecutarDesbloqueo(orgId, phone);
                bot.sendMessage(chatId, r.ok
                    ? `✅ ${esc(r.nombre || phone)} desbloqueado. El bot vuelve a atenderle. No se le ha enviado ningún mensaje.`
                    : '⚠️ No se ha encontrado ese contacto: no se ha tocado nada.');
            } catch (e) {
                logger.error('blacklist_reactivate_error', { orgId, phone, error: e.message });
                // El orden de ejecutarDesbloqueo hace que un fallo deje el bloqueo EN PIE, y eso
                // es lo que se dice: lo contrario —"error" sobre un contacto ya desbloqueado—
                // es justo lo que hacía esta rama hasta el 10/08/2026.
                bot.sendMessage(chatId, '❌ No se ha podido desbloquear. Sigue bloqueado; vuelve a intentarlo.');
            }
        } else {
            bot.sendMessage(chatId, '🚫 Se mantiene en la lista negra.');
        }
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
            chat_id: chatId, message_id: query.message.message_id,
        }).catch(() => {});
    });

    bot.on('polling_error', (e) => {
        const msg = e.message || '';
        if (msg.includes('409') || msg.includes('Conflict')) {
            logger.error('telegram_409_conflict', { error: msg });
            bot.stopPolling().then(() => {
                _isPolling = false;
                _botInstance = null;
                logger.info('telegram_polling_detenido_por_409');
            }).catch(() => { _isPolling = false; _botInstance = null; });
        } else {
            logger.error('telegram_polling_error', { error: msg });
        }
    });
}

module.exports = {
    startTelegramBot, notifyBizumPending, notifyEscalation, notifyVipSuggestion,
    notifyBlacklistAlert, notifyOrgAdmin, initSendOnlyBot,
    // Expuesto para tests: el handler de acciones del admin, sin polling ni red. Lo usa
    // tests/config-escritura-verificada.test.js para afirmar que pause_bot/resume_bot no
    // anuncian un guardado que no ocurrió.
    _ejecutarAccion: ejecutarAccionSegura,
    // Expuesto para tests: el desbloqueo real, sin polling ni Telegram. Lo usa
    // tests/blacklist-no-promete.test.js para afirmar el orden de las dos escrituras y que
    // NO se le manda ningún mensaje al contacto.
    _ejecutarDesbloqueo: ejecutarDesbloqueo,
    // Expuesto para tests: la resolución de pendientes por texto, sin polling ni red. Lo usa
    // tests/lectura-citas-y-pendientes.test.js para afirmar que una lectura caída de
    // pending_actions NO sale de aquí como rechazo sin manejar — el `bot.on('message')` que
    // la llama no tiene try/catch, así que saldría del proceso entero.
    _tryResolvePendingReply: tryResolvePendingReply,
};
