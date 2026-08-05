"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Sparkles, Send, Megaphone, Users, Info, Layers, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { API, apiHeaders } from "@/lib/api";
import { useOrg } from "@/lib/org-context";

type Audience = "todos" | "no_vip" | "nunca_reservado";

const AUDIENCE_LABELS: Record<Audience, string> = {
  todos: "Todos los clientes",
  no_vip: "Solo clientes no-VIP",
  nunca_reservado: "Solo clientes que nunca han reservado",
};

// Campañas disponibles. Sólo la etiqueta y la CLAVE de config viven aquí; los nombres
// reales de las plantillas aprobadas (y su variante por idioma) están en `config`, no en
// el código — igual que plantilla_recordatorio y plantilla_resena.
const CAMPAIGNS = [
  {
    key: "verano_tratamientos",
    label: "Verano · tratamientos",
    plantillaClave: "plantilla_campana",
  },
] as const;

// A quién NO le va a llegar la campaña. Se enseña ANTES de disparar y con nombre: entre los
// excluidos hay clientas reales con cita cuyo teléfono está mal escrito, y una campaña que las
// salta en silencio deja el problema donde estaba. El motivo llega como código desde la API;
// la frase se pone aquí.
type ContactoExcluido = {
  telefono: string | null;
  nombre: string | null;
  motivo: string;
};

const MOTIVO_LABELS: Record<string, string> = {
  sin_numero: "sin teléfono",
  numero_invalido: "número mal escrito",
  prueba: "contacto de prueba",
};

// "3 con el número mal, 2 de prueba". Las dos formas de tener el número mal se cuentan juntas
// —para quien lee, es el mismo problema y la misma acción: llamarla y corregirlo—, pero en la
// lista de abajo cada una dice lo suyo.
function resumenExclusiones(porMotivo: Record<string, number>): string {
  const numeroMal = (porMotivo.sin_numero ?? 0) + (porMotivo.numero_invalido ?? 0);
  const prueba = porMotivo.prueba ?? 0;
  const partes: string[] = [];
  if (numeroMal) partes.push(`${numeroMal} con el número mal`);
  if (prueba) partes.push(`${prueba} de prueba`);
  return partes.join(", ");
}

type CampaignStatus = {
  total_audiencia: number;
  ya_enviados: number;
  pendientes: number;
  enviados_24h: number;
  cupo_24h_restante: number;
  proxima_tanda: number;
  max_por_24h: number;
  excluidos?: ContactoExcluido[];
  excluidos_por_motivo?: Record<string, number>;
};

