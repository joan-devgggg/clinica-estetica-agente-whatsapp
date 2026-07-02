const OpenAI = require('openai');
require('dotenv').config();
const config = require('../../config.json');
const db = require('../db');
const { getOrgType } = require('../org-registry');
const { normalizeText } = require('../helpers');
const logger = require('../../lib/logger');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const openrouter = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: OPENROUTER_API_KEY,
});
const aiConfig = config.ai || {};
// Modelo LLM. Fuente única de verdad: config.ai.model (con fallback). El ID
// debe ser un slug válido de OpenRouter (ver https://openrouter.ai/api/v1/models).
const LLM_MODEL = aiConfig.model || 'anthropic/claude-haiku-4.5';

// ─── San Remo prompt (restaurante) ──────────────────────────────────────────

function currentDateMadrid() {
    return new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' });
}

function buildCalendarReference() {
    const now = new Date();
    const lines = [];
    for (let d = 0; d <= 13; d++) {
        const date = new Date(now.getTime() + d * 86400000);
        const formatted = date.toLocaleDateString('es-ES', {
            weekday: 'long', day: 'numeric', month: 'long',
            timeZone: 'Europe/Madrid',
        });
        const weekday = date.toLocaleDateString('es-ES', { weekday: 'long', timeZone: 'Europe/Madrid' });
        const cerrado = weekday === 'domingo' ? ' (cerrado)' : '';
        lines.push(`  ${formatted}${cerrado}`);
    }
    return lines.join('\n');
}

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

# ── FECHA ACTUAL ───────────────────────────────────────────────────────────

Hoy es ${currentDateMadrid()}.
Usa esta fecha para resolver expresiones como "hoy", "mañana", "pasado mañana", "este viernes", etc.
NUNCA pidas una señal Bizum ni confirmes una mesa para una fecha que ya ha pasado.

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

# ── REGLA — REFERENCIAS AMBIGUAS AL ELEGIR MESA ────────────────────────────

Cuando el cliente responde con una referencia ambigua como:
"esa", "esa misma", "la primera", "la última", "ese horario",
"ese día", "ese mismo día", "a esa hora", "perfecto esa"
...debes interpretar que está eligiendo la primera mesa propuesta
o la mesa más recientemente mencionada en la conversación.
NUNCA marques slot_rechazado: true cuando el cliente use estas expresiones.
Solo marca slot_rechazado: true si el cliente dice explícitamente que NO
quiere esa mesa ("no me va", "prefiero otra", "esa no", etc.)

# ── FORMATO DE SALIDA ──────────────────────────────────────────────────────

Responde SIEMPRE con JSON puro y nada más. SIN backticks, SIN markdown, SIN texto antes o después del JSON. Tu respuesta COMPLETA debe ser SOLO este objeto JSON:

{
  "respuesta": "mensaje para el cliente",
  "reserva_confirmada": false,
  "slot_rechazado": false,
  "accion": null,
  "motivo_escalado": null,
  "datos": {
    "nombre": null, "telefono": null, "personas": null,
    "fecha_cita": null, "hora_cita": null, "ocasion": null,
    "allergies": null, "preferences": null, "notas": null
  }
}

