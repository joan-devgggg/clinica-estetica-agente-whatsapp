# Agente WhatsApp — Clínica Estética

Agente de WhatsApp para clínica estética que capta leads de Instagram, agenda citas negociando disponibilidad en tiempo real, y solicita reseñas en Google tras la visita. Incluye un bot de Telegram para que la clínica gestione su configuración en lenguaje natural.

## Arquitectura

Monolito modular Node.js gestionado por PM2. Un único proceso con módulos bien separados que se comunican mediante EventEmitter interno. La capa de datos es **Supabase** (Postgres). El dashboard es una app **Next.js** separada en `dashboard-app/`.

```
server.js          ← Punto de entrada único (arranca todo)
├── webhook.js     ← Express: recibe leads de Instagram (Meta webhook) + API REST
├── bot.js         ← Conversación WhatsApp + negociación de citas
├── dashboard-app/ ← Dashboard Next.js (puerto 3001)
└── services/
    ├── db.js          ← Capa de datos — Supabase (interfaz pública del proyecto)
    ├── supabase.js    ← Cliente Supabase
    ├── calendar.js    ← Adapter genérico de calendario (mock hasta conectar sistema real)
    ├── review.js      ← Worker: envía WA de reseña 30min tras cita
    ├── reminder.js    ← Worker: recordatorio 24h antes de la cita
    ├── telegram.js    ← Bot admin con lenguaje natural (OpenAI)
    ├── helpers.js     ← Extracción y validación de datos de clínica
    ├── metrics.js     ← Métricas internas (metrics.json)
    └── providers/
        └── openai.js  ← System prompt de clínica + llamadas OpenAI
```

## Capa de datos — services/db.js

Toda la persistencia va por `db.js`. Nunca importar `supabase.js` directamente desde bot/webhook.

Funciones principales:
- `saveLead(datos)` — crea o actualiza un lead (detecta por `leadId`)
- `updateLead(datos)` — actualiza lead existente por `leadId` o teléfono
- `findByPhone(telefono)` — busca lead por teléfono
- `findById(id)` — busca lead por ID de Supabase
- `getAllLeads({ limit, offset, estado, search })` — lista paginada
- `updateLeadById(id, campos)` — actualiza campos permitidos
- `deleteLead(id)` — elimina lead
- `getStats()` — estadísticas para el dashboard

En `bot.js`, la sesión guarda `session.leadId` (ID de Supabase del lead activo).

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
6. Confirma cita → guarda en Supabase (`session.leadId`) → `appointment:booked`
7. Gestiona cancelaciones y cambios de forma autónoma

**Campos que captura el bot:** `nombre`, `telefono`, `tratamiento`, `preferencia_horaria`, `fecha_cita`, `hora_cita`

Lead completo cuando: `nombre` + `telefono` + `tratamiento` + `cita_confirmada = true`

### 3. Seguimiento post-cita → Reseña Google
- `review.js` corre cada 5 minutos
- Busca en Supabase citas con `estado_cita = completado` y `resena_enviada = false`
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
SUPABASE_URL                # URL del proyecto Supabase
SUPABASE_SERVICE_ROLE_KEY   # Service role key de Supabase
META_WEBHOOK_VERIFY_TOKEN   # Token de verificación webhook Meta (lo defines tú)
META_APP_SECRET             # App Secret de la app de Meta (para firma HMAC)
TELEGRAM_BOT_TOKEN          # Token del bot de Telegram (@BotFather)
TELEGRAM_ALLOWED_USERS      # IDs de Telegram autorizados, separados por coma
GOOGLE_REVIEW_LINK          # Link directo a Google Reviews de la clínica
PORT                        # Puerto del servidor Express (default: 3000)
```

## Esquema Supabase

### Tabla: leads
| Campo | Tipo |
|---|---|
| id | uuid (PK) |
| nombre | text |
| telefono | text |
| tratamiento | text |
| preferencia_horaria | text |
| fecha_cita | date |
| hora_cita | text |
| estado_cita | text: pendiente / confirmado / completado / cancelado |
| bot_mode | text: auto / manual |
| resena_enviada | boolean |
| recordatorio_enviado | boolean |
| appointment_id | text |
| origen | text |
| notas | text |
| created_at | timestamptz |
| updated_at | timestamptz |

### Tabla: config
| Campo | Tipo |
|---|---|
| clave | text (PK) |
| valor | text (JSON serializado) |
| updated_at | timestamptz |

### Tabla: messages
| Campo | Tipo |
|---|---|
| id | uuid (PK) |
| lead_id | uuid (FK leads) |
| telefono | text |
| direccion | text: entrante / saliente |
| contenido | text |
| es_manual | boolean |
| timestamp | timestamptz |

## Dashboard (dashboard-app/)

App Next.js que consume la API REST del bot (puerto 3000). Para arrancarlo:
```bash
cd dashboard-app && npm run dev
```
Abre en **http://localhost:3001**

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
cd dashboard-app && npm install && cd ..

# Bot en desarrollo (puerto 3000)
node server.js

# Dashboard en desarrollo (puerto 3001)
cd dashboard-app && npm run dev

# Producción con PM2
pm2 start server.js --name clinica-bot
pm2 save
pm2 startup
```

## Backlog de mejoras

### Branding por organización
Añadir campos `logo_url`, `primary_color`, `business_name` a la tabla `organizations`. El dashboard debe leer estos valores al arrancar y aplicarlos dinámicamente (logo en header, color primario en CSS variables, nombre en título/pestañas). Objetivo: cada cliente ve su propio branding sin hardcodear nada.

Impacto:
- Supabase: nueva migración con `ALTER TABLE organizations ADD COLUMN logo_url text, ADD COLUMN primary_color text, ADD COLUMN business_name text`
- Dashboard: cargar config de org al inicio y pasarla por contexto React
- No afecta a bot.js ni workers

### Features por organización
Añadir campo `features` (JSONB) a `organizations` con flags activables por cliente. Ejemplo de estructura:
```json
{ "resenas": true, "recordatorios": true, "calendario": false, "telegram_admin": true }
```

El dashboard solo renderiza las secciones cuyo flag esté activo. Los workers (`review.js`, `reminder.js`) consultan el flag antes de ejecutarse y se saltan la org si está desactivado.

Impacto:
- Supabase: `ALTER TABLE organizations ADD COLUMN features jsonb DEFAULT '{}'`
- Dashboard: gate en cada sección de menú/vista
- Workers: consultar `features` de la org al inicio del ciclo
- Sin cambios en bot.js

---

## Pendiente de la clínica

Antes de pasar a producción se necesita:
- Nombre de la clínica y nombre del bot (editar `config.json`)
- Lista de tratamientos con duración y precio
- Horario de atención y dirección física
- Link de Google Reviews
- Acceso a Meta Business para configurar el webhook
- Decisión sobre sistema de citas (Calendly, Acuity, etc.)
- ID de Telegram del administrador
