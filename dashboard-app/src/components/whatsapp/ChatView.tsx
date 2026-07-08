"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MessageCircle, Bot, UserCheck, Send, AlertTriangle } from "lucide-react";
import { MessageBubble } from "./MessageBubble";
import type { Conversation, Message } from "@/lib/whatsapp";
import { getInitials, getDateLabel } from "@/lib/whatsapp";
import { cn } from "@/lib/utils";

interface ChatViewProps {
  conversation: Conversation | null;
  messages: Message[];
  onBotModeToggle: (leadId: number, mode: "auto" | "manual") => Promise<void>;
  onSendMessage: (telefono: string, mensaje: string) => Promise<void>;
  onRemoveBlacklist?: (leadId: number, telefono: string) => Promise<void>;
  sendingMessage?: boolean;
  globalBotPaused?: boolean;
}

export function ChatView({
  conversation,
  messages,
  onBotModeToggle,
  onSendMessage,
  onRemoveBlacklist,
  sendingMessage,
  globalBotPaused,
}: ChatViewProps) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll al añadir mensajes
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || !conversation) return;
    setDraft("");
    await onSendMessage(conversation.telefono, text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Empty state
  if (!conversation) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-background text-muted-foreground gap-4">
        <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center">
          <MessageCircle size={28} strokeWidth={1.25} className="text-muted-foreground/50" />
        </div>
        <div className="text-center">
          <p className="text-[14px] font-medium text-foreground/60">Selecciona una conversación</p>
          <p className="text-[12px] mt-0.5 text-muted-foreground/60">
            Elige un chat de la lista para ver los mensajes
          </p>
        </div>
      </div>
    );
  }

  const isManual = conversation.bot_mode === "manual";
  const isEscalated = isManual && !!conversation.escalation_reason;
  const showInput = isManual || !!globalBotPaused;
  const initials = getInitials(conversation.nombre, conversation.telefono);

  const ESCALATION_LABELS: Record<string, string> = {
    escalado_bot: "Escalado por el bot",
    lista_negra: "Cliente en lista negra",
    consulta_extensiones: "Consulta sobre extensiones",
    consulta_permanente: "Consulta sobre permanente",
    consulta_salida_negro: "Consulta sobre salida de negro",
    queja_cita: "Queja sobre cita anterior",
    tono_agresivo: "Tono agresivo",
    pedir_persona: "Pidió hablar con una persona",
    pregunta_sin_respuesta: "Pregunta sin respuesta",
  };

  // Agrupar mensajes por fecha para separadores
  const groupedMessages: Array<{ dateLabel: string; msgs: Message[] }> = [];
  for (const msg of messages) {
    const label = getDateLabel(msg.timestamp);
    const last = groupedMessages[groupedMessages.length - 1];
    if (last && last.dateLabel === label) {
      last.msgs.push(msg);
    } else {
      groupedMessages.push({ dateLabel: label, msgs: [msg] });
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      {/* Chat header */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-3.5 border-b border-border/60 bg-card">
        <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center text-[12px] font-semibold text-muted-foreground shrink-0">
          {initials}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-medium text-foreground leading-none truncate">
            {conversation.nombre || "Sin nombre"}
          </p>
          <p className="text-[11px] text-muted-foreground leading-none mt-0.5 truncate">
            {conversation.telefono}
            {conversation.personas && ` · ${conversation.personas} pax`}
            {conversation.ocasion && ` · ${conversation.ocasion}`}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Badge
            variant="secondary"
            className={cn(
              "text-[10.5px] font-medium px-2 py-0.5 border",
              isManual
                ? "text-primary bg-[oklch(0.97_0.01_25)] border-[oklch(0.88_0.03_25)]"
                : "text-[oklch(0.42_0.06_160)] bg-[oklch(0.96_0.02_160)] border-[oklch(0.86_0.04_160)]"
            )}
          >
            {isManual ? "Manual" : "Bot"}
          </Badge>

          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11.5px] gap-1.5 border-border/60"
            onClick={() =>
              onBotModeToggle(conversation.id, isManual ? "auto" : "manual")
            }
          >
            {isManual ? (
              <>
                <Bot size={12} strokeWidth={1.75} />
                {isEscalated ? "Resolver y devolver al bot" : "Devolver al bot"}
              </>
            ) : (
              <>
                <UserCheck size={12} strokeWidth={1.75} />
                Tomar control
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Escalation banner */}
      {isEscalated && (
        <div className="shrink-0 flex items-center gap-2 px-5 py-2 bg-[oklch(0.95_0.04_25)] border-b border-[oklch(0.85_0.06_25)]">
          <AlertTriangle size={14} strokeWidth={2} className="text-[oklch(0.45_0.15_25)] shrink-0" />
          <p className="text-[12px] text-[oklch(0.35_0.08_25)] font-medium flex-1">
            ⚠️ Requiere atención — {ESCALATION_LABELS[conversation.escalation_reason || ""] || conversation.escalation_reason}
          </p>
          {conversation.escalation_reason === "lista_negra" && onRemoveBlacklist && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[10.5px] gap-1 shrink-0 border-[oklch(0.75_0.08_145)] text-[oklch(0.35_0.10_145)] hover:bg-[oklch(0.94_0.03_145)]"
              onClick={() => onRemoveBlacklist(conversation.id, conversation.telefono)}
            >
              ✅ Quitar de lista negra
            </Button>
          )}
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-[12px] text-muted-foreground/50">
              Sin mensajes registrados aún
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          {groupedMessages.map(({ dateLabel, msgs }) => (
            <div key={dateLabel}>
              {/* Date separator */}
              <div className="flex items-center gap-3 my-3">
                <div className="flex-1 h-px bg-border/40" />
                <span className="text-[10.5px] text-muted-foreground/60 font-medium px-2">
                  {dateLabel}
                </span>
                <div className="flex-1 h-px bg-border/40" />
              </div>

              <div className="flex flex-col gap-1.5">
                {msgs.map((msg) => (
                  <MessageBubble key={msg.id} message={msg} />
                ))}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-border/60 bg-card px-4 py-3">
        {showInput ? (
          <div className="flex flex-col gap-2">
            {globalBotPaused && !isManual && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                Bot pausado globalmente — escribe aquí para responder manualmente
              </p>
            )}
            <div className="flex items-center gap-2">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  globalBotPaused && !isManual
                    ? "Bot pausado — escribe un mensaje..."
                    : "Escribe un mensaje manual..."
                }
                className="flex-1 h-9 text-[13px] bg-background border-border/50 placeholder:text-muted-foreground/50"
                disabled={sendingMessage}
              />
              <Button
                size="sm"
                className="h-9 w-9 p-0 shrink-0"
                onClick={handleSend}
                disabled={!draft.trim() || sendingMessage}
              >
                <Send size={14} strokeWidth={1.75} />
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-muted-foreground">
              El bot está gestionando esta conversación.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11.5px] gap-1.5 border-border/60 shrink-0"
              onClick={() => onBotModeToggle(conversation.id, "manual")}
            >
              <UserCheck size={11} strokeWidth={1.75} />
              Tomar control
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
