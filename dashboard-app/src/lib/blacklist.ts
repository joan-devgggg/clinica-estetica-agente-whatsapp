// Qué pasa DE VERDAD al marcar `contacts.is_blacklisted`, escrito para que la confirmación del
// panel no prometa lo que el código no hace. Una confirmación genérica ("¿Seguro que quieres
// bloquear?") es peor que ninguna: hace decidir sin decir qué se decide, y aquí las dos
// sorpresas —que el bot todavía le contesta una vez y que el aviso de Telegram lleva un botón
// que DESBLOQUEA— son justo las que importan cuando quien está al otro lado amenaza.
//
// Fichero sin dependencias (ni React, ni @/lib/api, ni @/lib/types) a propósito: así
// tests/lista-negra-panel.test.js puede requerirlo desde Node y afirmar el texto.
//
// Cada línea de EFECTOS_BLOQUEO está anclada a su sitio en el código. Si alguna deja de ser
// cierta hay que cambiar las dos cosas a la vez; el texto no es decoración, es la descripción
// de un comportamiento:
//
//  1. `bot.js:3813-3836` — el bot NO se queda mudo del todo. La primera vez que escribe tras
//     el bloqueo recibe «Gracias por tu mensaje 🙏 En breve te atenderá nuestro equipo» y solo
//     a partir de ahí calla. Y `blacklistNotified` NO viaja en `buildSessionExtra`, así que
//     cada sesión nueva (timeout de 1 h, GC o reinicio del proceso) lo vuelve a mandar.
//     Fotos y audios tampoco se contestan: `isBlacklistedNow` (bot.js:6015) cubre esa rama,
//     que responde antes de llegar a `processMessageCore`.
//  2. Mismo bloque — pone `bot_mode='manual'`, `escalation_reason='lista_negra'`, abre una
//     `pending_actions` y dispara `notifyBlacklistAlert`.
//  3. `services/telegram.js:187-206` y `:589-601` — ese aviso lleva un botón «✅ Sí, continuar»
//     que llama a `removeBlacklist`, devuelve el bot a 'auto' y ADEMÁS le manda un mensaje.
//  4. `db.js:getBroadcastAudience` — campañas fuera siempre, incluso pasando allowlist
//     explícito: el `.or(is_blacklisted…)` va en la consulta, antes del `.in(wa_phone)`.
//  5. `db.js:getLeadsPendientesRecordatorio` — recordatorio de 24 h fuera.
//  6. `db.js:getCompletedAppointmentsForReview` — petición de reseña de Google fuera.
//  7. `setBlacklist` solo escribe en `contacts`: las citas de `appointments` siguen en pie.
//  8. Ni el Monitor (`whatsapp.ts:getConversations`) ni Clientes filtran lista negra: sigue
//     apareciendo. Y en el Monitor sube al PRIMER puesto, porque ordena delante las
//     conversaciones en manual con `escalation_reason` — que es justo lo que el bloqueo pone.

export interface BlacklistTarget {
  nombre?: string | null;
  telefono?: string | null;
  is_blacklisted?: boolean;
  blacklist_reason?: string | null;
}

export interface ConfirmacionBlacklist {
  titulo: string;
  intro: string;
  /** Lo que pasa exactamente. Se pintan como lista: se leen de un vistazo, un párrafo no. */
  efectos: string[];
  /** Texto del botón que ejecuta la acción. Dice el verbo, no "Aceptar". */
  cta: string;
}

/**
 * Cómo llamar al contacto en el aviso. El teléfono es el respaldo y no un "este contacto"
 * genérico: una ficha puede estar a nombre de otra persona —un número que cambia de manos—
 * y entonces el nombre es lo ÚNICO que no identifica a quien se está bloqueando.
 */
export function nombreParaAviso(t: BlacklistTarget): string {
  const nombre = (t.nombre || "").trim();
  const telefono = (t.telefono || "").trim();
  if (nombre && telefono) return `${nombre} (${telefono})`;
  return nombre || telefono || "este contacto";
}

export const EFECTOS_BLOQUEO: readonly string[] = [
  "El bot no se calla del todo de golpe: la próxima vez que escriba recibirá «En breve te atenderá nuestro equipo», y a partir de ahí ya no le contesta nada, ni a fotos ni a audios.",
  "Cada vez que escriba, su conversación pasa a manual y llega un aviso a Telegram con un botón «✅ Sí, continuar» que lo DESBLOQUEA y le manda un mensaje: no lo pulses.",
  "Seguirá apareciendo arriba del Monitor y en Clientes, con todo su historial: bloquear no borra ni oculta nada.",
  "No le llegará ninguna campaña, ni el recordatorio de 24 h, ni la petición de reseña de Google.",
  "Sus citas NO se cancelan: las que tenga siguen en la agenda (lo que no recibirá es su recordatorio).",
];

export const EFECTOS_DESBLOQUEO: readonly string[] = [
  "El bot vuelve a contestarle con normalidad y su conversación vuelve a modo automático.",
  "Volverá a entrar en las campañas, en el recordatorio de 24 h y en la petición de reseña.",
  "No se le envía ningún mensaje al desbloquear: si quieres escribirle, hazlo desde el Monitor.",
];

export function confirmacionBloqueo(t: BlacklistTarget): ConfirmacionBlacklist {
  return {
    titulo: "Bloquear contacto",
    intro: `Vas a bloquear a ${nombreParaAviso(t)}. Esto es lo que pasa:`,
    efectos: [...EFECTOS_BLOQUEO],
    cta: "Bloquear",
  };
}

export function confirmacionDesbloqueo(t: BlacklistTarget): ConfirmacionBlacklist {
  return {
    titulo: "Desbloquear contacto",
    intro: `Vas a desbloquear a ${nombreParaAviso(t)}. Esto es lo que pasa:`,
    efectos: [...EFECTOS_DESBLOQUEO],
    cta: "Desbloquear",
  };
}
