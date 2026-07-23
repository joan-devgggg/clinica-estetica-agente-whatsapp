import { API, apiHeaders } from "./api";

export type BotMode = "auto" | "manual";
export type EstadoCita = "pendiente" | "en_conversacion" | "confirmado" | "completado" | "cancelado" | "abandonado";

export interface Conversation {
  id: number;
  nombre: string | null;
  telefono: string;
  tratamiento: string | null;
  estado_cita: EstadoCita;
  bot_mode: BotMode;
  updated_at: string;
  created_at: string;
}

export interface Message {
  id: number;
  lead_id: number | null;
  telefono: string;
  direccion: "entrante" | "saliente";
  contenido: string;
  es_manual: boolean;
  timestamp: string;
}

const ACTIVE_ESTADOS: EstadoCita[] = ["pendiente", "en_conversacion", "confirmado", "completado"];

export async function getConversations(): Promise<Conversation[]> {
  try {
    const res = await fetch(`${API}/api/leads?limit=60`, { headers: apiHeaders() });
    if (!res.ok) return [];
    const data: Conversation[] = await res.json();
    return data
      .filter((l) => ACTIVE_ESTADOS.includes(l.estado_cita))
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  } catch {
    return [];
  }
}

export async function getMessages(telefono: string, limit = 100): Promise<Message[]> {
  try {
    const res = await fetch(
      `${API}/api/messages/${encodeURIComponent(telefono)}?limit=${limit}`,
      { headers: apiHeaders() }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function getBotActivo(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/config`, { headers: apiHeaders() });
    if (!res.ok) return true;
    const config = await res.json();
    return config.bot_activo !== false;
  } catch {
    return true;
  }
}

export async function toggleGlobalBot(active: boolean): Promise<void> {
  await fetch(`${API}/api/config/bot_activo`, {
    method: "PUT",
    headers: apiHeaders(),
    body: JSON.stringify({ valor: active }),
  });
}

export async function toggleLeadBotMode(leadId: number, mode: BotMode): Promise<void> {
  await fetch(`${API}/api/leads/${leadId}/bot-mode`, {
    method: "PUT",
    headers: apiHeaders(),
    body: JSON.stringify({ mode }),
  });
}

export async function sendManualMessage(telefono: string, mensaje: string): Promise<void> {
  const res = await fetch(`${API}/api/send`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ telefono, mensaje }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Error enviando mensaje");
  }
}

// ─── Helpers de formato ───────────────────────────────────────────────────────

export function getInitials(nombre: string | null, telefono: string): string {
  if (!nombre?.trim()) return telefono.slice(-2);
  return nombre
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Ayer";
  return date.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}

export function getDateLabel(ts: string): string {
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Hoy";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Ayer";
  return date.toLocaleDateString("es-ES", { day: "numeric", month: "long" });
}

export function formatMessageTime(ts: string): string {
  return new Date(ts).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}
