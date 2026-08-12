# Auditoría «afirmar sin verificar» — Caja, cierres, PIN, cobros y lista negra

**Fecha:** 12/08/2026 · **Alcance:** SOLO informe, nada arreglado en esta pasada.
**Motivo:** es el código escrito entre el 05 y el 11/08/2026 y no ha pasado por ninguna
auditoría de la familia (las dos anteriores son del 29-30/07 y del 05-06/08, y las dos son
anteriores a las migraciones 035-039).

Superficie recorrida, entera y línea a línea:

| Pieza | Ficheros |
|---|---|
| Endpoints de caja, cobros, cierres y PIN | `webhook.js:418-850`, `webhook.js:1049-1063`, `webhook.js:1375-1394` |
| Capa de datos | `services/db.js:1720-2135` (cobros, cierres, PIN) y `2181-2220` (lista negra) |
| PIN puro | `services/pin.js` |
| Panel — Caja | `caja/page.tsx`, `caja/revision/page.tsx`, `components/caja/*` (5), `lib/caja-session.ts` |
| Panel — PIN y lista negra | `configuracion/stylist-pins-section.tsx`, `lista-negra/page.tsx`, `lib/blacklist.ts` |
| Rama de lista negra del bot | `bot.js:3849-3912` |

## Resumen

**Lo que hay que decir primero: la parte de DINERO está bien.** Las cinco escrituras de
`cobros`/`cierres_caja`/`stylist_pins` pasan por `assertRowsAffected` o `assertWrite`, las once
lecturas de caja pasan por `assertRead`, y las siete pantallas cantan lo que devolvió el
servidor y no lo que enviaron. `/api/caja/pendientes`, `/api/caja/resumen` y
`/api/caja/cierre` con un fallo de lectura **lanzan** en vez de devolver `[]`, y la pantalla
pinta el aviso rojo **y nada más** (`caja/page.tsx:267`) precisamente para que un cero no se
pueda confundir con un día tranquilo. `cobroRapido` recarga incluso en el camino de error, y
el toast dice `cobro.importe_total` —lo guardado— y no el importe local. Nada de esto hay que
tocarlo.

**Los seis hallazgos están todos fuera de la caja**, y cinco de los seis caen en la misma
pantalla: la lista negra. Que es, además, la capacidad de urgencia que se devolvió al menú el
10/08 justo porque «se usa el día que hace falta».

| | Hallazgo | Sitio | Qué se afirma sin verificar |
|---|---|---|---|
| 🔴 1 | `getBlacklist` no mira el `error` | `db.js:2240` | «no hay nadie bloqueado» |
| 🔴 2 | La pantalla de lista negra se traga los dos fallos | `lista-negra/page.tsx:49,77` | «lista negra vacía» / «no existe ese contacto» |
| 🟠 3 | El aviso de bloqueo se marca ANTES de que Telegram entregue | `bot.js:3874-3888` | «ya avisado» |
| 🟠 4 | `getPendingActions` + `resolvePendingAction` mudos en el desbloqueo | `db.js:2504,2516` | «desbloqueado y escalada resuelta» |
| 🟡 5 | `clearStylistPin` no comprueba filas | `db.js:2112` | «PIN retirado» |
| 🟡 6 | El no-show del panel no aísla `setBlacklist` | `webhook.js:945-950` | un 500 sobre un PUT que sí escribió |

Y dos cosas que no son de la familia pero salieron por el camino, al final del documento.

---

## 🔴 1 · `getBlacklist` devuelve `[]` cuando la lectura falla

`services/db.js:2238-2247` es de los pocos supervivientes del patrón viejo:

```js
const { data } = await supabase
    .from('contacts').select('*')
    .eq('organization_id', oid).eq('is_blacklisted', true)
    .order('updated_at', { ascending: false });
return (data || []).map(rowToPublic);
```

Sin `error`, sin `assertRead`. Un fallo de Supabase, un RLS que cambie o un timeout devuelven
`data = null` → `[]` → `GET /api/lista-negra` responde **200 con una lista vacía**, que es
indistinguible de «no hay nadie bloqueado».

Lo que lo hace un 🔴 y no un 🟡 es lo que la pantalla escribe encima de ese `[]`
(`lista-negra/page.tsx:169-178`):

> **Lista negra vacía** · Los no-shows y rechazos de Bizum se añaden aquí automáticamente

