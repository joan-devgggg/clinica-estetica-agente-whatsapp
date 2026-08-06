# Auditoría: "afirmar sin verificar" — reseñas, campañas y facturación

**Fecha:** 05/08/2026 · **Alcance original:** solo informe.
**Estado a 06/08/2026: los seis hallazgos arreglados.** Cada uno lleva su párrafo de
«Arreglo» al final de su sección; el orden de ejecución fue el que se proponía abajo.

| | Hallazgo | Commit |
|---|---|---|
| 🔴 1 | El botón "enviar reseña" no envía nada | `d885dfb` |
| 🔴 2 | Una campaña entregada contada como fallida y reenviada | `9778f63` |
| 🟠 3 | Una reseña enviada y sin marcar se repite cada 5 min | `85a9c4c` |
| 🟠 4 | El sellado del importe falla en silencio | `e91e949` |
| 🟡 5 | El `catch` mudo de campañas | `9778f63` (de paso con el 2) |
| 🟡 6 | `noteSendResult` sin esperar | `2f5d298` |

El gemelo del punto 3 en `reminder.js`, que quedó apuntado y fuera del alcance, **también está
arreglado** (06/08/2026, ver el párrafo al final del punto 3).

**`setConfigValue` — ✅ ARREGLADO 06/08/2026**, y era el último superviviente de la familia.
Hacía el `upsert` **sin mirar el error ni cuántas filas tocó** y devolvía `true` igual, así que
el panel decía «guardado» y dejaba el toggle puesto en pantalla sobre una escritura que no
había ocurrido; al recargar volvía el valor viejo. De esa tabla cuelga todo lo que la dueña
configura: `bot_activo`, la ventana del recordatorio, las horas de la reseña, las plantillas.

Ahora usa `assertRowsAffected` con `.select('clave')` —`config` no tiene `id`, su PK es
`(organization_id, clave)`— y **lanza**. Los dos call sites lo saben:

- `PUT /api/config/:clave` lo convierte en **500** en vez de `{ok:true}`.
- `setBotActivo` (`bot.js`) **no puede esperarlo**: es síncrona y la llaman el handler de
  Telegram y el arranque. Lleva un `.catch()` que loguea a nivel **error**, y el nivel no es
  decorativo: el estado en MEMORIA queda como se pidió (el bot calla ahora), pero el de BD no,
  y `server.js` recarga `bot_activo` de `config` al arrancar — **el primer reinicio revive el
  bot que alguien había pausado**. Sin `.catch()`, además, sería un rechazo sin manejar, que en
  Node moderno tumba el proceso: o sea el bot de las dos orgs.

Red: `tests/config-escritura-verificada.test.js`, con un vigilante de `unhandledRejection` en
el propio test. Comprobado por mutación (quitar el `assertRowsAffected` tumba A1/A2/B1; quitar
el `.catch()` tumba C1/C2).

**El piso de arriba, `telegram.js` — ✅ ARREGLADO 06/08/2026.** El handler llamaba a
`setBotActivoFn(orgId, false)` sin esperar y contestaba «⏸️ Bot pausado» pasara lo que pasara.
Ahora `setBotActivo` **devuelve una promesa que resuelve a un booleano y nunca rechaza**, y esa
forma rara es la que permite las dos cosas a la vez:

- quien PUEDE esperar (Telegram) sabe si se guardó y responde en consecuencia;
- quien NO puede (`server.js` al arrancar, `webhook.js` tras escribir el panel) la ignora sin
  heredar un rechazo sin manejar, que tumbaría el proceso.

Si no se guardó, el admin lee que el bot **está pausado ahora mismo pero un reinicio lo
revive**, y que vuelva a intentarlo. Esa segunda frase es la que lo hace accionable: la
consecuencia no es adivinable desde «no se ha podido guardar». El default de `setBotActivoFn`
pasa a ser pesimista (`false` + log) por lo mismo — sin cablear no se aplica nada en ningún
sitio, así que anunciar éxito sería mentir dos veces.

`ejecutarAccion` se exporta como `_ejecutarAccion` para poder ejercitar el handler sin polling
ni red. Red: bloques C5 y D de `tests/config-escritura-verificada.test.js`; comprobado por
mutación (volver al fire-and-forget tumba D1; hacer que el fallo devuelva `true` tumba
C2/C5/D1/D2).

La familia que más daño ha hecho estos días: código que **dice que algo pasó sin comprobarlo**.
Se buscan tres formas concretas — escrituras que devuelven éxito sin mirar el error o las filas
afectadas, `catch` mudos, y mensajes al usuario que afirman un resultado antes de confirmarlo.

Ordenado por gravedad, no por flujo.

