# Agente WhatsApp — Clínica Estética

Bot de WhatsApp que capta leads de Instagram, agenda citas negociando disponibilidad en tiempo real y solicita reseñas en Google tras la visita. Incluye bot de Telegram para que la clínica gestione su configuración en lenguaje natural.

## Arranque rápido

```bash
# 1. Instalar dependencias
npm install
cd dashboard-app && npm install && cd ..

# 2. Configurar variables de entorno
cp .env.example .env
# Edita .env con tus claves

# 3. Bot (puerto 3000)
node server.js

# 4. Dashboard (puerto 3001, en otra terminal)
cd dashboard-app && npm run dev

# Producción con PM2
pm2 start server.js --name clinica-bot
pm2 save
```

## Variables de entorno

| Variable | Descripción |
|---|---|
| `OPENAI_API_KEY` | GPT-4o-mini para conversación y bot Telegram |
| `SUPABASE_URL` | URL del proyecto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key de Supabase |
| `META_WEBHOOK_VERIFY_TOKEN` | Token que defines tú para el webhook de Meta |
| `META_APP_SECRET` | App Secret de la app de Meta (firma HMAC) |
| `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram |
| `TELEGRAM_ALLOWED_USERS` | IDs de Telegram autorizados, separados por coma |
| `GOOGLE_REVIEW_LINK` | Link directo a Google Reviews de la clínica |

## Los 3 flujos

1. **Lead Instagram → WhatsApp** — Meta envía el lead al webhook `/webhook/meta`, el bot inicia conversación en segundos.
2. **Conversación + cita** — El bot resuelve dudas, captura preferencia horaria y negocia un hueco hasta confirmar la cita en Supabase.
3. **Reseña post-cita** — Worker que corre cada 5 min: 30 min después de la cita completada manda un WhatsApp pidiendo reseña en Google.

## Estructura

```
server.js              ← Punto de entrada único
├── webhook.js         ← Receptor leads Instagram (Express) + API REST
├── bot.js             ← Conversación WA + negociación de citas
├── dashboard-app/     ← Dashboard Next.js (citas, leads, config)
└── services/
    ├── db.js          ← Capa de datos — Supabase
    ├── supabase.js    ← Cliente Supabase
    ├── calendar.js    ← Adapter genérico de calendario (mock activo)
    ├── review.js      ← Worker reseñas Google
    ├── reminder.js    ← Worker recordatorios 24h antes
    ├── telegram.js    ← Bot admin en lenguaje natural
    └── providers/
        └── openai.js  ← System prompt + llamadas OpenAI
```

## API REST (puerto 3000)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/leads` | Lista de leads (paginado, filtrable) |
| GET | `/api/leads/:id` | Lead por ID |
| POST | `/api/leads` | Crear lead |
| PUT | `/api/leads/:id` | Editar lead |
| DELETE | `/api/leads/:id` | Eliminar lead |
| GET | `/api/citas` | Citas por rango de fechas |
| GET | `/api/stats` | Estadísticas del dashboard |
| GET | `/api/config` | Configuración actual |
| PUT | `/api/config/:clave` | Actualizar config |
| GET | `/api/messages/:telefono` | Historial de mensajes |
| PUT | `/api/leads/:id/bot-mode` | Activar/desactivar bot para un lead |
| POST | `/api/send` | Enviar mensaje manual por WhatsApp |

## Pendiente antes de producción

- Nombre de la clínica y del bot (editar `config.json`)
- Lista de tratamientos con duración y precio
- Horario de atención y dirección
- Link de Google Reviews
- Acceso Meta Business para configurar el webhook
- Sistema de citas a conectar (Calendly, Acuity, Google Calendar…)
- ID de Telegram del administrador
