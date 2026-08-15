# Incidentes cerrados — texto completo movido desde CLAUDE.md

Movido VERBATIM el 12/08/2026 para que CLAUDE.md baje del umbral de arranque. Cada sección
de abajo es el texto ÍNTEGRO que estaba en CLAUDE.md; allí queda una versión compacta con
las trampas e invariantes, enlazando aquí. Este fichero NO se lee al arrancar: se abre
cuando hace falta la historia entera de un incidente.

## El `{{2}}` del recordatorio dice la hora Y la fecha (`formatReminderWhen`) {#recordatorio-con-fecha}

El recordatorio decía solo la hora y la clienta no sabía de qué día le hablaban. La fecha entra
por el hueco que ya había —`{{2}}` es texto libre, o sea **sin plantilla nueva**— y va DETRÁS
de la hora, porque el texto fijo aprobado la precede con «a las / at / в / о»:

| | `{{2}}` | cómo queda |
|---|---|---|
| es | `12:00 del miércoles 12 de agosto` | …tu cita en Sante **a las 12:00 del miércoles 12 de agosto**. |
| en | `12:00 on Wednesday 12 August` | …your appointment at Sante **at 12:00 on Wednesday 12 August**. |
| ru | `12:00 в среду, 12 августа` | …о вашей записи в Sante **в 12:00 в среду, 12 августа**. |
| uk | `12:00 у середу, 12 серпня` | …про ваш запис у Sante **о 12:00 у середу, 12 серпня**. |

**El día de la semana va en tabla a mano, y ese es todo el motivo de que esto sea una función
y no un `toLocaleDateString`.** Intl devuelve el día en NOMINATIVO (`среда`, `середа`) y detrás
de la preposición el ruso y el ucraniano piden ACUSATIVO: `в среду`, `у середу`. Concatenar lo
que da Intl escribe «в 12:00 в среда», que está mal, y el martes cambia además la preposición
(«**во** вторник»). Es la misma decisión que la tabla genitiva de `MESES_MULTI`. De paso
desaparecen los otros dos sitios donde se rompía: a Intl solo se le pide el día y el mes, así
que ya no hay coma de es-ES que quitar («miércoles, 12 de agosto») ni mayúscula que corregir.

**Fecha concreta, nunca «mañana».** Hoy el recordatorio sale 24 h antes y las dos coincidirían
casi siempre, pero `horas_recordatorio` la edita la dueña y un envío que se retrase convierte
«mañana» en mentira. Una fecha no envejece mal.

**Un solo valor para los dos caminos.** Texto libre (dentro de la ventana de 24 h) y plantilla
(fuera) son código distinto: `resolveCuando` se llama UNA vez y alimenta a los dos. Tocar solo
uno es cómo dos clientas con la misma cita reciben mensajes distintos sin que nadie lo vea.

**San Remo queda fuera**, gateado por `getOrgType(orgId) === 'salon'` (no por UUID, para que un
salón futuro lo herede). No lo ha pedido su dueño y su recordatorio sigue byte por byte igual,
con test que lo fija.

**Una fecha que no se entiende NO bloquea el envío, pero tampoco pasa en silencio.** Sale la
hora sola —el mensaje de siempre—, y además del log (`recordatorio_fecha_no_formateable`) sale
un Telegram. Por eso **no** es un motivo de `motivoNoEnviable`: ahí caen las cosas que impiden
el envío, y esta no lo impide; cambiar un mensaje incompleto por ninguno sería peor. El aviso
dice que el mensaje YA salió —reenviarlo a mano sería un duplicado— y enseña el valor crudo,
porque una `fecha_cita` ilegible no es solo un recordatorio más pobre: esa cita también está
mal en la agenda. Throttle por clave Y VALOR, como `avisarVentanaInvalida`: el worker tica cada
5 min dentro de una ventana de 24 h (~288 mensajes sin él), y una fecha corregida que sigue mal
tiene que volver a avisar. Nunca se inventa un día. Pasa de verdad, porque `minutosHastaCita`
no descarta una `fecha_cita` malformada (`NaN > minutos` es false).

Red: `tests/recordatorio-con-fecha.test.js` — los siete días en los cuatro idiomas uno por uno,
que es donde va a fallar si falla. Las cinco protecciones están probadas por mutación.

## Avisos al admin: solo cuentan si llegan {#avisos-al-admin}

`alertOnce` (`services/admin-alerts.js`) marca la clave **después** de que Telegram confirme,
no antes. Hasta el 05/08/2026 la marcaba primero y `notifyOrgAdmin` ni siquiera se esperaba:
un proceso sin bot, una org sin admins o un rechazo daban exactamente el mismo resultado que
un envío correcto —`admin_alert_enviado` en el log y cero reintentos—. El único log que
prueba entrega es `telegram_notify_ok`. Si no hay entrega, la clave se libera y el siguiente
tic reintenta. `clearAlert(orgId, clave)` la libera a mano (lo usan los dos avisos de abajo
al recuperarse).

**Canal caído** (`channel-health.js`): 3 fallos consecutivos de PLATAFORMA en una org (401/403,
429, 5xx, frame de puppeteer muerto) → aviso; el primer envío bueno después → "ha vuelto" y
clave liberada. Los fallos de DESTINATARIO no cuentan (131047 fuera de ventana, 132000/1
plantilla): una campaña normal acumula decenas seguidos y el aviso saltaría en cada envío
masivo. Instrumentados los 4 embudos de envío —`waSendMessage`, reminder, review, broadcast—,
nunca los call sites; en `waSendMessage` el reporte va FUERA del bucle de reintentos (cuatro
intentos son un envío, no cuatro). Nace de los bloqueos de 360dialog del 1-2/08/2026: entraba
tráfico, no salía nada, y cada fallo moría en su propio `catch` sin que nadie sumara.

**El modelo no responde** (`llm-health.js`): el 05/08/2026 se acabó el saldo de OpenRouter,
cada llamada devolvía 402 y el bot devolvía su fallback —"Perdona, no he podido procesar tu
mensaje"— a todas las clientas. Siguió contestando con educación sin entender nada: sin coger
citas, sin mirar huecos. Nadie se enteró hasta mirar un log a mano. Mismo agujero que el canal
caído, un piso más abajo: allí no SALÍA nada, aquí sale algo que no significa nada.

El umbral depende del tipo, y esa es la parte que importa: **cuenta (402/401/403) avisa al
PRIMER fallo**, porque un "sin saldo" es cierto desde el primer intento y esperar a tres solo
garantiza que tres clientas se lleven el fallback; **transitorio (429/5xx/red) espera a 3**,
porque ahí un tropiezo aislado sí existe. Y son dos textos distintos: mandar recargar saldo por
una caída de diez minutos del proveedor sería la peor instrucción posible.

NO cuentan un 400 (es nuestro payload) ni un JSON mal formado (el proveedor contestó; eso mide
la calidad del modelo, que es otra cosa y con otro umbral). Instrumentado el embudo
(`getChatbotResponse`) y solo en el intento DEFINITIVO — los reintentos son una conversación,
no varias. `summarizeHistory` se queda fuera a propósito: no recibe orgId y un resumen fallido
no le llega a ninguna clienta.

**Bot pausado demasiado tiempo** (`bot-pause-alert.js`): además del aviso reactivo al tirar un
mensaje, un vigilante cada 10 min mira el ESTADO. Umbral: **2 h de horario de apertura**
(`config.horario`), no de reloj — con el reloj corriendo de noche, una pausa inocua a las
23:00 mandaría un Telegram a la 1:00. Si el salón abre con el bot ya pausado de antes, avisa
al abrir sin esperar. "Pausado desde" = `config.updated_at` de `bot_activo`, sin columna
nueva. Una org sin `horario` (hoy San Remo) cuenta reloj, y se dice: no se le inventa jornada.

## El vigilante de esperas está DORMIDO, y no por olvido (`services/espera-alert.js`) {#vigilante-de-esperas}

