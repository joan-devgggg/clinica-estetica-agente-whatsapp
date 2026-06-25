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
const { notifyVipSuggestion } = require('./services/telegram');
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
        const id = await db.saveLead(orgId, req.body);
        const lead = await db.findById(orgId, id);
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
        const apt = await db.saveAppointment(orgId, contactId, { servicio, fecha, hora, duracionMin, notas, personas, ocasion, stylistId, source: 'manual' });
        if (!apt) return res.status(500).json({ error: 'Error al crear la cita' });

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
        const apt = await db.updateAppointment(orgId, req.params.id, req.body);
        if (!apt) return res.status(404).json({ error: 'No encontrada' });

        if (req.body.noShow === true && apt.contact_id) {
            await db.setBlacklist(orgId, apt.contact_id, 'No-show');
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
                    notifyVipSuggestion(orgId, { ...contact, visit_count: visitCount }).catch(() => {});
                }
            }
        }

        res.json(apt);
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

app.get('/api/pending-actions', async (req, res) => {
    try { res.json(await db.getPendingActions(extractOrgId(req), req.query.type)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pending-actions/:id/resolver', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const { accion } = req.body;
        const pendientes = await db.getPendingActions(orgId, 'vip_suggestion');
        const pending = pendientes.find(p => String(p.id) === String(req.params.id));
        if (!pending) return res.status(404).json({ error: 'No encontrada' });

        if (accion === 'aceptar' && pending.contact_id) {
            await db.setVip(orgId, pending.contact_id, true);
        }
        await db.resolvePendingAction(orgId, pending.id, accion === 'aceptar' ? 'aceptado' : 'rechazado');
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
        if (_setConvMode) _setConvMode(lead.telefono, mode === 'auto');
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
        const digits = telefono.replace(/\D/g, '');
        let userPhone = `${digits}@c.us`;
        try {
            await client.sendMessage(userPhone, mensaje);
        } catch (waErr) {
            const msg = String(waErr?.message || waErr || '');
            if (msg.includes('LID')) {
                const { findOriginalJid } = require('./bot');
                const lidJid = findOriginalJid(orgId, digits);
                if (lidJid) {
                    logger.info('wa_send_lid_retry', { orgId, telefono, lidJid });
                    await client.sendMessage(lidJid, mensaje);
                } else {
                    logger.warn('wa_send_lid_no_session', { orgId, telefono });
                    return res.status(503).json({ error: 'No se puede enviar: el contacto usa LID y no hay sesión activa' });
                }
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

module.exports = { startWebhookServer, setWAClient };
