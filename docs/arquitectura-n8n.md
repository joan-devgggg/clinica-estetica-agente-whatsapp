# Arquitectura final: Node.js + n8n

## Qué se queda en Node.js (microservicio)

**Bot conversacional WhatsApp** — `bot.js` + `services/providers/openai.js`

- Gestión de estado por conversación (multi-turno)
- Negociación de slots de cita (propone → cliente rechaza → siguiente hueco)
- Captura progresiva de campos: nombre, tratamiento, preferencia horaria, fecha, hora
- Gestión de cancelaciones y cambios dentro del chat
- Se expone como HTTP microservicio: recibe mensaje WhatsApp, devuelve respuesta

```
POST /message  ←  n8n le envía cada mensaje entrante de WhatsApp
               →  devuelve el texto de respuesta para enviar
```

---

## Qué va a n8n

### 1. Webhook Meta → Lead en Airtable
- Trigger: POST de Meta cuando alguien rellena el formulario de Instagram
- Valida firma HMAC del webhook
- Extrae telefono, nombre, tratamiento del payload
- Guarda lead en Airtable (tabla Leads)
- Llama al microservicio Node.js para iniciar conversación WA

### 2. Worker de reseñas post-cita
- Trigger: cada 5 minutos (Schedule Trigger)
- Busca en Airtable: `estado = completado` + `resena_enviada = false`
- Filtra los que han pasado ≥ N minutos desde la cita (configurable)
- Envía mensaje WhatsApp con link de Google Reviews
- Marca `resena_enviada = true`

### 3a. Bot de Telegram — Admin clínica
- Bot token propio (`TELEGRAM_BOT_TOKEN_CLINICA`)
- Usuarios autorizados: dueños de la clínica (`TELEGRAM_ALLOWED_USERS_CLINICA`)
- Trigger: mensaje entrante de Telegram
- Llama a OpenAI para interpretar el comando en lenguaje natural
- Ejecuta la acción correspondiente en Airtable:
  - Añadir/editar/eliminar tratamientos (nombre, duración, precio)
  - Cambiar tiempo de envío de reseña
  - Ver/editar horario de atención
  - Pausar/reactivar el bot de WhatsApp
  - Consultar configuración actual (qué tratamientos hay, cuánto duran, precios…)
- Consultas sobre negocio (responde en lenguaje natural con datos de Airtable):
  - "¿Cuántas citas tengo esta semana?" → cuenta citas confirmadas en los próximos 7 días
  - "¿Quién ha cancelado últimamente?" → lista cancelaciones de los últimos 7 días con nombre y tratamiento
  - "¿Cuántos leads nuevos han llegado hoy?" → leads creados con origen instagram_ads en las últimas 24h
  - "¿Cuántas citas tengo mañana?" → detalle con nombre, tratamiento y hora
  - "¿Hay huecos libres esta semana?" → franjas sin cita según horario configurado
  - "¿Cuántas reseñas hemos pedido este mes?" → count de resena_enviada = true en el mes actual

### 3b. Bot de Telegram — Sistema (alertas + control técnico)
- Bot token propio distinto (`TELEGRAM_BOT_TOKEN_SISTEMA`)
- Usuario autorizado: solo el desarrollador/mantenedor (`TELEGRAM_ALLOWED_USERS_SISTEMA`)
- Llama a OpenAI para interpretar comandos en lenguaje natural
- Capacidades que expone al desarrollador:
  - Ver estado del sistema ("¿cómo está todo?", "¿hay algún error?")
  - Forzar un health check ahora mismo
  - Reiniciar el microservicio Node.js
  - Pausar/reactivar el bot de WhatsApp
  - Ver métricas (conversaciones activas, citas agendadas hoy, etc.)
  - Ver logs recientes de Airtable
  - Cambiar la frecuencia del health check
  - Activar/desactivar workflows individuales de n8n
- Además recibe notificaciones automáticas del health check (workflow #5)

> **Importante:** la tabla `Configuracion` de Airtable es la fuente de verdad compartida.
> Lo que el admin edita por Telegram es exactamente lo que el bot de WhatsApp lee en tiempo real
> para responder preguntas como "¿cuánto dura X?" o "¿cuánto cuesta Y?".
> No hay config duplicada — un único sitio, dos consumidores.

### 4. Recepción de mensajes WhatsApp entrantes
- Trigger: webhook de WhatsApp Business API
- Filtra mensajes de texto de usuarios activos
- Llama al microservicio Node.js con el mensaje
- Envía la respuesta devuelta al usuario por WhatsApp

### 5. Health check + auto-reparación
- Trigger: Schedule Trigger cada X horas (configurable en Airtable, default 4h)
- Comprueba cada componente del sistema:
  - Microservicio Node.js: `POST /message` con payload de test, espera respuesta válida
  - Workflows n8n: verifica que todos estén activos y sin errores en las últimas ejecuciones
  - Airtable: lectura de prueba en tabla Configuracion
  - OpenAI: llamada mínima a la API
  - WhatsApp Business API: comprueba validez de credenciales
- Si detecta fallo → intenta auto-reparación:
  - Proceso Node.js caído → reinicia via PM2 (comando SSH o endpoint de control)
  - Workflow desactivado → reactiva via API de n8n
  - Fallo de conectividad transitorio → reintenta 1 vez tras 2 minutos
- Si no puede repararlo → manda mensaje Telegram al admin con:
  - Qué componente falló
  - El error exacto
  - Qué intentó hacer para arreglarlo
- Guarda resultado de cada chequeo en Airtable (tabla Logs) para historial

---

## Flujo completo

```
Instagram Lead Ad
      ↓
n8n (webhook Meta) → Airtable (guarda lead)
      ↓
n8n → Node.js microservicio (inicia conversación WA)
      ↓
WhatsApp usuario ↔ n8n (webhook WA) ↔ Node.js microservicio
                                              ↓
                                      Airtable (guarda cita)
                                              ↓
                              n8n worker (cada 5min) → WhatsApp reseña

n8n health check (cada Xh) → comprueba todo → auto-repara o alerta Telegram
```

---

## Lo que tú tienes que hacer en n8n (una sola vez)

1. Conectar credenciales en la UI:
   - WhatsApp Business (API key + Phone Number ID)
   - Airtable (Personal Access Token)
   - OpenAI (API key)
   - Telegram Bot Admin clínica (Bot Token)
   - Telegram Bot Sistema/alertas (Bot Token distinto)
2. Si se usa Google Calendar: autorizar OAuth (click "Connect")
3. Activar los workflows una vez creados (toggle ON)

**Todo lo demás lo hace Claude con MCP + API de n8n.**

---

## Datos que necesita la clínica antes de lanzar

- [ ] Nombre de la clínica y nombre del bot
- [ ] Lista de tratamientos con duración y precio
- [ ] Horario de atención (días y franjas horarias)
- [ ] Dirección física
- [ ] Link de Google Reviews
- [ ] Acceso a Meta Business (para configurar webhook)
- [ ] Decisión sobre sistema de citas (Calendly, Google Calendar, Acuity, etc.)
- [ ] ID de Telegram del administrador
