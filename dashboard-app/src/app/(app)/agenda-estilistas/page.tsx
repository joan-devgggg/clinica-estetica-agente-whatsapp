"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { PageHeader } from "@/components/layout/page-header";
import { StylistAgenda } from "@/components/agenda/stylist-agenda";
import { CreateAppointmentDialog } from "@/components/agenda/create-appointment-dialog";
import { CreateBlockDialog } from "@/components/agenda/create-block-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, Plus, Ban } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/lib/org-context";
import { API, apiHeaders } from "@/lib/api";
import { ymd } from "@/lib/date";
import type { Stylist, Reserva, ScheduleBlock, StylistSchedule, BlockedDay } from "@/lib/types";

function getWeekRange(offset: number) {
  const now = new Date();
  const day = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + 1 + offset * 7);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return {
    start: ymd(monday),
    end: ymd(sunday),
    label: `${monday.toLocaleDateString("es-ES", { day: "numeric", month: "short" })} — ${sunday.toLocaleDateString("es-ES", { day: "numeric", month: "short" })}`,
  };
}

export default function AgendaEstilistasPage() {
  const [stylists, setStylists] = useState<Stylist[]>([]);
  const [appointments, setAppointments] = useState<Reserva[]>([]);
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([]);
  const [blockedDays, setBlockedDays] = useState<BlockedDay[]>([]);
  const [schedule, setSchedule] = useState<StylistSchedule[]>([]);
  const [activeStylistId, setActiveStylistId] = useState<string>("");
  const [weekOffset, setWeekOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showNewAppt, setShowNewAppt] = useState(false);
  const [showNewBlock, setShowNewBlock] = useState(false);
  const [blockToDelete, setBlockToDelete] = useState<ScheduleBlock | null>(null);
  const [deletingBlock, setDeletingBlock] = useState(false);

  const { orgId } = useOrg();
  const supabase = createClient();
  const week = getWeekRange(weekOffset);

  const loadData = useCallback(async () => {
    if (!orgId) return;
    try {
      const [styRes, apptRes, bdRes] = await Promise.all([
        fetch(`${API}/api/stylists`, { headers: apiHeaders(orgId) }),
        fetch(`${API}/api/citas?desde=${week.start}&hasta=${week.end}`, { headers: apiHeaders(orgId) }),
        fetch(`${API}/api/blocked-days?from=${week.start}&to=${week.end}`, { headers: apiHeaders(orgId) }),
      ]);

      const styData: Stylist[] = styRes.ok ? await styRes.json() : [];
      const apptData: Reserva[] = apptRes.ok ? await apptRes.json() : [];
      const bdData: BlockedDay[] = bdRes.ok ? await bdRes.json() : [];

      setStylists(styData);
      setAppointments(apptData);
      setBlockedDays(bdData);

      if (!activeStylistId && styData.length > 0) {
        setActiveStylistId(styData[0].id);
      }

      if (activeStylistId) {
        const [blockRes, schedRes] = await Promise.all([
          fetch(
            `${API}/api/schedule-blocks?stylistId=${activeStylistId}&desde=${week.start}&hasta=${week.end}`,
            { headers: apiHeaders(orgId) }
          ),
          fetch(`${API}/api/stylist-schedule/${activeStylistId}`, { headers: apiHeaders(orgId) }),
        ]);
        setBlocks(blockRes.ok ? await blockRes.json() : []);
        setSchedule(schedRes.ok ? await schedRes.json() : []);
      }
    } catch {
      toast.error("Error cargando la agenda");
    } finally {
      setLoading(false);
    }
  }, [orgId, week.start, week.end, activeStylistId]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const channel = supabase
      .channel("agenda-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments" }, () => { loadData(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "blocked_days" }, () => { loadData(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "schedule_blocks" }, () => { loadData(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeStylist = stylists.find(s => s.id === activeStylistId);
  const stylistAppointments = appointments.filter(a => a.stylist_id === activeStylistId);
  const stylistBlockedDays = blockedDays.filter(b => !b.stylist_id || b.stylist_id === activeStylistId);

  async function handleDeleteBlock() {
    if (!blockToDelete) return;
    setDeletingBlock(true);
    try {
      const res = await fetch(`${API}/api/schedule-blocks/${blockToDelete.id}`, {
        method: "DELETE",
        headers: apiHeaders(orgId),
      });
      if (!res.ok) throw new Error();
      toast.success("Bloqueo eliminado");
      setBlockToDelete(null);
      loadData();
    } catch {
      toast.error("Error al eliminar el bloqueo");
    } finally {
      setDeletingBlock(false);
    }
  }

  return (
    <>
      <PageHeader title="Agenda estilistas" subtitle="Vista semanal por estilista" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-6 py-6 space-y-4">
          {/* Week navigation */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" onClick={() => setWeekOffset(w => w - 1)}>
                <ChevronLeft size={16} />
              </Button>
              <span className="text-sm font-medium min-w-[180px] text-center">
                {week.label}
              </span>
              <Button variant="outline" size="icon" onClick={() => setWeekOffset(w => w + 1)}>
                <ChevronRight size={16} />
              </Button>
              {weekOffset !== 0 && (
                <Button variant="ghost" size="sm" onClick={() => setWeekOffset(0)}>
                  Hoy
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowNewBlock(true)}>
                <Ban size={14} className="mr-1.5" />
                Bloquear hueco
              </Button>
              <Button size="sm" onClick={() => setShowNewAppt(true)}>
                <Plus size={14} className="mr-1.5" />
                Nueva cita
              </Button>
            </div>
          </div>

          {/* Stylist tabs */}
          {loading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <div className="flex gap-1 border-b border-border pb-1 overflow-x-auto">
              {stylists.map(s => (
                <button
                  key={s.id}
                  onClick={() => setActiveStylistId(s.id)}
                  className={`px-4 py-2 text-sm font-medium rounded-t-lg whitespace-nowrap transition-colors ${
                    s.id === activeStylistId
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}

          {/* Weekly grid */}
          {loading ? (
            <Skeleton className="h-[500px] w-full rounded-lg" />
          ) : activeStylist ? (
            <StylistAgenda
              weekStart={week.start}
              appointments={stylistAppointments}
              blocks={blocks}
              blockedDays={stylistBlockedDays}
              schedule={schedule}
              stylist={activeStylist}
              onBlockClick={setBlockToDelete}
            />
          ) : (
            <p className="text-center text-muted-foreground py-12">No hay estilistas configuradas</p>
          )}
        </div>
      </div>

      {showNewAppt && (
        <CreateAppointmentDialog
          stylists={stylists}
          orgId={orgId}
          defaultStylistId={activeStylistId}
          onClose={() => setShowNewAppt(false)}
          onCreated={() => { setShowNewAppt(false); loadData(); }}
        />
      )}

      {showNewBlock && (
        <CreateBlockDialog
          stylists={stylists}
          orgId={orgId}
          defaultStylistId={activeStylistId}
          onClose={() => setShowNewBlock(false)}
          onCreated={() => { setShowNewBlock(false); loadData(); }}
        />
      )}

      <Dialog open={!!blockToDelete} onOpenChange={(open) => { if (!open) setBlockToDelete(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Eliminar bloqueo</DialogTitle>
            <DialogDescription>
              {blockToDelete && (() => {
                const start = new Date(blockToDelete.starts_at);
                const end = new Date(blockToDelete.ends_at);
                const fecha = start.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
                const hi = start.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
                const hf = end.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
                return (
                  <>
                    Se liberará el hueco del {fecha} de {hi} a {hf}
                    {blockToDelete.reason ? ` (${blockToDelete.reason})` : ""}. Esta acción no se puede deshacer.
                  </>
                );
              })()}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setBlockToDelete(null)} disabled={deletingBlock}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={handleDeleteBlock} disabled={deletingBlock}>
              {deletingBlock ? "Eliminando..." : "Eliminar bloqueo"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
