<!--
  ESTE DOCUMENTO ES UNA FOTO DEL 13/08/2026 — el brief de diseño del enlace público de
  reserva, tal como se escribió aquel día. NO se reescribe: como foto vale. Lo que ha
  quedado superado desde entonces está marcado EN EL PUNTO EXACTO con bloques
  «⚠️ SUPERADO/HECHO/DECIDIDO», y resumido aquí:

    · Código por WhatsApp (identidad, control nº1 de abuso) ..... DESCARTADO por Yulia, 19/08
    · Alcance v1 «lista corta de categorías» .................... SUPERADO: todos los servicios
      menos los que el bot no resuelve, con marca `solo_complemento` que confirma Yulia
    · «appointments sin UNIQUE ni EXCLUDE» / claim pendiente .... HECHO: migración 043 APLICADA
      el 19/08 (version 20260819203018), probada con scripts/prueba-claim-concurrente.js
    · D1 (dedupe) y D4 (bloqueo multi-día) «bloqueantes» ........ ARREGLADOS en ed60d7b (13/08)
    · «el worker de 24 h lee contacts» .......................... SUPERADO 14/08: el salón lee
      la CITA; la migración 042 está APLICADA (14/08 11:29 UTC)
    · Plantillas de Meta como camino crítico .................... YA NO EXISTE: la v1 sale con
      CERO plantillas nuevas (decisión 19/08)
    · Horizonte 30 días / antelación ~2 h ....................... DECIDIDO por Yulia: 3 meses
      y 1 hora

  La continuación de este documento es el PLAN del 19/08/2026 (aprobado, en la sesión de
  ese día) y el commit 49eac6c (claim atómico + prueba de concurrencia). Ante cualquier
  contradicción entre esta foto y la BD, manda la BD — la lección de la cabecera de la 042.
-->

# Brief — Enlace público de reserva (Sante)

## Context

La dueña quiere un enlace público donde las clientas reserven solas, conectado con
la agenda viva: si entra una cita por el panel o por el bot, el enlace lo sabe al
momento.

Esto es un **brief de diseño**, no un plan de implementación. Nada está decidido
salvo las cuatro respuestas de abajo. No se escribe código hasta que el brief se
apruebe.

Decidido en esta sesión:

| | |
|---|---|
| Identidad | **Código por WhatsApp** antes de escribir la cita |
| Dónde vive | **Subdominio del panel** (`reservar.ceromanual.es`), Next.js ya desplegado |
| Alcance v1 | **Lista corta de categorías** que elige la dueña |
| Solapes del panel | **Avisar, no bloquear** |

> ⚠️ **[SUPERADO 19/08/2026]** De estas cuatro decisiones, dos cayeron con las respuestas de Yulia: el **código por WhatsApp está DESCARTADO** (sin verificación de teléfono; el anillo anti-abuso se redimensionó entero en el plan del 19/08) y la **lista corta** pasó a ser *todos los servicios menos los que el bot no resuelve*, con la marca `solo_complemento` que confirma Yulia. «Dónde vive» y «avisar, no bloquear» siguen vigentes.


---

## Lo que dicen los datos (medido contra Supabase hoy, 13/08/2026)

Esto reordena las prioridades, así que va primero.

**El enlace no sería el tercer escritor. Sería el segundo real, y el primero sin
nadie mirando.**

| | |
|---|---|
| Citas activas con estilista | **58** |
| — creadas desde el panel (`source='manual'`) | **57** |
| — creadas por el bot (`source='bot'`) | **1** |
| Citas futuras | 18 · la más lejana **29/08** (16 días) |
| Contactos | 752 · **0 teléfonos duplicados** |
| Catálogo | 81 entradas · 22 categorías · 1 sola con `precio: null` (Consulta) |

El bot ha producido **una** cita completada en toda la historia de la tabla (más 3
canceladas). La agenda la escribe la dueña a mano, entera. Eso es a la vez el
argumento a favor del enlace —le quita trabajo manual— y el aviso: **no hay
experiencia operativa de citas que entren solas.**

**Y el salón solapa a propósito.** Hay 7 pares de citas superpuestas sobre la misma
estilista, en 5 días distintos, **todos `source='manual'`**, ninguno del bot:

- 4 son solapes de borde (≤20 min): una cita que se alarga sobre la siguiente.
- 1 es de más de una hora — Yulia, 11:00–14:35 sobre 08:00–13:30, dos clientas
  distintas. Eso no es un despiste: es una colorista atendiendo dos cabezas
  durante el tiempo de exposición.