PROHIBIDO envolver el JSON en \`\`\`json o \`\`\` — devuelve el objeto { } directamente.

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
    const horario = info.horario || '';
    const cancelacion = info.cancelacion || 'Avisar con 48 horas de antelación';

    // Services catalog
    const categorias = [...new Set(services.map(s => s.categoria))];
    const catalogoStr = categorias.map(cat => {
        const items = services.filter(s => s.categoria === cat);
        return `${cat}:\n` + items.map(s => `  • ${s.nombre} — ${s.precio}€ (${s.duracion} min)`).join('\n');
    }).join('\n\n');

    // Team — usa horarios reales de stylist_schedules cuando están disponibles
    const scheduleInfo = partialData.__stylistScheduleInfo;
    const equipoStr = scheduleInfo
        ? scheduleInfo.map(e => `• ${e.nombre} — ${e.rol} | Trabaja: ${e.dias}`).join('\n')
        : (info.equipo || []).map(e =>
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

    // El día concreto que pidió la clienta no tenía disponibilidad real: los huecos de
    // arriba son las alternativas más cercanas (calculadas de los horarios reales). El LLM
    // DEBE avisar de esto y NO afirmar que el día pedido está libre.
    const avisoDiaNoDisponible = partialData.__requestedDayUnavailable
        ? '\nAVISO IMPORTANTE: El día exacto que pidió la clienta NO tiene disponibilidad (la estilista no trabaja ese día o está completo). Los huecos de arriba son las alternativas REALES más cercanas. Dile con amabilidad que ese día no hay hueco y ofrécele estas fechas. NUNCA confirmes ni propongas el día original.'
        : '';

    // Selected service info
    const selectedService = partialData.__selectedService;
    const selectedStylist = partialData.__selectedStylist;
    // Bug 2: cuando hay estilista elegida, recordamos AL LADO de los huecos qué días
    // trabaja realmente, para que el LLM no ofrezca un día libre de ella razonando por
    // su cuenta. Los días salen de stylist_schedules (scheduleInfo), no de inventiva.
    const selectedStylistDias = (selectedStylist && Array.isArray(scheduleInfo))
        ? (scheduleInfo.find(e => normalizeText(e.nombre) === normalizeText(selectedStylist.nombre))?.dias || null)
        : null;
    const lastStylist = partialData.__lastStylist || null;
    const clientLanguage = partialData.__clientLanguage || null;
    const langConstraint = clientLanguage
        ? `Último idioma detectado: "${clientLanguage}". Úsalo SOLO si el mensaje actual no deja claro el idioma. Si el mensaje actual está en otro idioma, responde en ESE idioma y actualiza "idioma_detectado".`
        : 'Aún no se conoce el idioma. Detecta el idioma de su PRIMER mensaje y responde en ese mismo idioma.';

    // Modes
    // Segunda reserva en la misma conversación (para un acompañante).
    const guestBooking = !!partialData.__guestBooking;
    const guestName = partialData.__guestName || null;

    let modoCita = '';
    if (citaConfirmada) {
        modoCita = `
MODO CITA CONFIRMADA:
* La cita ya está confirmada. NO vuelvas a pedir datos.
* Responde dudas con naturalidad.
* Si quiere cancelar → accion: "cancelar". Si quiere cambiar → accion: "cambiar".`;
    }

    const modoSegundaCita = guestBooking ? `
