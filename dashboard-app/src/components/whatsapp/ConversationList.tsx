"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, UserCheck } from "lucide-react";
import type { Conversation } from "@/lib/whatsapp";
import { getInitials, formatTimestamp } from "@/lib/whatsapp";
import { cn } from "@/lib/utils";

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: number | null;
  onSelect: (conv: Conversation) => void;
}

const ESTADO_LABELS: Record<string, string> = {
  pendiente: "Pendiente",
  en_conversacion: "En chat",
  confirmado: "Cita confirmada",
  completado: "Completado",
};

export function ConversationList({ conversations, selectedId, onSelect }: ConversationListProps) {
  const [search, setSearch] = useState("");

  const filtered = conversations.filter((c) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      c.nombre?.toLowerCase().includes(q) ||
      c.telefono.includes(q) ||
      c.tratamiento?.toLowerCase().includes(q)
    );
  });

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
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground/60">
            <Search size={24} strokeWidth={1.25} />
            <p className="text-[12px]">Sin resultados</p>
          </div>
        )}

        {filtered.map((conv) => {
          const isActive = conv.id === selectedId;
          const initials = getInitials(conv.nombre, conv.telefono);

          return (
            <button
              key={conv.id}
              onClick={() => onSelect(conv)}
              className={cn(
                "w-full text-left px-4 py-3.5 flex items-start gap-3 transition-all duration-150",
                "border-b border-border/30 hover:bg-card/70",
                isActive && "bg-secondary/80 border-l-[3px] border-l-primary pl-[13px]"
              )}
            >
              {/* Avatar */}
              <div
                className={cn(
                  "shrink-0 h-9 w-9 rounded-full flex items-center justify-center text-[12px] font-semibold",
                  isActive
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
                  {conv.tratamiento || "Sin tratamiento"}
                </p>

                <div className="flex items-center gap-1.5 mt-1.5">
                  <Badge
                    variant="secondary"
                    className="text-[10px] px-1.5 py-0 h-4 font-medium border-0 bg-muted text-muted-foreground"
                  >
                    {ESTADO_LABELS[conv.estado_cita] ?? conv.estado_cita}
                  </Badge>
                  {conv.bot_mode === "manual" && (
                    <span className="flex items-center gap-0.5 text-[10px] font-medium text-primary">
                      <UserCheck size={10} strokeWidth={2} />
                      manual
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
