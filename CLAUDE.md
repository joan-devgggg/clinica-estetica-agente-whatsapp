# Agente WhatsApp — Multi-tenant (Antigravity)

Bot de WhatsApp multi-organización que gestiona citas, reservas y seguimiento post-visita. Cada organización tiene su propio número de WhatsApp, flujo conversacional y panel CRM. Un solo proceso Node.js sirve a todas las orgs simultáneamente.

## Organizaciones activas

| Org | Tipo | WhatsApp | Canal | UUID |
|---|---|---|---|---|
| Restaurante San Remo | restaurant | +34667474233 | whatsapp-web.js | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| Sante Healthy Hair Salon | salon | +34641029104 | 360dialog (Cloud API) | `b2c3d4e5-f6a7-8901-bcde-f12345678901` |

## Arquitectura

Monolito modular Node.js con PM2. Un proceso corre N clientes WhatsApp (uno por org). Supabase (Postgres) con RLS. Dashboard Next.js en `dashboard-app/`.

```
server.js              ← Punto de entrada: crea N clientes WA, arranca workers
├── bot.js             ← Conversación WhatsApp multi-org (detecta org por nº WA)
├── webhook.js         ← API REST multi-org (orgId via header X-Organization-Id)
├── dashboard-app/     ← Dashboard Next.js (puerto 3001)
└── services/
    ├── org-registry.js    ← Mapeo teléfono → orgId, tipo de org, CANAL de WhatsApp
    ├── outbound.js        ← Resolución ÚNICA del cliente saliente + reglas ventana 24h/plantillas
    ├── db.js              ← Capa de datos Supabase (TODAS las funciones reciben orgId)
    ├── supabase.js        ← Cliente Supabase
    ├── calendar.js        ← Mock de mesas (San Remo)
    ├── calendar-sante.js  ← Disponibilidad real por estilista (Sante)
    ├── review.js          ← Worker: reseña Google N horas tras cita completada
    ├── reminder.js        ← Worker: recordatorio 24h antes + auto-completar citas
    ├── auto-return.js     ← Worker: devuelve a 'auto' lo que lleva 7 días mudo en manual
    ├── telegram.js        ← Bot admin multi-org (mismo token, admins por org)
    ├── helpers.js         ← Extracción de datos (restaurante + salón)
    ├── memory.js          ← Sesiones SQLite (clave compuesta orgId:phone)
    ├── metrics.js         ← Métricas internas
    └── providers/
        ├── openai.js             ← System prompts por tipo de org + llamadas Claude API (Anthropic)
        └── threesixty-dialog.js  ← Adapter 360dialog: webhook entrante + cliente saliente (Sante)
```

## Canal de WhatsApp por organización

Cada org tiene UN canal, declarado en `services/org-registry.js` (`getOrgChannel(orgId)`):

- **`wwebjs`** (San Remo) — `server.js` crea un `Client` de whatsapp-web.js con su `LocalAuth`; el entrante llega por el evento `message_create`.
- **`360dialog`** (Sante) — **NO se crea cliente wwebjs**. El entrante llega por `POST /webhook/360dialog/:token` → `process360Webhook` → el mismo `handleIncomingMessage`. La org sigue en el Map `waClients` pero con el cliente de Cloud API, porque `reminder.js` y `review.js` iteran sus claves para saber qué orgs procesar.

**El canal es un dato del registry, nunca se deriva de `SANTE_360_API_KEY`.** Si dependiera de la key, una máquina sin ella levantaría otra vez el cliente wwebjs de Sante y habría dos canales escuchando el mismo número. Eso ya pasó: el dedupe no lo detecta porque los ids viven en espacios distintos (`wamid.…` vs `false_…@c.us_…`) y `TTLMessageDedupe` es un Map en RAM de 60 s por proceso. Guard de refuerzo en `handleIncomingMessage`: un mensaje sin id `wamid.` dirigido a una org no-wwebjs se descarta con `mensaje_ignorado_canal_inactivo`.

Rollback sin deploy: `SANTE_CHANNEL=wwebjs`.

⚠️ **Ventana de 24 h (Cloud API)**: el texto libre solo se entrega dentro de las 24 h desde el último mensaje *entrante* de la clienta. Meta responde 200 igualmente, así que un envío fuera de ventana no se distingue de uno entregado.

`reminder.js` y `review.js` lo resuelven con `resolveAutomatedSend` (`services/outbound.js`), que decide por contacto:

