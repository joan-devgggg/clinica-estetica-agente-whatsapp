# El largo del pelo: cómo lo dice una clienta y a qué tramo va

**Mapeo decidido por la dueña el 11/08/2026 y ya aplicado** en `extractLargoPelo`
(`services/helpers.js`). Red: `tests/largo-del-pelo.test.js`.

## Por qué el mapeo no lo decide el código

El largo fija el precio — en Anti-encrespamiento son **120 / 160 / 180 €** — y se le comunica
a la clienta como cifra buena. Dónde cae cada punto del cuerpo es criterio de salón: «pecho»
se mide por delante y el pelo cae por detrás, así que «por encima del pecho» podía ser medio o
largo según dónde se pusiera la raya. **Un `null` no es un fallo** (el bot vuelve a preguntar
o acepta el «no sé»); lo caro es devolver el tramo equivocado.

## La tabla

| tramo | punto del cuerpo |
|---|---|
| **1 · Corto** | por encima de las orejas · muy corto · barbilla · mentón · mandíbula · bob · melena corta · **por encima de / a la altura de / hasta los hombros** |
| **2 · Medio** | **por debajo de los hombros** · clavículas · **por encima de / a la altura de / hasta el pecho** · omóplatos · paletillas · axilas · media melena |
| **3 · Largo** | **por debajo del pecho** · **por debajo de los omóplatos** · media espalda · mitad de la espalda · codos · cintura |
| **4 · Muy largo** | **por debajo de la cintura** · cadera |

⚠️ **El tramo 4 NO compra la variante «XL»** de Deco Total Blond, Mechas Airtouch ni Mechas
Balayage: esas tres son para CAMBIOS DE COLOR IMPORTANTES y no por longitud (Yulia,
21/08/2026), así que un largo 4 para en «Largo», que es el techo de la escala. Lo decide
`elegirVariantePorLargo` (`helpers.js`), que es la ÚNICA fórmula — antes estaba copiada en
tres sitios y el criterio del techo solo en el prompt. Red: `tests/xl-no-es-un-largo.test.js`.

En negrita, las que llevan modificador: son las que hay que registrar aparte (ver abajo).

Los cuatro idiomas, con las formas equivalentes:

| | 1 · Corto | 2 · Medio | 3 · Largo | 4 · Muy largo |
|---|---|---|---|---|
| **en** | above the ears · chin/jaw length · shoulder length · bob · short | below/under the shoulders · collarbone · chest · shoulder blades · armpit · medium | below the chest · mid-back · middle of my back · waist · elbow · long | below/past the waist · hip length · very long |
| **ru** | до плеч · выше плеч · до подбородка · коротк · каре | ниже плеч · до ключиц · до груди · выше груди · до лопаток · средн | до талии · до пояса · ниже груди · ниже лопаток · до середины спины · до локтей · длинн | ниже талии · ниже пояса · до бедер · очень длинн |
| **uk** | до плечей · вище плечей · до підборіддя · коротк | нижче плечей · до ключиць · до грудей · до лопаток · середн | до талії · нижче грудей · нижче лопаток · до середини спини · до ліктів · довг | нижче талії · нижче пояса · до стегон · дуже довг |

## El invariante: se evalúa de 4 a 1, y el modificador manda

Un punto **suelto** se registra en su tramo («hombros» → 1) y con eso cubre gratis sus formas
neutras: «hasta los hombros», «por encima de los hombros», «a la altura de los hombros». Lo
que hay que registrar aparte es el **«por debajo de»**, porque significa un tramo MÁS ALTO — y
por eso el bucle va de 4 hacia 1: el tramo alto lo atrapa antes de que el bajo llegue a ver el
punto suelto que lleva dentro.

**Registrarlo en su propio tramo, o más abajo, pierde el modificador en silencio.** Las tres
que lo hacían hasta el 11/08/2026, y que son las únicas que respondían MAL (las demás
simplemente no se entendían, que es mucho más barato):

| decía | debía decir | por qué |
|---|---|---|
| «por debajo de los hombros» → **Corto (120 €)** | Medio (160 €) | casaba «hombros» e ignoraba el «por debajo» |
| «media espalda» → **Medio** | Largo | «media» y «espalda» estaban las dos en el tramo 2 |
| «hasta la mitad de la espalda» → **Medio** | Largo | íd. |

Ruso y ucraniano **no comparten entrada** aunque se parezcan a la vista: «до талии» (ru, `и`) y
«до талії» (uk, `і`) llevan letras distintas, y por eso la ucraniana casaba y la rusa devolvía
`null`. Todo el cirílico va por `buildCyrillicRe` y nunca con `\b`, que es ASCII.

## El sujetador se queda fuera, y es una DECISIÓN

**«A la altura del sujetador» · «bra strap length» · «hasta el sostén» · «до бретельки»**
devuelven `null` **a propósito**. No es un hueco por rellenar ni una traducción que falte:
está decidido así (11/08/2026), junto con el resto de la tabla.

Cae exactamente en la **raya** entre los omóplatos (tramo 2) y media espalda (tramo 3), y no
hay forma de deducir a cuál va. Con `null` el bot vuelve a preguntar el largo, y **preguntar
es gratis**; meterlo en un tramo cualquiera son **20 € de error en cualquiera de las dos
direcciones**, dichos como precio bueno.

O sea que añadirlo «para completar la lista» no mejora la cobertura: **cambia una pregunta de
más por un precio equivocado.** Está escrito en el propio `LARGO_REGLAS` para quien vaya a
tocarlo, y `tests/largo-del-pelo.test.js` lo afirma, así que un añadido bienintencionado sale
en rojo en vez de en la factura de una clienta. Si algún día la dueña dice el tramo, se añade
en los cuatro idiomas y ese test cambia a la vez.

## Al añadir una frase nueva

1. Si lleva modificador, comprobar que su tramo es **más alto** que el del punto que lleva
   dentro.
2. Test por tramo y por idioma, y **verlo fallar sin el arreglo** — la tabla de arriba se
   verificó así: revirtiendo la función caen los 21 bloques nuevos, e invirtiendo solo el
   orden del bucle (mismo vocabulario) caen 12, que es lo que demuestra que el orden es lo que
   protege y no las palabras.
3. Ojo con las palabras que casan dentro de otras: `cort[oa]s?` no puede casar en «corte»
   (quien pide un corte no está diciendo su largo), y tiene test de falso positivo.
