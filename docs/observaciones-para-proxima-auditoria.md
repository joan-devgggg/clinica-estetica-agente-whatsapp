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

---

## 13/08/2026 · Tres ficheros de catálogo, tres catálogos distintos, y ninguno es el vivo

Salió al diagnosticar la conversación de Mariola Mira Lopez: para saber si existía un «masaje
de 60 €» abrí `data/sante-catalogo-backup-2026-08-12.json` y concluí que el bot se había
inventado el nombre «Spa Hair Detox», porque ahí esa entrada se llama `Detox 60min`. **Era
falso.** El catálogo vivo sí tiene «Spa Hair Detox». La conclusión equivocada duró hasta que
contrasté contra `agent_configs.services`.

### El diff, medido

| entrada | vivo (`agent_configs`) | `backup-2026-08-12` | `tests/fixtures/sante-catalog.json` |
|---|---|---|---|
| Spa Hair Relax / Detox / Hidratación | ✅ nombres nuevos | ❌ `Relax 45min`, `Detox 60min`, `Spa Hidratación 60min` | ✅ nombres nuevos |
| `Manicura/Pedicura \| Japonesa` | ❌ no existe | ❌ no existe | ✅ **existe** |
| `Color Premium \| Difuminado de raíz` | ✅ existe | ✅ existe | ❌ **falta** |

Los tres tienen 81 entradas, que es justo lo que hace que parezcan el mismo fichero.

### El matiz que cambia el diagnóstico

**El backup no está desfasado por descuido: es la copia deliberada PREVIA a la migración
040** (`040_renombrar_spa_hair.sql`), que renombró esas tres entradas el 12/08. Su propia
cabecera lo dice. O sea que el fichero hace exactamente lo que debe — el problema es que
**su nombre solo lleva una fecha**, y nada en él avisa a quien lo abre de que está leyendo el
«antes» de un renombrado. Yo lo abrí buscando «qué hay en el catálogo» y me llevé la
respuesta anterior a la migración, sin una sola señal.

El fixture es otra cosa: **no es el «antes» de nada, es un fichero mantenido a mano que ha
seguido unos cambios y no otros.** Siguió el renombrado de Spa Hair (040) pero no la baja de
`Japonesa` ni el alta de `Difuminado de raíz`. Ese es el fichero peligroso de los tres,
porque nadie sabe de qué fecha es.

### Por qué importa, y a qué se parece

- **El backup, restaurado, movería dinero.** `appointments.service` guarda un NOMBRE; volver
  a poner `Detox 60min` en el JSONB haría que toda cita pasada con `service = 'Spa Hair
  Detox'` dejara de resolver → `unmatched` → 0 € en Facturación. Es literalmente el motivo
  por el que la 040 renombró también dos citas (las dos de Mariola). Un backup de catálogo
  **no es un fichero inerte: es una migración inversa sin revisar.**
- **El fixture pierde cobertura en silencio, no da rojo.** Lo usan **16 ficheros de test**.
  `tests/service-names-parity.test.js` dice en su cabecera que compara «sobre el catálogo
  REAL de Sante (el JSON que sirve `/api/service-catalog`)» — y usa el fixture. Esa frase ya
  no es cierta: si la dueña añade mañana un servicio con « + » en el nombre (los que rompen
  el split ingenuo, que es justo lo que ese test vigila), el test seguirá verde sin haberlo
  mirado nunca.
- Es el mismo daño que ya hizo el fixture de `verify:sante` en la Fase 2-largo, aunque por
  otra vía: allí la expectativa escrita a mano (`'por media espalda'` como nivel 2) certificó
  **el mapeo equivocado** durante semanas. En los dos casos, un fichero de git que hace de
  sustituto de la realidad **certificó algo falso sin ponerse en rojo**.

### Lo que NO hay que hacer con esto

