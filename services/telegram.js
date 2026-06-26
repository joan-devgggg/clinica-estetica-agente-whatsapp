/**
 * Bot de Telegram — Panel de administración multi-org
 * Mismo bot token, cada admin está vinculado a una org via config.telegram_admins.
 * Fallback: TELEGRAM_ALLOWED_USERS del .env para el org por defecto.
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { getConfigValue, setConfigValue, getAgentConfig, updateAgentConfig, getAllLeads, setBlacklist, removeBlacklist, setVip, getPendingActions, resolvePendingAction } = require('./db');
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
let setBotActivoFn = () => {};
let _botInstance = null;
let _isPolling = false;

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

function notifyOrgAdmin(orgId, mensaje) {
    if (!_botInstance) {
        logger.warn('telegram_no_iniciado_notify');
        return;
    }
    const admins = getAdminIdsForOrg(orgId);
    for (const userId of admins) {
        _botInstance.sendMessage(userId, mensaje, { parse_mode: 'Markdown' })
            .catch(e => logger.error('telegram_notify_error', { error: e.message, userId, orgId }));
    }
}

async function notifyBizumPending(orgId, reserva) {
    const msg = `💰 *Bizum pendiente de revisar*\n\n` +
        `👤 ${reserva.nombre || 'Sin nombre'}\n` +
        `📞 ${reserva.telefono}\n` +
        `📅 ${reserva.fecha} a las ${reserva.hora}\n` +
        `👥 ${reserva.personas || '?'} personas` +
        (reserva.ocasion ? `\n🎉 ${reserva.ocasion}` : '') +
        `\n\nResponde *confirmar* o *rechazar*.`;
    notifyOrgAdmin(orgId, msg);
}

const ESCALATION_LABELS = {
    escalado_bot: 'Escalado por el bot',
    lista_negra: 'Cliente en lista negra',
    consulta_extensiones: 'Consulta: extensiones de cabello',
    consulta_permanente: 'Consulta: permanente',
    consulta_salida_negro: 'Consulta: salida de negro / arrastre de color',
    queja_cita: 'Queja sobre cita anterior',
    tono_agresivo: 'Tono agresivo o frustrado',
    pedir_persona: 'Pide hablar con una persona',
    pregunta_sin_respuesta: 'Pregunta que el bot no puede responder',
};

async function notifyEscalation(orgId, contacto, mensaje, reason) {
    const motivoLabel = ESCALATION_LABELS[reason] || reason || 'Requiere atención humana';
    const hora = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
    const msg = `⚠️ *ATENCIÓN REQUERIDA — Santé*\n\n` +
        `👤 Cliente: ${contacto?.nombre || 'Sin nombre'}\n` +
        `📱 Teléfono: ${contacto?.telefono || 'Sin teléfono'}\n` +
        `💬 Motivo: ${motivoLabel}\n` +
        `🕐 Hora: ${hora}\n\n` +
        (mensaje ? `📝 Último mensaje: "${mensaje.slice(0, 200)}"\n\n` : '') +
        `👉 Entra al panel para responderle`;
    notifyOrgAdmin(orgId, msg);
}

async function notifyVipSuggestion(orgId, contacto) {
    const msg = `⭐ *Sugerencia VIP*\n\n` +
        `${contacto.nombre || 'Este cliente'} (${contacto.telefono}) ha venido ya ${contacto.visit_count} veces.\n` +
        `¿Lo añadimos a la lista VIP? Responde *si* o *no*.`;
    notifyOrgAdmin(orgId, msg);
}

async function notifyBlacklistAlert(orgId, contacto) {
    const msg = `🚫 *Cliente en lista negra*\n\n` +
        `${contacto.nombre || 'Cliente'} (${contacto.telefono}) está en la lista negra.\n` +
        `Motivo: ${contacto.blacklist_reason || 'sin motivo'}\n\n` +
        `Ha escrito por WhatsApp. ¿Quieres que el bot continúe? Responde desde el panel.`;
    notifyOrgAdmin(orgId, msg);
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
    await resolveBizumResult(pendingAction, confirmed);
    await resolvePendingAction(orgId, pendingAction.id, confirmed ? 'confirmado' : 'rechazado');
    const nombre = pendingAction.contacts?.full_name || pendingAction.payload?.nombre || 'el cliente';
    bot.sendMessage(chatId, confirmed
        ? `✅ Reserva de *${nombre}* confirmada. Se le ha avisado por WhatsApp.`
        : `❌ Bizum de *${nombre}* rechazado. Reserva cancelada y cliente añadido a la lista negra.`,
        { parse_mode: 'Markdown' });
}

async function resolveVipAction(orgId, pendingAction, accept, bot, chatId) {
    const nombre = pendingAction.contacts?.full_name || pendingAction.payload?.nombre || 'el cliente';
    if (accept && pendingAction.contact_id) {
        await setVip(orgId, pendingAction.contact_id, true);
    }
    await resolvePendingAction(orgId, pendingAction.id, accept ? 'aceptado' : 'rechazado');
    bot.sendMessage(chatId, accept
        ? `⭐ *${nombre}* añadido a la lista VIP.`
        : `Vale, *${nombre}* no se añade a la lista VIP.`,
        { parse_mode: 'Markdown' });
}

async function tryResolvePendingReply(orgId, bot, chatId, userId, texto) {
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
            return `✅ FAQ actualizada: *${campo}* → ${datos.valor}`;
        }

        case 'set_bizum': {
            const agentCfg = await getAgentConfig(orgId);
            const businessInfo = { ...(agentCfg?.business_info || {}) };
            businessInfo.bizum = { ...(businessInfo.bizum || {}) };
            if (datos.numero) businessInfo.bizum.numero = String(datos.numero);
            if (datos.importe !== undefined && datos.importe !== null) businessInfo.bizum.importe = Number(datos.importe);
            await updateAgentConfig(orgId, { business_info: businessInfo });
            return `✅ Datos de Bizum actualizados: ${businessInfo.bizum.importe}€ al ${businessInfo.bizum.numero}`;
        }

        case 'set_vip_umbral': {
            const umbral = parseInt(datos.umbral, 10);
            if (!umbral || umbral < 1) return '❌ El umbral debe ser un número mayor que 0.';
            const agentCfg = await getAgentConfig(orgId);
            const businessInfo = { ...(agentCfg?.business_info || {}) };
            businessInfo.vip = { ...(businessInfo.vip || {}), visitasParaSugerir: umbral };
            await updateAgentConfig(orgId, { business_info: businessInfo });
            return `✅ Ahora se sugerirá VIP a partir de *${umbral}* visitas.`;
        }

        case 'add_blacklist': {
            const contacto = await buscarContacto(orgId, datos.nombre || datos.telefono);
            if (!contacto) return `❌ No encontré a "${datos.nombre || datos.telefono}" en los clientes.`;
            await setBlacklist(orgId, contacto.id, datos.motivo || 'Añadido manualmente desde Telegram');
            return `🚫 *${contacto.nombre || contacto.telefono}* añadido a la lista negra.`;
        }

        case 'remove_blacklist': {
            const contacto = await buscarContacto(orgId, datos.nombre || datos.telefono);
            if (!contacto) return `❌ No encontré a "${datos.nombre || datos.telefono}" en los clientes.`;
            await removeBlacklist(orgId, contacto.id);
            return `✅ *${contacto.nombre || contacto.telefono}* eliminado de la lista negra.`;
        }

        case 'add_vip': {
            const contacto = await buscarContacto(orgId, datos.nombre || datos.telefono);
            if (!contacto) return `❌ No encontré a "${datos.nombre || datos.telefono}" en los clientes.`;
            await setVip(orgId, contacto.id, true);
            return `⭐ *${contacto.nombre || contacto.telefono}* añadido a la lista VIP.`;
        }

        case 'remove_vip': {
            const contacto = await buscarContacto(orgId, datos.nombre || datos.telefono);
            if (!contacto) return `❌ No encontré a "${datos.nombre || datos.telefono}" en los clientes.`;
            await setVip(orgId, contacto.id, false);
            return `✅ *${contacto.nombre || contacto.telefono}* eliminado de la lista VIP.`;
        }

        case 'list_blacklist': {
            const { getBlacklist } = require('./db');
            const lista = await getBlacklist(orgId);
            if (!lista.length) return 'La lista negra está vacía.';
            return `🚫 *Lista negra:*\n` + lista.map(c => `• ${c.nombre || c.telefono} — ${c.blacklist_reason || 'sin motivo'}`).join('\n');
        }

        case 'list_vip': {
            const { getVipList } = require('./db');
            const lista = await getVipList(orgId);
            if (!lista.length) return 'No hay clientes VIP todavía.';
            return `⭐ *Lista VIP:*\n` + lista.map(c => `• ${c.nombre || c.telefono} (${c.visit_count} visitas)`).join('\n');
        }

        case 'get_config': {
            const agentCfg = await getAgentConfig(orgId);
            const info = agentCfg?.business_info || {};
            return `⚙️ *Configuración actual:*\n` +
                `• Bot WhatsApp: ${getBotActivoFn(orgId) ? '🟢 Activo' : '🔴 Pausado'}\n` +
                (info.bizum ? `• Bizum: ${info.bizum.importe ?? '?'}€ al ${info.bizum.numero ?? '?'}\n` : '') +
                `• Umbral VIP: ${info.vip?.visitasParaSugerir ?? '?'} visitas`;
        }

        case 'pause_bot': {
            setBotActivoFn(orgId, false); // pausa SOLO la org de este admin
            return '⏸️ Bot de WhatsApp *pausado* para tu negocio.';
        }

        case 'resume_bot': {
            setBotActivoFn(orgId, true);
            return '▶️ Bot de WhatsApp *reactivado* para tu negocio.';
        }

        default:
            return null;
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
                const resultado = await ejecutarAccion(orgId, session.pendingAction.accion, session.pendingAction.datos, bot, chatId);
                telegramSessions.delete(userId);
                bot.sendMessage(chatId, resultado || '✅ Hecho.', { parse_mode: 'Markdown' });
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
            bot.sendMessage(chatId, `${interpretacion.respuesta}\n\n¿Confirmas? (sí / no)`, { parse_mode: 'Markdown' });
            return;
        }

        const resultado = await ejecutarAccion(orgId, interpretacion.accion, interpretacion.datos || {}, bot, chatId);
        bot.sendMessage(chatId, resultado || interpretacion.respuesta, { parse_mode: 'Markdown' });
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

module.exports = { startTelegramBot, notifyBizumPending, notifyEscalation, notifyVipSuggestion, notifyBlacklistAlert, notifyOrgAdmin };
