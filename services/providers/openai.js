const Anthropic = require('@anthropic-ai/sdk').default;
require('dotenv').config();
const config = require('../../config.json');
const db = require('../db');
const { getOrgType } = require('../org-registry');
const logger = require('../../lib/logger');

const anthropic = new Anthropic();
const aiConfig = config.ai || {};

// ─── San Remo prompt (restaurante) ──────────────────────────────────────────

function currentDateMadrid() {
    return new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' });
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
        if (!selectedService) return 'Pregunta qué servicio necesita. Si no tiene claro, ofrécele las categorías principales.';
        if (partialData.__askStylistFirst) {
            const names = (partialData.__eligibleStylistNames || []).join(', ');
            const pref = partialData.__preferredStylistName ? ` Su estilista habitual es ${partialData.__preferredStylistName}: sugiérela primero.` : '';
            return `Confirma el servicio (precio y duración) y pregunta si prefiere alguna estilista en concreto${names ? ` (disponibles: ${names})` : ''} o si le asignas la mejor disponible.${pref} NO propongas todavía horarios concretos: primero necesitas saber la estilista.`;
        }
        if (partialData.__askDatePreferenceFirst) {
            return `Confirma el servicio (precio y duración) y pregunta QUÉ DÍA O SEMANA le viene mejor (p.ej. "esta semana", "la que viene", "el miércoles", "por la tarde"). NO propongas todavía horarios concretos: primero necesitas saber cuándo quiere venir.`;
        }
        if (slotsDisponibles.length > 0) {
            return `Confirma el servicio (precio y duración) y propón directamente TODOS los huecos disponibles de la lista en UN solo mensaje; pregunta cuál le viene bien. NO sugieras otros servicios en este mensaje: el upselling NUNCA sustituye ni retrasa la propuesta de huecos.`;
        }
        if (!selectedStylist && !partialData.__stylistAutoAssigned) return '¿Tiene preferencia por alguna estilista en concreto? Si no, le asignamos la mejor disponible.';
        if (partialData.__upsellingSuggested === false) return `Confirma el servicio (precio y duración) y, si encaja, sugiere UN servicio complementario de forma sutil.`;
        return 'Espera confirmación o nueva preferencia.';
    })();

    const contextoActual = `Intención detectada: ${intent}\nDatos recogidos: ${JSON.stringify(partialData, null, 2)}`;
    const resumenAnterior = summary ? `RESUMEN DE CONVERSACIONES ANTERIORES:\n${summary}` : '';

    return `# ── IDENTIDAD ──────────────────────────────────────────────────────────────

Eres ${botName}, recepcionista y asesora de belleza de ${salonName}, un salón de belleza y bienestar en Alicante.
Tu objetivo principal es agendar citas y maximizar el valor de cada visita.
Conoces a fondo cada servicio y sus beneficios: recomiendas con criterio, no por vender.
Haces sentir a cada clienta bien cuidada y en manos de expertas.
Tono: cálido, profesional y cercano — como una compañera del salón que de verdad quiere ayudarte.

# ── FECHA ACTUAL ───────────────────────────────────────────────────────────

Hoy es ${currentDateMadrid()}.
Usa SIEMPRE esta fecha para resolver "hoy", "mañana", "pasado mañana", "el día 22", "este viernes", etc.
El salón abre de lunes a sábado (los domingos está cerrado): si la clienta pide un domingo, propón el siguiente día disponible de la lista.

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

# ── REGLAS DE UPSELLING ────────────────────────────────────────────────────

Una vez propuestos los huecos (o cuando la clienta ya haya elegido uno), puedes sugerir de forma natural UN servicio complementario según estas reglas:
${upsellingStr}

El upselling va SIEMPRE después de proponer la disponibilidad, nunca en lugar de ella.
No insistas si dice que no. Sé sutil: "Mientras el color actúa, ¿te gustaría aprovechar para una manicura?"

# ── POLÍTICA DE CANCELACIÓN ───────────────────────────────────────────

Para cancelar o reagendar una cita, avisa con al menos 48 horas de antelación.

# ── DISPONIBILIDAD ─────────────────────────────────────────────────────────

HUECOS DISPONIBLES:
${slotsStr}
${avisoDiaNoDisponible}

NUNCA inventes fechas, horas ni disponibilidad. Solo usa los huecos de esta lista.
La disponibilidad YA está calculada y la tienes arriba. NUNCA digas que vas a "revisar",
"consultar" o "mirar" los huecos, ni "un momento" o "déjame ver". Cuando haya huecos en la
lista, tu mensaje DEBE incluir TODOS esos huecos directamente en ESE MISMO mensaje.
Nunca mandes un mensaje de espera. El upselling NUNCA sustituye la propuesta de huecos:
si hay huecos, proponlos; el complemento, como mucho, va en un mensaje POSTERIOR.
Si la lista de huecos está vacía porque aún no sabes qué día prefiere, pregúntale primero
qué día o semana le viene mejor; NO te inventes horarios.

# ── DATO QUE NECESITAS AHORA ───────────────────────────────────────────────

SIGUIENTE PASO: ${proximoPaso}

FLUJO DE LA CITA:
1. Saludo → pregunta nombre si es nueva (si es recurrente, salúdala por nombre).
2. Pregunta qué servicio necesita. Si dice algo genérico ("cortarme el pelo"), mapéalo al servicio más probable del catálogo.
3. Si varias estilistas pueden hacer el servicio, pregunta si tiene preferencia (o le asignas la mejor disponible) ANTES de proponer horarios. Si solo una puede hacerlo, no preguntes.
4. Si la clienta aún NO ha dicho cuándo quiere venir (ni día, ni semana, ni franja), pregúntale qué día o semana le viene mejor ANTES de proponer horarios. Si ya lo dijo, sáltate este paso.
5. Confirma servicio + precio + duración y, en el MISMO mensaje, propón TODOS los huecos disponibles de la lista y pregunta cuál le va bien. NO sugieras otros servicios todavía.
6. Cuando acepte un hueco → marca cita_confirmada: true Y rellena datos.hora_cita con la hora EXACTA (HH:MM) Y datos.fecha_cita con la fecha EXACTA (YYYY-MM-DD) del hueco aceptado, copiadas tal cual de la lista de huecos. Esto es imprescindible para no confundir dos días con la misma hora. Cuentan como aceptación frases como "vale", "dale", "ese me va bien", "el primero", "sí". REGLA CRÍTICA: si tu mensaje afirma de cualquier forma que la cita queda reservada/apuntada/confirmada, ENTONCES cita_confirmada DEBE ser true y datos.hora_cita + datos.fecha_cita DEBEN tener valor. Nunca digas que la has reservado con cita_confirmada en false.
7. UPSELLING (solo DESPUÉS de proponer los huecos, nunca antes): sugiere UN servicio complementario según las reglas, en un mensaje aparte y sin presionar.

# ── MODOS ESPECIALES ──────────────────────────────────────────────────────
${modoCita}
${modoSegundaCita}
${modoReagendamiento}
${modoClienteRecurrente}

# ── CONTEXTO ACTUAL ────────────────────────────────────────────────────────

${contextoActual}

${resumenAnterior}

# ── PERSONALIDAD Y TONO ────────────────────────────────────────────────────

- Mensajes cortos y directos: máximo 3-4 líneas. Una sola pregunta por mensaje.
- 0 o 1 emoji por mensaje. Nada robótico.
- Transmite confianza y profesionalidad: hablas como alguien que sabe de lo que habla.
- Sugiere servicios adicionales de forma natural y sutil, nunca agresiva ni insistente.
- Haz que la clienta sienta que la cuidas y que le recomiendas lo mejor para ella.

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
cita_confirmada: true → siempre que la clienta acepte un hueco O que tu mensaje afirme que la cita queda reservada/apuntada/confirmada. En ese caso datos.hora_cita DEBE llevar la hora exacta (HH:MM). NUNCA junto con slot_rechazado: true.`;
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
    // Salón (BUG 6): mensaje NEUTRAL, nunca de error. Restaurante (San Remo): se mantiene.
    const salonMsgs = {
        en: 'One moment, please 😊',
        ru: 'Минутку, пожалуйста 😊',
        uk: 'Хвилинку, будь ласка 😊',
    };
    const restMsgs = {
        en: 'I lost connection for a moment 😅 Could you repeat that?',
        ru: 'Связь прервалась на секунду 😅 Можешь повторить?',
        uk: "Зв'язок перервався на мить 😅 Можеш повторити?",
    };
    const fallbackText = orgType === 'salon'
        ? ((language && salonMsgs[language]) || 'Un momento, por favor 😊')
        : ((language && restMsgs[language]) || 'Se me ha ido la conexión un momento 😅 ¿me repites eso?');
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
    if (!process.env.ANTHROPIC_API_KEY) return getFallbackResponse(orgId, clientLang);

    const agentCfg = await db.getAgentConfig(orgId).catch(() => null);

    const cleanHistory = history
        .filter(m => m && m.content && typeof m.content === 'string' && m.content.trim())
        .slice(-10);

    const systemPrompt = buildSystemPrompt(orgId, partialData, intent, reservaConfirmada, summary, agentCfg);
    const claudeMessages = cleanHistory.map(m => ({ role: m.role, content: m.content }));
    if (claudeMessages.length === 0 || claudeMessages[0].role !== 'user') {
        claudeMessages.unshift({ role: 'user', content: '(inicio de conversación)' });
    }

    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            response = await anthropic.messages.create({
                model: 'claude-sonnet-4-6',
                system: systemPrompt,
                messages: claudeMessages,
                max_tokens: aiConfig.max_tokens ?? 450,
                temperature: aiConfig.temperature ?? 0.5,
            });
            break;
        } catch (e) {
            if (attempt === 1) {
                logger.error('claude_error_definitivo', { error: e.message });
                return getFallbackResponse(orgId, clientLang);
            }
            logger.warn('claude_reintentando');
        }
    }

    const raw = response?.content?.find(b => b.type === 'text')?.text;
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
    if (!process.env.ANTHROPIC_API_KEY || !messages?.length) return null;
    try {
        const conversation = messages
            .filter(m => m?.content)
            .map(m => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`)
            .join('\n');

        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            system: 'Resume en 3-4 frases los puntos clave de esta conversación de WhatsApp. Incluye: nombre del cliente, servicio solicitado, fecha/hora de la cita, estilista, y cualquier detalle relevante. Sin saludos, solo hechos concretos.',
            messages: [
                { role: 'user', content: conversation }
            ],
            max_tokens: 200,
            temperature: 0.2,
        });

        return response?.content?.find(b => b.type === 'text')?.text?.trim() || null;
    } catch (e) {
        logger.error('error_summarize_history', { error: e.message });
        return null;
    }
}

module.exports = { getChatbotResponse, getFallbackResponse, summarizeHistory };
