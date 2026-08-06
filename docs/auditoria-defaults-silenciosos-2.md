# Auditoría: defaults silenciosos, segunda vuelta

**Fecha:** 06/08/2026 · **Alcance:** SOLO INFORME. Nada arreglado, nada tocado.

La primera vuelta cubrió **duración** y **precio**, y dejó el patrón bueno montado:
`resolveAppointmentDurationMin` devuelve `{minutos, resuelto, via}` — o sea que quien la llama
puede distinguir «dura 60» de «no lo sé y he puesto 60». Esta segunda vuelta busca lo mismo en
el resto: **`|| valor` y `?? valor` que sustituyen un dato NO RESUELTO por una suposición**, sin
que ni la clienta ni la dueña ni el log puedan distinguir después una cosa de la otra.

Barrido: `bot.js`, `webhook.js`, `services/*.js`, `services/providers/*.js`. Un `|| ''` para
formatear texto o un `|| 0` para contar no entran: eso es higiene, no una suposición sobre un
dato del negocio.

Ordenado por gravedad. Cada hallazgo dice si **está disparando hoy** o es un cargador puesto.

---

## 🔴 1 · El idioma que el modelo NO dijo se guarda como OBSERVADO

**IDIOMA** · [`openai.js:1092`](../services/providers/openai.js) → [`bot.js:4555`](../bot.js)

```js
// openai.js — normalización de la respuesta del LLM (camino de ÉXITO)
parsed.idioma_detectado = parsed.idioma_detectado || 'es';
```
```js
// bot.js — y esto es lo que se hace con ese valor
if (aiResponse.idioma_detectado && aiResponse.idioma_detectado !== session.language) {
    session.language = aiResponse.idioma_detectado;
    session.languageSource = 'observed';   // ← «el modelo lo ha leído del mensaje»
    updateContactLanguage(orgId, leadId, session.language);   // ← y a la ficha
}
```

**El modelo omite el campo constantemente.** Medido sobre una corrida COMPLETA del arnés LLM
(06/08/2026, 21 escenarios): **18 de 67 respuestas del modelo (27 %) llegan sin
`idioma_detectado`**. Ejemplos literales del log:

```
{"respuesta":"Genial, cabello medio. ¿Tienes estilista de confianza o prefieres…"}
{"respuesta":"Con Irina trabaja martes, jueves y sábado. ¿Prefieres secado o peinado Dyson?"}
```

En esas 9 el `|| 'es'` fabrica un idioma que nadie ha detectado, y `bot.js` lo escribe en la
ficha marcándolo **`'observed'`** — la etiqueta que existe justo para decir *«de este me fío,
lo ha leído una persona o el modelo del mensaje real»*.

Dos consecuencias, y la segunda es la grave:

1. **Envenena la única señal que distingue lo sabido de lo supuesto.** El trabajo de
   `language_source` (05/08) se hizo para poder segmentar por `metadata->>'language_source'`.
   Un `'observed'` fabricado es peor que un `'default'` honesto: el `'default'` se ignora a
   propósito en el prompt (`idioma_ficha_por_defecto_ignorado`), el `'observed'` se cree.
2. **Le cambia el idioma a una clienta que no habla español.** La condición es
   `idioma_detectado !== session.language`, así que el caso que dispara es exactamente el de
   una clienta ya marcada en otro idioma: `'es' !== 'ru'` → se pisa. A 06/08 hay **184
   contactos de Sante en `ru` (inferido)** y 3 en `ru` observado. A una de ellas le basta un
   turno en el que el modelo omita el campo para quedar en `es`/`observed` — y entonces el
   recordatorio de 24 h, la petición de reseña y la plantilla de campaña le salen en español.

**Cómo se ve desde fuera:** una clienta que ha hablado en ruso toda la conversación recibe el
recordatorio en español, y en la ficha pone `es` con pinta de dato bueno. Nadie relaciona una
cosa con la otra.

