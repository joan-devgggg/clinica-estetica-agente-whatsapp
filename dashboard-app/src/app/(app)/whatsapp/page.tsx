"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { toast } from "sonner";
import { ConversationList } from "@/components/whatsapp/ConversationList";
import { ChatView } from "@/components/whatsapp/ChatView";
import { BotToggle } from "@/components/whatsapp/BotToggle";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  getConversations,
  getMessages,
  getBotActivo,
  toggleGlobalBot,
  toggleLeadBotMode,
  sendManualMessage,
} from "@/lib/whatsapp";
import type { Conversation, Message } from "@/lib/whatsapp";
import { MOCK_CONVERSATIONS, MOCK_MESSAGES_BY_PHONE } from "@/lib/mock-data";

export default function WhatsAppPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [botActivo, setBotActivo] = useState(true);
  const [loadingBot, setLoadingBot] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    nextValue: boolean;
  }>({ open: false, nextValue: true });

  const selectedConv = conversations.find((c) => c.id === selectedId) ?? null;
  const supabase = createClient();

  // Carga inicial — usa mock si Supabase no devuelve datos
  useEffect(() => {
    Promise.all([getConversations(), getBotActivo()]).then(([convs, active]) => {
      setConversations(convs.length > 0 ? convs : MOCK_CONVERSATIONS);
      setBotActivo(active);
    });
  }, []);

  // Cargar mensajes al seleccionar conversación — usa mock si existe
  useEffect(() => {
    if (!selectedConv) {
      setMessages([]);
      return;
    }
    const mockMsgs = MOCK_MESSAGES_BY_PHONE[selectedConv.telefono];
    if (mockMsgs) {
      setMessages(mockMsgs);
    } else {
      getMessages(selectedConv.telefono).then(setMessages);
    }
  }, [selectedConv?.telefono]);

  // Realtime: conversaciones
  useEffect(() => {
    const channel = supabase
      .channel("leads-monitor")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "contacts" },
        () => {
          getConversations().then(setConversations);
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Realtime: mensajes del chat activo — refetch completo al recibir INSERT
  // (no usamos payload.new porque requeriría política anon de lectura en messages)
  useEffect(() => {
    if (!selectedConv) return;
    const phone = selectedConv.telefono;
    const channel = supabase
      .channel(`messages-${phone}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `telefono=eq.${phone}`,
        },
        () => {
          getMessages(phone).then(setMessages);
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConv?.telefono]);

  const handleBotToggleRequest = (next: boolean) => {
    setConfirmDialog({ open: true, nextValue: next });
  };

  const handleBotToggleConfirm = async () => {
    const next = confirmDialog.nextValue;
    setConfirmDialog((prev) => ({ ...prev, open: false }));
    setLoadingBot(true);
    try {
      await toggleGlobalBot(next);
      setBotActivo(next);
      toast(
        next
          ? "Bot reactivado correctamente"
          : "Bot desactivado — modo manual activado"
      );
    } catch {
      toast.error("Error al cambiar el estado del bot");
    } finally {
      setLoadingBot(false);
    }
  };

  const handleConvBotModeToggle = useCallback(
    async (leadId: number, mode: "auto" | "manual") => {
      try {
        await toggleLeadBotMode(leadId, mode);
        setConversations((prev) =>
          prev.map((c) => (c.id === leadId ? { ...c, bot_mode: mode } : c))
        );
        toast(
          mode === "manual"
            ? "Control manual activado para esta conversación"
            : "Bot reactivado en esta conversación"
        );
      } catch {
        toast.error("Error al cambiar el modo de la conversación");
      }
    },
    []
  );

  const handleSendMessage = useCallback(
    async (telefono: string, mensaje: string) => {
      setSendingMessage(true);
      try {
        await sendManualMessage(telefono, mensaje);
      } catch (e) {
        toast.error((e as Error).message || "Error enviando mensaje");
      } finally {
        setSendingMessage(false);
      }
    },
    []
  );

  return (
    <div className="flex flex-col" style={{ height: "100svh" }}>
      {/* Page header */}
      <header className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border/60 bg-card">
        <div>
          <h1 className="font-heading text-[22px] font-semibold leading-tight tracking-tight text-foreground">
            Monitor WhatsApp
          </h1>
          <p className="text-[12.5px] text-muted-foreground mt-0.5">
            Conversaciones en tiempo real · Clínica Aurora
          </p>
        </div>

        <BotToggle
          active={botActivo}
          onToggleRequest={handleBotToggleRequest}
          loading={loadingBot}
        />
      </header>

      {/* Main content: two-column WhatsApp layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: conversation list — 320px fixed */}
        <div className="w-80 shrink-0 flex flex-col overflow-hidden">
          <ConversationList
            conversations={conversations}
            selectedId={selectedId}
            onSelect={(conv) => setSelectedId(conv.id)}
          />
        </div>

        {/* Right: chat view */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <ChatView
            conversation={selectedConv}
            messages={messages}
            onBotModeToggle={handleConvBotModeToggle}
            onSendMessage={handleSendMessage}
            sendingMessage={sendingMessage}
          />
        </div>
      </div>

      {/* Confirmation dialog for global bot toggle */}
      <Dialog
        open={confirmDialog.open}
        onOpenChange={(open) =>
          setConfirmDialog((prev) => ({ ...prev, open }))
        }
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-heading text-[17px]">
              {confirmDialog.nextValue ? "¿Reactivar el bot?" : "¿Desactivar el bot?"}
            </DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed">
              {confirmDialog.nextValue
                ? "El agente de IA volverá a responder automáticamente a todos los clientes."
                : "Los clientes no recibirán respuestas automáticas hasta que lo reactives."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="ghost"
              size="sm"
              className="text-[13px]"
              onClick={() =>
                setConfirmDialog((prev) => ({ ...prev, open: false }))
              }
            >
              Cancelar
            </Button>
            <Button
              size="sm"
              className="text-[13px]"
              variant={confirmDialog.nextValue ? "default" : "destructive"}
              onClick={handleBotToggleConfirm}
            >
              {confirmDialog.nextValue ? "Reactivar bot" : "Desactivar bot"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