| Caso | Vía |
|---|---|
| Canal wwebjs (San Remo) | texto libre, sin cambios |
| Dentro de 24 h (`db.getLastInboundAt` + `isWithin24hWindow`) | texto libre |
| Fuera de 24 h, con plantilla en `config` | `client.sendTemplate` |
| Fuera de 24 h, **sin** plantilla | log `*_sin_plantilla_configurada` y **no** se marca enviado (reintenta) |

La ventana se calcula sobre `messages.direction = 'inbound'` — nunca sobre `conversations.last_message_at`, que un saliente nuestro refrescaría reabriendo una ventana que Meta considera cerrada.

Plantillas aprobadas (Sante): `sante_recordatorio_cita` ({{1}}=nombre, {{2}}=hora) y `sante_solicitud_resena` ({{1}}=nombre, {{2}}=enlace). Los nombres viven en `config` (`plantilla_recordatorio`, `plantilla_resena`), no en el código. `sanitizeTemplateParam` limpia saltos de línea/tabuladores/espacios múltiples: Meta rechaza el mensaje entero (132000) si un parámetro los lleva.

**La resolución de proveedor saliente es única**: `services/outbound.js` → `resolveOutboundClient(orgId, fallback)`, que enruta por `getOrgChannel` (registry), no por `SANTE_360_API_KEY`. La usan el panel (`webhook.js` → `getOutboundClient`) y los dos workers.

## Retorno automático a `auto` tras silencio (`services/auto-return.js`)

`bot_mode = 'manual'` se pone solo —basta con contestar desde el panel— y no se quitaba
nunca. La conversación se quedaba muda para siempre: el bot calla porque cree que hay una
persona, y la persona hace semanas que pasó a otra cosa.

El barrido corre cada hora, para todas las orgs del Map de clientes, y devuelve a `auto` lo
que lleve **7 días de silencio total** (`conversations.last_message_at`, cualquier
dirección — no la ventana de 24 h, que solo mira entrantes). Umbral por org en
`config.dias_retorno_auto`; **0 lo desactiva**.

Nunca devuelve: `escalation_reason` sin resolver, `pending_actions` en `pending`, o lista
negra. Las tres se comprueban dos veces, al decidir y otra vez como compare-and-set en el
propio UPDATE (`bot_mode` sigue en manual **y** `escalation_reason` sigue a null), porque
entre una cosa y otra pasan minutos y en ese hueco cabe que alguien tome el control.

La traza va en `contacts.metadata.auto_return` (`at`, `dias_silencio`,
`ultima_actividad_at`) y el Monitor la pinta mientras la conversación siga en auto: sin
ella, una devuelta por el sistema y otra devuelta a mano son la misma fila.

## Multi-tenancy

- **Routing**: Cada org tiene su propio número WA. `server.js` crea un `Client` de whatsapp-web.js por org con `LocalAuth({ clientId })` separado. Cuando llega un mensaje, `server.js` pasa el `orgId` a `bot.js`.
- **Sesiones**: Key en SQLite es `${orgId}:${phone}` — el mismo teléfono puede hablar con dos orgs sin conflicto.
- **Base de datos**: Todas las tablas tienen `organization_id`. RLS en Supabase. `db.js` recibe `orgId` como primer parámetro en todas las funciones.
- **Dashboard**: Header `X-Organization-Id` en todas las peticiones API. El perfil del usuario (`profiles.organization_id`) determina qué org ve.
- **Telegram**: Un solo bot, cada admin está vinculado a una org via `config.telegram_admins`.

## Capa de datos — services/db.js

Toda la persistencia va por `db.js`. NUNCA importar `supabase.js` directamente. TODAS las funciones reciben `orgId` como primer parámetro:

```javascript
findByPhone(orgId, telefono)
saveLead(orgId, datos)
saveAppointment(orgId, contactId, opciones)
getAgentConfig(orgId)  // cacheado 60s
getStylistsByOrg(orgId)
getScheduleBlocks(orgId, stylistId, from, to)
```

## Flujo: San Remo (restaurante)

1. Cliente → WhatsApp → bot pregunta nombre, personas, preferencia horaria
2. Mock calendar genera slots → bot propone mesa
3. Cliente acepta → bot pide Bizum → Alberto confirma/rechaza por Telegram
4. Recordatorio 24h antes

## Flujo: Sante (salón de belleza)

