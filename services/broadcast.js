/**
 * broadcast.js — Motor ÚNICO de envío masivo (campañas y VIP).
 *
 * Antes cada ruta del panel tenía su propio bucle (`/api/campaigns/broadcast` y
 * `/api/vip/broadcast`) y las dos mandaban texto libre a pelo. En Cloud API eso solo se
 * entrega dentro de la ventana de 24 h desde el último mensaje ENTRANTE de la clienta —
 * fuera, Meta responde 200 y no entrega nada. Con ~700 contactos y casi ninguno dentro de
 * ventana, una campaña se perdía entera sin un solo error visible.
 *
 * La regla de ventana/plantilla NO se reimplementa aquí: es la misma `resolveAutomatedSend`
 * que ya usan reminder.js y review.js. Este módulo solo añade lo que una campaña necesita y
 * un recordatorio no: tandas, deduplicación entre tandas y tope de 24 h del número.
 */

const { resolveAutomatedSend, parseTemplateConfig, isCloudChannel } = require('./outbound');
const { noteSendResult } = require('./channel-health');
const { alertOnce } = require('./admin-alerts');
const logger = require('../lib/logger');

// Tope de destinatarios por número y 24 h. No es una cifra nuestra: la impone Meta, y este
// número ya se llevó un bloqueo el 01/08/2026. Por eso el recorte es automático y no un
// aviso que alguien tenga que recordar.
const MAX_DESTINATARIOS_24H = 250;

// Envíos en paralelo. 250 POST secuenciales a Meta no caben en una petición HTTP del panel;
// con 4 en vuelo la tanda baja a ~15 s. Subirlo más tienta el rate limit de Cloud API.
const CONCURRENCIA = 4;

// Intentos de marcar 'sent' una entrega YA hecha. No es un envío: es una sola fila por id, y
// no dejar constancia de algo entregado no tiene ninguna salida buena, así que se insiste.
const REINTENTOS_REGISTRO = 3;

const MENSAJE_SIN_REGISTRAR = (telefono, campaignKey) =>
    '⚠️ <b>Un mensaje de campaña salió pero no se pudo registrar</b>\n\n'
    + `Número: <code>${telefono}</code>${campaignKey ? ` · Campaña: <code>${campaignKey}</code>` : ''}\n\n`
    + 'La clienta <b>sí lo ha recibido</b>. Lo que ha fallado es apuntarlo, así que si se '
    + 'relanza la campaña podría llegarle por segunda vez.\n\n'
    + 'Si vas a relanzarla, conviene quitar ese número de la lista.';

/** JID de destino: el canónico guardado (puede ser @lid) y, si no hay, el WID clásico. */
function resolveChatId(contacto) {
    const digits = (contacto.telefono || '').replace(/\D/g, '');
    return contacto.wa_jid || (digits ? `${digits}@c.us` : null);
}

/** Recorre `items` con N tareas en vuelo. Preserva el orden de `items` en los efectos. */
async function mapConLimite(items, limite, tarea) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limite, items.length) }, async () => {
        while (cursor < items.length) {
            const i = cursor++;
            await tarea(items[i], i);
        }
    });
    await Promise.all(workers);
}

/**
 * Envía `mensaje` (texto libre) y/o la plantilla de `plantillaClave` a `destinatarios`.
 *
 * @param {string} orgId
 * @param {object}   opts
 * @param {object}   opts.client           Cliente saliente ya resuelto (resolveOutboundClient).
 * @param {object[]} opts.destinatarios    Contactos en forma rowToPublic (telefono, language, wa_jid…).
 * @param {string}  [opts.mensaje]         Texto libre para quien esté DENTRO de ventana. Si no
 *                                         viene, esos también reciben la plantilla.
 * @param {string}  [opts.plantillaClave]  Clave de `config` con el mapa de plantillas por idioma.
 * @param {string}  [opts.campaignKey]     Identificador de campaña. SIN ella no hay registro ni
 *                                         deduplicación ni tope: es el comportamiento de siempre,
 *                                         que es lo que mantiene a San Remo intacto.
 * @param {number}  [opts.limit]           Tamaño máximo de la tanda pedido por el operador.
 */