---

## 🔴 1 · El botón "enviar reseña" del panel no envía nada — y además lo impide para siempre

**RESEÑAS** · [`webhook.js:1077`](../webhook.js) + [`resenas/page.tsx:64`](../dashboard-app/src/app/(app)/resenas/page.tsx)

```js
app.post('/api/reviews/:appointmentId/send', async (req, res) => {
    await db.updateAppointment(orgId, req.params.appointmentId, {
        resenaEnviada: true, actor: `panel:${req.authUserId || 'desconocido'}`,
    });
    res.json({ ok: true });   // ← "send" no envía. Solo marca la casilla.
});
```

El endpoint se llama `send`, devuelve `{ok:true}`, y el panel canta **`toast.success("Reseña
enviada")`** y quita la fila de la lista. **No se manda ningún mensaje a la clienta.** No hay
llamada a WhatsApp por ninguna parte de esa ruta.

Y no se queda en un no-op inofensivo: `getCompletedAppointmentsForReview` filtra por
`resena_enviada = false` (db.js:2302). Al ponerlo a `true`, esa cita **desaparece también de la
cola del worker**. O sea que pulsar el botón es la forma más eficaz de garantizar que esa
reseña no se pida nunca — ni a mano ni automáticamente.

Es el caso más puro de la familia: afirma un resultado que ni siquiera se intentó.

**Cómo se ve desde fuera:** Yulia repasa "Reseñas pendientes", pulsa en cada una, la lista se
vacía con un ✅ por cada clic, y ninguna clienta recibe nada.

---

## 🔴 2 · Una campaña entregada puede contarse como fallida y reenviarse

**CAMPAÑAS** · [`broadcast.js:190-214`](../services/broadcast.js)

```js
noteSendResult(orgId, { ok: true });
resumen.enviados++;                       // ← se cuenta como enviado
if (claimId) {
    await db.finishBroadcastSend(orgId, claimId, { status: 'sent', ... });   // ← puede LANZAR
}
} catch (e) {
    resumen.omitidos++;                   // ← y ahora también como omitido
    ...
    if (claimId) { await db.finishBroadcastSend(orgId, claimId, { status: 'failed', ... })...}
}
```

`finishBroadcastSend` usa `assertRowsAffected`, o sea que **lanza** si el UPDATE no toca fila.
Está dentro del `try`, después de que el mensaje ya haya salido. Si lanza:

1. El contacto queda contado en **`enviados` y en `omitidos` a la vez** — el resumen que lee el
   operador al terminar la tanda no cuadra consigo mismo.
2. El claim se marca `'failed'` aunque el mensaje se entregó.
3. `resetStaleBroadcastClaims` **borra** los claims con `status='failed'` al empezar la
   siguiente tanda (db.js:1738-1739). El contacto vuelve a ser elegible.
4. **La clienta recibe la campaña por segunda vez.**

El `UNIQUE` de `broadcast_sends` está puesto justo para que esto no pase, y este camino lo
rodea: la fila que lo garantizaba se borró.

---

## 🟠 3 · Una reseña que se envía y no se marca se reenvía cada 5 minutos — ✅ ARREGLADO 06/08/2026

**RESEÑAS** · [`review.js:130-137`](../services/review.js)

```js
if (resultado === 'enviado') {
    await updateAppointment(orgId, apt.id, { resenaEnviada: true, actor: 'worker:review' });
    logger.info('resena_enviada', { orgId, nombre, telefono: phone });
}
```

`updateAppointment` **lanza** ante cualquier error de escritura (db.js:1296-1300). El `try` que
lo recoge está en el nivel de la ORG, fuera del bucle de citas. Consecuencia si falla la
escritura después de un envío correcto:

- El mensaje ya salió a la clienta.
- `resena_enviada` sigue en `false`.
- Se aborta el resto de citas pendientes de esa org en este tic.
- Al tic siguiente (5 min) la misma cita vuelve a estar pendiente → **se le vuelve a pedir la
  reseña**. Y otra vez. Cada cinco minutos, hasta que la escritura funcione.

El envío y su marcado no son atómicos y no hay compensación en el lado del envío. Es el
espejo exacto del `resena_enviada` que se marcaba antes de tiempo (arreglado en su día): ahora
el riesgo se ha movido al otro lado.

