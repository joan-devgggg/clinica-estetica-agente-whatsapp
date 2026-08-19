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

**7. Borrar un contacto se lleva su conversación entera, en silencio.** `conversations` y
`messages` cuelgan de `contacts` con **`ON DELETE CASCADE`** (también `appointments`,
`pending_actions` y `seguimientos`), y no se emite ningún `DELETE` sobre ellas: no queda rastro
salvo el log HTTP del edge, que caduca en días. Así desapareció la conversación de Olga Yarmak
—30 mensajes, auditados enteros el 09/08— borrada desde el panel el **11/08/2026 a las
06:37:11 UTC**; se detectó cuatro días después, y la ausencia ya se había visto sin preguntarse
por qué. **Una ficha que falta no significa que nunca existiera.** Antes de borrar, exportar
(`npm run exportar:conversacion`); si lo que se quiere es que no le llegue nada, eso es
`is_blacklisted` y es reversible.
[Historia](docs/incidentes-cerrados.md#olga-borrada).

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

**La resolución de proveedor saliente es única**: `services/outbound.js` → `resolveOutboundClient(orgId, fallback)`, que enruta por `getOrgChannel` (registry), no por `SANTE_360_API_KEY`. La usan el panel (`webhook.js` → `getOutboundClient`) y los dos workers.

## El día de la semana se dice en UN solo sitio (`formatReminderWhen`)

Dos mensajes le dicen el día a la MISMA clienta —el recordatorio de 24 h y la oferta de
huecos— y los dos salen de la misma tabla. **Con dos tablas se separarían en el primer retoque
y el mismo miércoles saldría de dos formas sin que nadie se enterase**, así que `formatSlotTexto`
usa la de `formatReminderWhen` y solo añade dos palabras propias: el prefijo de la hora y el
conector de la estilista. Historia de cada uno:
[`recordatorio`](docs/incidentes-cerrados.md#recordatorio-con-fecha) ·
[`huecos`](docs/incidentes-cerrados.md#texto-del-hueco).

**Por qué es una función y no un `toLocaleDateString`:** Intl da el día en NOMINATIVO y detrás
de la preposición el ruso y el ucraniano piden ACUSATIVO («в среду»), y el martes cambia además
la preposición («**во** вторник»). Misma decisión que `MESES_MULTI`. Es TODO el motivo de que
exista, y es lo que hace que duplicar la tabla sea el error caro.

En el recordatorio (`{{2}}`, texto libre, **sin plantilla nueva**):

- La fecha va **DETRÁS** de la hora: el texto fijo aprobado la precede con «a las / at / в / о».
- **Fecha concreta, nunca «mañana»**: `horas_recordatorio` la edita la dueña y un retraso
  convierte «mañana» en mentira.
- **Un solo valor para los dos caminos** (texto libre y plantilla): `resolveCuando` se llama UNA
  vez y alimenta a los dos.
- **Una fecha ilegible NO bloquea el envío** —sale la hora sola— pero avisa: log
  `recordatorio_fecha_no_formateable` + Telegram con el valor crudo, throttle por clave Y VALOR.
  No es motivo de `motivoNoEnviable`, porque no impide el envío. Pasa de verdad:
  `minutosHastaCita` no descarta una `fecha_cita` malformada.
- **San Remo fuera**, gateado por `getOrgType(orgId) === 'salon'`; su recordatorio sigue byte por
  byte igual, con test.

En los huecos (`formatSlotTexto`), donde la trampa es otra:

- **El texto se fabrica UNA vez, en el origen, y lo recitan DOS caminos**: el prompt del modelo
  —cuya REGLA DÍA DE SEMANA le prohíbe recalcularlo *y traducirlo*— y los mensajes deterministas
  de `bot.js`. Traducirlo en el punto de salida arreglaría uno y dejaría al otro copiando
  castellano; por eso el idioma viaja como `lang` hasta `getAvailableSlots`
  (`session.language || null`, también en `reloadSlotsForConfirmation`) y el sustantivo («hueco»
  / «availability») lo pone la frase que envuelve.
- El nombre de la estilista va **TAL CUAL** está en la BD: declinarlo («с Ириной») sería
  inventarle grafía a un dato que edita la dueña. Idioma nulo o desconocido cae a castellano, y
  una fecha ilegible devuelve `null` con `addSlot` degradando al texto castellano de siempre en
  vez de dejar el hueco mudo (regla 3).

Red: `tests/recordatorio-con-fecha.test.js` y `tests/slot-texto-idioma.test.js` — los siete días
× cuatro idiomas uno por uno, y la contención entre las dos probada por mutación: darle a
`formatSlotTexto` una tabla propia tumba 12 bloques.

## Campaña por tandas: el allowlist se recalcula, la exclusión se guarda

Una campaña que va por tandas (`campaignKey` fija, `limit` por tanda) y que deja fuera a un
grupo concreto **guarda la lista de EXCLUIDOS, nunca la de destinatarios**: el allowlist se
recalcula antes de cada tanda restando las exclusiones de la audiencia del momento
(`getBroadcastAudience({audience:'todos'})` menos el set de exclusiones → `phones`). Congelar
los destinatarios parece equivalente y es una **foto** — la audiencia enviable de Sante pasó de
718 a 723 en dos días, y una lista congelada deja fuera para siempre, y en silencio, a toda
clienta creada después. Y el allowlist hay que pasarlo en **todas** las tandas: el dedupe de
`campaignKey` impide repetir destinatarios pero **no recuerda a quién excluiste** (no hay fila
en `broadcast_sends` para quien nunca entró), así que una tanda 2 sin allowlist se lo manda a
los excluidos.

Para excluir NO se usa `is_blacklisted` (significa «clienta bloqueada» y se ve así en el panel)
ni se siembran filas `'sent'` en `broadcast_sends` (escribiría «enviado» sobre mensajes que
nunca salieron, en la tabla de la que sale el reparto por estado). Campaña de verano:
[`docs/campana-verano-tandas.md`](docs/campana-verano-tandas.md) · lista en
`data/campana-verano-exclusiones.json` (**`revisado_por_duena: false`**).

## Seguimiento post-visita: la propuesta que sale semanas después (`services/seguimiento.js`)

Hidratación a las 2-3 semanas de unas mechas, matiz al mes, con un **-10 %** si reserva. Es lo
ÚNICO del sistema que EMPIEZA una conversación en vez de continuarla: cuando sale, ya no queda
conversación viva donde corregirse. Por eso nace **apagado** (`SEGUIMIENTOS=on`, off por
defecto) y con un simulacro obligatorio antes de encenderlo: `npm run informe:seguimientos --
sante`, solo lectura, que sale de `construirTanda` —la misma función que usa el worker— y
enseña la tanda entera con el texto EXACTO. Diseño completo, las ocho exclusiones y los dos
momentos de envío: [`docs/incidentes-cerrados.md#seguimiento`](docs/incidentes-cerrados.md#seguimiento).

Lo que no se puede tocar sin releer aquello:

- **La regla se ata al catálogo por `categoria|nombre`, jamás por una frase.** El puente de
  vuelta desde una cita guardada es `categoriasDeServicio`, y es lo que hace imposible la
  búsqueda por texto: una cita de Balayage se guarda como «Cabello corto», así que un
  `includes('balayage')` fallaría en las 4 entradas de Balayage. Es el fallo de
  `business_info.upselling`, y aquí sería peor: sale solo a un teléfono con un precio escrito.
- **El orden del worker es RESERVAR → ENVIAR → APUNTAR**, y es toda la protección contra el
  único fallo sin vuelta atrás: que la misma clienta reciba el mismo mensaje dos veces. El
  claim choca contra el UNIQUE `(org, appointment_origen_id, regla_key)`; el SELECT previo no
  basta, dos tics solapados lo pasan los dos.
- **Un envío que revienta NO se marca fallido**: si el error saltó después de que Meta aceptara
  el mensaje, marcarlo fallido lo devolvería a la cola. Se queda en `'pendiente'` —que bloquea
  el reintento— y un vigilante avisa de los claims atascados. Por eso
  `liberarSeguimientosFallidos` **no** libera las `'pendiente'` viejas, al revés que
  `resetStaleBroadcastClaims`.
- **`ventana_pasada` es la exclusión que impide un desastre al encender**: sin tope, el
  interruptor manda un WhatsApp por cada cita del histórico que cumpla la regla.
- **Un destino ambiguo BLOQUEA y se dice**, con las opciones y sus precios: «Hidratación
  intensa» resuelve contra tres entradas (45 / 85 / 110 €) y las reglas nacen con
  `destino: null` hasta que la dueña elija.
- **Sin `plantilla_seguimiento` aprobada por Meta el camino B no entrega nada** (Meta responde
  200 igual): log `seguimiento_sin_plantilla_configurada` y la reserva se libera.

San Remo fuera por `getOrgType`, estructuralmente y no por config vacía. Red:
`tests/seguimiento-{post-visita,a-quien,tanda,worker,en-resena}.test.js`, probado con seis
mutaciones (la del `includes` por frase suelta tumba 5 bloques).

## El caso 7 (`dato_no_disponible`): el modelo DECLARA la oferta, la máquina la arma

Escalaba **1 de cada 4 veces**, y la única que escaló lo hizo porque el modelo DESOBEDECIÓ.
La REGLA CRÍTICA del prompt le prohíbe poner `accion:escalar_humano` en el turno de la
PREGUNTA; obedeciéndola no declaraba nada, y entonces armar la espera dependía de que su
prosa libre casara con `detectaOfertaTraspaso`. Medido el 17/08/2026: **la frase que el
propio prompt le sugería para el caso 7 NO casaba** («preguntar» no es verbo de traspaso), ni
«¿te paso con el equipo?» (faltaba `con el equipo` en `HANDOVER_DESTINO`). Roto también en su
forma canónica. Historia: Esther (08/08), Mafe (12/08, la que sí), Gisvell (12/08),
34699866837 (17/08).

- **`ofrezco_traspaso` LLEVA el motivo, no es un booleano.** Dos campos pueden llegar en
  desacuerdo (`true` con motivo null) y entonces hay que inventar un default — el
  `escalado_bot` que ya lamentamos. Conjunto CERRADO (`MOTIVOS_OFRECIBLES`), validado en el
  normalizador **y** en `bot.js`: los dos leen la misma constante, y lo que cuelga del valor
  es una razón que se escribe en la ficha como `consulta_<valor>`.
- **Se lee en DOS puntos porque el texto final no existe al principio**: temprano se marca de
  quién es el turno (y si además viene `accion:escalar_humano`, gana la OFERTA — escalar en
  el turno de la pregunta deja `bot_mode='manual'` y el bot mudo ante el «sí»); tarde, sobre
  el texto ya definitivo, se arma.
- **Si declara y su prosa no ofrece, se le PEGA la pregunta** (4 idiomas, de la misma
  constante que el menú de rescate). Armar sin pegarla deja a la clienta sin nada que
  contestar. Precedente y reglas idénticas al coda de la puerta del nombre.
- **El TRINQUETE del turno N+1**, que era un segundo generador del mismo fallo: la red que
  baja la escalada a espera se guardaba solo de `!pendingEscalation`, así que si la oferta no
  armó nada, el «sí» siguiente —que el gate determinista no intercepta porque no hay espera—
  llegaba al modelo, este escalaba como le manda el prompt, y aquí se le anulaba para armar
  OTRA espera. Texto anunciando el traspaso, cero filas, `bot_mode` en auto. Ahora un
  afirmativo en ese punto ESCALA.
- **El anillo 3 (prosa) no se desmonta**: es lo que salvó a Mafe y lo que hace que el barrido
  y el bot no puedan divergir. Gana la declaración cuando hay ambas.
- **Los motivos viven en UNA lista** (`helpers.MOTIVOS_LLM` / `ESPERAS_ESCALADA` /
  `RAZONES_DE_CODIGO` → `ETIQUETAS_ESCALADA`). Estaban en cinco sitios y de los cinco motivos
  vivos en producción, DOS llegaban al admin como clave cruda. Telegram importa la fuente; el
  panel mantiene copia y la vigila `tests/etiquetas-escalada-paridad.test.js`.

Red: `tests/traspaso-declarado.test.js` (11 bloques, las tres frases reales congeladas, 5
sabotajes medidos) y el corpus (`alisado-organico-17-08.json`, con el turno que lo trajo).

### La medida NO vive en `metrics.json` — vive en Supabase, y corre pegada al barrido

Un umbral con ventana de dos semanas sobre `metrics.json` es **inalcanzable por
construcción**: el disco del contenedor es efímero y, medido sobre el reflog de `origin/main`
(un push = un deploy), en 30 días el hueco MAYOR entre dos pushes fue de **1,88 días** y en 90
días el mayor de todo el registro fue de **7,00**. Nunca ha habido 14 días sin desplegar.

No hace falta contador: **`pending_actions.payload.motivo` lleva el prefijo `consulta_` si y
solo si la escalada pasó por el protocolo de dos turnos**; un motivo pelado es inmediata. Con
eso y el último entrante anterior a la fila sale la clasificación entera, retroactiva y sobre
cualquier ventana. `npm run informe:escaladas -- sante [--desde N]`, y **corre además pegado
al final de `barrido:promesas`** reutilizando sus lecturas — un informe que hay que acordarse
de lanzar no lo lanza nadie. No toca su exit code.

Dos trampas suyas, las dos convertidas en regresión: **`isAffirmative` casa por SUBCADENA** y
sobre un mensaje largo miente («confu-**si**-ón», «повре-**жда**-ются»), así que un afirmativo
solo cuenta si el saliente ANTERIOR era una oferta; y **el coda se cuenta por el salto de
línea** que lo pega, porque las plantillas fijas hacen la misma pregunta en una sola línea.

**Umbral para cablear el 4 y el 5, escrito antes de mirar el número** (días NATURALES): se
cablean si aparecen escaladas de esos motivos precedidas de una oferta ACEPTADA y sin fila
—eso lo mide el barrido con `aceptada_sin_escalada`— con ≥2 en 14 días, o **1 sola en
`ru`/`uk`**, donde no hay backstop. Las inmediatas de `pedir_persona` **no cuentan: ahí lo
correcto es escalar en el acto**. Las de `queja_cita` se vigilan aparte (≥5 en 30 días abre la
conversación, que es de trato y no de código).

## Avisos al admin: solo cuentan si llegan

`alertOnce` (`services/admin-alerts.js`) marca la clave **después** de que Telegram confirme; el
único log que prueba entrega es `telegram_notify_ok`, y sin entrega la clave se libera y el
siguiente tic reintenta (`clearAlert(orgId, clave)` la libera a mano). Los tres vigilantes y
sus umbrales, que es lo que se toca:

- **Canal caído** (`channel-health.js`): 3 fallos consecutivos de PLATAFORMA (401/403, 429, 5xx,
  frame muerto) → aviso; primer envío bueno → «ha vuelto». Los fallos de DESTINATARIO **no
  cuentan** (131047 fuera de ventana, 132000/1 plantilla): una campaña normal acumula decenas.
  Instrumentados los 4 embudos, nunca los call sites, y en `waSendMessage` el reporte va FUERA
  del bucle de reintentos.
- **El modelo no responde** (`llm-health.js`): **cuenta (402/401/403) avisa al PRIMER fallo** —un
  «sin saldo» es cierto desde el primero—; **transitorio (429/5xx/red) espera a 3**. Dos textos
  distintos. NO cuentan un 400 (nuestro payload) ni un JSON mal formado (eso mide la calidad del
  modelo). Solo el intento DEFINITIVO de `getChatbotResponse`.
- **Bot pausado demasiado tiempo** (`bot-pause-alert.js`): cada 10 min, umbral **2 h de horario
  de APERTURA** (`config.horario`) y no de reloj; si abre con el bot ya pausado, avisa al abrir.
  Una org sin `horario` (hoy San Remo) cuenta reloj, y se dice.

Por qué cada umbral es ese, y los incidentes de OpenRouter y 360dialog que los trajeron:
[`docs/incidentes-cerrados.md#avisos-al-admin`](docs/incidentes-cerrados.md#avisos-al-admin).

## El vigilante de esperas está DORMIDO, y no por olvido (`services/espera-alert.js`)

**No lo enciendas.** Escrito el 09/08/2026 y apagado el 10/08 —antes de correr nunca en
producción— porque **mide otra cosa distinta de la que dice medir**: es el hecho 1 de la
cabecera. La regla 1 mide «alguien cerró la fila en el panel» y la regla 2 mide «el bot no
contestó», que no es «nadie contestó»; sus dos casos estrella estaban atendidos.
**Requisito único para encenderlo: que los ECOS registren en `messages` las respuestas del
móvil** — no es calibración, sin ecos no hay umbral que lo arregle. Interruptor
`VIGILANTE_ESPERAS=on`, apagado por defecto, y el código se deja entero a propósito. Umbrales,
diseño y lo que NO avisa (que es la mitad del diseño):
[`docs/incidentes-cerrados.md#vigilante-de-esperas`](docs/incidentes-cerrados.md#vigilante-de-esperas).

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
- **`'observed'` exige DOS mensajes que coincidan, y no lo escribe una centralita.**
  **Capa 1 — `persistirIdiomaObservado` (bot.js)**, paso ÚNICO de los dos detectores: a
  <**30 s** de un `broadcast_sends.sent_at` de ese teléfono no se escribe NADA en la ficha, y la
  fuente es `broadcast_sends` y **no `messages`** (la plantilla de campaña no se escribe en
  `messages`, así que con `messages` la guarda no saltaría nunca). Umbral medido sobre n=3,
  falla hacia el lado bueno; **recalibrar con la tanda 2**. **Capa 2 — corroboración**
  (`updateContactLanguage`): `language` se escribe al primer mensaje y la MARCA espera al
  segundo (`language_candidate`); un `'observed'` no se degrada. Trampa cubierta: en la rama sin
  promoción hay que **congelar la fuente explícitamente**, o `resolveLanguageSource` la deduce
  de la columna ya cambiada y una ficha sin corroborar se lee como observada.
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

## Los idiomas del BOT no son los idiomas del SALÓN (`business_info.idiomas`)

El bot contesta en el idioma de la clienta, sea cual sea, y eso NO se toca: es lo que hace que
una francesa reciba una respuesta en francés. Lo que no puede hacer es dar a entender que en el
salón la atienden en ese idioma. Conversación en francés del 19/08/2026: **«L'équipe du salon
t'aidera»** — cierto lo del equipo, falso lo del idioma.

- **La lista vive en `agent_configs.business_info.idiomas`** y estaba ahí desde el seed
  (`003_sante.sql`, `["español","inglés","ruso","ucraniano"]`) sin un solo lector. Es DATO
  (regla 5): cambia cuando cambia el equipo. **Sin la clave no se inventa la lista** (regla 3):
  se queda la prohibición, que es cierta sin datos, y desaparece la enumeración.
- **NO se deriva de `IDIOMAS_SOPORTADOS` aunque hoy sean las mismas cuatro.** Esa constante
  significa «idiomas en los que la MÁQUINA tiene textos fijos y plantillas de Meta»; ésta,
  «idiomas que hablan las PERSONAS». Que coincidan es la casualidad de la que salió el mensaje
  en francés: con una sola lista, contratar a alguien que hable francés movería la otra cosa.
- **El prompt SOLO no lo arregla, y está medido**: el mismo encargo redactado como regla de
  prosa se colocó en TRES sitios (sección IDIOMA, cola de ESCALADA, cabecera de ESCALADA ya sin
  condición dentro y gateada por la máquina) y las CUATRO corridas del arnés dieron la MISMA
  respuesta byte por byte: «Bien sûr 😊 Tu veux que je te mette en contact avec notre équipe ?».
  El modelo copia el guion literal del caso 4 y no le añade nada.
- **Reparto del caso 7: el modelo DECLARA y TRADUCE, la máquina DECIDE.** Él pone el código ISO
  en `idioma_detectado` (el normalizador lo sigue dejando en null —conjunto cerrado— pero
  conserva la señal en `idioma_fuera_de_lista`, booleano, nunca su cadena) y traduce la frase en
  `frase_idiomas_salon`. La máquina decide si esta conversación lo necesita
  (`session.idiomaSinCodigo`, **pegajosa** como `variasPersonas` porque el campo se omite el
  27 % de los turnos) y si ya se dijo (`idiomasSalonAvisado`). Las dos viajan en
  `buildSessionExtra`.
- **La frase la escribe él porque no hay alternativa**: `HANDOVER_TRASPASO` / `HANDOVER_DESTINO`
  son castellano normalizado y no ven «je te mette en contact avec notre équipe», así que la
  máquina no puede detectar la oferta sola; y no existe ninguna constante en francés que pegar.
  Sale saneada (una línea, tope de 220) y **AÑADE, nunca sustituye** — la respuesta del `else`
  de la regla 12: no se come ningún mensaje bueno.
- **El campo solo se le pide cuando la marca está puesta**, y va TAMBIÉN en el objeto de ejemplo
  del JSON: sin la clave en el ejemplo lo rellenó en 1 de 2 corridas. Consecuencia estructural:
  en una conversación en ruso ese campo NO EXISTE en el prompt, así que la exención deja de
  depender de que el modelo la respete.
- **Las plantillas fijas siguen en cuatro idiomas y una francesa las recibe en CASTELLANO**
  (`buildSanteConfirmationMessage` cae a `'es'`, `contacts.language` se queda en el `'es'` del
  INSERT porque `updateContactLanguage` rechaza lo que no esté en `IDIOMAS_SOPORTADOS`). No
  miente —el castellano SÍ se habla en el salón— pero es un cambio de idioma a media
  conversación. Trabajo aparte, no hecho.

Red: `tests/idiomas-del-salon.test.js` (prompt) y `tests/idiomas-del-salon-coda.test.js`
(maquinaria, 5 sabotajes medidos), más los escenarios 30 y 31 del arnés — el francés y su
CONTROL en ruso, que es el que vigila que no se pegue de más.

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

## La escalera (contrato, punto 4): las redes de AGENDA ya no solo borran

Cuando `respondsWithInventedSlots` o `respondsWithInventedDates` condenan la respuesta del
LLM, esta vuelve al modelo con el veredicto de la máquina y se pide reescritura — **UNA
vez** (3º peldaño); si falla lo que sea (timeout de 15 s propio, error, fallback, la
reescritura sigue violando, cita el veredicto o afirma reserva), se cae al 4º: sustituir
con el mensaje de la causa (huecos reales si los hay). Un falso positivo pasa de costar el
mensaje bueno a costar una llamada. `proposesTimingWithoutService` va directo al 4º a
propósito (`REGEN_POLITICA`): pedir el servicio ya es la respuesta verdadera y esa red no
tiene ni un falso positivo registrado. Lo que hay que saber al tocarla:

- **El veredicto NO es citable, y la garantía no es el prompt**: `VEREDICTO_PIEZAS` redacta
  el texto Y es la lista de marcadores del filtro (una sola fuente); la fuga TRADUCIDA
  (la frase real de Michal en inglés) la para `REGEN_FRASES_MAQUINARIA`, enumerada en 4
  idiomas. Ensanchar esa lista es barato: solo gatea la REESCRITURA, y su falso positivo
  cae al 4º — nunca se come un original.
- **Con texto de la clienta aparcado en el buffer no se regenera** (`pendientes_en_buffer`):
  contestaría a una foto que ella ya dejó atrás. Decidido NO consumir `pendingTexts` en la
  regeneración (regla 8).
- **De la 2ª llamada se usa SOLO `.respuesta`**: acciones y datos del turno ya corrieron
  sobre la primera. Las trazas de detección (`cita_sante_*_bloqueada/o`) no cambian: el
  corpus las afirma por nombre.
- **El número que hay que mirar**: `escaleraSustituida / escaleraIntervencion`
  (`metrics.json`) — el % de derrotas del contrato, que tiene que bajar. Cada intervención
  deja `escalera_intervencion` con la respuesta comida SIEMPRE (`respuestaOriginal`), y el
  4º peldaño deja además su motivo en un contador `escaleraSustituidaPor_<motivo>` (sufijo
  tras `:` recortado): si `escaleraSustituidaPor_pendientes_en_buffer` domina, la escalera
  no está rescatando y lo que hay que mirar es el buffer. **Producción corre en RAILWAY**
  (no PM2): la lectura es `railway ssh "cat metrics.json"` — y el disco del contenedor es
  efímero, así que cada deploy o restart pone los contadores a cero; la ventana de medida
  empieza en el último deploy.
- **Rollback sin deploy**: `ESCALERA_REGENERAR=off` apaga SOLO el peldaño 3.

Red: `tests/escalera-agenda.test.js` (gemelo determinista, 4 sabotajes medidos en su
cabecera; incluye el rescate A/B con el turno real de Ludmila) y la afirmación de
`llmCalls` en los rejugados del corpus de oro — una regeneración sin declarar en un
fixture sale en rojo con el número en pantalla.

## Lo que salió de esas conversaciones y no es una red

Todo con historia completa en [Olga](docs/incidentes-cerrados.md#olga-yarmak) y
[Michal y Esther](docs/incidentes-cerrados.md#michal-y-esther).

- **Cancelar no lo ejecuta el modelo**: el `accion` del LLM pasa por `cancelarConConfirmacion` y
  la guarda vive **dentro de `handleAppointmentAction`** (el salón no cancela por ahí, punto),
  para que un camino nuevo no pueda reabrirlo. Los enclíticos de `detectCancelRequest` van
  ENUMERADOS (`-me/-la/-lo`), nunca con comodín: «cancelada» es *nuestro* acuse y «cancelación»
  pregunta por la política, con test de falso positivo para los dos.
- **El menú de rescate tiene techo**: al cuarto turno sin servicio se **ofrece** una persona y se
  espera el «sí» (`pendingEscalation` armado a mano, no vía `offersHumanHandover`, que solo
  reconoce el castellano).
- **El trato de usted** viaja en `buildSessionExtra` (`detectTratamiento` →
  `session.tratamiento` → `contacts.metadata.tratamiento`). TRAMPA: «на вы» es subcadena de «на
  выходных», hace falta el lookahead cirílico. Solo tienen variante formal los textos fijos del
  camino de Olga, y es deuda deliberada.
- **Fotos**: no hay **salida** de media (`image`/`video` solo de ENTRADA). El idioma va en
  cascada —sesión → **el texto que espera en el buffer** → la ficha solo si es `'observed'`—, el
  turno se anota en `session.history`, y con texto suyo en vuelo la foto **no se contesta
  aparte**. Si `business_info.instagram`/`.web` están, el prompt manda pasarlos; prohibido «te
  las mando en un momento».
- **Un dato que el bot no tiene** → caso 7, `motivo_escalado: "dato_no_disponible"`, acotado a lo
  CONCRETO y COMPROBABLE y explícitamente fuera para precios, servicios, horarios y
  disponibilidad.
- **Decidido NO arreglar**, anotado en el propio código: la ventana del buffer (`BUFFER_DELAY_MS`
  5000 vs mensajes a 7,9 s — es dimensionado, no dedupe); el dedupe de sesión muerto en la ruta
  real (`flushBuffer` pasa `messageKey = null` y toda la protección es `buffer.seenKeys`); y
  `sinServicioStreak`, que no viaja en `buildSessionExtra`.

## La puerta del nombre pide UN dato, pero ya no se come el turno (Ihab, 16/08/2026)

Sin nombre no hay recordatorio de 24 h, así que antes de escribir la cita se pregunta y la
reserva queda retenida en `session.pendingNameForBooking`. Lo que costó: era una puerta de UN
SOLO DATO leída **antes que nada** (`handleNombreParaCita`, antes del LLM y de los detectores),
así que a «Hay cita libre a las 15 h?» le contestó «Perdona, ¿me dices tu nombre?» — y ese turno
**no se procesó en absoluto**. Los dos turnos están congelados en el corpus
(`tests/fixtures/corpus/ihab.json`, 2.1 y 2.2) y conducidos en
`tests/puerta-nombre-no-come-turno.test.js`.

- **El tragado estaba en DOS capas.** La pre-LLM y, en cuanto esa deja pasar el turno, la
  confirmación del LLM: «a las 15 h» da `hora_cita` y casa por `match_hora`, y ese sitio
  sustituye la respuesta entera. Arreglar solo la primera no arregla nada.
- **En esos turnos hablamos NOSOTROS, y no es pereza: es lo único cerrado.** Medido el
  17/08/2026, «te la dejo apartada a las 15:00», «vale, te lo guardo para las 15», «ese hueco es
  tuyo», «I will hold it for you at 3pm» y «Оставлю за тобой 15:00» dan `llmClaimsBooked`
  **false** y no las para ninguna red (la anti-fantasma la GATEA `llmClaimsBooked`; la de huecos
  inventados deja pasar la hora porque sí tiene respaldo). No hay regla textual que garantice
  que una prosa arbitraria no promete un hueco, así que la sustitución sigue siendo TOTAL —
  lo que cambia es que el texto que sustituye ya **contesta**.
- **El acuse va por DEIXIS y con el hueco verificado en ESE turno.** «Ese hueco te lo puedo
  dejar» (4 idiomas), sin hora y sin ✅, y solo si `_huecoVerificadoEsteTurno` — bandera de
  turno puesta donde el motor dice que sigue libre, nunca derivada de `pendingNameForBooking`
  (un hueco retenido hace tres turnos no está comprobado ahora). Con la hora dentro, el mismo
  mensaje saldría unas veces y otras no, según `availableSlots`.
- **La hora RETENIDA no se dice hasta que esté escrita** (`mencionaLoRetenido`): en un turno de
  coda, un texto del modelo que la nombre se descarta. Vigila el DATO y no la redacción, con la
  exención de `soloDeclaraHorarioDelSalon` para no repetir el horario de Olga. Residuo
  declarado: una promesa SIN hora sigue saliendo, y es el hueco preexistente de
  `llmClaimsBooked` — ensancharlo pondría a `resolveSalonConfirmation` a CREAR citas desde la
  prosa, así que es una decisión aparte y está escrita como test.
- **Contabilidad: `pedirNombre` es la única boca y el único contador.** Un turno cuyo único
  contenido es la pregunta gasta intento; una pregunta pegada a una respuesta (el coda), no —
  tope propio de 2, el mismo que el de preguntas. Contando en la puerta, cada disparo de la
  confirmación gastaba tope y **dos preguntas sobre horas escribían la cita sin nombre**.
- **Con nombre y algo más en el mismo mensaje**: no se pide el apellido (es opcional y no le
  gana el turno a una pregunta), y si el residuo CAMBIA la cita —otra hora, otro día, otro
  servicio, cancelar, reagendar, reinicio, «somos dos»— no se escribe nada: manda la petición
  nueva.

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

## «Somos dos» no cabía en ningún sitio (Mariola, 12/08/2026)

Pidió cita **«para mí y una amiga»**, lo repitió tres veces, y el bot lo entendió como DOS
SERVICIOS para una sola persona, hasta preguntarle «¿cuál queréis primero?». Preguntó dos veces
si una tendría que **esperar fuera** y no se le contestó ninguna; las dos citas las acabó
creando la dueña a mano, y la de la amiga quedó guardada con el nombre de Mariola. Historia
completa: [`docs/incidentes-cerrados.md#mariola`](docs/incidentes-cerrados.md#mariola).

- **El LLM no se confundió: no había DÓNDE guardarlo.** El esquema `datos` del salón no tiene
  campo para personas, así que la comprensión se evapora cada turno — y la **Regla Dura 13** del
  prompt («una cita por turno») convierte dos servicios sobre la mesa en «¿cuál queréis
  primero?». El modelo obedeció.
- **El gate era el problema**: `detectGuestBooking` no casaba «para mí **Y** una amiga» y solo se
  consulta dentro de `if (session.reservaConfirmada)`, o sea **nunca en el primer mensaje**. Por
  eso `detectVariasPersonas` va **sin gate** y **antes del LLM**, como `detectHoraFueraDeHorario`.
- **«LAS DOS» ES UNA HORA y no está en la lista en ninguna de sus formas**: en castellano vale
  igual para dos personas que para las 14:00. Mismo criterio que el sujetador de
  `extractLargoPelo` — en la raya no se adivina. La marca es **pegajosa**: basta acertar una vez.
- **No se promete el horario**: «a la vez o una detrás de otra, eso lo confirma el salón» es lo
  único afirmable, porque el motor **ni siquiera puede ver** si hay dos estilistas libres a la
  misma hora — el dedupe por `fecha-hora` (`calendar-sante.js:293-306`) las tira sin log.
  `variasPersonas` y `variasPersonasAvisado` viajan en `buildSessionExtra`.
- **Lo que NO se hizo, y es decisión**: reservar de verdad para dos (ficha propia para la amiga,
  la guarda de `db.js:1266-1284` —que rechaza dos citas del mismo contacto a la misma hora **y
  devuelve la primera como si fuera nueva**— y cirugía en el dedupe del motor). Decidido el
  13/08/2026 **no** acometerlo por falta de señal, como la deuda del upselling.

El otro síntoma de esa conversación —«el masaje capilar el de 60 euros» contestado con «el Spa
Hair Detox de 60 minutos», su cifra devuelta con otra unidad— es el que trajo la red de precio,
arriba. Red: `tests/varias-personas.test.js` y `tests/precio-sin-respaldo.test.js`, cada uno con
dos mutaciones. **El escenario 25 del arnés LLM es un VIGÍA, no una prueba**: medido con la red
apagada salió igualmente en verde porque el modelo nombró los 60 € él solo esa corrida — el
fallo era intermitente, y quien prueba la red es el test determinista.

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
| lo que el **BOT propone** | `botOfferableCatalog(cfg.services)` |
| lo que **OFRECE el panel** | `offerableCatalog(cfg.services)` |
| lo que se **RESUELVE** | `cfg.services` COMPLETO, siempre |

`activo` **ausente = activo** (sin backfill; solo el `false` explícito da de baja).
`isServiceActive` / `offerableCatalog` viven en `helpers.js`, al lado de
`isReactiveOnlyService`, que es el mismo patrón para otro motivo.

**Las dos primeras filas se separaron el 19/08/2026** y no son un matiz: `solo_complemento:
true` marca un servicio que NUNCA se vende suelto —«Peinado con tratamientos», 15 €/15 min,
porque no se puede peinar sin lavar y la clienta llega con la cabeza lavada del
tratamiento—. El bot no puede proponerlo (no está en su prompt ni en los detectores, y ahí
está la garantía: la prosa no basta, es la lección de la Consulta de valoración) pero la
dueña **sí** tiene que poder añadirlo a mano desde el panel a una cita de tratamiento, o la
caja no cuadra. Por eso `GET /api/service-catalog` se queda en `offerableCatalog`.

**La marca vive en la ENTRADA, no en un `Set` de categorías en el código.** La categoría la
edita la dueña sobre el JSONB: un `Set` contra su nombre deja de casar el día que la
renombre y el servicio se vuelve ofertable **en silencio** (regla 5). Es la fragilidad que
`REACTIVE_ONLY_CATEGORIES` sí tiene hoy con «Consulta», anotada y no arreglada.
`solo_complemento` **ausente = servicio normal**, igual que `activo`.

Dos cosas medidas que no hay que redescubrir al tocar esto:

- **La sonda que llega al complemento es el PLURAL suelto**, no «un peinado» (que da null
  con filtro y sin él). La contención veta los tokens que son identidad de otra categoría,
  y la categoría es «Tratamiento **Orgánico**» —singular—, así que `tratamientos` no queda
  vetado y la pasada 2 lo resuelve. Y una vez elegido **se queda**: el bloque de detección
  libre está gateado por `if (!session.selectedService)`, así que ningún turno posterior lo
  deshace.
- **El arnés no puede medir esto inyectando la entrada**: `bot.js` desestructura
  `require('./services/db')` en su línea 10, así que parchear `db.getAgentConfig` después de
  requerir el bot se lo enseña al arnés y no al sistema. La prueba es
  `tests/complemento-no-se-elige.test.js` (3 rojos al quitar el filtro); el escenario 32 del
  arnés es un VIGÍA sobre la conversación real.

**El filtro va en el CALL SITE, jamás dentro de un helper.** `extractServiceFromText` es a la
vez un detector (oferta) y el resolutor de las etiquetas de upselling al persistir y al
estimar duración (`resolveAcceptedUpsellName` / `resolveServiceDurationMin`): meterle el
filtro dentro apaga esas resoluciones sin que ningún test de oferta se entere. (La
facturación ya no es el consumidor difuso: `computeServiceBilling` casa EXACTO desde
`f187270` — un nombre que no existe da `unmatched`, no el parecido más cercano.)

**Ofrecen** (filtrado): el catálogo del prompt (`openai.js`, el 90 % del efecto), el bloque
determinista de `bot.js` (`catalogoOfertable`: cortes, detección libre, K18, categoría por
largo, consulta y recuperación desde `partialData`), la selección que llega del LLM, la segunda
reserva y `GET /api/service-catalog` por defecto. **Resuelven** (completo):
`computeServiceBilling`, `stampBillingSnapshot`, `buildFullServiceName`,
`resolveServiceDurationMin` / `resolveAppointmentDurationMin` y
`GET /api/service-catalog?incluirInactivos=1` — este último es el que necesita el formulario de
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

**DEUDA CONOCIDA — el upselling solo está medio cubierto.** Sus reglas viven en
`business_info.upselling`, que es una lista aparte de frases de marketing: hoy se descarta la
sugerencia cuando su etiqueta RESUELVE contra una entrada de baja
(`upsell_descartado_servicio_inactivo`) y ahí acaba la cobertura, así que el bot **puede seguir
ofreciendo por upsell un servicio dado de baja** si la regla está redactada con una frase que no
case con el catálogo. **Decidido el 05/08/2026 no arreglarlo** por falta de señal (cero
servicios de baja en producción, cero reglas apuntando a uno); qué costaría hacerlo, en
[`docs/incidentes-cerrados.md#deuda-upselling`](docs/incidentes-cerrados.md#deuda-upselling).

Red: `tests/servicio-desactivado.test.js` (en `npm test`; el primer bloque es la regresión de
facturación) y la **Fase 8** de `verify:sante`, que le exige a cada servicio de baja que siga
resolviendo. No hay UI ni endpoint de edición: `activo:false` se pone a mano sobre el JSONB, y
`PATCH /api/agent-config` sigue reemplazando el array entero — copia antes de tocarlo
(`data/sante-catalogo-backup-*.json`).

⚠️ **Esos backups sirven para RESTAURAR, nunca para CONSULTAR qué hay en el catálogo**, y hay
tres ficheros de 81 entradas que se parecen entre sí sin ser lo mismo (dos backups y el fixture
de tests). Es el hecho 4 de la cabecera, y lo que hay que saber al usarlos: llevan un `_meta`
en la línea 2 que dice de qué son el «antes», y **se restauran pegando `.services`, no el
objeto entero** — ese paso de más obliga a abrir el fichero, que es donde está el aviso. La
raya que los ordena —lo DETERMINISTA (mapeos, splits) va a fixture fijo en `npm test`; lo que
afirma algo del CATÁLOGO REAL va a `verify:sante`, contra `agent_configs`, que es la **Fase
9**— y la conclusión falsa que salió de saltársela, en
[`docs/incidentes-cerrados.md#tres-catalogos`](docs/incidentes-cerrados.md#tres-catalogos).

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

## Los dos flujos, en una línea cada paso

**San Remo (restaurante)**: pregunta nombre, personas y preferencia horaria → el mock calendar
genera slots → el cliente acepta → Bizum → Alberto confirma o rechaza por Telegram →
recordatorio 24 h antes.

**Sante (salón)**: detecta idioma (ES/EN/RU/UK) y pregunta nombre → servicio por fuzzy match
contra el catálogo → upselling según reglas → estilista preferida (si es recurrente, sugiere su
habitual) → `calendar-sante.js` calcula disponibilidad real
(`stylist_schedules - appointments - schedule_blocks`) → propone huecos con estilista → la
clienta confirma y
la cita se guarda sin Bizum → recordatorio 24 h → reseña de Google 2 h después.

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

### Estilistas de Sante

Índice de nombres y UUIDs, nada más. **Los horarios NO están aquí**: los edita la dueña y la
única fuente fiable es `stylist_schedules` (hecho 4 de la cabecera). Esta tabla llegó a tener
una columna de días del seed que a 04/08/2026 era falsa en 6 de las 8 filas — copiarla a un
test es lo que dejó `verify:sante` tres semanas en rojo, y por eso ya no está.

| Nombre | Rol | UUID |
|---|---|---|
| Veronika | colorista/estilista | c3d4...0101 |
| Irina | colorista/estilista | c3d4...0102 |
| Yulia | colorista/estilista + diagnóstico | c3d4...0103 |
| Olga (antes «Olgha») | manicura/pedicura | c3d4...0104 |
| Larisa | masajes/spa | c3d4...0105 |
| Tetiana | extensiones (agenda manual, nunca elegible) | c3d4...0106 |
| Natalia | colorista/estilista | c3d4...0107 |
| Yulia-Tricóloga | tricóloga (dueña) | c3d4...0108 |

## Variables de entorno

La lista completa, con sus valores de ejemplo, está en `.env.example` — con una salvedad:
**ahí pone `OPENAI_API_KEY` y el código lee `OPENROUTER_API_KEY`** (`services/providers/openai.js:13`),
así que ese fichero está desfasado justo en la clave del modelo. Las variables que **cambian la
conducta del sistema**, y por eso se miran antes de diagnosticar nada:

```bash
OPENROUTER_API_KEY  # sin ella el bot contesta siempre su fallback; avisa llm-health
SANTE_CHANNEL     # escape hatch: 'wwebjs' devuelve Sante a whatsapp-web.js (el canal por
                  # defecto lo dice el registry, NUNCA la presencia de SANTE_360_API_KEY)
SEGUIMIENTOS      # 'on' enciende la propuesta post-visita. APAGADO por defecto
SEGUIMIENTOS_LIMITE  # tope por tic y org (default 25)
VIGILANTE_ESPERAS # 'on' enciende el vigilante de esperas. NO lo enciendas (ver su sección)
ESCALERA_REGENERAR # 'off' apaga SOLO el peldaño 3 de la escalera (todo cae al 4º con
                   # causa). Encendido por defecto — es el rollback sin deploy
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

### `npm test` se autoriza por el EXIT CODE o por el MARCADOR, nunca por «no veo fallos»

`npm test; echo $?` y punto. Los fallos salen por **stderr** (82 ficheros imprimen `fail - …`
con `console.error`, **ninguno** por stdout), así que una corrida que muere a la mitad deja un
log donde todo dice `ok -`. Y un pipe se traga el código: `npm test 2>&1 | tail` devuelve 0.
Ya hizo autorizar un push sobre un árbol rojo (15/08/2026):
[historia](docs/incidentes-cerrados.md#npm-test-falso-verde).

Desde entonces la cadena termina en `scripts/suite-completa.js`, que imprime por **stdout**:

```
SUITE COMPLETA · 137 ficheros · 3 fuera a propósito (ver scripts/suite-completa.js)
```

**Si esa línea no está, la corrida no terminó** — sirve incluso mirando solo stdout, que es
por donde se coló el verde falso. El número lo CALCULA de la propia cadena: nunca hay que
tocarlo al añadir un test.

**Cómo se comprueba que un test nuevo está en la cadena: `npm run test:cobertura`.** Sale en
rojo si hay algún `tests/*.test.js` que no corre nadie (y también si la cadena nombra un
fichero que ya no existe). No depende de que nadie se acuerde: es el último eslabón de
`npm test`, así que un test escrito y no enchufado tumba la suite con su nombre en pantalla.
Un fichero puede quedarse fuera, pero entonces se declara con su motivo en `FUERA_A_PROPOSITO`
(`scripts/suite-completa.js`) — hoy hay **3**, los tres en rojo por el TEST y no por el
sistema. *Fuera y declarado es una decisión; fuera y en silencio es cómo `oferta-traspaso`
—el gemelo del anillo 1— pasó semanas sin correr mientras el test viejo que lo contradecía
seguía en la cadena en rojo.*

### Los timers de arranque van con `.unref()` — no los quites

```bash
npm run verify:robustez     # sale solo, con exit code. Nada de script -q ni pkill.
```

Importar `bot.js` registraba cuatro `setInterval` de módulo y el script no terminaba nunca. Un
timer con `.unref()` dispara EXACTAMENTE igual mientras el proceso siga vivo por otro motivo
(en producción lo mantienen Express y los clientes WA); solo pierde la capacidad de ser él la
razón de seguir vivo, y `metrics.js` vacía en `beforeExit` para no perder el último flush.
**Si alguien añade un `setInterval` de módulo, que lo pase por `unrefTimer()` (`bot.js`) o le
ponga `.unref()`: si no, todo esto vuelve** —
[historia](docs/incidentes-cerrados.md#timers-unref).

**Y no son solo los `setInterval`**: el 15/08/2026 se les unieron dos `setTimeout` de dentro
del turno que retenían el proceso hasta vencer — el **perdedor del `Promise.race` del LLM**
(45 s, vivo aunque gane el modelo) y la **limpieza del buffer** (60 s). No se nota en
producción, pero hacía que cualquier test que condujera un turno real pagase la espera entera,
y eran varios: `oferta-traspaso` 63 s → 3 s, `blacklist-aviso-entrega` 60 s → 0 s,
`idioma-ucraniano-y-ficha` 60 s → 0 s. **La suite entera bajó de 224 s a 60 s.** **El timer que
AGRUPA (`BUFFER_DELAY_MS`) sigue SIN unref a propósito**, y hay un test que lo vigila: ese
tiene que disparar aunque no quede nada más vivo, porque dentro hay mensajes de una clienta
sin contestar. Red: `tests/timers-unref-conducta.test.js`, que afirma la agrupación por
CONDUCTA (tres mensajes → un turno, ventana que se reinicia con cada uno, y un CONTROL de que
no agrupa de más).

Línea base con la que comparar: **OK 84 · GAP 9 · BUG 0**. Los GAP son deficiencias medidas,
no regresiones. `verify:sante` sale **entero en verde** (los 4 fallos que arrastraba eran del
test, no del sistema: 3 horarios copiados de la migración y un plural — ver abajo).

### `verify:robustez:llm` — línea base y cómo leer un DEGRADADO

Llama al LLM de verdad: **no es determinista y su línea base es un rango**. Desde el 19/08/2026
son **32 escenarios** (26–28: precio presencial, «Keratina», objeto olvidado; 29: el anillo C7
de punta a punta; 30–31: el francés y su CONTROL en ruso, los idiomas del salón; 32: que un
servicio `solo_complemento` no sea nunca el elegido); línea base medida el 19/08: **OK 32 ·
todo lo demás 0**, y sin un solo reintento. La del 15/08 fue OK 29
con un degradado transitorio del modelo en el 21 absorbido por el reintento automático del
arnés, que es su trabajo.

- **La fila dura es `BUG` · `SILENCIO` · `BUCLE` · `ERROR` = 0**: cualquiera por encima de 0 es
  un hallazgo, siempre.
- **Un DEGRADADO suelto que baila de escenario entre corridas es varianza del modelo** — antes
  de tocar nada, repetir. Dos corridas con el MISMO escenario degradado sí se persigue: así se
  cazó balayage.
- **Una TANDA de degradados con el texto `"Perdona, no he podido procesar tu mensaje"` no es
  una regresión: es el LLM caído o limitando** (es el fallback de bot.js; mide la red, no el
  salón).
- **Los checks afirman ESTADO, no redacción** (`session.selectedService` resuelto,
  `session.availableSlots` con huecos reales), con una excepción a propósito: el de avería mide
  TEXTO, porque ahí las palabras SON el daño.

Cómo se reescribieron los checks 3 y 15, qué destapó el 23 y el análisis del escenario 3 —que
NO es de la familia de la cita fantasma—:
[`docs/incidentes-cerrados.md#verify-robustez-llm`](docs/incidentes-cerrados.md#verify-robustez-llm)
y [`docs/incidentes-cerrados.md#informes-lectura`](docs/incidentes-cerrados.md#informes-lectura).

### Los invariantes de lo que edita la dueña (regla 5)

```bash
npm run verify:sante          # catálogo + motor de huecos + Fase 7 (coherencia de horarios)
npm run verify:sante:agenda   # SOLO LECTURA: ¿las citas futuras siguen cabiendo?
npm run informe:nombres       # SOLO LECTURA: ¿a quién no sabemos cómo llamar?  (-- sante)
npm run informe:seguimientos -- sante   # SOLO LECTURA: la tanda post-visita, sin enviarla
npm run informe:escaladas -- sante      # SOLO LECTURA: ¿qué escaladas preguntaron antes?
                                        # (corre TAMBIÉN al final de barrido:promesas)
```

- **`verify:sante:agenda`** es la red que faltaba: cuando la dueña quita un día o recorta una
  franja, las citas ya reservadas en ese hueco no se mueven ni avisan. Día laborable, franja
  (con `ends_at` incluido), `schedule_blocks`, skill por segmento y solapes. La lógica pura
  vive en `tests/lib/agenda-audit.js` y sí corre en `npm test`.
- **`informe:nombres`** cruza las **dos** columnas del nombre, que fallan distinto:
  `contacts.full_name` es NULLABLE y bloquea el recordatorio de 24 h; `appointments.full_name`
  es NOT NULL y cuando falta es cadena vacía (hecho 2 de la cabecera). No escribe nada:
  rellenar un nombre lo decide una persona, porque el bot saludará con él.
- **`informe:seguimientos`** es el simulacro obligatorio antes de encender `SEGUIMIENTOS`.

Ninguno de los cuatro compara contra listas escritas en git; todos afirman invariantes que se
sostienen con cualquier valor. Detalle de qué significa cada código de salida:
[`docs/incidentes-cerrados.md#informes-lectura`](docs/incidentes-cerrados.md#informes-lectura).

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
- Las **dos** formas de bloquear (`/lista-negra` y la ficha de Clientes) y las **dos** redes
  que lo protegen —la conducta y el TEXTO de la confirmación del panel— están en el archivo:
  la segunda es la que avisa de que la confirmación se ha vuelto mentira cuando cambia una
  conducta de la tabla.

## Regla de oro

**San Remo NO se toca.** Cualquier cambio en el código compartido debe mantener el comportamiento exacto de San Remo. El flujo Bizum, party_size, mock calendar — todo sigue igual para `orgType === 'restaurant'`.