- **Uno está en el futuro**: mañana 14/08, Olga, dos clientas distintas
  solapando 15:00–15:30 (Manicura+gel y Pedicura+esmaltado). Conviene mirarlo
  al margen de este proyecto.

Consecuencia de diseño, y es la que manda sobre toda la sección 2: **una restricción
global «no se puede solapar» es la respuesta equivocada.** No se podría ni aplicar
(7 filas la violan hoy) y le prohibiría a la dueña trabajo que hace de verdad.

---

## 1 · EL FLUJO

### El principio

Una conversación tiene que *adivinar* lo que la clienta quiere; un formulario puede
**enseñárselo**. Casi toda la maquinaria del bot (`extractLargoPelo`,
`detectLargoCategory`, `classifyLargoVariant`, los typos de balayage) existe para
resolver texto libre. El enlace no recibe texto libre, así que **no debe heredar esa
maquinaria: debe hacerla innecesaria.**

Esto no es un atajo, es más seguro. Hoy, cuando la clienta dice «no sé» el largo,
`bot.js:4808` cae **al nivel 2 (medio) por defecto** — y ese nivel fija un precio que
se le comunica como cifra buena. En un formulario con las cuatro variantes y sus
cuatro precios delante, ese default deja de existir.

### El orden

```
1. Familia          6 grupos, no 22 categorías ni 81 entradas
2. Servicio         dentro de la familia, con precio y duración
3. Variante         SOLO si la categoría tiene varias — y se enseñan TODAS con su precio
4. Estilista        «la primera que haya» por defecto · o una concreta
5. Día y hora       del motor real
6. Nombre + teléfono
7. Código por WhatsApp → confirmar
```

> ⚠️ **[SUPERADO 19/08/2026]** El paso 7 desaparece: el código por WhatsApp está descartado. El flujo termina en la pantalla de confirmación con el tic verde.


**Por qué la variante se enseña y no se pregunta.** El catálogo no tiene un campo
`largo`: el nivel se infiere del texto del nombre (`classifyLargoVariant`,
`helpers.js:2967`), y hay **dos convenciones conviviendo** —Airtouch usa
`Corto/Medio/Largo/XL`, Balayage usa `Cabello corto/medio/largo` + `XL / cambio
importante`—. Enseñar las cuatro filas tal como están en el catálogo, con sus cuatro
precios, evita interpretar nada:

```
Mechas Balayage — ¿cuál es tu caso?
  Cabello corto ............ 180 €   ·  4 h
  Cabello medio ............ 190 €   ·  4 h
  Cabello largo ............ 200 €   ·  4 h
  XL / cambio importante ... 230 €   ·  5 h
  No estoy segura  →  te lo miramos en el salón   [escribir por WhatsApp]
```

**Cuidado con «Mechas clásicas»: sus variantes NO son el largo.** `Mechas 1 / 2 / 3`
(60/80/100 €) son cantidad de cobertura. Un formulario que pregunte «¿qué largo
tienes?» para todas las categorías con variantes mentiría en esa. El texto de la
pregunta tiene que salir de la categoría, igual que ya hace el prompt
(`openai.js:511-536`).

**Y el precio que se enseña es el que se congela.** El importe que lee la clienta se
guarda en la cita, no se recalcula al cobrar. Es la decisión que ya está tomada en
seguimientos y por el mismo motivo: recalcular reabre la discusión en el mostrador
por un redondeo.

### Lo que hoy solo sabe resolver una conversación

Las tres se resuelven igual: **el formulario reconoce que no es lo suyo y pasa el
turno al bot**, con un botón que abre WhatsApp con el mensaje ya escrito
(`wa.me/34641029104?text=…`). Cero maquinaria nueva, y aterriza en el sitio que sí
es bueno en eso.