**No lo enciendas.** Escrito el 09/08/2026 y apagado el 10/08 —antes de correr nunca en
producción— porque **mide otra cosa distinta de la que dice medir**.

Lo que pasa de verdad cuando el bot escala: la dueña recibe su Telegram, entra al WhatsApp
**desde el móvil** y contesta. Ese circuito funciona. Lo que no hace nadie nunca es entrar al
panel a cerrar la fila de `pending_actions`, porque no hace falta para atender a nadie. Así
que el vigilante no mide atención: mide **si alguien cerró la `pending_action` en el panel**, y
cada aviso suyo sería sobre una clienta ya atendida. La regla 2 tiene el mismo agujero por otra
puerta: una respuesta enviada desde el móvil no se escribe en `messages`, así que lo que mide
es «el bot no contestó», que no es «nadie contestó».

Lo destapó la propia auditoría al revés: leyó a Olga Yarmak (3 días) y a 34656332064 (33 h)
como abandonadas, y a las dos les había contestado la dueña desde el móvil. Los dos primeros
Telegrams del vigilante habrían sido falsos, y sobre sus dos casos estrella.

**Requisito único para encenderlo: que los ECOS registren en `messages` las respuestas
enviadas desde el móvil.** Con eso la regla 2 se sostiene sola; la regla 1 necesita además que
la escalada se cierre con el eco y no a mano en el panel. No es calibración: sin ecos no hay
umbral que lo arregle. Interruptor: `VIGILANTE_ESPERAS=on`, apagado **por defecto** para que
un despliegue sin la variable no lo resucite.

El código se deja entero a propósito —umbrales medidos, textos, lecturas con `assertRead`—
para no reescribirlo el día que los ecos entren. Lo de abajo sigue siendo cierto, y conviene
no perderlo:

**El umbral es 60 minutos de APERTURA, y de dónde sale es lo único que hay que recordar.** De
213 entrantes, 199 se contestaron en menos de 20 s (p50 9,6 · p95 13,1 · p99 16,0 · máx 18) y
los otros 14 no se contestaron nunca o tardaron horas. Entre 18 s y 236 min **no hay nada**:
no es una cola larga, son dos poblaciones a cuatro órdenes de magnitud. O sea que la
distribución **no elige el número** — cualquier valor entre 1 y ~200 min da 0 falsos positivos
y caza los 14. Lo elige la jornada, que es un dato editable (`config.horario`, hoy 9 h): con
120 min, toda espera que empiece después de las 17:00 se va al día siguiente; con 60, solo la
de después de las 18:00. Olga escaló un viernes a las 17:42 con 78 minutos de jornada por
delante. **Un solo umbral para las dos reglas**: son la misma pregunta por dos puertas.

Se mide en horario de atención por lo mismo que `bot-pause-alert` (un Telegram de madrugada es
cómo se silencian los avisos), y quien escribió de noche o en domingo no espera otra hora: se
avisa al abrir (`vieneDeAntesDeAbrir`, el mismo predicado con nombre sin sujeto).

**Lo que NO avisa es la mitad del diseño:** con el bot pausado para la org calla —ahí *todas*
se quedan sin responder y `bot-pause-alert` ya lo dice mejor y una vez—; una clienta con
escalada abierta recibe UN aviso y no dos; lista negra, porque ese silencio es deliberado; y
más allá de **7 días** no hay nadie esperando sino una conversación muerta (el mismo número
con el que `auto-return` la da por terminada — sin él, el primer arranque desentierra meses).

El texto se escribe para actuar **sin abrir el panel**: quién, desde cuándo en hora de pared,
cuánto lleva en tiempo de salón abierto, qué dijo, y un enlace `wa.me`. Los motivos se dicen
en español corriente y uno desconocido se enseña crudo, porque inventarle traducción es peor.

Las dos lecturas van con `assertRead` y **no** reutilizan `getPendingActions`, que se traga el
`error` de Supabase: una lectura fallida se leería como "no hay ninguna escalada pendiente".
Un vigilante ciego es peor que ninguno, porque además tranquiliza. (`getPendingActions` sigue
igual: es de otro camino.)

## El idioma de una clienta (`contacts.language`) — historia completa {#idioma}

Decide en qué idioma le habla el bot, y **qué plantilla de Meta recibe en una campaña**. Se
escribe en tres sitios y solo tres: el INSERT de `saveLead` (default `'es'`),
`updateContactLanguage` (observado en conversación) y `updateLeadById` (corregido a mano
desde la ficha del panel). `IDIOMAS_SOPORTADOS` (`helpers.js`) es la lista única; un valor
fuera de ella se rechaza — se usaría como clave contra `config.plantilla_*` y la campaña
omitiría a esa clienta con un `sin_plantilla` que nadie relacionaría con la causa.

**El campo mezcla tres calidades. Cuál es cada una lo dice `metadata.language_source`**
(`'observed' | 'inferred' | 'default'`), que `rowToPublic` expone como `language_source`. A
05/08/2026, de 721 contactos de Sante: 3 observados, 184 inferidos por nombre y 534 en el
default que nadie tocó. **La columna `language` no cambia nunca por esto** — las plantillas
de campaña salen igual; lo único que cambia es de qué se puede uno fiar. Segmentar con
`metadata->>'language_source'`, no a ojo.

Lo escriben los mismos tres sitios que escriben el idioma: `saveLead` (`'default'`, salvo que
la clienta ya haya escrito en ese turno), `updateContactLanguage` (`'observed'`, y apaga la
marca de inferido) y `updateLeadById` (`'observed'`: lo ha elegido una persona). El backfill
de lo anterior es `034_language_source.sql`, y sus reglas son las mismas que aplica
`resolveLanguageSource` (`helpers.js`) a una fila sin marca — si se separan, el backfill
queda como una foto que la lógica desmiente en la primera fila nueva.

**`'observed'` exige DOS mensajes que coincidan, y no lo escribe una centralita.** Las dos
reglas nacen del mismo incidente (07/08/2026, tanda 1 de la campaña de verano): tres
autocontestadores de otros negocios —números de empresa dados de alta como fichas de clienta—
contestaron a la campaña en 7-10 s, y el bot les leyó el idioma y lo marcó `'observed'`. Dos
fichas acabaron en el idioma equivocado a partir del texto de una centralita ajena.

- **Capa 1 — `persistirIdiomaObservado` (bot.js).** Paso ÚNICO por el que escriben los dos
  detectores (el determinista y el `idioma_detectado` del LLM); dejar la guarda en uno solo no
  protegería nada, porque el modelo lee igual de bien a una centralita. Si el mensaje llega a
  menos de **30 s** de un `broadcast_sends.sent_at` de ese teléfono, no se escribe **nada** en
  la ficha: el turno usa el idioma, la ficha no se entera. La fuente es `broadcast_sends` y
  **no `messages`** — la plantilla de campaña no se escribe en `messages`, así que «tiempo
  desde nuestro último saliente» daría null y la guarda no saltaría nunca.
  Umbral medido, no supuesto: centralitas **7,1 · 8,1 · 10,0 s**, personas **126 · 132 · 459 s**.
  Es una hipótesis sobre n=3 y falla hacia el lado bueno (una clienta rápida conserva su idioma
  un mensaje más). **Recalibrar con la tanda 2.**
- **Capa 2 — corroboración (`updateContactLanguage`).** `language` se sigue escribiendo al
  primer mensaje; lo que espera es la MARCA. Hasta que un segundo mensaje coincide, la ficha
  conserva su fuente y guarda `language_candidate`. Una ficha que ya era `'observed'` no se
  degrada al cambiar de idioma. Un mensaje es prueba débil aunque no haya bots de por medio:
  el autocontestador de DarYsol Events era **bilingüe** (es+uk en el mismo texto) y
  `detectLanguage` tuvo que elegir uno.
  Trampa cubierta: en la rama sin promoción hay que **congelar la fuente explícitamente** si la
  ficha no la tenía. Si no, `resolveLanguageSource` la deduce de la columna ya cambiada por su
  última regla («idioma distinto de `'es'` ⇒ observed») y una ficha sin corroborar se lee como
  observada — justo lo contrario.

