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
        await db.clearStylistPin(orgId, req.params.id);
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
            appointmentId, cobradoPor, fechaCaja, metodo, importeTotal, importeEfectivo,
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

        const atrib = resolverAtribucion(req, orgId, cobradoPor);
        const cobro = await db.createCobro(orgId, {
            appointmentId, cobradoPor, fechaCaja, metodo, importeTotal, importeEfectivo,
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
        const { contactId, servicio, fecha, hora, duracionMin, stylistId, notas, personas, ocasion } = req.body;
        if (!contactId || !fecha) return res.status(400).json({ error: 'contactId y fecha requeridos' });
        if (hora != null && hora !== '' && !/^\d{1,2}:\d{2}$/.test(String(hora).trim())) {
            return res.status(400).json({ error: `Hora inválida ("${hora}"). Usa el formato HH:MM` });
        }
        const durErr = validarDuracion(duracionMin);
        if (durErr) return res.status(400).json({ error: durErr });
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
        console.log('[DEBUG apt]', apt);
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
            console.log('[DEBUG no-show] ejecutando setBlacklist', { orgId, contact_id: apt.contact_id, noShow: req.body.noShow, estado: req.body.estado });
            const noShowContact = await db.findById(orgId, apt.contact_id);
            await db.setBlacklist(orgId, apt.contact_id, 'No-show');
            notifyBlacklistAlert(orgId, { nombre: noShowContact?.nombre, telefono: noShowContact?.telefono, blacklist_reason: 'No-show' }).catch(() => {});
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

function startWebhookServer(port) {
    const PORT = port || process.env.PORT || 3000;
    app.listen(PORT, () => {
        logger.info('servidor_iniciado', { puerto: PORT });
    });
}

// `app` se exporta para tests de integración de rutas (no se usa en producción; el arranque
// real pasa por startWebhookServer). Exponerlo no cambia ningún comportamiento.
module.exports = { startWebhookServer, setWAClient, app };
