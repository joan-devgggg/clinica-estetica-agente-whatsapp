"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Sparkles, Send, Megaphone, Users, Info } from "lucide-react";
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

export default function CampanasPage() {
  const { orgId } = useOrg();
  const [promoIdea, setPromoIdea] = useState("");
  const [promoMensaje, setPromoMensaje] = useState("");
  const [audience, setAudience] = useState<Audience>("todos");
  const [useTemplate, setUseTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);

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
        if (!templateName) {
          toast.error("Selecciona una plantilla");
          setSending(false);
          return;
        }
        body.templateName = templateName;
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
      if (data.pendiente_plantilla) {
        toast.info(
          "El envío por plantilla aprobada requiere 360dialog (aún no conectado)."
        );
      } else {
        const enviados = data.enviados ?? 0;
        const omitidos = data.omitidos ?? 0;
        toast.success(
          `Mensaje enviado a ${enviados} cliente${enviados !== 1 ? "s" : ""}` +
            (omitidos ? ` · ${omitidos} omitido${omitidos !== 1 ? "s" : ""}` : "")
        );
      }
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
            </CardContent>
          </Card>

          {/* Plantilla aprobada (360dialog) */}
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
                <div className="space-y-2 pt-1">
                  <Select
                    value={templateName}
                    onValueChange={(v) => setTemplateName(v ?? "")}
                    disabled
                  >
                    <SelectTrigger className="h-9 w-full text-[13px]">
                      <SelectValue placeholder="No hay plantillas disponibles todavía" />
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                  <p className="text-[11.5px] text-amber-600 dark:text-amber-500 flex items-center gap-1.5">
                    <Info size={12} className="flex-shrink-0" />
                    Requiere plantilla aprobada en 360dialog (próximamente).
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Enviar */}
          <Button
            onClick={broadcast}
            disabled={
              sending ||
              (useTemplate ? !templateName : !promoMensaje.trim())
            }
            className="w-full"
          >
            <Send size={14} className="mr-1.5" />
            {sending
              ? "Enviando..."
              : `Enviar a ${AUDIENCE_LABELS[audience].toLowerCase()}`}
          </Button>
        </div>
      </div>
    </>
  );
}