Un check «fixture ≡ backup ≡ vivo» sería un rojo permanente y **es exactamente la trampa de
la regla 5**: mediría antigüedad, no corrección. Un fixture está desfasado *por diseño* —
esa es su función, y es lo que hace que los tests sean deterministas cuando la dueña renombra
algo. Y un backup está desfasado por definición. Un check así caducaría el primer día y
dejaría un fallo que nadie tiene que arreglar, que es la forma más rápida de que todo el
mundo deje de leer el informe (ya pasó tres veces: horarios de Tetiana/Natalia, «Consulta con
exactamente 4 estilistas», Olgha→Olga).

Análisis de qué SÍ tendría sentido: ver más abajo, sin construir.

### ¿Tiene sentido un check que compare los tres? — análisis, sin construir

**Respuesta corta: sí, pero no ese check.** «Avisar cuando diverjan» mide antigüedad. Lo que
sí se puede medir es la **consecuencia** de cada fichero, que es distinta en cada uno y es
verdad o mentira con independencia de cuánto haya editado la dueña.

**C · Que el fichero no se pueda confundir con la verdad** — *casi gratis, y ataca el fallo
que pasó de verdad*

Ni check ni script: metadatos. Un `_meta` dentro del propio JSON (`{ tomado_el,
antes_de_migracion, no_es_el_catalogo_vivo: true }`) o un hermano `.md` de dos líneas. El
backup de la 040 es correcto y útil; lo único que le falta es decir de qué es el «antes».
Cero mantenimiento, cero runtime, y mata exactamente lo que ocurrió: abrir el fichero y
tomarlo por el catálogo. **Es lo primero que haría.**

Para el fixture, lo mismo más una frase que hoy falta: *instantánea de tal fecha,
deliberadamente fija, NO sincronizar*. Que esté desfasado no es el bug — el bug es que nadie
sabe de cuándo es.

**A · «Restaurar este backup movería dinero»** — *el que tiene dinero detrás*

Un `informe:` de solo lectura, a mano y antes de restaurar, nunca en CI. Compara las claves
`categoria|nombre` del backup contra el catálogo vivo **y contra los segmentos de
`appointments.service` de las citas reales**, y responde una sola pregunta: *¿qué citas que
hoy resuelven dejarían de resolver si restauro esto?* Con su cuenta y su importe.

No es regla 5: no afirma que el backup deba parecerse al vivo — afirma una consecuencia
medible. Un backup de catálogo **no es un fichero inerte, es una migración inversa sin
revisar**, y hoy no hay nada que lo mire. Reutiliza `resolveServiceCatalogEntry` y
`computeServiceBilling`, que ya existen. Severidad error y salida 1, pero como corre a
demanda no deja rojo permanente.

⚠️ **Límite que hay que decir en el propio informe**: el catálogo no tiene ids y la clave es
`categoria|nombre`, así que un RENOMBRADO es indistinguible de un borrado más un alta. El
informe puede decir «esta entrada ya no existe y N citas dependen de ella»; **no** puede
decir «se llamaba X y ahora se llama Y». Por eso reporta consecuencia y no diff.

**B · «Los servicios que los tests dan por sentados siguen existiendo»** — *seguramente no*

Sería una lista DECLARADA de claves de catálogo de las que dependen tests concretos,
comprobada contra el vivo en `verify:sante` (que ya lee el vivo), con la forma de la Fase 8.
Avisaría de que un test se quedó certificando algo que ya no ocurre.

**El argumento en contra es fuerte y creo que gana**: esa lista hay que mantenerla a mano, y
mantener a mano un fichero que refleje el catálogo **es precisamente lo que falló con el
fixture**. Se construiría un segundo fichero con el mismo modo de fallo que el primero, más
la ilusión de estar cubierto.

**D · Dejar de fingir que el fixture es el catálogo real** — *lo estructural, y no es un check*

El fixture lo usan **16 ficheros de test**, y al menos uno miente en su cabecera:
`service-names-parity.test.js` dice comparar «sobre el catálogo REAL de Sante (el JSON que
sirve `/api/service-catalog`)» y usa el fixture. Ahí no falta un check: sobra una frase, o
falta mover esa afirmación a `verify:sante`, que sí lee el catálogo vivo.

