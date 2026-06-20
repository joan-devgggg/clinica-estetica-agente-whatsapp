const axios = require('axios');
require('dotenv').config();
const config = require('../../config.json');
const db = require('../db');
const { getOrgType } = require('../org-registry');
const logger = require('../../lib/logger');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const aiConfig = config.ai || {};

// ─── San Remo prompt (restaurante) ──────────────────────────────────────────

function buildSanRemoPrompt(partialData, intent, reservaConfirmada, summary, agentCfg) {
    const info = agentCfg?.business_info || {};
    const missingFields = partialData.__missingFields || [];
    const slotsDisponibles = partialData.__availableSlots || [];
    const slotsStr = slotsDisponibles.length > 0
        ? slotsDisponibles.map((s, i) => `  ${i + 1}. ${s.texto}`).join('\n')
        : 'No hay mesas cargadas todavía — la preferencia horaria aún no está definida. DEBES preguntar cuándo le viene mejor (comida/cena, esta semana/siguiente) antes de proponer cualquier mesa. NUNCA inventes fechas ni horas.';

    const nombreRestaurante = info.companyName || config.companyName || 'el restaurante';
    const nombreBot = info.botName || config.botName || 'el asistente';
    const owner = info.owner || config.owner || 'el encargado';
    const direccion = info.direccion || config.direccion || '';
    const telefono = config.telefonoRestaurante || '';
    const handoffMessage = agentCfg?.handoff_message || 'Un momento, le paso tu mensaje al equipo.';

    const faqs = info.faqs || config.faqs || {};
    const faqsStr = `- Horarios: ${faqs.horarios || 'sin información'}
- Carta: ${faqs.carta || 'sin información'}
- Parking: ${faqs.parking || 'sin información'}
- Alérgenos: ${faqs.alergias || 'sin información'}`;

    const bizum = info.bizum || config.bizum || {};

    let modoBizum = '';
    if (partialData.__bizumAsked && !partialData.__bizumPendiente) {
        modoBizum = `
MODO ESPERANDO BIZUM:
* Ya le has pedido al cliente una señal de ${bizum.importe}€ por Bizum al número ${bizum.numero} para confirmar la mesa.
* NO vuelvas a pedir los datos de la reserva.
* Si el cliente pregunta otra cosa (FAQ, horarios, carta...), respóndela con normalidad.
* Si el cliente dice que ya ha hecho el Bizum, el sistema se encargará de confirmarlo — tú simplemente puedes agradecerle brevemente.
* reserva_confirmada debe seguir en false hasta que el sistema lo gestione.`;
    } else if (partialData.__bizumPendiente) {
        modoBizum = `
MODO RESERVA PENDIENTE DE VERIFICAR:
* La reserva está hecha y la señal por Bizum está pendiente de que ${owner} la verifique.
* NO pidas datos de nuevo. Responde dudas con normalidad y tranquiliza al cliente: en cuanto se verifique se le confirma por aquí.
* Si quiere cancelar → accion: "cancelar". Si quiere cambiar la reserva → accion: "cambiar".`;
    } else if (reservaConfirmada) {
        modoBizum = `
MODO RESERVA CONFIRMADA:
* La reserva ya está confirmada. NO vuelvas a pedir datos al cliente.
* Responde dudas de forma natural y amable.
* Si quiere cancelar → accion: "cancelar". Si quiere cambiarla → accion: "cambiar".`;
    }

    const modoReagendamiento = partialData.__reagendando ? `
MODO REAGENDAMIENTO ACTIVO:
* El cliente quiere cambiar su reserva anterior. Ya estamos buscando un nuevo hueco.
* NUNCA devuelvas accion: "cambiar" — ya estamos en ese flujo.
* Si no hay mesas disponibles, pregunta su nueva preferencia (comida/cena, esta semana/la siguiente).
* Si hay mesas disponibles, propón la primera como si fuera la primera vez que se reserva.` : '';

    let modoClienteRecurrente = '';
    if (partialData.__clienteRecurrente) {
        const ultimaVisita = partialData.__ultimaVisita
            ? `Su última visita fue el ${partialData.__ultimaVisita}.`
            : 'Ya ha venido al restaurante antes.';
        modoClienteRecurrente = `
CLIENTE QUE VUELVE:
${ultimaVisita}
Salúdale con calidez como a alguien que ya conoces: algo como "¡Qué alegría tenerte de nuevo por aquí!". No hace falta presentarte. Tono cercano y de confianza.`;
    }

    const pendientes = missingFields.filter(f => f !== 'telefono');

    const proximoPaso = (() => {
        if (partialData.__bizumAsked || reservaConfirmada) return 'Sigue las instrucciones del modo activo indicado más abajo.';
        if (partialData.__clienteRecurrente) return 'Saluda con calidez y pregunta de forma abierta en qué puedes ayudarle.';
        if (pendientes.includes('nombre')) return 'Pregunta cómo se llama (o a nombre de quién hacemos la reserva).';
        if (pendientes.includes('personas')) return 'Pregunta para cuántas personas sería la mesa.';
        if (!partialData.preferencia_horaria) return 'Pregunta SOLO cuándo le viene mejor. Quieres saber DOS cosas: (1) si prefiere comida o cena, y (2) si esta semana o la siguiente. Hazlo en una sola pregunta natural. NUNCA propongas ninguna mesa todavía.';
        if (slotsDisponibles.length > 0) return `Propón la primera mesa disponible: "${slotsDisponibles[0]?.texto}". Pregunta si le va bien.`;
        return 'Espera confirmación o nueva preferencia.';
    })();

    const contextoActual = `Intención detectada: ${intent}\nDatos del cliente: ${JSON.stringify(partialData, null, 2)}`;
    const resumenAnterior = summary ? `RESUMEN DE CONVERSACIONES ANTERIORES CON ESTE CLIENTE:\n${summary}\n\nUsa este contexto para personalizar tu respuesta, pero no lo menciones explícitamente al cliente.` : '';
    const customPrefix = agentCfg?.system_prompt ? `${agentCfg.system_prompt}\n\n` : '';

    return `${customPrefix}# ── IDENTIDAD ──────────────────────────────────────────────────────────────

Eres ${nombreBot}, la asistente virtual de ${nombreRestaurante}, un restaurante de alta cocina (referencia Michelin) en Palencia.
Atiendes por WhatsApp las reservas de mesa y dudas de los clientes.
No eres un bot. Eres una asistente con un trato exquisito: elegante, cercana y profesional.

# ── EL RESTAURANTE ─────────────────────────────────────────────────────────

${direccion}${telefono ? `\nTeléfono: ${telefono}` : ''}

# ── PREGUNTAS FRECUENTES ───────────────────────────────────────────────────

${faqsStr}

Usa esta información para responder dudas. Si te preguntan algo que no está aquí, dilo con naturalidad y ofrece escalar con accion: "escalar_humano".

# ── DISPONIBILIDAD DE MESAS ────────────────────────────────────────────────

MESAS DISPONIBLES:
${slotsStr}

NUNCA inventes fechas, horas ni datos. Solo usa las mesas de esta lista.

# ── DATO QUE NECESITAS AHORA ───────────────────────────────────────────────

SIGUIENTE PASO: ${proximoPaso}

ORDEN DEL FLUJO:
1. Si falta el nombre → pregunta a nombre de quién hacemos la reserva.
2. Si falta el número de personas → pregunta para cuántos sería la mesa.
3. Si falta la preferencia horaria → pregunta cuándo le viene mejor.
4. Solo cuando tengas nombre + personas + preferencia → propón máximo 2 mesas.
5. Si el cliente menciona una ocasión especial guárdala en datos.ocasion.
6. Si el cliente menciona alergias guárdalas en datos.allergies, preferencias en datos.preferences.
7. Cuando el cliente acepte una mesa → marca reserva_confirmada: true.

# ── MODOS ESPECIALES ──────────────────────────────────────────────────────
${modoBizum}
${modoReagendamiento}
${modoClienteRecurrente}

# ── CONTEXTO ACTUAL ────────────────────────────────────────────────────────

${contextoActual}

${resumenAnterior}

# ── PERSONALIDAD Y TONO ────────────────────────────────────────────────────

- Habla de forma natural y elegante. Frases cortas. Nada de párrafos largos.
- 0 o 1 emoji por mensaje. Sin repetir el mismo emoji en la misma conversación.
- Nunca digas "Entendido", "Procesando" ni nada robótico.
- Máximo 3 líneas por mensaje. Una sola pregunta por mensaje.

# ── REGLAS DURAS ───────────────────────────────────────────────────────────

1. Una pregunta por mensaje. Nunca dos seguidas.
2. Nunca inventes mesas, fechas, horas ni datos del cliente.
3. Nunca repitas literalmente lo que acaba de decir el cliente.
4. Si el cliente llega solo con "hola", pregunta qué necesita.

# ── FORMATO DE SALIDA ──────────────────────────────────────────────────────

Responde SIEMPRE con este JSON y nada más:

{
  "respuesta": "mensaje para el cliente",
  "reserva_confirmada": false,
  "slot_rechazado": false,
  "accion": null,
  "datos": {
    "nombre": null, "telefono": null, "personas": null,
    "fecha_cita": null, "hora_cita": null, "ocasion": null,
    "allergies": null, "preferences": null, "notas": null
  }
}

Valores posibles de accion: "cancelar" | "cambiar" | "escalar_humano" | null${partialData.__reagendando ? '\nEn modo reagendamiento, accion es siempre null.' : ''}
Usa "escalar_humano" si el cliente pide hablar con una persona o la situación supera lo que puedes gestionar.`;
}

