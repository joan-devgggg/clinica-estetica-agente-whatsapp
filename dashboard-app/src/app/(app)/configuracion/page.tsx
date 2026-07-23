"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Trash2, Clock } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { BotToggle } from "@/components/configuracion/bot-toggle";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { API, apiHeaders } from "@/lib/api";

const DIAS = [
  { key: "lun", label: "Lunes" },
  { key: "mar", label: "Martes" },
  { key: "mie", label: "Miércoles" },
  { key: "jue", label: "Jueves" },
  { key: "vie", label: "Viernes" },
  { key: "sab", label: "Sábado" },
  { key: "dom", label: "Domingo" },
];

const TONES = [
  { value: "amigable", label: "Amigable" },
  { value: "profesional", label: "Profesional" },
  { value: "formal", label: "Formal" },
];

interface Servicio {
  nombre: string;
  duracion_min: number;
  precio: number;
  descripcion?: string;
}

interface HorarioDia {
  apertura: string;
  cierre: string;
  abierto: boolean;
}

interface Config {
  clinica_info?: {
    nombre?: string;
    telefono?: string;
    email?: string;
    direccion?: string;
    descripcion?: string;
    google_review_link?: string;
  };
  servicios?: Servicio[];
  horario?: Record<string, HorarioDia>;
  minutos_resena?: number;
  horas_recordatorio?: number;
  bot_activo?: boolean;
}

interface AgentConfig {
  system_prompt?: string;
  tone?: string;
  handoff_message?: string;
}

async function putConfig(clave: string, valor: unknown) {
  await fetch(`${API}/api/config/${clave}`, {
    method: "PUT",
    headers: apiHeaders(),
    body: JSON.stringify({ valor }),
  });
}

