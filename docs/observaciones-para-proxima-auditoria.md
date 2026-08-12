# Observaciones sueltas para la próxima auditoría

Lista corrida. Cosas vistas de pasada en conversaciones reales que **NO se han arreglado a
propósito**: no hay señal suficiente para acometerlas en el momento en que se vieron, y
arreglarlas de paso sería ampliar el alcance por iniciativa propia (regla 8). Cada entrada
lleva la conversación literal, que es lo que permite decidir después sin volver a excavar.

Lo que se anota aquí NO está decidido como «no arreglar»: está decidido como «no ahora».

---

## 12/08/2026 · Mafe Alayon (`34656332064`), conv `33beca35`

Cuatro cosas en la misma conversación, la de una clienta real que respondió a la tanda 2 de la
campaña de verano. Acabó escalada a una persona (correctamente) y **enfadada por un precio**.

### 1 · Pierde el referente y suelta el genérico de servicios

El hallazgo que motivó esta lista. A las 10:54 la clienta se refiere al producto del que
venían hablando y el bot pregunta desde cero:

```
[10:53:43] ELLA:  Ah vale claro, si yo le he preguntado por el producto que me has
                  enviado en la foto que sería la keratina
[10:53:53] BOT:   Los productos como la keratina los puedes comprar en nuestra tienda
                  online: … ¿hay algo que quieras hacerte en el salón?
[10:54:16] ELLA:  Si este sería genial, para cuando tendrías disponibilidad?
[10:54:26] BOT:   Perdona, no entiendo bien. ¿Cuál de nuestros servicios te gustaría?
                  Por ejemplo, un corte, color, mechas, tratamiento… ¿Qué necesitas?
```

«**Si este** sería genial» apunta al tratamiento que el propio bot acaba de nombrar. El
genérico borra el contexto y obliga a la clienta a repetirse. Tardó **27 minutos** en volver
(11:21) y cuando lo hizo tuvo que nombrar el servicio entero («Este alisado vegano»).

### 2 · «Keratina» se lee como NOMBRE DE ESTILISTA

Lo más llamativo de la conversación, y no es el mismo fallo que el 1:

```
[11:25:24] ELLA:  Qué producto sería para la Keratina? Que dices que vale 210€ ?
[11:25:34] BOT:   No tengo a nadie llamada Keratina en el equipo 😊 ¿Te refieres a
                  Irina, Natalia, Veronika o Yulia?
```

Venía de preguntarle si tenía estilista de confianza, así que el turno se interpretó como
respuesta a esa pregunta y `resolveStylistMention` casó un nombre de PRODUCTO —mencionado
tres veces antes en la misma conversación— como nombre de persona. CLAUDE.md ya dice que a
las guardas se les pasa el catálogo COMPLETO para que dar de baja un servicio «no pueda
convertir su nombre en un nombre de persona plausible»; aquí el nombre es de un producto que
ni siquiera está en el catálogo de servicios.

### 3 · El precio del salón (210 €) contra el precio del bot (310 €) — el caro

```
[11:23:09] ELLA:  Unos centímetros arriba de la cintura
[11:23:21] BOT:   Eso es cabello largo 😊 El alisado vegano largo cuesta 310€…
[11:27:19] ELLA:  ayer yo me acerqué a salón de SANTE me miraron el cabello y me dijeron
                  que me vale 210€. Entonces quiero saber por qué me dicen un precio en
                  el salón y por whatsaap ya me cambias el precio….
```

**100 € de diferencia**, y la clienta lo vivió como que se le cambiaba el precio. El bot lo
gestionó bien —admitió la duda y escaló, sin inventarse una explicación— pero la pregunta de
fondo es de la dueña y encaja justo donde CLAUDE.md dice que encaja: *«El mapeo lo fija la
dueña, no el código»* y *«dónde cae cada punto del cuerpo es criterio de salón»*. Si «unos
centímetros arriba de la cintura» debe ser Largo o Medio en el alisado vegano no lo puede
decidir quien escribe el código, y es exactamente el caso que
[`docs/largo-del-pelo.md`](largo-del-pelo.md) llama caro: el tramo equivocado se comunica
como cifra buena.

