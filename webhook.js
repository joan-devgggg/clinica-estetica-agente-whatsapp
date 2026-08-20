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
const { alertOnce } = require('./services/admin-alerts');
const { validateConfigValue } = require('./services/helpers');
const logger = require('./lib/logger');

const DEFAULT_ORG = process.env.ORGANIZATION_ID || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// Cuánto calendario ve el enlace público: TRES MESES, decisión de Yulia del 19/08/2026.
// El motor lo recibe por parámetro (`horizonteDias`); su default sigue siendo 14, que es lo
// que pide el bot, y por eso una conversación no se entera de este número.
const HORIZONTE_RESERVA_WEB = 90;

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';
const allowedOrigins = [
    'http://localhost:3001',
    'https://clinica-estetica-agente-whatsapp.vercel.app',
    'https://panel.ceromanual.es',
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

// Cliente SALIENTE consciente del proveedor. Si la org tiene canal 360dialog,
// devuelve el cliente de Cloud API — que expone la misma superficie
// (`sendMessage`/`getChatById`) que consume waSendMessage. El resto de orgs
// (San Remo) siguen por whatsapp-web.js SIN cambios. Lo usan todos los envíos
// que dispara el panel (/api/send y los broadcasts).
//
// La resolución vive en services/outbound.js para que el panel y los workers
// (reminder/review) usen LA MISMA: dos criterios distintos de "por dónde sale
// esto" es como se abre una segunda entrada sobre el mismo número.
const { resolveOutboundClient } = require('./services/outbound');
const { CHANNEL_WWEBJS } = require('./services/org-registry');
function getOutboundClient(orgId) {
    return resolveOutboundClient(orgId, getWAClient(orgId));
}

app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
// Incluye el commit desplegado para poder VERIFICAR con un curl qué versión está
// corriendo. Sin esto, un /health en 200 no distingue el código nuevo del viejo y no
// hay forma de confirmar un redespliegue desde fuera (Railway despliega en rolling: un
// deploy correcto no produce ningún corte observable). Railway inyecta
// RAILWAY_GIT_COMMIT_SHA en el build; fuera de Railway queda en null.
const COMMIT_SHA = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null;
const STARTED_AT = new Date().toISOString();

app.get('/health', (_req, res) => res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    commit: COMMIT_SHA ? COMMIT_SHA.slice(0, 7) : null,
    commitFull: COMMIT_SHA,
    startedAt: STARTED_AT, // cambia en cada reinicio → delata el redespliegue
}));

