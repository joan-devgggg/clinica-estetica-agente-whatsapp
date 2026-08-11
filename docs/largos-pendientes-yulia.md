# Cómo dice una clienta el largo de su pelo — preguntas para Yulia

**Estado a 11/08/2026: pendiente de respuesta. No se toca `extractLargoPelo` hasta tenerla.**

## Por qué se pregunta en vez de decidirlo nosotros

El largo fija el precio. En Anti-encrespamiento son **120 € / 160 € / 180 €**, o sea que
equivocar la categoría son 20-60 € que se le dicen a la clienta y que luego no se cumplen.

Y no es una traducción, es un criterio: **«pecho» se mide por delante y el pelo cae por
detrás**, así que «por encima del pecho» puede ser medio o largo según dónde ponga Yulia la
raya. Un modelo de lenguaje lo resolvió como «medio» en 10 de 10 pruebas, y eso no lo
convierte en criterio — sigue siendo una conjetura sobre un precio que la clienta se cree.

Caso real (11/08/2026): una clienta contestó **«Lo tengo por encima del pecho»** y el
detector no entendió nada. Se fue sin cita.

## Lo que hoy sí resuelve

| dice | se entiende como |
|---|---|
| corto · hasta los hombros · short · до плеч · коротк | **1 · Corto** |
| medio · media melena · espalda · hasta la mitad de la espalda · escápula · medium · mid · до лопаток · средн | **2 · Medio** |
| largo · cintura · me llega a la cintura · long · до пояса · до талі · длинн · довг | **3 · Largo** |
| muy largo · por debajo de la cintura · más de cintura · very long · очень длинн · дуже довг | **4 · Muy largo** |

## Lo que NO entiende (27 formas medidas, todas devuelven "no sé")

Cuando cae aquí, el bot se queda preguntando el largo una y otra vez.

**Castellano** — por encima del pecho · hasta el pecho · por debajo del pecho · a la altura
del pecho · por la clavícula · hasta la clavícula · por los omóplatos · hasta la barbilla ·
por la mandíbula · a la altura del sujetador · hasta las axilas · por los codos · hasta la
cadera · melena corta · tipo bob

**Inglés** — shoulder-length · chest length · collarbone length · down to my waist ·
bra strap length · chin length · armpit length

**Ruso / ucraniano** — до груди · до ключиці · до підборіддя · до талии · нижче плечей

## Dos que responde MAL, no que no responde

Estas dos son peores que las de arriba, porque el bot contesta con seguridad:

1. **«por debajo de los hombros» → dice Corto (120 €).** Reconoce la palabra «hombros» e
   ignora el «por debajo». Cobra de menos y lo afirma.
2. **«до талии»** (ruso, *hasta la cintura*) **no lo entiende**, mientras que «до пояса», que
   significa lo mismo, sí. Igual **«нижче плечей»** (ucraniano, *por debajo de los hombros*).

## Lo que hace falta que conteste Yulia

Para cada punto del cuerpo, a qué categoría va — **Corto (1) · Medio (2) · Largo (3) ·
Muy largo (4)**:

| punto del cuerpo | categoría |
|---|---|
| barbilla / mandíbula | ? |
| clavícula | ? |
| **por encima del pecho** ← el caso real | ? |
| a la altura del pecho | ? |
| por debajo del pecho | ? |
| omóplatos / paletillas | ? |
| axilas | ? |
| tira del sujetador | ? |
| **por debajo de los hombros** ← hoy contesta Corto | ? |
| codos | ? |
| cadera | ? |

Y dos preguntas de criterio:

- **¿Hay alguna que no se pueda decidir sin ver el pelo?** Si la hay, se dice y no se
  inventa: el bot puede contestar «eso lo confirmamos en el salón» y seguir con la reserva,
  que es lo que ya hace cuando la clienta dice «no sé». Un precio en blanco es mucho mejor
  que uno equivocado.
- **¿Cambia la raya según el servicio?** El largo se usa en anti-encrespamiento, balayage,
  decoloración, alisado y color, y hoy la tabla es única para todos.

## Cuando llegue la respuesta

Va a `extractLargoPelo` (`services/helpers.js`), en los cuatro idiomas, con test de la trampa
de «por debajo de los hombros» (que el «por debajo» gane a «hombros»). Es también el momento
de decidir si «tipo bob» y «melena corta» entran, que son forma de corte y no medida.
