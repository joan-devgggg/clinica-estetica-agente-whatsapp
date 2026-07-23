"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { CalendarX } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { WeekStrip } from "@/components/citas/week-strip";
import { AppointmentCard } from "@/components/citas/appointment-card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Cita } from "@/lib/types";
import { MOCK_CITAS } from "@/lib/mock-data";

import { API, apiHeaders } from "@/lib/api";

function getMondayOf(d: Date) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function toKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

function sortByHora(citas: Cita[]) {
  return [...citas].sort((a, b) =>
    (a.hora_cita ?? "").localeCompare(b.hora_cita ?? "")
  );
}

export default function CitasPage() {
  const [weekStart, setWeekStart] = useState(() => getMondayOf(new Date()));
  const [selectedDate, setSelectedDate] = useState(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
  });
  const [allCitas, setAllCitas] = useState<Cita[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  const fetchCitas = useCallback(async () => {
    setLoading(true);
    try {
      const desde = toKey(weekStart);
      const hasta = toKey(addDays(weekStart, 6));
      const res = await fetch(`${API}/api/citas?desde=${desde}&hasta=${hasta}`, { headers: apiHeaders() });
      if (!res.ok) throw new Error("API no disponible");
      setAllCitas(await res.json());
    } catch {
      const desde = toKey(weekStart);
      const hasta = toKey(addDays(weekStart, 6));
      setAllCitas(
        MOCK_CITAS.filter(
          (c) => c.fecha_cita && c.fecha_cita >= desde && c.fecha_cita <= hasta
        )
      );
    } finally {
      setLoading(false);
    }
  }, [weekStart]);

  useEffect(() => {
    fetchCitas();
  }, [fetchCitas]);

  // Realtime: actualizar agenda cuando el bot confirma o cambia una cita
  useEffect(() => {
    const channel = supabase
      .channel("citas-page")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "appointments" },
        () => { fetchCitas(); }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "contacts" },
        () => { fetchCitas(); }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Agrupar por fecha
  const citasByDate = allCitas.reduce<Record<string, number>>((acc, c) => {
    if (c.fecha_cita) acc[c.fecha_cita] = (acc[c.fecha_cita] ?? 0) + 1;
    return acc;
  }, {});

  const selectedKey = toKey(selectedDate);
  const citasDelDia = sortByHora(
    allCitas.filter((c) => c.fecha_cita === selectedKey)
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
      <PageHeader title="Citas" subtitle="Agenda" />
      <div className="flex-1 flex flex-col overflow-hidden">
        <WeekStrip
          weekStart={weekStart}
          selectedDate={selectedDate}
          citasByDate={citasByDate}
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
            ) : citasDelDia.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <CalendarX
                  size={36}
                  strokeWidth={1.25}
                  className="text-muted-foreground/40"
                />
                <p className="font-heading text-[16px] font-semibold text-foreground/60">
                  {isFuture ? "Sin citas programadas" : "Sin citas este día"}
                </p>
                <p className="text-[12px] text-muted-foreground">
                  {isFuture
                    ? "El bot agenda automáticamente desde WhatsApp"
                    : "No hay registros para esta fecha"}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {citasDelDia.map((cita) => (
                  <AppointmentCard key={cita.id} cita={cita} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