**DEUDA — la única señal DIRECTA la estamos tirando en el webhook.** El envelope de Cloud API
trae `value.contacts[].profile.name`, que para una cuenta de empresa es el nombre comercial
(«DarYsol Events» frente a la ficha «Dasha Kotenko»). `process360Webhook`
(`services/providers/threesixty-dialog.js`) solo lee `value.messages` y `value.metadata`: nunca
mira `value.contacts`, así que ese nombre llega y se descarta. Todo lo de arriba son
inferencias por tiempo; esto sería el dato. Pendiente a 07/08/2026 — aplazado por no caber con
garantías antes de la tanda 2, no por falta de valor.

**Un default NO se le pasa al LLM como idioma.** `bot.js` siembra `session.language` con el de
la ficha solo si su fuente no es `'default'`; si lo es, deja null y el prompt entra por su rama
de «aún no se conoce el idioma» (traza `idioma_ficha_por_defecto_ignorado`). Un `'inferred'` sí
se pasa, pero anunciado como PROBABLE. Lo que costó no distinguirlo: 19542240982 (+1, EEUU)
escribió «Thursday», su ficha llevaba el `'es'` del INSERT, el prompt se lo anunció como
«último idioma detectado» y el bot la saludó en castellano — a ella y a la foto que mandó
36 s después, que coge el idioma de la misma `session.language`.

**Los días de la semana están en las dos listas de `detectLanguage`.** Un día suelto es de las
respuestas más frecuentes que hay (se pregunta «¿qué día te viene bien?») y antes devolvía
`null`: la lista inglesa tenía `tomorrow`/`today` pero ningún día. Van los siete en inglés y
en español, sin solape entre ambas — si un día activara las dos listas, `detectLanguage`
devolvería `null` y no habría arreglado nada.

**Ucraniano.** `detectLanguage` marca `'uk'` por letras exclusivas (`і ї є ґ`) y, si no las
hay, por una lista corta de frases que no existen en ruso (`dyakuyu`, `budʹ laska`, `dobryi
denʹ`…). Esa segunda regla existe porque la primera es asimétrica: sin esas letras caía en
`'ru'`, y el saludo y el gracias no las llevan — «Доброго дня» quedó marcado ruso. Los
patrones cirílicos van SIEMPRE por `buildCyrillicRe` y se prueban contra `normalizeText`:
sin eso no casan nunca (NFD descompone й/ё/ї, y `\b` es ASCII).

## La conversación de Olga Yarmak (07/08/2026): cinco síntomas, cuatro causas {#olga-yarmak}

Respuesta a la tanda 1 de la campaña de verano, teléfono `34674987146` (**no**
`34667967943`, que es el autocontestador de la videógrafa). Cinco fallos en 17 minutos, y
tres de ellos eran **el mismo bug**.

### La raíz común: la red anti-invención se comía el horario del propio salón

`respondsWithInventedSlots` marcaba como hueco inventado **cualquier `HH:MM`** cuando
`availableSlots` estaba vacío. El horario del salón *son* dos `HH:MM`, así que
«cerramos a las 19:00» se bloqueaba y se sustituía por el menú genérico: **la única
respuesta correcta a "solo puedo después de las 23:00" era exactamente la que la red
mataba**. El LLM sí sabía el horario (`business_info.horario` va en el prompt); no es que
no lo supiera, es que no lo podía decir.

La clase de fallo ya estaba anotada para la función hermana (`unbackedBookingClaim`), donde
el coste se acepta —«un mensaje honesto de más»—. Aquí el coste era otro y no se vio: no
sobra un mensaje, se **pierde** el bueno.

La exención exige **cuatro** cosas, y las tres últimas están probadas por mutación (sin
ellas los tests seguían en verde, o sea que no protegían nada):

1. toda hora es punta del horario **o cae fuera de él** — la respuesta correcta REPITE la
   hora imposible que pidió la clienta, y una hora fuera del horario no es reservable;
2. **dos** puntas distintas: un horario tiene principio y fin; una hora suelta es una oferta;
3. el texto se declara horario (`statesOpeningHours`);
4. no da la reserva por hecha (`llmClaimsBooked`) — sin esto «te apunto a las 19:00» pasaría.

`asksForBookingApproval` **no** entra: (2) y (3) son más estrictas, y ella tenía un falso
positivo real — «Мы работаем с 11:00 до 15:00. Какое время тебе подойдёт?» es la respuesta
correcta en ruso y `подойдёт` está en `BOOKING_APPROVAL_QUESTIONS`.

### Hora fuera de horario: el gate

`detectHoraFueraDeHorario` (helpers, puro) + gate determinista **antes del LLM**. Es el
primer consumidor de `agent_configs.business_hours` — hasta ahora esa columna solo se
escribía. Nada de constantes: un 19:00 en el código mediría antigüedad (regla 5), y sin
`business_hours` utilizable **no se dice nada** en vez de inventar horario (regla 3).

**El mensaje lleva apertura Y cierre.** «A las 23:00 ya hemos cerrado» sin decir hasta
cuándo abren obliga a preguntar otra vez, que es el turno que el arreglo existe para ahorrar.

Sin día concreto se usa el **SOBRE** de todos los días (apertura más temprana, cierre más
tardío), no la franja común: con la común, un sábado que cerrase antes marcaría como
imposible una hora que de lunes a viernes sí vale. Solo se declara fuera de horario lo que
lo es **todos** los días.

### El menú de rescate tenía suelo, no techo

`streak >= 2` devolvía el MISMO párrafo indefinidamente. Olga lo recibió tres veces palabra
por palabra, una de ellas contestando a «¿me puedes mandar una foto?». Ahora al cuarto turno
sin servicio se **ofrece** una persona y se espera el «sí» (`pendingEscalation`, la
maquinaria que ya existía), porque los casos 1-6 del prompt no escalan sin confirmación.
`pendingEscalation` se arma a mano y no vía `offersHumanHandover`, que solo reconoce el
castellano: para una clienta rusa la oferta se habría quedado colgando.

### Las fechas también se inventan, y no las miraba nadie

Ludmila Zarahovich (03/08/2026) pidió el 28 de agosto, el bot le ofreció «el 27, 29 o 30» y
luego negó los tres, uno por turno. Una persona le creó a mano la cita del 28 —el día que
pidió— con el servicio de más ticket del periodo. **Las tres redes de horas quedan exoneradas**:
no hubo ni una `HH:MM` en toda la conversación y `respondsWithInventedSlots` sale en su primera
línea con `mentioned.length === 0`. El agujero era de unidad, no de cobertura: se vigilaban las
horas y nadie las fechas, cuando una cita son las dos cosas.

`respondsWithInventedDates` tiene la misma forma que su gemela (basta con que UNA fecha
mencionada tenga respaldo) y **dos exenciones, que son la parte que importa** — la lección de
Olga es que una red demasiado ancha se come el único mensaje correcto:

1. la fecha de una cita que la clienta YA tiene no sale de `availableSlots` y es legítima;
2. declarar que no hay hueco en **UNA** fecha es correcto, no es una oferta. El límite de una
   es lo que separa la negación honesta del mensaje de Ludmila, que negaba una y ofrecía tres.

`extractMentionedDates` lee **todas** las fechas y en los cuatro idiomas (el bot responde en el
de ella). La enumeración lleva coma **y** conjunción —«27, 29 o 30»— y quedarse en la coma
pierde el último, la misma trampa de `extractLooseClockHours`; en inglés el día va detrás del
mes; los límites de palabra van a mano porque `\b` es ASCII y sin eso «mayo» casa dentro de
«mayoría»; y un día suelto sin mes se deja fuera, que choca con elegir hueco por número.

