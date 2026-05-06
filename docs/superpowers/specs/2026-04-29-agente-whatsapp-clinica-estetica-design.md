# Agente WhatsApp — Clínica Estética
**Fecha:** 2026-04-29  
**Estado:** Aprobado por el cliente

---

## Resumen

Sistema automatizado de captación y gestión de clientes para una clínica estética. Recibe leads de Instagram Lead Ads, inicia conversación por WhatsApp en segundos, agenda citas negociando disponibilidad en tiempo real, hace seguimiento post-cita para solicitar reseña en Google, y ofrece un bot de Telegram con lenguaje natural para que la clínica gestione su configuración de forma autónoma.

---

## Arquitectura: Monolito modular (Opción C)

Un único proceso Node.js gestionado por PM2, con módulos bien separados que se comunican mediante EventEmitter interno. Simple de desplegar, fácil de mantener, con límites claros entre responsabilidades.

```
server.js  (punto de entrada único — PM2 lo gestiona)
│
├── webhook.js       Express server — recibe leads de Instagram (Meta)
├── bot.js           Lead agent — conversación WhatsApp + agendado
├── telegram.js      Admin bot — gestión de configuración por lenguaje natural
│
└── services/
    ├── calendar.js      Adapter genérico (Calendly / Acuity / Google Cal / otro)
    ├── airtable.js      CRM y almacén de configuración editable
    ├── review.js        Worker — detecta citas completadas y envía WA de reseña
    ├── ai.js            Prompts y llamadas a OpenAI (bot WA + bot Telegram)
    ├── helpers.js       Extracción y validación de datos
    └── metrics.js       Métricas internas
```

**Comunicación interna:** EventEmitter de Node.js
- `lead:new` → bot inicia conversación WA
- `appointment:booked` → Airtable guarda cita, clínica notificada
- `review:send` → bot manda WA de reseña al cliente

---

## Los 4 módulos principales

### 1. Portero — `webhook.js`
- Expone `GET /webhook/meta` para verificación inicial de Meta
- Expone `POST /webhook/meta` para recibir leads nuevos
- Valida firma HMAC de Meta (seguridad)
- Extrae teléfono (y nombre/tratamiento si el formulario los incluye)
- Emite `lead:new` → bot arranca conversación en segundos
- Flexible: funciona con cualquier combinación de campos del formulario

### 2. Recepcionista — `bot.js`
Flujo de conversación completo:
1. Saludo personalizado con datos del formulario
2. Resolución de dudas sobre tratamientos
3. Pregunta preferencia horaria (mañana/tarde, esta semana/siguiente)
4. Consulta `calendar.js` → propone hueco específico
5. Negocia hasta confirmar (cliente acepta o pide otro)
6. Confirma cita, guarda en Airtable
7. Gestiona cancelaciones y cambios de cita de forma autónoma

Campos capturados: `nombre`, `teléfono`, `tratamiento`, `fecha_cita`, `hora_cita`

### 3. Asistente de Telegram — `telegram.js`
Bot conversacional con lenguaje natural (OpenAI interpreta la intención). Solo accesible para usuarios autorizados (`TELEGRAM_ALLOWED_USERS`).

Capacidades:
- Añadir / editar / eliminar tratamientos (nombre, duración, precio)
- Cambiar tiempo de envío de reseña (minutos post-cita)
- Ver/editar horario de atención
- Pausar y reactivar el bot de WhatsApp
- Consultar configuración actual

Flujo: usuario escribe en lenguaje natural → LLM extrae intención + datos → bot pide confirmación → aplica cambio en Airtable → confirmación al usuario.

### 4. Recordatorio de reseñas — `services/review.js`
Worker con `setInterval` (cada 5 minutos). Consulta Airtable buscando citas con estado `completado` y `resena_enviada = false`. Para cada una, verifica que han pasado los minutos configurados (default: 30) desde `fecha_fin_cita` y manda el WA de reseña. Marca `resena_enviada = true` para evitar duplicados.

Mensaje de reseña:
> "Hola [nombre] 😊 Esperamos que tu experiencia haya sido genial. Si tienes un momento, nos ayudaría muchísimo que dejaras tu opinión: [GOOGLE_REVIEW_LINK] ¡Gracias!"

---

## Calendar Adapter — `services/calendar.js`

Interfaz genérica preparada para enchufar cualquier sistema:

```javascript
getAvailableSlots(date, treatmentDuration)  // → array de huecos libres
bookAppointment(slot, clientData)           // → confirmación de reserva
cancelAppointment(appointmentId)            // → cancelación
rescheduleAppointment(appointmentId, slot)  // → cambio de fecha/hora
getCompletedAppointments(since)             // → citas terminadas (para reseñas)
```