**El gemelo, hoy contenido:** [`openai.js:963`](../services/providers/openai.js) monta el objeto
de FALLBACK con `idioma_detectado: language || 'es'` — o sea que cuando el LLM no ha contestado
en absoluto, el objeto afirma haber detectado español. No llega a escribirse porque `bot.js`
corta antes (`if (!aiResponse?.respuesta || aiResponse._isFallback) { … return; }`) y sustituye
la respuesta entera. Es un default muerto **que solo está muerto por un `return`**: si ese
camino cambiara, se escribiría como observado un idioma que nadie miró.

---

## 🟠 2 · «No sé qué largo tengo» → el bot elige medio, y no lo dice

**LARGO DEL PELO** · [`bot.js:3886-3891`](../bot.js)

```js
const idx = variantNum > 0 ? Math.min(variantNum - 1, candidates.length - 1)
          : largo != null  ? Math.min(largo - 1,      candidates.length - 1)
          :                  Math.min(1, candidates.length - 1); // default to Largo 2 (medium)
```

La tercera rama es la de `noSabe` — se activa con «no sé», «ni idea», «no estoy segura», «i
don't know», «не знаю». El bot **elige la variante 2 y sigue como si la clienta la hubiera
dicho**: no lo menciona, no lo pregunta de otra forma, y `session.largoPelo` se queda en `null`
mientras `selectedService` queda fijado. La variante decide **precio y duración**.

Lo que se está suponiendo, con el catálogo real de Sante (82 servicios, copia del 05/08):

| Categoría | Elige | Rango real |
|---|---|---|
| Alisado vegano | Medio · 260 € · 300 min | 210 – 310 € |
| Mechas Airtouch | Medio · 220 € · 360 min | 195 – 260 € |
| Mechas Balayage | Cabello medio · 190 € · 240 min | 180 – 230 € |
| Deco Total Blond | Medio · 145 € · 120 min | 125 – 175 € |
| Anti-encrespamiento | Medio · 160 € · 240 min | 120 – 180 € |
| Color Premium | Largo 2 · 100 € · 120 min | 90 – 110 € |

Peor caso medido: una clienta de pelo XL que dice «no sé» y quiere balayage se reserva como
«Cabello medio» — **40 € menos y 60 minutos menos de agenda** (XL son 300 min, medio 240). Los
60 minutos son lo caro: la cita siguiente se coloca encima.

Hay una segunda suposición en la misma expresión, más pequeña: `Math.min(largo - 1, …)`. Una
clienta que dice «muy largo» (nivel 4) en una categoría que solo tiene tres variantes cae en la
3 sin que se diga. Ahí no hay opción mejor —la 3 es la más cara y la más larga—, pero tampoco
queda rastro de que se ha redondeado.

**Disparando hoy: no observado.** De las 24 citas de Sante en `appointments`, las tres con
variante de largo son `Alisado vegano Largo 1`, `Color completo largo 1` y `Deco Total Blond
Corto`. Ninguna en la variante 2. El mecanismo es real; la muestra es pequeña y todavía no lo
ha cazado.

**El contraste que hace que esto sea un hallazgo y no una preferencia:** para la DURACIÓN, el
mismo sistema ya se negó a suponer — `assertDuracion` (`calendar-sante.js:400`) dice
literalmente *«esto es una aserción del contrato, no un rescate»*. Para el LARGO, que es de
dónde sale esa duración, se supone y punto.

---

## 🟠 3 · Un `horas_recordatorio` mal escrito manda el recordatorio a TODAS las citas futuras

**RECORDATORIOS** · [`reminder.js:198-220`](../services/reminder.js)

```js
const minutosAntes = minutosDb !== null ? Number(minutosDb)
                   : horasDb   !== null ? Number(horasDb) * 60
                   : 1440;
…
if (minutosRestantes < 0 || minutosRestantes > minutosAntes) continue;
```

Dos cosas distintas, y la segunda no es un default sino lo que el default tapa:

- **Sin ninguna de las dos claves en `config`, se inventa 1440** (24 h) y se manda. La misma
  situación en el worker de reseñas se resuelve al revés: `if (horasResena === null) continue`
  — sin configuración, no se hace nada. Las dos decisiones son defendibles; **las dos a la vez,
  no**: una org sin configurar recibe recordatorios y no recibe reseñas, y en ningún sitio
  consta que eso se decidiera.