### Cancelar no lo ejecuta el modelo

Celeste González (06/08/2026) reservó a las 11:03:59 y a las 11:04:51 escribió «No entiendo» y
«Cancélala», confundida por el bloque de promoción del mensaje de confirmación. **El bot se la
canceló 60 s después de crearla, sin preguntar** (`last_change.by = 'bot'`). Siete minutos
después seguía queriendo el servicio.

La guarda existía y no falló: el camino determinista recita la cita y espera un sí desde el
04/08. Lo que había eran **dos caminos para la misma acción y solo uno con guarda** — el
`accion` del modelo se descartaba con `salon && !session.appointmentId`, o sea únicamente
cuando no había nada que cancelar. Ahora el `accion` pasa por `cancelarConConfirmacion`, y la
guarda vive **dentro de `handleAppointmentAction`** (el salón no cancela por ahí, punto) para
que un camino nuevo dentro de seis meses no pueda reabrirlo. San Remo intacto, con test.

Y el hallazgo lateral que lo hizo posible: `detectCancelRequest` **no reconocía «Cancélala»**.
Su lista tenía el enclítico `-me` pero no `-la/-lo`, así que el turno no lo cogió la capa
determinista. Los sufijos van enumerados y no con comodín porque «cancelada» es *nuestro* acuse
y «cancelación» es preguntar por la política — los dos tienen test de falso positivo, igual que
«cáncer» y «canela».

### Si se escala, se dice

La red de escalada solo existía en un sentido (`announcesHumanHandover`: lo promete y no lo
hace). A las 15:42:10 el LLM escaló de verdad —`pending_actions`, `bot_mode` manual,
Telegram— y el texto que le llegó a ella fue «Прости, я реально запуталась 😅 Объясни мне ещё
раз…», pidiéndole que se explicara otra vez justo cuando el bot acababa de dejar de hablarle.
44 s después escribió «me niego a hablar con un robot» y recibió **silencio**: correcto con
`bot_mode` en manual, e indistinguible de que la ignorasen.

`ensureHandoverAcknowledged` **añade** el acuse, no sustituye. La mala clasificación del LLM
(el disparador fue «o no me entienden o se están riendo», que no es pedir una persona) **no
se persigue**: con el acuse, una escalada de más deja a una clienta bien avisada.

**Límite conocido**: `HANDOVER_TRASPASO`/`DESTINO` son castellano, así que un traspaso ya
anunciado en ruso no se reconoce y el acuse se añade igual — una frase redundante, las dos
ciertas. Ampliarlos a cuatro idiomas cambiaría también a quién auto-escala la red del 28/07.

### El trato de usted

Pidió «Тогда давай на вы 🧐», el bot aceptó y volvió a tutearla al turno siguiente: el trato
no existía como dato en ninguna parte. Ahora `detectTratamiento` → `session.tratamiento` →
`contacts.metadata.tratamiento` (jsonb, sin migración) + una línea de prompt. Viaja en
`buildSessionExtra`: sin eso se pierde en cada rehidratación, la lección de `session.leadId`.

**TRAMPA, ya cubierta**: «на вы» es subcadena literal de «на выходных» ("el fin de semana") y
«на ви» de «на вихідних». Sin el lookahead cirílico —`\b` es ASCII y no sirve—, proponer día
(«давай на выходных») cambiaba el registro de toda la conversación.

**DEUDA — la cobertura de los textos fijos es PARCIAL y deliberada.** Solo tienen variante
formal los del camino que recorrió Olga: pregunta de servicio, menú de rescate, fuera de
horario, oferta de persona y acuse de escalada. **El resto de literales del salón siguen
tuteando**, así que una clienta que pida el usted lo recibirá del LLM (el 90 % de lo que sale)
y no de un mensaje determinista que le toque. Convertirlos todos son cuatro idiomas por dos
registros; se hace cuando haya señal de que molesta.

### Fotos

No hay **salida** de media: en `threesixty-dialog.js` los tipos `image`/`video` son solo de
ENTRADA. `business_info.instagram` / `.web` son datos editables; si están, el prompt manda
pasarlos, y si no, manda decir que no se pueden enviar y ofrecer la consulta — con
prohibición explícita de «te las mando en un momento». Enviar imágenes de verdad sigue sin
implementarse.

## Michal Gradziel y Esther Cediloo: seis síntomas, cuatro causas {#michal-y-esther}

Dos conversaciones del 07 y 08/08/2026, arregladas el 09/08. Michal
(`447432204269`) pidió una decoloración completa **en inglés**; Esther
(`19723581589`) quería nombrar a dos personas en una reseña de Google.

**La factura, que es lo que ordena todo lo demás:** la conversación de Michal muere a las
11:10:26 y a las 11:19:26 aparece una cita `Deco Total Blond Corto + Retocar mujer` (Natalia,
lunes 10 a las 09:00) **sin un solo mensaje saliente entre medias**. El bot no la cerró: la
cerró una persona desde el panel. El servicio de más ticket del catálogo, perdido entero.

### La cascada: el detector solo hablaba castellano, y el prompt empujaba hacia delante

`largoKeywords` tenía para Deco Total Blond `['total blond','decoloracion','decolorar','deco']`.
Ella escribió «near platinum», «full platinum blonde», «colouring my hair from dark to cool
platinum»: nada casó. Para una clienta anglófona el servicio solo aterrizaba si el LLM
rellenaba `datos.servicio` con un nombre del catálogo **en castellano** — el escenario 3 con la
moneda cargada en contra. Ahora las keywords van en los cuatro idiomas, con un criterio de
admisión: **que nadie la diga de pasada**. `blonde` a secas se queda fuera («I'm blonde and I
want a haircut» es una descripción) y tiene test de falso positivo.

Y encima, **el prompt le decía que siguiera**. `__servicioMencionado` (`bot.js`) se monta
justo cuando el match falló pero el LLM capturó prosa, y su rama le ordenaba «mapéalo al
catálogo … **y continúa el flujo**», dando por hecho que puede mapearlo. Cuando no puede,
cumple la segunda mitad igual: preguntó el día, preguntó la franja e inventó tres horas, todo
con `selectedService` a null.

Las guardas de CÓDIGO estaban bien y ninguna falló: `loadAvailableSlots` y
`askDatePreferenceFirst` exigen las dos `selectedService`. **Lo que no existía era una guarda
sobre lo que el modelo DICE**: `proposesTimingWithoutService`, que sustituye por
`salonNoSlotsMsg`. Es la recomendación 2 de `docs/escenario-3-servicio-sin-resolver.md`.

### La red de horas era ciega a las horas sin minutos

«around 10, 11, or 12», sin un hueco cargado, **no lo vio ninguna de las tres redes**:
`HORA_HHMM_SRC` exige los dos puntos y los dos dígitos, y `respondsWithInventedSlots` salía en
su primera línea con `mentioned.length === 0`. **La exención de horario del 07/08 queda
exonerada**: se evalúa una línea después y nunca llegó a ejecutarse.

El agujero era anterior y estaba en los tres sitios — incluido `detectHoraFueraDeHorario`, el
gate escrito el 07/08 para Olga, que tampoco veía «solo puedo después de las 23» sin los
`:00`. Y el patrón se declaraba «ÚNICO» mientras `bot.js` lo tenía copiado a mano dos veces
sin importar la constante.

`extractLooseClockHours` **exige marcador temporal delante** (a las / around / at / после /
в …): un número a secas no es una hora. **«Largo 2» no son las dos**, «35 €» no son las nueve
y «August 10» es una fecha. Dos trampas cubiertas: la enumeración lleva coma **y** conjunción
entre las dos últimas («10, 11, or 12» se cortaba en el 11), y se aplica la misma regla de 12h
que `normalizeHora` — que en `bot.js` se conserva encima, porque es quien convierte «5:30» en
17:30 y hace que case con un hueco real de la tarde.

