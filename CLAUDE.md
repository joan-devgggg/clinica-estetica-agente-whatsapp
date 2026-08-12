# Agente WhatsApp — Multi-tenant (Antigravity)

Bot de WhatsApp multi-organización que gestiona citas, reservas y seguimiento post-visita. Cada organización tiene su propio número de WhatsApp, flujo conversacional y panel CRM. Un solo proceso Node.js sirve a todas las orgs simultáneamente.

## Reglas de trabajo

Se aplican siempre; no hace falta repetirlas en cada petición. Cada una nació de algo que pasó
en este repo, y el ejemplo está para que se entienda el coste de saltársela.

**1. Diagnóstico antes de tocar código, y verificado contra la BD o el motor real.**
Lo que parece un problema casi nunca es el problema. *07/08/2026: tres citas con
`service='Cita manual'` parecían servicios que faltaban del catálogo; abriendo las filas
resultaron ser bloqueos de agenda con un contacto falso ("Close TIME") y una cuarta cita real
colgando del mismo contacto. Ese mismo día, la afirmación "el botón de bloquear está en otra
pantalla" resultó falsa al abrir el fichero: está pegado a "Nueva cita".*

**2. Un test que pasa con y sin el arreglo no protege nada.** Antes de darlo por bueno, hay que
verlo fallar sin el arreglo. *El escenario 3 de `verify:robustez:llm` comprobaba `/balayage/i`
sobre la respuesta del bot: dos corridas con el MISMO texto («Genial. ¿Qué día te viene
mejor?») tenían el estado OPUESTO. Medía la redacción, no la conducta. Ahora afirma el
ESTADO (`session.selectedService`), que la prosa del modelo no puede fabricar.*

**3. Nada de defaults silenciosos: si un dato no se resuelve, no se inventa.** Se dice, y se
cuenta aparte. *`precio_facturado` a null NO es un snapshot: sin el `!= null`, `Number(null)`
daba 0 y la cita se presentaba como calculada a 0,00 €, un importe inventado comunicado como
cifra buena. Igual `resolveImporteReferencia`, que devuelve **null** y no 0 cuando el servicio
no resuelve — un 0 metería esa cita en el descuadre como si se hubiera cobrado de menos.*

**4. Nada de afirmar sin verificar: ninguna escritura devuelve éxito sin mirar el `error` y las
filas afectadas.** De ahí `assertRead` / `assertWrite` / `assertRowsAffected` (auditoría del
29-30/07/2026). *Un UPDATE cuyos `.eq()` no casan nada devuelve `error=null`, y por eso hace
falta `assertRowsAffected`. El 07/08/2026 apareció otro caso: `deleteLead` no miraba el
`error`, así que un borrado rechazado devolvía `{ok:true}` y el panel decía "borrado" sobre un
contacto que seguía ahí.*