| Caso | Qué hace el enlace | Por qué |
|---|---|---|
| **«No sé qué quiero»** | Botón «No lo tengo claro, que me asesoren» → WhatsApp | La **Consulta** es `reactive-only` (`helpers.js:3142`) *por diseño*: el bot tiene prohibido ofrecerla por iniciativa propia desde el incidente del 02/08. Un formulario público que la ponga en un desplegable es exactamente lo que esa regla prohíbe. **Consulta fuera de la v1.** |
| **«Vamos dos»** | Botón «Somos dos o más» → WhatsApp | El motor **ni siquiera puede ver** si hay dos estilistas libres a la misma hora: el dedupe las colapsa (defecto D1). Y `saveAppointment` funde dos citas del mismo contacto a la misma hora devolviendo la primera como si fuera nueva (D6). Es la misma decisión ya tomada el 13/08 para el bot. |
| **«Quiero algo relajante»** | Se resuelve navegando: familia «Masajes y SPA» con descripción y precio | No es una consulta, es un catálogo mal presentado. Se arregla con las 6 familias del paso 1, sin NLP. |

**Extensiones, permanente y salida de negro** no entran: no están en el catálogo y ya
escalan a una persona (`detectConsultaService`, `helpers.js:3113`). Tetiana lleva
agenda manual por decisión.

---

## 2 · LA CONCURRENCIA

### El estado real

- **`appointments` no tiene ni un solo `UNIQUE` ni `EXCLUDE`.** Verificado contra
  `pg_indexes`: solo la PK y cuatro índices no únicos.

> ⚠️ **[HECHO 19/08/2026]** La migración **043 está APLICADA** (version `20260819203018`): `btree_gist` + EXCLUDE parcial sobre (org, estilista, rango) limitado a `bot`/`web`, y `reservar_hueco()` como único camino de escritura web. Probada con 12 reservas concurrentes y 2 mutaciones vistas en rojo (`scripts/prueba-claim-concurrente.js`, commit `49eac6c`).

- La guarda de `saveAppointment` (`db.js:1264-1284`) **no es una guarda de
  capacidad**. Su clave es `(org, contact_id, starts_at)`: sirve para que un
  reintento del *mismo* contacto no duplique. Dos clientas distintas pidiendo a
  Irina las 17:00 pasan las dos sin que nada las mire.
- Y **no es atómica**: es un `SELECT` y luego un `INSERT`. Dos peticiones
  simultáneas leen las dos `null` e insertan las dos. El comentario la llama
  «backstop a nivel de datos» y a nivel de datos no hay nada detrás.
- La única defensa hoy es que `getAvailableSlots` no ofrezca el hueco, más una
  reverificación en `bot.js:3637-3649` que es un TOCTOU con la ventana abierta.

### El patrón ya está escrito en este repo, dos veces

No hay que inventar nada. `broadcast_sends` (migración 027) y `seguimientos`
(migración 041) implementan el mismo molde, con la justificación escrita en la
cabecera del propio `.sql`: *«El UNIQUE es la garantía de verdad, no el SELECT
previo»*.

```
índice UNIQUE parcial  →  INSERT como claim  →  23505 = perdiste, no es error
                                             →  política explícita de claims muertos
```

Y `increment_visit_count` (migración 022) es el precedente de mover a Postgres un
read-modify-write que perdía escrituras concurrentes — nacido del mismo escenario:
dos escritores a la vez.

### La propuesta: tres capas, y la de en medio es la que importa

**Capa 1 — `reservar_hueco()`, función SQL, único camino del enlace.**

`SECURITY DEFINER`, molde de `increment_visit_count`. Hace en **una** transacción:

1. `pg_advisory_xact_lock(hashtext(org || stylist_id || fecha))` — serializa solo
   las escrituras sobre la misma estilista el mismo día. Se suelta al commit. Sin
   esto, bajo `READ COMMITTED` un `INSERT … WHERE NOT EXISTS` **no ve** la fila que
   la otra transacción aún no ha comiteado, y ganan las dos.
2. Reverifica lo que es dato puro: que no haya cita activa solapada de esa
   estilista, que no caiga en `schedule_blocks`, que esté dentro de una franja de
   `stylist_schedules` para ese día.
3. Inserta con `source = 'web'`.
4. Devuelve la fila, o **NULL si perdió la carrera**.

`NULL` no es un error: es «se acaba de ocupar», y la página lo dice con esas
palabras y recarga los huecos. Nunca un default silencioso.

**Dónde va la raya, que es la parte discutible.** La función SQL comprueba solo *«¿el
hueco físico está libre?»*. La skill, la duración y la resolución del servicio se
quedan en JS **antes** de la llamada. Duplicar esas reglas en SQL sería crear la
segunda versión del motor que la pregunta 3 prohíbe.

**Capa 2 — un `EXCLUDE` parcial que sí se puede aplicar.**

