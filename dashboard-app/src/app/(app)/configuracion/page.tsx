"use client";

import { useEffect, useState, useCallback } from "react";
import { Clock } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { BotToggle } from "@/components/configuracion/bot-toggle";
import { StylistsConfig } from "@/components/configuracion/stylists-config";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { API, apiHeaders } from "@/lib/api";
import { useOrg } from "@/lib/org-context";

const DIAS = [
  { key: "lun", label: "Lunes" },
  { key: "mar", label: "Martes" },
  { key: "mie", label: "Miércoles" },
  { key: "jue", label: "Jueves" },
  { key: "vie", label: "Viernes" },
  { key: "sab", label: "Sábado" },
  { key: "dom", label: "Domingo" },
];

interface HorarioDia {
  apertura: string;
  cierre: string;
  abierto: boolean;
}

interface RestauranteInfo {
  nombre?: string;
  telefono?: string;
  email?: string;
  direccion?: string;
  descripcion?: string;
}

interface FAQs {
  horarios?: string;
  carta?: string;
  parking?: string;
  alergias?: string;
}

interface BizumConfig {
  numero?: string;
  importe?: number;
}

interface VipConfig {
  visitasParaSugerir?: number;
}

interface BusinessInfo {
  faqs?: FAQs;
  bizum?: BizumConfig;
  vip?: VipConfig;
}

interface Config {
  restaurante_info?: RestauranteInfo;
  horario?: Record<string, HorarioDia>;
  horas_recordatorio?: number;
  bot_activo?: boolean;
}

interface AgentConfig {
  system_prompt?: string;
  tone?: string;
  handoff_message?: string;
  business_info?: BusinessInfo;
}

async function putConfig(orgId: string, clave: string, valor: unknown) {
  await fetch(`${API}/api/config/${clave}`, {
    method: "PUT",
    headers: apiHeaders(orgId),
    body: JSON.stringify({ valor }),
  });
}