**5. Lo que edita la dueña no se verifica contra constantes en git.** Horarios, nombres, skills
y catálogo cambian desde el panel; un check contra una lista escrita en el fichero mide
antigüedad, no corrección. Detalle y ejemplos en
[Los datos que edita la dueña no se verifican contra constantes](#los-datos-que-edita-la-dueña-no-se-verifican-contra-constantes).

**6. Toda migración se enseña ANTES de aplicarla, y a Supabase no se escribe sin permiso
explícito.** Leerla entera es la última oportunidad de ver lo que los tests no ven. *Revisar la
035 antes de aplicarla cazó que `ON DELETE SET NULL` en `cobros.appointment_id` habría hecho
imposible borrar una cita: ese SET NULL emite un UPDATE que choca con el trigger de
congelación. Cuando hay que probar contra la BD real, se hace en un bloque que revierte
(`DO $$ … RAISE $$`) y se comprueba que no queda ni una fila.*

**7. Antes de mutar código para comprobar que algo falla sin el arreglo, `cp` a un fichero
aparte.** `git checkout` solo restaura lo COMITEADO, y lo que acabas de escribir no lo está.

Esta regla ya se ha incumplido **dos veces**, las dos igual y las dos el 07/08/2026: mutar un
fichero con cambios sin comitear y "restaurarlo" con `git checkout --`, que devuelve la versión
del último commit y **borra el trabajo nuevo**. Pasó con `caja-session.ts` (se perdieron
`estilistaPorDefecto` y `saldraSinPin` recién escritos) y con `tests/caja-pendientes.test.js`
(se perdieron los tests del no-show). Las dos veces se detectó al mirar si el arreglo seguía
ahí, no en el momento.

Lo que engaña es que git *parece* la copia de seguridad, y lo es — de lo comiteado. Si el
experimento va sobre algo que aún no lo está, la copia hay que hacerla a mano:
`cp fichero /tmp/…` antes de mutar, `cp` de vuelta después, y comprobar que el arreglo sigue en
el fichero. `git stash push`/`pop` sí vale, y es lo que se usó bien la primera vez con
`reservas/page.tsx`; lo que no vale nunca es `git checkout --`.

**8. Parar y preguntar si algo cambia el diseño o se sale del alcance.** No ampliarlo por
iniciativa propia ni recortarlo en silencio. *Antes de escribir la 035 se pararon tres
decisiones (rectificación por fila nueva, identidad por PIN, y qué hacer con "Cita manual").
Y en la otra dirección: la deuda del upselling se decidió NO arreglar el 05/08/2026 por falta
de señal, en vez de acometerla de paso.*

**9. Nada está vivo hasta que se pushea.** Un arreglo comiteado en local se comporta
EXACTAMENTE como si no existiera: producción sigue con el código viejo, los síntomas siguen
ahí, y se investigan como si el arreglo no se hubiera hecho. Commits sí —uno por hallazgo, con
los tests en verde antes de cada uno—; `git push` lo lanza el dueño, así que al terminar hay
que decir en voz alta qué queda sin desplegar. *05/08/2026: el arreglo del idioma (`a88c669`,
17:48, `language_source` + migración 034) pasó horas comiteado en local mientras producción
servía el código anterior. Se detectó de rebote, por una ficha creada desde el panel con
`metadata` vacío y sin `language_source` — señal de que el proceso que servía el panel no
tenía ese código. Mientras tanto se seguía investigando por qué una clienta anglófona recibía
castellano, y el worker de reseñas mandó cuatro con la versión antigua.* Y un piso más abajo,
lo mismo sin comitear: *`7f53ecf` (04/08) arregla un `npm test` que fallaba en un clon limpio
porque la heurística de idioma solo existía en la working copy de quien la escribió.*

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
    ├── admin-alerts.js    ← alertOnce: un aviso por asunto, y SOLO si Telegram lo confirma
    ├── channel-health.js  ← Aviso de canal caído: 3 fallos de plataforma seguidos
    ├── llm-health.js      ← Aviso de proveedor del modelo caído (cuenta: 1 fallo · transitorio: 3)
    ├── bot-pause-alert.js ← Bot pausado: al tirar un mensaje, y a las 2 h de apertura
    ├── espera-alert.js    ← DORMIDO a propósito (mide el panel, no la atención) — ver su sección
    ├── horario-apertura.js← Puro: cuánto tiempo de ATENCIÓN hay entre dos instantes
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

Plantillas aprobadas (Sante): `sante_recordatorio_cita` ({{1}}=nombre, {{2}}=**cuándo**) y `sante_solicitud_resena` ({{1}}=nombre, {{2}}=enlace). Los nombres viven en `config` (`plantilla_recordatorio`, `plantilla_resena`), no en el código. `sanitizeTemplateParam` limpia saltos de línea/tabuladores/espacios múltiples: Meta rechaza el mensaje entero (132000) si un parámetro los lleva.

### El `{{2}}` del recordatorio dice la hora Y la fecha (`formatReminderWhen`)

Historia completa: [`docs/incidentes-cerrados.md#recordatorio-con-fecha`](docs/incidentes-cerrados.md#recordatorio-con-fecha). Lo que hay que recordar al tocarlo:

- La fecha va DETRÁS de la hora (el texto fijo aprobado la precede con «a las / at / в / о»)
  y `{{2}}` es texto libre — **sin plantilla nueva**.
- **La tabla de días a mano es TODO el motivo de que sea una función**: Intl da el día en
  NOMINATIVO y detrás de la preposición el ruso/ucraniano piden ACUSATIVO («в среду»), y el
  martes cambia la preposición («**во** вторник»). Misma decisión que `MESES_MULTI`.
- **Fecha concreta, nunca «mañana»**: `horas_recordatorio` la edita la dueña y un retraso
  convierte «mañana» en mentira.
- **Un solo valor para los dos caminos** (texto libre y plantilla): `resolveCuando` se llama
  UNA vez y alimenta a los dos.
- **San Remo fuera**, gateado por `getOrgType(orgId) === 'salon'`; su recordatorio sigue byte
  por byte igual, con test.
- **Una fecha ilegible NO bloquea el envío** (sale la hora sola) pero avisa: log
  `recordatorio_fecha_no_formateable` + Telegram con el valor crudo, throttle por clave Y
  VALOR. No es motivo de `motivoNoEnviable` — no impide el envío. Pasa de verdad:
  `minutosHastaCita` no descarta una `fecha_cita` malformada.

Red: `tests/recordatorio-con-fecha.test.js` — los siete días × cuatro idiomas uno por uno.
Las cinco protecciones probadas por mutación.

**La resolución de proveedor saliente es única**: `services/outbound.js` → `resolveOutboundClient(orgId, fallback)`, que enruta por `getOrgChannel` (registry), no por `SANTE_360_API_KEY`. La usan el panel (`webhook.js` → `getOutboundClient`) y los dos workers.

## Campaña por tandas: el allowlist se recalcula, la exclusión se guarda

Una campaña que va por tandas (`campaignKey` fija, `limit` por tanda) y que deja fuera a un
grupo concreto **guarda la lista de EXCLUIDOS, nunca la de destinatarios**. El allowlist se
recalcula antes de cada tanda restando las exclusiones de la audiencia del momento:
`getBroadcastAudience({audience:'todos'})` menos el set de exclusiones → `phones`.

Congelar los ~700 destinatarios parece equivalente y no lo es: es una **foto**. La audiencia
enviable de Sante pasó de 718 a 723 en dos días, así que una lista congelada deja fuera para
siempre a toda clienta creada después, y en silencio — para el motor no existían.

Y el allowlist hay que pasarlo en **todas** las tandas: el dedupe de `campaignKey` impide
repetir destinatarios, pero **no recuerda a quién excluiste** (no hay fila en
`broadcast_sends` para quien nunca entró en la lista). Una tanda 2 sin allowlist se lo manda
a los excluidos.

Campaña de verano en curso: [`docs/campana-verano-tandas.md`](docs/campana-verano-tandas.md) ·
lista en `data/campana-verano-exclusiones.json` (**`revisado_por_duena: false`** — son
conjeturas por nombre de pila, 19 de 20 sin ninguna cita).

Para excluir NO se usa `is_blacklisted` (significa "clienta bloqueada" y se ve así en el
panel) ni se siembran filas `'sent'` en `broadcast_sends` (escribiría "enviado" sobre
mensajes que nunca salieron, en la tabla de la que sale luego el reparto por estado).

## Avisos al admin: solo cuentan si llegan

Historia completa (incidentes de OpenRouter y 360dialog):
[`docs/incidentes-cerrados.md#avisos-al-admin`](docs/incidentes-cerrados.md#avisos-al-admin).

- `alertOnce` (`services/admin-alerts.js`) marca la clave **después** de que Telegram
  confirme. El único log que prueba entrega es `telegram_notify_ok`; sin entrega la clave se
  libera y el siguiente tic reintenta. `clearAlert(orgId, clave)` la libera a mano.
- **Canal caído** (`channel-health.js`): 3 fallos consecutivos de PLATAFORMA (401/403, 429,
  5xx, frame muerto) → aviso; primer envío bueno → «ha vuelto». Los fallos de DESTINATARIO
  **no cuentan** (131047 fuera de ventana, 132000/1 plantilla): una campaña normal acumula
  decenas. Instrumentados los 4 embudos —`waSendMessage`, reminder, review, broadcast—, nunca
  los call sites; en `waSendMessage` el reporte va FUERA del bucle de reintentos.
- **El modelo no responde** (`llm-health.js`): **cuenta (402/401/403) avisa al PRIMER fallo**
  (un «sin saldo» es cierto desde el primero); **transitorio (429/5xx/red) espera a 3**. Dos
  textos distintos. NO cuentan un 400 (nuestro payload) ni un JSON mal formado (eso mide la
  calidad del modelo). Solo el intento DEFINITIVO de `getChatbotResponse`; `summarizeHistory`
  queda fuera a propósito.
- **Bot pausado demasiado tiempo** (`bot-pause-alert.js`): vigilante cada 10 min; umbral
  **2 h de horario de APERTURA** (`config.horario`), no de reloj. Si abre con el bot ya
  pausado, avisa al abrir. «Pausado desde» = `config.updated_at` de `bot_activo`. Una org sin
  `horario` (hoy San Remo) cuenta reloj, y se dice.

## El vigilante de esperas está DORMIDO, y no por olvido (`services/espera-alert.js`)

**No lo enciendas.** Escrito el 09/08/2026 y apagado el 10/08 —antes de correr nunca en
producción— porque **mide otra cosa distinta de la que dice medir**: la dueña atiende desde el
móvil sin cerrar la `pending_action` en el panel, así que la regla 1 mide «alguien cerró la
fila en el panel» y la regla 2 mide «el bot no contestó», que no es «nadie contestó». Sus dos
casos estrella (Olga Yarmak, 34656332064) estaban atendidos. Historia y diseño completo:
[`docs/incidentes-cerrados.md#vigilante-de-esperas`](docs/incidentes-cerrados.md#vigilante-de-esperas).

- **Requisito único para encenderlo: que los ECOS registren en `messages` las respuestas del
  móvil.** No es calibración: sin ecos no hay umbral que lo arregle. Interruptor
  `VIGILANTE_ESPERAS=on`, apagado **por defecto**.
- El código se deja entero a propósito para el día que los ecos entren.
- Umbral: **60 min de APERTURA**. La distribución no elige el número (dos poblaciones a
  cuatro órdenes de magnitud: p95 13 s vs. horas/nunca); lo elige la jornada, que es dato
  editable (`config.horario`). Un solo umbral para las dos reglas.
- **Lo que NO avisa es la mitad del diseño**: bot pausado (lo dice `bot-pause-alert`),
  escalada ya avisada (UN aviso), lista negra (silencio deliberado), y >7 días (conversación
  muerta, el número de `auto-return`).
- Las lecturas van con `assertRead` y **no** reutilizan `getPendingActions`, que se traga el
  `error`: un vigilante ciego además tranquiliza.

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

## El idioma de una clienta (`contacts.language`)

Decide en qué idioma le habla el bot, y **qué plantilla de Meta recibe en una campaña**.
Historia completa (autocontestadores, DarYsol, la clienta de EEUU):
[`docs/incidentes-cerrados.md#idioma`](docs/incidentes-cerrados.md#idioma).

- **Tres escritores y solo tres**: el INSERT de `saveLead` (default `'es'`),
  `updateContactLanguage` (observado) y `updateLeadById` (corregido a mano).
  `IDIOMAS_SOPORTADOS` (`helpers.js`) es la lista única; un valor fuera se rechaza — sería
  clave contra `config.plantilla_*` y la campaña omitiría a la clienta con un `sin_plantilla`
  sin relación visible con la causa.
- **El campo mezcla tres calidades**, y lo dice `metadata.language_source`
  (`'observed' | 'inferred' | 'default'`). La columna `language` no cambia nunca por esto.
  Segmentar con `metadata->>'language_source'`, no a ojo. Backfill: `034_language_source.sql`,
  con las MISMAS reglas que `resolveLanguageSource` (`helpers.js`) — si se separan, el
  backfill queda como una foto que la lógica desmiente.
- **`'observed'` exige DOS mensajes que coincidan, y no lo escribe una centralita** (tanda 1,
  07/08/2026: tres autocontestadores contestaron en 7-10 s y dos fichas quedaron en idioma
  equivocado). **Capa 1 — `persistirIdiomaObservado` (bot.js)**, paso ÚNICO de los dos
  detectores: a <**30 s** de un `broadcast_sends.sent_at` de ese teléfono no se escribe NADA
  en la ficha. La fuente es `broadcast_sends` y **no `messages`** (la plantilla de campaña no
  se escribe en `messages`; con `messages` la guarda no saltaría nunca). Umbral medido sobre
  n=3, falla hacia el lado bueno. **Recalibrar con la tanda 2.**
  **Capa 2 — corroboración (`updateContactLanguage`)**: `language` se escribe al primer
  mensaje; la MARCA espera al segundo (`language_candidate`). Un `'observed'` no se degrada.
  Trampa cubierta: en la rama sin promoción hay que **congelar la fuente explícitamente** si
  la ficha no la tenía — si no, `resolveLanguageSource` la deduce de la columna ya cambiada y
  una ficha sin corroborar se lee como observada.
- **DEUDA**: el envelope de Cloud API trae `value.contacts[].profile.name` (nombre comercial
  de las cuentas de empresa) y `process360Webhook` lo descarta. Sería la señal DIRECTA;
  aplazado el 07/08/2026, no descartado.
- **Un default NO se le pasa al LLM como idioma**: `bot.js` siembra `session.language` solo si
  la fuente no es `'default'` (traza `idioma_ficha_por_defecto_ignorado`); un `'inferred'` sí
  se pasa, anunciado como PROBABLE.
- **Los días de la semana están en las dos listas de `detectLanguage`** (respuesta frecuente a
  «¿qué día te viene bien?»), sin solape entre ambas — un día en las dos devolvería `null`.
- **Ucraniano**: letras exclusivas (`і ї є ґ`) y, si no las hay, frases que no existen en ruso
  — sin esa segunda regla «Доброго дня» caía en `'ru'`. Los patrones cirílicos van SIEMPRE por
  `buildCyrillicRe` contra `normalizeText` (NFD descompone й/ё/ї, y `\b` es ASCII).

## La conversación de Olga Yarmak (07/08/2026): cinco síntomas, cuatro causas

Cinco fallos en 17 minutos, tres de ellos el mismo bug. La lección que ordena esta sección y
las dos siguientes: **una red demasiado ancha no sobra un mensaje, pierde el bueno.** Historia
completa: [`docs/incidentes-cerrados.md#olga-yarmak`](docs/incidentes-cerrados.md#olga-yarmak).

- **La raíz común**: `respondsWithInventedSlots` marcaba como inventado cualquier `HH:MM` con
  `availableSlots` vacío — y el horario del salón *son* dos `HH:MM`, así que mataba «cerramos
  a las 19:00», la única respuesta correcta. La exención exige **cuatro** cosas (las tres
  últimas probadas por mutación): (1) toda hora es punta del horario o cae fuera de él;
  (2) **dos** puntas distintas — una hora suelta es una oferta; (3) el texto se declara
  horario (`statesOpeningHours`); (4) no da la reserva por hecha (`llmClaimsBooked`).
  `asksForBookingApproval` **no** entra: exonera de más (`подойдёт` está en
  `BOOKING_APPROVAL_QUESTIONS` y aparece en la respuesta correcta en ruso).
- **Gate determinista antes del LLM**: `detectHoraFueraDeHorario` (helpers, puro), primer
  consumidor de `agent_configs.business_hours`. Nada de constantes (regla 5); sin
  `business_hours` utilizable **no se dice nada** (regla 3). El mensaje lleva apertura Y
  cierre. Sin día concreto se usa el **SOBRE** de todos los días (apertura más temprana,
  cierre más tardío), no la franja común: solo se declara fuera de horario lo que lo es
  **todos** los días.

- **El menú de rescate tenía suelo, no techo**: `streak >= 2` devolvía el mismo párrafo
  indefinidamente. Ahora al cuarto turno sin servicio se **ofrece** una persona y se espera el
  «sí» (`pendingEscalation`, armado a mano y no vía `offersHumanHandover`, que solo reconoce
  el castellano — para una clienta rusa la oferta quedaría colgando).
- **Fechas inventadas** (Ludmila Zarahovich, 03/08: pidió el 28, le ofrecieron «27, 29 o 30»
  y le negaron los tres): se vigilaban las horas y nadie las fechas.
  `respondsWithInventedDates` con **dos exenciones, que son la parte que importa**: (1) la
  fecha de una cita que la clienta YA tiene es legítima; (2) declarar que no hay hueco en
  **UNA** fecha es negación honesta, no oferta — el límite de una es lo que separa eso del
  mensaje de Ludmila. `extractMentionedDates`: cuatro idiomas, enumeración con coma **y**
  conjunción (quedarse en la coma pierde el último), en inglés el día detrás del mes, límites
  de palabra a mano (`\b` es ASCII: «mayo» casa dentro de «mayoría»), y un día suelto sin mes
  se deja fuera — choca con elegir hueco por número.

- **Cancelar no lo ejecuta el modelo** (Celeste González, 06/08: el bot le canceló la cita
  60 s después de crearla, sin preguntar). Había **dos caminos para la misma acción y solo uno
  con guarda**; ahora el `accion` del modelo pasa por `cancelarConConfirmacion` y la guarda
  vive **dentro de `handleAppointmentAction`** (el salón no cancela por ahí, punto), para que
  un camino nuevo no pueda reabrirlo. San Remo intacto, con test. Y `detectCancelRequest` no
  reconocía «Cancélala»: los enclíticos van ENUMERADOS (`-me/-la/-lo`), no con comodín —
  «cancelada» es *nuestro* acuse y «cancelación» pregunta por la política; test de falso
  positivo para esos dos, «cáncer» y «canela».
- **Si se escala, se dice**: `ensureHandoverAcknowledged` **añade** el acuse cuando el LLM
  escala de verdad (antes la clienta recibía una pregunta y luego silencio). La mala
  clasificación del LLM no se persigue: con acuse, una escalada de más deja a una clienta
  bien avisada. Límite conocido: `HANDOVER_TRASPASO`/`DESTINO` son castellano; un traspaso ya
  anunciado en ruso recibe acuse redundante (las dos frases ciertas). Ampliarlos cambiaría a
  quién auto-escala la red del 28/07.
- **El trato de usted**: `detectTratamiento` → `session.tratamiento` →
  `contacts.metadata.tratamiento` (jsonb, sin migración) + línea de prompt. Viaja en
  `buildSessionExtra` — sin eso se pierde en cada rehidratación. TRAMPA cubierta: «на вы» es
  subcadena de «на выходных» (fin de semana); hace falta el lookahead cirílico, `\b` no sirve.
  DEUDA deliberada: solo tienen variante formal los textos fijos del camino de Olga; el resto
  sigue tuteando hasta que haya señal de que molesta.
- **Fotos**: no hay **salida** de media (`image`/`video` solo de ENTRADA en
  `threesixty-dialog.js`). `business_info.instagram`/`.web` son editables; si están, el prompt
  manda pasarlos; si no, decir que no se pueden enviar y ofrecer la consulta — prohibido
  «te las mando en un momento».

## «¿Te lo reservo?» es una pregunta, y la red final se la comía

11/08/2026, conv `7a92ac2a`. Una clienta pregunta por el anti-encrespamiento, el bot le pide
el largo del pelo, ella contesta **«Lo tengo por encima del pecho»** y recibe «Uy, no he
podido fijar ese hueco 😕 ¿Cuál de los horarios disponibles te viene mejor?». Dos veces —
12:04 y 12:40, las dos justo tras describir el largo— sin que se hubiera hablado de horarios
en toda la conversación. Se fue sin cita, y 38 s después escribió «No puedo 160 € más
productos»: **mapeó ella sola su largo al precio correcto**, que es justo lo que el bot iba a
decirle y no dijo.

**La causa es el texto del PROPIO bot, no nada que dijera ella.** Con el servicio ya resuelto
el modelo cierra ofreciendo «¿Te lo reservo?», y `llmClaimsBooked` lo casa por su patrón de
1ª persona (`te lo reservo` / `te la apunto`): la red final anti-mentira se activa **sobre una
pregunta**. Como no hay hora ni fecha que casar, `pickChosenSlot` devuelve null y el `else`
de `bot.js` pisaba la respuesta buena. Medido: **6 de cada 10** turnos reales en ese estado.

Lo que se descartó con medición, porque las dos hipótesis naturales eran falsas: **no existe
`accion: 'reservar'`** (el enum es `cancelar|cambiar|escalar_humano|null`) y
**`cita_confirmada` vino `false` en 5 de 5** rejugadas del turno literal contra el LLM real —
o sea que la rama del flag (`cita_sante_flag_sin_slot`) queda exonerada. Ningún detector
determinista casa con ese texto, `isAffirmative` incluida. Y `pickChosenSlot` **no lee el
mensaje de la clienta**: solo `HH:MM` + fecha de `aiResponse.datos`.

**La exención va en el `else`, NUNCA en el gate.** Metida en el gate se saltaría la red
también cuando SÍ hay hueco identificado («te la apunto el jueves a las 10:00, ¿te va bien?»),
que es lo que debe seguir verificándose contra la agenda. En el `else` solo actúa cuando no
hay nada que guardar, así que ninguna reserva cambia. Traza propia:
`cita_sante_oferta_sin_slot`.

**`asksForBookingApproval` tiene historia y por eso se comprobó en los cuatro idiomas**: el
07/08 se QUITÓ de la exención de horario por exonerar de más (`подойдёт` está en
`BOOKING_APPROVAL_QUESTIONS`). Aquí no reabre aquello — las seis afirmaciones reales
(«te la he reservado», «queda confirmada», «you are all set», «записала тебя», «запис
підтверджено») dan `asksForBookingApproval` **false** y mantienen la red activa. Está fijado
fila por fila en `tests/oferta-no-es-afirmacion.test.js`, probado por mutación.

Es la lección de Olga otra vez, y la de Michal: **una red demasiado ancha no sobra un mensaje,
pierde el bueno.**

**Debajo había una causa estructural, y esa ya está arreglada** (ver la sección siguiente):
`extractLargoPelo` no entendía «por encima del pecho», así que el bloque determinista no
resolvía y el turno quedaba entero en manos del modelo.

**El otro síntoma de la misma conversación es la ventana del buffer** (causa 4 de la auditoría
del 09/08, ya decidida como no-arreglar): a las 12:03 el bot preguntó el largo **dos veces
seguidas con redacción distinta** porque los dos mensajes de ella iban a **7,197 s** y
`BUFFER_DELAY_MS` son 5 000. El matiz que aquí duele más de lo que dice esa nota: el segundo
mensaje era **«Al menos\*», la corrección de una errata** — se contestó dos veces a la misma
frase.

## El largo del pelo: el modificador manda, y se evalúa de 4 a 1

El largo fija el precio (Anti-encrespamiento: 120 / 160 / 180 €) y se le dice a la clienta
como cifra buena. **Un `null` no es un fallo** —el bot vuelve a preguntar o acepta el «no
sé»—; lo caro es devolver el tramo EQUIVOCADO. Mapeo completo y los cuatro idiomas:
[`docs/largo-del-pelo.md`](docs/largo-del-pelo.md).

**El sujetador devuelve `null` A PROPÓSITO** («a la altura del sujetador», «bra strap
length», «до бретельки»…). No es un hueco por rellenar: cae en la raya entre los omóplatos
(2) y media espalda (3), no se puede deducir a cuál va, y preguntar otra vez es gratis
mientras que meterlo en un tramo son 20 € de error **en cualquiera de las dos direcciones**.
Añadirlo «para completar la lista» cambia una pregunta de más por un precio equivocado. Está
escrito en el propio `LARGO_REGLAS` y hay un test que lo afirma, para que ese añadido salga en
rojo y no en la factura de una clienta.

**El mapeo lo fija la dueña, no el código** (11/08/2026). Dónde cae cada punto del cuerpo es
criterio de salón: «pecho» se mide por delante y el pelo cae por detrás.

**El invariante, que es lo único que hay que recordar al tocar `extractLargoPelo`:** un punto
SUELTO se registra en su tramo («hombros» → 1) y con eso cubre gratis «hasta los hombros»,
«por encima de los hombros» y «a la altura de los hombros». Lo que se registra aparte es el
**«por debajo de»**, porque significa un tramo MÁS ALTO — y por eso el bucle va **de 4 hacia
1**: el tramo alto lo atrapa antes de que el bajo vea el punto suelto que lleva dentro.
Registrarlo en su propio tramo o más abajo **pierde el modificador en silencio**.

Las tres frases que lo hacían mal —«por debajo de los hombros» (Corto en vez de Medio, 40 €
de error), «media espalda» y «hasta la mitad de la espalda» (Medio en vez de Largo)— eran las
únicas que respondían MAL; las demás simplemente no se entendían, que sale mucho más barato.
La tabla caso a caso está en [`docs/largo-del-pelo.md`](docs/largo-del-pelo.md).

**Ruso y ucraniano no comparten entrada** aunque se parezcan a la vista: «до талии» (ru, `и`)
y «до талії» (uk, `і`) llevan letras DISTINTAS, y por eso la ucraniana casaba y la rusa
devolvía null. Todo el cirílico va por `buildCyrillicRe`, nunca con `\b` (que es ASCII).

Red: `tests/largo-del-pelo.test.js`, por tramo y por idioma. Probado con **dos** mutaciones,
porque prueban cosas distintas: revertir la función tumba los 21 bloques nuevos, e invertir
**solo el orden del bucle** —mismo vocabulario— tumba 12. Lo segundo es lo que demuestra que
el que protege es el orden, no las palabras. Y `verify:sante` (Fase 2-largo) llevaba el bug
metido en su propio fixture: usaba `'por media espalda'` como texto de nivel 2, o sea que
afirmaba el mapeo equivocado; ahora usa «por debajo de los hombros» y vigila el caso caro.

## Michal Gradziel y Esther Cediloo: seis síntomas, cuatro causas

Dos conversaciones del 07-08/08/2026, arregladas el 09/08: Michal pidió una decoloración
completa **en inglés** y la cita la acabó cerrando una persona desde el panel; Esther pidió un
dato que el bot no tenía. Historia completa:
[`docs/incidentes-cerrados.md#michal-y-esther`](docs/incidentes-cerrados.md#michal-y-esther).

- **`largoKeywords` va en los cuatro idiomas**, con criterio de admisión: **que nadie la diga
  de pasada**. `blonde` a secas queda fuera («I'm blonde and I want a haircut» es una
  descripción) y tiene test de falso positivo.
- **Guarda sobre lo que el modelo DICE**: `proposesTimingWithoutService` sustituye por
  `salonNoSlotsMsg` cuando el modelo propone día/franja/horas con `selectedService` a null.
  Las guardas de código (`loadAvailableSlots`, `askDatePreferenceFirst`) estaban bien y no
  fallaron; lo que no existía era esta.
- **`extractLooseClockHours`**: las tres redes eran ciegas a horas sin minutos («around 10,
  11, or 12») porque `HORA_HHMM_SRC` exige los dos puntos. Exige **marcador temporal delante**
  (a las / around / at / после / в…): **«Largo 2» no son las dos**, «35 €» no son las nueve y
  «August 10» es una fecha. Enumeración con coma **y** conjunción, y la misma regla de 12h que
  `normalizeHora` — que en `bot.js` se conserva encima (convierte «5:30» en 17:30 para casar
  con un hueco real).

Y el resto en corto:

- **Fotos (tres arreglos).** La rama de media hace `return` antes del buffer. El idioma
  ahora cascada: sesión → **el texto que espera en el buffer** (evidencia del mismo turno) →
  la ficha solo si es `'observed'` — un `'default'` o `'inferred'` no deciden. El turno de la
  foto **se anota en `session.history`** y lo drena `processMessageCore` (el placeholder
  `[image]` va a `messages`/panel, no al prompt). Y con texto suyo en vuelo la foto **no se
  contesta aparte**; una foto sola sí, con test.
- **Dato que el bot no tiene** → caso 7, `motivo_escalado: "dato_no_disponible"`, acotado a
  lo CONCRETO y COMPROBABLE y explícitamente fuera para precios, servicios, horarios y
  disponibilidad. Escenario 23 de `verify:robustez:llm`, que afirma el ESTADO.
- **Decidido NO arreglar** (anotado en el propio código): la ventana del buffer
  (`BUFFER_DELAY_MS` 5000 vs mensajes a 7,9 s — es dimensionado, no dedupe); el dedupe de
  sesión muerto en la ruta real (`flushBuffer` pasa `messageKey = null`; toda la protección
  es `buffer.seenKeys`); y `sinServicioStreak` no viaja en `buildSessionExtra` (el nivel
  «ofrecer una persona» es inalcanzable si la conversación cruza un timeout).

## Bloquear agenda: `schedule_blocks`, nunca una cita con clienta inventada

Un hueco que se cierra **es un `schedule_blocks`**. Como cita con contacto falso resta
disponibilidad igual —el motor trata citas y bloqueos idénticos
(`calendar-sante.js:232-236`)— pero mete a un fantasma en «Pendientes de cobrar» y en todo
recuento de clientas. Lo hace el botón «Bloquear hueco», pegado a «Nueva cita». Historia de
los cuatro «Close TIME» (07/08/2026):
[`docs/incidentes-cerrados.md#bloquear-agenda`](docs/incidentes-cerrados.md#bloquear-agenda);
su detalle solo queda en
[`data/close-time-backup-2026-08-07.json`](data/close-time-backup-2026-08-07.json)
(`schedule_blocks` solo tiene `reason`, texto libre).

Lo que costó y no hay que redescubrir:

- **El nombre del servicio no distingue un bloqueo de una cita** («"Cita manual" es una
  convención del panel, no un dato» — migración 037). Eran CUATRO, no tres: el cuarto era
  «Manicura + gel», que resolvía contra el catálogo. Lo único que lo distingue es preguntar.
- **`cobros.appointment_id` es `ON DELETE RESTRICT`** (`035_cobros.sql:46`): un solo cobro,
  aunque esté anulado, hace fallar el borrado del contacto ENTERO por CASCADE. No se arregla
  con NULL — el trigger `cobros_congelar_importes` congela `appointment_id`. Solo cabe borrar
  la fila de `cobros`, y eso lo decide la dueña.
- **Orden no negociable**: crear los bloqueos → verificar que casan por (org, estilista,
  `starts_at`, `ends_at`) → solo entonces borrar.
- **Verificar disponibilidad con el motor REAL y ANCLANDO `preferencia.fecha`**
  (`calendar-sante.js:178`), día a día antes y después: sin anclar, el motor deja de recorrer
  en cuanto tiene huecos que proponer y un cambio en otra fecha no se ve.

## Dar de baja un servicio: `activo: false`, nunca borrar la fila

Un servicio que el salón deja de hacer **se desactiva, no se borra**. Borrar hace dos cosas
y solo una se quería. La que se quería: el bot deja de ofrecerlo. La que no:
`appointments.service` guarda un NOMBRE, y sin su entrada de catálogo ese nombre deja de
resolver — la cita pasada cae a `unmatched` en `computeServiceBilling`, suma 0 € y aparece
en "sin poder calcular". Dar de baja algo hoy movería la caja de meses cerrados.

De ahí la línea que sostiene todo esto, y que es lo único que hay que recordar:

| | Catálogo |
|---|---|
| se **OFRECE** | `offerableCatalog(cfg.services)` |
| se **RESUELVE** | `cfg.services` COMPLETO, siempre |

`activo` **ausente = activo** (sin backfill; solo el `false` explícito da de baja).
`isServiceActive` / `offerableCatalog` viven en `helpers.js`, al lado de
`isReactiveOnlyService`, que es el mismo patrón para otro motivo.

**El filtro va en el CALL SITE, jamás dentro de un helper.** `extractServiceFromText` es a la
vez un detector (oferta) y el fallback de `computeServiceBilling` (facturación): meterle el
filtro dentro apaga la factura de una cita pasada sin que ningún test de oferta se entere.

Ofrecen (filtrado): el catálogo del prompt (`openai.js`, el 90 % del efecto), el bloque
determinista de `bot.js` (`catalogoOfertable`: cortes, detección libre, K18, categoría por
largo, consulta, recuperación desde `partialData`), la selección que llega del LLM, la
segunda reserva, y `GET /api/service-catalog` por defecto.

Resuelven (completo): `computeServiceBilling`, `stampBillingSnapshot`, `buildFullServiceName`,
`resolveServiceDurationMin` / `resolveAppointmentDurationMin`, y
`GET /api/service-catalog?incluirInactivos=1` — que es el que necesita el formulario de
EDITAR una cita: si un servicio de baja desapareciera de esa lista, abrir una cita antigua
mostraría el campo vacío y guardarla lo borraría.

Tres trampas que ya están resueltas y conviene no reabrir:

- **Las variantes indexadas por posición** (Mechas clásicas, largo de pelo, corrección de
  largo) construyen su lista con el catálogo COMPLETO. Filtrar ahí correría los índices y
  "media cabeza" resolvería a la cobertura de al lado, otro precio y sin síntoma. El
  descarte va después, ya elegida la variante (`servicio_inactivo_no_seleccionado`).
- **`buildFullServiceName` cuenta homónimos**: sobre la lista filtrada, dar de baja a un
  "Hombre" haría que el otro dejara de prefijarse con su categoría. El nombre con el que se
  guarda una cita no puede depender de eso.
- **Las guardas no son ofertas**: el catálogo que reciben `isServiceName` y
  `resolveStylistMention` va completo — dar de baja un servicio no puede convertir su nombre
  en un nombre de persona plausible.

**DEUDA CONOCIDA — el upselling solo está medio cubierto.** Las reglas viven en
`business_info.upselling`, que es una lista aparte: dar de baja un servicio no la toca. Hoy
se descarta la sugerencia cuando su etiqueta RESUELVE contra una entrada de baja
(`upsell_descartado_servicio_inactivo`), y ahí se acaba la cobertura: las etiquetas son
frases de marketing, muchas no resuelven contra ninguna entrada, y de esas no se puede
afirmar que estén de baja. O sea que el bot **puede seguir ofreciendo por upsell un servicio
dado de baja** si su regla está redactada con una frase que no case con el catálogo.

Arreglarlo de verdad es ligar cada regla a su entrada de catálogo (una referencia, no una
frase), y eso es un trabajo aparte: toca el formato de `business_info.upselling`, las 8
reglas actuales y el flujo de aceptación. **Decidido el 05/08/2026 no hacerlo**: no hay
ninguna señal de que haga falta — cero servicios de baja en producción y cero reglas de
upsell apuntando a uno. Se retoma si aparece la señal.

Red: `tests/servicio-desactivado.test.js` (en `npm test`; el primer bloque es la regresión de
facturación) y la **Fase 8** de `verify:sante`, que le exige a cada servicio de baja que siga
resolviendo. No hay UI ni endpoint de edición: `activo:false` se pone a mano sobre el JSONB,
y `PATCH /api/agent-config` sigue reemplazando el array entero — copia antes de tocarlo
(`data/sante-catalogo-backup-*.json`).

## `session.leadId` puede venir vacío — usa `ensureLeadId`

**Nunca leas `session.leadId` a pelo.** Se queda a null en dos situaciones normales: el
primer mensaje de una desconocida (solo se asigna en la rama de sesión NUEVA, y ahí
`findByPhone` aún devuelve null porque la fila la crea `saveMessage` un instante después) y
cualquier sesión rehidratada (no viaja a SQLite, no está en `buildSessionExtra` — mientras
que `bookedSlots` sí).

Todo lo que colgaba de `if (session.leadId)` se saltaba en silencio en esos dos casos. Lo que
costó, medido: el idioma no se escribía (el bot respondía en ruso con la ficha en `'es'`), la
estilista habitual no se guardaba, y el barrido de abandono marcaba `'abandonado'` **sin
llegar a comprobar si había cita** — el incidente del 04/08/2026, tres clientas confirmadas
fuera del recordatorio de 24 h, cuyo arreglo estaba gateado justo por el campo vacío.

`ensureLeadId(orgId, session)` (bot.js) resuelve por teléfono y cachea en la sesión; si ya hay
`leadId` no consulta nada. Lo usan los cinco sitios que lo necesitan: idioma (×2), estilista
preferida/última, reconciliación de cita viva, guarda de cita duplicada, red anti-cita-fantasma
y el barrido de abandono. Trazas: `session_leadid_resuelto` / `session_leadid_backfill`.

**Los defaults de las guardas van hacia el lado recuperable.** La guarda de cita duplicada, si
no puede verificar, asume que la cita **sí** existe y no crea otra: un guardado de menos se
recupera, un duplicado lo ve la clienta. Y no toca `reservaConfirmada` al hacerlo — ponerlo a
true apaga cinco de las seis redes del salón, y ahí no se ha leído nada que lo justifique.

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
| `appointments` (auditoría, 033) | `updated_at` por TRIGGER · `updated_by` (`panel:<uuid>` / `bot` / `worker:*` / NULL = no consta) · `last_change` = solo el último `{at, by, de, a}` |
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

# Bot + API (puerto 3000) — mostrará QR para cada org. ESCRIBE por su cuenta.
node server.js

# Solo la API, para mirar el panel sin tocar producción: sin workers, sin WhatsApp,
# sin Telegram. Es lo que hay que usar para ver una pantalla.
npm run dev

# Dashboard (puerto 3001)
cd dashboard-app && npm run dev

# Producción
pm2 start server.js --name antigravity-bot
```

### Los timers de arranque van con `.unref()` — no los quites

```bash
npm run verify:robustez     # sale solo, con exit code. Nada de script -q ni pkill.
```

Importar `bot.js` registraba cuatro `setInterval` de módulo y el script nunca terminaba
(y redirigido a fichero, cero salida era indistinguible de cero progreso — historia completa:
[`docs/incidentes-cerrados.md#timers-unref`](docs/incidentes-cerrados.md#timers-unref)). Un
timer con `.unref()` dispara EXACTAMENTE igual mientras el proceso siga vivo por otro motivo
(en producción lo mantienen Express y los clientes WA); solo pierde la capacidad de ser él la
razón de seguir vivo. `metrics.js` vacía en `beforeExit` para no perder el último flush.
**Si alguien añade un `setInterval` de módulo, que lo pase por `unrefTimer()` (`bot.js`) o le
ponga `.unref()`: si no, todo esto vuelve.**

Línea base con la que comparar: **OK 84 · GAP 9 · BUG 0**. Los GAP son deficiencias medidas,
no regresiones. `verify:sante` sale **entero en verde** (los 4 fallos que arrastraba eran del
test, no del sistema: 3 horarios copiados de la migración y un plural — ver abajo).

### `verify:robustez:llm` — línea base y cómo leer un DEGRADADO

Llama al LLM de verdad: **no es determinista y su línea base es un rango**. Desde el
09/08/2026 son **23 escenarios**; línea base medida: **OK 23 · todo lo demás 0**. Historia
completa (cómo se reescribieron los checks 3 y 15, qué destapó el 23):
[`docs/incidentes-cerrados.md#verify-robustez-llm`](docs/incidentes-cerrados.md#verify-robustez-llm).

Cómo leerlo:

- **La fila dura es `BUG` · `SILENCIO` · `BUCLE` · `ERROR` = 0**: cualquiera por encima de 0
  es un hallazgo, siempre.
- **Un DEGRADADO suelto que baila de escenario entre corridas es varianza del modelo** —
  antes de tocar nada, repetir. Dos corridas con el MISMO escenario degradado sí se persigue:
  así se cazó balayage
  ([`docs/escenario-3-servicio-sin-resolver.md`](docs/escenario-3-servicio-sin-resolver.md),
  red determinista `tests/balayage-resuelve.test.js`).
- **Una TANDA de degradados con el texto `"Perdona, no he podido procesar tu mensaje"` no es
  una regresión: es el LLM caído o limitando** (es el fallback de bot.js; mide la red, no el
  salón). Mirar si el degradado es siempre la misma frase y esperar.
- **Los checks afirman ESTADO, no redacción**: el 3 exige `session.selectedService` resuelto
  con la categoría **leída del catálogo** (renombrada por la dueña ⇒ no aplicable, no rojo);
  el 15 exige que `session.availableSlots` llegó a tener huecos reales — se mira el MÁXIMO
  visto, porque reservar lo vacía. Excepción a propósito: el check de avería (`problema
  técnico`) mide TEXTO, porque ahí las palabras SON el daño.
- **Esc. 3, ya investigado**: NO es de la familia de la cita fantasma — los tres puntos de
  escritura de cita de Sante y los tres `loadAvailableSlots` están gateados por
  `selectedService`; molesto, no peligroso. (El molde sí está montado: si una guarda se
  relajara, `buildFullServiceName(null)` escribe `service: 'Reserva'`; no hay test que las
  afirme.) SÍ es el mismo callejón que el bucle sin servicio de `4e7743c`, por otra puerta.

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

## El menú de Sante: `/resenas` fuera del menú, y NO es código muerto

**`/resenas` salió del menú pero la página sigue viva** (se llega por URL; un `grep` del menú
la dará por muerta). Es el único sitio donde se ve la cola de reseñas y su botón «Enviar
reseña» la única salida manual — `services/review.js` no avisa cuando falla, así que sin esa
pantalla ese fallo no lo ve nadie. Si algún día se borra de verdad, sustituir antes esa
capacidad, no solo la ruta (motivo en cabecera de su `page.tsx` y en `app-sidebar.tsx`).

**`/lista-negra` también salió y hubo que devolverla el 10/08/2026** (GESTIÓN, bajo Lista
VIP): no se usa a diario, se usa el día que hace falta — y ese día la única forma de llegar
era teclear la URL. Una capacidad de urgencia no puede depender de que alguien recuerde la
ruta. (Resto de la limpieza del 07/08: Caja a GESTIÓN sobre Facturación; `/stripe` borrado —
[`docs/incidentes-cerrados.md#menu-sante`](docs/incidentes-cerrados.md#menu-sante).)

## Bloquear a alguien: qué hace de verdad `is_blacklisted`

La marca la ponen cuatro sitios (`setBlacklist`): el no-show desde el panel, el rechazo de
Bizum, el comando de Telegram, y a mano desde `/lista-negra` o desde la ficha de Clientes.
Lo que hace **no es «el bot deja de contestarle»**, y la diferencia importa:

| | Qué pasa |
|---|---|
| Conversación (salón) | **Silencio.** No se le contesta nada: ni texto, ni fotos, ni audios (`isBlacklistedNow`). Ni siquiera sabe que está bloqueado. |
| Conversación (San Remo) | **Sigue recibiendo** «En breve te atenderá nuestro equipo», y debe seguir. Ver abajo. |
| Ficha | `bot_mode='manual'` + `escalation_reason='lista_negra'` + una fila en `pending_actions`. |
| Telegram | **UN aviso**, no uno por mensaje: `blacklistNotified` viaja en `buildSessionExtra`. Desbloquear desde ahí cuesta dos toques y no le escribe. |
| Monitor / Clientes | **Sigue apareciendo**, y en el Monitor el PRIMERO: ordena delante lo que está en manual con escalada, que es lo que el bloqueo acaba de poner. |
| Campañas · recordatorio · reseña | **No le llega ninguno de los tres.** Filtran en la consulta: `getBroadcastAudience` (incluso con allowlist explícito), `getLeadsPendientesRecordatorio`, `getCompletedAppointmentsForReview`. |
| Citas | **Intactas.** `setBlacklist` solo escribe en `contacts`: lo que tenga sigue en la agenda, sin recordatorio. |

Historia completa (el acosador del 10/08/2026, el `ReferenceError` de `sendDirectMessage`):
[`docs/incidentes-cerrados.md#lista-negra`](docs/incidentes-cerrados.md#lista-negra). Lo que
hay que recordar al tocar esto:

- **Las dos filas de «Conversación» son la misma marca con dos significados.** En el salón
  bloquear es terminal (silencio); en San Remo es una retención a la espera de que un humano
  decida, así que allí «En breve te atenderá nuestro equipo» es verdad y se queda. El mensaje
  sigue al significado, no a la columna.
- **El aviso no se repite, pero se REARMA contra la FICHA**
  (`rearmarSiLaFichaNoLoRefleja`): en lista negra con `bot_mode` distinto de 'manual', ese
  bloqueo no lo ha procesado nadie — sin el rearme, un re-bloqueo sin mensaje en medio no
  pondría ni manual, ni escalada, ni Telegram.
- **Desbloquear son DOS escrituras y el orden importa**: primero `PUT
  /api/leads/:id/bot-mode {mode:'auto'}` (limpia `escalation_reason`, resuelve la
  `pending_action`), después `DELETE /api/lista-negra/:id`. Si falla el 2º el contacto sigue
  BLOQUEADO, que es el lado recuperable; al revés queda un «desbloqueado» al que no le
  contesta nadie (`auto-return` nunca rescata una escalada abierta). Los tres caminos —ficha
  de Clientes, «Quitar» de `/lista-negra`, `ejecutarDesbloqueo` de Telegram— lo hacen en ese
  orden desde el 10/08/2026.
- **Y ninguno le escribe al desbloquear.** En Telegram, `bl_ok` **pregunta** y `bl_do`
  ejecuta; `bl_ok` conserva el nombre A PROPÓSITO, para que un toque en un aviso viejo caiga
  en la confirmación y no desbloquee a la primera.
- Dos formas de bloquear, ninguna atajo de la otra: `/lista-negra` (vista completa) y la
  ficha de Clientes (solo salón, `isSalon`, con confirmación). Ambas por
  `POST`/`DELETE /api/lista-negra/:id`.
- Dos redes a propósito: `tests/blacklist-no-promete.test.js` (la CONDUCTA, hermético) y
  `tests/lista-negra-panel.test.js` (el TEXTO de la confirmación del panel, cada línea
  anclada al código que la hace cierta). Cuando cambie una conducta de la tabla, la segunda
  avisa de que la confirmación se ha vuelto mentira.

## Regla de oro

**San Remo NO se toca.** Cualquier cambio en el código compartido debe mantener el comportamiento exacto de San Remo. El flujo Bizum, party_size, mock calendar — todo sigue igual para `orgType === 'restaurant'`.
