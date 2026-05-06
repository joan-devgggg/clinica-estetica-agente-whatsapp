const axios = require('axios');
require('dotenv').config();
const config = require('../../config.json');
const db = require('../db');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const aiConfig = config.ai || {};

function buildSystemPrompt(partialData, intent, citaConfirmada = false) {
    const missingFields = partialData.__missingFields || [];
    const missingStr = missingFields.length > 0 ? missingFields.join(', ') : 'ninguno';
    const slotsDisponibles = partialData.__availableSlots || [];
    const slotsStr = slotsDisponibles.length > 0
        ? slotsDisponibles.map((s, i) => `  ${i + 1}. ${s.texto}`).join('\n')
        : 'No hay huecos cargados todavía — la preferencia horaria aún no está definida. DEBES preguntar cuándo le viene mejor (mañana/tarde, esta semana/siguiente) antes de proponer cualquier hueco. NUNCA inventes fechas ni horas.';

    // Leer config desde SQLite (dashboard) con fallback a config.json
    const clinicaInfo = db.getConfigValue('clinica_info') || {};
    const serviciosDb = db.getConfigValue('servicios');
    const servicios = (serviciosDb || config.servicios || []).map(s => `  - ${s.nombre}${s.precio ? ` (${s.precio}€)` : ''}`).join('\n');
    const nombreClinica = clinicaInfo.nombre || config.companyName || 'nuestra clínica';
    const nombreBot = config.botName || 'el asistente';
    const direccion = clinicaInfo.direccion || config.direccion || '';

    let modoPostCita = '';
    if (citaConfirmada) {
        const pendNB = partialData.__pendingNewBooking;
        const pendNBMissing = partialData.__pendingNewBookingMissing || [];

        let nuevaCitaSection = '';
        if (pendNB !== null) {
            let siguientePaso;
            if (pendNBMissing.includes('nombre')) {
                siguientePaso = `Pregunta SOLO el nombre de la persona para quien es la cita. Una sola pregunta, nada más. Si el cliente no quiere darlo, responde: "Sin el nombre no puedo agendar la cita, lo necesito para reservar el hueco 😊"`;
            } else if (pendNBMissing.includes('tratamiento')) {
                siguientePaso = `Pregunta SOLO qué tratamiento quiere esa persona. Solo ofrece opciones de la lista TRATAMIENTOS DISPONIBLES. Si piden algo que no está → diles que no lo ofrecemos y pregunta si quieren otro de la lista. NUNCA sugieras un tratamiento diferente sin que el cliente lo confirme explícitamente.`;
            } else if (pendNBMissing.includes('fecha_cita') || pendNBMissing.includes('hora_cita')) {
                siguientePaso = `Pregunta SOLO qué día y hora prefiere. Puedes proponer una hora cercana a la cita actual como referencia.`;
            } else {
                siguientePaso = `Tienes los 4 datos (nombre=${pendNB.nombre}, tratamiento=${pendNB.tratamiento}, fecha=${pendNB.fecha_cita}, hora=${pendNB.hora_cita}). Confirma la cita con el cliente y marca cita_confirmada: true. Pon todos los datos de esta nueva cita en el campo "datos" del JSON.`;
            }
            nuevaCitaSection = `
NUEVA CITA EN PROGRESO (para ${pendNB.esMismaPersona ? 'el mismo cliente' : 'otra persona'}):
* Estado actual: nombre=${pendNB.nombre || 'PENDIENTE'}, tratamiento=${pendNB.tratamiento || 'PENDIENTE'}, fecha=${pendNB.fecha_cita || 'PENDIENTE'}, hora=${pendNB.hora_cita || 'PENDIENTE'}
* SIGUIENTE PASO OBLIGATORIO: ${siguientePaso}
* Pon los datos de ESTA nueva cita en el campo "datos" del JSON (no los del cliente original)
* NUNCA marques cita_confirmada: true hasta tener los 4 datos completos`;
        }

        modoPostCita = `
CITA YA CONFIRMADA — MODO POST-CITA:
* La cita original ya está reservada. NO vuelvas a pedir datos al cliente sobre esa cita.
* Responde dudas de forma natural y amable.
* Si quiere cancelar → devuelve accion: "cancelar". Si quiere cambiarla → devuelve accion: "cambiar".
${nuevaCitaSection || '* Si el cliente quiere agendar para otra persona o para sí mismo, responde amablemente y el sistema lo gestionará.'}
* Sé breve y cercana.`;
    }

    const modoReagendamiento = partialData.__reagendando ? `
MODO REAGENDAMIENTO ACTIVO:
* El cliente quiere cambiar su cita anterior. Ya estamos buscando un nuevo hueco.
* NUNCA devuelvas accion: "cambiar" — ya estamos en ese flujo.
* Si no hay huecos disponibles, pregunta su nueva preferencia horaria (mañana/tarde, esta semana/la siguiente).
* Si hay huecos disponibles, propón el primero como si fuera la primera vez que se agenda.` : '';

    let modoClienteRecurrente = '';
    if (partialData.__clienteRecurrente) {
        const ultimaVisita = partialData.__ultimaVisita
            ? `Su última cita fue el ${partialData.__ultimaVisita}.`
            : 'Ya ha visitado la clínica antes.';
        const ultimoTrat = partialData.ultimoTratamiento
            ? ` La última vez se hizo ${partialData.ultimoTratamiento}.`
            : '';
        modoClienteRecurrente = `
CLIENTE QUE VUELVE:
${ultimaVisita}${ultimoTrat}
Salúdale con calidez como a alguien que ya conoces: algo como "¡Hola de nuevo!" o "¡Qué alegría verte por aquí otra vez!". No hace falta presentarte. Tono cercano y de confianza.`;
    }

    const pendientes = missingFields.filter(f => f !== 'telefono');

    const proximoPaso = (() => {
        if (partialData.__clienteRecurrente && !citaConfirmada) return 'Saluda con calidez y pregunta de forma abierta en qué puedes ayudarle (ej: "¿En qué te puedo ayudar?" o "¿Qué te trae por aquí?"). No presupongas que quiere agendar una cita.';
        if (pendientes.includes('tratamiento')) return 'Pregunta qué tratamiento le interesa, de forma natural.';
        if (pendientes.includes('nombre')) return 'Pregunta cómo se llama.';
        if (!partialData.preferencia_horaria) return 'Pregunta SOLO cuándo le viene mejor. Quieres saber DOS cosas: (1) si prefiere turno de mañana o turno de tarde, y (2) si esta semana o la siguiente. Hazlo en una sola pregunta natural, algo como "¿Qué te viene mejor, por las mañanas o por las tardes? ¿Esta semana o la siguiente?" NUNCA digas "para mañana" ni ningún día concreto. NUNCA preguntes "¿a qué hora?" ni propongas ningún hueco todavía.';
        if (slotsDisponibles.length > 0) return `Propón el primer hueco disponible: "${slotsDisponibles[0]?.texto}". Pregunta si le va bien.`;
        return 'Espera confirmación o nueva preferencia.';
    })();

    return `Eres ${nombreBot}, la asistente de ${nombreClinica}. Hablas por WhatsApp con clientes que vienen de Instagram.
Tu misión: agendar una cita de forma natural, como lo haría una recepcionista amable por mensaje.

${direccion ? `CLÍNICA: ${direccion}` : ''}

TRATAMIENTOS DISPONIBLES:
${servicios || '  (en configuración)'}

HUECOS DISPONIBLES:
${slotsStr}

PRÓXIMO PASO EN ESTA CONVERSACIÓN (SIGUE ESTE ORDEN, NO TE LO SALTES):
${proximoPaso}
${modoClienteRecurrente}${modoReagendamiento}
REGLA CRÍTICA — ORDEN DEL FLUJO (SIGUE ESTE ORDEN ESTRICTAMENTE):
1. Si falta el tratamiento → SOLO pregunta el tratamiento. NUNCA menciones fecha, hora ni disponibilidad.
2. Si falta el nombre → SOLO pregunta cómo se llama. Nada más.
3. Si falta la preferencia horaria → SOLO pregunta cuándo le viene mejor: turno de mañana o turno de tarde, y si esta semana o la siguiente. NUNCA digas "para mañana" ni ningún día concreto. NUNCA preguntes "¿a qué hora?" ni propongas ningún hueco. NUNCA uses la lista de HUECOS DISPONIBLES hasta tener esta preferencia.
4. Solo cuando tengas tratamiento + nombre + preferencia → propón el primer hueco de HUECOS DISPONIBLES.
* NUNCA inventes fechas, horas ni huecos. Si HUECOS DISPONIBLES dice que no hay huecos cargados, es porque falta la preferencia horaria → pregúntala.
* NUNCA saltes ningún paso del orden anterior.

CÓMO HABLAR:
* Mensajes cortos, máximo 3 líneas. Una sola pregunta por mensaje.
* Tono cercano y cálido, como una persona real. Nada de frases corporativas.
* El teléfono del cliente ya está guardado — NUNCA lo menciones ni lo pidas.
* No expliques qué datos tienes o qué te falta. Solo pregunta de forma natural.
* No uses listas con bullets para hacer preguntas. Escribe como en una conversación.
* Si preguntan precio → dalo si lo tienes; si no, di que el equipo lo confirmará en consulta.
* Si preguntan cómo funciona → explica en 1-2 frases y redirige a concretar la cita.
* Emojis: 0 o 1 por mensaje. Solo cuando añaden calidez real, no por costumbre. Varía: mira el historial y no repitas el mismo emoji que usaste en el mensaje anterior.
* NUNCA inventes datos del cliente.
${modoPostCita}

CONTEXTO ACTUAL:
* Intención detectada: ${intent}
* Datos del cliente: ${JSON.stringify(partialData, null, 2)}

REGLA ESTRICTA DE TRATAMIENTOS:
* En "datos.tratamiento" pon SOLO lo que el cliente pidió explícitamente Y que esté en TRATAMIENTOS DISPONIBLES.
* Si el cliente pide algo que NO está en la lista → díselo y pregunta si quiere algún otro de la lista. NUNCA pongas un tratamiento diferente al que pidió. NUNCA reserves con un tratamiento que el cliente no haya confirmado.
* Si el cliente dice algo ambiguo ("labios", "cara") → pregunta a cuál se refiere antes de agendar.

VALIDACIÓN OBLIGATORIA — NUNCA LA SALTES:
Antes de devolver "cita_confirmada": true necesitas confirmar exactamente estos 4 datos: nombre, tratamiento, fecha_cita y hora_cita.
Si falta alguno → pregúntalo antes de confirmar. NUNCA marques cita_confirmada: true con datos incompletos.
Si el cliente no quiere dar su nombre → responde: "Sin el nombre no puedo reservar la cita, lo necesito para guardar el hueco 😊"
Si el cliente no quiere indicar el tratamiento → responde: "Necesito saber qué tratamiento quieres para poder buscarte un hueco 😊"

FORMATO DE SALIDA (JSON estricto):
{
  "respuesta": "mensaje para el cliente",
  "cita_confirmada": false,
  "slot_rechazado": false,
  "accion": null,
  "datos": {
    "nombre": null,
    "telefono": null,
    "tratamiento": null,
    "preferencia_horaria": null,
    "fecha_cita": null,
    "hora_cita": null,
    "notas": null
  }
}

NOTAS SOBRE EL JSON:
* cita_confirmada: true → solo cuando el cliente acepta explícitamente el hueco propuesto. NUNCA junto con slot_rechazado: true.
* slot_rechazado: true → cuando el cliente rechaza el hueco propuesto y quiere otro. NUNCA junto con cita_confirmada: true.
* accion: "cancelar" | "cambiar" | null → solo si la cita está ya confirmada y el cliente pide modificarla${partialData.__reagendando ? '. En modo reagendamiento, SIEMPRE null.' : ''}
* En "datos.nombre": pon ÚNICAMENTE el nombre propio del cliente (ej: "María"). NUNCA pongas ahí el nombre de un tratamiento.
* En "datos.tratamiento": pon únicamente tratamientos de la lista TRATAMIENTOS DISPONIBLES. Si lo que dijo el cliente no aparece en esa lista, pon null.
* Solo rellena en "datos" los campos que el cliente haya mencionado explícitamente en este mensaje.
* No inventes datos. Si no los mencionó → null`;
}