### Las fotos: dos motores ciegos entre sí

La rama de media hace `return` **antes** del buffer. A las 11:04:54.939 salió el aviso fijo, y
a las 11:05:02.443 el LLM contestó a su texto con «Your hair looks beautiful». Tres cosas
distintas, las tres arregladas:

- **El idioma.** Leía solo `userSessions` (RAM), y en el PRIMER mensaje de una conversación no
  hay sesión: se crea en `processMessageCore`, que corre 5 s después. Ese camino no podía
  acertar nunca, ni con la ficha en `'en'` y `'observed'`. Cascada nueva: sesión → **el texto
  que espera en el buffer** (evidencia directa del mismo turno, y es lo que la salva) → la
  ficha solo si es `'observed'`. Un `'default'` o un `'inferred'` no deciden en qué idioma le
  hablamos. Es la familia de Tammy por una puerta peor.
- **El historial.** El placeholder `[image]` va a `messages` —o sea, al PANEL— y la respuesta
  fija sale por `sendWithDelay`; **ninguna de las dos toca `session.history`**, que es lo que
  lee el prompt. Para el modelo la foto no existía y nuestro aviso tampoco. Ahora el turno se
  anota y lo drena `processMessageCore` justo después del texto de la clienta.
- **La doble respuesta.** Si ya hay texto suyo en vuelo, la foto **no se contesta aparte**.
  Una foto sola sí, y tiene su test.

### Si le preguntan un dato que no tiene, ahora lo ofrece preguntar dentro

Esther quería nombrar a dos personas en una reseña; el bot sabía una y de la otra contestó «I'm
not sure I have that information», pidiéndole a ella el dato que le faltaba a él. **No hay
arreglo de datos posible**: sus dos citas del 08/08 están las dos a nombre de Natalia y la
segunda persona no está registrada en ningún sitio. Solo lo sabe alguien del salón.

Para Sante **no existía el concepto de «pregunta sin respuesta»**, y el prompt lo prohibía
(«NUNCA escales por ningún otro motivo») mientras el de San Remo lleva la instrucción contraria
desde siempre. Caso 7 nuevo, `motivo_escalado: "dato_no_disponible"`, acotado a lo CONCRETO y
COMPROBABLE y explícitamente fuera para precios, servicios, horarios y disponibilidad.
Escenario 23 de `verify:robustez:llm`, que afirma el ESTADO y no la redacción.

### Lo que se decidió NO arreglar

- **La ventana del buffer** (la otra mitad del «responde dos veces»). Los dos mensajes de
  Esther van a **7,9 s** y `BUFFER_DELAY_MS` es **5000**, mientras el LLM tardó entre 8,2 y
  12,2 s: lo que entre en ese hueco se contesta por separado. No es el dedupe, es el
  dimensionado. Reencolar el turno cuesta llamadas al modelo y cambia el diseño.
- **El dedupe de sesión está muerto en la ruta real**: `flushBuffer` pasa `messageKey = null`,
  así que `session.seenMessages` no se rellena y su guarda no puede saltar. Toda la protección
  es `buffer.seenKeys`, que se vacía en cada flush. Latente, no fue causa de nada aquí.
- **`sinServicioStreak` no viaja en `buildSessionExtra`**: se resetea en cada rehidratación, y
  el nivel «ofrecer una persona» (`>= 4`) es inalcanzable si la conversación cruza un timeout.

Las tres están anotadas en el propio código, donde mirará quien las toque.

## Bloquear agenda: `schedule_blocks`, nunca una cita con clienta inventada {#bloquear-agenda}

Un hueco que se cierra **es un `schedule_blocks`**. Hacerlo como cita a nombre de un contacto
falso resta disponibilidad igual —el motor concatena citas y bloqueos en un único array
`occupied` y los trata idénticos (`calendar-sante.js:232-236`)— pero además mete a un fantasma
en «Pendientes de cobrar», en el recuento de clientas y en cualquier consulta que cuente
contactos. Lo hace el botón «Bloquear hueco», pegado a «Nueva cita».

Los cuatro «Close TIME» de Sante (contacto `fb2d64f0…`, `wa_phone '000000000'`) se pasaron a
bloqueos el **07/08/2026** y el contacto se borró. Era el arreglo que
`037_cita_no_facturable.sql:12-13` dejó anotado. Detalle de lo que había, con el `service`
original de cada uno, en [`data/close-time-backup-2026-08-07.json`](../data/close-time-backup-2026-08-07.json)
— **es el único sitio donde queda**: `schedule_blocks` solo tiene `reason`, texto libre.

Tres cosas que costaron y conviene no volver a descubrir:

- **Eran CUATRO, no tres.** La migración contaba tres porque buscaba `service='Cita manual'`;
  la cuarta era «Manicura + gel», un servicio que resuelve contra el catálogo y por eso no
  parecía un bloqueo. El nombre del servicio no distingue un bloqueo de una cita — lo dice la
  propia 037 («"Cita manual" es una convención del panel, no un dato»). Lo único que lo
  distingue es preguntar.
- **`cobros.appointment_id` es `ON DELETE RESTRICT`** (`035_cobros.sql:46`), así que un solo
  cobro —aunque esté anulado— hace fallar el borrado del contacto ENTERO por CASCADE. Y no se
  arregla poniéndolo a NULL: el trigger `cobros_congelar_importes` congela `appointment_id`
  explícitamente. Solo cabe borrar la fila de `cobros`, y eso lo decide la dueña.
- **El orden importa y no es negociable**: crear los bloqueos → verificar que los cuatro casan
  por (org, estilista, `starts_at`, `ends_at`) → y solo entonces borrar. Con el CASCADE de por
  medio, un borrado antes de tiempo se lleva las citas sin nada que las sustituya.

Cómo se verificó que la disponibilidad no se movió, que es la parte que hay que repetir si se
vuelve a hacer: instantánea con el motor REAL (`getAvailableSlots`) **día a día**, anclando
`preferencia.fecha` (`calendar-sante.js:178`), antes y después. Sin anclar la fecha el motor
deja de recorrer en cuanto tiene un puñado que proponer —salieron 5 huecos, todos del mismo
día— y un cambio en otra fecha no se habría visto. Con anclaje: 3 duraciones × 14 días,
**idéntico byte a byte**, y los mismos 9 intervalos ocupados de Olga con 4 pasando de `cita` a
`bloqueo`.

## Los timers de arranque van con `.unref()` — historia completa {#timers-unref}

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

## `verify:robustez:llm` — historia completa de la línea base {#verify-robustez-llm}

Este llama al LLM de verdad, así que **no es determinista y su línea base es un rango**, no una
cifra. Medida el **06/08/2026, después de arreglar balayage y de reescribir el check del esc.
15** (los dos, abajo), tres corridas seguidas del MISMO código:

| | 1ª | 2ª | 3ª |
|---|---|---|---|
| OK | 21 | 21 | 21 |
| DEGRADADO | 0 | 0 | 0 |
| SILENCIO · BUCLE · ERROR · BUG | 0 | 0 | 0 |

**Desde el 09/08/2026 son 23**: se añadió el de Esther Cediloo («¿cómo se llama la otra chica?»),
que afirma que la escalada por dato no disponible OCURRIÓ —ficha en manual o con
`escalation_reason`—, no que el texto suene bien. Medido tras los arreglos: **OK 23 · todo lo
demás 0**.

Ese escenario se ganó el sueldo en su primera corrida: destapó **dos fallos que ningún test
determinista habría visto**. El LLM preguntaba y escalaba en el MISMO turno —`bot_mode` a
manual en el turno de la oferta y silencio en el siguiente, el fallo de Olga por otra puerta—,
y `isAffirmative` devolvía **false para «yes»**, que es la puerta de confirmación de las seis
escaladas y de la elección de hueco. Los dos están arreglados; el segundo destapó a su vez que
«yesterday» ya contaba como un sí desde siempre, porque `este` vive dentro de «y-este-rday».

