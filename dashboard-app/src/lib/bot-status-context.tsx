"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useOrg } from "./org-context";
import { fetchGlobalBotActive } from "./whatsapp";

/**
 * Estado del bot de TODA la organización (`config.bot_activo`), en un único sitio.
 *
 * Existe porque la píldora de la barra lateral decía "Activo" en texto fijo mientras la
 * tarjeta de Configuración decía "Pausado para TODAS las clientas": dos pantallas, dos
 * verdades, y la que se ve siempre era la falsa.
 *
 * Dos reglas:
 *  1. "Aún no lo sé" (`loading`) y "no he podido leerlo" (`unknown`) son estados propios.
 *     Nunca se colapsan a "activo": afirmar que el bot responde sin haberlo comprobado es
 *     el fallo que se está arreglando.
 *  2. Quien cambie el estado (el toggle de Configuración) llama a `setBotActive` DESPUÉS
 *     de que la escritura haya respondido OK, y todas las pantallas se enteran sin recargar.
 *
 * No hay pausa por clienta aquí: eso es `contacts.bot_mode`, otro campo y otro alcance
 * (una sola conversación). Ver `toggleLeadBotMode`.
 */
export type BotStatus = "loading" | "active" | "paused" | "unknown";

interface BotStatusValue {
  status: BotStatus;
  /** Refleja un cambio ya confirmado por la API. No escribe nada por su cuenta. */
  setBotActive: (active: boolean) => void;
  refresh: () => Promise<void>;
}

const BotStatusContext = createContext<BotStatusValue>({
  status: "loading",
  setBotActive: () => {},
  refresh: async () => {},
});

export function useBotStatus() {
  return useContext(BotStatusContext);
}

// El bot puede pausarse desde otra pestaña, otro usuario o Telegram. Mismo intervalo que
// tenía el Monitor de WhatsApp antes de compartir este estado.
const POLL_MS = 30_000;

export function BotStatusProvider({ children }: { children: ReactNode }) {
  const { orgId, loading: orgLoading } = useOrg();
  // Guardamos la lectura JUNTO A la org de la que salió. Así, mientras la org cambia (o
  // todavía no se conoce), el estado se deriva en render como "loading" en vez de arrastrar
  // el valor de la organización anterior.
  const [read, setRead] = useState<{ orgId: string; active: boolean | null } | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    const active = await fetchGlobalBotActive(orgId);
    if (!mountedRef.current) return;
    setRead({ orgId, active });
  }, [orgId]);

  useEffect(() => {
    if (orgLoading || !orgId) return;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [orgId, orgLoading, refresh]);

  const setBotActive = useCallback(
    (active: boolean) => {
      if (orgId) setRead({ orgId, active });
    },
    [orgId]
  );

  const status: BotStatus = orgLoading
    ? "loading" // ni siquiera sabemos qué organización es
    : !orgId
      ? "unknown" // sesión sin organización: no hay nada que podamos afirmar
      : read?.orgId !== orgId
        ? "loading" // la lectura es de otra org (o aún no hay ninguna)
        : read.active === null
          ? "unknown" // se intentó leer y falló
          : read.active
            ? "active"
            : "paused";

  return (
    <BotStatusContext value={{ status, setBotActive, refresh }}>
      {children}
    </BotStatusContext>
  );
}