async function runBroadcast(orgId, {
    client,
    destinatarios = [],
    mensaje = null,
    plantillaClave = null,
    campaignKey = null,
    limit = null,
    maxPor24h = MAX_DESTINATARIOS_24H,
    concurrencia = CONCURRENCIA,
    // Inyectable para el test. Por defecto el mismo waSendMessage de bot.js que ya usaban
    // las dos rutas, para conservar su reintento ante errores transitorios de WhatsApp.
    sendText = null,
} = {}) {
    const db = require('./db');
    const enviarTexto = sendText || require('../bot').waSendMessage;
    const cloud = isCloudChannel(orgId);

    const resumen = {
        total_audiencia: destinatarios.length,
        enviados: 0,
        por_plantilla: 0,
        texto_libre: 0,
        omitidos: 0,
        // Entregados a la clienta que NO se pudieron apuntar. Cuentan aparte a propósito: no
        // son un fallo de envío (el mensaje llegó) ni un envío limpio (no hay constancia).
        // Meterlos en `omitidos` era justo lo que hacía que el resumen no cuadrara.
        registro_fallido: 0,
        restantes: 0,
        cupo_24h_restante: null,
        recortado_por_tope: false,
        fallos: [],
    };
    if (!destinatarios.length) return resumen;

    // ── 1. Quitar a quien ya recibió esta campaña ────────────────────────────
    let pendientes = destinatarios;
    if (campaignKey) {
        await db.resetStaleBroadcastClaims(orgId, campaignKey);
        const yaEnviados = await db.getBroadcastSentPhones(orgId, campaignKey);
        pendientes = destinatarios.filter(c => !yaEnviados.has(db.sanitizePhone(c.telefono)));
    }

    // ── 2. Recortar la tanda: lo que pida el operador y lo que deje el tope ───
    let tope = pendientes.length;
    if (campaignKey && cloud) {
        const enviados24h = await db.countBroadcastSendsLast24h(orgId);
        const cupo = Math.max(0, maxPor24h - enviados24h);
        resumen.cupo_24h_restante = cupo;
        if (cupo < tope) { tope = cupo; resumen.recortado_por_tope = true; }
    }
    if (Number.isFinite(limit) && limit !== null && limit >= 0 && limit < tope) tope = limit;

    const tanda = pendientes.slice(0, tope);
    resumen.restantes = pendientes.length - tanda.length;
    if (!tanda.length) return resumen;

    // ── 3. Precargar ventana y plantillas: 3 consultas en vez de ~4 por contacto ──
    let ventanaPorTelefono = new Map();
    let plantillaConfig;
    if (cloud) {
        ventanaPorTelefono = await db.getLastInboundAtBulk(orgId, tanda.map(c => c.telefono));
        plantillaConfig = plantillaClave ? await db.getConfigValue(orgId, plantillaClave) : null;
    }

    // ── 4. Enviar ────────────────────────────────────────────────────────────
    await mapConLimite(tanda, concurrencia, async (contacto) => {
        const telefono = contacto.telefono;
        const chatId = resolveChatId(contacto);
        if (!chatId) {
            resumen.omitidos++;
            resumen.fallos.push({ telefono, motivo: 'sin teléfono ni JID' });
            return;
        }

        const decision = await resolveAutomatedSend(orgId, {
            telefono,
            language: contacto.language || 'es',
            plantillaClave,
            ...(cloud ? {
                lastInboundAt: ventanaPorTelefono.get(db.sanitizePhone(telefono)) ?? null,
                plantillaConfig,
            } : {}),
        });

        // Dentro de ventana pero sin texto que mandar: la plantilla también se entrega
        // dentro de la ventana, así que se usa esa en vez de omitir a la clienta.
        let modo = decision.mode;
        let plantilla = decision.template || null;
        if (modo === 'free_text' && !mensaje) {
            plantilla = parseTemplateConfig(plantillaConfig, contacto.language || 'es');
            modo = plantilla ? 'template' : 'sin_mensaje';
        }

        if (modo === 'sin_plantilla' || modo === 'sin_mensaje') {
            resumen.omitidos++;
            resumen.fallos.push({
                telefono,
                motivo: modo === 'sin_plantilla'
                    ? `sin plantilla configurada para '${contacto.language || 'es'}' en ${plantillaClave}`
                    : 'sin mensaje ni plantilla',
            });
            logger.warn('campana_destinatario_omitido', {
                orgId, telefono, motivo: modo, language: contacto.language || 'es',
            });
            return;
        }

        // ── Reserva ANTES de enviar. El UNIQUE de broadcast_sends es lo que impide que
        // dos operadores a la vez manden el mismo mensaje dos veces a la misma clienta.
        let claimId = null;
        if (campaignKey) {
            claimId = await db.claimBroadcastRecipient(orgId, {
                campaignKey, contactId: contacto.id || null, telefono,
            });
            if (!claimId) return; // otro proceso la tiene: ni enviamos ni la contamos como fallo
        }

        // ── ENVIAR y REGISTRAR son dos cosas, y el `try` de una no puede tapar a la otra ──
        //
        // Estaban en el mismo bloque: `finishBroadcastSend('sent')` iba DENTRO del try del
        // envío y lanza (assertRowsAffected). Cuando lanzaba, con el mensaje ya entregado:
        // el contacto se contaba en `enviados` Y en `omitidos` (el resumen no cuadraba
        // consigo mismo), y el claim se marcaba 'failed' — que es justo lo que
        // resetStaleBroadcastClaims BORRA al empezar la tanda siguiente. El contacto volvía
        // a ser elegible y la clienta recibía la campaña dos veces. El UNIQUE de
        // broadcast_sends existe para impedirlo, y este camino lo rodeaba borrando su fila.
        //
        // Regla, y es la que sostiene el invariante: **después de una entrega confirmada, el
        // registro NUNCA puede marcar 'failed' ni contar como fallo.** Un fallo de registro
        // es un problema de contabilidad; un 'failed' sobre algo entregado es un WhatsApp de
        // más en el móvil de una clienta.
        let entregado = false;
        try {
            if (modo === 'template') {
                // Las plantillas de campaña no llevan variables: sin `params`, sendTemplate
                // omite `components` — mandar parámetros de más lo rechazaría Meta (132000).
                await client.sendTemplate(chatId, {
                    name: plantilla.name,
                    language: plantilla.language,
                });
                resumen.por_plantilla++;
            } else {
                await enviarTexto(client, chatId, mensaje);
                resumen.texto_libre++;
            }
            entregado = true;
        } catch (e) {
            resumen.omitidos++;
            resumen.fallos.push({ telefono, motivo: e.message });
            logger.error('campana_fallo_envio', { orgId, telefono, error: e.message });
            // Los fallos por destinatario (fuera de ventana, plantilla) los descarta
            // classifyChannelError: una campaña normal los acumula por decenas y con ellos
            // en la cuenta el aviso saltaría en cada envío masivo.
            await noteSendResult(orgId, { ok: false, error: e, contexto: `campaña a ${telefono}` });
            // Aquí SÍ es correcto 'failed': no se entregó nada, así que reintentarlo en la
            // tanda siguiente es lo que queremos.
            if (claimId) {
                try {
                    await db.finishBroadcastSend(orgId, claimId, {
                        status: 'failed', mode: modo, error: e.message,
                    });
                } catch (e2) {
                    // Antes era un `.catch(() => {})` mudo. El claim se queda en 'pending' y
                    // caducará solo, así que el comportamiento se recupera — pero perder el
                    // único rastro de que la contabilidad se rompió, justo donde ya sabemos
                    // que algo va mal, no.
                    logger.error('campana_registro_fallo_no_guardado', {
                        orgId, telefono, error: e2.message,
                    });
                }
            }
            return;
        }

        // A partir de aquí el mensaje ESTÁ en el móvil de la clienta.
        // Salud del canal, UNA vez por destinatario y por las dos vías. `enviarTexto` es
        // waSendMessage, al que a propósito NO se le pasa orgId: reportaría el mismo envío
        // otra vez y una tanda contaría el doble.
        await noteSendResult(orgId, { ok: true });
        resumen.enviados++;

        if (!claimId) return;

        // El registro se reintenta: es una sola fila por id y un fallo aquí no tiene ninguna
        // salida buena, así que vale la pena insistir antes de rendirse.
        let registrado = false;
        let ultimoError = null;
        for (let intento = 0; intento < REINTENTOS_REGISTRO && !registrado; intento++) {
            if (intento > 0) await new Promise(r => setTimeout(r, 200 * intento));
            try {
                await db.finishBroadcastSend(orgId, claimId, {
                    status: 'sent',
                    mode: modo,
                    templateName: modo === 'template' ? plantilla.name : null,
                });
                registrado = true;
            } catch (e) {
                ultimoError = e;
            }
        }

        if (!registrado) {
            // Se entregó y no se pudo dejar constancia. NO se marca 'failed' (ver arriba) y
            // NO cuenta como fallo de envío: la clienta lo recibió. Va a su propio contador
            // para que el resumen del operador cuadre y para que esto se vea.
            //
            // LÍMITE CONOCIDO, y no se puede cerrar desde aquí: la fila se queda en
            // 'pending' y resetStaleBroadcastClaims la borra a los 15 min, así que una
            // tanda posterior podría reenviarle. No hay forma de evitarlo sin una
            // transacción entre WhatsApp y Postgres, que no existe. Lo que sí se hace es
            // que sea RARO (reintentos), que no sea el camino rápido (nunca 'failed') y que
            // una persona se entere.
            resumen.registro_fallido++;
            resumen.fallos.push({
                telefono,
                motivo: `ENTREGADO pero sin registrar (${ultimoError?.message || 'sin detalle'}) — `
                    + 'riesgo de reenvío si la campaña se relanza',
            });
            logger.error('campana_entregado_sin_registrar', {
                orgId, telefono, campaignKey, claimId, error: ultimoError?.message || null,
            });
            await alertOnce(orgId, `campana_sin_registrar|${campaignKey}|${telefono}`,
                MENSAJE_SIN_REGISTRAR(telefono, campaignKey));
        }
    });

    logger.info('campana_tanda_completada', {
        orgId, campaignKey, enviados: resumen.enviados, por_plantilla: resumen.por_plantilla,
        texto_libre: resumen.texto_libre, omitidos: resumen.omitidos, restantes: resumen.restantes,
    });
    return resumen;
}

module.exports = {
    runBroadcast,
    MAX_DESTINATARIOS_24H,
    // exportados para el test
    mapConLimite,
    resolveChatId,
};