La línea que ordena esto ya está escrita en CLAUDE.md para otra cosa y vale igual aquí:

| | Dónde va |
|---|---|
| lo que necesita ser **DETERMINISTA** (mapeos, splits, formatos) | fixture, fijo, y que su cabecera lo diga |
| lo que afirma algo del **CATÁLOGO REAL** | `verify:sante`, contra `agent_configs` |

Repartir los 16 por esa raya es trabajo de una tarde y no añade ningún fichero nuevo que
mantener. **Es lo que de verdad cierra el agujero**; A cubre el dinero, C cubre el despiste,
y B sobra.

**Frecuencia, para dimensionar**: el catálogo cambió el 05/08 (baja de `Japonesa`), el 12/08
(renombrado de los tres Spa Hair) y tiene un alta sin fechar (`Difuminado de raíz`).
Aproximadamente semanal — bastante para que A importe, y bastante para que cualquier check
de «deben ser iguales» viviera en rojo.

---

## 18/08/2026 · Los casos 1-3 del prompt no existen en cirílico, y el arnés casi tampoco

Salió de rebote al trazar el caso 7 (`dato_no_disponible`) para el anillo 2. Se anota aquí y
**no se arregla ahora**: no está en el alcance acordado y tocarlo es cambiar la conducta de
tres casos de escalada a la vez.

### El hecho

`detectConsultaService` (`services/helpers.js`) es el detector determinista de ENTRADA que
cubre los casos 1, 2 y 3 del prompt de Sante — extensiones, permanente y eliminación del
pigmento. Corre **antes del LLM**, arma `pendingEscalation` con texto propio del bot y es
la razón por la que esos tres casos NO dependen de cómo redacte el modelo.

Es **íntegramente de alfabeto latino**:

```js
/\b(extension|extensiones)\b/        → 'extensiones'
/\b(permanente|permanent)\b/         → 'permanente'
/salida de negro|arrastre de color|quitar tinte negro|…|quitar pigmento/  → 'salida_negro'
```

Ni una letra cirílica. Una clienta rusa o ucraniana preguntando exactamente lo mismo se salta
el detector entero y cae en el modelo — o sea, en el mismo agujero que el caso 7 tenía hasta
ayer, y sin la red del anillo 2, que solo se cableó para `dato_no_disponible`.

### El caso real que lo motiva

**Nastya Nizenko, 09/08/2026, `ru`.** Fila de `pending_actions` con motivo
`servicio_especial` **pelado, sin el prefijo `consulta_`** — o sea que NO pasó por el
protocolo de dos turnos: la escribió el despacho de acciones directamente. Su último entrante
antes de la fila fue una pregunta, no una aceptación:

```
Как это проходит и как можно гарантировать что волосы ни как не повреждаются
```

Es decir: el detector no la vio, el modelo escaló por su cuenta y a ella no se le preguntó.
Sale sola en `npm run informe:escaladas -- sante`, clasificada como «inmediata SIN preguntar».

### Lo que hace que esto no se vea

El arnés LLM tiene **29 escenarios y su reparto por idioma es 26 `es` · 2 `ru` · 1 `en` ·
CERO `uk`** (contado el 18/08 sobre las metas `idioma:` de `verify-sante-robustez-llm.js`).
Los tres casos que este hallazgo afecta se prueban solo en castellano, así que el agujero es
invisible por construcción: no hay escenario que pueda ponerse rojo.

Ese cero en ucraniano es además el más caro de los dos, porque `uk` no tiene ni el backstop
castellano de `announcesHumanHandover` ni —hasta ayer— las formas de su propio verbo en el
detector de ofertas (`з'єднаю` frente a `зв'яжу`; se arregló al escribir el coda).

### Qué costaría, para cuando se decida

1. Enumerar los términos cirílicos de los tres servicios (`наращивание`, `химическая завивка`,
   `выход из чёрного`… y sus formas ucranianas), **siempre por `buildCyrillicRe`** y nunca con
   `\b`, que es ASCII. Criterio de admisión de siempre: formas que alguien haya escrito de
   verdad, nunca un fuzzy.
