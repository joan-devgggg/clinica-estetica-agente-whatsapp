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
con test que lo fija. Si la fecha no se entiende sale la hora sola —el mensaje de siempre— y se
dice en el log (`recordatorio_fecha_no_formateable`): nunca se inventa un día. Pasa de verdad,
porque `minutosHastaCita` no descarta una `fecha_cita` malformada (`NaN > minutos` es false).

Red: `tests/recordatorio-con-fecha.test.js` — los siete días en los cuatro idiomas uno por uno,
que es donde va a fallar si falla. Las cinco protecciones están probadas por mutación.

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

## El vigilante de esperas está DORMIDO, y no por olvido (`services/espera-alert.js`)

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

## La conversación de Olga Yarmak (07/08/2026): cinco síntomas, cuatro causas

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

## Michal Gradziel y Esther Cediloo: seis síntomas, cuatro causas

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

## Bloquear agenda: `schedule_blocks`, nunca una cita con clienta inventada

Un hueco que se cierra **es un `schedule_blocks`**. Hacerlo como cita a nombre de un contacto
falso resta disponibilidad igual —el motor concatena citas y bloqueos en un único array
`occupied` y los trata idénticos (`calendar-sante.js:232-236`)— pero además mete a un fantasma
en «Pendientes de cobrar», en el recuento de clientas y en cualquier consulta que cuente
contactos. Lo hace el botón «Bloquear hueco», pegado a «Nueva cita».

Los cuatro «Close TIME» de Sante (contacto `fb2d64f0…`, `wa_phone '000000000'`) se pasaron a
bloqueos el **07/08/2026** y el contacto se borró. Era el arreglo que
`037_cita_no_facturable.sql:12-13` dejó anotado. Detalle de lo que había, con el `service`
original de cada uno, en [`data/close-time-backup-2026-08-07.json`](data/close-time-backup-2026-08-07.json)
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

### `verify:robustez:llm` — línea base y cómo leer un DEGRADADO

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

**Lo que se compara es la fila de abajo.** `BUG`, `SILENCIO`, `BUCLE` y `ERROR` a 0 son el
invariante duro: cualquiera de ellos por encima de 0 es un hallazgo, siempre. **Un DEGRADADO
suelto que cae en un escenario distinto en cada corrida es varianza del modelo, no una
regresión** — antes de tocar nada, repetir. Dos corridas con el MISMO escenario degradado ya
es otra cosa.

Así se cazó lo de balayage: el degradado dejó de bailar y repitió en el escenario 3 dos de
cada tres corridas. Diagnóstico en
[`docs/escenario-3-servicio-sin-resolver.md`](docs/escenario-3-servicio-sin-resolver.md) y
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

**Ya está investigado** (05/08/2026): [`docs/escenario-3-servicio-sin-resolver.md`](docs/escenario-3-servicio-sin-resolver.md).
Dos conclusiones que conviene tener a mano antes de tocar nada:

- **NO es de la familia de la cita fantasma.** Por ese camino no se puede reservar: los tres
  puntos de entrada a la escritura de una cita de Sante están gateados por `selectedService`,
  y también los tres `loadAvailableSlots` del flujo de salón — así que ni siquiera llega a
  proponer horas concretas, solo a preguntar el día. Es molesto, no peligroso. (El molde sí
  está montado: si una de esas tres guardas se relajara, `buildFullServiceName(null)` acaba
  escribiendo `service: 'Reserva'`. Hoy no hay ningún test que las afirme.)
- **Sí es el mismo callejón que el bucle sin servicio de `4e7743c`**, por otra puerta: allí la
  clienta no sabía qué quería, aquí lo sabe y el detector no lo reconoce. Ha pasado con
  clientas reales cuatro veces entre el 01 y el 03/08.

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

## El menú de Sante: dos pantallas fuera del menú que NO son código muerto

Limpieza del 07/08/2026. **Caja** bajó de PRINCIPAL a GESTIÓN, primera y justo encima de
Facturación: una registra lo que entra y la otra lo valora. **«Pagos» (`/stripe`) se borró
entero** —era un placeholder con badge SOON que no hacía nada— y su hueco lo ocupa Caja.

**`/lista-negra` y `/resenas` salieron del menú de Sante pero las páginas siguen vivas**, y se
llega a ellas escribiendo la URL. Un `grep` del menú las dará por muertas; no lo están, y
borrarlas quita una capacidad que no tiene otro sitio:

- **`/lista-negra`** — el filtro sigue corriendo por debajo (`bot.js:3511`, y `db.js` lo
  aplica a recordatorios y reseñas). Es la única forma de **desbloquear** a alguien; sin
  pantalla, un bloqueo es definitivo y silencioso. Sigue en el menú de San Remo.
- **`/resenas`** — único sitio donde se ve la cola, y su botón «Enviar reseña» es la única
  salida manual. El 06/08/2026 aparecieron cinco marcadas como enviadas que nunca salieron;
  `services/review.js` no avisa cuando falla, así que sin esta pantalla ese fallo no lo ve
  nadie.

Si algún día se borran de verdad, hay que sustituir antes esas dos capacidades —desbloquear
una clienta y ver la cola de reseñas—, no solo la ruta. El motivo está repetido en cabecera de
cada `page.tsx` y en `app-sidebar.tsx`, que es donde estará mirando quien vaya a borrarlas.

## Regla de oro

**San Remo NO se toca.** Cualquier cambio en el código compartido debe mantener el comportamiento exacto de San Remo. El flujo Bizum, party_size, mock calendar — todo sigue igual para `orgType === 'restaurant'`.