O sea: no es un hueco mudo, es una **afirmación positiva** de que el mecanismo funciona y no
ha atrapado a nadie. Y el día que se mira esa pantalla es el día del acosador del 10/08. Es el
mismo patrón exacto que `getAppointmentsByDateRange` («no hay citas») y el que motivó
`assertRead`.

El vecino `getVipList` (`db.js:2261`) tiene el mismo agujero y consecuencia menor (una lista
VIP vacía no promete nada operativo).

## 🔴 2 · La pantalla se traga los dos fallos, y no tiene sitio donde enseñarlos

`lista-negra/page.tsx` no tiene estado de error. Los dos `catch` van a lista vacía:

```js
} catch {
  setItems([]);        // línea 49  — fetchItems
}
} catch {
  setResults([]);      // línea 77  — handleSearch
}
```

Son **dos afirmaciones distintas y las dos falsas**:

- `fetchItems` → «lista negra vacía» (agravado por el hallazgo 1: aunque `getBlacklist`
  lanzara y el endpoint diera 500, esta pantalla **seguiría** diciendo «vacía»). Los dos
  arreglos hacen falta; ninguno de los dos basta solo.
- `handleSearch` → el buscador no encuentra nada, que en esa pantalla se lee como «ese número
  no está en el sistema». Se está buscando a alguien para bloquearlo: creer que no existe es
  irse sin bloquear.

Y no es que falte criterio en el equipo: **`/caja` lo hace bien tres pantallas más allá**
(`error` en estado, banner `role="alert"`, y con error no se pinta nada más). Aquí solo falta
copiar ese patrón, `mensajeDeFallo`/`mensajeDeError` incluidos.

## 🟠 3 · El aviso de bloqueo se da por hecho antes de que Telegram lo entregue

`bot.js:3873-3888`, primer mensaje de un contacto bloqueado:

```js
if (!session.blacklistNotified) {
    session.blacklistNotified = true;          // ← ANTES de todo
    ...
    notifyBlacklistAlert(...).catch(() => {}); // ← fire-and-forget
    ...
}
persistSession(orgId, userPhone, session);     // ← y se persiste a SQLite
```

Es la inversión literal de la regla de `alertOnce`, que marca la clave **después** de que
Telegram confirme (`telegram_notify_ok`) y la libera si no. Aquí el flag se marca primero, y
además viaja a SQLite en `buildSessionExtra`, así que sobrevive a reinicios.

Lo que hace que no se recupere solo: **`rearmarSiLaFichaNoLoRefleja` no cubre este caso.** Su
desempate es `contact.bot_mode !== 'manual'`, y en el camino de fallo de Telegram el
`setLeadBotMode(…, 'manual')` **sí** tuvo éxito (va antes, líneas 3878-3882). La ficha refleja
el bloqueo perfectamente; lo único que no ocurrió es la entrega. El rearme mira hacia otro
lado y el aviso se pierde para siempre, en silencio.

Atenuante real, y por eso es 🟠 y no 🔴: la `pending_actions` de escalación sí se crea, así que
el bloqueo aparece en el Monitor arriba del todo. Lo que se pierde es el empujón —el que hace
que alguien lo MIRE— y se pierde justo en el escenario para el que se escribió.

`notifyBlacklistAlert` (`telegram.js:199-218`) tampoco ayuda: no devuelve si entregó. Cada
`sendMessage` lleva su `.catch(e => logger.error('telegram_notify_error'…))` dentro del bucle,
así que la función resuelve igual con cero entregas. El `.catch(() => {})` del call site es
mudo pero casi inocuo — no queda nada que capturar.

## 🟠 4 · Desbloquear: las dos lecturas de la escalada son mudas

`PUT /api/leads/:id/bot-mode` con `mode:'auto'` (`webhook.js:1383-1392`) es el **primer** paso
del desbloqueo, el que se puso en ese orden el 10/08 precisamente para no dejar «desbloqueados
a los que no contesta nadie». Los dos pasos internos se tragan el error:

```js
const escalations = await db.getPendingActions(orgId, 'escalation');  // db.js:2512 sin error
const match = escalations.find(...);
if (match) { await db.resolvePendingAction(orgId, match.id, ...); }   // db.js:2518 sin error
...
res.json({ ok: true, mode });
```

