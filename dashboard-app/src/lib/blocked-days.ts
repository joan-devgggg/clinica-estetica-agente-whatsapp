import { API, apiHeaders } from "./api";
import type { BlockedDay } from "./types";

export async function getBlockedDays(orgId: string): Promise<BlockedDay[]> {
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch(`${API}/api/blocked-days?from=${today}`, {
    headers: await apiHeaders(orgId),
  });
  if (!res.ok) return [];
  return res.json();
}

export async function createBlockedDay(
  orgId: string,
  data: { fecha: string; motivo: string; stylistId?: string | null }
): Promise<BlockedDay> {
  const res = await fetch(`${API}/api/blocked-days`, {
    method: "POST",
    headers: await apiHeaders(orgId),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Error creando bloqueo");
  }
  return res.json();
}

export async function deleteBlockedDay(orgId: string, id: string): Promise<void> {
  const res = await fetch(`${API}/api/blocked-days/${id}`, {
    method: "DELETE",
    headers: await apiHeaders(orgId),
  });
  if (!res.ok) {
    throw new Error("Error eliminando bloqueo");
  }
}
