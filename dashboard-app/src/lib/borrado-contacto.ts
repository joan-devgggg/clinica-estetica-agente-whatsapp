// Qué destruye DE VERDAD borrar un contacto, escrito para que la confirmación del panel no
// se calle la mitad. Hasta el 15/08/2026 el botón «Eliminar» de la ficha no preguntaba nada:
// un clic y la ficha desaparecía — y con ella, en silencio, la conversación entera.
//
// Pasó de verdad: Olga Yarmak (11/08/2026, 06:37:11 UTC). Se borró su ficha desde el panel y
// se fueron 30 mensajes de una conversación que se había auditado entera dos días antes. No
// hubo ningún DELETE contra `messages`: se los llevó `ON DELETE CASCADE`, sin traza, y se
// detectó cuatro días después por un descuadre de recuentos.
// Historia: docs/incidentes-cerrados.md#olga-borrada
//
// La regla que sigue este texto: **decirlo, no impedirlo**. No hay doble confirmación ni
// bloqueo — quien borra suele tener un motivo bueno (el número cambió de manos, no es una
// clienta). Lo que faltaba no era una barrera, era la frase que dice qué se pierde y que hay
// otra puerta si lo que se quiere es que no le llegue nada.
//
// Fichero SIN dependencias (ni React, ni @/lib/api, ni @/lib/types) a propósito, igual que
// `blacklist.ts`: así `tests/borrado-contacto-panel.test.js` puede requerirlo desde Node y
// afirmar el texto. Cada línea está anclada a su sitio en el código, y si alguna deja de ser
// cierta hay que cambiar las dos cosas a la vez:
//
//  1. `conversations.contact_id → contacts` es ON DELETE CASCADE, y
//     `messages.conversation_id → conversations` también: la conversación entera se va.
//     Verificado contra information_schema el 15/08/2026.
//  2. `appointments.contact_id → contacts` es CASCADE: las citas se van, pasadas y futuras.
//     Con ellas se va el histórico del que sale la facturación de meses ya cerrados.
//  3. `pending_actions.contact_id → contacts` es CASCADE: las escaladas abiertas se van.
//  4. `cobros.contact_id` es SET NULL y `cobros.appointment_id` es ON DELETE RESTRICT
//     (035_cobros.sql:46): si alguna cita tiene un cobro, el borrado FALLA entero y el panel
//     responde 409 con su propio mensaje (webhook.js). Por eso aquí no se promete que vaya a
//     salir bien.
//  5. `setBlacklist` (db.js) solo escribe en `contacts`: bloquear NO borra nada y se deshace
//     desde la misma ficha. Es la alternativa que se ofrece, y es reversible.

export interface ImpactoBorrado {
  mensajes: number;
  citas: number;
  escaladas: number;
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/**
 * Las líneas de lo que se destruye. Se omiten las que valen 0: una lista con «0 citas» hace
 * leer de menos justo lo que sí importa.
 *
 * `impacto` a null significa **no se ha podido contar** (la lectura falló), y entonces NO se
 * dice ninguna cifra: un «0 mensajes» inventado invita a borrar. Es la misma regla que
 * `resolveImporteReferencia` — un dato que no se resuelve se cuenta aparte, no se rellena.
 */
export function efectosBorrado(impacto: ImpactoBorrado | null): string[] {
  if (!impacto) {
    return [
      'No se ha podido contar qué se perderá (fallo de lectura).',
      'Se borrará la conversación completa, las citas y las escaladas abiertas.',
    ];
  }
  const lineas: string[] = [];
  lineas.push(
    impacto.mensajes > 0
      ? `La conversación completa: ${plural(impacto.mensajes, 'mensaje', 'mensajes')}. No se puede deshacer.`
      : 'La conversación completa (ahora mismo no tiene ningún mensaje guardado).',
  );
  if (impacto.citas > 0) {
    lineas.push(
      impacto.citas === 1
        ? '1 cita — también deja de contar en la facturación.'
        : `${impacto.citas} citas, pasadas y futuras — también dejan de contar en la facturación.`,
    );
  }
  if (impacto.escaladas > 0) {
    lineas.push(`${plural(impacto.escaladas, 'escalada abierta', 'escaladas abiertas')} que desaparecerán de la cola.`);
  }
  return lineas;
}

/** La alternativa, en el mismo diálogo: si lo que se quiere es que no le llegue nada. */
export const ALTERNATIVA_BLOQUEAR =
  'Si lo que quieres es que no le llegue nada —ni respuestas del bot, ni campañas, ni '
  + 'recordatorios, ni reseñas— bloquéalo en vez de borrarlo: hace eso y se deshace cuando quieras.';

export function confirmacionBorrado(
  nombre: string | null | undefined,
  impacto: ImpactoBorrado | null,
): { titulo: string; efectos: string[]; alternativa: string; confirmar: string; cancelar: string } {
  const quien = (nombre || '').trim() || 'este contacto';
  return {
    titulo: `Vas a eliminar a ${quien}`,
    efectos: efectosBorrado(impacto),
    alternativa: ALTERNATIVA_BLOQUEAR,
    confirmar: 'Eliminar de todas formas',
    cancelar: 'Cancelar',
  };
}