- **`Number()` sobre un valor no numérico da `NaN`, y `NaN` desarma el filtro entero.**
  `getConfigValue` hace `JSON.parse` y, si falla, devuelve la cadena tal cual: un `24 horas` o
  un `veinticuatro` escritos a mano en la tabla pasan enteros. Y entonces
  `minutosRestantes > NaN` es `false`, o sea que **la guarda no descarta nada**. Comprobado:

  ```
  "24"          minutosAntes=1440   la salta (bien)
  "24 horas"    minutosAntes=NaN    → MANDA EL RECORDATORIO 45 DÍAS ANTES
  "veinticuatro" minutosAntes=NaN   → MANDA EL RECORDATORIO 45 DÍAS ANTES
  ```

  No hay ninguna otra red: `getLeadsPendientesRecordatorio` no acota por fecha (filtra por
  `estado='confirmado'`, `recordatorio_enviado=false` y `fecha_cita not null`), así que el
  único límite de «cuánto antes» es esta comparación. Un tic mandaría el recordatorio de
  **todas** las citas futuras de la org, las marcaría como enviadas y ya no habría recordatorio
  el día de antes.

**Disparando hoy: no.** Los dos valores en producción son numéricos (`minutos_recordatorio` =
`1440` en San Remo, `horas_recordatorio` = `24` en Sante). Es un cargador puesto y la dueña
edita config desde el panel.

---

## 🟠 4 · El panel y el worker no contestan lo mismo a «¿cuándo toca pedir la reseña?»

**RESEÑAS** · [`webhook.js:1084`](../webhook.js) y [`review.js:197`](../services/review.js)

```js
const appointments = await db.getCompletedAppointmentsForReview(orgId, horasResena || 0);
```

`horas_resena` ausente significa dos cosas distintas según quién pregunte:

| | Sin `horas_resena` |
|---|---|
| Worker (`checkAndSendReviews`) | `continue` — esa org no pide reseñas |
| Panel (`GET /api/reviews-pending`) | **0 horas** — toda cita completada sale como pendiente |
| Botón (`sendReviewForAppointment`) | **0 horas** — y con eso decide si la cita es «pendiente» |

**San Remo no tiene la clave** (comprobado en `config`: solo `bot_activo` y
`minutos_recordatorio`). Su pantalla de reseñas lista como pendientes citas que el worker no va
a tocar jamás. Hoy el botón falla limpio con `409 sin_enlace` porque San Remo tampoco tiene
`googleReviewLink` — o sea que lo que salva la situación es una segunda carencia, no una
decisión.

Y en una org que SÍ tenga enlace pero no la clave, el `|| 0` deja pedir la reseña **cero horas
después** de acabar la cita: la clienta aún está en el salón.

---

## 🟡 5 · El nombre del salón que se le dice a la clienta puede ser inventado

**TEXTO A LA CLIENTA** · [`reminder.js:208`](../services/reminder.js),
[`review.js:207,240`](../services/review.js), [`openai.js:240`](../services/providers/openai.js)

```js
const companyName = info.companyName || 'nuestro centro';      // reminder + review
const salonName   = info.companyName || 'Sante Healthy Hair Salon';   // prompt del salón
```

`getAgentConfig` **devuelve `null` sin lanzar** cuando la lectura falla y no hay copia cacheada
(está documentado y es deliberado: el contrato es config-o-null). Con `null`, el recordatorio
sale igual y dice *«Te recordamos tu cita en nuestro centro»*. El mensaje se manda, se marca
como enviado y no se reintenta nunca: el nombre no es una condición de envío.

Y en `openai.js` el fallback no es genérico sino **el nombre de una org concreta escrito en
código compartido**. Hoy da igual (solo hay un salón), pero es un default que se salta el
multi-tenant: un segundo salón cuya config no cargara se presentaría como Sante.

