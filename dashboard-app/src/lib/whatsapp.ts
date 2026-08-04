import { API, apiHeaders, apiMutate } from "./api";

export type BotMode = "auto" | "manual";
export type EstadoCita = "pendiente" | "en_conversacion" | "pendiente_bizum" | "confirmado" | "completado" | "cancelado" | "abandonado";

/**
 * Traza del retorno automático a 'auto' (opción C). La escribe el barrido del servidor en
 * `contacts.metadata.auto_return`. Sin ella, en el panel una conversación devuelta por el
 * sistema y otra devuelta a mano son idénticas.
 */
export interface AutoReturn {
  at: string;
  dias_silencio: number;
  ultima_actividad_at: string | null;
}

export interface Conversation {
  id: number;
  nombre: string | null;
  telefono: string;
  personas: number | null;
  ocasion: string | null;
  estado_cita: EstadoCita;
  bot_mode: BotMode;
  is_vip?: boolean;
  is_blacklisted?: boolean;
  escalation_reason?: string | null;
  auto_return?: AutoReturn | null;
  updated_at: string;
  created_at: string;
}

/**
 * Fecha corta para la traza ("5 ago"). Devuelve null si no es legible: una traza sin fecha
 * fiable no se pinta, porque "el bot volvió solo" sin cuándo no se puede contrastar con nada.
 */
export function formatTraceDate(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
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

// `abandonado` entra a propósito: es un estado que pone el bot solo (la clienta dejó de
// contestar), no una conversación cerrada por nadie. Sin él, el Monitor no las listaba y por
// tanto no se podían abrir ni retomar a mano — justo las que más falta hace repescar. Y si
// el estado se puso mal, sin poder abrir el chat no había forma de verlo desde el panel.
const ACTIVE_ESTADOS: EstadoCita[] = ["pendiente", "en_conversacion", "pendiente_bizum", "confirmado", "completado", "cancelado", "abandonado"];

/** Cuántas conversaciones se piden de golpe, y cuántas añade cada "Cargar más". */
export const CONVERSATIONS_PAGE_SIZE = 60;

export interface ConversationPage {
  items: Conversation[];
  /** El servidor llenó la ventana entera: es muy probable que haya más detrás. */
  hayMas: boolean;
}

/**
 * Devuelve las `limit` conversaciones más recientes (el servidor ordena por updated_at
 * desc). La paginación es por VENTANA, no por páginas sueltas: "Cargar más" vuelve a pedir
 * desde el principio con un límite mayor. Así el refresco en tiempo real —que dispara con
 * cada mensaje que entra— no tiene que recomponer trozos ni puede duplicar o perder filas
 * cuando el orden cambia entre una petición y la siguiente.
 *
 * `hayMas` se calcula sobre lo que devuelve el servidor, ANTES de descartar los estados no
 * activos: si se mirara la lista ya filtrada, una ventana llena de descartes se leería como
 * "no hay nada más" y el botón desaparecería con conversaciones todavía sin traer.
 */
export async function getConversations(
  orgId: string,
  limit: number = CONVERSATIONS_PAGE_SIZE
): Promise<ConversationPage> {
  try {
    const res = await fetch(`${API}/api/leads?limit=${limit}&hasConversation=true`, {
      headers: await apiHeaders(orgId),
    });
    if (!res.ok) return { items: [], hayMas: false };
    const data: Conversation[] = await res.json();
    const items = data
      .filter((l) => ACTIVE_ESTADOS.includes(l.estado_cita))
      .sort((a, b) => {
        const aEsc = a.bot_mode === "manual" && !!a.escalation_reason ? 1 : 0;
        const bEsc = b.bot_mode === "manual" && !!b.escalation_reason ? 1 : 0;
        if (aEsc !== bEsc) return bEsc - aEsc;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });
    return { items, hayMas: data.length >= limit };
  } catch {
    return { items: [], hayMas: false };
  }
}

export async function getMessages(orgId: string, telefono: string, limit = 100): Promise<Message[]> {
  try {
    const res = await fetch(
      `${API}/api/messages/${encodeURIComponent(telefono)}?limit=${limit}`,
      { headers: await apiHeaders(orgId) }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/**
 * Estado del bot de TODA la organización (`config.bot_activo`).
 *
 * Devuelve `null` — no `true` — cuando no se ha podido leer (API caída, 401, red).
 * Antes devolvía `true` en el catch: un fallo de red se veía exactamente igual que un bot
 * respondiendo, y la UI afirmaba "Activo" sin haber comprobado nada. Quien consuma esto
 * debe distinguir los tres casos; el valor por defecto NUNCA puede ser "activo".
 */
export async function fetchGlobalBotActive(orgId: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${API}/api/config`, { headers: await apiHeaders(orgId) });
    if (!res.ok) return null;
    const config = await res.json();
    return config.bot_activo !== false;
  } catch {
    return null;
  }
}

// No hay helper para apagar el bot de la organización: se hace desde Configuración, que
// escribe `bot_activo` con putConfig. Tener aquí un `toggleGlobalBot` importable desde el
// Monitor de WhatsApp es lo que permitió apagar Sante entera creyendo que se pausaba una
// conversación (01/08). Para una sola conversación, toggleLeadBotMode.

/**
 * Cambia el modo de UNA conversación. Lanza si el servidor no confirma la escritura: sin
 * eso, un 500 o un 401 dejaban la lista pintando "auto" con la conversación todavía en
 * manual — es decir, el bot mudo y nadie mirando ese chat.
 */
export async function toggleLeadBotMode(orgId: string, leadId: number, mode: BotMode): Promise<void> {
  await apiMutate(`/api/leads/${leadId}/bot-mode`, { method: "PUT", body: { mode }, orgId });
}

/**
 * Envía un mensaje escrito a mano. Por defecto el backend pausa el bot en ESA conversación
 * (bot_mode='manual'): si una persona está atendiendo, el bot no debe hablar encima.
 * Reactivarlo es explícito, con el botón del propio chat.
 *
 * `pausarBot: false` es solo para el mensaje de reactivación tras quitar de lista negra,
 * que acaba de poner el modo en 'auto' y no debe deshacerlo.
 *
 * Devuelve si el bot quedó pausado, para que la UI no diga una cosa y la BD otra.
 */
export async function sendManualMessage(
  orgId: string,
  telefono: string,
  mensaje: string,
  opts: { pausarBot?: boolean } = {}
): Promise<{ botPausado: boolean }> {
  const res = await fetch(`${API}/api/send`, {
    method: "POST",
    headers: await apiHeaders(orgId),
    body: JSON.stringify({ telefono, mensaje, pausarBot: opts.pausarBot ?? true }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Error enviando mensaje");
  }
  const body = (await res.json().catch(() => ({}))) as { botPausado?: boolean };
  return { botPausado: body.botPausado === true };
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