**Arreglo:** el marcado pasa por `marcarResenaEnviada`, que reintenta 3 veces, y lo que aun
así no se pudo apuntar queda en `enviadasSinMarcar` (Map en RAM, clave `orgId|aptId`) — el tic
siguiente ve la cita pendiente en BD, mira ese Map y reintenta el **marcado**, nunca el envío.
Si ni con reintentos se apunta, `alertOnce` avisa a una persona (throttle por cita). El
`try/catch` baja al nivel de la CITA: un fallo ya no aborta las demás de la org. El Map se poda
con las citas que dejan de estar pendientes. Mismo camino para el botón del panel, que dejaba
la cita pendiente y por tanto expuesta al reenvío del worker. Red:
`tests/resena-no-se-repite.test.js`.

**Límite conocido y aceptado**, el mismo de `admin-alerts` y del registro de campañas: el Map
vive en RAM, así que un reinicio entre el envío y el marcado permite una segunda petición. Se
asume porque la alternativa —persistirlo— es escribir la fila, que es justo lo que no se ha
podido hacer.

**El gemelo de `reminder.js` — ✅ ARREGLADO 06/08/2026.** Quedaba apuntado aquí y era **más
silencioso** que el original: `marcarRecordatorioSent` no lanzaba, hacía el UPDATE y devolvía
`true` sin mirar el error ni cuántas filas tocó. O sea que un marcado perdido no abortaba nada
—parecía ir bien— y el tic siguiente encontraba la ficha pendiente y le mandaba OTRO
recordatorio. Y otro. Sin un solo log, porque nada lo detectaba.

Dos piezas: `marcarRecordatorioSent` pasa a verificar con `assertRowsAffected` (ahora el fallo
existe), y `reminder.js` recibe el mismo tratamiento que las reseñas — reintentos, memoria en
RAM de lo entregado-sin-apuntar para reintentar el MARCADO en vez de reenviar, `alertOnce`, y
el `try/catch` bajado al nivel del contacto. La estructura se ha duplicado a propósito en vez
de factorizarla: son dos identidades (contacto vs cita), dos textos para Yulia y dos ritmos,
igual que `resolveChatId`, que ya vivía duplicado en los dos ficheros.

Red: `tests/recordatorio-no-se-repite.test.js`. Comprobado por mutación — con una salvedad que
el propio fichero documenta: el `try/catch` por contacto no lo distingue ningún test hoy,
porque el helper de reintentos no lanza nunca. Es cinturón sobre tirantes, no código medido.

---

## 🟠 4 · El sellado del importe puede fallar entero sin que nadie se entere — ✅ ARREGLADO 06/08/2026

**FACTURACIÓN** · [`db.js:2334-2340`](../services/db.js) y [`db.js:1445-1475`](../services/db.js)

```js
if (data?.length) {
    try {
        await stampBillingSnapshot(oid, data.map(a => a.id));
    } catch (e) {
        logger.error('error_snapshot_facturacion', { orgId: oid, error: e.message });
    }
}
```

Dos cosas, ninguna catastrófica pero las dos de la familia:

- **El `catch` no avisa a nadie.** Las citas quedan `completed` y sin importe congelado. El
  informe se degrada a recalcular desde el catálogo — que es la degradación documentada y
  correcta —, pero es exactamente el escenario contra el que existe el snapshot: si el
  catálogo sube de precio antes de que alguien mire, ese periodo se factura al precio nuevo y
  nadie sabrá que pasó. Un log que nadie lee no es un aviso; ahora que existe `alertOnce`, esto
  es candidato.
- **`stampBillingSnapshot` devuelve `n` y nadie lo mira.** Dentro hace `continue` por fila
  fallida (correcto: no inventa importes), pero el llamador no puede distinguir "sellé 10 de
  10" de "sellé 1 de 10". El valor de retorno existe y se descarta.

