/**
 * Webhook Server — API REST multi-org para el dashboard
 * Todas las rutas bajo /api extraen orgId del header X-Organization-Id
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const db = require('./services/db');
const config = require('./config.json');
const { notifyBlacklistAlert } = require('./services/telegram');
const logger = require('./lib/logger');

const DASHBOARD_API_SECRET = process.env.DASHBOARD_API_SECRET || '';
const DEFAULT_ORG = process.env.ORGANIZATION_ID || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';
const allowedOrigins = [
    'http://localhost:3001',
    ...(DASHBOARD_ORIGIN ? [DASHBOARD_ORIGIN] : []),
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`CORS: origen no permitido — ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Organization-Id'],
}));

let _waClients = null; // Map<orgId, { client, ... }>
let _setConvMode = null;
let _setBotActivo = null; // (orgId, valor, persist) → actualiza el estado por org

function setWAClient(clients, setConvMode, setBotActivo) {
    _waClients = clients;
    _setConvMode = setConvMode;
    _setBotActivo = setBotActivo;
}

function getWAClient(orgId) {
    if (!_waClients) return null;
    if (_waClients instanceof Map) return _waClients.get(orgId)?.client || null;
    return _waClients;
}

app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/api/wa-status', async (_req, res) => {
    const statuses = {};
    if (_waClients instanceof Map) {
        for (const [orgId, entry] of _waClients) {
            try {
                const state = await entry.client.getState();
                statuses[entry.slug || orgId] = state || 'DISCONNECTED';
            } catch {
                statuses[entry.slug || orgId] = 'DISCONNECTED';
            }
        }
    }
    res.json(statuses);
});

// ─── Webhook 360dialog (WhatsApp Cloud API) — SOLO Sante ─────────────────────
// Fuera de /api → NO pasa por requireApiAuth (360dialog es server-to-server y no
// envía el Bearer del dashboard). Se protege con un token secreto en la URL.
// `./bot` y el provider se requieren perezosamente dentro del handler para no
// crear un ciclo de carga (misma convención que el resto del archivo).
const WHATSAPP_WEBHOOK_TOKEN = process.env.WHATSAPP_WEBHOOK_TOKEN || '';

function require360Token(req, res, next) {
    const token = req.params.token || '';
    if (!WHATSAPP_WEBHOOK_TOKEN) {
        logger.warn('webhook_360d_sin_token_configurado');
        return res.sendStatus(403);
    }
    try {
        const a = Buffer.from(token);
        const b = Buffer.from(WHATSAPP_WEBHOOK_TOKEN);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(403);
    } catch {
        return res.sendStatus(403);
    }
    next();
}

// GET: no-op defensivo. 360dialog NO exige handshake tipo Meta (hub.challenge),
// pero exponerlo permite verificar la ruta desde el navegador / un ping.
app.get('/webhook/360dialog/:token', require360Token, (_req, res) => res.sendStatus(200));

// POST: responde 200 inmediato y procesa async (Cloud API reintenta si tardas →
// evita timeouts y duplicados; el dedupe por wamid en bot.js cubre reintentos).
app.post('/webhook/360dialog/:token', require360Token, (req, res) => {
    res.sendStatus(200);
    const body = req.body;
    setImmediate(async () => {
        try {
            const { process360Webhook } = require('./services/providers/threesixty-dialog');
            const { resolveOrgByPhone } = require('./services/org-registry');
            const { handleIncomingMessage, isBotActivo } = require('./bot');
            await process360Webhook(body, { resolveOrgByPhone, isBotActivo, handleIncomingMessage });
        } catch (e) {
            logger.error('webhook_360d_error', { error: e.message });
        }
    });
});

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireApiAuth(req, res, next) {
    if (!DASHBOARD_API_SECRET) {
        logger.warn('api_sin_proteccion');
        return next();
    }
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Token requerido' });
    try {
        const a = Buffer.from(token);
        const b = Buffer.from(DASHBOARD_API_SECRET);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return res.status(401).json({ error: 'Token inválido' });
        }
    } catch {
        return res.status(401).json({ error: 'Token inválido' });
    }
    next();
}

// Extract orgId from header (fallback to env default)
function extractOrgId(req) {
    return req.headers['x-organization-id'] || DEFAULT_ORG;
}

app.use('/api', requireApiAuth);

// ─── API: Leads ───────────────────────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const { limit = 100, offset = 0, estado, search, hasConversation } = req.query;
        const leads = await db.getAllLeads(orgId, { limit: Number(limit), offset: Number(offset), estado, search, hasConversation: hasConversation === 'true' });
        res.json(leads);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leads/:id', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const lead = await db.findById(orgId, req.params.id);
        if (!lead) return res.status(404).json({ error: 'No encontrado' });
        res.json(lead);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        if (!req.body.telefono) return res.status(400).json({ error: 'El teléfono es obligatorio' });
        const id = await db.saveLead(orgId, req.body);
        if (!id) return res.status(400).json({ error: 'No se pudo crear el contacto — verifica el teléfono' });
        const lead = await db.findById(orgId, id);
        if (!lead) return res.status(500).json({ error: 'Contacto creado pero no encontrado al releer' });
        res.status(201).json(lead);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/leads/:id', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const lead = await db.updateLeadById(orgId, req.params.id, req.body);
        res.json(lead);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leads/:id', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        await db.deleteLead(orgId, req.params.id);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Clientes (enriched with appointment stats) ────────────────────────
app.get('/api/clientes', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const { limit = 100, offset = 0, estado, search } = req.query;
        const [leads, stats, stylists] = await Promise.all([
            db.getAllLeads(orgId, { limit: Number(limit), offset: Number(offset), estado, search }),
            db.getContactStats(orgId),
            db.getStylistsByOrg(orgId),
        ]);
        const statsMap = new Map(stats.map(s => [s.contact_id, s]));
        const stylistMap = new Map(stylists.map(s => [s.id, s.name]));
        const enriched = leads.map(l => {
            const s = statsMap.get(l.id);
            // Estilista de la próxima cita (citas manuales/bot guardan stylist_id en
            // appointments, no en contacts); fallback a la estilista preferida del contacto.
            const stylistIdForName = s?.proxima_stylist_id || l.preferred_stylist_id;
            return {
                ...l,
                total_visitas: Number(s?.total_visitas) || 0,
                proxima_cita: s?.proxima_cita || null,
                ultima_cita_real: s?.ultima_cita_real || null,
                ultimo_servicio: s?.ultimo_servicio || null,
                estilista_nombre: stylistIdForName
                    ? stylistMap.get(stylistIdForName) || null
                    : null,
            };
        });
        res.json(enriched);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Appointments ───────────────────────────────────────────────────────
app.get('/api/citas', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const hoy = new Date().toISOString().split('T')[0];
        const desde = req.query.desde || hoy;
        const hasta = req.query.hasta || hoy;
        const citas = await db.getAppointmentsByDateRange(orgId, desde, hasta);
        res.json(citas);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/appointments', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const { contactId, servicio, fecha, hora, duracionMin, stylistId, notas, personas, ocasion } = req.body;
        if (!contactId || !fecha) return res.status(400).json({ error: 'contactId y fecha requeridos' });
        if (hora != null && hora !== '' && !/^\d{1,2}:\d{2}$/.test(String(hora).trim())) {
            return res.status(400).json({ error: `Hora inválida ("${hora}"). Usa el formato HH:MM` });
        }
        const apt = await db.saveAppointment(orgId, contactId, { servicio, fecha, hora, duracionMin, notas, personas, ocasion, stylistId, source: 'manual' });
        if (!apt) {
            const contact = await db.findById(orgId, contactId);
            if (!contact) return res.status(400).json({ error: `Contacto con id ${contactId} no encontrado` });
            return res.status(500).json({ error: 'No se pudo crear la cita — revisa los datos o inténtalo de nuevo' });
        }

        await db.updateLeadById(orgId, contactId, {
            estado_cita: 'confirmado',
            fecha_cita: fecha,
            hora_cita: hora || null,
            origen: 'manual',
            appointment_id: apt.id,
        });

        res.status(201).json(apt);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/citas/:id', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        console.log('[DEBUG PUT /api/citas/:id] llegó petición', { id: req.params.id, orgId, body: req.body });
        const apt = await db.updateAppointment(orgId, req.params.id, req.body);
        console.log('[DEBUG apt]', apt);
        if (!apt) return res.status(404).json({ error: 'No encontrada' });

        if ((req.body.noShow === true || req.body.estado === 'no_show') && apt.contact_id) {
            console.log('[DEBUG no-show] ejecutando setBlacklist', { orgId, contact_id: apt.contact_id, noShow: req.body.noShow, estado: req.body.estado });
            const noShowContact = await db.findById(orgId, apt.contact_id);
            await db.setBlacklist(orgId, apt.contact_id, 'No-show');
            notifyBlacklistAlert(orgId, { nombre: noShowContact?.nombre, telefono: noShowContact?.telefono, blacklist_reason: 'No-show' }).catch(() => {});
        }

        if (req.body.estado === 'completed' && apt.contact_id) {
            const visitCount = await db.incrementVisitCount(orgId, apt.contact_id);
            const contact = await db.findById(orgId, apt.contact_id);
            if (contact && !contact.is_vip) {
                const agentCfg = await db.getAgentConfig(orgId);
                const umbral = agentCfg?.business_info?.vip?.visitasParaSugerir ?? 3;
                if (visitCount >= umbral) {
                    await db.createPendingAction(orgId, {
                        type: 'vip_suggestion',
                        contactId: contact.id,
                        payload: { nombre: contact.nombre, telefono: contact.telefono, visit_count: visitCount }
                    });
                }
            }
        }

        res.json(apt);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/citas/:id', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const result = await db.deleteAppointment(orgId, req.params.id);
        if (!result.ok) return res.status(400).json({ error: result.error || 'No se pudo eliminar la cita' });
        if (result.deleted === 0) return res.status(404).json({ error: 'No encontrada' });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Bizums ─────────────────────────────────────────────────────────────
app.get('/api/bizums', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        res.json(await db.getReservasBizumPendiente(orgId));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bizums/:appointmentId/resolver', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const { confirmado } = req.body;
        const pendientes = await db.getPendingActions(orgId, 'bizum_review');
        const pending = pendientes.find(p => p.appointment_id === req.params.appointmentId);
        if (!pending) return res.status(404).json({ error: 'No hay verificación pendiente para esta reserva' });

        const { resolveBizumResult } = require('./bot');
        await resolveBizumResult(pending, !!confirmado);
        await db.resolvePendingAction(orgId, pending.id, confirmado ? 'confirmado' : 'rechazado');
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Lista negra ────────────────────────────────────────────────────────
app.get('/api/lista-negra', async (req, res) => {
    try { res.json(await db.getBlacklist(extractOrgId(req))); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/lista-negra/:id', async (req, res) => {
    try { await db.setBlacklist(extractOrgId(req), req.params.id, req.body.motivo); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/lista-negra/:id', async (req, res) => {
    try { await db.removeBlacklist(extractOrgId(req), req.params.id); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Lista VIP ──────────────────────────────────────────────────────────
app.get('/api/lista-vip', async (req, res) => {
    try { res.json(await db.getVipList(extractOrgId(req))); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/lista-vip/:id', async (req, res) => {
    try { await db.setVip(extractOrgId(req), req.params.id, true); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/lista-vip/:id', async (req, res) => {
    try { await db.setVip(extractOrgId(req), req.params.id, false); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/vip/generate-message', async (req, res) => {
    try {
        const { idea } = req.body;
        if (!idea) return res.status(400).json({ error: 'idea requerida' });
        const OpenAI = require('openai');
        const openrouter = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY });
        const completion = await openrouter.chat.completions.create({
            model: 'anthropic/claude-haiku-4.5',
            messages: [
                {
                    role: 'system',
                    content: 'Eres el asistente de Santé Healthy Hair Salon, un salón premium en Alicante. Genera mensajes de WhatsApp para clientas VIP: cortos (máximo 2-3 líneas), cercanos, con 1-2 emojis, en español informal (tuteo). Termina siempre con una llamada a la acción como \'¿Te apuntas?\' o \'¿Reservamos?\' o similar. NUNCA uses asteriscos, negritas ni markdown. Solo texto plano.',
                },
                { role: 'user', content: `Genera un mensaje promocional para enviar a nuestras clientas VIP basado en esta idea: ${idea}` },
            ],
            max_tokens: 200,
        });
        const mensaje = completion.choices[0]?.message?.content?.trim() || '';
        res.json({ mensaje });
    } catch (e) {
        console.error('[vip/generate-message] ERROR:', {
            message: e.message,
            status: e.status,
            code: e.code,
            type: e.type,
            cause: e.cause,
            responseBody: e.response?.data || e.error,
            OPENROUTER_KEY_SET: !!process.env.OPENROUTER_API_KEY,
            OPENROUTER_KEY_PREFIX: process.env.OPENROUTER_API_KEY?.slice(0, 8),
        });
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/vip/broadcast', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const { mensaje } = req.body;
        if (!mensaje) return res.status(400).json({ error: 'mensaje requerido' });
        const client = getWAClient(orgId);
        if (!client) return res.status(503).json({ error: 'WhatsApp no conectado' });
        const vips = await db.getVipList(orgId);
        if (!vips.length) return res.json({ enviados: 0, omitidos: 0, fallos: [] });
        const { waSendMessage } = require('./bot');
        let enviados = 0;
        const fallos = [];
        for (const vip of vips) {
            // Preferir el JID canónico guardado (metadata.wa_jid, p.ej. @lid); solo si
            // no existe, reconstruir el WID clásico a partir del teléfono.
            const digits = (vip.telefono || '').replace(/\D/g, '');
            const chatId = vip.wa_jid || (digits ? `${digits}@c.us` : null);
            if (!chatId) { fallos.push({ telefono: vip.telefono, jid: null, error: 'sin teléfono ni JID' }); continue; }
            try {
                await waSendMessage(client, chatId, mensaje);
                enviados++;
            } catch (e) {
                console.error('[vip/broadcast] fallo envío', { telefono: vip.telefono, jid: chatId, error: e.message });
                fallos.push({ telefono: vip.telefono, jid: chatId, error: e.message });
            }
        }
        res.json({ enviados, omitidos: fallos.length, fallos });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Campañas (mensaje masivo con IA + filtros de audiencia) ─────────────
app.post('/api/campaigns/generate-message', async (req, res) => {
    try {
        const { idea } = req.body;
        if (!idea) return res.status(400).json({ error: 'idea requerida' });
        const OpenAI = require('openai');
        const openrouter = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY });
        const completion = await openrouter.chat.completions.create({
            model: 'anthropic/claude-haiku-4.5',
            messages: [
                {
                    role: 'system',
                    content: 'Eres el asistente de Santé Healthy Hair Salon, un salón premium en Alicante. Genera mensajes de WhatsApp para enviar a la base de clientas del salón: cortos (máximo 2-3 líneas), cercanos, con 1-2 emojis, en español informal (tuteo). Termina siempre con una llamada a la acción como \'¿Te apuntas?\' o \'¿Reservamos?\' o similar. NUNCA uses asteriscos, negritas ni markdown. Solo texto plano.',
                },
                { role: 'user', content: `Genera un mensaje promocional para enviar a nuestras clientas basado en esta idea: ${idea}` },
            ],
            max_tokens: 200,
        });
        const mensaje = completion.choices[0]?.message?.content?.trim() || '';
        res.json({ mensaje });
    } catch (e) {
        console.error('[campaigns/generate-message] ERROR:', {
            message: e.message,
            status: e.status,
            code: e.code,
            OPENROUTER_KEY_SET: !!process.env.OPENROUTER_API_KEY,
        });
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/campaigns/broadcast', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const { mensaje, audience = 'todos', templateName, templateParams, phones } = req.body;

        // phones: allowlist explícito de teléfonos (prueba segura). Si viene, apunta
        // SOLO a esos números e ignora la audiencia.
        const destinatarios = await db.getBroadcastRecipients(orgId, { audience, phones });
        const total = destinatarios.length;

        // Ruta plantilla aprobada (360dialog) — estructura lista, aún no operativa.
        if (templateName) {
            return res.json({
                enviados: 0,
                total,
                omitidos: total,
                pendiente_plantilla: true,
                nota: 'El envío por plantilla aprobada requiere 360dialog (aún no conectado).',
            });
        }

        // Ruta mensaje libre — mismo patrón que /api/vip/broadcast.
        if (!mensaje) return res.status(400).json({ error: 'mensaje requerido' });
        const client = getWAClient(orgId);
        if (!client) return res.status(503).json({ error: 'WhatsApp no conectado' });
        if (!total) return res.json({ enviados: 0, total: 0, omitidos: 0 });

        const { waSendMessage } = require('./bot');
        let enviados = 0;
        const fallos = [];
        for (const c of destinatarios) {
            // Preferir el JID canónico guardado (metadata.wa_jid, p.ej. @lid); solo si
            // no existe, reconstruir el WID clásico a partir del teléfono.
            const digits = (c.telefono || '').replace(/\D/g, '');
            const chatId = c.wa_jid || (digits ? `${digits}@c.us` : null);
            if (!chatId) { fallos.push({ telefono: c.telefono, jid: null, error: 'sin teléfono ni JID' }); continue; }
            try {
                await waSendMessage(client, chatId, mensaje);
                enviados++;
            } catch (e) {
                console.error('[campaigns/broadcast] fallo envío', { telefono: c.telefono, jid: chatId, error: e.message });
                fallos.push({ telefono: c.telefono, jid: chatId, error: e.message });
            }
        }
        res.json({ enviados, total, omitidos: total - enviados, fallos });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pending-actions', async (req, res) => {
    try { res.json(await db.getPendingActions(extractOrgId(req), req.query.type)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pending-actions/:id/resolver', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const { accion, type } = req.body;
        const pendingType = type || 'vip_suggestion';
        const pendientes = await db.getPendingActions(orgId, pendingType);
        const pending = pendientes.find(p => String(p.id) === String(req.params.id));
        if (!pending) return res.status(404).json({ error: 'No encontrada' });

        if (pendingType === 'vip_suggestion') {
            if (accion === 'aceptar' && pending.contact_id) {
                await db.setVip(orgId, pending.contact_id, true);
            }
        } else if (pendingType === 'escalation' && accion === 'resolver' && pending.contact_id) {
            const contact = await db.findById(orgId, pending.contact_id);
            if (contact) {
                await db.setLeadBotMode(orgId, contact.telefono, 'auto');
                if (_setConvMode) _setConvMode(contact.telefono, true);
            }
        }

        const resolution = accion === 'aceptar' || accion === 'resolver' ? 'resuelto' : 'rechazado';
        await db.resolvePendingAction(orgId, pending.id, resolution);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Stats ──────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
    try { res.json(await db.getStats(extractOrgId(req))); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Config ─────────────────────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
    try { res.json(await db.getAllConfig(extractOrgId(req))); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/config/:clave', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        await db.setConfigValue(orgId, req.params.clave, req.body.valor);
        // El toggle del bot es POR organización: solo afecta a la org de la petición.
        // La config ya quedó persistida arriba → actualizamos memoria sin re-escribir.
        if (req.params.clave === 'bot_activo' && _setBotActivo) {
            _setBotActivo(orgId, !!req.body.valor, false);
        }
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Agent Config ───────────────────────────────────────────────────────
app.get('/api/agent-config', async (req, res) => {
    try { res.json(await db.getAgentConfig(extractOrgId(req))); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/agent-config', async (req, res) => {
    try { res.json(await db.updateAgentConfig(extractOrgId(req), req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Messages ───────────────────────────────────────────────────────────
app.get('/api/messages/:telefono', async (req, res) => {
    try {
        const messages = await db.getMessages(extractOrgId(req), req.params.telefono);
        res.json(messages);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/leads/:id/bot-mode', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const lead = await db.findById(orgId, req.params.id);
        if (!lead) return res.status(404).json({ error: 'No encontrado' });
        const mode = req.body.mode === 'manual' ? 'manual' : 'auto';
        await db.setLeadBotMode(orgId, lead.telefono, mode);
        let isEscalationResolve = false;
        if (mode === 'auto') {
            const escalations = await db.getPendingActions(orgId, 'escalation');
            const match = escalations.find(e => String(e.contact_id) === String(lead.id));
            if (match) {
                await db.resolvePendingAction(orgId, match.id, 'resuelto_panel');
                isEscalationResolve = true;
            }
        }
        if (_setConvMode) _setConvMode(lead.telefono, mode === 'auto', isEscalationResolve);
        res.json({ ok: true, mode });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const { telefono, mensaje } = req.body;
        if (!telefono || !mensaje) return res.status(400).json({ error: 'telefono y mensaje requeridos' });
        const client = getWAClient(orgId);
        if (!client) return res.status(503).json({ error: 'WhatsApp no conectado — reconecta el bot e inténtalo de nuevo' });
        const { findOriginalJid, waSendMessage, isTransientWAError } = require('./bot');
        const digits = telefono.replace(/\D/g, '');
        // Resolvemos el JID REAL del chat. Para contactos LID, construir "<lid>@c.us" apunta a
        // un chat inexistente y desadjunta el frame de puppeteer ("detached Frame"). Prioridad:
        // 1) JID persistido en BD (contacts.metadata.wa_jid), 2) sesión en memoria,
        // 3) heurística: un LID (~15 dígitos) no es un número @c.us válido → usar @lid.
        const persistedJid = await db.getContactWaJid(orgId, digits).catch(() => null);
        const looksLikeLid = digits.length >= 14;
        const userPhone = persistedJid
            || findOriginalJid(orgId, digits)
            || (looksLikeLid ? `${digits}@lid` : `${digits}@c.us`);
        // Warm-up del chat YA resuelto (best-effort), como el path del bot.
        try { await client.getChatById(userPhone); } catch { /* best-effort */ }
        try {
            // waSendMessage reintenta con backoff ante errores transitorios de frame (bug 7).
            await waSendMessage(client, userPhone, mensaje);
        } catch (waErr) {
            const msg = String(waErr?.message || waErr || '');
            if (msg.includes('LID')) {
                const altJid = findOriginalJid(orgId, digits) || `${digits}@lid`;
                if (altJid && altJid !== userPhone) {
                    logger.info('wa_send_lid_retry', { orgId, telefono, altJid });
                    await waSendMessage(client, altJid, mensaje);
                } else {
                    logger.warn('wa_send_lid_no_jid', { orgId, telefono });
                    return res.status(503).json({ error: 'No se puede enviar: el contacto usa LID y no hay chat conocido' });
                }
            } else if (isTransientWAError(waErr)) {
                // El frame seguía desadjuntado tras los reintentos: pedimos reintentar.
                logger.warn('wa_send_frame_detached', { orgId, telefono, error: msg });
                return res.status(503).json({ error: 'WhatsApp estaba ocupado un momento — vuelve a intentarlo' });
            } else if (msg.includes('not connected') || msg.includes('ECONNREFUSED') || msg.includes('Protocol error')) {
                logger.warn('wa_send_desconectado', { orgId, telefono, error: msg });
                return res.status(503).json({ error: 'WhatsApp no conectado — reconecta el bot e inténtalo de nuevo' });
            } else {
                throw waErr;
            }
        }
        await db.saveMessage(orgId, { telefono: digits, contenido: mensaje, direccion: 'saliente', esManual: true });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Stylists ───────────────────────────────────────────────────────────
