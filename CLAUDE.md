# Agente WhatsApp — Multi-tenant (Antigravity)

## Antes de afirmar nada sobre este sistema

Seis hechos que, si no se saben, no producen un bug: producen un INFORME FALSO. Si algo de lo
que vas a escribir depende de uno de ellos, vuelve aquí primero.

**1. `messages` NO es el registro de lo que pasó.** Las dueñas contestan desde el MÓVIL y ese
saliente no se escribe (Coexistence); las plantillas de campaña tampoco (van a
`broadcast_sends`). **Ausencia de saliente no es ausencia de atención**: es lo que dejó dormido
al vigilante de esperas, cuyos dos casos estrella estaban atendidos.

**2. Un cero no es una ausencia.** Puede ser una lectura rota —una consulta que falla devuelve
vacío, y por eso existe `assertRead`: tres veces esta semana («no hay nadie bloqueado»,
«audiencia vacía», la cola de pendientes)— o una consulta que mide otra cosa:
`appointments.full_name` es **NOT NULL**, así que cuando falta es cadena vacía y un `IS NULL`
no encuentra a nadie. Y al revés, una fila no dice de qué es: los cuatro bloqueos de agenda
hechos como cita («Close TIME») se contaron como citas reales.

**3. «Enviado» no es «entregado».** Fuera de la ventana de 24 h Meta responde **200** y no
entrega. Un recuento de envíos de Sante es un recuento de aceptaciones de Meta, nunca de
mensajes leídos por nadie.

**4. Ningún catálogo del repo es el vivo.** Los tres ficheros de 81 entradas
(`data/sante-catalogo-backup-*.json`, `tests/fixtures/sante-catalog.json`) son fotos de
momentos distintos; el vivo es `agent_configs.services`. Lo mismo el resto de lo que edita la
dueña: horarios, nombres y skills. De ahí salió el 13/08/2026 la conclusión falsa de que el
bot se había inventado el nombre de un servicio.

**5. En `appointments` no hay precio.** Toda cifra de dinero de un informe es un RECÁLCULO
contra el catálogo de hoy; un nombre que no resuelve no suma 0 €, se cuenta aparte. Cambiar el
catálogo mueve las cifras de meses ya cerrados.

**6. Lo comiteado en local no está en producción.** `git push` lo lanza el dueño. Un síntoma
que sigue apareciendo después de un arreglo casi siempre es esto, no un arreglo incompleto.

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