1. Clienta → WhatsApp → bot detecta idioma (ES/EN/RU/UK), pregunta nombre
2. Pregunta servicio → fuzzy match contra catálogo de 70+ servicios
3. Upselling automático según reglas (Color raíz → manicura, Balayage → K18, etc.)
4. Pregunta estilista preferida → si recurrente, sugiere su habitual
5. `calendar-sante.js` consulta disponibilidad real: `stylist_schedules - appointments - schedule_blocks`
6. Bot propone huecos con estilista asignada → clienta confirma
7. Cita guardada directamente (sin Bizum) → recordatorio 24h → reseña Google 2h después

## Esquema Supabase

### Tablas principales (todas con organization_id)

| Tabla | Propósito |
|---|---|
| `organizations` | Orgs registradas |
| `profiles` | auth.users → organization_id |
| `contacts` | Clientes (WA phone, nombre, VIP, blacklist, language, preferred_stylist_id) |
| `conversations` | Hilos por contacto |
| `messages` | Mensajes WA (inbound/outbound) |
| `appointments` | Citas/reservas (service, starts_at, ends_at, stylist_id, status) |
| `agent_configs` | System prompt, tone, business_info, services, business_hours por org |
| `config` | Key-value por org (bot_activo, horas_resena, telegram_admins, plantilla_recordatorio, plantilla_resena, dias_retorno_auto) |
| `pending_actions` | Cola de verificaciones Telegram (bizum_review, vip_suggestion, escalation) |
| `stylists` | Equipo del salón (name, role, skills JSONB) |
| `stylist_schedules` | Horario semanal por estilista (day_of_week, start_time, end_time) |
| `schedule_blocks` | Bloqueos manuales (vacaciones, descansos) |

### Estilistas de Sante (seeded)

Los **días de esta tabla son los del seed, no la verdad**: la dueña edita horarios, nombres y
skills desde el panel de Configuración, y `stylist_schedules` es la única fuente fiable. A
04/08/2026, 6 de las 8 estilistas ya no coinciden con su migración. No copies estos días a
ningún test — eso es exactamente lo que dejó `verify:sante` tres semanas en rojo.

| Nombre | Rol | Días (seed) | UUID |
|---|---|---|---|
| Veronika | colorista/estilista | L-S | c3d4...0101 |
| Irina | colorista/estilista | L-S | c3d4...0102 |
| Yulia | colorista/estilista + diagnóstico | L-S | c3d4...0103 |
| Olga (antes «Olgha») | manicura/pedicura | M-J-V | c3d4...0104 |
| Larisa | masajes/spa | L-S | c3d4...0105 |
| Tetiana | extensiones (agenda manual, nunca elegible) | — | c3d4...0106 |
| Natalia | colorista/estilista | — | c3d4...0107 |
| Yulia-Tricóloga | tricóloga (dueña) | — | c3d4...0108 |

## Variables de entorno

```bash
OPENROUTER_API_KEY             # Claude Haiku 3.5 via OpenRouter
SUPABASE_URL                  # URL del proyecto Supabase
SUPABASE_SERVICE_ROLE_KEY     # Service role key
SANREMO_ORG_ID                # UUID San Remo
SANTE_ORG_ID                  # UUID Sante
SANREMO_WA_PHONE              # 34667474233
SANTE_WA_PHONE                # 34641029104
SANTE_360_API_KEY             # 360dialog: clave de envío de Sante (necesaria para ENVIAR como Sante)
SANTE_360_PHONE_NUMBER_ID     # 360dialog: phone number id de Sante
WHATSAPP_360_BASE_URL         # Opcional (default: https://waba-v2.360dialog.io)
WHATSAPP_WEBHOOK_TOKEN        # Token secreto de /webhook/360dialog/:token (única protección de esa ruta)
SANTE_CHANNEL                 # Escape hatch: 'wwebjs' devuelve Sante a whatsapp-web.js
ORGANIZATION_ID               # Fallback/default org
DASHBOARD_API_SECRET          # Bearer token para API REST
TELEGRAM_BOT_TOKEN            # Bot Telegram (compartido)
TELEGRAM_ALLOWED_USERS        # Fallback admin IDs
PORT                          # Puerto Express (default: 3000)
```

## Comandos de desarrollo

```bash
npm install
cd dashboard-app && npm install && cd ..

# Bot + API (puerto 3000) — mostrará QR para cada org
node server.js

# Dashboard (puerto 3001)
cd dashboard-app && npm run dev

# Producción
pm2 start server.js --name antigravity-bot
```

### Los timers de arranque van con `.unref()` — no los quites

```bash
npm run verify:robustez     # sale solo, con exit code. Nada de script -q ni pkill.
```

