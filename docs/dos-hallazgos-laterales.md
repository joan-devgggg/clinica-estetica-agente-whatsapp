# Los dos hallazgos laterales del 09/08: diagnóstico y propuesta

**Fecha:** 12/08/2026 · **Estado: DIAGNOSTICADOS, sin implementar.** Los dos quedaron anotados
como «decidido NO arreglar» el 09/08 (auditoría de Michal y Esther) y están citados así en
CLAUDE.md. Esto no revierte esa decisión: la documenta con números y deja la propuesta escrita
para cuando se decida.

Los dos comparten forma —una protección que existe, se lee entera en el código, y **no llega
a correr en el camino real**— y por eso ninguno de los dos ha dado nunca un síntoma buscable.
No fallan: no están.

---

# 1 · El dedupe de sesión está muerto en la ruta real

## Qué pasa exactamente

`processMessageCore` tiene **un solo call site en todo el repo** (`bot.js:6090`, dentro de
`flushBuffer`) y le pasa `messageKey = null`, siempre:

```js
await processMessageCore(client, message, userPhone, combinedText, null, orgId, dbPhone);
```

El `null` no es un descuido de una rama: es el único valor que ese parámetro toma nunca. Y es
inevitable donde está, porque a esa altura ya no hay UN mensaje — hay `buffer.texts.join('\n')`,
o sea de 1 a N mensajes fusionados en un texto, y N claves distintas. No hay ningún
`messageKey` correcto que pasar.

De ahí cuelgan **dos piezas muertas**:

```js
// bot.js:3869-3870 — dentro de processMessageCore. `messageKey` es null: nunca entra.
if (messageKey && session.seenMessages.has(messageKey)) { …; return; }
if (messageKey) session.seenMessages.add(messageKey);

// bot.js:6163-6169 — en handleIncomingMessage, la guarda que consulta lo anterior.
if (messageKey) {
    const s = userSessions.get(sKey);
    if (s?.seenMessages?.has(messageKey)) { …; return; }   // ← nunca es true
}
```

`session.seenMessages` (un `TTLMessageDedupe` de 60 s, `bot.js:216`) **se construye en cada
sesión y no se le añade nunca nada**. La única línea que lo rellenaría es la 3870, gateada por
la clave que no llega. La guarda de la 6165 no puede saltar jamás.

## Lo que queda protegiendo, y hasta dónde llega

Toda la defensa real es `buffer.seenKeys` (`bot.js:6263-6270`). Su alcance es más corto de lo
que parece, y en dos direcciones a la vez:

| | `buffer.seenKeys` (lo que hay) | `session.seenMessages` (lo que se diseñó) |
|---|---|---|
| Ventana | hasta el flush — **se vacía en cada uno** (`bot.js:6077`) | 60 s desde el mensaje |
| Vida del contenedor | el buffer se borra a los 60 s de inactividad (`bot.js:6105-6110`) | mientras viva la sesión (1 h) |
| Sobrevive a un reinicio | no | no (también en RAM) |

Con `BUFFER_DELAY_MS = 5000`, la ventana efectiva de dedupe en la ruta real es de **unos 5
segundos**, no de 60. **Un reenvío del mismo `wamid` entre los ~5 s y los 60 s se contesta dos
veces.** Ese es el hueco entero, y es exactamente la franja que el diseño de 60 s cubría.

## Por qué importa más de lo que parecía en agosto

Hay un comentario en `webhook.js:139-140`, sobre la ruta de entrada de Sante, que se apoya en
esta protección por su nombre:

> POST: responde 200 inmediato y procesa async (Cloud API reintenta si tardas → evita timeouts
> y duplicados; **el dedupe por wamid en bot.js cubre reintentos**).

No los cubre pasados los 5 s. Y el 200 inmediato hace que el reintento de Meta sea raro, sí,
pero no imposible: si el proceso cae entre el `res.sendStatus(200)` y el `setImmediate`, o si
360dialog reenvía por su cuenta, el reintento llega. Sante entra por ahí y solo por ahí.

Lo que no es: no es la causa de ninguno de los seis síntomas de Michal/Esther (se comprobó el
09/08) ni de la doble pregunta del largo de Nora (esa es la ventana del buffer, 7,197 s > 5 s,
que es dimensionado y no dedupe). Es un agujero **latente**, y sigue siéndolo.