`btree_gist` está disponible en el proyecto (v1.7, sin instalar). La restricción que
**se puede aplicar hoy sin romper nada**:

```
EXCLUDE USING gist (
  organization_id WITH =, stylist_id WITH =,
  tstzrange(starts_at, ends_at) WITH &&
) WHERE (source IN ('bot','web') AND status <> 'cancelled' AND stylist_id IS NOT NULL)
```

Medido: **0 solapes existentes involucran a `bot` o `web`**, así que aplica limpio.
Y **no toca ni una fila del panel**, que es lo que la hace viable. Cubre web-vs-web y
web-vs-bot, que es exactamente el miedo de la pregunta.

Es la lección de Celeste González: la guarda vive *dentro*, para que un camino nuevo
no pueda reabrirla.

**Capa 3 — el panel avisa.**

Al guardar una cita que solapa: *«Veronika ya tiene a alguien a esa hora. ¿La pones
igual?»*. No bloquea. Convierte 7 solapes de origen desconocido en solapes
deliberados, que es la única forma de que el dato signifique algo.

### Lo que NO hay que construir

**Nada de reservas temporales con caducidad.** Un carrito que retiene el hueco 10
minutos es una tabla más, un worker de expiración más y una clase nueva de bug
(huecos retenidos por sesiones muertas). Con 18 citas futuras en total, la
probabilidad de colisión real es despreciable, y el claim atómico + «se acaba de
ocupar, mira estos otros» cubre el caso honestamente. **v2 si el volumen lo pide.**

---

## 3 · QUÉ SE REUTILIZA

La regla: **el enlace no añade ni una línea de lógica de disponibilidad.**

| Pieza | Dónde vive | Cómo se usa |
|---|---|---|
| `getAvailableSlots` | `services/calendar-sante.js:56` | La **misma llamada** que hace el bot, mismo `preferencia`. |
| `offerableCatalog` · `isServiceActive` · `isReactiveOnlyService` | `helpers.js:3180 / 3171 / 3148` | Filtro **en el call site**, nunca dentro de un resolver. |
| `resolveAppointmentDurationMin` | `helpers.js:2404` | El `resuelto:false` bloquea la reserva; no se reserva con una duración inventada. |
| `buildFullServiceName` | `helpers.js:1292` | Con el catálogo **completo** (cuenta homónimos). |
| `serviceCatalogKey` (`categoria\|nombre`) | `helpers.js:4177` | La clave del formulario. `nombre` a secas no vale: «Corto» existe 4 veces entre 120 € y 210 €. |
| `formatSlotTexto` | `helpers.js` | Etiqueta del hueco en es/en/ru/uk, con la tabla de días compartida. |
| `db.saveAppointment` | `db.js:1234` | **Sigue siendo el único camino de creación.** `reservar_hueco()` se llama *desde dentro*, en la rama `source:'web'`. Dos caminos de creación es el patrón de Celeste González. |
| `auditAgenda` | `tests/lib/agenda-audit.js:59` | Puro y ya probado; el pre-vuelo «¿esto cabe?». |
| `GET /api/service-catalog` | `webhook.js:1361` | El catálogo del formulario sale **de aquí**, nunca de un JSON copiado. |

**Ese último punto es una trampa ya documentada en el repo**: hay tres ficheros de
catálogo (fixture + dos backups), los tres con 81 entradas, **y ninguno es el vivo**.
El 13/08 esa confusión produjo un diagnóstico falso. Un cuarto en una página pública
sería el peor de todos, porque lo que llevaría escrito es el **precio que lee la
clienta**.

**La protección estructural: un test de paridad.** Mismo `preferencia` → el camino web
y el camino bot devuelven **la misma lista de huecos**. Molde:
`tests/service-names-parity.test.js`. Es la respuesta del repo a «si divergen».

### Los siete defectos del motor que hay que arreglar ANTES de publicarlo

Salieron al explorar. En una conversación se disimulan porque hay una persona
mirando; en un enlace público se convierten en dinero perdido y en la clienta
plantada.