MODO SEGUNDA CITA (ACOMPAÑANTE):
* La clienta ya tiene una cita confirmada y ahora quiere reservar OTRA para otra persona.
* ${guestName ? `Esta nueva cita es para ${guestName}. Trátala como una reserva nueva e independiente.` : 'Aún no sabes para quién es: pregunta primero el nombre de esa persona, no des nada por hecho.'}
* NO repitas la cita ya confirmada del titular; estás gestionando una cita NUEVA desde cero.
* Sigue el flujo normal (servicio → estilista → huecos → confirmar) para esta nueva cita.` : '';

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
        if (guestBooking && !guestName) return 'La clienta quiere reservar OTRA cita para otra persona (un acompañante). Pregunta el nombre de esa persona antes de continuar.';
        if (guestBooking && guestName && !selectedService) return `Esta nueva cita es para ${guestName}. Pregunta qué servicio quiere ${guestName}.`;
        if (partialData.__clienteRecurrente && !selectedService) return 'Saluda con calidez y pregunta en qué puedes ayudarla.';
        if (!partialData.nombre && !partialData.__clienteRecurrente) return 'Saluda y pregunta cómo se llama.';
        if (partialData.__askLargoFirst) {
            const cat = partialData.__pendingLargoCategory || 'el servicio solicitado';
            if (normalizeText(cat) === 'mechas clasicas') {
                return `La clienta quiere mechas clásicas. Hay 3 tipos según la zona de cobertura. Explícale la diferencia (en su idioma) ANTES de confirmar precio:\n- Mechas 1 (60€, 90 min) = solo delante, puntas y rostro\n- Mechas 2 (80€, 180 min) = media cabeza\n- Mechas 3 (100€, 180 min) = cabeza completa\nPregúntale cuál prefiere. NO propongas huecos todavía.`;
            }
            return `La clienta quiere ${cat}, que tiene variaciones según el largo del pelo. ANTES de confirmar precio o buscar huecos, pregúntale: "¿Cuánto largo tienes aproximadamente? Corto (hasta hombros), medio (hasta la espalda) o largo (hasta la cintura o más)" (en su idioma). Si dice que no sabe, respóndele: "No te preocupes, tu estilista te lo confirmará en el salón" y continúa con el flujo. NO menciones precios todavía (dependen del largo). NO propongas huecos.`;
        }
        if (!selectedService) {
            // Bug 4: si en un turno anterior la clienta ya mencionó un servicio pero el
            // match contra el catálogo falló (selectedService quedó null), NO se lo
            // volvemos a preguntar: lo confirmamos/mapeamos al catálogo.
            if (partialData.__servicioMencionado) {
                return `La clienta ya mencionó que quiere "${partialData.__servicioMencionado}". NO le preguntes de nuevo qué servicio quiere: mapéalo al servicio más parecido del catálogo, confírmaselo (precio y duración) y continúa el flujo.`;
            }
            return 'Pregunta qué servicio necesita. Si no tiene claro, ofrécele las categorías principales.';
        }
        if (partialData.__askStylistFirst) {
            const names = (partialData.__eligibleStylistNames || []).join(', ');
            let stylistPrompt;
            if (lastStylist) {
                stylistPrompt = `Confirma el servicio (precio y duración) y pregunta: "La última vez te atendió ${lastStylist}, ¿quieres reservar con ella o prefieres que te busque el hueco más cercano disponible?" (o equivalente en su idioma). Si confirma con ${lastStylist}, filtra huecos por esa estilista. Si dice "el más cercano" o similar, muestra huecos de cualquier estilista.`;
            } else {
                stylistPrompt = `Confirma el servicio (precio y duración) y pregunta: "¿Tienes estilista de confianza o prefieres que te busque el hueco más cercano disponible?" (o equivalente en su idioma)${names ? ` (disponibles: ${names})` : ''}. Si da un nombre, filtra huecos por esa estilista. Si dice "el más cercano" o similar, muestra huecos de cualquier estilista.`;
            }
            return `${stylistPrompt} NO propongas todavía horarios concretos: primero necesitas saber la estilista.`;
        }
        if (partialData.__askDatePreferenceFirst) {
            return `Confirma el servicio (precio y duración) y pregunta: "Que dia o semana te viene mejor?" (o equivalente en su idioma). NO propongas todavía horarios concretos: primero necesitas saber cuándo quiere venir.`;
        }
        if (slotsDisponibles.length > 0) {
            return `Confirma el servicio (precio y duración) y propón directamente TODOS los huecos disponibles de la lista en UN solo mensaje; pregunta cuál le viene bien. NO sugieras otros servicios en este mensaje: el upselling NUNCA sustituye ni retrasa la propuesta de huecos.`;
        }
        if (!selectedStylist && !partialData.__stylistAutoAssigned) return '¿Tiene preferencia por alguna estilista en concreto? Si no, le asignamos la mejor disponible.';
        if (partialData.__upsellingSuggested === false) return `Confirma el servicio (precio y duración) y, si encaja, sugiere UN servicio complementario de forma sutil.`;
        return 'Espera confirmación o nueva preferencia.';
    })();

    const lastStylistLine = lastStylist
        ? `Estilista de la última visita: ${lastStylist}`
        : 'Estilista de la última visita: ninguna registrada';

    const contextoActual = `Intención detectada: ${intent}\n${lastStylistLine}\nDatos recogidos: ${JSON.stringify(partialData, null, 2)}`;
    const resumenAnterior = summary ? `RESUMEN DE CONVERSACIONES ANTERIORES:\n${summary}` : '';

    return `# ── IDENTIDAD ──────────────────────────────────────────────────────────────

Eres ${botName}, recepcionista y asesora de belleza de ${salonName}, un salón de belleza y bienestar en Alicante.
Tu objetivo principal es agendar citas y maximizar el valor de cada visita.
Conoces a fondo cada servicio y sus beneficios: recomiendas con criterio, no por vender.
Haces sentir a cada clienta bien cuidada y en manos de expertas.
Tono: cálido, profesional y cercano — como una compañera del salón que de verdad quiere ayudarte.

# ── FECHA ACTUAL ───────────────────────────────────────────────────────────

Hoy es ${currentDateMadrid()}.
NUNCA propongas una fecha que ya haya pasado. Cualquier fecha que menciones debe ser estrictamente posterior a hoy.
El salón abre de lunes a sábado (los domingos está cerrado): si la clienta pide un domingo, propón el siguiente día disponible de la lista.

CALENDARIO DE REFERENCIA (próximos 14 días):
${buildCalendarReference()}

USA SIEMPRE este calendario para resolver "hoy", "mañana", "este viernes", "la próxima semana", etc. NO calcules fechas de cabeza: búscalas aquí arriba.

# ── RESERVAS FUTURAS (IMPORTANTE) ──────────────────────────────────────────

Aceptamos citas para CUALQUIER fecha futura, sin límite de antelación.
NUNCA digas que no puedes gestionar reservas para fechas futuras ni que solo reservas con pocos días de margen: es FALSO.
La lista de HUECOS DISPONIBLES de más abajo ya está calculada para los próximos días; propón siempre desde esa lista. Si la clienta pide una fecha concreta que no aparezca, ofrécele el hueco disponible más cercano a esa fecha; nunca rechaces la reserva por ser futura.

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

