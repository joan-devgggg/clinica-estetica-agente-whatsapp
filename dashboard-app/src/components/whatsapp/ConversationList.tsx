"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, UserCheck, AlertTriangle, Bot } from "lucide-react";
import type { Conversation } from "@/lib/whatsapp";
import { getInitials, formatTimestamp } from "@/lib/whatsapp";
import { cn } from "@/lib/utils";

export type ModeFilter = "todas" | "manual" | "auto";

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: number | null;
  onSelect: (conv: Conversation) => void;
  /**
   * Devuelve una conversación al bot SIN abrir el chat. Quien atiende suele tener 5 o 6
   * conversaciones en manual y solo quiere soltarlas: abrir cada chat para pulsar el mismo
   * botón es lo que hacía que se quedaran en manual días enteros (y el bot mudo con ellas).
   */
  onReturnToBot?: (conv: Conversation) => Promise<void>;
  /** Hay más conversaciones detrás de la ventana cargada. */
  hayMas?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

const ESTADO_LABELS: Record<string, string> = {
  pendiente: "Pendiente",
  en_conversacion: "En chat",
  pendiente_bizum: "Bizum pendiente",
  confirmado: "Reserva confirmada",
  completado: "Completada",
  cancelado: "Cancelada",
  abandonado: "Abandonada",
};