2. Un escenario `ru` y otro `uk` en el arnés para cada uno de los tres, o el agujero se
   vuelve a cerrar sobre sí mismo.
3. Mirar de paso si `detectConsultaValoracion` y `detectVariasPersonas` tienen el mismo sesgo.

**No decidido como «no arreglar»: decidido como «no ahora».** La señal existe (una fila real)
pero es una, y ampliar el alcance por iniciativa propia es la regla 8.

---

## 21/08/2026 · «tinte de raíz» pasó de PREGUNTAR a DECIDIR, y nadie lo pidió

Efecto lateral de marcar los nueve complementos que confirmó Yulia para poder publicar el
enlace. No es un fallo —la resolución nueva es correcta— pero **es un sitio donde el bot dejó
de preguntar y empezó a decidir, y ese salto lo produjo un cambio de DATOS, no de código**.
Aceptado por el dueño el 21/08 («un tinte de raíz ES una color raíz, y preguntar por algo que
está claro también molesta») con el encargo explícito de mirarlo en la próxima auditoría.

### Qué cambió, medido contra el catálogo vivo

```
                        ANTES (Difuminado ofertable)   DESPUÉS (Difuminado = complemento)
  «tinte de raíz»       null → el bot pregunta         Color raíz · 75 € / 120 min
  «retoque de raíz»     null → el bot pregunta         Color raíz · 75 € / 120 min
  «me toca la raíz»     null → el bot pregunta         Color raíz · 75 € / 120 min
  «color raíz»          Color raíz                     Color raíz        (sin cambio)
```

### Por qué, que es lo que no hay que volver a excavar

La pasada fuzzy de `extractServiceFromText` entra por `CATEGORY_KEYWORDS` (`raiz` → Color
Premium) y puntúa las entradas de esa categoría. Con «Difuminado de raíz» todavía ofertable,
**«Difuminado de raíz» y «Color raíz» empataban a 1** —las dos casan solo `raiz`— y un empate
que el prefijo no rompe devuelve `null` a propósito: preguntar es más barato que cobrar de
más en silencio. Retirado el difuminado de la lista ofertable, el empate desaparece y «Color
raíz» gana sola.

O sea: **el `null` de antes no era un juicio sobre esas frases, era un empate**. Nadie decidió
que «tinte de raíz» debía preguntarse; salía de que había dos candidatos. Y por el mismo
motivo puede volver a cambiar sin que nadie toque código: le basta a Yulia con añadir otra
entrada a Color Premium que case `raiz`, y las tres frases vuelven a `null`.

### Qué mirar en la auditoría

1. **¿Acierta de verdad?** «me toca la raíz» resuelve hoy a Color raíz (75 €, 120 min). Si la
   clienta quería el difuminado de 40 €, es el error caro que el veto de `difuminado` tapa
   solo cuando dice esa palabra.
2. **Cuántos sitios más tienen esta forma.** Este empate-que-desaparece es genérico: cualquier
   categoría que se quede con UNA sola entrada casando su keyword deja de preguntar. Con las
   nueve marcadas, las candidatas son Color Premium (6→4), Manicura/Pedicura (10→7), Matiz
   mujer (3→2) y Reconstrucción (3→2). No está medido — eso es el trabajo.
3. **Si conviene que el empate no sea la única razón de preguntar.** Hoy la decisión de
   preguntar es un subproducto de cuántas entradas hay, no una regla. Es la misma forma que
   `REACTIVE_ONLY_CATEGORIES`: conducta que depende de datos que edita la dueña, sin que ella
   lo sepa. (`COBERTURA_MECHAS_CLASICAS` era el tercer caso de esa familia y se cerró el
   21/08/2026 llevándose la cobertura al propio catálogo — ver CLAUDE.md.)

**No decidido como «no arreglar»: decidido como «no ahora»**, y con el cambio aceptado en
firme. Contexto completo del marcado: CLAUDE.md, sección «Dar de baja un servicio».
