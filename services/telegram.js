/**
 * Bot de Telegram — Panel de administración en lenguaje natural
 * La clínica puede gestionar tratamientos, horarios y configuración
 * sin tocar código ni hablar con el desarrollador.
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { getConfigValue, setConfigValue } = require('./airtable');
const config = require('../config.json');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USERS || '')
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(Boolean);

const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Estado de conversación por usuario de Telegram (para confirmaciones)
const telegramSessions = new Map();

let botActivo = true; // estado global del bot de WA (referencia compartida)
let getBotActivoFn = () => botActivo;
let setBotActivoFn = (v) => { botActivo = v; };

function isAuthorized(userId) {
    if (ALLOWED_USERS.length === 0) return true; // si no hay lista, permite todos (desarrollo)
    return ALLOWED_USERS.includes(userId);
}

// ─── Interprete de lenguaje natural vía OpenAI ───────────────────────────────

async function interpretarComando(mensaje, contextoActual) {
    if (!OPENAI_KEY) return null;

    const serviciosActuales = JSON.stringify(contextoActual.servicios || config.servicios || []);
    const minutosResena = contextoActual.minutosResena || config.conversation?.minutosResena || 30;

    const systemPrompt = `Eres el sistema de administración de un bot de WhatsApp para una clínica estética.
Un administrador de la clínica te manda mensajes en lenguaje natural para gestionar la configuración.

CONFIGURACIÓN ACTUAL:
- Tratamientos: ${serviciosActuales}
- Minutos para pedir reseña: ${minutosResena}
- Bot de WhatsApp: ${getBotActivoFn() ? 'ACTIVO' : 'PAUSADO'}

ACCIONES POSIBLES (responde en JSON):
{
  "accion": "add_servicio" | "edit_servicio" | "delete_servicio" | "list_servicios" |
             "set_minutos_resena" | "get_config" | "pause_bot" | "resume_bot" | "unknown",
  "datos": { ... },
  "respuesta": "mensaje confirmando lo que vas a hacer (pide confirmación si es destructivo)",
  "requiere_confirmacion": true | false
}

EJEMPLOS:
- "añade botox duración 45 minutos precio 150€" → add_servicio con datos
- "cambia el tiempo de reseña a 1 hora" → set_minutos_resena con datos.minutos = 60
- "para el bot" → pause_bot
- "activa el bot" → resume_bot
- "ver configuración" → get_config
- "elimina el tratamiento peeling" → delete_servicio con requiere_confirmacion: true

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
        console.error('Telegram admin LLM error:', e.message);
        return null;
    }
}

// ─── Ejecutar acciones ────────────────────────────────────────────────────────

async function ejecutarAccion(accion, datos, bot, chatId) {
    switch (accion) {
        case 'add_servicio': {
            const servicios = await getConfigValue('servicios') || config.servicios || [];
            servicios.push({
                nombre: datos.nombre || 'Sin nombre',
                duracion: datos.duracion || 60,
                precio: datos.precio || 0
            });
            await setConfigValue('servicios', servicios);
            return `✅ Tratamiento añadido: *${datos.nombre}* (${datos.duracion} min${datos.precio ? `, ${datos.precio}€` : ''})`;
        }

        case 'edit_servicio': {
            const servicios = await getConfigValue('servicios') || config.servicios || [];
            const idx = servicios.findIndex(s =>
                s.nombre.toLowerCase().includes((datos.nombre || '').toLowerCase())
            );
            if (idx === -1) return `❌ No encontré el tratamiento "${datos.nombre}"`;
            servicios[idx] = { ...servicios[idx], ...datos };
            await setConfigValue('servicios', servicios);
            return `✅ Tratamiento actualizado: *${servicios[idx].nombre}*`;
        }

        case 'delete_servicio': {
            const servicios = await getConfigValue('servicios') || config.servicios || [];
            const filtered = servicios.filter(s =>
                !s.nombre.toLowerCase().includes((datos.nombre || '').toLowerCase())
            );
            if (filtered.length === servicios.length) return `❌ No encontré el tratamiento "${datos.nombre}"`;
            await setConfigValue('servicios', filtered);
            return `✅ Tratamiento eliminado: *${datos.nombre}*`;
        }

        case 'list_servicios': {
            const servicios = await getConfigValue('servicios') || config.servicios || [];
            if (!servicios.length) return 'No hay tratamientos configurados.';
            const lista = servicios.map(s =>
                `• *${s.nombre}* — ${s.duracion} min${s.precio ? ` — ${s.precio}€` : ''}`
            ).join('\n');
            return `📋 *Tratamientos actuales:*\n${lista}`;
        }

        case 'set_minutos_resena': {
            const minutos = parseInt(datos.minutos) || 30;
            await setConfigValue('minutos_resena', minutos);
            return `✅ Tiempo de reseña actualizado a *${minutos} minutos* tras la cita.`;
        }

        case 'get_config': {
            const servicios = await getConfigValue('servicios') || config.servicios || [];
            const minutos = await getConfigValue('minutos_resena') || config.conversation?.minutosResena || 30;
            return `⚙️ *Configuración actual:*\n` +
                `• Bot WhatsApp: ${getBotActivoFn() ? '🟢 Activo' : '🔴 Pausado'}\n` +
                `• Reseña: ${minutos} min tras cita\n` +
                `• Tratamientos: ${servicios.length}\n` +
                `\nEscribe "ver tratamientos" para ver la lista completa.`;
        }

        case 'pause_bot': {
            setBotActivoFn(false);
            return '⏸️ Bot de WhatsApp *pausado*. Escribe "activa el bot" para reactivarlo.';
        }

        case 'resume_bot': {
            setBotActivoFn(true);
            return '▶️ Bot de WhatsApp *reactivado*. Ya está atendiendo mensajes.';
        }

        default:
            return null;
    }
}

// ─── Inicialización ───────────────────────────────────────────────────────────

function startTelegramBot(options = {}) {
    if (!TELEGRAM_TOKEN) {
        console.warn('⚠️ TELEGRAM_BOT_TOKEN no configurado — bot de Telegram desactivado');
        return { isBotActivo: getBotActivoFn, setBotActivo: setBotActivoFn };
    }

    if (options.getBotActivo) getBotActivoFn = options.getBotActivo;
    if (options.setBotActivo) setBotActivoFn = options.setBotActivo;

    const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    console.log('📱 Bot de Telegram iniciado');

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const texto = msg.text || '';

        if (!isAuthorized(userId)) {
            bot.sendMessage(chatId, '⛔ No tienes acceso a este panel de administración.');
            return;
        }

        // Gestión de confirmaciones pendientes
        const session = telegramSessions.get(userId);
        if (session && session.pendingAction) {
            if (['si', 'sí', 'confirmo', 'ok', 'vale'].includes(texto.toLowerCase().trim())) {
                const resultado = await ejecutarAccion(session.pendingAction.accion, session.pendingAction.datos, bot, chatId);
                telegramSessions.delete(userId);
                bot.sendMessage(chatId, resultado || '✅ Hecho.', { parse_mode: 'Markdown' });
            } else {
                telegramSessions.delete(userId);
                bot.sendMessage(chatId, '❌ Cancelado.');
            }
            return;
        }

        // Cargar contexto actual
        const contextoActual = {
            servicios: await getConfigValue('servicios') || config.servicios || [],
            minutosResena: await getConfigValue('minutos_resena') || config.conversation?.minutosResena || 30
        };

        const interpretacion = await interpretarComando(texto, contextoActual);

        if (!interpretacion || interpretacion.accion === 'unknown') {
            bot.sendMessage(chatId, interpretacion?.respuesta ||
                'No entendí bien. Puedes decirme cosas como:\n• "añade tratamiento botox 45 min 150€"\n• "cambia el tiempo de reseña a 1 hora"\n• "para el bot"\n• "ver configuración"');
            return;
        }

        // Si requiere confirmación → guardar y preguntar
        if (interpretacion.requiere_confirmacion) {
            telegramSessions.set(userId, { pendingAction: interpretacion });
            bot.sendMessage(chatId, `${interpretacion.respuesta}\n\n¿Confirmas? (sí / no)`, { parse_mode: 'Markdown' });
            return;
        }

        // Ejecutar directamente
        bot.sendMessage(chatId, interpretacion.respuesta, { parse_mode: 'Markdown' });
        const resultado = await ejecutarAccion(interpretacion.accion, interpretacion.datos || {}, bot, chatId);
        if (resultado && resultado !== interpretacion.respuesta) {
            bot.sendMessage(chatId, resultado, { parse_mode: 'Markdown' });
        }
    });

    bot.on('polling_error', (e) => console.error('Telegram polling error:', e.message));

    return { isBotActivo: getBotActivoFn, setBotActivo: setBotActivoFn };
}

module.exports = { startTelegramBot };
