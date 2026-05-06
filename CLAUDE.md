# Agente WhatsApp — Clínica Estética

Agente de WhatsApp para clínica estética que capta leads de Instagram, agenda citas negociando disponibilidad en tiempo real, y solicita reseñas en Google tras la visita. Incluye un bot de Telegram para que la clínica gestione su configuración en lenguaje natural.

## Arquitectura

Monolito modular Node.js gestionado por PM2. Un único proceso con módulos bien separados que se comunican mediante EventEmitter interno.

```
server.js          ← Punto de entrada único (arranca todo)
├── webhook.js     ← Express: recibe leads de Instagram (Meta webhook)
├── bot.js         ← Conversación WhatsApp + negociación de citas
├── services/
│   ├── calendar.js    ← Adapter genérico de calendario (mock hasta conectar sistema real)
│   ├── airtable.js    ← CRM: leads, citas, config editable
│   ├── review.js      ← Worker: envía WA de reseña 30min tras cita
│   ├── telegram.js    ← Bot admin con lenguaje natural (OpenAI)
│   ├── llm.js         ← Router de proveedor AI
│   ├── helpers.js     ← Extracción y validación de datos de clínica
│   ├── metrics.js     ← Métricas internas
│   └── providers/
│       └── openai.js  ← System prompt de clínica + llamadas OpenAI
```

## Los 3 flujos principales

### 1. Lead desde Instagram → WhatsApp
1. Cliente rellena formulario de Instagram Lead Ads
2. Meta envía POST a `/webhook/meta`
3. `webhook.js` valida firma HMAC y extrae datos del formulario
4. Emite evento `lead:new` con `{ telefono, nombre?, tratamiento? }`
5. `bot.js` inicia conversación WA en segundos

### 2. Conversación + Agendado de cita
1. Bot saluda con datos del formulario (nombre si está disponible)
2. Resuelve dudas sobre tratamientos
3. Pregunta preferencia horaria (mañana/tarde, semana)
4. Consulta `calendar.getAvailableSlots()` → propone hueco específico
5. Negocia hasta confirmar: "¿El martes a las 17h te va bien?" → si no, siguiente hueco
6. Confirma cita → guarda en Airtable → `appointment:booked`
7. Gestiona cancelaciones y cambios de forma autónoma

**Campos que captura el bot:** `nombre`, `telefono`, `tratamiento`, `preferencia_horaria`, `fecha_cita`, `hora_cita`

Lead completo cuando: `nombre` + `telefono` + `tratamiento` + `cita_confirmada = true`

### 3. Seguimiento post-cita → Reseña Google
- `review.js` corre cada 5 minutos
- Busca en Airtable citas con `estado = completado` y `resena_enviada = false`
- Si han pasado ≥ N minutos (configurable, default 30) desde la cita → manda WA
- Marca `resena_enviada = true` para evitar duplicados

## Bot de Telegram (admin)

Lenguaje natural procesado por OpenAI. Solo usuarios autorizados (`TELEGRAM_ALLOWED_USERS`).

Capacidades:
- Añadir/editar/eliminar tratamientos (nombre, duración, precio)
- Cambiar tiempo de envío de reseña
- Ver/editar horario de atención
- Pausar y reactivar el bot de WhatsApp
- Consultar configuración actual

## Variables de entorno requeridas

```bash
OPENAI_API_KEY              # OpenAI GPT-4o-mini
AIRTABLE_API_KEY            # Airtable personal access token
AIRTABLE_BASE_ID            # ID de la base de Airtable
META_WEBHOOK_VERIFY_TOKEN   # Token de verificación webhook Meta (lo defines tú)
META_APP_SECRET             # App Secret de la app de Meta (para firma HMAC)
TELEGRAM_BOT_TOKEN          # Token del bot de Telegram (@BotFather)
TELEGRAM_ALLOWED_USERS      # IDs de Telegram autorizados, separados por coma
GOOGLE_REVIEW_LINK          # Link directo a Google Reviews de la clínica
PORT                        # Puerto del servidor Express (ej: 3000)
```

## Estructura de Airtable

### Tabla: Leads
| Campo | Tipo |
|---|---|
| Nombre | Texto |
| Telefono | Texto (clave de búsqueda) |
| Tratamiento | Texto |
| Preferencia_horaria | Texto |
| Fecha_cita | Fecha |
| Hora_cita | Texto |
| Estado_cita | Select: pendiente / confirmado / completado / cancelado |
| Resena_enviada | Checkbox |
| Origen | Texto (instagram_ads) |
| Notas | Texto largo |

### Tabla: Configuracion
| Campo | Tipo |
|---|---|
| Clave | Texto (ej: "servicios", "minutos_resena") |
| Valor | Texto largo (JSON serializado) |

## Calendar Adapter

`services/calendar.js` expone una interfaz genérica. Actualmente usa mock. Cuando la clínica decida el sistema (Calendly, Acuity, Google Calendar, Doctoralia, Fresha…) se implementa el adapter sin tocar el resto del código.

```javascript
getAvailableSlots(preferencia, tratamientoDuracion)
bookAppointment(slot, clientData)
cancelAppointment(appointmentId)
rescheduleAppointment(appointmentId, newSlot)
getCompletedAppointments(since)
```

## Comandos de desarrollo

```bash
# Instalar dependencias
npm install

# Arrancar en desarrollo
node server.js

# Arrancar con PM2 (producción)
pm2 start server.js --name clinica-bot
pm2 save
pm2 startup
```

## Pendiente de la clínica

Antes de pasar a producción se necesita:
- Nombre de la clínica y nombre del bot
- Lista de tratamientos con duración y precio
- Horario de atención
- Dirección física
- Link de Google Reviews
- Acceso a Meta Business para configurar el webhook
- Decisión sobre sistema de citas (Calendly, Acuity, etc.)
- ID de Telegram del administrador
