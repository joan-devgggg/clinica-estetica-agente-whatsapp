"use client";

import type { Message } from "@/lib/whatsapp";
import { formatMessageTime } from "@/lib/whatsapp";
import { cn } from "@/lib/utils";

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isEntrante = message.direccion === "entrante";

  return (
    <div
      className={cn(
        "flex w-full",
        isEntrante ? "justify-start" : "justify-end"
      )}
    >
      <div
        className={cn(
          "relative max-w-[72%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-[1.45] shadow-sm",
          isEntrante
            ? "rounded-tl-sm bg-muted text-foreground border border-border/40"
            : "rounded-tr-sm bg-secondary text-foreground border border-border/30"
        )}
      >
        {/* Indicador de mensaje manual */}
        {!isEntrante && message.es_manual && (
          <span
            className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full border-2 border-card"
            style={{ backgroundColor: "var(--primary)" }}
            title="Enviado manualmente"
          />
        )}

        <p className="whitespace-pre-wrap break-words">{message.contenido}</p>

        <p
          className={cn(
            "mt-1 text-[10.5px] leading-none",
            isEntrante ? "text-muted-foreground" : "text-muted-foreground/80 text-right"
          )}
        >
          {formatMessageTime(message.timestamp)}
          {!isEntrante && message.es_manual && (
            <span className="ml-1 opacity-70">· manual</span>
          )}
        </p>
      </div>
    </div>
  );
}