| # | Defecto | Efecto en el enlace |
|---|---|---|
| **D1** | El dedupe agrupa por `fecha-hora` **sin estilista** (`calendar-sante.js:300-306`). Como `getStylistsByOrg` ordena `.order('name')`, **gana siempre la alfabéticamente primera**. | Con 4 generalistas de skills idénticas, el enlace publicaría ~**1/4 de la capacidad real** y fabricaría colisiones que no existen. Una estilista puede quedar **inofrecible por completo**. Además `bot.js:603-608` cuenta estilistas *después* del dedupe y auto-asigna una que la clienta no eligió. |
| **D2** | `buildStartsAt` (`db.js:1218`) usa la hora **local del proceso**, no `BUSINESS_TZ`. Única discontinuidad de zona horaria del camino de escritura. | Un proceso fuera de `Europe/Madrid` guarda el instante equivocado, y aquí ya no hay nadie leyéndolo. |
| **D3** | `computeFreeSlots` usa `t + dur < workEnd` **estricto** (`:405`). | Se pierde el último hueco legítimo de **cada jornada**. |
| **D4** | Bloqueo **multi-día** → intervalo invertido `{start:1080, end:600}` (`calendar-sante.js:226-233`). | Unas vacaciones cargadas como un bloque largo dejan **los días intermedios completamente abiertos**. El enlace las regalaría. |
| **D5** | El diagnóstico de cero no mira bloqueos ni preferencias (`:322-340`). | Dice «está todo cogido» cuando es mentira. |
| **D6** | `saveAppointment`: clave `(org, contact, starts_at)`, check-then-insert, `.maybeSingle()` que **explota si ya hay dos filas**. | Sección 2. |
| **D7** | Prefetch **N+1 secuencial**: 6 estilistas × 3 `await` en serie = 18 viajes por carga (`:116-123`). | El bot lo llama 2 veces por turno; un formulario público lo llama en cada clic. |

**D1 y D4 son bloqueantes.** D2, D3, D6 van en el mismo lote. D5 y D7 pueden esperar.

> ⚠️ **[ARREGLADOS 13/08/2026]** D1 y D4 se arreglaron en `ed60d7b`, tres horas después de escribir este brief. D6 lo cubre la 043 para el camino web. D2, D3 y D7 siguen pendientes con su reparto en el plan del 19/08 (D7 pasó a obligatorio al subir el horizonte a 3 meses).


---

## 4 · LA IDENTIDAD

Punto de partida bueno: `contacts` **ya tiene un `UNIQUE (organization_id, wa_phone)`**
y hoy hay **0 teléfonos duplicados** en 752 fichas. El teléfono ya es la clave de
identidad y la BD ya serializa el alta concurrente del mismo número. No hace falta
inventar nada.

**Decidido: código por WhatsApp antes de escribir la cita.**

> ⚠️ **[DESCARTADO 19/08/2026]** Yulia dijo NO al código. La postura que ordena el resto: «lo importante es que reserven, después yo modifico y les aviso». Las demás reglas de esta sección (no saludar por nombre, ficha nueva por `saveLead`, lista negra con mensaje neutro) **siguen vigentes**.


- Se pide **al final**, justo antes de confirmar — nunca antes de enseñar precios y
  huecos. Un formulario que pide verificación por delante no convierte a nadie.
- Es la misma pieza que resuelve la mitad de la sección 6: prueba que el número
  existe, que es suyo y que hay una persona.
- **Dependencia con plazo: hace falta una plantilla de utilidad aprobada por Meta.**
  Días de espera, y no depende de nosotros. Es el camino crítico del proyecto:
  **empezar por ahí.**

Las reglas que van con ello:

- **No se enseña lo que se ha encontrado.** Si el teléfono casa con una ficha, la
  página **no** saluda por su nombre. Eso filtraría el nombre de una clienta a
  cualquiera que teclee su número. La dueña ve el cruce en el panel; la clienta, no.
- **Ficha nueva**: se crea por el camino de siempre (`saveLead`), con `origen: 'web'`.
- **El idioma que elige en el desplegable es un dato declarado**, y no encaja en los
  tres valores que hoy tiene `language_source` (`observed | inferred | default`).
  `'observed'` significa dos mensajes que coinciden y explícitamente *no* lo escribe
  una centralita — un desplegable tampoco. Propongo **añadir `'declared'`** y tocar
  `resolveLanguageSource` y el backfill 034 a la vez, para que el campo siga siendo
  honesto. *Decisión abierta.*
- **Lista negra**: la cita **no se escribe**, y la página dice algo neutro («no
  podemos confirmarlo online, llámanos»), nunca «estás bloqueada» — y con el mismo
  tiempo de respuesta que los demás fallos, para que no se distinga por el reloj. En
  el salón el bloqueo es silencio; una página tiene que renderizar algo, así que la
  traducción es esa.