Por ahora devuelve datos mock. Cuando la clínica decida el sistema (Calendly, Acuity, Google Calendar, Doctoralia, Fresha…) se implementa el adapter correspondiente sin tocar el resto del código.

---

## Datos — Airtable

### Tabla: Leads
| Campo | Tipo | Descripción |
|---|---|---|
| nombre | texto | Nombre del cliente |
| teléfono | texto | Número WhatsApp |
| tratamiento | texto | Tratamiento de interés |
| preferencia_horaria | texto | Mañana/tarde, semana |
| fecha_cita | fecha | Fecha confirmada |
| hora_cita | texto | Hora confirmada |
| estado | select | pendiente / confirmado / completado / cancelado |
| resena_enviada | boolean | Si ya se mandó el WA de reseña |
| origen | texto | instagram_ads |
| created_at | fecha | Fecha de creación del lead |

### Tabla: Configuración
| Campo | Tipo | Descripción |
|---|---|---|
| servicios | JSON | Lista de tratamientos con nombre, duración, precio |
| minutos_resena | número | Minutos post-cita para enviar WA de reseña (default: 30) |
| horario | JSON | Días y franjas horarias de atención |
| bot_activo | boolean | Si el bot de WA está activo o pausado |

---

## Variables de entorno necesarias

```
OPENAI_API_KEY              # OpenAI (bot WA + bot Telegram)
AIRTABLE_API_KEY            # Airtable
AIRTABLE_BASE_ID            # Base de Airtable
META_WEBHOOK_VERIFY_TOKEN   # Token verificación webhook Instagram
META_APP_SECRET             # Firma HMAC seguridad Meta
TELEGRAM_BOT_TOKEN          # Token del bot de Telegram
TELEGRAM_ALLOWED_USERS      # IDs de Telegram autorizados (separados por coma)
GOOGLE_REVIEW_LINK          # Link directo a Google Reviews de la clínica
PORT                        # Puerto Express para webhook (ej: 3000)
```

---

## Lo que necesitas saber de la clínica (checklist)

Ver sección al final del documento.

---

## Decisiones técnicas

- **LOPD:** Meta recoge el consentimiento en el formulario de Instagram. No se repite en WhatsApp.
- **Notificación a clínica al confirmar cita:** Solo Airtable (por ahora).
- **Cancelaciones/cambios:** El bot las gestiona solo sin intervención humana.
- **Idioma:** Español. Configurable en el futuro desde Telegram.
- **Tiempo reseña:** 30 minutos por defecto, configurable desde Telegram.
- **Calendario:** Adapter genérico con mock hasta que la clínica decida el sistema.
- **PM2:** Gestiona el proceso, auto-restart si cae.

---

## Checklist — Lo que necesitas preguntar a la clínica

### Datos básicos
- [ ] Nombre exacto de la clínica
- [ ] Número de WhatsApp que usará el bot
- [ ] Dirección física (el bot la menciona al confirmar cita)
- [ ] Horario de atención (días y horas)
- [ ] Link de Google Reviews

### Tratamientos
- [ ] Lista de tratamientos que ofrecen
- [ ] Duración de cada tratamiento (para reservar el hueco correcto)
- [ ] Precio de cada tratamiento (opcional, por si el bot da información)
- [ ] ¿El bot debe dar precios o redirigir a la clínica para eso?

### Instagram / Meta
- [ ] Acceso a la cuenta de Meta Business para configurar el webhook
- [ ] Qué campos tiene el formulario de Instagram (nombre, teléfono, tratamiento…)
- [ ] App ID y App Secret de la app de Meta

### Calendario
- [ ] ¿Qué sistema de citas van a usar? (Calendly, Acuity, Google Calendar, Doctoralia, Fresha, otro)
- [ ] ¿Tienen ya cuenta o hay que crearla?

### Telegram
- [ ] Número de Telegram de quién gestionará el bot (para autorizar acceso)

### Tono y personalidad del bot
- [ ] ¿Cómo quieren que se llame el bot? (ej: "Sara", "Asistente de [Clínica]")
- [ ] ¿Tono formal o cercano?
- [ ] ¿Algún mensaje de bienvenida específico que quieran usar?

### Operativa
- [ ] ¿Cuántos profesionales/cabinas hay? (afecta a cuántas citas simultáneas puede haber)
- [ ] ¿El bot debe gestionar solo un tipo de cita o puede haber citas de varios tratamientos?
- [ ] ¿Política de cancelación? (¿con cuántas horas de antelación se puede cancelar?)