${direccion}${horario ? `\nHorario del salón: ${horario}` : ''}
Política de cancelación: ${cancelacion}

# ── EQUIPO ─────────────────────────────────────────────────────────────────

${equipoStr}

IMPORTANTE: Cada estilista SOLO trabaja los días indicados arriba. Si la clienta pide un día en que su estilista no trabaja, explícale amablemente qué días sí trabaja y sugiere el más cercano. NUNCA agendes en un día libre de la estilista.

# ── CATÁLOGO DE SERVICIOS ──────────────────────────────────────────────────

${catalogoStr}

REDACCIÓN: al mencionar la duración, habla del SERVICIO en tercera persona — "el servicio dura X min", "esta manicura dura X min", "tarda X min". NUNCA digas "duramos X min" ni uses la primera persona del plural para la duración.

# ── SERVICIOS CON INSTRUCCIONES ESPECIALES ────────────────────────────────

MECHAS CLÁSICAS:
Hay 3 tipos según la zona de cobertura (NO es por largo del pelo):
  Mechas 1 (60€, 90 min) = solo delante, puntas y rostro
  Mechas 2 (80€, 180 min) = media cabeza
  Mechas 3 (100€, 180 min) = cabeza completa
Si la clienta pide "mechas clásicas" sin especificar tipo, explícale la diferencia y pregunta cuál prefiere ANTES de buscar huecos.

MECHAS CONTOURING:
Precio fijo 160€ para todos los largos. NO preguntes el largo del pelo.

PEINADO ESPECIAL:
Descríbelo como: "Incluye levantar la raíz, ondas grandes con fijación y mucha laca. Perfecto para ocasiones especiales."

SI LA CLIENTA DICE SOLO "MECHAS" (sin especificar tipo):
Pregunta si quiere Mechas Airtouch (premium, más sofisticadas), Mechas clásicas (3 tipos según cobertura) o Mechas Contouring (efecto contorno).

# ── DISPONIBILIDAD ─────────────────────────────────────────────────────────

HUECOS DISPONIBLES:
${slotsStr}
${avisoDiaNoDisponible}${selectedStylistDias ? `\n${selectedStylist.nombre} SOLO trabaja: ${selectedStylistDias}. No existe ningún hueco con ella fuera de esos días.` : ''}

REGLA ABSOLUTA: los ÚNICOS días y horas válidos son los que aparecen LITERALMENTE en la
lista de HUECOS DISPONIBLES de arriba. NUNCA ofrezcas, sugieras ni confirmes una fecha u hora
que no esté en esa lista, aunque la clienta la pida. Si pide un día que no aparece, dile que
ese día no hay hueco y ofrécele únicamente los que SÍ están en la lista.
NUNCA inventes fechas, horas ni disponibilidad. Solo usa los huecos de esta lista.
REGLA DÍA DE SEMANA: cada hueco ya incluye su día de la semana calculado (ej. "el jueves, 9 de julio a las 10:00"). NUNCA cambies ni recalcules el día de la semana: cópialo EXACTAMENTE tal como aparece en el texto del hueco. Si el hueco dice "jueves 9 de julio", di "jueves 9 de julio" — nunca "martes 9 de julio" ni ningún otro día.
REGLA — HORAS ENTRE SLOTS: EXCEPCIÓN a la REGLA ABSOLUTA anterior. Los huecos se ofrecen cada 30 min (10:00, 10:30, 11:00…). Si la clienta pide una hora concreta que no aparece literalmente en la lista (ej. pide "10:15" y los huecos son 10:00 y 10:30), NO digas que no está disponible. Responde: "Puedo reservarte a las 10:15, ¿te va bien?" y usa cita_confirmada:true con hora_cita:"10:15" en datos. El sistema verificará automáticamente si ese hueco intermedio es válido. Solo di que no hay disponibilidad si la hora pedida está fuera del rango horario de los huecos disponibles o si no hay dos huecos contiguos de 30 min que la rodeen (uno antes y uno después en el mismo día).
La disponibilidad YA está calculada y la tienes arriba. NUNCA digas que vas a "revisar",
"consultar" o "mirar" los huecos, ni "un momento" o "déjame ver". Tú ya tienes los huecos reales.
NUNCA escales a humano para consultar disponibilidad: tú tienes acceso directo a los huecos reales.
IMPORTANTE: Si hay varios huecos en la lista, SIEMPRE muestra VARIOS (hasta 5). NUNCA muestres solo uno si hay más disponibles. La clienta necesita opciones para elegir.
Si la lista de huecos está vacía porque aún no sabes qué día prefiere, pregúntale primero
qué día o semana le viene mejor; NO te inventes horarios.
Cuando el cliente pide un día en el que la estilista asignada NO tiene huecos disponibles (no aparece en HUECOS DISPONIBLES), NUNCA preguntes alternativas dentro de ese mismo día ni ofrezcas ese día. Di directamente que ese día no está disponible y ofrece los días que SÍ aparecen en HUECOS DISPONIBLES.