const MODE_FILTERS: Array<{ key: ModeFilter; label: string }> = [
  { key: "todas", label: "Todas" },
  { key: "manual", label: "Manual" },
  { key: "auto", label: "Bot" },
];

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onReturnToBot,
  hayMas,
  loadingMore,
  onLoadMore,
}: ConversationListProps) {
  const [search, setSearch] = useState("");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("todas");
  // Id en vuelo: evita el doble clic y da señal de que algo está pasando.
  const [returning, setReturning] = useState<number | null>(null);

  // Los contadores se calculan sobre TODA la lista, no sobre la búsqueda: son la razón por
  // la que alguien pulsa el filtro, así que tienen que seguir visibles con el buscador puesto.
  const manualCount = conversations.filter((c) => c.bot_mode === "manual").length;
  const counts: Record<ModeFilter, number> = {
    todas: conversations.length,
    manual: manualCount,
    auto: conversations.length - manualCount,
  };

  const filtered = conversations.filter((c) => {
    if (modeFilter === "manual" && c.bot_mode !== "manual") return false;
    if (modeFilter === "auto" && c.bot_mode === "manual") return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      c.nombre?.toLowerCase().includes(q) ||
      c.telefono.includes(q) ||
      c.ocasion?.toLowerCase().includes(q)
    );
  });

  const handleReturn = async (conv: Conversation) => {
    if (!onReturnToBot || returning !== null) return;
    setReturning(conv.id);
    try {
      await onReturnToBot(conv);
    } finally {
      setReturning((prev) => (prev === conv.id ? null : prev));
    }
  };

  return (
    <div className="flex flex-col h-full bg-muted/60 border-r border-border/60">
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-3 border-b border-border/40">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 mb-2.5">
          Conversaciones
        </p>
        <div className="relative">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60"
            strokeWidth={1.75}
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar conversación..."
            className="h-8 pl-8 text-[12.5px] bg-card border-border/50 placeholder:text-muted-foreground/50"
          />
        </div>

        {/* Filtro por modo. "Manual" es el que importa: son las conversaciones en las que el
            bot NO va a contestar, y hasta ahora había que ir abriéndolas una a una para saberlo. */}
        <div className="mt-2.5 flex items-center gap-1" role="group" aria-label="Filtrar por modo">
          {MODE_FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setModeFilter(key)}
              aria-pressed={modeFilter === key}
              className={cn(
                "flex-1 h-6 rounded-md text-[11px] font-medium transition-colors border",
                modeFilter === key
                  ? "bg-card text-foreground border-border/70 shadow-xs"
                  : "bg-transparent text-muted-foreground border-transparent hover:bg-card/60"
              )}
            >
              {label} · {counts[key]}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div
            className={cn(
              "flex flex-col items-center justify-center gap-2 text-muted-foreground/60 px-4 text-center",
              hayMas ? "py-10" : "h-full"
            )}
          >
            <Search size={24} strokeWidth={1.25} />
            <p className="text-[12px]">
              {modeFilter === "manual" && !search.trim()
                ? "Ninguna conversación en manual"
                : modeFilter === "auto" && !search.trim()
                  ? "Ninguna conversación la lleva el bot"
                  : "Sin resultados"}
            </p>
            {hayMas && (
              <p className="text-[11px] text-muted-foreground/70">
                Solo se han cargado las más recientes.
              </p>
            )}
          </div>
        )}

        {filtered.map((conv) => {
          const isActive = conv.id === selectedId;
          const isManual = conv.bot_mode === "manual";
          const isEscalated = isManual && !!conv.escalation_reason;
          const initials = getInitials(conv.nombre, conv.telefono);
          const canReturn = isManual && !!onReturnToBot;

          return (
            <div
              key={conv.id}
              className={cn(
                "relative transition-all duration-150 border-b border-border/30",
                isEscalated && !isActive && "bg-[oklch(0.97_0.02_25)] border-l-[3px] border-l-[oklch(0.45_0.15_25)]",
                isEscalated && isActive && "bg-[oklch(0.95_0.03_25)] border-l-[3px] border-l-[oklch(0.45_0.15_25)]",
                !isEscalated && isActive && "bg-secondary/80 border-l-[3px] border-l-primary",
                !isActive && "hover:bg-card/70"
              )}
            >
              <button
                onClick={() => onSelect(conv)}
                className={cn(
                  "w-full text-left py-3.5 pr-4 flex items-start gap-3",
                  isActive || isEscalated ? "pl-[13px]" : "pl-4"
                )}
              >
                {/* Avatar */}
                <div
                  className={cn(
                    "shrink-0 h-9 w-9 rounded-full flex items-center justify-center text-[12px] font-semibold",
                    isEscalated
                      ? "bg-destructive/15 text-destructive"
                      : isActive
                        ? "bg-primary/15 text-primary"
                        : "bg-muted-foreground/12 text-muted-foreground"
                  )}
                >
                  {initials}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1 mb-0.5">
                    <span className="text-[13px] font-medium text-foreground truncate leading-none">
                      {conv.nombre || conv.telefono}
                    </span>
                    <span className="shrink-0 text-[10.5px] text-muted-foreground leading-none">
                      {formatTimestamp(conv.updated_at)}
                    </span>
                  </div>

                  <p className="text-[12px] text-muted-foreground truncate leading-snug">
                    {conv.personas ? `${conv.personas} persona${conv.personas === 1 ? "" : "s"}` : "Sin reserva"}
                    {conv.ocasion ? ` · ${conv.ocasion}` : ""}
                  </p>

                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    <Badge
                      variant="secondary"
                      className="text-[10px] px-1.5 py-0 h-4 font-medium border-0 bg-muted text-muted-foreground"
                    >
                      {ESTADO_LABELS[conv.estado_cita] ?? conv.estado_cita}
                    </Badge>
                    {/* La marca de "manual" se pinta SIEMPRE que el modo sea manual, escalada
                        incluida. Antes la escalada la sustituía, así que la información que
                        de verdad hacía falta —el bot no contesta aquí— desaparecía justo en
                        las conversaciones más delicadas. */}
                    {isManual && (
                      <span className="flex items-center gap-0.5 text-[10px] font-medium text-primary">
                        <UserCheck size={10} strokeWidth={2} />
                        manual
                      </span>
                    )}
                    {isEscalated && (
                      <Badge
                        variant="destructive"
                        className="text-[10px] px-1.5 py-0 h-4 font-medium gap-0.5"
                      >
                        <AlertTriangle size={9} strokeWidth={2.5} />
                        Requiere atención
                      </Badge>
                    )}
                  </div>

                  {/* Hueco reservado al botón de devolver, que va por encima (no puede ir
                      dentro de este <button>: un botón dentro de otro no es HTML válido). */}
                  {canReturn && <div className="h-7" />}
                </div>
              </button>

              {canReturn && (
                <button
                  type="button"
                  onClick={() => handleReturn(conv)}
                  disabled={returning === conv.id}
                  title={
                    isEscalated
                      ? "Marca la escalada como resuelta y devuelve la conversación al bot"
                      : "Devuelve la conversación al bot"
                  }
                  className={cn(
                    "absolute right-4 bottom-3 h-7 px-2 rounded-md border border-border/60 bg-card",
                    "text-[11px] font-medium text-foreground flex items-center gap-1.5",
                    "hover:bg-secondary disabled:opacity-50 disabled:pointer-events-none"
                  )}
                >
                  <Bot size={11} strokeWidth={1.75} />
                  {returning === conv.id
                    ? "Devolviendo…"
                    : isEscalated
                      ? "Resolver y devolver"
                      : "Devolver al bot"}
                </button>
              )}
            </div>
          );
        })}

        {/* La lista solo trae una ventana de las más recientes. Sin este botón, las
            conversaciones que se salían del tope de 60 sencillamente no existían para el
            panel: ni buscándolas por nombre aparecían, porque el buscador filtra lo ya
            cargado, no la base de datos. */}
        {hayMas && onLoadMore && (
          <div className="p-3">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
              className={cn(
                "w-full h-8 rounded-md border border-border/60 bg-card text-[12px] font-medium",
                "text-foreground hover:bg-secondary disabled:opacity-60 disabled:pointer-events-none"
              )}
            >
              {loadingMore ? "Cargando…" : "Cargar conversaciones anteriores"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