**Arreglo:** `stampBillingSnapshot` devuelve `{intentadas, selladas, fallidas}` y avisa ella
misma (`avisarSnapshotIncompleto`) en cuanto `fallidas > 0`; el `catch` de
`autoCompleteAppointments` y el de `webhook.js` avisan del caso en que ni se llegó a intentar.
Nada de esto propaga: la cita SÍ está completada y el panel merece su 200. Throttle por DÍA y
org, no por cita: esto es "el sellado está fallando", no una incidencia de una visita — y el
barrido tica cada 5 min. El mensaje explica la consecuencia real ("el informe pasa a calcular
con los precios de HOY"), que es lo único accionable. Red:
`tests/snapshot-facturacion-avisa.test.js`.

**Decisión de capa, y es discutible:** el aviso sale de `db.js`, que hasta hoy no avisaba de
nada. Va con un `require('./admin-alerts')` PEREZOSO porque admin-alerts arrastra
`telegram.js`, que requiere `db.js` — cargarlo arriba cierra el ciclo y telegram se queda con
las funciones de db a medio definir. La alternativa era sacar el sellado de
`autoCompleteAppointments` al worker, y eso rompe el acoplamiento deliberado "se congela en el
mismo momento en que la cita entra en la facturación".

---

## 🟡 5 · El único `catch` completamente mudo de los tres flujos — ✅ ARREGLADO 05/08/2026

**CAMPAÑAS** · [`broadcast.js:212`](../services/broadcast.js)

```js
await db.finishBroadcastSend(orgId, claimId, {
    status: 'failed', mode: modo, error: e.message,
}).catch(() => {});
```

Sin log, sin contador, sin nada. Si falla el registro del fallo, el claim se queda en
`pending` y `resetStaleBroadcastClaims` lo liberará por caducidad — o sea que el
comportamiento se recupera solo. Pero se pierde el único rastro de que la contabilidad de la
campaña se rompió, y este es justo el sitio donde ya sabemos que algo va mal.

**Arreglo:** cayó de paso con el punto 2 (`9778f63`). Ahora es un `try/catch` con
`campana_registro_fallo_no_guardado`.

---

## 🟡 6 · `noteSendResult` no se espera nunca — ✅ ARREGLADO 06/08/2026

**RESEÑAS** ([review.js:91, 95](../services/review.js)) y **CAMPAÑAS**
([broadcast.js:190, 206](../services/broadcast.js))

Es `async` y se llama sin `await` en los cuatro sitios. No lanza nunca (tiene su propio
`try/catch` interno), así que no hay promesa colgando sin manejar. Pero el aviso de canal caído
puede quedarse a medias si el proceso muere entre medias, y —más práctico— el orden entre el
aviso y el `return` del worker no está garantizado. Es el mismo patrón que el `await` que sí
se puso en `alertOnce` al arreglar los avisos que no llegaban.

**Arreglo:** `await` en los cuatro embudos, no solo en los dos que enumeraba el hallazgo. Los
que faltaban eran `reminder.js` (mismo par exacto que review) y los tres de `waSendMessage`
(`bot.js`), que es por donde pasa TODO el saliente de San Remo — dejarlos sin esperar habría
sido arreglar el aviso en los sitios donde menos tráfico hay. Los de campañas ya se habían
esperado al arreglar el punto 2.

---

## ✅ Lo que está bien, y conviene no romper

Para que esto no se lea como una lista de quejas: la mitad de lo que se buscaba **ya está
resuelto**, y con la verificación puesta a propósito.

- **`setManualPrice`** (db.js:1500-1510): `assertWrite` + devuelve `null` si no tocó fila, y el
  endpoint responde `404`. Es el modelo a seguir.
- **`getCompletedAppointmentsForBilling`**: propaga el error en vez de devolver `[]`, con el
  comentario "Es dinero: si la consulta falla NO devolvemos []". Un `[]` se habría leído como
  "0 € facturados".
- **`GET /api/facturacion`**: rechaza un `stylist` malformado con 400 en vez de ignorarlo —
  ignorarlo habría presentado el total de todas como el de una.
- **`buildStylistBillingReport`**: un importe que no se puede calcular cae a `sinCalcular` y se
  comunica como dudoso; nunca a `0,00 €` presentado como cifra buena.
- **`finishBroadcastSend`** e **`incrementVisitCount`**: `assertRowsAffected` / `assertWrite`.
  El problema del punto 2 no es esta función, es **dónde** se la llama.
- **`resolveAutomatedSend`**: fuera de ventana y sin plantilla, NO marca como enviado y deja
  que se reintente. Es la decisión correcta y la contraria a la del punto 1.

---

## El patrón, en una frase

Los tres agujeros graves tienen la misma forma: **el efecto externo (mandar un WhatsApp) y su
registro interno (marcar la fila) no son atómicos, y el código asume que si llegó al segundo
paso es que el primero valió** — o al revés, como en el punto 1, donde solo existe el segundo
paso y se presenta como si hubiera habido primero.

Donde se ha arreglado bien (los ✅) es donde alguien se preguntó explícitamente *"¿y si esta
escritura no toca ninguna fila?"*. Donde no, el éxito se da por hecho.

## Orden que propondría

1. **Punto 1** — es el único que ya está causando daño hoy, cada vez que alguien usa esa
   pantalla. Y es el más barato: o el endpoint envía de verdad (reutilizando
   `sendReviewMessage`), o el botón desaparece.
2. **Punto 2** — sacar `finishBroadcastSend('sent')` fuera del `try` del envío, o distinguir
   los dos fallos. Reenviar una campaña a una clienta se ve desde fuera.
3. **Punto 3** — reintentar el marcado, o mover el `try/catch` al nivel de la cita para no
   abortar el resto del tic.
4. **Puntos 4-6** — cuando toque; ninguno está sangrando.