async function patchAgentConfig(orgId: string, campos: Partial<AgentConfig>) {
  const res = await fetch(`${API}/api/agent-config`, {
    method: "PATCH",
    headers: apiHeaders(orgId),
    body: JSON.stringify(campos),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export default function ConfiguracionPage() {
  const [config, setConfig] = useState<Config>({});
  const [agentCfg, setAgentCfg] = useState<AgentConfig>({});
  const [loading, setLoading] = useState(true);
  const [savingBot, setSavingBot] = useState(false);
  const { orgId, orgType } = useOrg();

  const fetchAll = useCallback(async () => {
    if (!orgId) return;
    try {
      const [cfgRes, agentRes] = await Promise.all([
        fetch(`${API}/api/config`, { headers: apiHeaders(orgId) }),
        fetch(`${API}/api/agent-config`, { headers: apiHeaders(orgId) }),
      ]);
      if (!cfgRes.ok || !agentRes.ok) throw new Error("API no disponible");
      setConfig(await cfgRes.json());
      setAgentCfg(await agentRes.json());
    } catch {
      /* API offline */
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ── Bot toggle ──
  async function handleBotToggle(next: boolean) {
    setSavingBot(true);
    await putConfig(orgId, "bot_activo", next);
    setConfig((c) => ({ ...c, bot_activo: next }));
    setSavingBot(false);
  }

  // ── Información del restaurante ──
  async function handleSaveRestaurante(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const info: RestauranteInfo = {
      nombre: form.get("nombre") as string,
      telefono: form.get("telefono") as string,
      email: form.get("email") as string,
      direccion: form.get("direccion") as string,
      descripcion: form.get("descripcion") as string,
    };
    await putConfig(orgId, "restaurante_info", info);
    setConfig((c) => ({ ...c, restaurante_info: info }));
    toast.success("Información guardada");
  }

  // ── Horario ──
  const horario = config.horario ?? {};

  function updateHorario(dia: string, field: keyof HorarioDia, val: string | boolean) {
    setConfig((c) => ({
      ...c,
      horario: {
        ...c.horario,
        [dia]: {
          ...(c.horario?.[dia] ?? { apertura: "10:00", cierre: "20:00", abierto: true }),
          [field]: val,
        },
      },
    }));
  }

  async function saveHorario() {
    await putConfig(orgId, "horario", horario);
    toast.success("Horario guardado");
  }

  // ── FAQs, Bizum y VIP ──
  async function handleSaveBusinessInfo(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const businessInfo: BusinessInfo = {
      faqs: {
        horarios: form.get("faq_horarios") as string,
        carta: form.get("faq_carta") as string,
        parking: form.get("faq_parking") as string,
        alergias: form.get("faq_alergias") as string,
      },
      bizum: {
        numero: form.get("bizum_numero") as string,
        importe: Number(form.get("bizum_importe")),
      },
      vip: {
        visitasParaSugerir: Number(form.get("vip_visitas")),
      },
    };
    try {
      await patchAgentConfig(orgId, { business_info: businessInfo });
      setAgentCfg((c) => ({ ...c, business_info: businessInfo }));
      toast.success("FAQs y Bizum guardados");
    } catch {
      toast.error("Error al guardar");
    }
  }

  // ── Automatización ──
  async function handleSaveAutomacion(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const horas = Number(form.get("horas_recordatorio"));
    await putConfig(orgId, "horas_recordatorio", horas);
    setConfig((c) => ({ ...c, horas_recordatorio: horas }));
    toast.success("Tiempo guardado");
  }

  if (loading) {
    return (
      <>
        <PageHeader title="Configuración" subtitle="Ajustes del negocio y del agente" />
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-6 py-8 space-y-4">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-40 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </>
    );
  }

  const ri = config.restaurante_info ?? {};
  const bi = agentCfg.business_info ?? {};
  const faqs = bi.faqs ?? {};
  const bizum = bi.bizum ?? {};
  const vip = bi.vip ?? {};

  return (
    <>
      <PageHeader title="Configuración" subtitle="Ajustes del negocio y del agente" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8 space-y-6">

          {/* Bot toggle */}
          <BotToggle
            active={config.bot_activo ?? false}
            onToggle={handleBotToggle}
            loading={savingBot}
          />

          {/* Estilistas — solo salón */}
          {orgType === "salon" && <StylistsConfig orgId={orgId} />}

          {/* Información del restaurante — solo restaurant */}
          {orgType !== "salon" && <Card className="border-border/60 shadow-sm">
            <CardHeader className="pb-2 pt-5 px-5">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                Información del restaurante
              </p>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              <form onSubmit={handleSaveRestaurante} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                      Nombre
                    </Label>
                    <Input name="nombre" defaultValue={ri.nombre ?? ""} className="h-9" placeholder="Restaurante San Remo" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                      Teléfono
                    </Label>
                    <Input name="telefono" defaultValue={ri.telefono ?? ""} className="h-9" placeholder="+34 900 000 000" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                      Email
                    </Label>
                    <Input name="email" defaultValue={ri.email ?? ""} className="h-9" placeholder="info@restaurantesanremo.com" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                      Dirección
                    </Label>
                    <Input name="direccion" defaultValue={ri.direccion ?? ""} className="h-9" placeholder="Calle, Palencia" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                    Descripción (el bot la usa)
                  </Label>
                  <Textarea
                    name="descripcion"
                    defaultValue={ri.descripcion ?? ""}
                    rows={3}
                    placeholder="Somos un restaurante especializado en..."
                    className="resize-none text-[13.5px]"
                  />
                </div>
                <div className="flex justify-end pt-1">
                  <Button type="submit" size="sm">Guardar información</Button>
                </div>
              </form>
            </CardContent>
          </Card>}

          {/* FAQs, Bizum y VIP — solo restaurant */}
          {orgType !== "salon" && <Card className="border-border/60 shadow-sm">
            <CardHeader className="pb-2 pt-5 px-5">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                FAQs, Bizum y VIP
              </p>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              <form onSubmit={handleSaveBusinessInfo} className="space-y-5">
                <div className="space-y-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    Preguntas frecuentes
                  </p>
                  <div className="space-y-1.5">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                      Horarios
                    </Label>
                    <Textarea
                      name="faq_horarios"
                      defaultValue={faqs.horarios ?? ""}
                      rows={2}
                      placeholder="Abrimos de martes a domingo de 13:00 a 16:00..."
                      className="resize-none text-[13px]"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                      Carta
                    </Label>
                    <Textarea
                      name="faq_carta"
                      defaultValue={faqs.carta ?? ""}
                      rows={2}
                      placeholder="Nuestra carta incluye..."
                      className="resize-none text-[13px]"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                      Parking
                    </Label>
                    <Textarea
                      name="faq_parking"
                      defaultValue={faqs.parking ?? ""}
                      rows={2}
                      placeholder="Disponemos de parking propio / cercano en..."
                      className="resize-none text-[13px]"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                      Alergias
                    </Label>
                    <Textarea
                      name="faq_alergias"
                      defaultValue={faqs.alergias ?? ""}
                      rows={2}
                      placeholder="Adaptamos los platos a intolerancias y alergias, indícanoslo al reservar..."
                      className="resize-none text-[13px]"
                    />
                  </div>
                </div>

                <Separator />

                <div className="space-y-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    Señal por Bizum
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                        Número Bizum
                      </Label>
                      <Input name="bizum_numero" defaultValue={bizum.numero ?? ""} className="h-9" placeholder="+34 600 000 000" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                        Importe (€)
                      </Label>
                      <Input name="bizum_importe" type="number" min={0} defaultValue={bizum.importe ?? 10} className="h-9" />
                    </div>
                  </div>
                </div>

                <Separator />

                <div className="space-y-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    Clientes VIP
                  </p>
                  <div className="space-y-1.5 max-w-xs">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                      Visitas para sugerir VIP
                    </Label>
                    <Input name="vip_visitas" type="number" min={1} defaultValue={vip.visitasParaSugerir ?? 3} className="h-9" />
                    <p className="text-[10.5px] text-muted-foreground">
                      A partir de cuántas visitas se sugiere marcar al cliente como VIP
                    </p>
                  </div>
                </div>

                <div className="flex justify-end pt-1">
                  <Button type="submit" size="sm">Guardar</Button>
                </div>
              </form>
            </CardContent>
          </Card>}

          {/* Horario de atención */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="pb-2 pt-5 px-5">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                Horario de atención
              </p>
            </CardHeader>
            <CardContent className="px-5 pb-5 space-y-3">
              {DIAS.map(({ key, label }) => {
                const dia = horario[key] ?? { apertura: "10:00", cierre: "19:00", abierto: true };
                return (
                  <div key={key} className="flex items-center gap-4">
                    <Switch
                      checked={dia.abierto}
                      onCheckedChange={(checked) => updateHorario(key, "abierto", checked)}
                      aria-label={`${label} ${dia.abierto ? "abierto" : "cerrado"}`}
                    />
                    <span
                      className={`w-28 text-[13px] font-medium transition-colors ${
                        dia.abierto ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {label}
                    </span>
                    {dia.abierto ? (
                      <>
                        <input
                          type="time"
                          value={dia.apertura}
                          onChange={(e) => updateHorario(key, "apertura", e.target.value)}
                          className="h-8 w-32 rounded-md border border-input bg-transparent px-2.5 text-[12.5px] outline-none focus:border-ring focus:ring-3 focus:ring-ring/50"
                        />
                        <span className="text-[12px] text-muted-foreground">–</span>
                        <input
                          type="time"
                          value={dia.cierre}
                          onChange={(e) => updateHorario(key, "cierre", e.target.value)}
                          className="h-8 w-32 rounded-md border border-input bg-transparent px-2.5 text-[12.5px] outline-none focus:border-ring focus:ring-3 focus:ring-ring/50"
                        />
                      </>
                    ) : (
                      <span className="text-[12px] text-muted-foreground italic">Cerrado</span>
                    )}
                  </div>
                );
              })}
              <div className="flex justify-end pt-2">
                <Button size="sm" onClick={saveHorario}>
                  Guardar horario
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Automatización */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="pb-2 pt-5 px-5">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                Automatización
              </p>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              <form onSubmit={handleSaveAutomacion} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground flex items-center gap-1.5">
                      <Clock size={11} /> Recordatorio previo (h)
                    </Label>
                    <Input
                      name="horas_recordatorio"
                      type="number"
                      defaultValue={config.horas_recordatorio ?? 24}
                      min={1}
                      className="h-9"
                    />
                    <p className="text-[10.5px] text-muted-foreground">
                      Horas antes de la reserva para enviar el recordatorio
                    </p>
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm">Guardar tiempo</Button>
                </div>
              </form>
            </CardContent>
          </Card>

        </div>
      </div>
    </>
  );
}