// ─── Sante prompt (salón de belleza) ────────────────────────────────────────

function buildSantePrompt(partialData, intent, citaConfirmada, summary, agentCfg) {
    const info = agentCfg?.business_info || {};
    const services = agentCfg?.services || [];
    const handoffMessage = agentCfg?.handoff_message || 'Un momento, te paso con alguien del equipo.';

    const salonName = info.companyName || 'Sante Healthy Hair Salon';
    const botName = info.botName || 'Asistente de Santé';
    const direccion = info.direccion || '';
    const cancelacion = info.cancelacion || 'Avisar con 48 horas de antelación';

    // Services catalog
    const categorias = [...new Set(services.map(s => s.categoria))];
    const catalogoStr = categorias.map(cat => {
        const items = services.filter(s => s.categoria === cat);
        return `${cat}:\n` + items.map(s => `  • ${s.nombre} — ${s.precio}€ (${s.duracion} min)`).join('\n');
    }).join('\n\n');

    // Team
    const equipo = info.equipo || [];
    const equipoStr = equipo.map(e =>
        `• ${e.nombre} — ${e.rol}${e.disponibilidad ? ` (${e.disponibilidad})` : ''}`
    ).join('\n');

    // Upselling rules
    const upselling = info.upselling || [];
    const upsellingStr = upselling.map(u =>
        `• Si pide "${u.servicio}" → sugiere: ${u.sugerencias.join(', ')}`
    ).join('\n');

    // Available slots (injected from calendar-sante)
    const slotsDisponibles = partialData.__availableSlots || [];
    const slotsStr = slotsDisponibles.length > 0
        ? slotsDisponibles.map((s, i) => `  ${i + 1}. ${s.texto}`).join('\n')
        : 'Todavía no hay huecos cargados — necesito saber qué servicio quiere la clienta antes de buscar disponibilidad.';

    // Selected service info
    const selectedService = partialData.__selectedService;
    const selectedStylist = partialData.__selectedStylist;
    const clientLanguage = partialData.__clientLanguage || null;
    const langConstraint = clientLanguage
        ? `Idioma de la clienta (ya detectado): "${clientLanguage}". DEBES responder en "${clientLanguage}".`
        : 'Aún no se conoce el idioma. Detecta el idioma de su PRIMER mensaje y responde en ese mismo idioma.';

    // Modes
    let modoCita = '';
    if (citaConfirmada) {
        modoCita = `
MODO CITA CONFIRMADA:
* La cita ya está confirmada. NO vuelvas a pedir datos.
* Responde dudas con naturalidad.
* Si quiere cancelar → accion: "cancelar". Si quiere cambiar → accion: "cambiar".`;
    }

    const modoReagendamiento = partialData.__reagendando ? `
MODO REAGENDAMIENTO:
* La clienta quiere cambiar su cita. Buscando nuevos huecos.
* NUNCA devuelvas accion: "cambiar" — ya estamos en ese flujo.` : '';

    let modoClienteRecurrente = '';
    if (partialData.__clienteRecurrente) {
        const stylistHabitual = partialData.__preferredStylistName;
        const ultimoServicio = partialData.__ultimoServicio;
        const ultimaEstilista = partialData.__ultimaEstilista;
        let historialStr = partialData.__ultimaVisita
            ? `Su última visita fue el ${partialData.__ultimaVisita}.`
            : 'Ya ha venido al salón antes.';
        if (ultimoServicio) {
            historialStr += ` Su último servicio fue ${ultimoServicio}`;
            if (ultimaEstilista) historialStr += ` con ${ultimaEstilista}`;
            historialStr += '.';
        }
        modoClienteRecurrente = `
CLIENTA RECURRENTE:
${historialStr}
${stylistHabitual ? `Su estilista habitual es ${stylistHabitual}. Sugiere primero esa estilista.` : ''}
Salúdala con calidez, como a alguien que ya conoces. Puedes hacer referencia a su último servicio de forma natural.`;
    }

    // Next step logic
    const proximoPaso = (() => {
        if (citaConfirmada) return 'Sigue las instrucciones del modo cita confirmada.';
        if (partialData.__clienteRecurrente && !selectedService) return 'Saluda con calidez y pregunta en qué puedes ayudarla.';
        if (!partialData.nombre && !partialData.__clienteRecurrente) return 'Saluda y pregunta cómo se llama.';
        if (!selectedService) return 'Pregunta qué servicio necesita. Si no tiene claro, ofrécele las categorías principales.';
        if (partialData.__upsellingSuggested === false) return `UPSELLING: antes de buscar disponibilidad, sugiere los servicios complementarios de forma natural y sutil. No los impongas.`;
        if (!selectedStylist && !partialData.__stylistAutoAssigned) return '¿Tiene preferencia por alguna estilista en concreto? Si no, le asignamos la mejor disponible.';
        if (slotsDisponibles.length > 0) return `Propón los huecos disponibles. Pregunta cuál le va bien.`;
        return 'Espera confirmación o nueva preferencia.';
    })();

    const contextoActual = `Intención detectada: ${intent}\nDatos recogidos: ${JSON.stringify(partialData, null, 2)}`;
    const resumenAnterior = summary ? `RESUMEN DE CONVERSACIONES ANTERIORES:\n${summary}` : '';

    return `# ── IDENTIDAD ──────────────────────────────────────────────────────────────

Eres ${botName}, la asistente virtual de ${salonName}, un salón de belleza y bienestar en Alicante.
Atiendes por WhatsApp a las clientas para agendar citas, resolver dudas y sugerir servicios.
Tono: cercano, cálido y profesional. Como una amiga que trabaja en el salón.

# ── IDIOMA (OBLIGATORIO) ──────────────────────────────────────────────────

REGLA CRÍTICA: El campo "respuesta" DEBE estar en el idioma de la clienta, NO en español (a menos que hable español).
Aunque estas instrucciones están en español, tu respuesta SIEMPRE va en el idioma detectado.

${langConstraint}

Idiomas soportados: español ("es"), inglés ("en"), ruso ("ru"), ucraniano ("uk").
Incluye "idioma_detectado" con el código correspondiente.

Ejemplos:

Cliente: "Hi, I'd like to book an appointment"
→ "respuesta": "Hi! Welcome to Santé 😊 What's your name?", "idioma_detectado": "en"

Cliente: "Привет, хочу записаться"
→ "respuesta": "Привет! Добро пожаловать в Santé 😊 Как тебя зовут?", "idioma_detectado": "ru"

Cliente: "Привіт, хочу записатися"
→ "respuesta": "Привіт! Ласкаво просимо до Santé 😊 Як тебе звати?", "idioma_detectado": "uk"

Cliente: "Hola, quiero pedir cita"
→ "respuesta": "¡Hola! Bienvenida a Santé 😊 ¿Cómo te llamas?", "idioma_detectado": "es"

# ── EL SALÓN ───────────────────────────────────────────────────────────────

${direccion}
Política de cancelación: ${cancelacion}

# ── EQUIPO ─────────────────────────────────────────────────────────────────

${equipoStr}

# ── CATÁLOGO DE SERVICIOS ──────────────────────────────────────────────────

${catalogoStr}

# ── REGLAS DE UPSELLING ────────────────────────────────────────────────────

Después de que la clienta elija su servicio principal, sugiere de forma natural UN servicio complementario según estas reglas:
${upsellingStr}

No insistas si dice que no. Sé sutil: "Mientras el color actúa, ¿te gustaría aprovechar para una manicura?"

# ── DISPONIBILIDAD ─────────────────────────────────────────────────────────

HUECOS DISPONIBLES:
${slotsStr}

NUNCA inventes fechas, horas ni disponibilidad. Solo usa los huecos de esta lista.

# ── DATO QUE NECESITAS AHORA ───────────────────────────────────────────────

SIGUIENTE PASO: ${proximoPaso}

FLUJO DE LA CITA:
1. Saludo → pregunta nombre si es nueva (si es recurrente, salúdala por nombre).
2. Pregunta qué servicio necesita. Si dice algo genérico ("cortarme el pelo"), mapéalo al servicio más probable del catálogo.
3. Confirma servicio + precio + duración.
4. UPSELLING: sugiere UN servicio complementario según las reglas.
5. ¿Tiene preferencia de estilista? Si es recurrente, sugiere su estilista habitual. Si no pide ninguna, dile que le asignamos la mejor disponible.
6. Propón los huecos disponibles (máximo 3). Pregunta cuál le va bien.
7. Cuando acepte un hueco → marca cita_confirmada: true.

# ── MODOS ESPECIALES ──────────────────────────────────────────────────────
${modoCita}
${modoReagendamiento}
${modoClienteRecurrente}

# ── CONTEXTO ACTUAL ────────────────────────────────────────────────────────

${contextoActual}

${resumenAnterior}

# ── PERSONALIDAD Y TONO ────────────────────────────────────────────────────

- Habla de forma natural. Frases cortas y directas.
- 0 o 1 emoji por mensaje.
- Nunca digas nada robótico.
- Máximo 3-4 líneas por mensaje. Una sola pregunta por mensaje.

# ── REGLAS DURAS ───────────────────────────────────────────────────────────

1. Una pregunta por mensaje. Nunca dos seguidas.
2. Nunca inventes huecos, fechas, precios ni datos.
3. Si la clienta pide algo que no puedes gestionar → accion: "escalar_humano". Di: "${handoffMessage}"
4. Si llega solo con "hola", pregunta qué necesita.

# ── FORMATO DE SALIDA ──────────────────────────────────────────────────────

Responde SIEMPRE con este JSON y nada más:

{
  "respuesta": "mensaje para la clienta",
  "cita_confirmada": false,
  "slot_rechazado": false,
  "accion": null,
  "idioma_detectado": "es",
  "datos": {
    "nombre": null,
    "servicio": null,
    "categoria_servicio": null,
    "estilista_preferida": null,
    "fecha_cita": null,
    "hora_cita": null,
    "upselling_aceptado": [],
    "notas": null
  }
}

Valores posibles de accion: "cancelar" | "cambiar" | "escalar_humano" | null
cita_confirmada: true → solo cuando la clienta acepta explícitamente un hueco. NUNCA junto con slot_rechazado: true.`;
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

function buildSystemPrompt(orgId, partialData, intent, reservaConfirmada, summary, agentCfg) {
    const orgType = getOrgType(orgId);
    if (orgType === 'salon') {
        return buildSantePrompt(partialData, intent, reservaConfirmada, summary, agentCfg);
    }
    return buildSanRemoPrompt(partialData, intent, reservaConfirmada, summary, agentCfg);
}

function getFallbackResponse(orgId, language) {
    const orgType = getOrgType(orgId);
    const fallbackMessages = {
        en: 'I lost connection for a moment 😅 Could you repeat that?',
        ru: 'Связь прервалась на секунду 😅 Можешь повторить?',
        uk: "Зв'язок перервався на мить 😅 Можеш повторити?",
    };
    const fallbackText = (language && fallbackMessages[language]) || 'Se me ha ido la conexión un momento 😅 ¿me repites eso?';
    const base = {
        respuesta: fallbackText,
        slot_rechazado: false,
        accion: null,
    };
    if (orgType === 'salon') {
        return {
            ...base,
            cita_confirmada: false,
            idioma_detectado: language || 'es',
            datos: { nombre: null, servicio: null, categoria_servicio: null, estilista_preferida: null, fecha_cita: null, hora_cita: null, upselling_aceptado: [], notas: null },
        };
    }
    return {
        ...base,
        reserva_confirmada: false,
        datos: { nombre: null, telefono: null, personas: null, fecha_cita: null, hora_cita: null, ocasion: null, allergies: null, preferences: null, notas: null },
    };
}

async function getChatbotResponse(orgId, history, partialData = {}, intent = 'general', reservaConfirmada = false, summary = null) {
    const clientLang = partialData?.__clientLanguage || null;
    if (!OPENAI_API_KEY) return getFallbackResponse(orgId, clientLang);

    const agentCfg = await db.getAgentConfig(orgId).catch(() => null);

    const cleanHistory = history
        .filter(m => m && m.content && typeof m.content === 'string' && m.content.trim())
        .slice(-14);

    const messages = [
        { role: 'system', content: buildSystemPrompt(orgId, partialData, intent, reservaConfirmada, summary, agentCfg) },
        ...cleanHistory.map(m => ({ role: m.role, content: m.content })),
    ];

    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            response = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: aiConfig.model || 'gpt-4o-mini',
                messages,
                temperature: aiConfig.temperature ?? 0.5,
                max_tokens: aiConfig.max_tokens ?? 450,
                response_format: { type: 'json_object' }
            }, {
                headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }
            });
            break;
        } catch (e) {
            if (attempt === 1) {
                logger.error('openai_error_definitivo', { error: e.response?.data || e.message });
                return getFallbackResponse(orgId, clientLang);
            }
            logger.warn('openai_reintentando');
        }
    }

    const raw = response?.data?.choices?.[0]?.message?.content;
    if (!raw || !raw.includes('{')) return getFallbackResponse(orgId, clientLang);

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return getFallbackResponse(orgId, clientLang);
    }

    if (!parsed.respuesta) return getFallbackResponse(orgId, clientLang);

    const orgType = getOrgType(orgId);
    if (orgType === 'salon') {
        const datosBase = { nombre: null, servicio: null, categoria_servicio: null, estilista_preferida: null, fecha_cita: null, hora_cita: null, upselling_aceptado: [], notas: null };
        parsed.datos = { ...datosBase, ...(parsed.datos || {}) };
        parsed.cita_confirmada = !!parsed.cita_confirmada;
        parsed.idioma_detectado = parsed.idioma_detectado || 'es';
        // Normalize: salon uses cita_confirmada, map to reserva_confirmada for bot.js compatibility
        parsed.reserva_confirmada = parsed.cita_confirmada;
    } else {
        const datosBase = { nombre: null, telefono: null, personas: null, fecha_cita: null, hora_cita: null, ocasion: null, allergies: null, preferences: null, notas: null };
        parsed.datos = { ...datosBase, ...(parsed.datos || {}) };
        parsed.reserva_confirmada = !!parsed.reserva_confirmada;
    }
    parsed.slot_rechazado = !!parsed.slot_rechazado;
    parsed.accion = parsed.accion || null;

    if (parsed.respuesta.length > (aiConfig.responseMaxLength || 280)) {
        parsed.respuesta = parsed.respuesta.slice(0, aiConfig.responseMaxLength || 280);
    }

    return parsed;
}

async function summarizeHistory(messages, partialData = {}) {
    if (!OPENAI_API_KEY || !messages?.length) return null;
    try {
        const conversation = messages
            .filter(m => m?.content)
            .map(m => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`)
            .join('\n');

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: 'Resume en 3-4 frases los puntos clave de esta conversación de WhatsApp. Incluye: nombre del cliente, servicio solicitado, fecha/hora de la cita, estilista, y cualquier detalle relevante. Sin saludos, solo hechos concretos.'
                },
                { role: 'user', content: conversation }
            ],
            temperature: 0.2,
            max_tokens: 200
        }, {
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }
        });

        return response?.data?.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
        logger.error('error_summarize_history', { error: e.message });
        return null;
    }
}

module.exports = { getChatbotResponse, getFallbackResponse, summarizeHistory };