**5. Lo que edita la dueña no se verifica contra constantes en git.** `stylist_schedules`,
`stylists.name`, `stylists.skills`, `agent_configs.services` y `business_hours` cambian desde
el panel; un check contra una lista escrita en el fichero mide antigüedad, no corrección:
caduca en el primer cambio y deja un fallo permanente que no hay que arreglar, que es la
forma más rápida de que nadie vuelva a leer el informe. *Ya pasó tres veces: los horarios de
Tetiana/Natalia/Yulia-Tricóloga, «Consulta con exactamente 4 estilistas», y Olgha→Olga
contándose como fallo del matcher.* Se verifica con invariantes que se sostienen con
cualquier valor — los comandos, en [Comandos de desarrollo](#comandos-de-desarrollo).

**6. Toda migración se enseña ANTES de aplicarla, y a Supabase no se escribe sin permiso
explícito.** Leerla entera es la última oportunidad de ver lo que los tests no ven. *Revisar la
035 antes de aplicarla cazó que `ON DELETE SET NULL` en `cobros.appointment_id` habría hecho
imposible borrar una cita: ese SET NULL emite un UPDATE que choca con el trigger de
congelación. Cuando hay que probar contra la BD real, se hace en un bloque que revierte
(`DO $$ … RAISE $$`) y se comprueba que no queda ni una fila.*

**7. Antes de mutar código para comprobar que algo falla sin el arreglo, `cp` a un fichero
aparte.** `cp fichero /tmp/…` antes de mutar, `cp` de vuelta después, y comprobar que el
arreglo sigue ahí. `git stash push`/`pop` también vale; **`git checkout --` no vale nunca**:
restaura la versión del último commit y borra el trabajo nuevo. *Incumplida dos veces, las dos
el 07/08/2026 y las dos igual: se perdieron `estilistaPorDefecto` y `saldraSinPin` en
`caja-session.ts`, y los tests del no-show en `tests/caja-pendientes.test.js`. Las dos veces se
detectó al mirar si el arreglo seguía ahí, no en el momento.* Texto completo:
[`docs/incidentes-cerrados.md#reglas-recortadas`](docs/incidentes-cerrados.md#reglas-recortadas).

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

**10. TODA respuesta va en UN solo bloque de código, y sin una línea de texto fuera.**
Cualquiera: un plan, un informe, un aviso, una pregunta, dos frases sueltas. Todo dentro
—encabezados y viñetas incluidos— y ni una línea de prosa antes o después; si el contenido
lleva a su vez bloques de código, el de fuera se abre con más backticks (````). *El destino es
el móvil, donde un bloque se copia de un toque.* **Y las TABLAS, que es por donde se colaba**:
la app del móvil renderiza una tabla markdown como elemento APARTE, con su propio botón de
copiar, así que una tabla fuera del bloque rompe la regla igual que un párrafo suelto. Si hace
falta, va DENTRO y en **texto plano alineado con espacios** —nada de `|---|---|`—, y lo mismo
cualquier otra cosa que la app renderice aparte: bloques de código sueltos, citas (`>`),
listas de tareas. **En una frase: si en la pantalla del móvil se ve más de un botón de copiar,
está mal.** Texto completo:
[`docs/incidentes-cerrados.md#reglas-recortadas`](docs/incidentes-cerrados.md#reglas-recortadas).

**11. Hacer lanzar una función obliga a mirar TODOS sus call sites.** Meter un `assertRead` /
`assertWrite` dentro cambia el contrato de quien la llama: donde había un vacío ahora hay una
excepción, y quien no la espera se lleva por delante lo que tenga encima. *`tryResolvePendingReply`
y `ejecutarAccion` (`telegram.js`) cuelgan de un `bot.on(...)` que NO tiene try/catch: una
lectura rota habría tumbado el proceso — el de LAS DOS orgs, que comparten proceso. Y
`setBotActivo` es síncrona y no puede esperar la promesa de `setConfigValue`, así que el
rechazo sale por `unhandledRejection`.* A veces la respuesta correcta es que la función NO
lance y devuelva el fallo; lo que no vale es no mirarlo. Fijado en
`tests/lectura-citas-y-pendientes.test.js`, `tests/lista-negra-no-dice-vacia.test.js` y
`tests/config-escritura-verificada.test.js`.

**12. Una red que SUSTITUYE un mensaje puede comerse el correcto: di cuál ANTES de añadirla.**
Las redes anti-mentira del salón no filtran, reemplazan la respuesta del modelo por una fija.
Antes de añadir una —o de ensanchar la de al lado— hay que escribir qué respuesta BUENA deja
de salir. *Ha salido caro tres veces: el horario de Olga (todo `HH:MM` sin huecos se marcaba
inventado, y el horario del salón SON dos `HH:MM`, así que mataba la única respuesta correcta);
`подойдёт` dentro de `BOOKING_APPROVAL_QUESTIONS`, que exoneraba de más; y «¿te lo reservo?»
de Mariola, que activó la red anti-afirmación sobre una PREGUNTA en 6 de cada 10 turnos.* Dos
consecuencias que ya son doctrina: la exención va donde no se pierde nada (en el `else` sin
hueco, **nunca en el gate**) y se comprueba en los cuatro idiomas. **Una red demasiado ancha no
sobra un mensaje: pierde el bueno.**

## Organizaciones activas

| Org | Tipo | WhatsApp | Canal | UUID |
|---|---|---|---|---|
| Restaurante San Remo | restaurant | +34667474233 | whatsapp-web.js | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| Sante Healthy Hair Salon | salon | +34641029104 | 360dialog (Cloud API) | `b2c3d4e5-f6a7-8901-bcde-f12345678901` |

## Arquitectura

Bot de WhatsApp multi-organización que gestiona citas, reservas y seguimiento post-visita. Cada organización tiene su propio número de WhatsApp, flujo conversacional y panel CRM. Un solo proceso Node.js sirve a todas las orgs simultáneamente.

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
    ├── seguimiento.js     ← Worker: propuesta post-visita con -10% (APAGADO por defecto)
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

## El texto de un hueco va en el idioma de la clienta (`formatSlotTexto`)

Causa 3 de la auditoría del 11/08/2026 (`9253b81`). Hasta entonces `addSlot` fabricaba
`slot.texto` con un `toLocaleDateString('es-ES')` a secas, y Nora Benedikte (10/08, ficha en
inglés y `'observed'`) recibió cinco veces «El jueves, 13 de agosto a las 10:00 con Irina» en
una conversación entera en inglés — justo en el momento en que se decide si se reserva.

Las dos trampas que no hay que reabrir:

- **El texto se fabrica UNA vez, en el origen, y lo recitan DOS caminos**: el prompt del
  modelo —cuya REGLA DÍA DE SEMANA le prohíbe recalcularlo *y traducirlo*— y los mensajes
  deterministas de `bot.js` (`salonOfferSlotsMsg` y la alternativa de «ese día no tengo
  hueco»). Traducirlo en el punto de salida arreglaría uno y dejaría al otro copiando
  castellano. Por eso el idioma viaja como `lang` hasta `getAvailableSlots`
  (`session.language || null`, también en `reloadSlotsForConfirmation`) y el sustantivo
  («hueco» / «availability») lo pone la frase que envuelve, nunca el hueco.
- **La tabla de días es la de `formatReminderWhen`, y no se duplica jamás.**
  `formatSlotTexto` solo añade dos palabras propias: el prefijo de la hora y el conector de
  la estilista. El recordatorio y la oferta de huecos le dicen el día a la MISMA clienta; con
  dos tablas se separarían en el primer retoque y el mismo miércoles saldría de dos formas
  sin que nadie se enterase. Es el motivo por el que `formatReminderWhen` es una función
  (acusativo ruso/ucraniano), heredado entero.

El resto, ya decidido: el nombre de la estilista va TAL CUAL está en la BD (declinarlo, «с
Ириной», sería inventarle grafía a un dato que edita la dueña); idioma nulo o desconocido cae
a castellano con el MISMO criterio que `formatReminderWhen`; y una fecha ilegible devuelve
`null`, con `addSlot` degradando al texto castellano de siempre en vez de dejar el hueco mudo
(regla 3).

Red: `tests/slot-texto-idioma.test.js` — la contención contra `formatReminderWhen` los siete
días × cuatro idiomas, los 28 literales a mano, y `addSlot` de verdad vía `_internals`.
Probado con dos mutaciones: quitarle a `addSlot` la llamada tumba 2 bloques, y darle a
`formatSlotTexto` una tabla de días propia tumba 12 — lo segundo es lo que demuestra que
protege la contención, no el vocabulario.

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

## Seguimiento post-visita: la propuesta que sale semanas después (`services/seguimiento.js`)

Hidratación a las 2-3 semanas de unas mechas, matiz al mes, con un **-10 %** si reserva. Es
lo ÚNICO del sistema que empieza una conversación en vez de continuarla: cuando sale, ya no
queda conversación viva donde corregirse. Por eso nace **apagado** (`SEGUIMIENTOS=on`, off por
defecto, como `VIGILANTE_ESPERAS`) y con un simulacro que enseña la tanda entera antes:
`npm run informe:seguimientos -- sante`, solo lectura.

**La regla se ata al catálogo por `categoria|nombre`, jamás por una frase.** Es la misma clave
que emite `GET /api/service-catalog` y a la que ya se atan los desplegables del panel; el
catálogo no tiene ids y `nombre` a secas no vale ("Corto" existe 4 veces con 4 precios). El
puente de vuelta desde una cita guardada es `categoriasDeServicio` (helpers), y **es la pieza
que hace imposible la búsqueda por texto**: una cita de Balayage se guarda como «Cabello
corto» y una de clásicas como «Mechas 1» — un `includes('balayage')` fallaría en las 4 entradas
de Balayage y en las 3 de clásicas. Es el fallo de `business_info.upselling` (9 etiquetas de
marketing, 7 sin casar con nada), y aquí sería peor: sale solo a un teléfono con un precio
escrito.

**Dos momentos, porque son dos trabajos:**

| | Cuándo | Qué hace | Coste |
|---|---|---|---|
| **A** | 2 h, DENTRO del mensaje de reseña | siembra la oferta y fija el precio | **cero** WhatsApps |
| **B** | día N (worker) | rescata a quien no reservó en A | uno |

A solo se engancha si el envío va por **texto libre**: una plantilla de Meta no admite párrafo
extra, y a las 2 h lo normal es estar FUERA de la ventana de 24 h — por eso A no puede ser el
único camino. `regla_key` lleva sufijo `#resena` para que B siga siendo suyo.

**El orden del worker es RESERVAR → ENVIAR → APUNTAR**, y es toda la protección contra el
único fallo sin vuelta atrás: que la misma clienta reciba el mismo mensaje dos veces. El claim
choca contra el UNIQUE `(org, appointment_origen_id, regla_key)`; el SELECT previo no basta,
dos tics solapados lo pasan los dos.

**Un envío que revienta NO se marca fallido.** Si el error saltó después de que Meta aceptara
el mensaje, marcarlo fallido lo devolvería a la cola. La fila se queda en `'pendiente'` —que
bloquea el reintento— y un vigilante avisa de los claims atascados. Por lo mismo,
`liberarSeguimientosFallidos` **no** libera las `'pendiente'` viejas, al revés que
`resetStaleBroadcastClaims`: allí se arriesga un duplicado para recuperar un envío perdido,
aquí no compensa.

**Las ocho exclusiones** (`decidirSeguimiento`, puro y testeable sin BD). Las tres primeras son
las de `getCompletedAppointmentsForReview`, copiadas a propósito. Las que costaron:

- **`ventana_pasada`** — sin tope, encender el interruptor manda un WhatsApp por cada cita del
  histórico que cumpla la regla. Es la forma que tendría esto de repetir el incidente del
  `horas_recordatorio` a NaN.
- **`bot_apagado`** — excluye aquí y NO en la reseña: un enlace de reseña con el bot apagado
  sigue sirviendo, una pregunta no.
- **`demasiado_reciente`** — protege de la SUMA de las reglas, que ninguna regla ve por sí sola.
- **`ya volvió`**, en sus dos formas: cita futura, o ya se hizo el destino (comparado por clave,
  porque una cita con dos servicios se guarda como "A + B").

**El precio va en EUROS y el porcentaje NO aparece**: «76,50 € en vez de 85 €» se entiende de
un vistazo; «un 10 % de descuento» obliga a echar cuentas, y esas cuentas se rehacen en el
mostrador. Las tres cifras se congelan en la fila (incluida la recalculable): es la cifra que
LEYÓ la clienta, y recalcularla al cobrar reabre la discusión por un redondeo.

**Un destino ambiguo BLOQUEA y se dice, con las opciones y sus precios.** «Hidratación intensa»
resuelve contra tres entradas (45 / 85 / 110 €) y «Matiz» contra dos (40 / 65 €): las reglas
nacen con `destino: null` y no envían hasta que la dueña elija. El preview lo imprime con esas
palabras y cuenta a cuánta gente le llegaría en cuanto se elija — sin esa cuenta, la elección
entre 45 € y 110 € se toma a ciegas.

**Sin `plantilla_seguimiento` aprobada por Meta el camino B no entrega nada** (Meta responde 200
igual). Log `seguimiento_sin_plantilla_configurada` y la reserva se libera para reintentar.

San Remo fuera por `getOrgType`, estructuralmente y no por config vacía. Red:
`tests/seguimiento-{post-visita,a-quien,tanda,worker,en-resena}.test.js`; probado con seis
mutaciones (la del `includes` por frase suelta tumba 5 bloques).

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

## Las redes anti-mentira del salón: qué vigila cada una y qué NO puede comerse

Sustituyen la respuesta del modelo por una fija, así que cada una se define por su EXENCIÓN:
el mensaje CORRECTO que no debe tragarse (regla 12). Las conversaciones que las trajeron, con
su historia entera: [Olga Yarmak](docs/incidentes-cerrados.md#olga-yarmak) ·
[Michal y Esther](docs/incidentes-cerrados.md#michal-y-esther) ·
[«¿te lo reservo?»](docs/incidentes-cerrados.md#te-lo-reservo).

| Red | Vigila | La exención: el mensaje bueno que no puede comerse |
|---|---|---|
| `respondsWithInventedSlots` | `HH:MM` sin huecos cargados | el HORARIO del propio salón (cuatro condiciones) |
| `respondsWithInventedDates` | fechas sin respaldo | (1) la fecha de una cita que YA tiene; (2) negar hueco en UNA fecha |
| `llmClaimsBooked` + `pickChosenSlot` | dar una reserva por hecha | «¿te lo reservo?» es una PREGUNTA |
| `proposesTimingWithoutService` | día/franja/horas con `selectedService` a null | ninguna: ahí no hay mensaje bueno que perder |
| `extractPrecioMencionado` | la cifra que dijo la clienta, sin respaldo | la respuesta que SÍ nombra esa cifra |
| `ensureHandoverAcknowledged` | escalada muda | no sustituye: AÑADE el acuse |

**La exención del horario exige CUATRO cosas** (las tres últimas probadas por mutación):
(1) toda hora es punta del horario o cae fuera de él; (2) **dos** puntas distintas —una hora
suelta es una oferta—; (3) el texto se declara horario (`statesOpeningHours`); (4) no da la
reserva por hecha (`llmClaimsBooked`). `asksForBookingApproval` **no** entra, porque exonera de
más: `подойдёт` está en `BOOKING_APPROVAL_QUESTIONS` y aparece en la respuesta correcta en
ruso. Es la red que mataba «cerramos a las 19:00», que era la única respuesta correcta.

**La exención de «¿te lo reservo?» va en el `else`, NUNCA en el gate.** En el gate se saltaría
la red también cuando SÍ hay hueco identificado («te la apunto el jueves a las 10:00, ¿te va
bien?»), que es justo lo que debe seguir verificándose contra la agenda; en el `else` solo
actúa cuando no hay nada que guardar, así que ninguna reserva cambia. Traza propia:
`cita_sante_oferta_sin_slot`. Las seis afirmaciones reales («te la he reservado», «queda
confirmada», «you are all set», «записала тебя», «запис підтверджено») siguen dando
`asksForBookingApproval` **false** y mantienen la red activa, fila por fila en
`tests/oferta-no-es-afirmacion.test.js`.

**El precio era el único dato duro del salón sin red** hasta el 13/08/2026, y su exención va en
la salida `'atendido'`: si la respuesta nombra esa cifra se deja de vigilar; puesta en el gate,
la red dispararía en el turno siguiente contra la respuesta BUENA. `MONEDA_SUFIJOS` es UNA
lista, compartida por los dos sitios que leen ese número con intenciones opuestas
—`NO_ES_HORA_DETRAS` para descartarlo y `extractPrecioMencionado` para capturarlo—: con dos,
añadir un sufijo a una dejaría ciega a la otra en silencio.

**Antes de las redes hay un gate determinista**: `detectHoraFueraDeHorario` (helpers, puro),
primer consumidor de `agent_configs.business_hours`. Nada de constantes (regla 5), y sin
`business_hours` utilizable **no se dice nada** (regla 3). El mensaje lleva apertura Y cierre;
sin día concreto se usa el **SOBRE** de todos los días (apertura más temprana, cierre más
tardío), no la franja común: solo se declara fuera de horario lo que lo es **todos** los días.

**Lo que leen las redes lo extraen tres funciones, y ahí están las trampas:**

- `extractLooseClockHours` — las horas sin minutos («around 10, 11, or 12») eran invisibles
  para `HORA_HHMM_SRC`, que exige los dos puntos. Exige **marcador temporal delante** (a las /
  around / at / после / в…): **«Largo 2» no son las dos**, «35 €» no son las nueve y
  «August 10» es una fecha. Enumeración con coma **y** conjunción, y la misma regla de 12 h que
  `normalizeHora`.
- `extractMentionedDates` — cuatro idiomas, enumeración con coma **y** conjunción (quedarse en
  la coma pierde el último), en inglés el día detrás del mes, límites de palabra a mano (`\b`
  es ASCII: «mayo» casa dentro de «mayoría»), y un día suelto sin mes se deja fuera.
- `largoKeywords` (`detectLargoCategory`) — los typos van **ENUMERADOS**, jamás un corrector
  difuso, y el criterio de admisión es doble: que lo haya escrito alguien de verdad y **que
  nadie la diga de pasada**. `blonde` a secas queda fuera («I'm blonde and I want a haircut» es
  una descripción) con test de falso positivo; un umbral difuso lo readmitiría sin que ningún
  test de erratas se enterase. Historia:
  [typos](docs/incidentes-cerrados.md#typos-enumerados).

Red: `tests/oferta-no-es-afirmacion.test.js`, `tests/precio-sin-respaldo.test.js` y
`tests/balayage-resuelve.test.js`, los tres probados por mutación.

## Lo que salió de esas conversaciones y no es una red

- **Cancelar no lo ejecuta el modelo.** El `accion` del LLM pasa por `cancelarConConfirmacion`,
  y la guarda vive **dentro de `handleAppointmentAction`** (el salón no cancela por ahí, punto)
  para que un camino nuevo no pueda reabrirlo. San Remo intacto, con test. Los enclíticos de
  `detectCancelRequest` van ENUMERADOS (`-me/-la/-lo`), no con comodín: «cancelada» es
  *nuestro* acuse y «cancelación» pregunta por la política, y los dos tienen test de falso
  positivo.
- **El menú de rescate tiene techo**: al cuarto turno sin servicio se **ofrece** una persona y
  se espera el «sí» (`pendingEscalation` armado a mano, no vía `offersHumanHandover`, que solo
  reconoce el castellano — para una clienta rusa la oferta quedaría colgando).
- **Si se escala, se dice**: `ensureHandoverAcknowledged` **añade** el acuse. La mala
  clasificación del LLM no se persigue: con acuse, una escalada de más deja a una clienta bien
  avisada. Límite conocido: `HANDOVER_TRASPASO`/`DESTINO` son castellano, así que un traspaso
  ya anunciado en ruso recibe acuse redundante (las dos frases ciertas).
- **El trato de usted**: `detectTratamiento` → `session.tratamiento` →
  `contacts.metadata.tratamiento` (jsonb, sin migración) + línea de prompt, viajando en
  `buildSessionExtra`. TRAMPA cubierta: «на вы» es subcadena de «на выходных» (fin de semana),
  así que hace falta el lookahead cirílico. DEUDA deliberada: solo tienen variante formal los
  textos fijos del camino de Olga.
- **Fotos**: no hay **salida** de media (`image`/`video` solo de ENTRADA en
  `threesixty-dialog.js`). Si `business_info.instagram`/`.web` están, el prompt manda pasarlos;
  si no, decir que no se pueden enviar y ofrecer la consulta — prohibido «te las mando en un
  momento». El idioma de una foto va en cascada (sesión → **el texto que espera en el buffer**
  → la ficha solo si es `'observed'`), el turno se anota en `session.history`, y con texto suyo
  en vuelo la foto **no se contesta aparte**.
- **Un dato que el bot no tiene** → caso 7, `motivo_escalado: "dato_no_disponible"`, acotado a
  lo CONCRETO y COMPROBABLE y explícitamente fuera para precios, servicios, horarios y
  disponibilidad.
- **Decidido NO arreglar** (anotado en el propio código): la ventana del buffer
  (`BUFFER_DELAY_MS` 5000 vs mensajes a 7,9 s — es dimensionado, no dedupe); el dedupe de
  sesión muerto en la ruta real (`flushBuffer` pasa `messageKey = null`, y toda la protección
  es `buffer.seenKeys`); y `sinServicioStreak`, que no viaja en `buildSessionExtra`.

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

## Mariola Mira Lopez (12/08/2026): «somos dos» no cabía en ningún sitio, y el precio no lo leía nadie

Pidió cita **«para mí y una amiga»**, lo repitió tres veces, y el bot lo entendió como DOS
SERVICIOS para una sola persona hasta preguntarle «¿cuál queréis primero, el Spa Hair Detox o
la Reconstrucción Pro Miracle?». Preguntó dos veces si una tendría que **esperar fuera** y no
se le contestó ninguna. Las dos citas las acabó creando la dueña a mano —consecutivas, 13:00
y 14:00, la misma estilista—, y la de la amiga quedó guardada **con el nombre de Mariola**.

### «Somos dos»

**El LLM no se confundió: lo dijo dos veces con sus palabras** («podemos agendar para las
dos», «¿es para ti, para tu amiga o para las dos?»). Lo que faltaba era **dónde guardarlo** —
el esquema `datos` del salón no tiene campo para personas, así que la comprensión se evapora
cada turno. Y entonces la **Regla Dura 13** del prompt («el sistema solo puede guardar una
cita por turno… confirma la primera y pregunta los detalles de la segunda por separado»)
convierte dos servicios sobre la mesa en «¿cuál queréis primero?». El modelo obedeció.

La maquinaria de acompañante que ya existía **no llegaba, por dos motivos independientes**:
`detectGuestBooking` no casaba «para mí **Y** una amiga» (se le escapaba por una palabra) y
solo se consulta dentro de `if (session.reservaConfirmada)` — o sea **nunca en el primer
mensaje**. Ese gate es lo que dejó el caso sin ningún camino, y por eso
`detectVariasPersonas` va **sin él** y **antes del LLM**, como `detectHoraFueraDeHorario`.

- **«LAS DOS» ES UNA HORA y no está en la lista en ninguna de sus formas**, ni siquiera «para
  las dos»: en castellano vale igual para dos personas que para las 14:00 y no se puede
  deducir cuál. Mismo criterio que el sujetador en `extractLargoPelo` — en la raya no se
  adivina. Mariola queda cubierta por su primer mensaje, que sí es inequívoco, y **la marca
  es pegajosa**: basta con acertar una vez.
- **No se promete el horario.** El mensaje dice «a la vez o una detrás de otra, eso lo
  confirma el salón», que es lo único afirmable: el motor **ni siquiera puede ver** si hay
  dos estilistas libres a la misma hora — el dedupe por `fecha-hora`
  (`calendar-sante.js:293-306`) las tira sin log.
- `variasPersonas` y `variasPersonasAvisado` viajan en `buildSessionExtra`.

**Lo que NO se hizo, y es decisión, no olvido:** reservar de verdad para dos. Requiere ficha
propia para la amiga, revisar la guarda de `db.js:1266-1284` (que rechaza dos citas del mismo
contacto a la misma hora **y devuelve la primera como si fuera nueva**), y —para el caso
simultáneo— cirugía en el dedupe del motor. Decidido el 13/08/2026 **no** acometerlo: la
única señal es una tanda de dos citas hechas a mano, con una estilista fuera de sus skills.
Misma decisión que la deuda del upselling.

### El precio que dice la clienta

Escribió «El masaje capilar el de 60 euros» y recibió **«el Spa Hair Detox de 60 minutos»** —
su cifra devuelta con **otra unidad**, que es la forma más cara de la regla 3: un dato que no
resolvió, reciclado con otro significado y con pinta de acuerdo. Un turno después, 115 €.
Nunca se le dijo que a 60 € no hay ningún masaje. **Y probablemente ella tenía razón**: a 60 €
está la Reconstrucción Pro Miracle, que es lo que nombró ella sola en el turno siguiente.

Ese número **no lo leía nadie**: la única regla que lo miraba era `NO_ES_HORA_DETRAS`, y solo
para tirarlo. Las diez redes anti-mentira cubrían huecos, fechas, horarios, cierres y
afirmaciones de reserva; **el precio era el único dato duro del salón sin red**. El prompt ya
mandaba lo correcto («NUNCA inventes precios»): era instrucción sin suelo.

- **`MONEDA_SUFIJOS` es UNA lista** y la comparten los dos sitios que miran el mismo texto con
  intenciones opuestas: `NO_ES_HORA_DETRAS` para descartar y `extractPrecioMencionado` para
  capturar. Con dos, añadir un sufijo a una dejaría ciega a la otra en silencio.
- **La exención va en la salida `'atendido'`, no en el gate**: si la respuesta nombra esa
  cifra, se deja de vigilar — si no, la red dispararía en el turno siguiente contra la
  respuesta BUENA, cuando la clienta ya ha elegido el servicio de 115 €.
- **Resolver el servicio de la respuesta es orientativo y no decide solo.**
  `extractServiceFromText` sobre prosa libre acierta a medias («el Detox limpia el cuero
  cabelludo» resuelve contra Exfoliación cabeza, 10 €). El nombre solo se usa si el precio lo
  corrobora; si no, el mensaje habla de la cifra y **se calla el nombre**.
- **`precio != null` ANTES del `Number()`**: `Number(null)` es 0, no NaN, así que un servicio
  con «precio a confirmar en el salón» pasaría por uno de 0 € y la red lo contradiría con una
  cifra inventada. Es el fallo de `precio_facturado` otra vez.

Red: `tests/varias-personas.test.js` y `tests/precio-sin-respaldo.test.js`, cada uno con dos
mutaciones. **El escenario 25 del arnés LLM es un VIGÍA, no una prueba**: medido con la red
apagada, salió igualmente en verde porque el modelo nombró los 60 € él solo esa corrida — el
fallo de Mariola era intermitente. Quien prueba la red es el test determinista.

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

⚠️ **Ese backup sirve para RESTAURAR, nunca para CONSULTAR qué hay en el catálogo**, y no
porque esté mal hecho: `sante-catalogo-backup-2026-08-12.json` es la copia **deliberada
previa a la migración 040**, que renombró los tres Spa Hair. Hace justo lo que debe. Lo que
no tenía era ninguna señal de serlo — **su nombre solo lleva una fecha**, así que quien lo
abría buscando «qué hay en el catálogo» se llevaba el *antes* de un renombrado sin enterarse.
Pasó el 13/08/2026 al diagnosticar la conversación de Mariola: el fichero dice `Detox 60min`
donde `agent_configs.services` dice `Spa Hair Detox`, y de ahí salió la conclusión falsa de
que el bot se había inventado el nombre.

Por eso **los dos backups llevan ahora un `_meta` en la línea 2** (`tomado_el`, `antes_de`,
`antes_de_migracion`, el diff con el estado siguiente, y qué comprobar antes de restaurar).
El array pasa a colgar de `.services`: **se restaura pegando `.services`, no el objeto
entero.** Ese paso de más es deliberado — obliga a abrir el fichero, que es donde está el
aviso.

Y hay un tercero: `tests/fixtures/sante-catalog.json`, que **no es el «antes» de nada** sino
un fichero mantenido a mano que siguió unos cambios y no otros (tiene los nombres nuevos de
Spa Hair, le sobra `Japonesa` y le falta `Difuminado de raíz`). Los tres tienen 81 entradas,
que es lo que hace que parezcan el mismo fichero, y **ninguno de los tres es el vivo**.

La raya, que vale para cualquier fichero de catálogo del repo:

| | Dónde va | Ejemplo |
|---|---|---|
| lo que necesita ser **DETERMINISTA** (mapeos, splits, formatos) | fixture, fijo, en `npm test` | `service-names-parity` (paridad de las dos `splitServiceNames`) |
| lo que afirma algo del **CATÁLOGO REAL** | `verify:sante`, contra `agent_configs` | **Fase 9** (que ningún nombre VIVO rompa el split) |

Los 16 tests que usan el fixture se corrieron el 13/08/2026 **también contra el catálogo
vivo**: los 16 en verde. O sea que ninguno depende de en qué se diferencian — todos están ya
del lado determinista. Lo que faltaba no era repartirlos, era la Fase 9: el fixture está fijo
a propósito, así que un servicio nuevo con `" + "` en el nombre no lo mira nadie, y eso **no
da rojo, da ausencia de cobertura**.

Un check «fixture ≡ backup ≡ vivo» sería la regla 5 al revés: mediría antigüedad y viviría en
rojo, porque un fixture está desfasado **por diseño**. Análisis de qué sí tendría sentido —y
del riesgo real, que es que restaurar un backup viejo deja sin resolver las citas pasadas y
mueve el dinero de meses cerrados— en
[`docs/observaciones-para-proxima-auditoria.md`](docs/observaciones-para-proxima-auditoria.md).

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
SEGUIMIENTOS                  # 'on' enciende la propuesta post-visita. APAGADO por defecto
SEGUIMIENTOS_LIMITE           # Tope de seguimientos por tic y org (default 25)
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
13/08/2026 son **25 escenarios** (los dos nuevos son los de Mariola: dos personas y precio);
línea base medida: **OK 25 · todo lo demás 0**. Historia
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

npm run informe:seguimientos -- sante   # SOLO LECTURA: la tanda post-visita, sin enviarla
```

`informe:seguimientos` es el simulacro obligatorio antes de encender `SEGUIMIENTOS`. Dice qué
reglas pueden enviar y cuáles no —con las opciones del catálogo y su precio, para que la dueña
elija—, y a quién le llegaría con el texto EXACTO. Sale de `construirTanda`, la misma función
que usa el worker: si fueran dos caminos, mirarlo antes no probaría nada. Código 1 solo si hay
reglas configuradas que no pueden enviar.

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