- `getPendingActions` con fallo de lectura → `[]` → no hay `match` → **la escalada no se
  resuelve y nadie se entera**. El endpoint devuelve `{ok:true}` igual.
- `resolvePendingAction` con fallo → `data` a null → `return data || null`, que ningún llamante
  mira. Idem.

El panel encadena entonces el `DELETE /api/lista-negra/:id`, que sí verifica, y canta
**«Eliminado de la lista negra»**. Verdad a medias: la marca se quitó, la `pending_action`
sigue en `pending` y la conversación sigue mostrándose escalada. Y una `pending_action` abierta
es una de las tres cosas que impiden que `auto-return` rescate esa conversación más adelante.

`getPendingActions` ya estaba señalada en CLAUDE.md («se traga el `error`: un vigilante ciego
además tranquiliza», sección de `espera-alert.js`), pero solo se resolvió allí, esquivándola.
Aquí no se puede esquivar: es el camino del desbloqueo.

## 🟡 5 · `clearStylistPin` dice «PIN retirado» sin mirar si retiró algo

`db.js:2112-2118` tiene `assertWrite` (cubre el error de Supabase) pero **no**
`assertRowsAffected`, y devuelve `true` fijo. `DELETE /api/stylists/:id/pin` responde
`{ok:true}` y el panel canta «PIN retirado» (`stylist-pins-section.tsx:68`).

Con un `stylistId` que no case —o de otra org— no se borra nada y la pantalla lo afirma igual.
El daño es acotado y en la dirección buena (un PIN que sigue existiendo no atribuye de más:
confirma cobros de quien de verdad lo teclea), pero es literalmente el caso `deleteLead` del
07/08 y cuesta una línea. Sus hermanas `setStylistPin` y `createCobro` ya lo hacen bien.

## 🟡 6 · El no-show del panel: un 500 sobre un PUT que ya escribió

`webhook.js:945-950`. `setBlacklist` lanza (y hace bien), pero aquí no está aislado:

```js
if ((req.body.noShow === true || req.body.estado === 'no_show') && apt.contact_id) {
    const noShowContact = await db.findById(orgId, apt.contact_id);
    await db.setBlacklist(orgId, apt.contact_id, 'No-show');   // ← sin try
    notifyBlacklistAlert(...).catch(() => {});
}
```

Si falla, el `catch` del endpoint devuelve **500** sobre un PUT cuyo `updateAppointment` ya
escribió el no-show. La pantalla dirá que no se pudo, y el no-show está puesto.

Es el caso opuesto al que ya está resuelto veinte líneas más abajo: `stampBillingSnapshot` e
`incrementVisitCount` van cada una en su `try` con `logger.error`, con el comentario que
explica por qué («el UPDATE de la cita YA tuvo éxito y el panel merece su 200»). El mismo
razonamiento aplica aquí y no se aplicó. Falla hacia el lado recuperable —error sobre éxito
parcial, no éxito sobre fallo— y por eso es 🟡.

---

## Dos cosas que no son de esta familia

**Dos `console.log('[DEBUG …')` vivos en producción**, `webhook.js:924` y `webhook.js:946`. El
primero vuelca la cita ENTERA en cada `PUT /api/appointments/:id`; el segundo, el `contact_id`
en cada no-show. No pasan por `logger`, así que no llevan nivel ni org y no se filtran.

**`getBroadcastAudience` (`db.js:2304`) tiene el mismo agujero**, fuera de alcance y anotado
aquí para no perderlo: un fallo de lectura devuelve `{destinatarios: [], excluidos: []}`, o sea
una campaña que informa de cero destinatarios **y cero excluidos** — que es exactamente la
forma que tiene esa función de decir «no hay nadie a quien escribir», sin ningún excluido que
haga sospechar. Con una campaña por tandas en curso, conviene mirarlo antes de la tanda 2.

## Orden que se propone

1. Hallazgos 1 y 2 juntos: son la misma pantalla y ninguno de los dos arreglos basta solo.
2. Hallazgo 4 (`getPendingActions` + `resolvePendingAction`): toca el camino del desbloqueo, y
   `getPendingActions` tiene además otros cuatro call sites.
3. Hallazgo 3: es el que más piensa que cuesta (¿`alertOnce`, o que `notifyBlacklistAlert`
   devuelva si entregó, o ampliar el desempate del rearme?). No es una línea.
4. Hallazgos 5 y 6, de paso, con su test cada uno.