Ojo a la asimetría con el caso del sujetador: ahí se devuelve `null` a propósito porque
preguntar otra vez es gratis. Aquí el bot **sí** resolvió, y resolvió distinto que el salón.

### 4 · Otra instancia de la ventana del buffer (ya decidida como no-arreglar)

Dos entrantes a 10 s (10:53:43 y 10:53:53) generaron **dos salientes solapados** que se pisan:

```
[10:53:53] BOT: Ah, entendido. Los productos como la keratina… ¿hay algo que quieras
                hacerte en el salón? Un tratamiento, un corte, color… 😊
[10:54:03] BOT: Perfecto, Mafe Alayon 😊 ¿Qué te gustaría hacerte hoy en el salón?
```

Las dos preguntan lo mismo con distinta redacción. Es el mismo dimensionado ya anotado en
CLAUDE.md (`BUFFER_DELAY_MS` 5 000 vs mensajes reales a 7-10 s) y **no** un hallazgo nuevo;
se apunta solo como instancia adicional, porque es la tercera medida y todas caen en la misma
franja de 7-10 s.

### Estado operativo (no es un hallazgo, es un pendiente)

Escalada registrada correctamente a las 11:29:09 UTC: `bot_mode: manual`,
`escalation_reason: consulta_dato_no_disponible`, `pending_actions` en `pending`. La clienta
mandó «Vale» a las 11:43 y **está esperando a una persona**. La maquinaria de escalada
funcionó; lo que falta es que alguien la atienda.

---

## 12/08/2026 · El fallback difuso de `computeServiceBilling` remapea a otro precio

Salió al escribir la red del renombrado de Spa Hair (migración 040). **No es un hallazgo de
conversación: es dinero mal calculado en Facturación hoy**, y por eso está aquí y no en
CLAUDE.md como trampa resuelta.

### Qué pasa

`computeServiceBilling` (`services/helpers.js:3449`) resuelve cada segmento así:

```js
const entry = exactas[0] || extractServiceFromText(name, catalog) || null;
if (!entry) return { name, precio: null, status: 'unmatched' };
```

Cuando el nombre guardado en `appointments.service` **no** casa exacto contra el catálogo, cae
a `extractServiceFromText`. Y esa función no está hecha para esto: está hecha para entender lo
que ESCRIBE una clienta y para resolver etiquetas de upselling (`Reconstrucción molecular K18 o
Pro-Miracle`), que por eso es tolerante. Aplicada a un nombre de cita, un nombre que ya no
existe no vuelve como `unmatched` —que es visible, sale en «sin poder calcular»— sino como un
servicio VECINO **con status `ok`** y otro precio. La cifra se presenta como buena.

### Cuánto, medido contra el catálogo REAL de producción (81 entradas, 12/08/2026)

Barrido: para cada entrada, quitarla del catálogo (equivale a renombrarla o borrarla) y
preguntar por su propio nombre. **21 de las 81** devuelven otro precio con status `ok`; **8**
se van además a otra CATEGORÍA:

