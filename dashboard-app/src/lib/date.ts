// Utilidades de fecha del dashboard.
//
// Regla: las rejillas de calendario operan sobre FECHAS-CALENDARIO (YYYY-MM-DD),
// no sobre instantes. Por eso `ymd` deriva la clave de los componentes locales
// (nunca `toISOString`, que devuelve UTC y desplaza el día). Para INSTANTES ISO
// (p. ej. `starts_at`) usa `madridDateKey`, que sí fija Europe/Madrid.

const MADRID_TZ = "Europe/Madrid";

/** Clave de fecha `YYYY-MM-DD` a partir de los componentes locales de un Date. */
export function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parsea `YYYY-MM-DD` a un Date al mediodía local, evitando cruces de
 * medianoche/DST que desplazarían el día.
 */
export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

/**
 * Para un timestamp ISO (instante), su fecha-calendario en Europe/Madrid.
 * `en-CA` produce el formato `YYYY-MM-DD`.
 */
export function madridDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: MADRID_TZ });
}

/** Para un timestamp ISO (instante), su hora `HH:mm` en Europe/Madrid. */
export function madridTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-ES", {
    timeZone: MADRID_TZ,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Devuelve un nuevo Date desplazado `n` días. */
export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Lunes de la semana que contiene `d` (a medianoche local). */
export function getMondayOf(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