---

## 5 · QUÉ PASA DESPUÉS

**La cita tiene que ser indistinguible de cualquier otra.** La columna `source` ya
existe (migración 005, default `'bot'`): basta con `'web'`. Más `updated_by = 'web'`
para que la auditoría de la 033 lea bien.

**Y hay un paso que es fácil olvidar y rompe el recordatorio:** el worker de 24 h lee
**`contacts`, no `appointments`** (`db.js:564`). Una cita web que no sincronice
`fecha_cita` / `hora_cita` / `estado` en la ficha **no genera recordatorio**. El panel
ya lo hace (`webhook.js:897`); el enlace tiene que hacer lo mismo.

> ⚠️ **[SUPERADO 14/08/2026]** Este párrafo dejó de ser verdad al día siguiente del brief: el recordatorio del salón cuelga ahora de la **CITA** (`getCitasPendientesRecordatorio`), no de la ficha, y la migración **042 está APLICADA** (14/08 11:29 UTC). Una cita web genera recordatorio sin sincronizar la ficha.


`motivoNoEnviable` (`reminder.js:127`) exige nombre usable, teléfono y hora. El
formulario garantiza los tres — que de hecho es **mejor** que el estado actual, donde
existe `informe:nombres` precisamente porque faltan nombres.

**Los envíos van por `resolveAutomatedSend` (`outbound.js:75`), no por un emisor
nuevo.** Una reserva web está por definición **fuera** de la ventana de 24 h (la
clienta no ha escrito), así que es siempre el camino de plantilla.

Plantillas necesarias, las dos con espera de aprobación:

| Plantilla | Para qué | Estado |
|---|---|---|
| código de verificación | sección 4 | **nueva — camino crítico** |
| confirmación de reserva | «tu cita queda el …» | **nueva** |
| `sante_recordatorio_cita` | recordatorio 24 h | ya aprobada, sirve sin tocar |

> ⚠️ **[SUPERADO 19/08/2026]** La v1 sale con **CERO plantillas nuevas**: el código está descartado y la confirmación se da en pantalla. La clienta recibe solo el recordatorio de 24 h, con la plantilla ya aprobada. No hay espera de Meta.


El «cuándo» de la confirmación se formatea con **`formatReminderWhen`**, el mismo que
el recordatorio. No se escribe un segundo formateador: la tabla de días a mano existe
porque el ruso y el ucraniano piden acusativo detrás de la preposición, y con dos
tablas el mismo miércoles saldría de dos formas a la misma clienta.

Ojo con `sanitizeTemplateParam` (`threesixty-dialog.js:75`): un nombre de servicio con
un salto de línea hace que Meta rechace **el mensaje entero** (132000).

**Aviso a la dueña por Telegram en cada reserva web**, al menos las primeras semanas.
Una cita que entra sin que nadie la vea llegar debería anunciarse. Con `notify`
normal, no `alertOnce` (que dedupe por asunto), y **sin** que un fallo de Telegram
tumbe la reserva.

**Los cuatro idiomas desde el día uno.** `formatSlotTexto` y `formatReminderWhen` ya
cubren es/en/ru/uk y las tablas están escritas. Una clienta rusa contra un formulario
solo en castellano es el fallo de Nora Benedikte otra vez, y aquí sale barato
evitarlo.

---

## 6 · EL RIESGO DE ABUSO

Punto de partida: **no hay rate limiting en ninguna parte de `webhook.js`** — ni en
`/api`, ni en el webhook público, ni en `POST /api/caja/sesion`, que es un PIN de 4-6
dígitos. Y todo lo que cuelga de `/api` exige JWT, así que **las rutas públicas tienen
que vivir fuera de `/api`**, con el precedente que ya existe:
`/webhook/360dialog/:token`.