| servicio | su precio | resuelve a | precio que sale |
|---|---|---|---|
| Matiz (Matiz mujer) | 40 € | Matiz plus (Matiz mujer) | 65 € |
| Matiz plus (Matiz mujer) | 65 € | Matiz (Matiz mujer) | 40 € |
| Reconstrucción K18 (Reconstrucción) | 35 € | Reconstrucción K18 + lavar y peinar | 60 € |
| Green Purity Detox (Tratamiento Orgánico) | 35 € | Detox 60min (Spa Hair) | 115 € |
| Botanical Glow Pure Blond (Trat. Orgánico) | 45 € | Brillo intensivo (Brillo Glow) | 120 € |
| Fresh Hidratación (Tratamiento Orgánico) | 45 € | Orising hidratación intensa | 85 € |
| Mechas Airtouch XL | 260 € | XL (Deco Total Blond) | 175 € |
| Deco Total Blond XL | 175 € | XL (Mechas Airtouch) | 260 € |
| Drenaje linfático piernas (Masajes y SPA) | 45 € | Drenaje corporal (Masajes y SPA) | 75 € |
| Drenaje corporal (Masajes y SPA) | 75 € | Drenaje linfático piernas | 45 € |
| Relajante completo (Masajes y SPA) | 70 € | Holistic relajante Premium | 95 € |
| Holistic relajante Premium (Masajes y SPA) | 95 € | Relajante completo | 70 € |
| Relax 45min (Spa Hair) | 85 € | Aromaterapia relax (Masajes y SPA) | 75 € |
| Aromaterapia relax (Masajes y SPA) | 75 € | Relax 45min (Spa Hair) | 85 € |
| Corte mujer y secado (Cortes) | 40 € | Mujer y peinado Dyson (Cortes) | 50 € |
| Corte mujer y peinado Dyson (Cortes) | 50 € | Mujer y secado (Cortes) | 40 € |
| Difuminado de raíz (Color Premium) | 40 € | Color raíz (Color Premium) | 75 € |
| Extensión uñas (Manicura/Pedicura) | 45 € | Corrección uñas ext | 40 € |
| Corrección uñas ext (Manicura/Pedicura) | 40 € | Extensión uñas | 45 € |
| Dermapen Hair Loss | 75 € | Consulta tricológica con Yulia (Diagnóstico Capilar) | 85 € |
| Miracle Elixir (Tratamiento Orgánico) | 59 € | Reconstrucción Pro Miracle (Reconstrucción) | 60 € |

Los pares simétricos son los que más asustan: `Matiz` ⇄ `Matiz plus` se intercambian 25 €, y
`Mechas Airtouch XL` ⇄ `Deco Total Blond XL` se intercambian **85 €** en las dos direcciones.

### Por qué importa aunque hoy no haya citas rotas

Hoy ninguna cita de producción está en ese estado (todas casan exacto), así que **no hay
dinero mal cobrado ahora mismo**. Lo que hay es un campo de minas para lo siguiente que se
haga con el catálogo:

- **Renombrar** una entrada. Ya casi pasó: la 040 renombró `Relax 45min` y había dos citas
  confirmadas del 13/08 sin sellar. Con el catálogo renombrado y las filas intactas se
  habrían facturado a 75 € en vez de 85, y `stampBillingSnapshot` (`db.js:1612`) lo habría
  **congelado** al pasar a `completed` — sin que `isBillingServiceDiverged` avisara, porque
  `servicio_facturado` y `service` habrían dicho lo mismo. Se evitó renombrando las citas en
  la misma transacción.
- **Borrar** una entrada. CLAUDE.md ya dice «`activo: false`, nunca borrar», y su razón
  declarada es que la cita cae a `unmatched`. Esta medición dice que en 21 de 81 casos NO cae
  a `unmatched`: cae a otro precio, que es peor porque no se ve.
- **Editar** el `service` de una cita desde el panel con una errata.

### Por qué no se arregla aquí

Estrechar el fallback es un trabajo de diseño, no una línea: `extractServiceFromText` tiene
tres consumidores con necesidades opuestas —el detector de la conversación (quiere ser
tolerante), la resolución de etiquetas de upselling (`resolveServiceDurationMin`, que la
necesita difusa a propósito) y la facturación (que no debería serlo)— y CLAUDE.md ya avisa de
que *«el filtro va en el CALL SITE, jamás dentro de un helper»*. La forma que pinta bien es
que la facturación pida resolución ESTRICTA (exacto, o `unmatched`) y deje el difuso para los
otros dos, pero eso hay que medirlo contra las 62 citas reales antes de tocarlo: hay que saber
a cuántas les cambia el estado hoy.

Medición reproducible: es el barrido de `tests/renombrar-servicio-no-mueve-dinero.test.js`,
cuya propiedad sobre las 81 entradas se quedó a propósito en «cada servicio factura su propio
precio» — la versión fuerte («ninguna remapea») sale en rojo por estas 21 y no se puede meter
en `npm test` sin arreglar antes lo de arriba.