async function patchAgentConfig(campos: Partial<AgentConfig>) {
  const res = await fetch(`${API}/api/agent-config`, {
    method: "PATCH",
    headers: apiHeaders(),
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

  const fetchAll = useCallback(async () => {
    try {
      const [cfgRes, agentRes] = await Promise.all([
        fetch(`${API}/api/config`, { headers: apiHeaders() }),
        fetch(`${API}/api/agent-config`, { headers: apiHeaders() }),
      ]);
      if (!cfgRes.ok || !agentRes.ok) throw new Error("API no disponible");
      setConfig(await cfgRes.json());
      setAgentCfg(await agentRes.json());
    } catch {
      /* API offline */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ── Bot toggle ──
  async function handleBotToggle(next: boolean) {
    setSavingBot(true);
    await putConfig("bot_activo", next);
    setConfig((c) => ({ ...c, bot_activo: next }));
    setSavingBot(false);
  }

  // ── Clínica info ──
  async function handleSaveClinica(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const info = {
      nombre: form.get("nombre"),
      telefono: form.get("telefono"),
      email: form.get("email"),
      direccion: form.get("direccion"),
      descripcion: form.get("descripcion"),
      google_review_link: form.get("google_review_link"),
    };
    await putConfig("clinica_info", info);
    setConfig((c) => ({ ...c, clinica_info: info as Config["clinica_info"] }));
    toast.success("Información guardada");
  }

  // ── Servicios ──
  const servicios = config.servicios ?? [];

  function updateServicio(i: number, field: keyof Servicio, val: string | number) {
    const next = servicios.map((s, idx) =>
      idx === i
        ? { ...s, [field]: field === "nombre" || field === "descripcion" ? val : Number(val) }
        : s
    );
    setConfig((c) => ({ ...c, servicios: next }));
  }

  function addServicio() {
    setConfig((c) => ({
      ...c,
      servicios: [...(c.servicios ?? []), { nombre: "", duracion_min: 45, precio: 0, descripcion: "" }],
    }));
  }

  function removeServicio(i: number) {
    setConfig((c) => ({ ...c, servicios: servicios.filter((_, idx) => idx !== i) }));
  }

  async function saveServicios() {
    await putConfig("servicios", servicios);
    toast.success("Tratamientos guardados");
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
    await putConfig("horario", horario);
    toast.success("Horario guardado");
  }

  // ── Automatización ──
  async function handleSaveAutomacion(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const mins = Number(form.get("minutos_resena"));
    const horas = Number(form.get("horas_recordatorio"));
    await Promise.all([
      putConfig("minutos_resena", mins),
      putConfig("horas_recordatorio", horas),
    ]);
    setConfig((c) => ({ ...c, minutos_resena: mins, horas_recordatorio: horas }));
    toast.success("Tiempos guardados");
  }

  // ── Identidad del bot ──
  async function handleSaveIdentidad(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await patchAgentConfig({
        tone: form.get("tone") as string,
        handoff_message: form.get("handoff_message") as string,
      });
      toast.success("Identidad guardada");
    } catch {
      toast.error("Error al guardar");
    }
  }

  // ── System prompt ──
  async function handleSavePrompt(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await patchAgentConfig({ system_prompt: form.get("system_prompt") as string });
      toast.success("System prompt guardado");
    } catch {
      toast.error("Error al guardar");
    }
  }

  if (loading) {
    return (
      <>
        <PageHeader title="Configuración" subtitle="Ajustes de la clínica y del agente" />
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

  const ci = config.clinica_info ?? {};

  return (
    <>
      <PageHeader title="Configuración" subtitle="Ajustes de la clínica y del agente" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8 space-y-6">

          {/* Bot toggle */}
          <BotToggle
            active={config.bot_activo ?? false}
            onToggle={handleBotToggle}
            loading={savingBot}
          />

          {/* Información de la clínica */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="pb-2 pt-5 px-5">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                Información de la clínica
              </p>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              <form onSubmit={handleSaveClinica} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                      Nombre
                    </Label>
                    <Input name="nombre" defaultValue={ci.nombre ?? ""} className="h-9" placeholder="Clínica Aurora" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                      Teléfono
                    </Label>
                    <Input name="telefono" defaultValue={ci.telefono ?? ""} className="h-9" placeholder="+34 900 000 000" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                      Email
                    </Label>
                    <Input name="email" defaultValue={ci.email ?? ""} className="h-9" placeholder="info@clinica.com" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                      Dirección
                    </Label>
                    <Input name="direccion" defaultValue={ci.direccion ?? ""} className="h-9" placeholder="Calle, ciudad" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                    Descripción (el bot la usa)
                  </Label>
                  <Textarea
                    name="descripcion"
                    defaultValue={ci.descripcion ?? ""}
                    rows={3}
                    placeholder="Somos una clínica especializada en..."
                    className="resize-none text-[13.5px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                    Link Google Reviews
                  </Label>
                  <Input name="google_review_link" defaultValue={ci.google_review_link ?? ""} className="h-9" placeholder="g.page/r/..." />
                </div>
                <div className="flex justify-end pt-1">
                  <Button type="submit" size="sm">Guardar información</Button>
                </div>
              </form>
            </CardContent>
          </Card>

          {/* Tratamientos */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="pb-2 pt-5 px-5">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                Tratamientos
              </p>
            </CardHeader>
            <CardContent className="px-5 pb-5 space-y-4">
              {servicios.length === 0 && (
                <p className="text-[12.5px] text-muted-foreground py-2">Sin tratamientos configurados</p>
              )}
              {servicios.map((s, i) => (
                <div key={i} className="space-y-2.5 pb-4 border-b border-border/40 last:border-0 last:pb-0">
                  <div className="flex items-end gap-3">
                    <div className="flex-1 space-y-1.5">
                      <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                        Nombre
                      </Label>
                      <Input
                        value={s.nombre}
                        onChange={(e) => updateServicio(i, "nombre", e.target.value)}
                        className="h-9"
                        placeholder="Botox"
                      />
                    </div>
                    <div className="w-28 space-y-1.5">
                      <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                        Duración (min)
                      </Label>
                      <Input
                        type="number"
                        value={s.duracion_min}
                        onChange={(e) => updateServicio(i, "duracion_min", e.target.value)}
                        className="h-9"
                        min={5}
                      />
                    </div>
                    <div className="w-24 space-y-1.5">
                      <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                        Precio (€)
                      </Label>
                      <Input
                        type="number"
                        value={s.precio}
                        onChange={(e) => updateServicio(i, "precio", e.target.value)}
                        className="h-9"
                        min={0}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-muted-foreground hover:text-destructive flex-shrink-0"
                      onClick={() => removeServicio(i)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                      Descripción (el bot la usa para responder preguntas)
                    </Label>
                    <Textarea
                      value={s.descripcion ?? ""}
                      onChange={(e) => updateServicio(i, "descripcion", e.target.value)}
                      rows={2}
                      placeholder="Describe el tratamiento, qué incluye, resultados esperados..."
                      className="resize-none text-[13px]"
                    />
                  </div>
                </div>
              ))}
              <Separator className="my-1" />
              <div className="flex items-center justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground text-[12.5px] -ml-2"
                  onClick={addServicio}
                >
                  <Plus size={13} className="mr-1" /> Añadir tratamiento
                </Button>
                <Button size="sm" onClick={saveServicios}>
                  Guardar tratamientos
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Horario de atención */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="pb-2 pt-5 px-5">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                Horario de atención
              </p>
            </CardHeader>
            <CardContent className="px-5 pb-5 space-y-3">
              {DIAS.map(({ key, label }) => {
                const dia = horario[key] ?? { apertura: "10:00", cierre: "20:00", abierto: true };
                return (
                  <div key={key} className="flex items-center gap-4">
                    <button
                      type="button"
                      onClick={() => updateHorario(key, "abierto", !dia.abierto)}
                      className={`w-28 text-left text-[13px] font-medium transition-colors ${
                        dia.abierto ? "text-foreground" : "text-muted-foreground line-through"
                      }`}
                    >
                      {label}
                    </button>
                    {dia.abierto ? (
                      <>
                        <Input
                          type="time"
                          value={dia.apertura}
                          onChange={(e) => updateHorario(key, "apertura", e.target.value)}
                          className="h-8 w-32 text-[12.5px]"
                        />
                        <span className="text-[12px] text-muted-foreground">–</span>
                        <Input
                          type="time"
                          value={dia.cierre}
                          onChange={(e) => updateHorario(key, "cierre", e.target.value)}
                          className="h-8 w-32 text-[12.5px]"
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
                      <Clock size={11} /> Reseña post-cita (min)
                    </Label>
                    <Input
                      name="minutos_resena"
                      type="number"
                      defaultValue={config.minutos_resena ?? 30}
                      min={5}
                      className="h-9"
                    />
                    <p className="text-[10.5px] text-muted-foreground">
                      Minutos después de la cita para pedir reseña
                    </p>
                  </div>
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
                      Horas antes de la cita para el recordatorio
                    </p>
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm">Guardar tiempos</Button>
                </div>
              </form>
            </CardContent>
          </Card>

          {/* Identidad del bot */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="pb-2 pt-5 px-5">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                Identidad del bot
              </p>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              <form onSubmit={handleSaveIdentidad} className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                    Tono
                  </Label>
                  <select
                    name="tone"
                    defaultValue={agentCfg.tone ?? "amigable"}
                    className="h-9 w-48 rounded-md border border-input bg-transparent px-3 text-[13.5px] focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    {TONES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                    Mensaje de traspaso a humano
                  </Label>
                  <Textarea
                    name="handoff_message"
                    defaultValue={agentCfg.handoff_message ?? ""}
                    rows={2}
                    placeholder="Un momento, te paso con un miembro del equipo."
                    className="resize-none text-[13.5px]"
                  />
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm">Guardar identidad</Button>
                </div>
              </form>
            </CardContent>
          </Card>

          {/* System prompt */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="pb-2 pt-5 px-5">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                System prompt
              </p>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              <form onSubmit={handleSavePrompt} className="space-y-3">
                <p className="text-[12px] text-muted-foreground">
                  Instrucciones base del bot. Se anteponen al contexto de la conversación.
                </p>
                <Textarea
                  name="system_prompt"
                  defaultValue={agentCfg.system_prompt ?? ""}
                  rows={8}
                  placeholder="Eres la asistente virtual de la clínica. Tu objetivo es..."
                  className="resize-y text-[13px] font-mono"
                />
                <div className="flex justify-end">
                  <Button type="submit" size="sm">Guardar prompt</Button>
                </div>
              </form>
            </CardContent>
          </Card>

        </div>
      </div>
    </>
  );
}