Comparar con lo que sí se hace bien al lado: `motivoNoEnviable` bloquea el recordatorio y avisa
a una persona si falta el NOMBRE DE LA CLIENTA. Falta el nombre del salón y sale igual.

---

## 🟡 6 · El tope de mensajes no es de la org: es de un fichero

**TOPE DE MENSAJES** · [`bot.js:3391-3394`](../bot.js)

```js
const maxMsg = orgType === 'salon'
    ? (config.conversation?.maxMessagesPerSessionSalon || 60)
    : (config.conversation?.maxMessagesPerSession || 30);
```

`config` es `config.json`, un fichero del repo — **no `agent_configs` ni `config` de Supabase**,
que es donde vive todo lo demás que la dueña puede tocar. Consecuencias:

- El tope es el mismo para todas las orgs de su tipo, y no hay forma de subirlo para una sola
  sin tocar el repo y desplegar.
- Los valores están hoy en el fichero (30/60), así que los literales del `||` están muertos.
  Pero son **otro par de números distintos escritos en otro sitio**: si alguien vacía la
  sección `conversation`, el tope cambia sin que nadie lo haya decidido.

Y lo que pasa al tocar el tope no es cosmético: se manda «nuestro equipo te atenderá enseguida»,
se apaga el bot para esa clienta y se abre una escalada. Un número supuesto decide eso.

---

## 🟡 7 · Una org desconocida es un restaurante

**MULTI-TENANT** · [`org-registry.js:73`](../services/org-registry.js)

```js
function getOrgType(orgId) { return byOrgId.get(orgId)?.type || 'restaurant'; }
```

Un `orgId` que no esté en el registry se comporta como San Remo: flujo Bizum, mock de mesas,
prompt de restaurante, sin la puerta de lista negra del salón (`bot.js:5335` y `5351` la gatean
por `=== 'salon'`). Es el mismo sitio donde `getOrgChannel` **sí** documenta su default y por
qué es el seguro («no silencia mensajes de una org que no esté en el registry»); dos líneas más
arriba, `getOrgType` no dice nada.

El default seguro para un tipo desconocido no existe —no hay un tipo neutro—, y por eso lo que
falta aquí no es otro valor: es un log. Hoy una org mal registrada se degrada a restaurante en
silencio absoluto.

**Disparando hoy: no.** Las dos orgs están en el registry y el `orgId` sale de ahí.

---

## 🟡 8 · El panel inventa 60 minutos donde el bot declara «no resuelta»

**DURACIÓN (coletilla de la primera vuelta)** · [`webhook.js:879`](../webhook.js)

```js
duracion: svc.duracion ?? 60,     // GET /api/service-catalog
```

Es la misma pregunta que la primera vuelta resolvió en `resolveAppointmentDurationMin`
(`{minutos, resuelto, via}`), contestada de la forma vieja en el endpoint que alimenta el
formulario de citas del panel. Un servicio sin `duracion` viaja al formulario como 60 min, el
formulario suma las filas y el `ends_at` que se guarda lleva ese 60 dentro sin marca.

**Disparando hoy: no.** Los 82 servicios del catálogo tienen `duracion > 0`. El único hueco del
catálogo es de PRECIO (`Consulta`, con `precio: null` a propósito — «se confirma en salón»), y
ese sí está bien tratado en toda la cadena.

---

## 🟡 9 · Defaults muertos que describen mal la configuración

**VARIOS** · [`openai.js:1013-1014, 1104`](../services/providers/openai.js)

```js
temperature: aiConfig.temperature ?? 0.5,     // config.json dice 0.7
max_tokens:  aiConfig.max_tokens  ?? 450,     // config.json dice 600
if (parsed.respuesta.length > (aiConfig.responseMaxLength || 280))   // config.json dice 1000
```

Ninguno se ejecuta: los tres valores están en `config.json`. Pero los tres literales **mienten
sobre lo que el sistema hace** a quien lee el código para enterarse, y el de 280 es el peor de
leer: sugiere que las respuestas se cortan a 280 caracteres, que es menos que casi cualquier
mensaje de propuesta de huecos. Si alguien recorta `config.json` alguna vez, el bot empieza a
truncar frases a media palabra.

