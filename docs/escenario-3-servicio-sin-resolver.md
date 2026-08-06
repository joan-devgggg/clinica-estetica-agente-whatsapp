# Escenario 3 — el servicio que nunca aterriza

**Fecha:** 05/08/2026 · **Estado:** diagnosticado, sin arreglar · **Alcance:** solo diagnóstico —
ni una línea de código tocada, ni una escritura en Supabase.

El escenario 3 de `verify:robustez:llm` («valayage») degrada ~1 de cada 3 corridas desde que
el 05/08/2026 se le cambió el check para que afirmara **conducta sobre el estado** en vez de
buscar la palabra "balayage" en la respuesta. Lo que mide ahora: que tras contestar el largo,
`session.selectedService` quede resuelto. Cuando falla, el bot pregunta el día **sin haber
resuelto el servicio**, y un turno después sigue sin resolverlo.

Cómo se reproduce lo de abajo: los helpers se ejecutaron contra el catálogo real de Sante
leído de Supabase; los caminos de escritura son lectura de `bot.js`; los datos de clientas
salen de `SELECT` sobre la Supabase de producción.

---

## 1. Dónde se pierde: no se pierde — nunca llega

No existe ningún punto donde `selectedService` se borre. **La capa determinista no resuelve
balayage en ningún momento**, y lo importante es que tampoco lo hace con la palabra bien
escrita:

```
"kiero un valayage"       → extractServiceFromText: null · detectLargoCategory: null
"quiero un balayage"      → extractServiceFromText: null · detectLargoCategory: null   ← sin typo
"balayage"                → extractServiceFromText: null · detectLargoCategory: null
"quiero mechas balayage"  → detectLargoCategory: "Mechas Balayage"                     ← solo así
```

Dos causas independientes, las dos en [`detectLargoCategory`](../services/helpers.js) (~línea 2292):

1. **El match de categoría es por subcadena completa** (`t.includes(normalizeText(name))`). La
   categoría se llama `"Mechas Balayage"`, así que "balayage" a secas no la contiene.
2. **La tabla `largoKeywords` no tiene entrada para balayage.** Tiene alisado, airtouch,
   clásicas, deco, antifrizz y color completo. Es la única categoría con variantes de largo
   que falta.

Como `pendingLargoCategory` nunca se pone, y **los dos bloques de resolución de largo están
gateados por él**, el turno siguiente ("medio") tampoco resuelve nada — aunque
`extractLargoPelo('medio')` devuelva `2` perfectamente. El dato está y no hay quien lo use.

### Entonces, ¿por qué funciona 2 de cada 3 veces?

Porque lo resuelve el LLM, no el código. Cuando el modelo rellena `datos.servicio =
"Cabello medio"`, lo recoge el bloque de selección desde LLM de `bot.js` (~4575) y resuelve,
porque `"Cabello medio"` es **único** en el catálogo (solo Mechas Balayage lo usa). Cuando el
modelo contesta solo en prosa sin rellenar `datos`, no hay nada detrás que lo recoja.

**Toda la diferencia entre la corrida verde y la roja es si el modelo rellenó un campo.** El
escenario se llama "falta de ortografía", pero el typo es una pista falsa: falla igual escrito
bien. Lo que mide de verdad es que balayage no tiene capa determinista.

---

## 2. ¿Puede llegar a RESERVAR? No. Ni siquiera llega a proponer huecos

Revisados los cuatro caminos que escriben una cita de Sante. **Los tres puntos de entrada
están gateados por `selectedService`**:

| Camino | Guarda | Línea |
|---|---|---|
| `resolveSalonConfirmation` | `if (!session.selectedService) return null;` | bot.js ~2264 |
| Reload dirigido tras "el LLM dijo confirmada" | `&& session.selectedService` | bot.js ~4799 |
| Red de seguridad | `session.selectedService && safetySlots.length` | bot.js ~4855 |

El cuarto (`finalizarReservaPendiente`, que retoma una reserva que esperaba el nombre) solo se
alcanza desde `session.pendingNameForBooking`, y eso únicamente lo pone `finalizarCitaSante`
— o sea, después de haber pasado ya por una de las tres guardas. No puede originar nada.

Y un piso más arriba: **los tres `loadAvailableSlots` del flujo de salón también están
gateados** por `selectedService` (bot.js ~4204 y ~4499; el de ~4213 es la rama de San Remo).
Así que con el servicio sin resolver `availableSlots` se queda vacío y el bot **no llega a
proponer horas concretas**: solo puede preguntar el día. Si el modelo se inventa una hora, la
caza la red anti-invención y la sustituye por `salonNoSlotsMsg`.

Confirmado también con datos: **cero citas de Sante con `service = 'Reserva'`** (el fallback de
`saveAppointment`) y **cero con servicio vacío**.

**Conclusión: es molesto, no cita fantasma.**

### Pero el molde de la cita fantasma está montado

Si alguna de esas tres guardas se relajara, el camino existe entero y no hay nada más que lo
pare — `finalizarCitaSante` **no comprueba el servicio por su cuenta**:

```
finalizarCitaSante  →  buildFullServiceName(null, catálogo)  →  null
                    →  allServices = [null, ...upsells].filter(Boolean).join(' + ')  →  ''
bot.js ~2777        →  servicio: allServices || session.selectedService?.nombre || 'Cita'
```

