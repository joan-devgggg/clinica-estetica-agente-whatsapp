"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { CalendarX } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { WeekStrip } from "@/components/reservas/week-strip";
import { ReservaCard } from "@/components/reservas/reserva-card";
import { AppointmentEditSheet } from "@/components/reservas/appointment-edit-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { Reserva, Stylist } from "@/lib/types";
import { useOrg } from "@/lib/org-context";
import { ymd as toKey, addDays, getMondayOf } from "@/lib/date";

import { API, apiHeaders } from "@/lib/api";

function sortByHora(reservas: Reserva[]) {
  return [...reservas].sort((a, b) =>
    (a.hora_cita ?? "").localeCompare(b.hora_cita ?? "")
  );
}

export default function ReservasPage() {
  const [weekStart, setWeekStart] = useState(() => getMondayOf(new Date()));
  const [selectedDate, setSelectedDate] = useState(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
  });
  const [allReservas, setAllReservas] = useState<Reserva[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editReserva, setEditReserva] = useState<Reserva | null>(null);
  const [stylists, setStylists] = useState<Stylist[]>([]);
  // Memoizado: createClient() en cada render creaba un socket realtime nuevo cada vez y los
  // canales quedaban huérfanos → el panel no refrescaba en tiempo real al borrar/cambiar citas.
  const [supabase] = useState(() => createClient());
  const { orgId, orgType } = useOrg();

  const fetchReservas = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const desde = toKey(weekStart);
      const hasta = toKey(addDays(weekStart, 6));
      const res = await fetch(`${API}/api/citas?desde=${desde}&hasta=${hasta}`, { headers: await apiHeaders(orgId) });
      if (!res.ok) {
        if (res.status === 401) throw new Error("401 — sesión no autorizada (el token no llegó o caducó). Cierra sesión y vuelve a entrar.");
        if (res.status === 403) throw new Error("403 — sin permiso para esta organización.");
        throw new Error(`La API respondió ${res.status}. Inténtalo de nuevo o revisa el servidor.`);
      }
      setAllReservas(await res.json());
      setError(null);
    } catch (err) {
      // Antes se tragaba el error y se veía "Sin reservas este día", indistinguible
      // de un día realmente vacío. Ahora dejamos el motivo visible.
      setError(
        err instanceof Error && err.message !== "Failed to fetch"
          ? err.message
          : "No se pudo contactar con la API (fallo de red o servidor caído)."
      );
      setAllReservas([]);
    } finally {
      setLoading(false);
    }
  }, [weekStart, orgId]);

  useEffect(() => {
    fetchReservas();
  }, [fetchReservas]);

  useEffect(() => {
    if (!orgId || orgType !== "salon") return;
    (async () => {
      try {
        const r = await fetch(`${API}/api/stylists`, { headers: await apiHeaders(orgId) });
        setStylists(r.ok ? await r.json() : []);
      } catch {
        /* noop */
      }
    })();
  }, [orgId, orgType]);

  // Realtime: actualizar agenda cuando el bot confirma o cambia una reserva
  useEffect(() => {
    const channel = supabase
      .channel("reservas-page")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "appointments" },
        () => { fetchReservas(); }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "contacts" },
        () => { fetchReservas(); }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Agrupar por fecha
  const reservasByDate = allReservas.reduce<Record<string, number>>((acc, r) => {
    if (r.fecha_cita) acc[r.fecha_cita] = (acc[r.fecha_cita] ?? 0) + 1;
    return acc;
  }, {});

  const selectedKey = toKey(selectedDate);
  const reservasDelDia = sortByHora(
    allReservas.filter((r) => r.fecha_cita === selectedKey)
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isToday = selectedKey === toKey(today);
  const isFuture = selectedDate > today;

  const sectionLabel = isToday
    ? "Hoy"
    : selectedDate.toLocaleDateString("es-ES", {
        weekday: "long",
        day: "numeric",
        month: "long",
      });

  return (
    <>
      <PageHeader
        title={orgType === "salon" ? "Citas" : "Reservas"}
        subtitle={orgType === "salon" ? "Agenda del salón" : "Agenda de mesas"}
      />
      <div className="flex-1 flex flex-col overflow-hidden">
        <WeekStrip
          weekStart={weekStart}
          selectedDate={selectedDate}
          citasByDate={reservasByDate}
          onSelectDate={setSelectedDate}
          onPrevWeek={() => setWeekStart((w) => addDays(w, -7))}
          onNextWeek={() => setWeekStart((w) => addDays(w, 7))}
        />

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-6 py-6">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-4 capitalize">
              {sectionLabel}
            </p>

            {loading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-20 w-full rounded-lg" />
                ))}
              </div>
            ) : error ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px] text-destructive"
              >
                No se pudieron cargar las citas. {error}
              </div>
            ) : reservasDelDia.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <CalendarX
                  size={36}
                  strokeWidth={1.25}
                  className="text-muted-foreground/40"
                />
                <p className="font-heading text-[16px] font-semibold text-foreground/60">
                  {isFuture ? "Sin reservas programadas" : "Sin reservas este día"}
                </p>
                <p className="text-[12px] text-muted-foreground">
                  {isFuture
                    ? "El bot agenda automáticamente desde WhatsApp"
                    : "No hay registros para esta fecha"}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {reservasDelDia.map((reserva) => (
                  <ReservaCard key={reserva.appointment_id ?? reserva.id} reserva={reserva} orgType={orgType} onClick={() => setEditReserva(reserva)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <AppointmentEditSheet
        reserva={editReserva}
        open={!!editReserva}
        onClose={() => setEditReserva(null)}
        onUpdated={fetchReservas}
        orgId={orgId}
        orgType={orgType}
        stylists={stylists}
      />
    </>
  );
}