Y una lección de lectura: en una de las tres corridas el escenario 7 (CONTROL de estilista)
salió DEGRADADO. Repetido aislado y en una corrida completa, verde las dos veces, y en sus
logs no aparecía la red nueva. Era varianza del modelo, exactamente lo que el párrafo de
abajo dice que hay que comprobar antes de tocar nada.

**Desde el 07/08/2026 son 22 escenarios**, no 21: se añadió el 12 («solo puedo después de las
23:00»), que afirma que la respuesta lleva las DOS puntas del horario **leídas de
`business_hours`** — con el horario que tenga el panel en ese momento, no con un 10:00–19:00
escrito en el test. Medido una vez tras los arreglos: **OK 22 · todo lo demás 0**.

Los escenarios **3 y 15 salen en verde las tres veces**, con el mismo resultado exacto
(`Mechas Balayage · Cabello medio (190 €)` y `20 huecos reales cargados · Mechas 3`). Antes de
sus arreglos, el 3 degradaba 2 de cada 3 y el 15 ~1 de cada 3.

Las tres corridas salieron con **cero** mensajes `"Perdona, no he podido procesar tu mensaje"`,
que es lo que hace válida la medición: el proveedor estuvo en pie de principio a fin (ver el
párrafo de la TANDA, más abajo — el 05/08 hubo tres corridas que hubo que tirar por un 402).

**Esc. 15 («REPRO Eva») — su DEGRADADO era del check, igual que el del 3.** Exigía una hora
concreta (`\d{1,2}:\d{2}`) en la respuesta, y eso fallaba por los dos lados: el modelo propone
a veces el día primero ("mañana viernes, ¿te va bien?") con los huecos **ya cargados** —
conducta correcta marcada en rojo—, y al revés, cualquier hora que el modelo se inventara sin
haber consultado la agenda pasaba por buena, que es literalmente el fallo de Eva contado con
otras palabras. Reescrito el 06/08/2026 para afirmar el ESTADO: que `session.availableSlots`
llegó a tener huecos reales para el servicio pedido. Eso sale de `loadAvailableSlots` y la
prosa del modelo no puede fabricarlo. Se mira el MÁXIMO visto en la conversación, no el estado
final, porque reservar vacía `availableSlots`.

> **Lo que estas tres corridas NO demuestran, y conviene no leerlo de más:** en las tres el
> modelo listó horas en el texto, así que **el check viejo también habría pasado**. O sea que
> no son la prueba de que la varianza se acabó — el camino que fallaba no se dio. Lo que sí
> está garantizado por construcción es que la redacción ya no decide el veredicto en ninguna
> de las dos direcciones. Si el 15 vuelve a degradar, la nota dirá cuál de los cuatro motivos
> reales fue (servicio sin aterrizar, agenda nunca consultada, 0 huecos con causa, o avería
> anunciada) y eso **sí** habrá que perseguirlo.
>
> El check de avería (`problema técnico`) sigue midiéndose sobre el TEXTO a propósito: ahí las
> palabras SON el daño, porque la clienta lee una avería que no existe.

Así se cazó lo de balayage: el degradado dejó de bailar y repitió en el escenario 3 dos de
cada tres corridas. Diagnóstico en
[`docs/escenario-3-servicio-sin-resolver.md`](escenario-3-servicio-sin-resolver.md) y
arreglo el 06/08/2026 — `detectLargoCategory` casaba la categoría exigiendo su nombre completo
como subcadena y `largoKeywords` no tenía entrada para balayage, la única categoría con
variantes de largo que faltaba. El typo del nombre del escenario era una pista falsa: fallaba
igual con "balayage" bien escrito. Red determinista:
`tests/balayage-resuelve.test.js`.

**Una TANDA de degradados que comparten el texto `"Perdona, no he podido procesar tu mensaje"`
no es una regresión: es el LLM caído o limitando.** Ese literal es el fallback de bot.js cuando
la llamada falla, así que mide la red, no el salón. Medido el 05/08/2026: tras cinco corridas
seguidas en una hora, una sexta salió con **OK 14 · DEGRADADO 7** y seis de esos siete llevaban
ese texto. Antes de creerse un desplome así, mirar si el degradado es siempre la misma frase y
esperar un rato.

**Esc. 3 («valayage») — por qué ya no mide una palabra.** El check era
`/balayage/i` sobre la respuesta del modelo. Daba DEGRADADO 1 de cada 3 corridas con el bot
haciendo lo correcto, y **era ciego a lo único que importaba**. Medido con tres repeticiones
limpias: en dos de ellas el bot contestó exactamente `"Genial. ¿Qué día te viene mejor?"` —sin
nombrar el servicio, o sea rojo con el check viejo— y en una de esas dos el servicio SÍ estaba
resuelto en la sesión y en la otra no. Texto idéntico, estado opuesto.

Ahora afirma CONDUCTA sobre el ESTADO: se contesta el largo y se exige que
`session.selectedService` quede resuelto con la categoría de balayage **leída del catálogo**, no
de una constante (si la dueña la renombra, el escenario se declara no aplicable en vez de
quedarse en rojo). Sigue degradando ~1 de cada 3, pero ya por un motivo real y no por
redacción: el bot pasa a preguntar el día **sin haber resuelto el servicio** —`selectedService`
a null y 0 huecos cargados—, y en la repetición que falló seguía sin resolverlo un turno
después, preguntando el día para una cita cuyo servicio no sabía.

## El menú de Sante — historia completa {#menu-sante}

Limpieza del 07/08/2026. **Caja** bajó de PRINCIPAL a GESTIÓN, primera y justo encima de
Facturación: una registra lo que entra y la otra lo valora. **«Pagos» (`/stripe`) se borró
entero** —era un placeholder con badge SOON que no hacía nada— y su hueco lo ocupa Caja.

**`/resenas` salió del menú de Sante pero la página sigue viva**, y se llega escribiendo la
URL. Un `grep` del menú la dará por muerta; no lo está. Es el único sitio donde se ve la cola,
y su botón «Enviar reseña» la única salida manual: el 06/08/2026 aparecieron cinco marcadas
como enviadas que nunca salieron y `services/review.js` no avisa cuando falla, así que sin
esta pantalla ese fallo no lo ve nadie. Si algún día se borra de verdad, hay que sustituir
antes esa capacidad, no solo la ruta. El motivo está en cabecera de su `page.tsx` y en
`app-sidebar.tsx`, que es donde estará mirando quien vaya a borrarla.

**`/lista-negra` también salió, y hubo que devolverla el 10/08/2026** (GESTIÓN, justo debajo
de Lista VIP). El argumento para quitarla —«la dueña no la abre a diario»— era cierto y daba
igual: no se usa a diario, se usa el día que hace falta. Ese día llegó tres días después, con
alguien escribiendo barbaridades y amenazando, y la única forma de llegar era teclear la URL.
Una capacidad que solo se necesita en una urgencia es justo la que no puede depender de que
alguien recuerde la ruta.

## Bloquear a alguien (`is_blacklisted`) — historia completa {#lista-negra}

**Las dos filas de «Conversación» son la misma marca con dos significados.** En el salón,
bloquear es terminal: lo pide la dueña sobre alguien con quien no quiere tratar, y «En breve te
atenderá nuestro equipo» era una promesa de atención a quien se acaba de decidir no atender —
con el acosador del 10/08/2026, además, la confirmación de que hay alguien al otro lado
leyéndole. En San Remo la lista negra es una **retención a la espera de que un humano decida**
(no-show y Bizum rechazado abren un Telegram con «¿Qué hacemos?»), así que allí la frase es
verdad y se queda. El mensaje sigue al significado, no a la columna.