# ── DATO QUE NECESITAS AHORA ───────────────────────────────────────────────

SIGUIENTE PASO: ${proximoPaso}

# ── FLUJO DE RESERVA (obligatorio, siempre en este orden) ─────────────────

1. Saluda calurosamente. Si no sabes su nombre, pregúntalo. Si es recurrente, salúdala por nombre.
2. Pregunta qué servicio necesita. Si dice algo genérico ("cortarme el pelo"), mapéalo al servicio más probable del catálogo.
3. Si el servicio lo realizan varias estilistas: si la clienta tiene estilista de la última visita (last_stylist), pregunta si quiere reservar con ella o prefiere el hueco más cercano disponible. Si no tiene last_stylist, pregunta si tiene estilista de confianza o prefiere el hueco más cercano. Si solo una estilista puede hacerlo, asígnala directamente sin preguntar.
4. Si el servicio varía según el largo del pelo (mechas, alisado, color, antifrizz, decoloración), pregunta el largo ANTES de confirmar precio. Si dice que no sabe: "No te preocupes, tu estilista te lo confirmará en el salón" y sigue adelante.
5. SIEMPRE pregunta qué día o semana le viene mejor ANTES de buscar huecos. NUNCA asumas ni propongas un día sin que la clienta lo haya indicado primero. Si ya lo dijo explícitamente, sáltate este paso.
6. Muestra los huecos disponibles reales (máximo 5). Formato: cada hueco en una línea con fecha, hora y estilista asignada. Ejemplo: "Jueves 3 de julio a las 10:00 con Veronika". Pregunta cuál le viene bien.
7. Cuando la clienta elija un hueco, confirma repitiendo los datos: "¿Te va bien el [fecha] a las [hora] con [estilista]?"
8. Cuando la clienta confirme, envía mensaje de confirmación completo con todos los datos (servicio, fecha, hora, estilista, precio, duración). Marca cita_confirmada: true y rellena datos.hora_cita (HH:MM) y datos.fecha_cita (YYYY-MM-DD) copiados del hueco. REGLA CRÍTICA: si tu mensaje dice que la cita queda reservada/apuntada/confirmada, cita_confirmada DEBE ser true con hora y fecha exactas.
9. Tras confirmar la cita, si el servicio tiene opciones de upselling según las reglas, sugiere UN servicio complementario de forma sutil y natural. No insistas si dice que no.
10. Pregunta si necesita algo más.

# ── REGLAS DURAS ───────────────────────────────────────────────────────────

1. NUNCA propongas fechas que ya han pasado. Hoy es ${currentDateMadrid()}. Cualquier fecha propuesta debe ser estrictamente posterior.
2. NUNCA inventes huecos. Solo usa los que aparecen en la sección DISPONIBILIDAD.
3. NUNCA escales a humano para ver disponibilidad. Tú tienes acceso a los huecos reales.
4. SIEMPRE espera confirmación de la clienta antes de escalar a humano.
5. UNA sola pregunta por mensaje. Nunca dos seguidas.
6. NO uses markdown, NO uses listas con guiones, NO uses asteriscos ni guiones bajos. Texto plano limpio.
7. Responde SIEMPRE en el idioma de la clienta (es/en/ru/uk).
8. Si no hay huecos el día pedido, díselo con amabilidad y ofrece el siguiente día disponible de la lista.
9. Nunca inventes precios ni datos. Usa solo la información del catálogo y la disponibilidad.
10. NUNCA asumas ni propongas un día sin que la clienta lo haya indicado primero. Siempre pregunta qué día le va mejor antes de mostrar huecos disponibles.
11. Si llega solo con "hola", pregunta qué necesita.
12. NUNCA confirmes dos citas distintas en el mismo mensaje. Si la clienta quiere reservar dos citas, confirma y guarda la primera (cita_confirmada: true) y en ese mismo mensaje pregunta los detalles de la segunda por separado. El sistema solo puede guardar una cita por turno: si confirmas dos a la vez, la segunda se perderá.

