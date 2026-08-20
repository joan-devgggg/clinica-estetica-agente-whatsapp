// origen-cita.ts — De dónde viene una cita, dicho como lo diría la dueña.
//
// `appointments.source` guarda 'web' | 'bot' | 'manual' y hasta el 21/08/2026 no se pintaba
// en NINGUNA pantalla: una reserva de internet era indistinguible de una que había tecleado
// una estilista. El dato estaba guardado en las tres; lo que faltaba era enseñarlo.
//
// Fichero SIN dependencias a propósito —mismo motivo que service-names.ts—: así
// tests/origen-de-cita.test.js lo ejecuta desde Node y compara esta lista contra los valores
// que de verdad ESCRIBE el backend. Con la tabla dentro de un componente de React, ese cruce
// no se puede hacer y un `source` nuevo se quedaría sin etiqueta en silencio.
//
// LO QUE NO HACE, y es la regla 3: si el valor no se reconoce —o no hay valor— devuelve
// `null` y la pantalla no pinta NADA. Una cita antigua sin dato no se etiqueta a ojo: es
// preferible no decir de dónde vino a decir de dónde vino y equivocarse. (Cuidado con esto
// al mirar filas viejas: la migración 005 añadió la columna con DEFAULT 'bot', así que lo
// anterior a ella dice 'bot' sin que nadie lo haya comprobado.)

export type OrigenCita = "web" | "bot" | "manual";

export type EtiquetaOrigen = {
  /** El distintivo de una lista. Cabe en una línea con el nombre y la hora al lado. */
  corta: string;
  /** La frase entera, para cuando ya se ha abierto la cita y hay sitio. */
  frase: string;
  /** Qué dibujo le toca. El mapa a un icono de verdad vive en un solo componente. */
  icono: "internet" | "whatsapp" | "mano";
  /**
   * Cuánto tiene que gritar. `manual` va APAGADO y no es un descuido: hoy son 81 de las 89
   * citas de Sante, y un distintivo llamativo en casi todas las tarjetas deja de distinguir
   * nada. Lo que hay que ver de un vistazo es la que NO la escribió el salón.
   */
  tono: "destacado" | "normal" | "apagado";
};

const ORIGENES: Record<OrigenCita, EtiquetaOrigen> = {
  web: {
    corta: "Por internet",
    frase: "La clienta reservó por internet",
    icono: "internet",
    tono: "destacado",
  },
  bot: {
    corta: "Por WhatsApp",
    frase: "La clienta reservó por WhatsApp",
    icono: "whatsapp",
    tono: "normal",
  },
  manual: {
    corta: "A mano",
    frase: "La apuntó el salón a mano",
    icono: "mano",
    tono: "apagado",
  },
};

export const ORIGENES_CONOCIDOS = Object.keys(ORIGENES) as OrigenCita[];

export function origenDeCita(source: unknown): EtiquetaOrigen | null {
  if (typeof source !== "string") return null;
  const clave = source.trim().toLowerCase();
  return (Object.prototype.hasOwnProperty.call(ORIGENES, clave)
    ? ORIGENES[clave as OrigenCita]
    : null);
}