**El aviso no se repite, pero se REARMA si la ficha deja de reflejar el bloqueo.** Persistir
`blacklistNotified` abre un hueco: bloquear → escribe → desbloquear → **volver a bloquear sin
que él escriba en medio**. La sesión guardada seguiría diciendo «ya avisado», así que el
segundo bloqueo no pondría manual, ni escalada, ni Telegram, y el panel enseñaría la
conversación en 'auto' —«el bot le contesta»— mientras el bot calla.
`rearmarSiLaFichaNoLoRefleja` lo desempata contra la FICHA, no contra el flag: en lista negra
y `bot_mode` distinto de 'manual' significa que ese bloqueo no lo ha procesado nadie.

**Desbloquear son DOS escrituras y el orden importa.** Quitar solo `is_blacklisted` deja la
conversación en manual con la escalada sin resolver, o sea **el bot mudo igual** — y
`auto-return` no la rescata nunca, precisamente porque no devuelve a 'auto' nada con una
escalada abierta. Primero `PUT /api/leads/:id/bot-mode {mode:'auto'}` (que limpia
`escalation_reason` y resuelve la `pending_action`) y después `DELETE /api/lista-negra/:id`:
si falla el segundo paso el contacto sigue BLOQUEADO, que es el lado recuperable. Al revés,
el fallo deja un «desbloqueado» al que no le contesta nadie. **Los tres caminos hacen los dos
pasos en ese orden** desde el 10/08/2026: la ficha de Clientes, el «Quitar» de `/lista-negra`
(que hasta entonces hacía solo el DELETE) y `ejecutarDesbloqueo` de Telegram.

**Y ninguno le escribe.** El botón de Telegram mandaba además «Hola 😊 Hemos revisado tu caso.
¿En qué puedo ayudarte?» de un solo toque y sin confirmar: con un acosador, un dedo torcido en
una notificación del móvil le reabre la puerta y le invita a seguir. Ahora `bl_ok` **pregunta**
y `bl_do` ejecuta — `bl_ok` conserva el nombre A PROPÓSITO, para que un toque en un aviso ya
enviado caiga también en la confirmación en vez de desbloquear a la primera.

Al separarlo apareció que **ese mensaje no se enviaba desde hacía tiempo**: `sendDirectMessage`
no está definido ni importado en `telegram.js`, así que la llamada lanzaba `ReferenceError`, lo
recogía el `catch` y el admin leía «❌ Error al reactivar el cliente» sobre un contacto que SÍ
había quedado desbloqueado (las dos escrituras van antes). Mentía en la dirección peligrosa:
te hace creer que el bloqueo aguanta. Quitar la línea no cambia nada de lo que le llega a
nadie —hoy no le llega—; lo que cambia es que el parte diga la verdad.

**Dos formas de bloquear, ninguna es atajo de la otra**: `/lista-negra` es la vista completa
(quién está bloqueado, buscar a cualquiera, desbloquear) y la ficha de Clientes actúa sobre el
contacto que ya tienes abierto. Las dos pasan por `POST`/`DELETE /api/lista-negra/:id` (más el
`bot-mode` del desbloqueo). La de la ficha es **solo salón** (`isSalon`) y pide confirmación.

Las dos redes, y por qué son dos:

- `tests/blacklist-no-promete.test.js` — la CONDUCTA, contra el motor real: que al salón no le
  sale ni un mensaje, que el aviso no se repite ni tras un timeout de sesión, que sí se rearma
  con la ficha desincronizada, que San Remo recibe su frase palabra por palabra, y el orden de
  las dos escrituras del desbloqueo. Hermético (Supabase, Telegram y LLM interceptados).
- `tests/lista-negra-panel.test.js` — el TEXTO de la confirmación, que vive en
  `dashboard-app/src/lib/blacklist.ts` con cada línea anclada al código que la hace cierta.
  Afirma, entre otras, que **no** le promete atención a quien se acaba de bloquear.

Están separadas a propósito: la primera protege lo que hace el sistema y la segunda que el
panel siga contando lo mismo. Cuando cambie una conducta de la tabla de arriba, la segunda es
la que avisa de que la confirmación se ha vuelto mentira.

## Reglas de trabajo — el texto largo que se recortó {#reglas-recortadas}

Recortado en CLAUDE.md el **14/08/2026**, al añadir la cabecera de seis hechos y las reglas 11
y 12. Las reglas siguen vigentes tal cual están arriba; aquí queda su redacción larga, que es
donde estaban los ejemplos completos.

### Regla 7 — `cp` antes de mutar (texto completo)

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

### Regla 10 — un solo bloque de código (texto completo)

**10. TODA respuesta va en UN solo bloque de código, y sin una línea de texto fuera.**
No solo los planes, resúmenes, informes, listas de pasos o mensajes para otra herramienta:
**cualquier** respuesta —un aviso, una pregunta, un «hecho», dos frases sueltas— va dentro de
un único bloque markdown, con todo dentro (encabezados y viñetas incluidos) y ni una línea de
prosa antes o después. *El destino es el móvil: allí un bloque de código se copia de un toque,
mientras que seleccionar a mano tres trozos de texto suelto cuesta más que el trabajo que se
está pasando.* Si el contenido lleva a su vez bloques de código, el de fuera se abre con más
backticks para que los de dentro no lo cierren.

**Y las TABLAS, que es por donde se colaba.** La app del móvil renderiza una tabla markdown
como elemento APARTE, con su propio botón de copiar: aunque el resto de la respuesta vaya en
un bloque, la tabla hay que copiarla por separado. O sea que una tabla fuera del bloque rompe
la regla igual que un párrafo suelto, aunque «visualmente» parezca que está dentro de la
respuesta. *Pasó con el brief del enlace.*

- **NUNCA una tabla markdown fuera del bloque. Ninguna.**
- Si hace falta una tabla, va **DENTRO** del bloque, en **texto plano alineado con espacios**
  — nada de `|---|---|`.
- Lo mismo para cualquier otra cosa que la app renderice aparte: bloques de código sueltos,
  citas (`>`), listas de tareas. Todo dentro del único bloque.

**La regla en una frase: si al mirar la pantalla del móvil se ve más de un botón de copiar,
está mal.**

## «¿Te lo reservo?» es una pregunta, y la red final se la comía {#te-lo-reservo}

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

## Los typos de un servicio van ENUMERADOS, nunca con corrector difuso {#typos-enumerados}

Causa 5 de la misma auditoría (`016b4d9`). La errata más común del servicio más vendido
devolvía null: Nora escribió «bayalage» tres veces el 10/08 —«im thinking bayalage», «I want a
bayalage», «blonde bayalage»— y el servicio no aterrizó ninguna. Tres turnos de fricción con
la clienta repitiendo lo que quería; lo peor lo evitó la guarda de Michal
(`proposesTimingWithoutService`): sin servicio resuelto el bot no llegó a inventar horas.
`largoKeywords` (`detectLargoCategory`, helpers.js) lleva ahora `balayage`, `balaiage`,
`valayage` (escenario 3) y `bayalage`, `baleage`, `balyage`.

**El criterio de admisión es que cada typo lo haya escrito alguien de verdad**, y la trampa
que no hay que reabrir es sustituir la lista por un corrector difuso. Parece la generalización
obvia y es lo contrario: `largoKeywords` no es un diccionario de servicios, es una lista con
criterio —**que nadie la diga de pasada**—, y un fuzzy no sabe distinguir una errata de una
palabra vecina dicha al pasar. Justo eso deja fuera a `blonde` a secas («I'm blonde and I want
a haircut» es una descripción, no un servicio), con su test de falso positivo: un umbral
difuso lo readmitiría sin que ningún test de erratas se enterase. La lección de siempre, otra
vez: una red demasiado ancha no sobra un mensaje, pierde el bueno.

Red: `tests/balayage-resuelve.test.js`, con el primer mensaje literal de Nora.

## Mariola Mira Lopez (12/08/2026): «somos dos» y el precio que no leía nadie {#mariola}

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