app.get('/api/wa-status', async (_req, res) => {
    const statuses = {};
    if (_waClients instanceof Map) {
        for (const [orgId, entry] of _waClients) {
            const key = entry.slug || orgId;
            // Una org en Cloud API no tiene sesión de whatsapp-web.js: su cliente no expone
            // getState(), así que la rama de abajo la reportaría DISCONNECTED de por vida.
            // Eso es falso y esconde el estado real (el canal está operativo por webhook).
            if (entry.channel && entry.channel !== CHANNEL_WWEBJS) {
                statuses[key] = String(entry.channel).toUpperCase();
                continue;
            }
            try {
                const state = await entry.client.getState();
                statuses[key] = state || 'DISCONNECTED';
            } catch {
                statuses[key] = 'DISCONNECTED';
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
// Cada request al dashboard trae el access_token (JWT) del usuario de Supabase
// Auth en `Authorization: Bearer <token>`. Verificamos el token contra Supabase,
// derivamos la organización del usuario desde `profiles` y la IMPUENTA en
// req.authOrgId. El header X-Organization-Id se ignora: la org sale SIEMPRE del
// token verificado, de modo que un usuario de una org no puede leer otra org
// aunque manipule el header. Caché en memoria corta para evitar un round-trip
// a Supabase por cada request.
const AUTH_CACHE_TTL_MS = 60 * 1000;
const authCache = new Map(); // token → { orgId, userId, exp }

// appointments.status → contacts.estado. Las dos tablas nombran lo mismo distinto y la ficha
// del contacto es la que leen los workers de recordatorio y reseña.
const ESTADO_CITA_A_CONTACTO = {
    confirmed: 'confirmado',
    completed: 'completado',
    cancelled: 'cancelado',
    no_show:   'cancelado',
};

async function requireApiAuth(req, res, next) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'Token requerido' });

    const cached = authCache.get(token);
    if (cached && cached.exp > Date.now()) {
        req.authOrgId = cached.orgId;
        req.authUserId = cached.userId;
        return next();
    }

    try {
        const session = await db.authenticateToken(token);
        if (!session) {
            authCache.delete(token);
            return res.status(401).json({ error: 'Token inválido' });
        }
        authCache.set(token, { orgId: session.orgId, userId: session.userId, exp: Date.now() + AUTH_CACHE_TTL_MS });
        req.authOrgId = session.orgId;
        req.authUserId = session.userId;
        next();
    } catch (e) {
        logger.error('api_auth_error', { error: e.message });
        return res.status(401).json({ error: 'Token inválido' });
    }
}

// La org SIEMPRE proviene del token verificado (nunca de un header del cliente).
function extractOrgId(req) {
    return req.authOrgId || DEFAULT_ORG;
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
        // El diálogo de cita manual manda siempre { nombre, telefono }. Si ese teléfono ya
        // existe, saveLead delega en updateLead y PISABA el nombre guardado con lo que se
        // acabara de teclear. Aquí el nombre solo rellena un hueco vacío; para renombrar a
        // alguien está PUT /api/leads/:id, que es la acción explícita de editar la ficha.
        const datos = { ...req.body };
        const existente = await db.findByPhone(orgId, datos.telefono);
        if (existente?.nombre && datos.nombre) delete datos.nombre;
        const id = await db.saveLead(orgId, datos);
        if (!id) return res.status(400).json({ error: 'No se pudo crear el contacto — verifica el teléfono' });
        const lead = await db.findById(orgId, id);
        if (!lead) return res.status(500).json({ error: 'Contacto creado pero no encontrado al releer' });
        res.status(201).json(lead);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/leads/:id', async (req, res) => {
    const orgId = extractOrgId(req);
    try {
        const lead = await db.updateLeadById(orgId, req.params.id, req.body);
        res.json(lead);
    } catch (e) {
        // Nunca devolver 200 con la fila sin modificar: el panel lo leería como "guardado".
        logger.error('lead_update_error', { orgId, leadId: req.params.id, error: e.message });
        res.status(500).json({ error: e.message });
    }
});

// Un borrado bloqueado por dinero registrado (RESTRICT de cobros.appointment_id, migración
// 035) llega como un 23503 de Postgres. Sin traducir, el panel enseñaría "insert or update on
// table ... violates foreign key constraint" y nadie sabría qué hacer con eso.
// 409 y no 500: no es un fallo del servidor, es una precondición que no se cumple.
function esBloqueoPorCobro(e) {
    const msg = String(e?.message || '');
    return e?.code === '23503' || msg.includes('23503') || msg.includes('cobros_appointment_id_fkey');
}

// Lo que el borrado se llevaría por delante, para que la confirmación del panel lo diga en vez
// de callarlo (Olga Yarmak, 11/08/2026: 30 mensajes por CASCADE, sin traza). Solo lectura, y
// NO condiciona el borrado: si esto falla, el panel avisa de que no ha podido contarlo y el
// botón de borrar sigue estando — informar no es bloquear.
app.get('/api/leads/:id/impacto-borrado', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        res.json(await db.contarImpactoBorrado(orgId, req.params.id));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leads/:id', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        await db.deleteLead(orgId, req.params.id);
        res.json({ ok: true });
    } catch (e) {
        if (esBloqueoPorCobro(e)) {
            return res.status(409).json({
                error: 'Este cliente tiene alguna cita con un cobro registrado en caja. '
                     + 'Anula primero esos cobros; si no, se borraría dinero ya contabilizado.',
            });
        }
        res.status(500).json({ error: e.message });
    }
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

// Informe de facturación por estilista (solo salón). Recalcula el importe de las citas
// COMPLETED del rango cruzando appointments.service contra el catálogo de precios.
// ?stylist= filtra por UNA estilista (UUID) o por el grupo sin estilista asignada.
app.get('/api/facturacion', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const hoy = new Date().toISOString().split('T')[0];
        const desde = req.query.desde || hoy;
        const hasta = req.query.hasta || hoy;
        const {
            buildStylistBillingReport, buildBillingStylistOptions, NO_STYLIST_KEY,
        } = require('./services/helpers');

        // Es dinero: un filtro mal escrito se rechaza en voz alta. Ignorarlo devolvería el
        // total de TODAS las estilistas presentado como el de una sola.
        const stylistParam = req.query.stylist;
        let stylistFiltro = null;
        if (stylistParam != null && stylistParam !== '' && stylistParam !== 'all') {
            const valido = stylistParam === NO_STYLIST_KEY ||
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(stylistParam));
            if (!valido) return res.status(400).json({ error: 'stylist inválido' });
            stylistFiltro = String(stylistParam);
        }

        const [citas, agentConfig, stylists] = await Promise.all([
            db.getCompletedAppointmentsForBilling(orgId, desde, hasta, stylistFiltro),
            db.getAgentConfig(orgId),
            db.getStylistsByOrg(orgId),
        ]);
        const report = buildStylistBillingReport(citas, agentConfig?.services || []);
        res.json({
            ...report,
            estilistasDisponibles: buildBillingStylistOptions(stylists, report.estilistas),
            stylistFiltro,
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fija o limpia A MANO el importe de una cita (solo salón). Dos usos: corregir un error y
// aplicar un descuento, que el catálogo no sabe representar.
//
// Ruta PROPIA y no un campo más de PUT /api/citas/:id, a propósito:
//   1. Ese PUT es también la ruta de San Remo y el panel manda el formulario ENTERO en cada
//      guardado — el dinero no puede viajar de polizón en una petición cuyo propósito es
//      "he movido la cita a las 11:30".
//   2. Mantiene mecánicamente el invariante: el dict `campos` de updateAppointment no tiene
//      ninguna clave de facturación, así que no hay forma de pisar un importe manual desde
//      la edición normal de la cita.
//
// body: { precio: number|null, motivo?: string }.  precio null limpia el importe manual;
// precio 0 es válido (cortesía) y por eso la validación no puede usar truthiness.
app.patch('/api/citas/:id/precio', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const { getOrgType } = require('./services/org-registry');
        if (getOrgType(orgId) !== 'salon') {
            return res.status(403).json({ error: 'El importe manual es solo para salón' });
        }

        const { precio, motivo } = req.body || {};
        if (precio !== null && precio !== undefined) {
            const n = Number(precio);
            // typeof: un "abc" da NaN pero un "150" pasaría — y aceptar strings aquí abre la
            // puerta a que el importe llegue como texto y se guarde sin validar de verdad.
            if (typeof precio !== 'number' || !Number.isFinite(n) || n < 0) {
                return res.status(400).json({ error: 'precio debe ser un número >= 0, o null para limpiar' });
            }
        }
        if (motivo != null && String(motivo).length > 300) {
            return res.status(400).json({ error: 'motivo demasiado largo (máx. 300)' });
        }

        const cita = await db.setManualPrice(orgId, req.params.id, {
            precio: precio === undefined ? null : precio,
            motivo: motivo == null ? null : String(motivo).trim() || null,
            // Del token verificado, NUNCA del body: la atribución de un cambio de dinero
            // tiene que ser de quien de verdad ha entrado.
            userId: req.authUserId || null,
        });
        if (!cita) return res.status(404).json({ error: 'No encontrada' });

        logger.info('precio_manual_actualizado', {
            orgId, citaId: req.params.id, precio: cita.precio_manual, userId: req.authUserId || null,
        });
        res.json(cita);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Caja (registro de cobros) ─────────────────────────────────────────
//
// Solo salón, igual que el importe manual: San Remo cobra con el flujo Bizum y no se toca.
function exigirSalon(req, res) {
    const orgId = extractOrgId(req);
    const { getOrgType } = require('./services/org-registry');
    if (getOrgType(orgId) !== 'salon') {
        res.status(403).json({ error: 'El registro de caja es solo para salón' });
        return null;
    }
    return orgId;
}

const FECHA_YMD = /^\d{4}-\d{2}-\d{2}$/;

// Lo que Facturación diría por esa cita, congelado en el cobro. Sale de resolveImporteReferencia
// (helpers), que es la MISMA precedencia que pinta el informe — no una segunda copia.
// null = de esa cita no hay contra qué comparar, y así se guarda: es lo que mantendrá fuera del
// descuadre a las citas sin servicio resoluble en vez de inventarles una referencia.
async function calcularImporteReferencia(orgId, appointmentId) {
    if (!appointmentId) return null;
    const { resolveImporteReferencia } = require('./services/helpers');
    const [cita, cfg] = await Promise.all([
        db.getAppointmentById(orgId, appointmentId),
        db.getAgentConfig(orgId),
    ]);
    if (!cita) return null;
    return resolveImporteReferencia(cita, cfg?.services || []);
}

// ─── PIN de atribución ──────────────────────────────────────────────────────
//
// Lo pone y lo cambia la DUEÑA. No hay recuperación: si una estilista lo olvida, se le pone
// otro. Un flujo de recuperación sería aparato de seguridad, y esto no es seguridad.

// Quién tiene PIN. Devuelve booleanos y fechas, JAMÁS hash ni salt.
app.get('/api/stylists/pin-status', async (req, res) => {
    try {
        const orgId = exigirSalon(req, res);
        if (!orgId) return;
        res.json(await db.getStylistPinStatus(orgId));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/stylists/:id/pin', async (req, res) => {
    try {
        const orgId = exigirSalon(req, res);
        if (!orgId) return;
        const { isValidPinFormat } = require('./services/pin');
        if (!isValidPinFormat(req.body?.pin)) {
            return res.status(400).json({ error: 'El PIN son 4 a 6 dígitos' });
        }
        const r = await db.setStylistPin(orgId, req.params.id, req.body.pin, { userId: req.authUserId || null });
        if (!r) return res.status(404).json({ error: 'Esa estilista no existe en este salón' });
        // El PIN NO se registra en el log, obviamente. Solo que se cambió y quién lo cambió.
        logger.info('pin_estilista_actualizado', { orgId, stylistId: req.params.id, userId: req.authUserId || null });
        res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/stylists/:id/pin', async (req, res) => {
    try {
        const orgId = exigirSalon(req, res);
        if (!orgId) return;
        const retirado = await db.clearStylistPin(orgId, req.params.id);
        // El `{ok:true}` era incondicional y el panel canta «PIN retirado» con él: sin esto,
        // un id que no casa (o de otra org) se anunciaba como retirado con el PIN aún puesto.
        if (!retirado) return res.status(404).json({ error: 'Esa estilista no tenía PIN' });
        logger.info('pin_estilista_retirado', { orgId, stylistId: req.params.id, userId: req.authUserId || null });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Abre sesión de caja: se teclea el PIN UNA vez y se cambia por un token corto y firmado.
// El PIN nunca se guarda en el navegador; lo que viaja luego en cada cobro es el token.
app.post('/api/caja/sesion', async (req, res) => {
    try {
        const orgId = exigirSalon(req, res);
        if (!orgId) return;
        const { stylistId, pin } = req.body || {};
        if (!stylistId) return res.status(400).json({ error: 'Elige primero quién cobra' });

        const ok = await db.verifyStylistPin(orgId, stylistId, pin);
        if (!ok) {
            // Mismo 401 para "PIN equivocado" y "esa estilista no tiene PIN": distinguirlos
            // enseñaría a quién se le puede atribuir sin más. Y el cobro NO depende de esto —
            // se puede registrar igual, como declarada.
            logger.warn('caja_pin_rechazado', { orgId, stylistId });
            return res.status(401).json({ error: 'PIN incorrecto' });
        }
        const { issueAttributionToken } = require('./services/pin');
        const minutos = Number(await db.getConfigValue(orgId, 'caja_pin_minutos')) || 30;
        const token = issueAttributionToken({ orgId, stylistId, minutos });
        logger.info('caja_sesion_abierta', { orgId, stylistId, minutos });
        res.json({ token, stylistId, minutos });
    } catch (e) {
        if (/DASHBOARD_API_SECRET/.test(e.message || '')) return res.status(500).json({ error: e.message });
        res.status(500).json({ error: e.message });
    }
});

// Decide la atribución de un cobro a partir del token que trae la petición.
//
// Devuelve SIEMPRE una atribución utilizable: el cobro nunca se bloquea por esto. Lo que
// cambia es de qué te puedes fiar, y el caso del token de OTRA estilista se registra aparte
// porque significa que alguien cambió el nombre en pantalla sin meter el PIN — que es
// exactamente lo que la columna existe para poder distinguir.
function resolverAtribucion(req, orgId, cobradoPor) {
    const token = req.get('X-Caja-Token') || req.body?.cajaToken || null;
    if (!token || !cobradoPor) return { atribucion: 'declarada', token: null };

    const { verifyAttributionToken, issueAttributionToken } = require('./services/pin');
    const sesion = verifyAttributionToken(token, { orgId });
    if (!sesion) return { atribucion: 'declarada', token: null };

    if (sesion.stylistId !== String(cobradoPor)) {
        // INFO y no WARN: desde que quién cobra se elige por cobro, que no coincida con el PIN
        // puesto es lo NORMAL —una atiende y cobra otra— y no una anomalía. Un aviso que salta
        // en el caso corriente deja de leerse, y entonces no avisa de nada. Se sigue registrando
        // porque es lo que explica por qué ese cobro quedó sin PIN.
        logger.info('caja_atribucion_desajustada', {
            orgId, tokenStylistId: sesion.stylistId, cobradoPor: String(cobradoPor),
            detalle: 'quien cobra no es la del PIN puesto; el cobro se registra sin PIN',
        });
        return { atribucion: 'declarada', token: null };
    }
    // Renovado en cada cobro: así la caducidad es por INACTIVIDAD de verdad y la controla el
    // servidor, no el reloj del navegador.
    let renovado = null;
    try { renovado = issueAttributionToken({ orgId, stylistId: sesion.stylistId }); } catch { /* sin secreto */ }
    return { atribucion: 'confirmada', token: renovado };
}

// Registra un cobro. `fechaCaja` solo se manda para imputar a propósito un cobro de madrugada
// a la jornada anterior; sin ella la decide el servidor en Europe/Madrid (db.diaDeCajaHoy).
app.post('/api/cobros', async (req, res) => {
    try {
        const orgId = exigirSalon(req, res);
        if (!orgId) return;
        const {
            appointmentId, contactId, cobradoPor, fechaCaja, metodo, importeTotal, importeEfectivo,
            concepto, motivoDiferencia, nota,
        } = req.body || {};

        if (fechaCaja != null && !FECHA_YMD.test(String(fechaCaja))) {
            return res.status(400).json({ error: 'La fecha del cobro no es válida' });
        }
        const { MOTIVOS_DIFERENCIA } = require('./services/helpers');
        if (motivoDiferencia != null && !MOTIVOS_DIFERENCIA.includes(motivoDiferencia)) {
            return res.status(400).json({ error: 'Ese motivo no es válido' });
        }
        if (!appointmentId && !concepto) {
            return res.status(400).json({ error: 'Escribe qué se ha vendido' });
        }
        // Saber DE QUIÉN es la venta no sustituye a saber QUÉ se vendió: `concepto` sigue
        // siendo obligatorio arriba. Y la clienta es opcional a propósito — entra gente de
        // paso, y exigir una ficha para vender un champú convertiría un cobro de 20 € en un
        // alta de cliente.
        if (contactId != null && typeof contactId !== 'string') {
            return res.status(400).json({ error: 'La clienta indicada no es válida' });
        }

        const atrib = resolverAtribucion(req, orgId, cobradoPor);
        const cobro = await db.createCobro(orgId, {
            appointmentId, contactId, cobradoPor, fechaCaja, metodo, importeTotal, importeEfectivo,
            concepto, motivoDiferencia, nota,
            importeReferencia: await calcularImporteReferencia(orgId, appointmentId),
            // Del token verificado, NUNCA del body: es dinero.
            userId: req.authUserId || null,
            atribucion: atrib.atribucion,
        });
        logger.info('cobro_registrado', {
            orgId, cobroId: cobro.id, metodo: cobro.metodo, total: cobro.importe_total,
            efectivo: cobro.importe_efectivo, fechaCaja: cobro.fecha_caja,
            atribucion: cobro.atribucion, userId: req.authUserId || null,
        });
        // El token renovado viaja de vuelta para que el cliente lo sustituya: la caducidad se
        // cuenta desde el ÚLTIMO cobro, no desde que se tecleó el PIN.
        res.status(201).json(atrib.token ? { ...cobro, cajaToken: atrib.token } : cobro);
    } catch (e) {
        // Los mensajes de normalizeCobroImportes están escritos para leerse; no son un 500.
        if (/inválid|mixto|efectivo|estilista|decir por qué/i.test(e.message || '')) {
            return res.status(400).json({ error: e.message });
        }
        res.status(500).json({ error: e.message });
    }
});

// Por defecto, los cobros que CUENTAN (vista cobros_vigentes). ?historial=1 devuelve también
// lo anulado y lo rectificado — que es para auditar, nunca para sumar.
app.get('/api/cobros', async (req, res) => {
    try {
        const orgId = exigirSalon(req, res);
        if (!orgId) return;
        const hoy = db.diaDeCajaHoy();
        const desde = req.query.desde || hoy;
        const hasta = req.query.hasta || desde;
        if (!FECHA_YMD.test(String(desde)) || !FECHA_YMD.test(String(hasta))) {
            return res.status(400).json({ error: 'Las fechas no son válidas' });
        }
        const opciones = { desde, hasta, appointmentId: req.query.citaId || null };
        if (req.query.historial === '1') {
            return res.json({ historial: true, cobros: await db.getCobrosHistorial(orgId, opciones) });
        }
        res.json({
            historial: false,
            cobros: await db.getCobrosVigentes(orgId, { ...opciones, stylistId: req.query.stylist || null }),
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lo que puede cobrarse hoy: las citas del día con su importe de referencia YA RESUELTO y con
// los cobros que ya tengan encima.
//
// La referencia se calcula aquí y no en el panel: `resolveImporteReferencia` es la misma
// precedencia que pinta Facturación, y duplicarla en el cliente daría dos opiniones sobre lo
// que vale una cita. El panel enseña cifras, no las decide.
//
// `stylist_id`/`atendio` (quién hizo el trabajo) viaja aparte de quién cobra: en un mostrador
// compartido difieren a menudo y la pantalla tiene que poder decir las dos cosas.
app.get('/api/caja/pendientes', async (req, res) => {
    try {
        const orgId = exigirSalon(req, res);
        if (!orgId) return;
        const fecha = req.query.fecha || db.diaDeCajaHoy();
        if (!FECHA_YMD.test(String(fecha))) {
            return res.status(400).json({ error: 'La fecha no es válida' });
        }

        const { resolveImporteReferencia } = require('./services/helpers');
        const [citas, cfg, cobros] = await Promise.all([
            db.getCitasDelDiaParaCaja(orgId, fecha),
            db.getAgentConfig(orgId),
            // Solo los VIGENTES: un cobro rectificado o anulado deja la cita otra vez por cobrar.
            db.getCobrosVigentes(orgId, { desde: fecha, hasta: fecha }),
        ]);
        const catalogo = cfg?.services || [];
        const cobradaPorCita = new Map();
        for (const c of cobros) {
            if (c.appointment_id) cobradaPorCita.set(c.appointment_id, c);
        }

        res.json({
            fecha,
            citas: citas.map(a => {
                const cobro = cobradaPorCita.get(a.id) || null;
                return {
                    appointment_id: a.id,
                    cliente: a.contacts?.full_name || null,
                    service: a.service,
                    starts_at: a.starts_at,
                    estado: a.status,
                    // Quién ATENDIÓ. Distinto de quién cobra, y a propósito.
                    atendio_id: a.stylist_id || null,
                    atendio: a.stylists?.name || null,
                    // null = de esta cita no hay contra qué comparar (servicio sin resolver).
                    // Se manda tal cual: inventar un 0 la metería en el descuadre.
                    importe_referencia: resolveImporteReferencia(a, catalogo),
                    cobro: cobro
                        ? { id: cobro.id, importe_total: cobro.importe_total, metodo: cobro.metodo, atribucion: cobro.atribucion }
                        : null,
                };
            }),
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resumen de caja de un día, por estilista, con el reparto CONFIRMADA / DECLARADA.
//
// Existe porque una columna `atribucion` que no se ve en ningún sitio no sirve de nada — y
// entonces el PIN tampoco. Es solo lectura: NO cierra el día ni escribe nada. Contar el cajón
// y fijar la diferencia es otra cosa, y está sin diseñar.
app.get('/api/caja/resumen', async (req, res) => {
    try {
        const orgId = exigirSalon(req, res);
        if (!orgId) return;
        const fecha = req.query.fecha || db.diaDeCajaHoy();
        if (!FECHA_YMD.test(String(fecha))) {
            return res.status(400).json({ error: 'fecha debe ser YYYY-MM-DD' });
        }
        const { buildCajaResumen } = require('./services/helpers');
        const [cobros, stylists] = await Promise.all([
            // De la VISTA: qué cobro cuenta lo decide la 035 y nadie más.
            db.getCobrosVigentes(orgId, { desde: fecha, hasta: fecha }),
            db.getStylistsByOrg(orgId),
        ]);
        res.json({ fecha, ...buildCajaResumen(cobros, { stylists }) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Dar el día por revisado (migración 039) ─────────────────────────────────
//
// Sustituye al WhatsApp que la recepcionista manda cada noche con el efectivo, el TPV y el
// total. NO es un cierre contable: es un ACUSE de que alguien ha mirado el día. La diferencia
// se apunta si la hay y no se pide justificarla — "nunca falta dinero", dijo la dueña, y un
// formulario que exija explicar un descuadre es un formulario que se deja de usar.
//
// Asíncrono por diseño: el TPV no está en el banco hasta el día siguiente, así que lo normal es
// revisar hoy el día de ayer.

// Estado de un día: lo que suman sus cobros AHORA, su acuse si lo tiene, y si se ha MOVIDO
// desde que se revisó. No escribe nada.
app.get('/api/caja/cierre', async (req, res) => {
    try {
        const orgId = exigirSalon(req, res);
        if (!orgId) return;
        const fecha = req.query.fecha || db.diaDeCajaHoy();
        if (!FECHA_YMD.test(String(fecha))) {
            return res.status(400).json({ error: 'La fecha no es válida' });
        }
        const { buildCajaResumen, buildEstadoDiaRevisado } = require('./services/helpers');
        const [cobros, cierre] = await Promise.all([
            db.getCobrosVigentes(orgId, { desde: fecha, hasta: fecha }),
            db.getCierreDelDia(orgId, fecha),
        ]);
        res.json({ fecha, ...buildEstadoDiaRevisado(buildCajaResumen(cobros), cierre) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// La cola: días CON dinero que nadie ha revisado, del más antiguo primero. Es lo que responde
// de un vistazo a "¿me falta algún día por mirar?".
app.get('/api/caja/cierre/pendientes', async (req, res) => {
    try {
        const orgId = exigirSalon(req, res);
        if (!orgId) return;
        res.json({ dias: await db.getDiasSinRevisar(orgId) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Registrar el acuse. Lo ESPERADO no se acepta del cliente: se lee aquí y se congela, o el
// acuse afirmaría lo que la pantalla creía en vez de lo que hay.
app.post('/api/caja/cierre', async (req, res) => {
    try {
        const orgId = exigirSalon(req, res);
        if (!orgId) return;
        const { fecha, contadoEfectivo, tpvDeclarado, nota, corrigeA, motivoCorreccion } = req.body || {};
        if (!FECHA_YMD.test(String(fecha || ''))) {
            return res.status(400).json({ error: 'La fecha no es válida' });
        }
        // Un día del FUTURO no se puede haber revisado. Hoy sí se permite —a veces se cuadra la
        // caja al cerrar el salón— aunque la pantalla proponga ayer.
        if (fecha > db.diaDeCajaHoy()) {
            return res.status(400).json({ error: 'Ese día todavía no ha pasado' });
        }
        const numeros = { contadoEfectivo, tpvDeclarado };
        for (const [campo, v] of Object.entries(numeros)) {
            const n = Number(v);
            if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n < 0) {
                return res.status(400).json({ error: `Escribe ${campo === 'contadoEfectivo' ? 'el efectivo contado' : 'el importe del TPV'}` });
            }
        }
        if (corrigeA && !String(motivoCorreccion || '').trim()) {
            return res.status(400).json({ error: 'Di por qué se vuelve a revisar' });
        }

        const cierre = await db.createCierre(orgId, {
            fecha,
            contadoEfectivo: Number(contadoEfectivo),
            tpvDeclarado: Number(tpvDeclarado),
            nota: nota || null,
            corrigeA: corrigeA || null,
            motivoCorreccion: motivoCorreccion || null,
            // Del token verificado. Hoy identifica poco (login compartido) y así está dicho en
            // la 039, pero inventarlo desde el body sería peor.
            userId: req.authUserId || null,
        });
        logger.info('caja_dia_revisado', {
            orgId, fecha, cierreId: cierre.id,
            difEfectivo: cierre.diferencia_efectivo, difTarjeta: cierre.diferencia_tarjeta,
            corrigeA: cierre.corrige_a || null, userId: req.authUserId || null,
        });
        res.status(201).json(cierre);
    } catch (e) {
        // El índice único es la conducta esperada, no un 500: alguien ha revisado ese día
        // mientras esta pantalla estaba abierta.
        if (/cierres_un_acuse_por_dia|duplicate key/i.test(e.message || '')) {
            return res.status(409).json({ error: 'Ese día ya está revisado. Recarga para verlo.' });
        }
        res.status(500).json({ error: e.message });
    }
});

// Rectificar: una sola escritura, el sucesor anula al anterior. Ruta propia y no un PUT sobre
// el cobro, porque un cobro NO se edita — el trigger de la 035 lo impide en la base.
app.post('/api/cobros/:id/rectificar', async (req, res) => {
    try {
        const orgId = exigirSalon(req, res);
        if (!orgId) return;
        const { motivoCorreccion } = req.body || {};
        if (!motivoCorreccion || !String(motivoCorreccion).trim()) {
            return res.status(400).json({ error: 'Di por qué se corrige: sin motivo, la rectificación no explica nada' });
        }
        const original = await db.getCobroById(orgId, req.params.id);
        if (!original) return res.status(404).json({ error: 'No encontrado' });

        const cobro = await db.rectifyCobro(orgId, req.params.id, {
            ...req.body,
            motivoCorreccion: String(motivoCorreccion).trim(),
            // Afirmación NUEVA, no heredada: la hace quien rectifica, ahora.
            atribucion: resolverAtribucion(
                req, orgId, req.body?.cobradoPor !== undefined ? req.body.cobradoPor : original.cobrado_por,
            ).atribucion,
            // Si cambia la cita, la referencia se recalcula; si no, se hereda.
            importeReferencia: req.body?.appointmentId !== undefined
                ? await calcularImporteReferencia(orgId, req.body.appointmentId)
                : undefined,
            userId: req.authUserId || null,
        });
        logger.info('cobro_rectificado', {
            orgId, corrigeA: req.params.id, cobroId: cobro.id, userId: req.authUserId || null,
        });
        res.status(201).json(cobro);
    } catch (e) {
        if (/inválid|mixto|efectivo|anulado|decir por qué/i.test(e.message || '')) {
            return res.status(400).json({ error: e.message });
        }
        res.status(500).json({ error: e.message });
    }
});

// Anular SIN sustituto: "esto no se llegó a cobrar". Distinto de rectificar, que sí lo tiene.
app.post('/api/cobros/:id/anular', async (req, res) => {
    try {
        const orgId = exigirSalon(req, res);
        if (!orgId) return;
        const cobro = await db.anularCobro(orgId, req.params.id, {
            motivo: req.body?.motivo ? String(req.body.motivo).trim() : null,
            userId: req.authUserId || null,
        });
        // null = no existe en esta org, o ya estaba anulado. Las dos son un 404 honesto: no hay
        // nada que anular. Nunca un 200 sobre una escritura que no ocurrió.
        if (!cobro) return res.status(404).json({ error: 'No encontrado, o ya estaba anulado' });
        logger.info('cobro_anulado', { orgId, cobroId: cobro.id, userId: req.authUserId || null });
        res.json(cobro);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// La duración es la que ocupa la agenda: db.js ya no la rellena con un 120 por
// defecto, así que ausente significa cita no guardada. Validarla aquí es lo que
// convierte ese rechazo en un mensaje que se entiende, en vez de un 500 genérico
// (POST) o un "No encontrada" que no tiene nada que ver (PUT).
function validarDuracion(duracionMin) {
    const dur = Number(duracionMin);
    if (Number.isFinite(dur) && dur > 0) return null;
    return `Duración inválida (${JSON.stringify(duracionMin ?? null)}). Indica los minutos que ocupa la cita.`;
}

app.post('/api/appointments', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const { contactId, servicio, fecha, hora, duracionMin, stylistId, notas, personas, ocasion, noFacturable } = req.body;
        if (!contactId || !fecha) return res.status(400).json({ error: 'contactId y fecha requeridos' });

        // Una cita creada a mano DICE qué servicio es, o dice que no se cobra. No hay tercera
        // opción, y esa es toda la regla.
        //
        // Antes el panel rellenaba `servicio` con el literal 'Cita manual' cuando se dejaba en
        // blanco, y esa cita quedaba sin importe de referencia y en «pendientes de cobrar» para
        // siempre. Hoy hay tres así en la agenda de Sante —y ni siquiera son citas: son
        // bloqueos con una clienta inventada—. Exigir servicio a secas obligaría a inventárselo
        // el día que haya algo fuera de catálogo, así que la casilla es el escape explícito.
        const { getOrgType: tipoOrg } = require('./services/org-registry');
        if (tipoOrg(orgId) === 'salon' && !noFacturable && !String(servicio || '').trim()) {
            return res.status(400).json({
                error: 'Dime qué servicio es. Si esta cita no se va a cobrar, márcala como "no se cobra".',
            });
        }
        if (hora != null && hora !== '' && !/^\d{1,2}:\d{2}$/.test(String(hora).trim())) {
            return res.status(400).json({ error: `Hora inválida ("${hora}"). Usa el formato HH:MM` });
        }
        const durErr = validarDuracion(duracionMin);
        if (durErr) return res.status(400).json({ error: durErr });
        const apt = await db.saveAppointment(orgId, contactId, { servicio, fecha, hora, duracionMin, notas, personas, ocasion, stylistId, source: 'manual', noFacturable: !!noFacturable });
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
        // Solo cuando se MUEVE la cita: es la única rama que recalcula ends_at. Un PUT
        // que solo cambia estado/notas no tiene por qué traer duración.
        if (req.body?.fecha !== undefined && req.body?.hora !== undefined) {
            const durErr = validarDuracion(req.body.duracionMin);
            if (durErr) return res.status(400).json({ error: durErr });
        }
        // Estado ANTERIOR: hace falta para no contar dos veces la misma visita si la cita ya
        // estaba completada (el worker de auto-completar pudo adelantarse al panel).
        const previo = await db.getAppointmentById(orgId, req.params.id);
        // El actor sale del token ya verificado, nunca del body: es la firma de quién movió
        // la cita, y una firma que puede escribir el cliente no vale para nada.
        const apt = await db.updateAppointment(orgId, req.params.id, {
            ...req.body, actor: `panel:${req.authUserId || 'desconocido'}`,
        });
        if (!apt) return res.status(404).json({ error: 'No encontrada' });

        // La ficha del contacto es la que lee reminder.js (no `appointments`), así que mover una
        // cita desde el panel sin actualizarla mandaba el recordatorio con la hora antigua.
        // POST /api/appointments ya lo hacía; el PUT no.
        if (apt.contact_id) {
            const sync = {};
            if (req.body.fecha !== undefined) sync.fecha_cita = req.body.fecha;
            if (req.body.hora !== undefined) sync.hora_cita = req.body.hora || null;
            const estadoContacto = ESTADO_CITA_A_CONTACTO[req.body.estado];
            if (estadoContacto) sync.estado_cita = estadoContacto;
            if (Object.keys(sync).length) {
                try {
                    await db.updateLeadById(orgId, apt.contact_id, sync);
                } catch (e) {
                    logger.error('error_sync_contacto_cita', { orgId, citaId: req.params.id, error: e.message });
                }
            }
        }

        if ((req.body.noShow === true || req.body.estado === 'no_show') && apt.contact_id) {
            // Aislado, por lo mismo que `stampBillingSnapshot` veinte líneas más abajo: el
            // UPDATE de la cita YA tuvo éxito y el panel merece su 200. Sin este try, un
            // `setBlacklist` fallido —lanza desde julio, verifica filas— devolvía 500 sobre
            // un no-show que sí quedó escrito, y la pantalla decía que no se pudo.
            //
            // Pero no se queda en un log: el bloqueo es la mitad de lo que se pidió al marcar
            // el no-show, y perderlo en silencio deja a alguien que no vino recibiendo
            // campañas y recordatorios como si nada. Por eso avisa.
            try {
                const noShowContact = await db.findById(orgId, apt.contact_id);
                await db.setBlacklist(orgId, apt.contact_id, 'No-show');
                notifyBlacklistAlert(orgId, { nombre: noShowContact?.nombre, telefono: noShowContact?.telefono, blacklist_reason: 'No-show' }).catch(() => {});
            } catch (e) {
                logger.error('error_noshow_blacklist', { orgId, citaId: req.params.id, contactId: apt.contact_id, error: e.message });
                await alertOnce(orgId, `noshow_blacklist|${apt.contact_id}`,
                    '⚠️ <b>No-show sin bloquear</b>\n\n'
                    + 'He marcado la cita como "no vino", pero no he podido añadir a esa clienta '
                    + 'a la lista negra.\n\n'
                    + 'La cita está bien. Lo que NO ha pasado es el bloqueo: le seguirán llegando '
                    + 'campañas, recordatorios y peticiones de reseña. Puedes bloquearla a mano '
                    + 'desde Lista negra.\n\n'
                    + `Detalle técnico: ${e.message}`).catch(() => {});
            }
        }

        if (req.body.estado === 'completed' && apt.contact_id && previo?.status !== 'completed') {
            // La sugerencia VIP es un efecto secundario: desde que createPendingAction lanza
            // ante un error de Supabase (ver assertWrite en db.js), un fallo aquí devolvería
            // un 500 en una petición cuyo UPDATE de la cita YA tuvo éxito. Se aísla para que
            // el panel siga viendo el 200 que le corresponde; el fallo queda en los logs.
            // Congelar el importe: la cita acaba de entrar en la facturación.
            // No propaga (el UPDATE de la cita ya tuvo éxito y el panel merece su 200), pero
            // tampoco se queda en un log: sin snapshot, el informe recalcula con los precios
            // de hoy y una subida de tarifa reescribiría un periodo cerrado sin dejar rastro.
            // El aviso de "selladas 0 de N" lo manda stampBillingSnapshot; aquí se cubre el
            // caso en que ni siquiera llegó a intentarlo.
            try {
                await db.stampBillingSnapshot(orgId, [apt.id]);
            } catch (e) {
                logger.error('error_snapshot_facturacion', { orgId, citaId: apt.id, error: e.message });
                await alertOnce(orgId, `snapshot_facturacion|${new Date().toISOString().slice(0, 10)}`,
                    '⚠️ <b>Importes sin congelar</b>\n\n'
                    + 'Al marcar una cita como completada no he podido guardar su importe.\n\n'
                    + 'La cita está bien y el informe sigue saliendo, pero calculado con los '
                    + 'precios de HOY: si alguien cambia una tarifa, ese periodo cambiará con ella.\n\n'
                    + `Detalle técnico: ${e.message}`).catch(() => {});
            }
            try {
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
            } catch (e) {
                logger.error('error_vip_suggestion', { orgId, contactId: apt.contact_id, error: e.message });
            }
        }

        res.json(apt);
    } catch (e) {
        if (e?.code === 'PGRST116') return res.status(404).json({ error: 'No encontrada' });
        res.status(500).json({ error: e.message });
    }
});

// Cancela (soft-delete), NO borra. Un DELETE físico destruía el histórico de facturación de
// forma irreversible; el panel ya cancelaba en la práctica (el botón "eliminar" manda
// PUT {estado:'cancelled'}), así que esta ruta solo quedaba como un pie de cañón.
// Para borrar de verdad está db.deleteAppointment, sin exponer por HTTP.
app.delete('/api/citas/:id', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const apt = await db.updateAppointment(orgId, req.params.id, {
            estado: 'cancelled', actor: `panel:${req.authUserId || 'desconocido'}`,
        });
        if (!apt) return res.status(404).json({ error: 'No encontrada' });
        if (apt.contact_id) {
            try {
                await db.updateLeadById(orgId, apt.contact_id, { estado_cita: 'cancelado' });
            } catch (e) {
                logger.error('error_sync_contacto_cita', { orgId, citaId: req.params.id, error: e.message });
            }
        }
        res.json({ ok: true, cancelled: true });
    } catch (e) {
        // PGRST116 = el .single() de updateAppointment no encontró la fila.
        if (e?.code === 'PGRST116') return res.status(404).json({ error: 'No encontrada' });
        res.status(500).json({ error: e.message });
    }
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
        await resolveBizumResult(pending, !!confirmado, { actor: `panel:${req.authUserId || 'desconocido'}` });
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
        const { mensaje, plantillaClave, campaignKey, limit } = req.body;
        if (!mensaje && !plantillaClave) {
            return res.status(400).json({ error: 'mensaje o plantillaClave requerido' });
        }
        const client = getOutboundClient(orgId);
        if (!client) return res.status(503).json({ error: 'WhatsApp no conectado' });
        const vips = await db.getVipList(orgId, { excludeBlacklisted: true });

        const { runBroadcast } = require('./services/broadcast');
        const resumen = await runBroadcast(orgId, {
            client,
            destinatarios: vips,
            mensaje: mensaje || null,
            plantillaClave: plantillaClave || null,
            campaignKey: campaignKey || null,
            limit: Number.isFinite(limit) ? limit : null,
        });
        res.json(resumen);
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

/**
 * Envío masivo por tandas.
 *
 * `plantillaClave` sustituyó al antiguo `templateName` (nombre crudo de plantilla) a
 * propósito y SIN vía degradada: un nombre suelto no puede elegir idioma, así que habría
 * mandado la plantilla española a las clientas ru/uk. La clave apunta a un mapa por idioma
 * en `config`, igual que plantilla_recordatorio y plantilla_resena.
 *
 * `campaignKey` es lo que permite continuar mañana donde se dejó hoy: sin ella no hay
 * registro ni deduplicación (comportamiento histórico, el que conserva San Remo).
 */
app.post('/api/campaigns/broadcast', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const { mensaje, audience = 'todos', plantillaClave, campaignKey, phones, limit } = req.body;

        if (!mensaje && !plantillaClave) {
            return res.status(400).json({ error: 'mensaje o plantillaClave requerido' });
        }

        // phones: allowlist explícito de teléfonos (prueba segura). Si viene, apunta
        // SOLO a esos números e ignora la audiencia.
        const destinatarios = await db.getBroadcastRecipients(orgId, { audience, phones });

        const client = getOutboundClient(orgId);
        if (!client) return res.status(503).json({ error: 'WhatsApp no conectado' });

        const { runBroadcast } = require('./services/broadcast');
        const resumen = await runBroadcast(orgId, {
            client,
            destinatarios,
            mensaje: mensaje || null,
            plantillaClave: plantillaClave || null,
            campaignKey: campaignKey || null,
            limit: Number.isFinite(limit) ? limit : null,
        });
        res.json(resumen);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * Estado de una campaña SIN enviar nada: cuántos faltan y cuánto cupo queda hoy.
 * El panel lo pinta antes de lanzar la tanda, para que la dueña no dispare a ciegas.
 */
app.get('/api/campaigns/status', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const { audience = 'todos', campaignKey } = req.query;
        const { MAX_DESTINATARIOS_24H } = require('./services/broadcast');

        const { destinatarios, excluidos } = await db.getBroadcastAudience(orgId, { audience });
        const yaEnviados = campaignKey ? await db.getBroadcastSentPhones(orgId, campaignKey) : new Set();
        const pendientes = destinatarios.filter(c => !yaEnviados.has(db.sanitizePhone(c.telefono)));
        const enviados24h = await db.countBroadcastSendsLast24h(orgId);
        const cupo = Math.max(0, MAX_DESTINATARIOS_24H - enviados24h);

        // A quién NO le va a llegar, y por qué, ANTES de disparar. No es un adorno: entre los
        // excluidos hay clientas reales con cita cuyo teléfono está mal escrito, y una campaña
        // que las salta en silencio deja el problema exactamente donde estaba. Con el nombre
        // delante, alguien puede llamarlas. Van los datos crudos (teléfono, nombre, código de
        // motivo) y el recuento por motivo; el texto lo pone el panel.
        const porMotivo = {};
        for (const c of excluidos) porMotivo[c.motivo] = (porMotivo[c.motivo] || 0) + 1;

        res.json({
            total_audiencia: destinatarios.length,
            ya_enviados: yaEnviados.size,
            pendientes: pendientes.length,
            enviados_24h: enviados24h,
            cupo_24h_restante: cupo,
            proxima_tanda: Math.min(pendientes.length, cupo),
            max_por_24h: MAX_DESTINATARIOS_24H,
            excluidos: excluidos.map(c => ({ telefono: c.telefono, nombre: c.nombre, motivo: c.motivo })),
            excluidos_por_motivo: porMotivo,
        });
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
        // Un número mal escrito aquí no se queda en el panel: `horas_recordatorio` alimenta
        // la única guarda que decide a qué citas les toca el recordatorio, y un valor no
        // numérico la desarma entera (`Number('24 horas')` es NaN, y `x > NaN` es false), así
        // que se mandaría el recordatorio de TODAS las citas futuras de golpe. Se rechaza al
        // escribir, con el mensaje que hay que enseñarle a quien lo está editando.
        const check = validateConfigValue(req.params.clave, req.body.valor);
        if (!check.ok) {
            logger.warn('config_valor_rechazado', {
                orgId, clave: req.params.clave, valor: String(req.body.valor).slice(0, 40), motivo: check.motivo,
            });
            return res.status(400).json({ error: check.mensaje, clave: req.params.clave, motivo: check.motivo });
        }
        // Se guarda NORMALIZADO: el '24' del formulario entra como 24 y ningún lector tiene
        // que volver a adivinar de qué tipo era.
        await db.setConfigValue(orgId, req.params.clave, check.valor);
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

// Catálogo de servicios para desplegables del panel (alta/edición manual de citas).
// `fullName` usa el MISMO buildFullServiceName que resuelve las citas del bot y la
// facturación por estilista, para que el nombre guardado desde el panel case exacto
// contra el catálogo (ver auditoría de facturación: nombres ambiguos como "Largo 2").
//
// Por defecto devuelve solo los OFERTABLES: es lo que quiere el desplegable de una cita
// NUEVA. `?incluirInactivos=1` devuelve también los dados de baja, con `activo:false` en
// cada entrada, y eso es lo que necesita el formulario de EDITAR una cita existente: si un
// servicio de baja desapareciera de esa lista, abrir una cita antigua mostraría el campo
// de servicio vacío y guardarla lo borraría. Es el mismo principio de siempre — se filtra
// donde se ofrece, nunca donde se resuelve algo que ya está guardado.
app.get('/api/service-catalog', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const { buildFullServiceName, offerableCatalog, isServiceActive } = require('./services/helpers');
        const incluirInactivos = req.query.incluirInactivos === '1' || req.query.incluirInactivos === 'true';
        const agentConfig = await db.getAgentConfig(orgId);
        const completo = Array.isArray(agentConfig?.services) ? agentConfig.services : [];
        // buildFullServiceName recibe SIEMPRE el catálogo completo: decide si un nombre es
        // ambiguo contando cuántas entradas lo comparten, y contar sobre la lista filtrada
        // haría que un "Largo 2" dejara de prefijarse con su categoría en cuanto se diera de
        // baja a uno de sus hermanos. El nombre guardado cambiaría por un motivo que no
        // tiene nada que ver con él.
        const catalog = incluirInactivos ? completo : offerableCatalog(completo);
        const entries = catalog.map(svc => ({
            key: `${svc.categoria || ''}|${svc.nombre || ''}`,
            activo: isServiceActive(svc),
            nombre: svc.nombre,
            categoria: svc.categoria ?? null,
            precio: svc.precio ?? null,
            duracion: svc.duracion ?? 60,
            fullName: buildFullServiceName(svc, completo),
        }));
        res.json(entries);
    } catch (e) { res.status(500).json({ error: e.message }); }
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
        // `pausarBot` (por defecto true): escribir a mano en un chat significa que una
        // persona está atendiendo, así que el bot se aparta de ESA conversación — y solo
        // de esa. El 01/08/2026 Yulia escribió a Valeria y el bot, que seguía en 'auto',
        // volvió a hablar encima ("Nos vemos pronto" a una clienta sin cita). Reactivarlo
        // es explícito: el botón del propio chat.
        //
        // La excepción es el mensaje de reactivación tras quitar de lista negra, que acaba
        // de poner bot_mode='auto' a propósito: ese pasa pausarBot=false para no deshacerlo.
        const { telefono, mensaje, pausarBot = true } = req.body;
        if (!telefono || !mensaje) return res.status(400).json({ error: 'telefono y mensaje requeridos' });
        const client = getOutboundClient(orgId);
        if (!client) return res.status(503).json({ error: 'WhatsApp no conectado — reconecta el bot e inténtalo de nuevo' });
        const { findOriginalJid, waSendMessage, isTransientWAError, extractSentMessageId } = require('./bot');
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
        let enviado = null;
        try {
            // waSendMessage reintenta con backoff ante errores transitorios de frame (bug 7).
            enviado = await waSendMessage(client, userPhone, mensaje, { orgId });
        } catch (waErr) {
            const msg = String(waErr?.message || waErr || '');
            if (msg.includes('LID')) {
                const altJid = findOriginalJid(orgId, digits) || `${digits}@lid`;
                if (altJid && altJid !== userPhone) {
                    logger.info('wa_send_lid_retry', { orgId, telefono, altJid });
                    enviado = await waSendMessage(client, altJid, mensaje, { orgId });
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
        await db.saveMessage(orgId, {
            telefono: digits, contenido: mensaje, direccion: 'saliente', esManual: true,
            waMessageId: extractSentMessageId(enviado),
        });

        // Solo si el envío salió bien: si falló, la persona no ha atendido a nadie y no
        // tiene sentido dejar el bot apagado en esa conversación. Mismo par de llamadas que
        // PUT /api/leads/:id/bot-mode — el estado vive en Supabase (setLeadBotMode) y en la
        // sesión en memoria/SQLite (_setConvMode), y desincronizarlos deja al bot
        // respondiendo hasta el siguiente reinicio.
        let botPausado = false;
        if (pausarBot) {
            try {
                await db.setLeadBotMode(orgId, digits, 'manual');
                if (_setConvMode) _setConvMode(digits, false);
                botPausado = true;
                logger.info('bot_pausado_por_envio_manual', { orgId, telefono: digits });
            } catch (e) {
                // El mensaje ya se envió: no se devuelve error, pero hay que poder verlo.
                logger.error('bot_pausar_tras_envio_error', { orgId, telefono: digits, error: e.message });
            }
        }
        res.json({ ok: true, botPausado });
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

// Pide la reseña de VERDAD y solo entonces marca la cita.
//
// Hasta el 06/08/2026 esta ruta se llamaba `send` y no enviaba nada: ponía
// `resena_enviada = true` y devolvía {ok:true}, y el panel cantaba "Reseña enviada". Y como
// la cola del worker filtra por `resena_enviada = false`, el clic sacaba la cita también de
// ahí: pulsar el botón era la forma más eficaz de garantizar que esa reseña no se pidiera
// nunca. Cinco reseñas reales se perdieron así entre el 01 y el 05/08/2026.
//
// Ahora el envío pasa por el MISMO embudo que el worker (review.sendReviewForAppointment),
// y cada motivo de no-envío tiene su código: el operador tiene que poder distinguir "esa
// cita ya no está pendiente" de "WhatsApp no está conectado".
app.post('/api/reviews/:appointmentId/send', async (req, res) => {
    try {
        const orgId = extractOrgId(req);
        const client = getOutboundClient(orgId);
        if (!client) return res.status(503).json({ error: 'WhatsApp no conectado' });

        const { sendReviewForAppointment } = require('./services/review');
        const r = await sendReviewForAppointment(orgId, req.params.appointmentId, {
            client, actor: `panel:${req.authUserId || 'desconocido'}`,
        });

        if (!r.ok) {
            const HTTP = {
                no_pendiente:  [404, 'Esa cita ya no está pendiente de reseña'],
                sin_enlace:    [409, 'Falta el enlace de reseñas de Google en la configuración'],
                sin_telefono:  [422, 'La clienta no tiene un teléfono utilizable'],
                sin_plantilla: [409, 'Fuera de la ventana de 24 h y sin plantilla de reseña configurada'],
                fallo:         [502, 'No se pudo enviar el mensaje por WhatsApp'],
            };
            const [codigo, mensaje] = HTTP[r.motivo] || [502, 'No se pudo enviar la reseña'];
            return res.status(codigo).json({ error: mensaje, motivo: r.motivo });
        }

        // `registrado:false` = salió pero no se pudo marcar. Se responde 200 a propósito: un
        // error haría que el operador volviera a pulsar y la clienta recibiera dos peticiones
        // de reseña. El worker podría repetirla; es el mal menor y queda en el log.
        res.json({ ok: true, registrado: r.registrado !== false });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// ENLACE PÚBLICO DE RESERVA — la primera superficie SIN SESIÓN del proyecto
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// Cuatro rutas, y ni una más: catálogo, días con hueco, huecos de un día, y la reserva.
//
// ── LA FORMA, que es la mitad de la seguridad ────────────────────────────────────────────
//
//   navegador → Route Handler del Next (Vercel) → ESTAS RUTAS (Railway)
//
// El navegador de la clienta NUNCA habla con Railway. Eso trae dos cosas gratis: no hay que
// abrir el CORS de arriba a un origen público (la petición la hace un servidor, y CORS es
// cosa de navegadores) y la URL de la API no aparece en el HTML de nadie.
//
// Pero «el navegador no la conoce» NO es una protección: estas rutas están en internet y
// quien descubra el dominio de Railway puede llamarlas. Por eso hay un SECRETO compartido,
// con el precedente que ya existe en este mismo fichero (`/webhook/360dialog/:token`, que es
// server-to-server igual que esto y se protege igual).
//
// Van FUERA de `/api`, así que no pasan por `requireApiAuth` — que es justo lo que se quiere:
// no hay usuario que autenticar. Y por estar fuera, el orden de registro respecto a
// `app.use('/api', ...)` da igual.
//
// ── LO QUE NO PUEDE SALIR ────────────────────────────────────────────────────────────────
//
// Todo lo que se devuelve pasa por una proyección de `services/reserva-web.js` que ENUMERA
// campos. Nunca se esparce un objeto de la base de datos ni una entrada del catálogo: lo que
// hay dentro de `agent_configs.services` lo edita la dueña desde el panel, y el día que
// apunte ahí una nota interna, un spread la publicaría sin que nadie tocara una línea.
//
// Y los errores se traducen: un `e.message` de Supabase a una página pública puede llevar el
// nombre de una tabla, una constraint o un fragmento de fila.

const {
    MOTIVOS, respuestaNo, resolverLimites, crearLimitador, interpretarMotivoSql,
    catalogoPublico, diasPublicos, huecosPublicos, reservaPublica,
    limpiarUnaLinea, idiomaValido, MAX_NOTAS, MAX_NOMBRE, FECHA_RE, HORA_RE, UUID_RE,
} = require('./services/reserva-web');
const { resolveOrgBySlug } = require('./services/org-registry');

// El secreto que prueba que la petición viene de NUESTRO Next y no de un curl. Sin él
// configurado las rutas responden 404 a todo: una superficie pública a medio configurar se
// queda cerrada, nunca abierta (mismo criterio que `require360Token`).
const RESERVA_WEB_TOKEN = process.env.RESERVA_WEB_TOKEN || '';

// UN limitador para todo el proceso. Vive aquí y no en el Next porque Vercel es serverless:
// allí cada invocación puede caer en una instancia nueva y un contador en RAM no contaría
// nada. Aquí es un proceso largo, el mismo que ya sostiene `authCache`.
//
// SE VA CON CADA DESPLIEGUE, y hay que saberlo: para una ventana de una hora es asumible
// —el hueco mayor entre dos deploys en 30 días fue de 1,88 días— pero significa que un
// reinicio perdona a quien estuviera pegando. Lo que NO puede irse con el deploy es el tope
// de citas por clienta, y por eso ése lo cuenta Postgres dentro de `reservar_hueco()`.
const limitadorReservas = crearLimitador();

// 404 idéntico para TODO lo que no se puede atender: slug que no existe, org que no es
// salón (San Remo), y token ausente o equivocado. Si distinguiéramos unos de otros,
// cualquiera podría enumerar qué negocios hay en el sistema probando slugs — y sabría
// además cuál tiene el enlace encendido.
function noHayNada(res) {
    return res.status(404).json({ ok: false, motivo: 'no_encontrado' });
}

function tokenReservaValido(req) {
    if (!RESERVA_WEB_TOKEN) return false;
    const enviado = req.headers['x-reserva-token'];
    if (typeof enviado !== 'string' || !enviado) return false;
    try {
        const a = Buffer.from(enviado);
        const b = Buffer.from(RESERVA_WEB_TOKEN);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
}

/**
 * La IP de la CLIENTA, que es la que hay que limitar.
 *
 * `req.ip` aquí es la de Vercel: todas las clientas compartirían un cupo de 3/h y la primera
 * dejaría fuera a las demás. Así que el Next la reenvía en una cabecera.
 *
 * Y esa cabecera solo se cree DESPUÉS de que la petición haya probado el secreto — quien lo
 * tenga puede falsear la IP, pero quien lo tenga puede hacer cosas peores, así que no añade
 * superficie. Lo que sí sería un agujero es leer `X-Forwarded-For` a pelo sin secreto: ahí
 * cualquiera se salta el límite cambiando una cabecera.
 *
 * Sin IP utilizable NO se inventa una clave: se usa una compartida, que es el lado seguro
 * (limita de más, nunca de menos).
 */
function ipDeLaClienta(req) {
    const cabecera = req.headers['x-cliente-ip'];
    const ip = typeof cabecera === 'string' ? cabecera.trim().slice(0, 64) : '';
    return ip || 'sin-ip';
}

/**
 * Resuelve el contexto de una petición pública, o responde y devuelve null.
 *
 * Hace las tres puertas en el orden que importa: secreto → slug/tipo de org → interruptor.
 * El interruptor va el ÚLTIMO porque su «no» es distinto: a esa altura ya sabemos que el
 * salón existe, y la clienta merece un «ahora mismo no se puede reservar por aquí, escríbenos»
 * en vez de un 404 mudo.
 */
async function contextoPublico(req, res) {
    if (!tokenReservaValido(req)) { noHayNada(res); return null; }

    const org = resolveOrgBySlug(req.params.slug);
    if (!org) { noHayNada(res); return null; }

    // `getAllConfig` no lanza: si la lectura falla devuelve {} y los topes caen a sus
    // defaults, entre ellos `reservas_web_activo: false`. O sea que una config ilegible
    // CIERRA el enlace en vez de abrirlo con valores inventados. Es el lado recuperable.
    const configMap = await db.getAllConfig(org.orgId);
    const limites = resolverLimites(configMap || {});
    if (limites.invalidas.length) {
        // Un tope escrito a mano y mal no se aplica, y sin esto nadie se enteraría de que
        // el valor que la dueña cree haber puesto no está haciendo nada.
        logger.warn('reserva_web_config_invalida', { orgId: org.orgId, claves: limites.invalidas });
    }

    const lang = idiomaValido(req.query.lang || (req.body && req.body.lang));
    if (!limites.activo) {
        const { estado, cuerpo } = respuestaNo(MOTIVOS.CERRADO, { waPhone: org.waPhone, lang });
        res.status(estado).json(cuerpo);
        return null;
    }
    return { org, limites, lang, ip: ipDeLaClienta(req) };
}

/** El limitador de LECTURAS. Generoso a propósito: pintar un mes y abrir varios días son
 *  decenas de peticiones de una clienta que se está portando bien. Con el 3/h de las
 *  reservas, la página se rompería sola en el primer minuto. */
function limitarLectura(ctx, res) {
    const r = limitadorReservas.consumir(`lectura:${ctx.org.orgId}:${ctx.ip}`, {
        limite: ctx.limites.reservas_web_max_hora_lecturas_ip,
    });
    if (!r.permitido) {
        logger.warn('reserva_web_lectura_limitada', { orgId: ctx.org.orgId });
        const { estado, cuerpo } = respuestaNo(MOTIVOS.DEMASIADAS_PETICIONES,
            { waPhone: ctx.org.waPhone, lang: ctx.lang, esperaSegundos: r.esperaSegundos });
        res.status(estado).json(cuerpo);
        return false;
    }
    return true;
}

// Un fallo interno NO sale con su mensaje: se registra entero —con la traza de Supabase, que
// es donde sirve— y hacia fuera va un motivo pelado. Un `e.message` en una página pública
// puede llevar el nombre de una tabla, de una constraint o un trozo de fila.
//
// Y sale CON el WhatsApp: si el sistema se ha roto, la clienta no puede hacer nada por su
// cuenta y quedarse mirando un error sin salida es perderla. Por eso recibe el contexto
// entero y no solo el orgId — sin el teléfono, `respuestaNo` omite el enlace en silencio y
// la política de arriba quedaría incumplida sin que se notara.
function fallo(res, evento, ctx, e) {
    logger.error(evento, { orgId: ctx?.org?.orgId || null, error: e?.message || String(e) });
    const { estado, cuerpo } = respuestaNo(MOTIVOS.ERROR_INTERNO, {
        waPhone: ctx?.org?.waPhone, lang: ctx?.lang,
    });
    return res.status(estado).json(cuerpo);
}

// ─── 1 · El catálogo ofertable ───────────────────────────────────────────────────────────
//
// TRES filtros encadenados, y el orden de la composición es la decisión:
//
//   · `botOfferableCatalog` — quita los inactivos Y los `solo_complemento`. Es el catálogo
//     del BOT y no el del panel (`offerableCatalog`), y esa es la elección importante: el
//     panel se lo puede permitir porque hay una persona que sabe que «Peinado con
//     tratamientos» no se vende suelto. Aquí no hay nadie. El enlace es la TERCERA fila de
//     esa tabla y va con el bot, no con el panel.
//   · `isReactiveOnlyService` — fuera la Consulta de valoración. El bot tiene PROHIBIDO
//     ofrecerla por iniciativa propia desde el 02/08; ponerla en un desplegable público es
//     exactamente lo que esa regla prohíbe.
//
// El filtro va AQUÍ, en el call site, nunca dentro de una proyección ni de un helper.
app.get('/reserva-web/:slug/catalogo', async (req, res) => {
    const ctx = await contextoPublico(req, res);
    if (!ctx) return;
    if (!limitarLectura(ctx, res)) return;
    try {
        const { botOfferableCatalog, isReactiveOnlyService, serviceCatalogKey } = require('./services/helpers');
        const cfg = await db.getAgentConfig(ctx.org.orgId);
        // Un catálogo que no se ha podido leer NO es un catálogo vacío. `getAgentConfig`
        // devuelve null cuando falla la lectura, y publicar eso como `servicios: []` sería
        // enseñar un salón sin servicios (regla 3 y hecho 2 de la cabecera).
        if (!cfg || !Array.isArray(cfg.services)) {
            logger.error('reserva_web_catalogo_ilegible', { orgId: ctx.org.orgId });
            const { estado, cuerpo } = respuestaNo(MOTIVOS.ERROR_INTERNO, { waPhone: ctx.org.waPhone, lang: ctx.lang });
            return res.status(estado).json(cuerpo);
        }
        const ofertables = botOfferableCatalog(cfg.services).filter(s => !isReactiveOnlyService(s));
        res.json({ ok: true, servicios: catalogoPublico(ofertables, serviceCatalogKey) });
    } catch (e) { fallo(res, 'reserva_web_catalogo_error', ctx, e); }
});

// ─── 2 · Los días con hueco (la rejilla del mes) ─────────────────────────────────────────
app.get('/reserva-web/:slug/dias', async (req, res) => {
    const ctx = await contextoPublico(req, res);
    if (!ctx) return;
    if (!limitarLectura(ctx, res)) return;
    try {
        const servicio = await resolverServicioPublico(ctx.org.orgId, req.query.servicio);
        if (!servicio.ok) {
            const { estado, cuerpo } = respuestaNo(servicio.motivo, { waPhone: ctx.org.waPhone, lang: ctx.lang });
            return res.status(estado).json(cuerpo);
        }
        const estilistaId = typeof req.query.estilista === 'string' && UUID_RE.test(req.query.estilista)
            ? req.query.estilista : undefined;
        const calendarSante = require('./services/calendar-sante');
        const dias = await calendarSante.getAvailableDays(ctx.org.orgId, {
            serviceDuration: servicio.duracionMin,
            serviceCategory: servicio.entrada.categoria,
            preferredStylistId: estilistaId,
            horizonteDias: HORIZONTE_RESERVA_WEB,
        });
        res.json({ ok: true, dias: diasPublicos(dias), causa: dias.causa || null });
    } catch (e) { fallo(res, 'reserva_web_dias_error', ctx, e); }
});

// ─── 3 · Los huecos de un día concreto ───────────────────────────────────────────────────
app.get('/reserva-web/:slug/huecos', async (req, res) => {
    const ctx = await contextoPublico(req, res);
    if (!ctx) return;
    if (!limitarLectura(ctx, res)) return;
    try {
        const fecha = String(req.query.fecha || '');
        if (!FECHA_RE.test(fecha)) {
            const { estado, cuerpo } = respuestaNo(MOTIVOS.DATOS_INVALIDOS, { waPhone: ctx.org.waPhone, lang: ctx.lang });
            return res.status(estado).json(cuerpo);
        }
        const servicio = await resolverServicioPublico(ctx.org.orgId, req.query.servicio);
        if (!servicio.ok) {
            const { estado, cuerpo } = respuestaNo(servicio.motivo, { waPhone: ctx.org.waPhone, lang: ctx.lang });
            return res.status(estado).json(cuerpo);
        }
        const estilistaId = typeof req.query.estilista === 'string' && UUID_RE.test(req.query.estilista)
            ? req.query.estilista : undefined;
        const calendarSante = require('./services/calendar-sante');
        // Con la fecha ANCLADA el motor devuelve todos los huecos de ese día (sin el tope de
        // 20 que es una decisión de conversación) y cada hueco trae sus alternativas de
        // estilista. Es la misma llamada que hace el bot: un solo motor.
        const slots = await calendarSante.getAvailableSlots(ctx.org.orgId, {
            serviceDuration: servicio.duracionMin,
            serviceCategory: servicio.entrada.categoria,
            preferredStylistId: estilistaId,
            preferencia: { fecha },
            horizonteDias: HORIZONTE_RESERVA_WEB,
        });
        // El motor, cuando el día pedido no tiene nada, propone los más cercanos y lo marca.
        // Aquí eso NO se quiere: la clienta preguntó por un día. Devolver los de otro día
        // sin decirlo pondría en pantalla huecos de una fecha que ella no eligió.
        const delDia = slots.requestedDayUnavailable ? [] : slots.filter(s => s.fecha === fecha);
        res.json({ ok: true, fecha, huecos: huecosPublicos(delDia), causa: slots.causa || null });
    } catch (e) { fallo(res, 'reserva_web_huecos_error', ctx, e); }
});

// ─── El resolutor de servicio, compartido por las tres rutas que lo necesitan ────────────
//
// Resuelve la clave `categoria|nombre` que mandó el formulario contra el catálogo OFERTABLE
// —el mismo filtro que la ruta del catálogo— y nunca contra el completo. Ésa es la garantía
// de que alguien que teclee a mano la clave de un `solo_complemento`, de un inactivo o de la
// Consulta reciba «ese servicio no se puede reservar por aquí» en vez de una cita.
//
// La DURACIÓN sale de `resolveAppointmentDurationMin`, y un `resuelto:false` BLOQUEA. En una
// conversación una duración adivinada solo estropea una propuesta que alguien puede corregir;
// aquí se escribiría en `ends_at` y publicaría agenda libre encima de una clienta.
//
// El NOMBRE con el que se guarda sale de `buildFullServiceName` con el catálogo COMPLETO,
// porque cuenta homónimos: sobre la lista filtrada, dar de baja a un «Hombre» haría que el
// otro dejara de prefijarse con su categoría, y el nombre con el que se guarda una cita no
// puede depender de eso.
async function resolverServicioPublico(orgId, clave) {
    if (typeof clave !== 'string' || !clave.includes('|')) {
        return { ok: false, motivo: MOTIVOS.DATOS_INVALIDOS };
    }
    const {
        botOfferableCatalog, isReactiveOnlyService, findCatalogEntryByKey,
        resolveAppointmentDurationMin, buildFullServiceName,
    } = require('./services/helpers');

    const cfg = await db.getAgentConfig(orgId);
    if (!cfg || !Array.isArray(cfg.services)) {
        logger.error('reserva_web_catalogo_ilegible', { orgId });
        return { ok: false, motivo: MOTIVOS.ERROR_INTERNO };
    }
    const completo = cfg.services;
    const ofertables = botOfferableCatalog(completo).filter(s => !isReactiveOnlyService(s));
    const entrada = findCatalogEntryByKey(clave, ofertables);
    if (!entrada) return { ok: false, motivo: MOTIVOS.SERVICIO_NO_DISPONIBLE };

    const dur = resolveAppointmentDurationMin(entrada, completo);
    if (!dur.resuelto) {
        logger.error('reserva_web_duracion_no_resuelta', { orgId, servicio: entrada.nombre || null });
        return { ok: false, motivo: MOTIVOS.SERVICIO_NO_DISPONIBLE };
    }
    return {
        ok: true, entrada,
        duracionMin: dur.minutos,
        nombreCompleto: buildFullServiceName(entrada, completo),
    };
}

// ─── 4 · La reserva ──────────────────────────────────────────────────────────────────────
//
// El orden de las comprobaciones NO es casual, y cada paso está antes que el siguiente por
// una razón concreta:
//
//   1. limitador por IP    — antes de tocar la base de datos, que es lo que cuesta.
//   2. limitador por ORG   — el techo del salón; protege de un ataque repartido entre IPs.
//   3. forma de los datos  — barato y no lee nada.
//   4. servicio            — contra el catálogo ofertable.
//   5. LISTA NEGRA         — antes de escribir NADA. Ni ficha, ni cita.
//   6. ficha (saveLead)    — crea o actualiza, SIN pisar el nombre guardado.
//   7. verificación del hueco contra el motor REAL — es lo único que sabe de skills.
//   8. el claim atómico    — `reservar_hueco()`, que es quien decide de verdad.
app.post('/reserva-web/:slug/reserva', async (req, res) => {
    const ctx = await contextoPublico(req, res);
    if (!ctx) return;
    const { org, limites, lang } = ctx;
    const no = (motivo, extra) => {
        const { estado, cuerpo } = respuestaNo(motivo, { waPhone: org.waPhone, lang, ...extra });
        return res.status(estado).json(cuerpo);
    };

    try {
        // (1) y (2) — los dos limitadores. El de la org va DESPUÉS del de IP a propósito:
        // así una sola IP pegando no consume el techo del salón y deja fuera a las clientas
        // de verdad; primero se la para a ella.
        const porIp = limitadorReservas.consumir(`reserva:${org.orgId}:${ctx.ip}`,
            { limite: limites.reservas_web_max_hora_ip });
        if (!porIp.permitido) {
            logger.warn('reserva_web_limite_ip', { orgId: org.orgId });
            return no(MOTIVOS.DEMASIADAS_PETICIONES, { esperaSegundos: porIp.esperaSegundos });
        }
        const porOrg = limitadorReservas.consumir(`reserva-org:${org.orgId}`,
            { limite: limites.reservas_web_max_hora_org });
        if (!porOrg.permitido) {
            // Esto sí merece mirarse: o hay un ataque, o el salón está teniendo su mejor día.
            logger.warn('reserva_web_techo_org', { orgId: org.orgId, limite: limites.reservas_web_max_hora_org });
            return no(MOTIVOS.SALON_SATURADO, { esperaSegundos: porOrg.esperaSegundos });
        }

        // (3) La forma. Todo lo que entra es texto de internet: se valida, se acota y se
        // limpia a una línea antes de tocar nada.
        const body = req.body || {};
        const fecha = String(body.fecha || '');
        const hora = String(body.hora || '');
        const telefono = db.sanitizePhone(String(body.telefono || ''));
        const nombre = limpiarUnaLinea(body.nombre || '', MAX_NOMBRE);
        const notas = body.notas ? limpiarUnaLinea(body.notas, MAX_NOTAS) : null;
        const estilistaPedida = typeof body.estilista === 'string' && UUID_RE.test(body.estilista)
            ? body.estilista : null;
        if (!FECHA_RE.test(fecha) || !HORA_RE.test(hora) || !telefono || nombre.length < 2) {
            return no(MOTIVOS.DATOS_INVALIDOS);
        }

        // (4) El servicio.
        const servicio = await resolverServicioPublico(org.orgId, body.servicio);
        if (!servicio.ok) return no(servicio.motivo);

        // (5) LISTA NEGRA, antes de escribir nada.
        //
        // El mensaje es NEUTRO y comparte forma con el resto de «esto no se cierra online»:
        // en el salón bloquear es silencio, pero una página tiene que renderizar algo, y ese
        // algo no puede ser «estás bloqueada». La lectura lleva assertRead, así que una
        // consulta rota LANZA y cae en el catch — nunca se lee como «no está bloqueada».
        const existente = await db.getContactoParaReservaWeb(org.orgId, telefono);
        if (existente?.blacklisted) {
            logger.info('reserva_web_bloqueada_lista_negra', { orgId: org.orgId });
            return no(MOTIVOS.NO_CONFIRMABLE_ONLINE);
        }

        // (6) La ficha. `saveLead` crea o actualiza por teléfono.
        //
        // EL NOMBRE NO SE PISA si ya había uno, y en una superficie pública eso deja de ser
        // cortesía y pasa a ser una defensa: sin esto, cualquiera que teclee el teléfono de
        // otra persona le renombra la ficha, y el bot la saludaría con ese nombre. Es la
        // misma guarda que ya tiene `POST /api/leads`.
        const datosFicha = { telefono, origen: 'web' };
        if (!existente?.tieneNombre) datosFicha.nombre = nombre;
        const contactId = await db.saveLead(org.orgId, datosFicha);
        if (!contactId) {
            logger.error('reserva_web_sin_ficha', { orgId: org.orgId });
            return no(MOTIVOS.ERROR_INTERNO);
        }

        // (7) ¿Ese hueco existe DE VERDAD, y quién puede atenderlo?
        //
        // `reservar_hueco()` mira horario, bloqueos y citas, pero NO sabe de skills — esa
        // regla vive en JS y aquí es donde se aplica. Además es de donde sale la estilista
        // cuando la clienta dijo «la primera que haya».
        const calendarSante = require('./services/calendar-sante');
        const slots = await calendarSante.getAvailableSlots(org.orgId, {
            serviceDuration: servicio.duracionMin,
            serviceCategory: servicio.entrada.categoria,
            preferredStylistId: estilistaPedida || undefined,
            preferencia: { fecha },
            horizonteDias: HORIZONTE_RESERVA_WEB,
        });
        const hueco = slots.requestedDayUnavailable
            ? null
            : slots.find(s => s.fecha === fecha && s.hora === hora);
        if (!hueco) return no(MOTIVOS.HUECO_NO_EXISTE);

        // Las candidatas, en el orden en que el motor las da (alfabético, estable).
        let candidatas = (hueco.alternativas || [{ id: hueco.stylistId, name: hueco.stylistName }]);
        if (estilistaPedida) {
            candidatas = candidatas.filter(c => c.id === estilistaPedida);
            if (!candidatas.length) return no(MOTIVOS.HUECO_NO_EXISTE);
        }

        // (8) El claim. Si la clienta NO eligió estilista, se prueba con la siguiente cuando
        // la primera pierde la carrera: ella pidió «la primera que haya», así que cambiar de
        // nombre por dentro es invisible y le ahorra tener que volver a empezar.
        //
        // Si SÍ eligió, no se reintenta con otra: le llegaría una confirmación con un nombre
        // distinto del que pulsó, y una sorpresa en la pantalla de confirmación de una
        // reserva es peor que pedirle que elija otro hueco.
        let ultimoMotivo = MOTIVOS.HUECO_OCUPADO;
        for (const candidata of candidatas) {
            try {
                const cita = await db.saveAppointment(org.orgId, contactId, {
                    servicio: servicio.nombreCompleto,
                    fecha, hora,
                    duracionMin: servicio.duracionMin,
                    stylistId: candidata.id,
                    notas,
                    source: 'web',
                    maxFuturas: limites.reservas_web_max_futuras,
                });
                if (!cita) { ultimoMotivo = MOTIVOS.ERROR_INTERNO; break; }
                logger.info('reserva_web_creada', {
                    orgId: org.orgId, citaId: cita.id, fecha, hora,
                    servicio: servicio.nombreCompleto, estilistaId: candidata.id,
                });
                return res.json(reservaPublica({
                    fecha, hora,
                    servicio: servicio.nombreCompleto,
                    estilistaNombre: candidata.name,
                    duracionMin: servicio.duracionMin,
                }));
            } catch (e) {
                if (!(e instanceof db.ReservaWebRechazada)) throw e;
                ultimoMotivo = interpretarMotivoSql(e.motivo);
                // El tope de citas y un rango mal construido no mejoran probando con otra
                // estilista: son de la clienta y de nuestro código, no del hueco.
                if (ultimoMotivo === MOTIVOS.TOPE_CITAS || ultimoMotivo === MOTIVOS.RANGO_INVALIDO) break;
                if (estilistaPedida) break;
            }
        }
        logger.warn('reserva_web_no_confirmada', { orgId: org.orgId, motivo: ultimoMotivo, fecha, hora });
        return no(ultimoMotivo);
    } catch (e) { return fallo(res, 'reserva_web_error', ctx, e); }
});

function startWebhookServer(port) {
    const PORT = port || process.env.PORT || 3000;
    app.listen(PORT, () => {
        logger.info('servidor_iniciado', { puerto: PORT });
    });
}

// `app` se exporta para tests de integración de rutas (no se usa en producción; el arranque
// real pasa por startWebhookServer). Exponerlo no cambia ningún comportamiento.
module.exports = { startWebhookServer, setWAClient, app, _limitadorReservas: limitadorReservas };