**El problema (04/08/2026, casi una hora perdida):** `verify:robustez` importa `bot.js`, y al
importarse `bot.js` registraba tres `setInterval` (GC de sesiones, limpieza del dedupe,
barrido de abandono) más un cuarto en `services/metrics.js` (flush a disco). Cuatro timers
referenciados = el event loop nunca se vacía. El script hacía **todo** su trabajo, imprimía
el resumen y se quedaba vivo indefinidamente: 48 minutos en una ocasión, con ~0,5 s de CPU
acumulada. Y como Node bloquea el buffer de stdout cuando no es un TTY, redirigido a fichero
no escribía nada hasta terminar — y como no terminaba, no escribía nunca. Cero salida era
indistinguible de cero progreso.

**Por qué `.unref()` y no otra cosa:** un timer con unref se dispara EXACTAMENTE igual
mientras el proceso siga vivo por cualquier otro motivo; lo único que pierde es la capacidad
de ser él la razón de que siga vivo. En producción el proceso lo mantienen el Express de
`server.js` y los clientes de WhatsApp, así que GC, dedupe, barrido y flush corren igual.
Comprobado: un intervalo unref de 100 ms dispara 5 veces en 600 ms si hay otro handle vivo.

Contrapartida cubierta: un proceso corto que ahora sí termina ya no espera al siguiente tic
de métricas, así que `metrics.js` vacía en `beforeExit` (que admite trabajo asíncrono, al
revés que `exit`). Los handlers de SIGINT/SIGTERM siguen cubriendo la muerte por señal.

Si alguien vuelve a añadir un `setInterval` de módulo, que lo pase por `unrefTimer()`
(`bot.js`) o le ponga `.unref()`: si no, todo esto vuelve.

Línea base con la que comparar: **OK 84 · GAP 9 · BUG 0**. Los GAP son deficiencias medidas,
no regresiones. `verify:sante` sale **entero en verde** (los 4 fallos que arrastraba eran del
test, no del sistema: 3 horarios copiados de la migración y un plural — ver abajo).

### Los datos que edita la dueña no se verifican contra constantes

`stylist_schedules`, `stylists.name`, `stylists.skills`, `agent_configs.services` y
`business_hours` los cambia la dueña desde el panel. Un check que los compare contra una lista
escrita en el fichero mide antigüedad, no corrección: caduca en el primer cambio y deja un
fallo permanente que no hay que arreglar — que es la forma más rápida de que todo el mundo
deje de leer el informe. Ya pasó tres veces (horarios de Tetiana/Natalia/Yulia-Tricóloga,
"Consulta con exactamente 4 estilistas", y Olgha→Olga contándose como fallo del matcher).

Se verifica con invariantes que se sostienen con cualquier valor:

```bash
npm run verify:sante          # catálogo + motor de huecos + Fase 7 (coherencia de horarios)
npm run verify:sante:agenda   # SOLO LECTURA: ¿las citas futuras siguen cabiendo?
```

```bash
npm run informe:nombres            # SOLO LECTURA: ¿a quién no sabemos cómo llamar?
npm run informe:nombres -- sante   # una sola org (sante | sanremo | slug | uuid)
```

`informe:nombres` mira las **dos** columnas del nombre, que fallan distinto:
`contacts.full_name` es NULLABLE y es la que bloquea el recordatorio de 24 h;
`appointments.full_name` es **NOT NULL**, así que cuando falta es **cadena vacía** —
`saveAppointment` escribe `contact.nombre || ''`— y ningún `IS NULL` la encuentra. Cruza las
dos: lo más común es que el nombre esté en una y no en la otra, y eso se arregla copiando.
"Sin nombre" es `!isUsableName`, no `!full_name`: entra 'cliente' o '-', y no entra el
cirílico. Sale con código 1 solo con `error` (hay una cita futura y su recordatorio no va a
salir). No escribe nada: rellenar un nombre lo decide una persona, porque el bot saludará
con él.

`verify:sante:agenda` es la red que faltaba: cuando la dueña quita un día o recorta una franja,
las citas ya reservadas en ese hueco no se mueven ni avisan. Comprueba día laborable, franja
(con `ends_at` incluido), `schedule_blocks`, skill por segmento de servicio y solapes. Sale con
código 1 solo con hallazgos de severidad `error`; `sin-skill` es aviso porque puede ser una
decisión deliberada. La lógica pura vive en `tests/lib/agenda-audit.js` y sí corre en `npm test`.

## Regla de oro

**San Remo NO se toca.** Cualquier cambio en el código compartido debe mantener el comportamiento exacto de San Remo. El flujo Bizum, party_size, mock calendar — todo sigue igual para `orgType === 'restaurant'`.
