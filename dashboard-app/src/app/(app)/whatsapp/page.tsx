"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/utils/supabase/client";
import { toast } from "sonner";
import { useOrg } from "@/lib/org-context";
import Link from "next/link";
import { ConversationList } from "@/components/whatsapp/ConversationList";
import { ChatView } from "@/components/whatsapp/ChatView";
import {
  getConversations,
  getMessages,
  toggleLeadBotMode,
  sendManualMessage,
  CONVERSATIONS_PAGE_SIZE,
} from "@/lib/whatsapp";
import { useBotStatus } from "@/lib/bot-status-context";
import type { Conversation, ConversationPage, Message } from "@/lib/whatsapp";
import { API, apiHeaders } from "@/lib/api";

export default function WhatsAppPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // Tamaño de la ventana que se pide al servidor. Crece de golpes de CONVERSATIONS_PAGE_SIZE
  // con "Cargar más"; el refresco en tiempo real siempre pide la ventana actual entera, así
  // que lo ya cargado no se encoge cuando entra un mensaje.
  //
  // Va emparejado con la org a la que pertenece y se DERIVA, en vez de resetearse en un
  // efecto: al cambiar de organización vuelve solo al tamaño inicial, sin un render extra
  // en el que se pediría la ventana grande de la org anterior.
  const [limitState, setLimitState] = useState({ org: "", limit: CONVERSATIONS_PAGE_SIZE });
  const [hayMas, setHayMas] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sendingMessage, setSendingMessage] = useState(false);
  // Solo de LECTURA en esta pantalla. El interruptor que apaga el bot de TODA la
  // organización vive únicamente en Configuración: tenerlo aquí, junto al de "modo manual"
  // de cada conversación, hizo que el 01/08 se apagara Sante entera 4 h creyendo que se
  // pausaba una sola clienta (los dos controles se llamaban parecido y estaban a 30 cm).
  // El estado (y su refresco periódico) sale de BotStatusProvider, el mismo que pinta la
  // píldora de la barra lateral: antes esta pantalla lo mantenía por su cuenta arrancando
  // en `true`, así que el aviso rojo tardaba en aparecer aunque el bot ya estuviera parado.
  const { status: botStatus } = useBotStatus();
  const botPausado = botStatus === "paused";

  const { orgId, orgName } = useOrg();
  const limit = limitState.org === orgId ? limitState.limit : CONVERSATIONS_PAGE_SIZE;
  const selectedConv = conversations.find((c) => c.id === selectedId) ?? null;
  // Bug 9: memoizamos el cliente. Antes se llamaba createClient() en CADA render, creando
  // una instancia nueva de Supabase (y un socket realtime nuevo) cada vez → los canales
  // realtime quedaban huérfanos y los mensajes no llegaban sin recargar la página.
  const [supabase] = useState(() => createClient());
  const mountedRef = useRef(true);
  const sendingRef = useRef(false);
  const pendingConvRefresh = useRef(false);
  // Reseteamos a true en CADA montaje. Con solo el cleanup, React StrictMode (dev) deja
  // mountedRef.current=false tras su desmontaje/remontaje simulado, y entonces los guards
  // `mountedRef.current && setMessages(...)` no se ejecutaban nunca → no aparecían mensajes.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const applyPage = useCallback((page: ConversationPage) => {
    setConversations(page.items);
    setHayMas(page.hayMas);
    setLoadingMore(false);
  }, []);

  // Carga inicial y recarga al crecer la ventana — solo datos reales de la org activa
  useEffect(() => {
    if (!orgId) return;
    getConversations(orgId, limit).then(applyPage);
  }, [orgId, limit, applyPage]);

  // Cargar mensajes al seleccionar conversación
  useEffect(() => {
    if (!selectedConv || !orgId) {
      setMessages([]);
      return;
    }
    getMessages(orgId, selectedConv.telefono).then((m) => {
      if (mountedRef.current) setMessages(m);
    });
  }, [orgId, selectedConv?.id, selectedConv?.telefono]);

  const refreshConversations = useCallback(() => {
    if (!orgId) return;
    if (sendingRef.current) {
      pendingConvRefresh.current = true;
      return;
    }
    getConversations(orgId, limit).then(applyPage);
  }, [orgId, limit, applyPage]);

  const handleLoadMore = useCallback(() => {
    setLoadingMore(true);
    setLimitState({ org: orgId, limit: limit + CONVERSATIONS_PAGE_SIZE });
  }, [orgId, limit]);

  // Realtime: refrescar lista de conversaciones cuando cambian contacts, conversations o llegan mensajes nuevos
  useEffect(() => {
    if (!orgId) return;
    const channel = supabase
      .channel("leads-monitor")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "contacts", filter: `organization_id=eq.${orgId}` },
        () => { refreshConversations(); }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations", filter: `organization_id=eq.${orgId}` },
        () => { refreshConversations(); }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        () => { refreshConversations(); }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, refreshConversations]);

  // Realtime: mensajes del chat activo. Filtramos por organization_id (siempre presente y
  // estable) en vez de por conversation_id (que requería una resolución async frágil y dejaba
  // la suscripción sin filtro mientras se resolvía). Al llegar un mensaje nuevo de la org,
  // recargamos los del chat abierto.
  useEffect(() => {
    if (!selectedConv || !orgId) return;
    const phone = selectedConv.telefono;
    const channel = supabase
      .channel(`messages-${orgId}-${selectedConv.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `organization_id=eq.${orgId}`,
        },
        () => {
          getMessages(orgId, phone).then((m) => {
            if (mountedRef.current) setMessages(m);
          });
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, selectedConv?.id, selectedConv?.telefono]);

  const handleConvBotModeToggle = useCallback(
    async (leadId: number, mode: "auto" | "manual") => {
      try {
        await toggleLeadBotMode(orgId, leadId, mode);
        if (!mountedRef.current) return;
        setConversations((prev) =>
          prev.map((c) =>
            c.id === leadId
              ? { ...c, bot_mode: mode, ...(mode === "auto" ? { escalation_reason: null } : {}) }
              : c
          )
        );
        toast(
          mode === "manual"
            ? "Control manual activado para esta conversación"
            : "Bot reactivado en esta conversación"
        );
      } catch {
        if (!mountedRef.current) return;
        toast.error("Error al cambiar el modo de la conversación");
      }
    },
    [orgId]
  );

  // Devolver al bot desde la LISTA, sin abrir el chat. Reutiliza el mismo camino que el
  // botón del chat (misma escritura, mismo reflejo en la lista) y deja que el error suba
  // para que la fila no se quede diciendo "Devolviendo…" cuando no se ha devuelto nada.
  const handleReturnToBot = useCallback(
    async (conv: Conversation) => {
      await handleConvBotModeToggle(conv.id, "auto");
    },
    [handleConvBotModeToggle]
  );

  const handleSendMessage = useCallback(
    async (telefono: string, mensaje: string) => {
      sendingRef.current = true;
      setSendingMessage(true);
      try {
        const { botPausado } = await sendManualMessage(orgId, telefono, mensaje);
        if (!mountedRef.current) return;
        // El backend acaba de poner bot_mode='manual' en esta conversación. Lo reflejamos
        // aquí para que el interruptor del chat no siga diciendo "auto": si la UI y la BD
        // no coinciden, quien atiende cree que el bot está activo cuando no lo está.
        if (botPausado) {
          setConversations((prev) =>
            prev.map((c) => (c.telefono === telefono ? { ...c, bot_mode: "manual" } : c))
          );
          toast("Bot pausado en esta conversación — reactívalo cuando termines");
        }
      } catch (e) {
        if (!mountedRef.current) return;
        toast.error((e as Error).message || "Error enviando mensaje");
      } finally {
        sendingRef.current = false;
        if (mountedRef.current) {
          setSendingMessage(false);
          if (pendingConvRefresh.current) {
            pendingConvRefresh.current = false;
            getConversations(orgId, limit).then(applyPage);
          }
        }
      }
    },
    [orgId, limit, applyPage]
  );

  const handleRemoveBlacklist = useCallback(
    async (leadId: number, telefono: string) => {
      try {
        await fetch(`${API}/api/lista-negra/${leadId}`, {
          method: "DELETE",
          headers: await apiHeaders(orgId),
        });
        await toggleLeadBotMode(orgId, leadId, "auto");
        // pausarBot:false — este saludo REACTIVA al cliente; si pausara, desharía el
        // 'auto' que acabamos de poner y el bot se quedaría mudo con la UI diciendo auto.
        await sendManualMessage(
          orgId,
          telefono,
          "Hola 😊 Hemos revisado tu caso. ¿En qué puedo ayudarte?",
          { pausarBot: false }
        );
        setConversations((prev) =>
          prev.map((c) =>
            c.id === leadId
              ? { ...c, is_blacklisted: false, bot_mode: "auto", escalation_reason: null }
              : c
          )
        );
        toast("Cliente reactivado");
      } catch {
        toast.error("Error al reactivar el cliente");
      }
    },
    [orgId]
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
            Conversaciones en tiempo real · {orgName || "Cargando…"}
          </p>
        </div>
      </header>

      {/* Aviso persistente: mientras la org esté pausada el bot DESCARTA todo lo que entra,
          de todas las clientas. El 01/08 estuvo así 4 h sin que nadie lo notara. */}
      {botPausado && (
        <div
          role="alert"
          className="shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1 px-6 py-2.5 border-b border-destructive/30 bg-destructive/10 text-[13px] text-destructive"
        >
          <span className="font-semibold">
            Bot pausado para TODAS las clientas de {orgName || "esta organización"}.
          </span>
          <span className="text-destructive/85">
            Los mensajes que lleguen no se responden ni se contestan después.
          </span>
          <Link
            href="/configuracion"
            className="font-semibold underline underline-offset-2 hover:no-underline"
          >
            Reactivar en Configuración
          </Link>
        </div>
      )}

      {/* Main content: two-column WhatsApp layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: conversation list — 320px fixed */}
        <div className="w-80 shrink-0 flex flex-col overflow-hidden">
          <ConversationList
            conversations={conversations}
            selectedId={selectedId}
            onSelect={(conv) => setSelectedId(conv.id)}
            onReturnToBot={handleReturnToBot}
            hayMas={hayMas}
            loadingMore={loadingMore}
            onLoadMore={handleLoadMore}
          />
        </div>

        {/* Right: chat view */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <ChatView
            conversation={selectedConv}
            messages={messages}
            onBotModeToggle={handleConvBotModeToggle}
            onSendMessage={handleSendMessage}
            onRemoveBlacklist={handleRemoveBlacklist}
            sendingMessage={sendingMessage}
            globalBotPaused={botPausado}
          />
        </div>
      </div>

    </div>
  );
}