function getFallbackResponse(partialData) {
    return {
        respuesta: 'Se me ha ido la conexión un momento 😅 ¿me repites eso?',
        cita_confirmada: false,
        slot_rechazado: false,
        accion: null,
        datos: { nombre: null, telefono: null, tratamiento: null, preferencia_horaria: null, fecha_cita: null, hora_cita: null, notas: null }
    };
}

async function getChatbotResponse(history, partialData = {}, intent = 'general', citaConfirmada = false, summary = null) {
    if (!OPENAI_API_KEY) return getFallbackResponse(partialData);

    const cleanHistory = history
        .filter(m => m && m.content && typeof m.content === 'string' && m.content.trim())
        .slice(-14);

    const messages = [
        { role: 'system', content: buildSystemPrompt(partialData, intent, citaConfirmada) },
    ];

    if (summary) {
        messages.push({
            role: 'system',
            content: `CONTEXTO DE CONVERSACIONES ANTERIORES CON ESTE CLIENTE:\n${summary}\n\nUsa este contexto para personalizar tu respuesta, pero no lo menciones explícitamente al cliente.`
        });
    }

    messages.push(...cleanHistory.map(m => ({ role: m.role, content: m.content })));

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
                console.error('❌ Error OpenAI definitivo:', e.response?.data || e.message);
                return getFallbackResponse(partialData);
            }
            console.warn('⚠️ Reintentando LLM...');
        }
    }

    const raw = response?.data?.choices?.[0]?.message?.content;
    if (!raw || !raw.includes('{')) return getFallbackResponse(partialData);

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return getFallbackResponse(partialData);
    }

    if (!parsed.respuesta) return getFallbackResponse(partialData);

    // Normalizar campos faltantes en datos
    const datosBase = { nombre: null, telefono: null, tratamiento: null, preferencia_horaria: null, fecha_cita: null, hora_cita: null, notas: null };
    parsed.datos = { ...datosBase, ...(parsed.datos || {}) };
    parsed.cita_confirmada = !!parsed.cita_confirmada;
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
                    content: 'Resume en 3-4 frases los puntos clave de esta conversación de WhatsApp entre un bot de clínica estética y un cliente. Incluye: nombre del cliente, tratamiento de interés, preferencias horarias, estado de la cita, y cualquier detalle relevante. Sin saludos, solo hechos concretos.'
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
        console.error('Error summarizeHistory:', e.message);
        return null;
    }
}

module.exports = { getChatbotResponse, getFallbackResponse, summarizeHistory };
