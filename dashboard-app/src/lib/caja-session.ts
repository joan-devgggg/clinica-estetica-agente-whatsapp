/**
 * caja-session.ts — quién está cobrando en ESTE dispositivo.
 *
 * Guarda la estilista activa y su token de atribución en `sessionStorage`: muere al cerrar la
 * pestaña, no se comparte entre navegadores y no viaja a ningún sitio.
 *
 * **El PIN NUNCA se guarda.** Se teclea una vez, se cambia por un token firmado por el servidor
 * (`POST /api/caja/sesion`) y es ese token el que viaja en cada cobro. Guardar el PIN "para no
 * volver a pedirlo" convertiría un modelo de atribución en un llavero, que es exactamente lo
 * que no se quiere.
 *
 * La caducidad de verdad la impone el SERVIDOR: el token la lleva dentro y firmada. Lo de aquí
 * es solo para no enseñar "confirmada" en pantalla cuando ya sabemos que caducó — nunca es la
 * autoridad. Un reloj adelantado en el navegador no confirma nada.
 */

import type { Atribucion } from "@/lib/types";

const CLAVE = "caja.sesion.v1";

export interface CajaSesion {
  stylistId: string;
  stylistName: string;
  /** Con token = los cobros salen confirmada. Sin él, declarada — y se cobra igual. */
  token: string | null;
  /** Milisegundos epoch. Orientativo: la caducidad que manda va firmada dentro del token. */
  expiraEn: number | null;
}

function almacen(): Storage | null {
  if (typeof window === "undefined") return null;
  try { return window.sessionStorage; } catch { return null; }
}

export function leerSesion(ahora = Date.now()): CajaSesion | null {
  const s = almacen();
  if (!s) return null;
  let guardada: CajaSesion | null = null;
  try {
    const crudo = s.getItem(CLAVE);
    guardada = crudo ? (JSON.parse(crudo) as CajaSesion) : null;
  } catch { return null; }
  if (!guardada?.stylistId) return null;

  // Caducado: se conserva QUIÉN está en la caja y se tira solo el token. Así la pantalla sigue
  // sabiendo a quién atribuir —el cobro nunca se bloquea— y solo baja a "declarada" hasta que
  // vuelva a teclear el PIN. Borrar la sesión entera obligaría a re-elegir estilista y es la
  // clase de fricción por la que se acaba esquivando el PIN.
  if (guardada.token && guardada.expiraEn && guardada.expiraEn <= ahora) {
    const sinToken = { ...guardada, token: null, expiraEn: null };
    escribirSesion(sinToken);
    return sinToken;
  }
  return guardada;
}

export function escribirSesion(sesion: CajaSesion): void {
  const s = almacen();
  if (!s) return;
  try { s.setItem(CLAVE, JSON.stringify(sesion)); } catch { /* modo privado, sin espacio */ }
}

export function borrarSesion(): void {
  const s = almacen();
  if (!s) return;
  try { s.removeItem(CLAVE); } catch { /* noop */ }
}

/**
 * Sustituye el token por el renovado que devuelve cada cobro confirmado. Así la caducidad se
 * cuenta desde el ÚLTIMO cobro y no desde que se tecleó el PIN: es inactividad de verdad.
 */
export function renovarToken(token: string | null | undefined, minutos = 30, ahora = Date.now()): void {
  if (!token) return;
  const actual = leerSesion(ahora);
  if (!actual) return;
  escribirSesion({ ...actual, token, expiraEn: ahora + minutos * 60_000 });
}

/** Lo que se le enseña a quien va a tocar un botón de cobro. */
export function atribucionDe(sesion: CajaSesion | null): Atribucion {
  return sesion?.token ? "confirmada" : "declarada";
}
