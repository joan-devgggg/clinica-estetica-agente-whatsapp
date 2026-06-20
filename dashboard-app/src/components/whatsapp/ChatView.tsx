"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MessageCircle, Bot, UserCheck, Send } from "lucide-react";
import { MessageBubble } from "./MessageBubble";
import type { Conversation, Message } from "@/lib/whatsapp";
import { getInitials, getDateLabel } from "@/lib/whatsapp";
import { cn } from "@/lib/utils";

interface ChatViewProps {
  conversation: Conversation | null;
  messages: Message[];
  onBotModeToggle: (leadId: number, mode: "auto" | "manual") => Promise<void>;
  onSendMessage: (telefono: string, mensaje: string) => Promise<void>;
  sendingMessage?: boolean;
}

export function ChatView({
  conversation,
  messages,
  onBotModeToggle,
  onSendMessage,
  sendingMessage,
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
  const initials = getInitials(conversation.nombre, conversation.telefono);

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
                Devolver al bot
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
        {isManual ? (
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escribe un mensaje manual..."
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