| # | Control | Por qué |
|---|---|---|
| 1 | **Código por WhatsApp** (sección 4) | El control principal. Todo lo demás es secundario. |
| 2 | **Rate limit por IP y por teléfono**, sobre todo en el envío de código | Es el endpoint que **cuesta dinero por llamada**. Orden de magnitud: 5/hora/IP, 3/día/teléfono. |
| 3 | **Tope de citas futuras abiertas por contacto** (2) | Barato, y también corta el doble-reserva de buena fe. |
| 4 | **Horizonte de reserva** (30 días) | Hoy la cita más lejana real está a 16 días. Sin tope, alguien reserva 200 huecos de 2027. |
| 5 | **Antelación mínima** (~2 h) | Que a la dueña le dé tiempo a verla. Editable por ella. |
| 6 | **Lista negra antes de escribir** | Sección 4. |
| 7 | **`notas` acotado, solo al panel** | Nunca interpolado en un parámetro de plantilla. |
| 8 | **Turnstile en el envío de código** | Invisible y estándar. Opcional si 1 y 2 están. |
| 9 | **Alerta por ráfaga** (N reservas en M minutos) | Con el `logger` que ya existe. |

> ⚠️ **[SUPERADO 19/08/2026]** El control nº1 (código por WhatsApp) está descartado, así que esta tabla ya no describe el anillo real: se redimensionó entero en el plan del 19/08 (rate limit en RAM en Express, topes durables en SQL dentro de `reservar_hueco()`, techo global por org e interruptor `reservas_web_activo`). Los controles 4 y 5 los decidió Yulia: horizonte **3 meses** y antelación **1 hora**.


**Tres agujeros que ya están abiertos hoy** y que este proyecto agrava, así que van en
el mismo lote:

- **`GET /api/wa-status` está registrado ANTES del middleware de auth**
  (`webhook.js:89` vs `:209`) → hoy es **público** y filtra los slugs de las orgs y su
  estado de conexión.
- **`PATCH /api/agent-config` escribe `req.body` sin validar** (`webhook.js:1345`),
  a diferencia de `PUT /api/config/:clave`, que sí valida. Es el endpoint que reemplaza
  el catálogo entero.
- **`updateLeadById` escribe `wa_phone` sin `sanitizePhone`** (`db.js:116`) — origen
  documentado de contactos duplicados. Con un formulario público metiendo teléfonos,
  esto deja de ser teórico.

---

## 7 · DÓNDE VIVE

**`reservar.ceromanual.es`**, página del Next.js que ya existe (`dashboard-app/`,
Next 16 + React 19, desplegado en Vercel).

Por qué:

- La app ya está desplegada, ya habla con la API y ya tiene contexto de org.
- Mismo origen para las llamadas → **no hay que ampliar la allowlist de CORS**
  (`webhook.js:23-28`).
- Un enlace se pega en cualquier sitio: web del salón, bio de Instagram, Google
  Business, perfil de WhatsApp. Si vive dentro de la web del salón, el deploy lo
  controla quien lleve esa web y el catálogo acaba copiado allí.

**Cuidado con `proxy.ts`** (`dashboard-app/src/proxy.ts:1-34`): en Next 16 es lo que
sustituye a `middleware.ts` y **redirige a `/login` todo lo que no sea `/login` ni
`/api/auth`**. La ruta pública hay que añadirla ahí explícitamente. Y ojo con
`NEXT_PUBLIC_DEV_SKIP_AUTH`, que hoy deja pasar todo sin sesión.

**Multi-tenant en la ruta desde el principio** (`/reservar/:slug`) pero **v1 solo para
Sante**, gateado por `getOrgType(orgId) === 'salon'` estructuralmente, no por config
vacía. San Remo no se toca.

**Qué configura la dueña**, desde Configuración, y nada más:

- interruptor de encendido
- **qué categorías salen al enlace** (la lista corta)
- horizonte de reserva y antelación mínima
- los nombres de las dos plantillas nuevas — en `config`, junto a
  `plantilla_recordatorio` y `plantilla_resena`, no en el código

Todo lo demás **deriva** de datos que ella ya edita: horarios, skills, catálogo,
precios. Ni un segundo catálogo, ni un segundo horario. Es la regla 5 aplicada a la
superficie nueva.

*(Nota: hoy la pantalla de Configuración del salón no expone `business_info` — ese
bloque está gateado a restaurante. Habrá que abrir un hueco para estos ajustes.)*

---

## Qué NO haría en la primera versión

