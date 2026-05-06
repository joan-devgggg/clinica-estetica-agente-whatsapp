/**
 * Webhook Server — Receptor de leads de Instagram Lead Ads
 * Meta envía un POST cada vez que alguien rellena el formulario de Instagram.
 * Este servidor valida la firma, extrae los datos y emite el evento 'lead:new'.
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');
const db = require('./services/db');

const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'clinica_verify_token';
const APP_SECRET = process.env.META_APP_SECRET || '';

const emitter = new EventEmitter();
const app = express();

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
        console.log('✅ Webhook Meta verificado');
        return res.status(200).send(challenge);
    }
    console.warn('⚠️ Verificación webhook fallida');
    res.sendStatus(403);
});

// ─── Validar firma HMAC de Meta ───────────────────────────────────────────────
function isValidMetaSignature(req) {
    if (!APP_SECRET) return true; // En desarrollo sin APP_SECRET, omitir validación
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
        console.error('Error extrayendo lead de payload Meta:', e.message);
    }
    return null;
}

// ─── Receptor principal de leads ──────────────────────────────────────────────
app.post('/webhook/meta', (req, res) => {
    // Validar firma
    if (!isValidMetaSignature(req)) {
        console.warn('⚠️ Firma Meta inválida — rechazando webhook');
        return res.sendStatus(403);
    }

    // Meta espera 200 en menos de 5s — respondemos inmediatamente
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== 'page' && body.object !== 'instagram') {
        console.log('Webhook recibido pero no es de página/instagram:', body.object);
        return;
    }

    const entries = body.entry || [];
    for (const entry of entries) {
        const leadData = extractLeadData(entry);
        if (leadData) {
            console.log('📥 Nuevo lead de Instagram:', leadData.telefono, leadData.nombre || '(sin nombre)');
            emitter.emit('lead:new', leadData);
        }
    }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── Dashboard ────────────────────────────────────────────────────────────────
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard', 'index.html')));

// ─── API: Leads ───────────────────────────────────────────────────────────────
app.get('/api/leads', (req, res) => {
    try {
        const { limit = 100, offset = 0, estado, search } = req.query;
        const leads = db.getAllLeads({ limit: Number(limit), offset: Number(offset), estado, search });
        res.json(leads);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leads/:id', (req, res) => {
    try {
        const lead = db.findById(Number(req.params.id));
        if (!lead) return res.status(404).json({ error: 'No encontrado' });
        res.json(lead);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads', (req, res) => {
    try {
        const id = db.guardarLeadEnAirtable(req.body);
        const lead = db.findById(Number(id));
        res.status(201).json(lead);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/leads/:id', (req, res) => {
    try {
        const lead = db.updateLeadById(Number(req.params.id), req.body);
        res.json(lead);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leads/:id', (req, res) => {
    try {
        db.deleteLead(Number(req.params.id));
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Citas (leads con fecha) ─────────────────────────────────────────────
app.get('/api/citas', (req, res) => {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        const desde = req.query.desde || hoy;
        const hasta = req.query.hasta || hoy;
        const citas = db.getLeadsByDateRange(desde, hasta);
        res.json(citas);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Stats ───────────────────────────────────────────────────────────────
app.get('/api/stats', (_req, res) => {
    try { res.json(db.getStats()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Config ──────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
    try { res.json(db.getAllConfig()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/config/:clave', (req, res) => {
    try {
        db.setConfigValue(req.params.clave, req.body.valor);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

function startWebhookServer(port) {
    const PORT = port || process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🌐 Webhook server escuchando en puerto ${PORT}`);
        console.log(`   GET  /webhook/meta → verificación Meta`);
        console.log(`   POST /webhook/meta → leads de Instagram`);
        console.log(`   GET  /health       → health check`);
    });
    return emitter;
}

module.exports = { startWebhookServer };