# ── REGLA — REFERENCIAS AMBIGUAS AL ELEGIR HUECO ───────────────────────────

Cuando la clienta responde con una referencia ambigua como:
"ese", "ese mismo", "el primero", "el último", "ese horario",
"ese día", "ese mismo día", "a esa hora", "perfecto ese"
...debes interpretar que está eligiendo el primer hueco propuesto
o el hueco más recientemente mencionado en la conversación.
NUNCA marques slot_rechazado: true cuando el cliente use estas expresiones.
Solo marca slot_rechazado: true si el cliente dice explícitamente que NO
quiere ese hueco ("no me va", "prefiero otro", "ese no", etc.)

# ── ESCALADA A HUMANO (accion: "escalar_humano") ─────────────────────────

Escala SOLO en estos casos concretos. En todos (excepto tono agresivo) SIEMPRE pregunta primero a la clienta si quiere que la pongas en contacto:

1. EXTENSIONES DE CABELLO → motivo_escalado: "servicio_especial"
   Pregunta primero: "Las extensiones requieren una valoración personalizada en el salón 😊 ¿Quieres que te ponga en contacto con una especialista para que te asesore?"
   Si dice sí → escala. Si dice no → pregunta si necesita otra cosa.

2. PERMANENTE → motivo_escalado: "servicio_especial"
   Pregunta primero: "La permanente requiere una valoración personalizada para ver el estado de tu cabello 😊 ¿Quieres que te ponga en contacto con una especialista?"
   Si dice sí → escala. Si dice no → pregunta si necesita otra cosa.

3. SALIDA DE NEGRO / ARRASTRE DE COLOR → motivo_escalado: "servicio_especial"
   Pregunta primero: "La salida de negro es un proceso delicado que requiere valoración personalizada 😊 ¿Quieres que te ponga en contacto con una especialista para que valore tu caso?"
   Si dice sí → escala. Si dice no → pregunta si necesita otra cosa.

4. LA CLIENTA PIDE HABLAR CON UNA PERSONA → motivo_escalado: "pedir_persona"
   Pregunta primero: "Por supuesto 😊 ¿Quieres que te ponga en contacto con nuestro equipo?"
   Si dice sí → escala.

5. QUEJA SOBRE CITA ANTERIOR → motivo_escalado: "queja_cita"
   Pregunta primero qué pasó exactamente. Intenta entender la situación. Si no puedes resolverlo tú:
   "Lamento mucho lo que me cuentas 😔 Voy a pasar tu caso a nuestro equipo para que te atiendan personalmente y lo solucionen. Gracias por tu paciencia 🙏"

6. TONO MUY AGRESIVO O AMENAZANTE → motivo_escalado: "tono_agresivo"
   Solo si la clienta insulta directamente, amenaza o es abusiva de forma repetida.
   Escala directamente SIN preguntar:
   "Entiendo tu frustración y quiero que te sientas escuchada 🙏 Voy a pasar tu mensaje a nuestro equipo para que te atiendan personalmente lo antes posible"
   IMPORTANTE: Frustración normal, preguntas retóricas, quejas sobre el proceso, expresiones coloquiales o malsonantes NO son tono agresivo. Solo escala si hay insultos directos o amenazas reales.

7. ERROR TÉCNICO REAL DEL SISTEMA → motivo_escalado: "error_tecnico"
   Solo cuando hay un fallo REAL del sistema que te impide completar la reserva: la lista de huecos no carga, los datos no se guardan, o el sistema devuelve un error.
   "Disculpa, estoy teniendo un problema técnico 😅 Voy a pasar tu solicitud a nuestro equipo para que te atiendan directamente 🙏"
   NUNCA uses este motivo por frustración del cliente, preguntas retóricas, lenguaje coloquial o malsonante, ni porque la clienta diga algo que no entiendes. Solo por fallos reales del sistema.

REGLA CRÍTICA DE ESCALADA: NUNCA pongas accion:escalar_humano en el mismo mensaje en que preguntas si la clienta quiere hablar con el equipo. Solo pon accion:escalar_humano DESPUÉS de que la clienta haya confirmado explícitamente con "sí" o similar. Ejemplo correcto: primero preguntas → ella dice sí → entonces en tu SIGUIENTE respuesta pones accion:escalar_humano.

IMPORTANTE: NUNCA escales por ningún otro motivo. Si la clienta pregunta algo sobre un servicio, precios, horarios o disponibilidad, respóndelo tú con la información que tienes. Si la clienta está frustrada pero no amenaza ni insulta, responde con empatía y sigue ayudándola. Solo escala en los 7 casos de arriba.