## Los tres ficheros de catálogo del repo, y por qué ninguno es el vivo {#tres-catalogos}

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

## Seguimiento post-visita — diseño completo (`services/seguimiento.js`) {#seguimiento}

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

## Cómo se leen los informes y el arnés — texto completo {#informes-lectura}

Recortado de CLAUDE.md el 14/08/2026. Arriba queda la línea dura del arnés y los
comandos; esto es el detalle de cómo se lee cada uno.

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

## El texto de un hueco va en el idioma de la clienta (`formatSlotTexto`) {#texto-del-hueco}

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

## La deuda del upselling: por qué se decidió NO arreglarla {#deuda-upselling}

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



## La conversación de Olga Yarmak no se perdió: se borró (11/08/2026) {#olga-borrada}

Investigado el 15/08/2026 al no encontrarla en `messages` para el corpus de oro. **Desapareció
una conversación entera de producción**, y se puede fechar al segundo.

**Que existía, probado por conteo.** La auditoría del 09/08 leyó **38 conversaciones · 392
mensajes** entre el 31/07 y el 09/08, Olga entre ellas (fila «7 ago · Olga Yarmak»). Hoy esa
misma ventana da **37 · 362**. La ventana está cerrada —`created_at` no cambia—, así que esos
30 mensajes solo pueden haberse borrado. Cruzando nombre por nombre las 38 auditadas contra
las 37 de hoy, la única ausente es ella.

**Que se borró, probado por los edge logs de Supabase.**

```
DELETE | 204 | /rest/v1/contacts?id=eq.cc9007ce-4215-4d8a-865d-240f8c797181
               &organization_id=eq.b2c3d4e5-…        2026-08-11T06:37:11.548Z  (08:37 Madrid)
```

El **orden de los parámetros identifica el camino**: `id` antes que `organization_id` es
`db.deleteLead` (`.eq('id', id).eq('organization_id', oid)`), o sea `DELETE /api/leads/:id`,
el botón de borrar contacto del panel. Ese mismo día, entre las 15:36 y las 16:35, se borraron
**93 contactos más** con el patrón CONTRARIO (`organization_id` primero, precedido de un
borrado de `appointments` y otro de `pending_actions`): es el `cleanup(phone)` del arnés
`verify:robustez:llm` retirando sus propios contactos sintéticos. Separados por consulta: **1
de panel · 93 de arnés**. El 10/08 no hubo ninguno.

**Por qué no quedó rastro.** No se emitió ni un solo `DELETE` contra `conversations` ni contra
`messages`: se fueron por **`ON DELETE CASCADE`** (`conversations.contact_id → contacts` y
`messages.conversation_id → conversations`; igual `appointments`, `pending_actions` y
`seguimientos`). Borrar un contacto destruye su historial entero en silencio, y lo único que
lo data es el log HTTP del edge, que caduca en días. **No hay recuperación**: el log guarda la
petición, no el contenido. Lo único que sobrevive de esa conversación es la narrativa de
[#olga-yarmak](#olga-yarmak) y las frases congeladas en `tests/horario-fuera-de-rango.test.js`,
`tests/tratamiento-formal.test.js`, `tests/escalada-acuse.test.js` y `menu-rescate-tope`.

**La ausencia ya se había visto, y se leyó como inocua.** `docs/campana-verano-tandas.md`
(commit `6ad973d`, 12/08 12:52) anota que `34674987146` «ya no tiene ficha en `contacts`» y
concluye: «Inocuo — excluir un teléfono que no existe no quita a nadie». Para la campaña es
cierto. Lo que no se preguntó nadie es **por qué** no estaba, y ahí lo inocuo era una
conversación auditada de 30 mensajes.

**Borrar la ficha probablemente fue correcto; perder la conversación no era visible como su
consecuencia.** `data/campana-verano-exclusiones.json` dice de ese número: contestó a la tanda
1 con «Я мужчина» y pidiendo «cambio de aceite y filtros, montaje y arranque del motor» — o el
número cambió de manos o la ficha estaba mal, pero clienta del salón no era.

Lo que hay que cambiar, y no está hecho:

- **Borrar un contacto no es «que no me escriba más» ni «que no salga en campañas»**, y hoy la
  confirmación del panel no dice que se lleva por delante la conversación, las citas y las
  filas de `pending_actions`. Debería decirlo, con el número de mensajes que va a destruir.
- **Antes de borrar, exportar**: `npm run exportar:conversacion -- sante <telefono>` deja el
  hilo entero en un JSON. Es de lectura y cuesta un segundo.
- Si lo que se quiere es que no le llegue nada, eso ya existe y es reversible:
  `is_blacklisted` (la filtran campañas, recordatorio y reseña).

## `npm test` puede dar VERDE estando en rojo — no es el runner, es cómo se lee {#npm-test-falso-verde}

Dos sesiones corrieron `npm test` sobre `0a7e7c5` el 15/08 y reportaron cosas opuestas. La
correcta es **ROJO**, reproducido en un worktree limpio sobre ese commit exacto:

```
EXIT = 1            para en el 13º de 129 ficheros (tests/sin-preferencia-vs-asap.test.js)
stdout: 323 líneas · 234 «ok -» · CERO líneas de fallo
stderr: la línea «fail - …» y el AssertionError
corrida VERDE, para comparar: 2662 líneas de stdout
```

El fallo era real y **no es un flake**: la aserción es un `grep` sobre el texto de `bot.js`
(esperaba `offersHumanHandover(aiResponse.respuesta)`, un call site que el anillo 1 sustituyó
por `detectaOfertaTraspaso`). No puede pasar en ese commit a ninguna hora ni con ninguna
variable de entorno. **Cualquier verde sobre 0a7e7c5 es un artefacto de lectura**, y hay tres
formas de producirlo:

1. **Los fallos salen por STDERR.** 82 de los 129 ficheros imprimen `fail - …` con
   `console.error`; **ninguno** lo imprime por stdout. Un `npm test > log 2>/dev/null` deja un
   log de 323 líneas donde todas dicen `ok -`. Y `grep -i fail log` da 3 aciertos, los tres
   inocentes (nombres de test que llevan «fail» dentro), o sea que hasta el grep tranquiliza.
2. **No hay línea de resumen.** La cadena no imprime nada al terminar, así que una corrida que
   se para en el fichero 13 es indistinguible de una completa salvo por el número de líneas
   (323 vs 2662) o por el exit code. No hay nada que buscar.
3. **Un pipe se come el exit code.** `npm test 2>&1 | tail -5` devuelve **0** — el de `tail`.

Lo que NO falla, comprobado: los 129 ficheros de la cadena propagan el fallo por exit code
(115 con `process.exit`/`exitCode`, 14 con `node:test`, 0 sin forma de propagar), así que el
`&&` corta donde debe. El agujero es de lectura, no de ejecución.

Qué cambiar para que no vuelva a pasar:

- **Un marcador final en la cadena**: `… && echo "SUITE COMPLETA · 129 ficheros"`. Si esa línea
  no está en el log, la corrida no terminó — sirve incluso mirando solo stdout.
- **Autorizar por exit code, nunca por el log.** `npm test; echo $?` y punto. Si se pipea, con
  `set -o pipefail`.
- **Nunca descartar stderr** en una corrida que se va a usar para decidir un despliegue.
- **10 ficheros `*.test.js` no están en la cadena** y no los corre nadie:
  `blacklist-reconcile`, `escalation-flow`, `helpers`, `media-dedupe`,
  `monitor-orden-ultimo-mensaje`, `oferta-traspaso`, `promesas-audit`, `recordatorio-por-cita`,
  `recordatorio-registro-conversacion`, `robustez-llm-arnes`. Entre ellos está justamente
  `oferta-traspaso`, el test NUEVO del anillo 1: se escribió, nunca se enchufó, y mientras
  tanto el test VIEJO que lo contradecía seguía en la cadena en rojo.
