"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TimePickerSelect } from "@/components/ui/time-picker-select";
import { API, apiHeaders } from "@/lib/api";

// Esquema: day_of_week 0 = Lunes … 6 = Domingo (igual que stylist_schedules en Supabase).
const DIAS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

interface ScheduleRow {
  day_of_week: number;
  start_time: string; // "HH:MM"
  end_time: string; // "HH:MM"
}

interface Stylist {
  id: string;
  name: string;
  role: string | null;
  skills: string[];
}

interface DayState {
  abierto: boolean;
  apertura: string;
  cierre: string;
}

function hhmm(t?: string): string {
  return (t ?? "").slice(0, 5) || "10:00";
}

function buildDayStates(rows: ScheduleRow[]): DayState[] {
  return DIAS.map((_, idx) => {
    const row = rows.find((r) => r.day_of_week === idx);
    return row
      ? { abierto: true, apertura: hhmm(row.start_time), cierre: hhmm(row.end_time) }
      : { abierto: false, apertura: "10:00", cierre: "19:00" };
  });
}

const LBL = "text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground";

export function StylistsConfig({ orgId }: { orgId: string }) {
  const [loading, setLoading] = useState(true);
  const [stylists, setStylists] = useState<Stylist[]>([]);
  const [schedules, setSchedules] = useState<Record<string, DayState[]>>({});
  const [categorias, setCategorias] = useState<string[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!orgId) return;
    try {
      const [stylistsRes, agentRes] = await Promise.all([
        fetch(`${API}/api/stylists`, { headers: apiHeaders(orgId) }),
        fetch(`${API}/api/agent-config`, { headers: apiHeaders(orgId) }),
      ]);
      if (!stylistsRes.ok) throw new Error("API no disponible");
      const list: Stylist[] = await stylistsRes.json();
      const normalized = list.map((s) => ({ ...s, skills: Array.isArray(s.skills) ? s.skills : [] }));
      setStylists(normalized);

      // Categorías disponibles (para el selector de servicios) desde el catálogo del agente.
      try {
        const agent = await agentRes.json();
        const cats: string[] = Array.isArray(agent?.services)
          ? [...new Set(agent.services.map((sv: { categoria?: string }) => sv.categoria).filter(Boolean))] as string[]
          : [];
        setCategorias(cats.sort((a, b) => a.localeCompare(b)));
      } catch {
        setCategorias([]);
      }

      // Horarios por estilista en paralelo.
      const entries = await Promise.all(
        normalized.map(async (s) => {
          const r = await fetch(`${API}/api/stylist-schedule/${s.id}`, { headers: apiHeaders(orgId) });
          const rows: ScheduleRow[] = r.ok ? await r.json() : [];
          return [s.id, buildDayStates(rows)] as const;
        })
      );
      setSchedules(Object.fromEntries(entries));
    } catch {
      /* API offline */
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  function updateStylistField(id: string, field: "name", value: string) {
    setStylists((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  }

  function addSkill(id: string, skill: string) {
    if (!skill) return;
    setStylists((prev) =>
      prev.map((s) =>
        s.id === id && !s.skills.includes(skill) ? { ...s, skills: [...s.skills, skill] } : s
      )
    );
  }

  function removeSkill(id: string, skill: string) {
    setStylists((prev) =>
      prev.map((s) => (s.id === id ? { ...s, skills: s.skills.filter((k) => k !== skill) } : s))
    );
  }

  function updateDay(id: string, dayIdx: number, patch: Partial<DayState>) {
    setSchedules((prev) => {
      const days = prev[id] ?? buildDayStates([]);
      const next = days.map((d, i) => (i === dayIdx ? { ...d, ...patch } : d));
      return { ...prev, [id]: next };
    });
  }

  async function saveStylist(id: string) {
    const stylist = stylists.find((s) => s.id === id);
    if (!stylist) return;
    const days = schedules[id] ?? buildDayStates([]);
    const scheduleRows = days
      .map((d, idx) => ({ ...d, idx }))
      .filter((d) => d.abierto)
      .map((d) => ({ day_of_week: d.idx, start_time: d.apertura, end_time: d.cierre }));

    setSavingId(id);
    try {
      const [r1, r2] = await Promise.all([
        fetch(`${API}/api/stylists/${id}`, {
          method: "PUT",
          headers: apiHeaders(orgId),
          body: JSON.stringify({ name: stylist.name, skills: stylist.skills }),
        }),
        fetch(`${API}/api/stylist-schedule/${id}`, {
          method: "PUT",
          headers: apiHeaders(orgId),
          body: JSON.stringify({ schedules: scheduleRows }),
        }),
      ]);
      if (!r1.ok || !r2.ok) throw new Error("Error al guardar");
      toast.success(`${stylist.name} guardada`);
    } catch {
      toast.error("Error al guardar la estilista");
    } finally {
      setSavingId(null);
    }
  }

  if (loading) {
    return (
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-2 pt-5 px-5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            Estilistas
          </p>
        </CardHeader>
        <CardContent className="px-5 pb-5 space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/60 shadow-sm">
      <CardHeader className="pb-2 pt-5 px-5">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          Estilistas
        </p>
        <p className="text-[11.5px] text-muted-foreground">
          Servicios y horario de cada profesional. El bot lee esta configuración para asignar citas.
        </p>
      </CardHeader>
      <CardContent className="px-5 pb-5 space-y-5">
        {stylists.map((stylist) => {
          const days = schedules[stylist.id] ?? buildDayStates([]);
          const disponibles = categorias.filter((c) => !stylist.skills.includes(c));
          return (
            <div key={stylist.id} className="rounded-lg border border-border/60 p-4 space-y-4">
              {/* Nombre + rol */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className={LBL}>Nombre</Label>
                  <Input
                    value={stylist.name}
                    onChange={(e) => updateStylistField(stylist.id, "name", e.target.value)}
                    className="h-9"
                  />
                </div>
                {stylist.role && (
                  <div className="space-y-1.5">
                    <Label className={LBL}>Rol</Label>
                    <Input value={stylist.role} disabled className="h-9 opacity-70" />
                  </div>
                )}
              </div>

              {/* Servicios (skills) */}
              <div className="space-y-2">
                <Label className={LBL}>Servicios que realiza</Label>
                <div className="flex flex-wrap gap-1.5">
                  {stylist.skills.length === 0 && (
                    <span className="text-[12px] text-muted-foreground italic">Ningún servicio asignado</span>
                  )}
                  {stylist.skills.map((skill) => (
                    <span
                      key={skill}
                      className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-[11.5px] font-medium"
                    >
                      {skill}
                      <button
                        type="button"
                        onClick={() => removeSkill(stylist.id, skill)}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`Quitar ${skill}`}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
                {disponibles.length > 0 && (
                  <div className="flex items-center gap-2 pt-1">
                    <select
                      value=""
                      onChange={(e) => {
                        addSkill(stylist.id, e.target.value);
                        e.currentTarget.value = "";
                      }}
                      className="h-8 rounded-md border border-input bg-transparent px-2 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      <option value="">+ Añadir servicio…</option>
                      {disponibles.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <Plus size={13} className="text-muted-foreground" />
                  </div>
                )}
              </div>

              <Separator />

              {/* Horario */}
              <div className="space-y-2">
                <Label className={LBL}>Horario</Label>
                <div className="space-y-2">
                  {DIAS.map((label, idx) => {
                    const d = days[idx] ?? { abierto: false, apertura: "10:00", cierre: "19:00" };
                    return (
                      <div key={label} className="flex items-center gap-3">
                        <Switch
                          checked={d.abierto}
                          onCheckedChange={(checked) => updateDay(stylist.id, idx, { abierto: checked })}
                          aria-label={`${label} ${d.abierto ? "abierto" : "libre"}`}
                        />
                        <span
                          className={`w-24 text-[12.5px] font-medium transition-colors ${
                            d.abierto ? "text-foreground" : "text-muted-foreground"
                          }`}
                        >
                          {label}
                        </span>
                        {d.abierto ? (
                          <>
                            <TimePickerSelect
                              value={d.apertura}
                              onChange={(v) => updateDay(stylist.id, idx, { apertura: v })}
                              minuteStep={15}
                            />
                            <span className="text-[12px] text-muted-foreground">–</span>
                            <TimePickerSelect
                              value={d.cierre}
                              onChange={(v) => updateDay(stylist.id, idx, { cierre: v })}
                              minuteStep={15}
                            />
                          </>
                        ) : (
                          <span className="text-[12px] text-muted-foreground italic">Libre</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex justify-end">
                <Button size="sm" onClick={() => saveStylist(stylist.id)} disabled={savingId === stylist.id}>
                  {savingId === stylist.id && <Loader2 size={13} className="mr-1.5 animate-spin" />}
                  Guardar {stylist.name}
                </Button>
              </div>
            </div>
          );
        })}
        {stylists.length === 0 && (
          <p className="text-[12.5px] text-muted-foreground italic">No hay estilistas configuradas.</p>
        )}
      </CardContent>
    </Card>
  );
}