Un matiz importante para no exagerarlo: **la fila de `messages` no se duplica**.
`messages.wa_message_id` es `TEXT UNIQUE` (`001_schema.sql:209`) y `saveMessage` ya reconoce el
`PG_UNIQUE_VIOLATION` y lo registra como `mensaje_duplicado_ignorado` (`db.js:736-740`). Lo
que se duplica es **la RESPUESTA**: la clienta recibe dos.

## Propuesta

Tres caminos. El primero es el que se recomienda.

**A · Dedupe en la puerta, antes del buffer (recomendado).** Sacar el registro de la clave de
`processMessageCore` y llevarlo a `handleIncomingMessage`, junto a la guarda que ya vive ahí
(6163-6169): mismo `TTLMessageDedupe`, misma clave, mismo sitio donde ya se consulta. Deja de
depender de un parámetro que el único llamante no puede rellenar.

- Un solo contenedor con la vida correcta. Cambio pequeño y localizado.
- Dónde colgarlo es la única decisión: `userSessions.get(sKey)?.seenMessages` no sirve —en el
  primer mensaje la sesión aún no existe—, así que pide un `TTLMessageDedupe` de MÓDULO
  cacheado por `sKey`, o mover la creación de la sesión antes. Lo primero es menos invasivo.
- Trampa a cubrir: el dedupe tiene que ir **después** del guard de canal
  (`mensaje_ignorado_canal_inactivo`, 6146) y **antes** del `saveMessage` de la 6244; si va
  antes del guard de canal, un mensaje descartado por canal quemaría su clave.
- Al hacerlo, **borrar** las líneas 3869-3870 y el parámetro `messageKey` de la firma. Dejarlas
  «por si acaso» es lo que nos ha tenido nueve meses leyendo una protección que no corría.

**B · Apoyarse en el UNIQUE de `messages`.** Es tentador —es persistente, es por org, sobrevive
a reinicios y cruza procesos, que es más de lo que da cualquier Map en RAM— y **no se
recomienda tal cual**. `saveMessage` devuelve `null` en cinco situaciones distintas (teléfono
vacío, contacto no creable, conversación no creable, violación de unicidad, y cualquier otro
error de escritura), así que un `if (!id) return;` **descartaría en silencio mensajes reales**
cada vez que Supabase tosiera. Sería cambiar una respuesta de más por un silencio, que es el
lado caro. Viable solo si `saveMessage` pasa a distinguir el duplicado del resto (p. ej.
`{ id, duplicado: true }`), y eso ya es tocar la capa de datos.

**C · Alargar `buffer.seenKeys`.** No vaciarlo en el flush y darle TTL propio. Es el cambio de
una línea y es el peor: convierte el buffer —una estructura de agrupación, con su ciclo de
vida— en el sitio donde vive el dedupe, y el siguiente que toque el ciclo de vida del buffer
volverá a romperlo sin enterarse.

**Test que hay que ver fallar antes:** dos `handleIncomingMessage` con el MISMO `messageKey`
separados por más de `BUFFER_DELAY_MS` (con temporizadores falsos), afirmando **una sola**
llamada a `processMessageCore`. Con el código de hoy tiene que salir 2. Y un control con dos
claves DISTINTAS a la misma distancia, que debe seguir dando 2 — si no, lo que se ha escrito no
es un dedupe, es un silenciador.

---

# 2 · `sinServicioStreak` no viaja, y el nivel 4 es inalcanzable

## Qué pasa exactamente

El menú de rescate de `salonNoSlotsMsg` (`bot.js:1879-1902`) tiene tres escalones sobre un solo
contador:

```js
session.sinServicioStreak = (session.sinServicioStreak || 0) + 1;
if (session.sinServicioStreak >= 4) return salonOfferHumanMsg(session);   // ofrece una persona
if (session.sinServicioStreak >= 2) return salonPickServiceMenuMsg(session);
// 1 → «¿qué servicio quieres?»
```

`sinServicioStreak` **no está en `buildSessionExtra`** (`bot.js:668-725`), así que no viaja a
SQLite. Se inicializa a `0` en la plantilla de sesión (`bot.js:279`) y la rehidratación
(`bot.js:3620-3627`) no lo restaura. Cualquier corte lo pone a cero:

- un timeout de sesión (`SESSION_TIMEOUT`, **1 hora**, `bot.js:63`),
- el GC que desaloja la sesión más tarde,
- un `pm2 restart`.

Para llegar al escalón 4 hacen falta **cuatro turnos de `salonNoSlotsMsg` sin servicio
resuelto, todos dentro de la misma hora y sin que el proceso se reinicie**. Justo la
conversación que motivó el escalón —alguien que lleva rato sin conseguir explicarse— es la que
más probabilidades tiene de tener un hueco de más de una hora en medio.

El efecto es silencioso y engañoso: no se pierde el rescate, se pierde **el techo**. La clienta
vuelve al escalón 2 y recibe el menú de servicios otra vez, que es exactamente el bucle sin
suelo que se arregló el 07/08 por el caso de Olga Yarmak. La corrección funciona dentro de la
hora y desaparece al cruzarla.

## Lo que hace pensar que es un olvido y no una decisión

Dos vecinos de la misma familia **sí** viajan, y uno de ellos es la otra mitad de este mismo
mecanismo:

- `pendingEscalation` / `pendingEscalationService` (`buildSessionExtra:696-697`) — es la
  bandera que arma el escalón 4 para esperar el «sí». O sea: **la respuesta a la oferta
  sobrevive a un timeout, pero el contador que dispara la oferta no.** Media función
  persistida.
- `preguntasCierre` (`buildSessionExtra:713`) — otro contador entero, de la misma forma, que sí
  está en la lista.

Cuesta cuatro palabras arreglarlo, y eso es también un argumento para no hacerlo a la ligera:
lo barato invita a colarlo sin test.

## Propuesta

**Añadir `sinServicioStreak: session.sinServicioStreak || 0` a `buildSessionExtra` y
restaurarlo en la rehidratación**, al lado de `preguntasCierre`, que es su gemelo exacto.

Tres cosas que hay que resolver ANTES de escribirlo, y son la razón de que esto no sea un
one-liner:

1. **Va en el bloque de salón, no en `base`.** `buildSessionExtra` devuelve `base` y sale para
   `orgType !== 'salon'` (línea 670). `salonNoSlotsMsg` es solo del salón, así que le
   corresponde el bloque de abajo — y ahí San Remo no se entera, que es la regla de oro.
2. **Qué significa un streak de hace 50 minutos.** Persistirlo hace que un `>= 4` se pueda
   alcanzar sumando turnos de conversaciones que la clienta vive como distintas: cuatro
   intentos repartidos en semanas ofrecerían una persona en el cuarto, sin que nadie recuerde
   los tres anteriores. Puede ser lo correcto —cuatro intentos fallidos son cuatro— o puede ser
   un traspaso que sorprende. **Esto es diseño y lo decide el dueño**, y es lo que hay que
   preguntar antes de tocar nada. Si la respuesta es «solo dentro de la conversación», el campo
   tiene que viajar con su marca de tiempo y caducar (el molde ya existe:
   `conversationStartedAt` está en `base`).
3. **El contador solo baja en un sitio** (`bot.js:1903`, cuando el servicio SÍ resuelve). Al
   persistirlo hay que comprobar que ese reset también se guarda, o un streak alto se queda
   pegado a la ficha para siempre. Es la mitad del test.

**Test que hay que ver fallar antes:** una conversación que llega a streak 3, cruza un timeout
de sesión (rehidratando desde SQLite de verdad, no tocando el objeto a mano) y hace un cuarto
turno sin servicio. Debe recibir `salonOfferHumanMsg`; hoy recibe `salonPickServiceMenuMsg`.
Y el control opuesto: streak 3, servicio resuelto, timeout, y otro turno sin servicio → debe
volver a empezar por el escalón 1, no saltar al 4.

---

## Lo que se propone hacer con esto

Ninguno de los dos se toca sin decisión del dueño, y por motivos distintos:

- El **1** es una decisión de alcance (toca la puerta de entrada de las dos orgs, el camino más
  caliente del repo) con un arreglo claro y un test limpio. Es el que se recomienda hacer
  primero si se hace alguno.
- El **2** es una decisión de **diseño** —qué significa el contador entre conversaciones— y por
  eso está parado en el punto 2 de su propuesta, no en el código.