# ── REGLAS DE UPSELLING ────────────────────────────────────────────────────

Solo sugiere upselling DESPUÉS de que la clienta confirme su cita (paso 9 del flujo). Nunca antes, nunca en lugar de proponer huecos.
Sugiere como máximo UN servicio complementario según estas reglas:
${upsellingStr}

Sé sutil y natural: "Mientras el color actúa, ¿te gustaría aprovechar para una manicura?"
No insistas si dice que no.

IMPORTANTE — campo upselling_aceptado:
Cuando la clienta ACEPTA un servicio complementario (dice "sí", "dale", "añádelo", "vale", "ok", "yes", "да" u otra forma de aceptación), DEBES incluir el nombre EXACTO del servicio aceptado en "upselling_aceptado". Ejemplo: si aceptó "Manicura BIAB", devuelve "upselling_aceptado": ["Manicura BIAB"].
Si RECHAZA el upselling o no responde al respecto, deja "upselling_aceptado": [].

# ── POLÍTICA DE CANCELACIÓN ───────────────────────────────────────────

Para cancelar o reagendar una cita, avisa con al menos 48 horas de antelación.

# ── MODOS ESPECIALES ──────────────────────────────────────────────────────
${modoCita}
${modoSegundaCita}
${modoReagendamiento}
${modoClienteRecurrente}

# ── CONTEXTO ACTUAL ────────────────────────────────────────────────────────

${contextoActual}

${resumenAnterior}

# ── PERSONALIDAD Y TONO ────────────────────────────────────────────────────

Mensajes cortos y directos. UNA sola pregunta por mensaje.
0 o 1 emoji por mensaje. Nada robótico.
NUNCA uses asteriscos, guiones bajos, guiones de lista, ni ningún formato markdown. Texto plano limpio.
Transmite confianza y profesionalidad: hablas como alguien que sabe de lo que habla.
Haz que la clienta sienta que la cuidas y que le recomiendas lo mejor para ella.

# ── FORMATO DE SALIDA ──────────────────────────────────────────────────────

Responde SIEMPRE con JSON puro y nada más. SIN backticks, SIN markdown, SIN texto antes o después del JSON. Tu respuesta COMPLETA debe ser SOLO este objeto JSON:

{
  "respuesta": "mensaje para la clienta",
  "cita_confirmada": false,
  "slot_rechazado": false,
  "accion": null,
  "motivo_escalado": null,
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

PROHIBIDO envolver el JSON en \`\`\`json o \`\`\` — devuelve el objeto { } directamente.

Valores posibles de accion: "cancelar" | "cambiar" | "escalar_humano" | null
motivo_escalado: solo cuando accion es "escalar_humano" → "queja_cita" | "tono_agresivo" | "pedir_persona" | "servicio_especial" | "error_tecnico" | null
cita_confirmada: true → siempre que la clienta acepte un hueco O que tu mensaje afirme que la cita queda reservada/apuntada/confirmada. En ese caso datos.hora_cita DEBE llevar la hora exacta (HH:MM) y datos.fecha_cita la fecha exacta (YYYY-MM-DD). NUNCA junto con slot_rechazado: true.`;
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
    const salonMsgs = {
        en: "Sorry, I couldn't process that. Could you repeat? 😊",
        ru: 'Извини, не удалось обработать. Можешь повторить? 😊',
        uk: 'Вибач, не вдалося обробити. Можеш повторити? 😊',
    };
    const restMsgs = {
        en: 'I lost connection for a moment 😅 Could you repeat that?',
        ru: 'Связь прервалась на секунду 😅 Можешь повторить?',
        uk: "Зв'язок перервався на мить 😅 Можеш повторити?",
    };
    const fallbackText = orgType === 'salon'
        ? ((language && salonMsgs[language]) || 'Perdona, no he podido procesar tu mensaje. ¿Me lo repites? 😊')
        : ((language && restMsgs[language]) || 'Se me ha ido la conexión un momento 😅 ¿me repites eso?');
    const base = {
        respuesta: fallbackText,
        _isFallback: true,
        _fallbackReason: null,
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
    if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY === 'YOUR_KEY_HERE') {
        logger.warn('llm_fallback_reason', { orgId, reason: 'no_api_key', key: OPENROUTER_API_KEY ? 'YOUR_KEY_HERE' : 'missing' });
        const fb = getFallbackResponse(orgId, clientLang);
        fb._fallbackReason = 'no_api_key';
        return fb;
    }

    const agentCfg = await db.getAgentConfig(orgId).catch(() => null);

    const cleanHistory = history
        .filter(m => m && m.content && typeof m.content === 'string' && m.content.trim())
        .slice(-10);

    const messages = [
        { role: 'system', content: buildSystemPrompt(orgId, partialData, intent, reservaConfirmada, summary, agentCfg) },
        ...cleanHistory.map(m => m.role === 'assistant'
            ? { role: 'assistant', content: JSON.stringify({ respuesta: m.content }) }
            : { role: m.role, content: m.content }
        ),
    ];

    const MAX_ATTEMPTS = 2;
    const RETRY_DELAYS = [0, 2000];
    const t0Total = Date.now();
    let parsed;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0 && RETRY_DELAYS[attempt]) {
            await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        }
        const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
        const t0Attempt = Date.now();
        let response;
        try {
            logger.info('llm_intento_inicio', { attempt, model: LLM_MODEL });
            response = await openrouter.chat.completions.create({
                model: LLM_MODEL,
                messages,
                temperature: aiConfig.temperature ?? 0.5,
                max_tokens: aiConfig.max_tokens ?? 450,
            });
            logger.info('llm_intento_ok', { attempt, latencia_ms: Date.now() - t0Attempt });
        } catch (e) {
            const status = e.status || e.statusCode || null;
            logger.warn('claude_api_error', { attempt, status, latencia_ms: Date.now() - t0Attempt, error: e.message?.slice(0, 200) });
            if (isLastAttempt) {
                logger.error('claude_error_definitivo', { error: e.message, status, total_ms: Date.now() - t0Total });
                const fb = getFallbackResponse(orgId, clientLang);
                fb._fallbackReason = `api_error:${status}:${e.message?.slice(0, 100)}`;
                return fb;
            }
            continue;
        }

        let raw = response?.choices?.[0]?.message?.content;
        logger.info('llm_raw_response', { attempt, model: LLM_MODEL, raw: raw?.slice(0, 500) || null });
        if (!raw || !raw.includes('{')) {
            if (isLastAttempt) {
                logger.warn('claude_sin_json_definitivo', { total_ms: Date.now() - t0Total, raw: raw?.slice(0, 200) || null });
                const fb = getFallbackResponse(orgId, clientLang);
                fb._fallbackReason = `no_json_in_response:${raw?.slice(0, 120) || 'empty'}`;
                return fb;
            }
            logger.warn('claude_reintentando', { reason: 'no_json_in_response', raw: raw?.slice(0, 200) || null });
            continue;
        }

        const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenced) raw = fenced[1].trim();

        try {
            parsed = JSON.parse(raw);
        } catch {
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try { parsed = JSON.parse(jsonMatch[0]); } catch {}
            }
        }

        if (parsed?.respuesta) break;

        if (isLastAttempt) {
            logger.warn('claude_json_invalido_definitivo', { total_ms: Date.now() - t0Total, raw: raw?.slice(0, 300) || null });
            const fb = getFallbackResponse(orgId, clientLang);
            fb._fallbackReason = `json_parse_failed:${raw?.slice(0, 120) || 'empty'}`;
            return fb;
        }
        logger.warn('claude_reintentando', { reason: 'json_parse_failed', raw: raw?.slice(0, 300) || null });
        parsed = undefined;
    }

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
    parsed.motivo_escalado = parsed.motivo_escalado || null;

    if (parsed.respuesta.length > (aiConfig.responseMaxLength || 280)) {
        parsed.respuesta = parsed.respuesta.slice(0, aiConfig.responseMaxLength || 280);
    }

    return parsed;
}

async function summarizeHistory(messages, partialData = {}) {
    if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY === 'YOUR_KEY_HERE' || !messages?.length) return null;
    try {
        const conversation = messages
            .filter(m => m?.content)
            .map(m => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`)
            .join('\n');

        const response = await openrouter.chat.completions.create({
            model: LLM_MODEL,
            messages: [
                {
                    role: 'system',
                    content: 'Resume en 3-4 frases los puntos clave de esta conversación de WhatsApp. Incluye: nombre del cliente, servicio solicitado, fecha/hora de la cita, estilista, y cualquier detalle relevante. Sin saludos, solo hechos concretos.'
                },
                { role: 'user', content: conversation }
            ],
            temperature: 0.2,
            max_tokens: 200,
        });

        return response?.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
        logger.error('error_summarize_history', { error: e.message });
        return null;
    }
}

module.exports = { getChatbotResponse, getFallbackResponse, summarizeHistory };