### CERRADO el 13/08/2026 · `92ce19a` (escritura) y el commit siguiente (lectura)

Arreglado en dos commits, en ese orden y nunca al revés:

- **Escritura** (`92ce19a`): `resolveAcceptedUpsellName` traduce la etiqueta de upselling a su
  nombre de catálogo ANTES de persistirla en `appointments.service`. El difuso se queda, pero
  corre en la conversación. Sin esta mitad, la siguiente habría hecho desaparecer el dinero de
  5 de las 9 etiquetas.
- **Lectura**: `computeServiceBilling` pasa a ser estricto (`exactas[0] || null`). Un nombre
  huérfano sale `unmatched`, que se ve, en vez de heredar el precio del vecino.

Medido contra las 62 citas: **2 cambian, las dos `cancelled`, y 0 de las 37 `completed`.**
El informe no se mueve — de esas 37, solo **1** depende del cálculo en vivo (`calculado`); las
demás son 18 `congelado`, 16 `manual` y 2 `divergente` (esas dos por el detector de la 031, sin
relación con esto). Las dos que cambian:

- `96bca537` «Alisado vegano Largo 1» (cancelada): **310 € → `unmatched`**. Facturaba 310 €
  cuando su precio real era **210 €** — el error lo introdujo la migración 023 al renombrar
  «Largo 1» → «Corto», y el difuso se llevaba la entrada «Largo» por el token. Fijado en un
  test, porque es la prueba de que esto no era hipotético.
- `dd30234e` «Corte niño + Exfoliación del cuero cabelludo» (cancelada): **35 € → 25 € +
  `unmatched`**. Es una etiqueta de upsell guardada como nombre de servicio; con la mitad de
  escritura ya arreglada, una cita nueva guarda `Exfoliación/pilling` y factura sus 10 €.

**Las dos filas históricas no se han tocado**: están canceladas y renombrarlas es una decisión
del dueño, no del arreglo.

### LO QUE QUEDA ABIERTO, y es el trabajo que cierra esta familia

La causa de fondo de que 7 de las 9 etiquetas no casen: **una regla de
`business_info.upselling` es una FRASE de marketing, no una referencia a una entrada de
catálogo.** Es la deuda del upselling ya anotada en CLAUDE.md el 05/08/2026 —entonces por el
lado de los servicios dados de baja— y esto la reabre por el lado del dinero: mientras la regla
sea una frase, lo que hace `resolveAcceptedUpsellName` es una traducción por PARECIDO, y solo
está bien porque hoy acierta.

Arreglarlo de verdad es que cada regla apunte a su entrada de catálogo (un nombre exacto, o una
referencia). Toca el formato de `business_info.upselling`, las 8 reglas actuales, el flujo de
aceptación y el prompt. Con eso, `resolveAcceptedUpsellName` se queda en el match exacto y las
dos etiquetas que hoy no resuelven (`Reconstrucción molecular`, `Tratamiento hidratación`)
dejarían de poder existir.

**Dos decisiones están preguntadas a la dueña** (13/08/2026) y son las que bloquean el paso
siguiente, porque son precios y no código:

| Etiqueta | Hoy se cobra como | Alternativa que existe en el catálogo |
|---|---|---|
| `Manicura` | `Manicura + gel` — **35 €** | `Higiénica mujer` — **25 €** (no hay ninguna «Manicura» a secas) |
| `Tratamiento capilar personalizado` | `Consulta tricológica con Yulia` — **85 €** | — (¿es eso lo que se quiere ofrecer tras un corte?) |

Mientras no conteste se conserva lo que resuelve el difuso —que es el comportamiento de
siempre— y cada caso avisa por Telegram con la etiqueta Y su destino con precio, para que
contestarlo sea editar una línea. Aviso `upsell_etiqueta_por_parecido`, una clave de throttle
por etiqueta.