O sea: una cita real, ocupando agenda, con `service = 'Cita'`, que no resuelve contra el
catálogo y cae a "sin poder calcular" en Facturación. Y con 60 minutos: `resolveAppointmentDurationMin(null)`
devuelve `{minutos: 60, resuelto: false}`, así que si aquello era un balayage se publican tres
horas libres encima de la propia clienta.

> **Corrección (06/08/2026):** arriba decía `service = 'Reserva'`. Ese es el fallback de
> `db.js ~1159` (`servicio || 'Reserva'`) y **por este camino no se alcanza**, porque `bot.js`
> ya manda el literal `'Cita'`, que es truthy. El daño es idéntico; el nombre que habría que
> buscar en la tabla, no.

**Ya no lo detienen solo tres `if`: hay test** — `tests/cita-exige-servicio.test.js`
(06/08/2026), en `npm test`. Afirma la conducta de `resolveSalonConfirmation` (con control de
no-vacuidad), pone un cable trampa estructural sobre las otras dos guardas y sobre los tres
`loadAvailableSlots` —que están dentro de `processMessageCore`, sin exportar y no ejercitables
sin LLM ni Supabase—, y mide la consecuencia de arriba para que el cable trampa se entienda.
Comprobado por mutación: quitar cualquiera de las cinco condiciones lo pone en rojo. Era la
recomendación (3) de abajo.

---

## 3. Relación con el bucle sin servicio de `4e7743c`: es el mismo animal

Directa. Con `selectedService` a null:

```
loadAvailableSlots no corre  →  availableSlots vacío  →  cualquier hora que invente el modelo
la caza la red anti-invención  →  salonNoSlotsMsg  →  "Para mirarte los huecos primero
necesito saber qué servicio quieres"
```

`4e7743c` (03/08/2026) arregló **el síntoma de salida y una causa de entrada**: que el mensaje
dejara de repetirse (a la 2ª abre el menú de categorías y ofrece la consulta) y que
`detectConsultaValoracion` reconociera la familia "evaluar / valorar". **No tocó esta causa de
entrada.** El escenario 3 llega al mismo callejón por la puerta de al lado: en vez de "no sé
qué quiero", es **"sé exactamente qué quiero y el detector no lo reconoce"**.

La diferencia práctica importa para priorizar: en el caso de `4e7743c` el bot pregunta el
servicio, que es honesto aunque se repita. En el escenario 3 **el bot pregunta el día
primero** y solo admite que no sabe el servicio cuando la clienta ya ha contestado. Eso se
lee peor.

---

## 4. Con clientas reales: sí, cuatro veces en tres días

La frase de `salonNoSlotsMsg` sin servicio salió **4 veces entre el 01 y el 03/08/2026**:

| Fecha | Clienta | Lo que dijo justo antes | Lo que dijo después |
|---|---|---|---|
| 01/08 14:21 | Valeria Rivera | "Qué datos necesita?" | "Solo un corte y secado" → reservó |
| 02/08 22:36 | Mariana Becker | **"Miércoles"** | "Me tienen que evaluar" |
| 02/08 22:37 | Mariana Becker | **"Por la tarde"** | "Hidratación" ← se rindió |
| 03/08 08:22 | Mariana Becker | "Está súper así.. yo llego y me dicen que debo hacer" | "uper" |

Las tres de Mariana Becker **son el incidente que originó `4e7743c`**. Y la columna "lo que
dijo justo antes" es el hallazgo: contestó **el día** y luego **la hora** antes de que el bot
admitiera que no sabía el servicio. Es exactamente la forma del escenario 3, con clienta real.

Dos cosas más que salen de ahí:

- **La cuarta (03/08 08:22) es POSTERIOR al arreglo y sigue abierta.** "Yo llego y me dicen
  que debo hacer" es una petición de valoración de manual, y `detectConsultaValoracion` **hoy
  sigue devolviendo `false`** para esa frase (comprobado). Es una 5ª variante de la familia
  "evaluar", sin cubrir.
- **La conversación de balayage real existe** (Lorena Pérez, 03/08, conv. `288ca354`): pidió
  "reflejos o balayage" y el bot llevó el flujo entero apoyado en el LLM, con precios
  correctos (200 € cabello largo, 40/50 € cortes — todos cuadran con el catálogo). No llegó al
  callejón **solo porque ella se fue antes de dar un día** ("lo organizo y te escribo"). Con
  una fecha en ese mensaje habría sido la quinta.

---

## 5. Qué haría, por orden de coste/efecto

Nada de esto está hecho.

1. **Añadir `balayage` a `largoKeywords`** y relajar el match de categoría a tokens en vez de
   subcadena completa. Es la causa raíz del escenario 3, son dos líneas, y cubre "balayage",
   "un balayage" y "reflejos o balayage".
2. **No preguntar el día sin servicio.** Un gate en el `proximoPaso` del prompt: con
   `selectedService` a null, el próximo paso es el servicio, nunca la fecha. Ataca la familia
   entera y no solo balayage — es lo que habría evitado que Mariana contestara "Miércoles" y
   "Por la tarde" para nada.
3. ~~**Un test que afirme las tres guardas de escritura**~~ — **HECHO 06/08/2026**,
   `tests/cita-exige-servicio.test.js`. Ver §2.
4. **La 5ª variante de "evaluar".** Más barato que ampliar la regex: que el streak abra el
   menú a la **primera** cuando la clienta ya ha dado día u hora — porque ahí ya se sabe que
   la conversación va de reservar y que lo que falta es el servicio.
