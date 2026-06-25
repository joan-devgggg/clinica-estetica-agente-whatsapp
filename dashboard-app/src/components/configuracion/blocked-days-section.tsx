"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarOff, Plus, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { API, apiHeaders } from "@/lib/api";
import {
  getBlockedDays,
  createBlockedDay,
  deleteBlockedDay,
} from "@/lib/blocked-days";
import type { BlockedDay } from "@/lib/types";

interface Stylist {
  id: string;
  name: string;
}

const MOTIVOS = [
  { value: "vacaciones", label: "Vacaciones" },
  { value: "festivo", label: "Festivo" },
  { value: "cierre", label: "Cierre" },
  { value: "otro", label: "Otro" },
];

const LBL =
  "text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground";

function formatFecha(fecha: string): string {
  const d = new Date(fecha + "T12:00:00");
  return d.toLocaleDateString("es-ES", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function motivoLabel(motivo: string): string {
  return MOTIVOS.find((m) => m.value === motivo)?.label ?? motivo;
}

export function BlockedDaysSection({ orgId }: { orgId: string }) {
  const [blocks, setBlocks] = useState<BlockedDay[]>([]);
  const [stylists, setStylists] = useState<Stylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [fecha, setFecha] = useState("");
  const [motivo, setMotivo] = useState("vacaciones");
  const [stylistId, setStylistId] = useState("");

  const load = useCallback(async () => {
    try {
      const [b, sRes] = await Promise.all([
        getBlockedDays(orgId),
        fetch(`${API}/api/stylists`, { headers: apiHeaders(orgId) }),
      ]);
      setBlocks(b);
      if (sRes.ok) setStylists(await sRes.json());
    } catch {
      toast.error("Error cargando datos");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = async () => {
    if (!fecha) {
      toast.error("Selecciona una fecha");
      return;
    }
    setSaving(true);
    try {
      await createBlockedDay(orgId, {
        fecha,
        motivo,
        stylistId: stylistId || null,
      });
      toast.success("Día bloqueado correctamente");
      setFecha("");
      setMotivo("vacaciones");
      setStylistId("");
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Error creando bloqueo");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteBlockedDay(orgId, id);
      setBlocks((prev) => prev.filter((b) => b.id !== id));
      toast.success("Bloqueo eliminado");
    } catch {
      toast.error("Error eliminando bloqueo");
    }
  };

  const stylistName = (id: string | null) => {
    if (!id) return "Todo el salón";
    return stylists.find((s) => s.id === id)?.name ?? "Estilista";
  };

  const today = new Date().toISOString().slice(0, 10);

  return (
    <Card className="border-border/60 shadow-sm">
      <CardHeader className="pb-2 pt-5 px-5">
        <div className="flex items-center gap-2">
          <CalendarOff size={14} className="text-muted-foreground" />
          <span className={LBL}>Días bloqueados</span>
        </div>
      </CardHeader>

      <CardContent className="px-5 pb-5 space-y-5">
        {/* Add form */}
        <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end">
          <div>
            <Label className={LBL}>Fecha</Label>
            <Input
              type="date"
              className="h-9 text-[13px] mt-1"
              value={fecha}
              min={today}
              onChange={(e) => setFecha(e.target.value)}
            />
          </div>
          <div>
            <Label className={LBL}>Motivo</Label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-[13px] mt-1 focus:outline-none focus:ring-1 focus:ring-ring"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            >
              {MOTIVOS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className={LBL}>Aplica a</Label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-[13px] mt-1 focus:outline-none focus:ring-1 focus:ring-ring"
              value={stylistId}
              onChange={(e) => setStylistId(e.target.value)}
            >
              <option value="">Todo el salón</option>
              {stylists.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            className="h-9 gap-1.5"
            onClick={handleAdd}
            disabled={saving || !fecha}
          >
            {saving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
            Añadir
          </Button>
        </div>

        {/* List */}
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={18} className="animate-spin text-muted-foreground" />
          </div>
        ) : blocks.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground text-center py-4">
            No hay días bloqueados programados
          </p>
        ) : (
          <div className="space-y-1.5">
            {blocks.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-[13px] font-medium shrink-0">
                    {formatFecha(b.fecha)}
                  </span>
                  <span className="text-[11.5px] text-muted-foreground px-2 py-0.5 bg-muted rounded-full shrink-0">
                    {motivoLabel(b.motivo)}
                  </span>
                  <span className="text-[11.5px] text-muted-foreground truncate">
                    {stylistName(b.stylist_id)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => handleDelete(b.id)}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
