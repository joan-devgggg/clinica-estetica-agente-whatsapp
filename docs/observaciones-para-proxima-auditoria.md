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
