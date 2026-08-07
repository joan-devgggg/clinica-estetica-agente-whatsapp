# Fase 2 — cerrar el día

**Plan. No hay nada construido.** Escrito el 07/08/2026 para decidirlo antes de tocar código.

## Qué falta y por qué es otra cosa

La Fase 1 registra lo que entró (`cobros`, 035) y con qué atribución (`atribucion`, 036), y
`/caja` lo enseña repartido por estilista. Lo que **no** existe es el acto de cerrar: contar el
cajón, decir cuánto hay de verdad, y dejar constancia de la diferencia.

Y no es un informe más, es un **hecho nuevo**. Hoy el resumen del día se recalcula cada vez que
se abre la pantalla: si mañana entra un cobro con `fecha_caja` de ayer, el resumen de ayer cambia
solo. Eso está bien para un resumen y es inaceptable para un cierre — un día cerrado tiene que
seguir diciendo lo que dijo cuando se cerró.

---

## La tabla

```
cierres_caja
  id, organization_id
  fecha_caja        DATE      · el día que se cierra (Madrid, como en cobros)
  stylist_id        → stylists · de quién es esta caja
  stylist_nombre    congelado

  esperado_efectivo NUMERIC   · lo que sumaban sus cobros en efectivo AL CERRAR
  contado_efectivo  NUMERIC   · lo que ella dice que hay en el cajón
  diferencia        NUMERIC   · contado - esperado  (se guarda, no se deriva)
  tarjeta_referencia NUMERIC  · el total en tarjeta al cerrar, solo para mirar

  cerrado_at, cerrado_por → profiles, atribucion ('confirmada' | 'declarada')
  nota              TEXT
  estado            'vigente' | 'anulado'
  corrige_a         → cierres_caja
  motivo_correccion TEXT
```

### Cuatro decisiones que vienen de lo ya construido

**1. `esperado_efectivo` se CONGELA al cerrar, no se recalcula.** Es la lección de la migración
021 aplicada un piso más arriba: si se recalculara, un cobro añadido después movería en silencio
un día ya cerrado. Congelado, la diferencia entre lo congelado y lo que suma hoy **es un dato
visible** en vez de un cambio invisible.

**2. `diferencia` se guarda, no se deriva.** Podría calcularse restando dos columnas de la misma
fila y saldría igual. Se guarda igual porque es LA cifra del cierre, y una cifra que se recalcula
al leer acaba dependiendo de cómo se lea.

**3. Un cierre es inmutable, y se corrige con fila nueva.** Mismo trigger y mismo `corrige_a` que
`cobros`. Volver a contar el cajón no reescribe lo que se dijo antes: lo sustituye a la vista.

**4. La atribución también aplica.** Cerrar con PIN es una afirmación más fuerte que cerrar sin
él, exactamente igual que cobrar. Misma columna, mismo mecanismo, cero infraestructura nueva.

---

## Lo que pasa después de cerrar

Es la parte que hay que decidir bien, porque es la que decide si el cierre se usa o se esquiva.

**Un cobro con `fecha_caja` de un día ya cerrado NO se bloquea.** Bloquearlo obligaría a
apuntarlo en otro día —a mentir— y eso es peor que un cierre desactualizado. Lo que pasa en su
lugar: el día cerrado queda marcado como **movido desde que se cerró**, comparando el
`esperado_efectivo` congelado con lo que suman ahora sus cobros vigentes. La pantalla lo enseña
y se resuelve volviendo a cerrar (fila nueva con `corrige_a`).

Esto es exactamente el patrón de `servicio_facturado` en la 031: no se revaloriza sola, se AVISA
de que ya no cuadra y decide una persona.

**Un día sin cobros SÍ se puede cerrar**, con 0. "No se cerró" y "se cerró a cero" son hechos
distintos y hoy no se distinguen.

---

## Lo que NO entra en la Fase 2

- **Alertas de descuadre.** Siguen esperando datos reales para calibrar el umbral. Cuando los
  haya, salen de `cierres_caja.diferencia` y de ninguna otra parte.
- **Arqueo por denominaciones** (cuántos billetes de 50, etc.). Es otro nivel de detalle y nadie
  lo ha pedido.
- **Cierre del salón entero** como fila propia. La suma de las cajas individuales es una vista,
  no un hecho: hacerla fila obligaría a mantener dos verdades sincronizadas.

---

## Tres cosas que decidir antes de escribir código

**1. ¿Quién cierra?** Cada estilista la suya, o la dueña todas. Cambia la pantalla y cambia qué
significa `cerrado_por`.
→ *Recomendación:* cada una la suya, con su PIN, y la dueña puede cerrar cualquiera (queda como
`declarada` si no mete el PIN de esa estilista). Es coherente con "cada una responde de su caja"
sin dejar el día a medias cuando alguien se va antes.

**2. ¿Qué pasa con los cobros sin estilista?** Hoy `cobrado_por` puede ser null (nadie eligió
quién cobraba). Ese dinero no tiene caja a la que pertenecer.
→ *Recomendación:* un cierre del grupo "sin estilista", igual que el bucket que ya existe en el
resumen. Feo pero honesto: esconderlo dejaría dinero fuera de todo cierre.

**3. ¿Cerrar bloquea algo?** ¿Se puede seguir cobrando en un día cerrado desde la propia
pantalla, o solo corrigiendo?
→ *Recomendación:* no bloquear nada, marcar el día como movido. Ver arriba.

---

## Red

`tests/cierre-caja.test.js` con lo mismo que se le pidió a la Fase 1: que el esperado quede
congelado, que un cobro posterior marque el día como movido en vez de cambiarlo, que cerrar dos
veces no duplique, que una diferencia de 0 sea un cierre válido y distinto de no haber cerrado,
y que la migración rechace de verdad lo que dice rechazar (probado contra la BD en un bloque que
revierte, como la 035 y la 036).
