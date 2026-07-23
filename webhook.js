/**
 * Webhook Server — Receptor de leads de Instagram Lead Ads
 * Meta envía un POST cada vez que alguien rellena el formulario de Instagram.
 * Este servidor valida la firma, extrae los datos y emite el evento 'lead:new'.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');
const db = require('./services/db');
const logger = require('./lib/logger');

const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'clinica_verify_token';
const APP_SECRET = process.env.META_APP_SECRET || '';
const DASHBOARD_API_SECRET = process.env.DASHBOARD_API_SECRET || '';

const emitter = new EventEmitter();
const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';
const allowedOrigins = [
    'http://localhost:3001',
    ...(DASHBOARD_ORIGIN ? [DASHBOARD_ORIGIN] : []),
];

app.use(cors({
    origin: (origin, callback) => {
        // Permitir peticiones sin origin (Postman, curl, server-to-server)
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`CORS: origen no permitido — ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// WhatsApp client y callback de modo conversación (inyectados desde server.js)
let _waClient = null;
let _setConvMode = null;
function setWAClient(client, setConvMode) {
    _waClient = client;
    _setConvMode = setConvMode;
}

// Raw body para validar firma HMAC de Meta
app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ─── Verificación inicial del webhook (Meta lo llama una vez al configurarlo) ──
app.get('/webhook/meta', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        logger.info('webhook_verificado');
        return res.status(200).send(challenge);
    }
    logger.warn('webhook_verificacion_fallida');
    res.sendStatus(403);
});

// ─── Validar firma HMAC de Meta ───────────────────────────────────────────────
function isValidMetaSignature(req) {
    if (!APP_SECRET) return false; // Rechazar si APP_SECRET no está configurado
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) return false;
    const expected = 'sha256=' + crypto
        .createHmac('sha256', APP_SECRET)
        .update(req.rawBody)
        .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─── Extrae datos del formulario de Instagram Lead Ads ────────────────────────
function extractLeadData(entry) {
    try {
        const changes = entry?.changes || [];
        for (const change of changes) {
            if (change.field !== 'leadgen') continue;
            const value = change.value || {};

            // Los field_data vienen como array de { name, values }
            const fieldData = value.field_data || [];
            const fields = {};
            for (const f of fieldData) {
                fields[f.name?.toLowerCase()] = f.values?.[0] || '';
            }

            // Mapeo flexible — Meta puede enviar distintos nombres de campo
            const telefono = fields['phone_number'] || fields['telefono'] || fields['phone'] || fields['mobile'] || '';
            const nombre = fields['full_name'] || fields['nombre'] || fields['name'] || fields['first_name'] || '';
            const tratamiento = fields['tratamiento'] || fields['service'] || fields['servicio'] || fields['interes'] || '';

            if (telefono) {
                return {
                    telefono: telefono.replace(/\D/g, ''),
                    nombre: nombre || null,
                    tratamiento: tratamiento || null,
                    leadId: value.leadgen_id || null,
                    formId: value.form_id || null,
                    pageId: value.page_id || null
                };
            }
        }
    } catch (e) {
        logger.error('error_extraccion_lead', { error: e.message });
    }
    return null;
}

// ─── Receptor principal de leads ──────────────────────────────────────────────
app.post('/webhook/meta', (req, res) => {
    // Validar firma
    if (!isValidMetaSignature(req)) {
        logger.warn('firma_meta_invalida');
        return res.sendStatus(403);
    }

    // Meta espera 200 en menos de 5s — respondemos inmediatamente
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== 'page' && body.object !== 'instagram') {
        logger.info('webhook_objeto_desconocido', { objeto: body.object });
        return;
    }

    const entries = body.entry || [];
    for (const entry of entries) {
        const leadData = extractLeadData(entry);
        if (leadData) {
            logger.info('lead_nuevo', { telefono: leadData.telefono, nombre: leadData.nombre || null });
            emitter.emit('lead:new', leadData);
        }
    }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── Auth middleware para la API del dashboard ────────────────────────────────
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

app.use('/api', requireApiAuth);

// ─── API: Leads ───────────────────────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
    try {
        const { limit = 100, offset = 0, estado, search } = req.query;
        const leads = await db.getAllLeads({ limit: Number(limit), offset: Number(offset), estado, search });
        res.json(leads);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leads/:id', async (req, res) => {
    try {
        const lead = await db.findById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'No encontrado' });
        res.json(lead);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads', async (req, res) => {
    try {
        const id = await db.saveLead(req.body);
        const lead = await db.findById(id);
        res.status(201).json(lead);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/leads/:id', async (req, res) => {
    try {
        const lead = await db.updateLeadById(req.params.id, req.body);
        res.json(lead);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leads/:id', async (req, res) => {
    try {
        await db.deleteLead(req.params.id);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Citas (leads con fecha) ─────────────────────────────────────────────
app.get('/api/citas', async (req, res) => {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        const desde = req.query.desde || hoy;
        const hasta = req.query.hasta || hoy;
        const citas = await db.getAppointmentsByDateRange(desde, hasta);
        res.json(citas);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Stats ───────────────────────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
    try { res.json(await db.getStats()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Config ──────────────────────────────────────────────────────────────
app.get('/api/config', async (_req, res) => {
    try { res.json(await db.getAllConfig()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/config/:clave', async (req, res) => {
    try {
        await db.setConfigValue(req.params.clave, req.body.valor);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Agent Config ────────────────────────────────────────────────────────
app.get('/api/agent-config', async (_req, res) => {
    try { res.json(await db.getAgentConfig()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/agent-config', async (req, res) => {
    try { res.json(await db.updateAgentConfig(req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Monitor WhatsApp ────────────────────────────────────────────────────

app.get('/api/messages/:telefono', async (req, res) => {
    try {
        const messages = await db.getMessages(req.params.telefono);
        res.json(messages);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/leads/:id/bot-mode', async (req, res) => {
    try {
        const lead = await db.findById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'No encontrado' });
        const mode = req.body.mode === 'manual' ? 'manual' : 'auto';
        await db.setLeadBotMode(lead.telefono, mode);
        if (_setConvMode) _setConvMode(lead.telefono, mode === 'auto');
        res.json({ ok: true, mode });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send', async (req, res) => {
    try {
        const { telefono, mensaje } = req.body;
        if (!telefono || !mensaje) return res.status(400).json({ error: 'telefono y mensaje requeridos' });
        if (!_waClient) return res.status(503).json({ error: 'WhatsApp no conectado' });
        const userPhone = `${telefono.replace(/\D/g, '')}@c.us`;
        await _waClient.sendMessage(userPhone, mensaje);
        await db.saveMessage({ telefono: telefono.replace(/\D/g, ''), contenido: mensaje, direccion: 'saliente', esManual: true });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

function startWebhookServer(port) {
    const PORT = port || process.env.PORT || 3000;
    app.listen(PORT, () => {
        logger.info('servidor_iniciado', { puerto: PORT });
    });
    return emitter;
}

module.exports = { startWebhookServer, setWAClient };