| Fuera | Por qué |
|---|---|
| **Pagos / señal** | Cambia política de cancelación, devoluciones y caja. El salón hoy no cobra por adelantado. |
| **Reservar para dos** | El motor no puede ver dos estilistas a la vez (D1) y `saveAppointment` funde las dos citas (D6). Misma decisión que el 13/08. |
| **Consulta / valoración** | Es `reactive-only` por diseño; el bot tiene prohibido ofrecerla. |
| **Cancelar y cambiar desde el enlace** | Mover una cita es donde de verdad viven los bugs de doble reserva, y `updateAppointment` **no comprueba solape ninguno**. En v1 se cancela por WhatsApp, que ya lo maneja con confirmación. |
| **Retención temporal del hueco** | Sección 2. |
| **Upselling en la web** | Las reglas son frases de marketing con deuda conocida; una página pública es el peor sitio para enseñar una etiqueta irresoluble con un precio al lado. |
| **Cuentas / login de clienta** | El teléfono es la identidad. |
| **Extensiones (Tetiana)** | Agenda manual por decisión. |
| **San Remo** | Estructuralmente fuera. |

---

## Coste

Órdenes de magnitud, no presupuesto. En días de trabajo.

| Pieza | Días | Nota |
|---|---|---|
| **Plantillas de Meta** (código + confirmación) | 0,5 + **espera** | Camino crítico. Empezar el día 1. |
| **D1 · dedupe con estilistas** | 1,5–2 | Opción nueva, default del bot intacto, test de paridad. Lo más delicado. |
| **D4 · bloqueos multi-día** | 0,5 | Bug claro. |
| **D2 + D3 + D6 · TZ, borde de jornada, guarda de duplicado** | 1,5 | |
| **`reservar_hueco()` + `EXCLUDE` parcial** | 2 | Migración enseñada antes de aplicar; probada en bloque que revierte. |
| **Rutas públicas + rate limit + Turnstile** | 1,5 | Incluye los 3 agujeros abiertos de la sección 6. |
| **Verificación por código** | 1,5 | Emisión, caducidad, reintentos, límites. |
| **Formulario** (6 pasos, 4 idiomas, responsive) | 3–4 | Lo más visible y lo menos arriesgado. |
| **Escritura + sync a `contacts` + confirmación + Telegram** | 1,5 | |
| **Config de la dueña** | 1 | |
| **Tests** (paridad, claim concurrente, no-regresión bot y San Remo) | 2 | |
| **Total** | **~16–18 días** | + la espera de Meta, en paralelo |

> ⚠️ **[SUPERADO 19/08/2026]** La espera de Meta ya no existe y D1+D4 ya están pagados. El plan del 19/08 recalculó: **v1 en ~14 días laborables**, sin dependencia externa salvo la marca `solo_complemento` de Yulia.


Reparto grueso: **~4 días son arreglar el motor que ya está roto** y que hoy se
disimula porque hay una persona leyendo, **~4 son concurrencia y seguridad**, y el
resto es el producto en sí.

---

## Verificación

Cuando se construya, así se comprueba:

1. **Paridad de motor** — test hermético: mismo `preferencia` → web y bot devuelven
   la misma lista. Verlo fallar metiendo una divergencia a mano.
2. **Claim concurrente** — script que dispara N reservas simultáneas sobre el mismo
   hueco contra una rama de Supabase; **exactamente 1** gana, N−1 reciben «ocupado».
   Verlo fallar quitando el `advisory_xact_lock`.
3. **D1 por mutación** — revertir el dedupe tumba los bloques de capacidad.
4. **La migración se enseña entera antes de aplicarla**, y el `EXCLUDE` se prueba en
   un bloque `DO $$ … RAISE $$` que revierte, comprobando que no queda ni una fila.
5. **`npm test` entero en verde** antes de cada commit, más `verify:sante`,
   `verify:sante:agenda` y `verify:robustez`. Línea base a batir: **OK 84 · GAP 9 ·
   BUG 0**.
6. **No-regresión de San Remo**, con test explícito.
7. **Ensayo en seco** antes de publicar el enlace: la dueña reserva desde su móvil y
   se comprueba que la cita sale en el panel, en la agenda, sincroniza `contacts` y
   **genera recordatorio**.

---

## Decisiones que siguen abiertas

1. **`language_source: 'declared'`** — ¿se añade el cuarto valor o el idioma elegido
   en el formulario se guarda como `'inferred'`?
2. **Qué categorías** entran en la lista corta. Es de la dueña, y hasta que las diga
   no se puede dimensionar el paso 1 del formulario.
3. **El solape de mañana** (14/08, Olga, 15:00–15:30, dos clientas): ¿es
   intencionado? Es independiente de este proyecto pero conviene mirarlo hoy.
