// Puerto al cliente de splitServiceNames / normalizeText (services/helpers.js). Vive en un
// fichero SIN dependencias (ni React, ni @/lib/api) a propósito: así el test de paridad
// tests/service-names-parity.test.js puede requerirlo desde Node y comparar cada nombre del
// catálogo REAL contra la versión del backend. Si las dos se desincronizan, el panel guardaría
// un `service` que la facturación parsea de otra forma.

export function normalizeServiceName(value: string | null | undefined): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Forma mínima que necesita el split: el nombre completo ya resuelto por el backend
// (buildFullServiceName) y el nombre crudo del catálogo.
export interface SplittableEntry {
  fullName: string;
  nombre?: string;
}

// Equivalente a findCatalogEntriesExact(...)[0] del backend: primero por nombre completo
// generado, y solo si ninguno casa, por nombre crudo del catálogo.
function resolveExact<T extends SplittableEntry>(name: string, catalog: T[]): T | null {
  if (!name || !catalog?.length) return null;
  const target = normalizeServiceName(name);
  if (!target) return null;
  const byFull = catalog.find((e) => normalizeServiceName(e.fullName) === target);
  if (byFull) return byFull;
  return catalog.find((e) => normalizeServiceName(e.nombre) === target) || null;
}

// Parte el string de appointments.service en NOMBRES de servicio. No basta con partir por
// " + ": hay servicios de catálogo que llevan ese separador DENTRO del nombre ("Pedicura +
// esmaltado", "Manicura + gel"). Se recompone de izquierda a derecha con el tramo más largo
// que matchee de forma determinista ("longest match"), igual que splitServiceNames en
// services/helpers.js — el formulario debe reconstruir exactamente las filas que la
// facturación va a cobrar.
export function splitServiceNames<T extends SplittableEntry>(
  serviceString: string | null | undefined,
  catalog: T[]
): string[] {
  const parts = String(serviceString || "")
    .split(" + ")
    .map((s) => s.trim())
    .filter(Boolean);

  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let taken = 1;
    // De más largo a más corto; solo tramos de 2+ partes (1 parte es el caso por defecto).
    for (let j = parts.length; j > i + 1; j--) {
      if (resolveExact(parts.slice(i, j).join(" + "), catalog)) {
        taken = j - i;
        break;
      }
    }
    names.push(parts.slice(i, i + taken).join(" + "));
    i += taken - 1;
  }
  return names;
}

// Une varios nombres en el string que se guarda en appointments.service. El separador es
// exactamente " + " (con espacios) porque es lo que parsea el backend; los vacíos se
// descartan para que una fila a medio rellenar no meta un "A +  + B".
export function joinServiceNames(names: (string | null | undefined)[]): string {
  return (names || []).map((n) => String(n || "").trim()).filter(Boolean).join(" + ");
}

// Entrada con duración conocida: el mismo shape que sirve /api/service-catalog.
export interface DurationEntry extends SplittableEntry {
  duracion?: number | null;
}

// Duración total de una cita a partir de su string de servicios, o `null` si no se puede
// saber (algún servicio es texto libre, o su duración no es un número útil).
//
// Es la ÚNICA fuente de la duración en el formulario: se deriva de `servicio` en cada
// render, no se guarda en el estado. Antes vivía en el estado y solo se refrescaba al tocar
// el desplegable, así que al REABRIR una cita multi-servicio el campo enseñaba la duración
// vieja de la BD (Paloma: resumen "3 servicios · 320 min" y campo en 60) y al guardar el PUT
// mandaba ese 60, recortando ends_at a una hora para una visita de más de cinco.
//
// El lookup es ESTRICTO por nombre completo, nunca por el `nombre` crudo del catálogo: el
// catálogo real repite nombres ("Largo" sale 4 veces, de 120 a 360 min según la categoría),
// y resolver por el crudo elegiría uno al azar — un número plausible y equivocado. Sin
// duración fiable devolvemos null y el panel deja el campo editable.
export function catalogDurationTotal<T extends DurationEntry>(
  servicio: string | null | undefined,
  catalog: T[]
): number | null {
  const nombres = splitServiceNames(servicio, catalog);
  if (!nombres.length) return null;
  let total = 0;
  for (const nombre of nombres) {
    const target = normalizeServiceName(nombre);
    const entry = catalog.find((e) => normalizeServiceName(e.fullName) === target);
    const min = Number(entry?.duracion);
    if (!entry || !Number.isFinite(min) || min <= 0) return null;
    total += min;
  }
  return total;
}

// ─── Filas del formulario multi-servicio ──────────────────────────────────────────────
// El estado de ServiceListField es {servicio, numFilas}: los NOMBRES no se duplican en
// estado local (viven en el `servicio` del formulario padre, la fuente de verdad) y lo único
// local es cuántas filas se enseñan, para poder mostrar una vacía recién añadida que todavía
// no existe en `servicio`. Las transiciones viven aquí, puras, porque son la parte sutil:
// ver tests/service-rows.test.js.
export interface ServiceRowsState {
  servicio: string;
  numFilas: number;
}

// Filas visibles. Se muestran al menos tantas como servicios haya guardados (por si el
// `servicio` entrante trae más de los que numFilas contaba) y nunca menos de una.
export function serviceRows<T extends SplittableEntry>(state: ServiceRowsState, catalog: T[]): string[] {
  const nombres = splitServiceNames(state.servicio, catalog);
  const total = Math.max(state.numFilas, nombres.length, 1);
  return Array.from({ length: total }, (_, i) => nombres[i] ?? "");
}

export function addServiceRow<T extends SplittableEntry>(state: ServiceRowsState, catalog: T[]): ServiceRowsState {
  return { ...state, numFilas: serviceRows(state, catalog).length + 1 };
}

// Editar una fila NO cambia cuántas hay: al rellenar la recién añadida, `servicio` crece y el
// max() de serviceRows ya la cuenta. Si aquí se recalculara numFilas desde las filas rellenas,
// añadir una fila y rellenar OTRA haría desaparecer la vacía recién añadida.
export function setServiceRow<T extends SplittableEntry>(
  state: ServiceRowsState,
  idx: number,
  valor: string,
  catalog: T[]
): ServiceRowsState {
  const filas = serviceRows(state, catalog);
  filas[idx] = valor;
  return { servicio: joinServiceNames(filas), numFilas: Math.max(state.numFilas, filas.length) };
}

// Borrar sí decrementa: sin ello quedaría un hueco vacío fantasma detrás, porque `servicio`
// pierde un nombre pero numFilas seguiría en el número anterior.
export function removeServiceRow<T extends SplittableEntry>(
  state: ServiceRowsState,
  idx: number,
  catalog: T[]
): ServiceRowsState {
  const filas = serviceRows(state, catalog).filter((_, i) => i !== idx);
  return { servicio: joinServiceNames(filas), numFilas: Math.max(filas.length, 1) };
}