app.get('/api/stylists', async (req, res) => {
    try { res.json(await db.getStylistsByOrg(extractOrgId(req))); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stylists', async (req, res) => {
    try {
        const stylist = await db.createStylist(extractOrgId(req), req.body);
        res.status(201).json(stylist);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/stylists/:id', async (req, res) => {
    try {
        const stylist = await db.updateStylist(extractOrgId(req), req.params.id, req.body);
        if (!stylist) return res.status(404).json({ error: 'No encontrado' });
        res.json(stylist);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Stylist Schedules ──────────────────────────────────────────────────
app.get('/api/stylist-schedule/:stylistId', async (req, res) => {
    try { res.json(await db.getStylistSchedule(extractOrgId(req), req.params.stylistId)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/stylist-schedule/:stylistId', async (req, res) => {
    try {
        const schedule = await db.upsertStylistSchedule(extractOrgId(req), req.params.stylistId, req.body.schedules || []);
        res.json(schedule);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Schedule Blocks ────────────────────────────────────────────────────
app.get('/api/schedule-blocks', async (req, res) => {
    try {
        const { stylistId, desde, hasta } = req.query;
        res.json(await db.getScheduleBlocks(extractOrgId(req), stylistId, desde, hasta));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/schedule-blocks', async (req, res) => {
    try {
        const block = await db.createScheduleBlock(extractOrgId(req), req.body);
        res.status(201).json(block);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/schedule-blocks/:id', async (req, res) => {
    try {
        await db.deleteScheduleBlock(extractOrgId(req), req.params.id);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Blocked Days ──────────────────────────────────────────────────────
app.get('/api/blocked-days', async (req, res) => {
    try {
        const { from, to, stylistId } = req.query;
        res.json(await db.getBlockedDays(extractOrgId(req), { from, to, stylistId }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/blocked-days', async (req, res) => {
    try {
        const block = await db.createBlockedDay(extractOrgId(req), req.body);
        res.status(201).json(block);
    } catch (e) {
        const msg = e.message || '';
        if (msg.includes('duplicate') || msg.includes('unique')) {
            return res.status(409).json({ error: 'Ese día ya está bloqueado' });
        }
        res.status(500).json({ error: msg });
    }
});

app.delete('/api/blocked-days/:id', async (req, res) => {
    try {
        await db.deleteBlockedDay(extractOrgId(req), req.params.id);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Reviews pending ────────────────────────────────────────────────────
app.get('/api/reviews-pending', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const horasResena = await db.getConfigValue(orgId, 'horas_resena');
        const appointments = await db.getCompletedAppointmentsForReview(orgId, horasResena || 0);
        res.json(appointments);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reviews/:appointmentId/send', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        await db.updateAppointment(orgId, req.params.appointmentId, { resenaEnviada: true });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

function startWebhookServer(port) {
    const PORT = port || process.env.PORT || 3000;
    app.listen(PORT, () => {
        logger.info('servidor_iniciado', { puerto: PORT });
    });
}

// `app` se exporta para tests de integración de rutas (no se usa en producción; el arranque
// real pasa por startWebhookServer). Exponerlo no cambia ningún comportamiento.
module.exports = { startWebhookServer, setWAClient, app };
