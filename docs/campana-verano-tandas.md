# Campaña de verano de Sante — las tres tandas

`campaignKey: 'verano_tratamientos'`, org Sante (`b2c3d4e5-…-f12345678901`).

## La regla que no se puede saltar

**El allowlist se RECALCULA antes de cada tanda**, restando las exclusiones de la audiencia
del momento. No se guarda nunca la lista de destinatarios resultante.

```js
const { excluidos } = require('../data/campana-verano-exclusiones.json');
const EXCLUIDAS = new Set(excluidos.map(e => e.telefono));

const { destinatarios } = await db.getBroadcastAudience(SANTE_ORG_ID, { audience: 'todos' });
const phones = destinatarios
    .map(c => db.sanitizePhone(c.telefono))
    .filter(p => !EXCLUIDAS.has(p));
// phones → body de POST /api/campaigns/broadcast, junto a campaignKey / plantillaClave / limit
```

Por qué recalcular y no congelar los ~700 destinatarios: **el allowlist es una foto**. La
audiencia enviable pasó de 718 a 723 en dos días — entran fichas nuevas continuamente. Una
lista congelada deja fuera para siempre a toda clienta creada después, y sin dejar rastro,
porque para el motor no existían. Lo que se guarda es lo que NO cambia: las exclusiones.

**Y hay que aplicarlo en las TRES tandas.** El dedupe de `campaignKey` impide repetir
destinatarios entre tandas, pero **no recuerda a quién excluiste**: no hay ninguna fila en
`broadcast_sends` para alguien que nunca entró en la lista. Si la tanda 2 sale sin el
allowlist, las 20 fichas de `data/campana-verano-exclusiones.json` reciben la campaña, y eso
ya no se deshace.

## Los parámetros de la tanda

| | |
|---|---|
| `campaignKey` | `verano_tratamientos` — **idéntica en las tres tandas**; cambiarla haría que las mismas clientas lo recibieran dos veces |
| `plantillaClave` | `plantilla_campana` (es/en/ru/uk → `sante_verano_tratamientos2` y sufijos) |
| `mensaje` | **OMITIDO POR COMPLETO** |
| `limit` | 250 |

**Omitir `mensaje` no basta por sí solo: lo que fuerza la plantilla es `plantillaClave`.** Sin
las dos cosas, `runBroadcast` cae en `sin_mensaje` y omite a los 250 sin enviar nada
([broadcast.js:161-178](../services/broadcast.js#L161-L178)); por el endpoint HTTP devuelve 400.

Con `mensaje`, las que estén dentro de la ventana de 24 h recibirían texto libre en español en
vez de su plantilla — que es justo lo que se quiere evitar con las 187 rusoparlantes.

## Las exclusiones están PENDIENTES de revisión

`data/campana-verano-exclusiones.json` lleva `"revisado_por_duena": false`. Las 20 entradas
salen de una heurística sobre el nombre de pila y **son conjeturas**: 19 vienen del import del
Excel con 0 citas y 0 visitas, así que sobre ellas no hay más dato que el nombre. La dueña
tiene que repasarlas antes de darlas por buenas.

Joan Gascon (`34644610120`) estaba en la lista y **se quitó a mano el 06/08/2026**: quiere
recibirla.

## Lo que NO se usa para esto

- **La lista negra no.** `is_blacklisted` significa otra cosa (clienta bloqueada, p. ej. por
  no-shows) y se ve así en el panel. Usarla como filtro de campaña cambiaría el significado
  del dato en la ficha de 20 personas.
- **Sembrar filas `'sent'` en `broadcast_sends` tampoco.** Saltaría el dedupe sin esfuerzo,
  pero escribiría "enviado" sobre mensajes que nunca salieron, en la tabla de la que después
  sale el reparto por estado. Misma objeción que la lista negra: falsear el registro para
  ahorrarse un `filter`.

## Tanda 1 — LANZADA el 07/08/2026 17:22 (hora local)

`enviados: 250 · por_plantilla: 250 · texto_libre: 0 · omitidos: 0 · registro_fallido: 0 ·
fallos: [] · restantes: 454`. En `broadcast_sends`: 250 `sent`, 0 `pending`, 0 `failed`.

Allowlist recalculado en el instante del disparo: audiencia **724** (era 723 el 06/08 — creció
sola en un día) − 20 exclusiones = **704**. La tanda salió recortada a 250 por el tope de Meta,
no por el `limit`.

Reparto **por plantilla realmente enviada**, que es el dato bueno: 181 `_ru2` · 67 `es2` ·
2 `_en2`. (El reparto por `contacts.language` de ahora ya no cuadra con eso, y no es un error:
la campaña genera respuestas y el bot va actualizando el idioma observado. Ver abajo.)

**Cupo:** 250/250 consumido. La tanda 2 no puede salir hasta que la ventana móvil de 24 h
libere hueco, o sea a partir de **las 17:22 del 08/08**.

### Lo que hay que mirar ANTES de la tanda 2

**Tres de las cinco primeras respuestas fueron autocontestadores de OTROS negocios**, no
clientas: `34643209389` (DarYsol Events), `34613109685` (Save Yourself) y `34667967943` (bot de
una videógrafa). Son números de empresa metidos en la agenda como si fueran fichas de clienta.

Tiene dos consecuencias, y la segunda es la que importa:

1. El bot se pone a conversar con un autocontestador. Comprobado a los 4 minutos: 1 entrante y
   1 saliente por cada uno, **sin ping-pong** — nadie se ha quedado en bucle.
2. **El idioma de esas fichas se reescribe con el idioma del AUTOCONTESTADOR**, y queda marcado
   `language_source: 'observed'`, que es la calidad más alta que existe. Dasha Kotenko pasó de
   `es` a `uk` y ALLA Sinchuk de `ru` a `uk` por el texto de un bot ajeno. `'observed'` debería
   significar «se lo hemos leído a ELLA»; aquí significa «se lo hemos leído a su centralita».
   Con 454 envíos por delante, esto va a repetirse.

No se ha tocado nada de esto: son fichas de la dueña y el criterio para limpiarlas (¿borrar?,
¿marcar?, ¿solo revertir el idioma?) es suyo.

## Cifras de partida (06/08/2026)

- Audiencia `todos`: **723** enviables · **4** excluidas por teléfono (`numero_invalido` ×3,
  `sin_numero` ×1 — son clientas reales mal apuntadas, no descartes).
- Allowlist tras restar las 20: **702**. Medido: `in(...)` de 8.429 caracteres, 192 ms, devuelve
  exactamente 702. Probado hasta 6.000 teléfonos (72 KB) sin error, así que el tamaño no es
  un problema.
- Idioma de la audiencia: 533 `es` · 187 `ru` · 1 `en` · 0 `uk`.
- `broadcast_sends` con la clave real: **0 filas** antes de la tanda 1.
