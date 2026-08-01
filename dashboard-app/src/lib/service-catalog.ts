"use client";

import { useEffect, useState } from "react";
import { API, apiHeaders } from "@/lib/api";

// Reexportados desde el fichero sin dependencias para que quien ya importa de aquí no tenga
// que conocer los dos módulos. La lógica vive aparte porque el test de paridad con el backend
// (tests/service-names-parity.test.js) la requiere desde Node, sin React.
import { splitServiceNames } from "@/lib/service-names";
export {
  splitServiceNames,
  joinServiceNames,
  normalizeServiceName,
  serviceRows,
  addServiceRow,
  setServiceRow,
  removeServiceRow,
} from "@/lib/service-names";
export type { ServiceRowsState } from "@/lib/service-names";

// Entrada de catálogo ya resuelta por el backend: `fullName` viene de
// buildFullServiceName (services/helpers.js), el MISMO helper que resuelve
// appointments.service en el bot y en la facturación por estilista. El panel
// nunca recalcula el nombre por su cuenta para no divergir de esa lógica.
export interface ServiceCatalogEntry {
  key: string; // `${categoria}|${nombre}` — nombre solo no es único en el catálogo real
  nombre: string;
  categoria: string | null;
  precio: number | null; // null = precio se confirma en salón (ej. Consulta)
  duracion: number; // minutos
  fullName: string;
}

export function useServiceCatalog(orgId: string, enabled: boolean) {
  const [catalog, setCatalog] = useState<ServiceCatalogEntry[]>([]);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!orgId || !enabled) {
        if (!cancelled) setLoading(false);
        return;
      }
      if (!cancelled) setLoading(true);
      try {
        const res = await fetch(`${API}/api/service-catalog`, { headers: await apiHeaders(orgId) });
        const data = res.ok ? await res.json() : [];
        if (!cancelled) setCatalog(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setCatalog([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, enabled]);

  return { catalog, loading };
}

export function findCatalogEntryByFullName(
  catalog: ServiceCatalogEntry[],
  fullName: string
): ServiceCatalogEntry | null {
  if (!fullName) return null;
  const target = fullName.trim().toLowerCase();
  if (!target) return null;
  return catalog.find((e) => e.fullName.trim().toLowerCase() === target) || null;
}

// ¿TODOS los servicios de la cita casan con el catálogo? Es la condición para bloquear el
// input de duración: si todos son de catálogo la duración es la suma y no debe tocarse a
// mano; en cuanto uno es texto libre su duración es desconocida y hay que poder ponerla.
export function servicesAllInCatalog(catalog: ServiceCatalogEntry[], servicio: string): boolean {
  const nombres = splitServiceNames(servicio, catalog);
  return nombres.length > 0 && nombres.every((n) => !!findCatalogEntryByFullName(catalog, n));
}

// Estilistas cuya skill casa con la categoría del servicio elegido — mismo
// criterio que stylistCanDoService en bot.js (comparación exacta case-insensitive,
// sin difuso). Se usa solo para SUGERIR una preselección; la recepcionista
// siempre puede cambiarla.
export function stylistsForCategoria<T extends { skills?: string[] | null }>(
  stylists: T[],
  categoria: string | null
): T[] {
  if (!categoria) return stylists;
  const target = categoria.trim().toLowerCase();
  return stylists.filter((s) =>
    Array.isArray(s.skills) && s.skills.some((sk) => String(sk).trim().toLowerCase() === target)
  );
}