---

## 🟡 10 · Una métrica que divide entre 1 cuando no hay nada que dividir

**MÉTRICAS** · [`metrics.js:72`](../services/metrics.js)

```js
const totalConversations = metricsCache.conversationStarted || 1;
```

Protege de la división por cero convirtiendo «no ha habido ninguna conversación» en «ha habido
una». Un día sin tráfico no sale como «sin datos» sino como un porcentaje calculado sobre una
conversación que no existió. Es el único de la lista que no afecta a ninguna clienta; entra
porque es exactamente la misma forma: un dato ausente presentado como un dato.

---

## ✅ Lo que ya distingue «resuelto» de «supuesto», y conviene no romper

- **`resolveAppointmentDurationMin`** — el modelo a seguir: `{minutos, resuelto, via}`. Quien
  llama puede decidir, y `bot.js:2222` lo aprovecha (`ancla_duracion_no_recibida` registra
  `resuelto` junto con los minutos usados).
- **`assertDuracion`** (`calendar-sante.js:400`) — se negó explícitamente a ser un tercer
  default: *«esto es una aserción del contrato, no un rescate»*.
- **`resolveLanguageSource` + `language_source`** — toda la maquinaria para no confundir un
  idioma observado con uno por defecto. El hallazgo 1 no la contradice: la usa mal un sitio.
- **`getAgentConfig`** — un error de lectura NO se cachea y devuelve la última copia buena; el
  default («ninguna config») no se congela 60 s.
- **`precio: null` de `Consulta`** — el catálogo tiene un hueco de precio a propósito y toda la
  cadena lo respeta hasta el «se confirma en salón». Es el ejemplo de que un dato ausente puede
  viajar entero sin que nadie lo rellene.
- **`isServiceActive`: ausente = activo** — un default declarado, escrito y con test. Un
  default explícito no es un default silencioso.

---

## Lo que NO se ha vuelto a mirar (ya tiene dueño)

- **El `120` de `saveAppointment`/`updateAppointment`** (`db.js`): es la duración de las mesas
  de San Remo y está **pendiente de decisión de Joan**, con parche probado y aparcado por la
  Regla de oro. No se re-audita.
- **`service: servicio || 'Reserva'`** (`db.js:1159`): ya documentado como el molde de la cita
  fantasma; hoy inalcanzable porque los tres puntos de entrada están gateados por
  `selectedService`. Ver `docs/escenario-3-servicio-sin-resolver.md`.
- **`contacts.language` = `'es'` por defecto en el INSERT**: es la decisión documentada en
  CLAUDE.md, con su `language_source` al lado. Lo que el hallazgo 1 denuncia no es ese default
  sino que otro sitio lo disfrace de observación.

---

## El patrón, en una frase

La primera vuelta dejó dicho que **un dato no resuelto tiene que poder viajar como no resuelto**.
Donde eso se hizo (duración) hay una función que devuelve `resuelto: false` y un `assert` que se
niega a inventar. Donde no se ha hecho, el `||` no es una red: **es una respuesta inventada que
después nadie puede distinguir de una buena** — y en los dos casos más caros de esta lista
(idioma, largo) la suposición no solo se usa, se **guarda y se etiqueta como sabida**.

## Orden que propondría

1. **Hallazgo 1** — es el único que ya está corrompiendo datos hoy, en cada conversación, y
   además estropea la señal que se construyó para medir esto mismo. Y es barato: el arreglo es
   no fabricar el campo (`parsed.idioma_detectado ?? null`) y que `bot.js` no escriba nada
   cuando no venga.
2. **Hallazgo 2** — toca dinero y agenda, y la salida no es un default mejor: es preguntar otra
   vez o marcarlo para que la dueña lo confirme al llegar la clienta.
3. **Hallazgo 3** — validar el número y decidir de una vez qué significa «sin configurar», igual
   para los dos workers.
4. **Hallazgo 4** — que el panel y el worker lean la misma regla.
5. **5-10** — cuando toque; ninguno está sangrando.