export default function CampanasPage() {
  const { orgId } = useOrg();
  const [promoIdea, setPromoIdea] = useState("");
  const [promoMensaje, setPromoMensaje] = useState("");
  const [audience, setAudience] = useState<Audience>("todos");
  const [useTemplate, setUseTemplate] = useState(true);
  const [campaignKey, setCampaignKey] = useState<string>(CAMPAIGNS[0].key);
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<CampaignStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [verExcluidos, setVerExcluidos] = useState(false);

  const campaign = CAMPAIGNS.find((c) => c.key === campaignKey) ?? CAMPAIGNS[0];
  const excluidos = status?.excluidos ?? [];

  // Estado de la campaña: cuántas faltan y cuánto cupo queda hoy. Se consulta antes de
  // enviar para que la tanda no se dispare a ciegas, y se refresca tras cada envío.
  // Se consulta SIEMPRE, también con texto libre: el progreso de tandas solo aplica a las
  // plantillas, pero saber a quién no le va a llegar y por qué importa igual en los dos modos.
  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const qs = new URLSearchParams({ audience, campaignKey });
      const res = await fetch(`${API}/api/campaigns/status?${qs}`, {
        headers: await apiHeaders(orgId),
      });
      if (!res.ok) throw new Error("status");
      setStatus(await res.json());
    } catch {
      setStatus(null);
    } finally {
      setLoadingStatus(false);
    }
  }, [orgId, audience, campaignKey, useTemplate]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  async function generateMessage() {
    if (!promoIdea.trim()) return;
    setGenerating(true);
    try {
      const res = await fetch(`${API}/api/campaigns/generate-message`, {
        method: "POST",
        headers: { ...await apiHeaders(orgId), "Content-Type": "application/json" },
        body: JSON.stringify({ idea: promoIdea }),
      });
      if (!res.ok) throw new Error("Error generando mensaje");
      const data = await res.json();
      setPromoMensaje(data.mensaje || "");
    } catch {
      toast.error("No se pudo generar el mensaje");
    } finally {
      setGenerating(false);
    }
  }

  async function broadcast() {
    if (!useTemplate && !promoMensaje.trim()) return;
    setSending(true);
    try {
      const body: Record<string, unknown> = { audience };
      if (useTemplate) {
        // La plantilla se elige por CLAVE de config, no por nombre suelto: un nombre
        // crudo no sabe de idiomas y le mandaría la versión española a las clientas
        // rusas y ucranianas.
        body.plantillaClave = campaign.plantillaClave;
        body.campaignKey = campaign.key;
        // El texto libre sigue siendo útil: es lo que reciben las que están dentro de
        // la ventana de 24 h, donde no hace falta plantilla.
        if (promoMensaje.trim()) body.mensaje = promoMensaje;
      } else {
        body.mensaje = promoMensaje;
      }
      const res = await fetch(`${API}/api/campaigns/broadcast`, {
        method: "POST",
        headers: { ...await apiHeaders(orgId), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Error enviando mensajes");
      const data = await res.json();

      const enviados = data.enviados ?? 0;
      const restantes = data.restantes ?? 0;
      const omitidos = data.omitidos ?? 0;

      if (enviados === 0 && restantes > 0) {
        toast.warning(
          data.cupo_24h_restante === 0
            ? `Cupo diario agotado. Quedan ${restantes} por enviar: vuelve mañana.`
            : `No se envió a nadie · ${omitidos} omitido${omitidos !== 1 ? "s" : ""}`
        );
      } else {
        toast.success(
          `Enviado a ${enviados} cliente${enviados !== 1 ? "s" : ""}` +
            (omitidos ? ` · ${omitidos} omitido${omitidos !== 1 ? "s" : ""}` : "") +
            (restantes ? ` · quedan ${restantes} para la próxima tanda` : " · campaña completada")
        );
      }
      await loadStatus();
    } catch {
      toast.error("No se pudo enviar el mensaje");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Campañas"
        subtitle="Mensaje masivo con IA a tu base de clientes"
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6 space-y-6">
          {/* Generación del mensaje */}
          <Card className="border-border/60 shadow-sm">
            <CardContent className="p-4 space-y-3">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground flex items-center gap-1.5">
                <Megaphone size={12} /> Mensaje masivo
              </p>
              <div className="space-y-2">
                <p className="text-[11.5px] text-muted-foreground">
                  ¿Cuál es tu idea o promoción?
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="Ej: 15% de descuento en tratamientos este mes..."
                    value={promoIdea}
                    onChange={(e) => setPromoIdea(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && generateMessage()}
                    className="h-9 text-[13px]"
                  />
                  <Button
                    size="sm"
                    onClick={generateMessage}
                    disabled={generating || !promoIdea.trim()}
                  >
                    <Sparkles size={13} className="mr-1" />
                    {generating ? "Generando..." : "Generar con IA"}
                  </Button>
                </div>
              </div>
              {promoMensaje && (
                <Textarea
                  value={promoMensaje}
                  onChange={(e) => setPromoMensaje(e.target.value)}
                  className="text-[13px] min-h-[80px] resize-none"
                />
              )}
            </CardContent>
          </Card>

          {/* Audiencia */}
          <Card className="border-border/60 shadow-sm">
            <CardContent className="p-4 space-y-3">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground flex items-center gap-1.5">
                <Users size={12} /> Audiencia
              </p>
              <Select
                value={audience}
                onValueChange={(v) => setAudience(v as Audience)}
              >
                <SelectTrigger className="h-9 w-full text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todos">{AUDIENCE_LABELS.todos}</SelectItem>
                  <SelectItem value="no_vip">{AUDIENCE_LABELS.no_vip}</SelectItem>
                  <SelectItem value="nunca_reservado">
                    {AUDIENCE_LABELS.nunca_reservado}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11.5px] text-muted-foreground flex items-center gap-1.5">
                <Info size={12} className="flex-shrink-0" />
                Los contactos en lista negra siempre se excluyen.
              </p>

              {status && (
                <div className="space-y-1.5 pt-0.5">
                  <p className="text-[11.5px] text-foreground">
                    <span className="font-semibold tabular-nums">{status.total_audiencia}</span>{" "}
                    destinatario{status.total_audiencia !== 1 ? "s" : ""}
                    {excluidos.length > 0 && (
                      <>
                        {" · "}
                        <span className="font-semibold tabular-nums">{excluidos.length}</span> fuera:{" "}
                        {resumenExclusiones(status.excluidos_por_motivo ?? {})}
                      </>
                    )}
                  </p>

                  {excluidos.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() => setVerExcluidos((v) => !v)}
                        className="text-[11.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                      >
                        {verExcluidos ? "Ocultar" : "Ver quiénes"}
                      </button>

                      {verExcluidos && (
                        <>
                          <ul className="divide-y divide-border/50 rounded-md border border-border/60 bg-muted/30">
                            {excluidos.map((e, i) => (
                              <li
                                key={`${e.telefono ?? ""}-${i}`}
                                className="flex items-center justify-between gap-2 px-2.5 py-1.5"
                              >
                                <span className="truncate text-[11.5px] text-foreground">
                                  {e.nombre?.trim() || "Sin nombre"}
                                  <span className="text-muted-foreground">
                                    {" · "}
                                    {e.telefono?.trim() || "sin teléfono"}
                                  </span>
                                </span>
                                <span className="whitespace-nowrap text-[10.5px] text-muted-foreground">
                                  {MOTIVO_LABELS[e.motivo] ?? e.motivo}
                                </span>
                              </li>
                            ))}
                          </ul>
                          <p className="text-[11px] text-muted-foreground">
                            No se les puede entregar nada por WhatsApp con ese número. Corrígelo en
                            su ficha y volverán a entrar en la audiencia solas.
                          </p>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Plantilla aprobada (360dialog) + tandas */}
          <Card className="border-border/60 shadow-sm">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[13px] font-medium text-foreground">
                    Usar plantilla aprobada
                  </p>
                  <p className="text-[11.5px] text-muted-foreground">
                    Necesaria para escribir a contactos fuera de la ventana de 24h
                  </p>
                </div>
                <Switch checked={useTemplate} onCheckedChange={setUseTemplate} />
              </div>

              {useTemplate && (
                <div className="space-y-3 pt-1">
                  <Select
                    value={campaignKey}
                    onValueChange={(v) => setCampaignKey(v ?? CAMPAIGNS[0].key)}
                  >
                    <SelectTrigger className="h-9 w-full text-[13px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CAMPAIGNS.map((c) => (
                        <SelectItem key={c.key} value={c.key}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {status && (
                    <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground flex items-center gap-1.5">
                          <Layers size={12} /> Progreso de la campaña
                        </p>
                        <button
                          type="button"
                          onClick={loadStatus}
                          disabled={loadingStatus}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                          aria-label="Actualizar progreso"
                        >
                          <RefreshCw size={12} className={loadingStatus ? "animate-spin" : ""} />
                        </button>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div>
                          <p className="text-[17px] font-semibold tabular-nums text-foreground">
                            {status.ya_enviados}
                          </p>
                          <p className="text-[10.5px] text-muted-foreground">Ya enviados</p>
                        </div>
                        <div>
                          <p className="text-[17px] font-semibold tabular-nums text-foreground">
                            {status.pendientes}
                          </p>
                          <p className="text-[10.5px] text-muted-foreground">Pendientes</p>
                        </div>
                        <div>
                          <p className="text-[17px] font-semibold tabular-nums text-foreground">
                            {status.cupo_24h_restante}
                          </p>
                          <p className="text-[10.5px] text-muted-foreground">Cupo hoy</p>
                        </div>
                      </div>
                      <p className="text-[11.5px] text-muted-foreground flex items-start gap-1.5">
                        <Info size={12} className="flex-shrink-0 mt-0.5" />
                        {status.pendientes === 0
                          ? "Campaña completada: no queda nadie por recibirla."
                          : status.proxima_tanda === 0
                          ? `Cupo diario agotado (${status.enviados_24h}/${status.max_por_24h} en las últimas 24 h). Vuelve mañana para seguir.`
                          : `Se enviará a ${status.proxima_tanda} de ${status.pendientes} pendientes. El resto, en la siguiente tanda.`}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Enviar */}
          <Button
            onClick={broadcast}
            disabled={
              sending ||
              (useTemplate
                ? !status || status.proxima_tanda === 0
                : !promoMensaje.trim())
            }
            className="w-full"
          >
            <Send size={14} className="mr-1.5" />
            {sending
              ? "Enviando..."
              : useTemplate
              ? `Enviar tanda de ${status?.proxima_tanda ?? 0}`
              : `Enviar a ${AUDIENCE_LABELS[audience].toLowerCase()}`}
          </Button>
        </div>
      </div>
    </>
  );
}
