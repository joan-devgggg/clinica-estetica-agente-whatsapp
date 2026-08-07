"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/utils/supabase/client";
import { CalendarX, Ban, Banknote } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { WeekStrip } from "@/components/reservas/week-strip";
import { ReservaCard } from "@/components/reservas/reserva-card";
import { AppointmentEditSheet } from "@/components/reservas/appointment-edit-sheet";
import { CreateBlockDialog } from "@/components/agenda/create-block-dialog";
import { CobroSheet, type CobroContexto } from "@/components/caja/cobro-sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Reserva, Stylist, ScheduleBlock } from "@/lib/types";
import { useOrg } from "@/lib/org-context";
import { leerSesion, type CajaSesion } from "@/lib/caja-session";
import { ymd as toKey, addDays, getMondayOf, madridDateKey, madridTime } from "@/lib/date";

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
  // Los bloqueos se pintan AQUÍ, no solo en Agenda por estilistas. Sin esto, un hueco cerrado
  // de verdad (schedule_blocks) es invisible en la vista donde se repasa el día, y la única
  // forma de "verlo" es crear una cita falsa — que es justo lo que hay hoy en la agenda de
  // Sante: tres citas "Cita manual" con la clienta inventada "Close TIME".
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([]);
  // Un fallo al cargar los bloqueos NO puede leerse como "no hay bloqueos": pintaría como
  // libre un hueco cerrado, que es el error más caro de esta pantalla.
  const [blocksError, setBlocksError] = useState<string | null>(null);
  const [showNewBlock, setShowNewBlock] = useState(false);
  // Cobrar desde la cita que ya tienes delante. Es la MISMA hoja que /caja: obligar a cambiar
  // de pantalla para cobrar a quien está en el mostrador es justo el "buscarlo" que sobra.
  const [cobro, setCobro] = useState<CobroContexto | null>(null);
  const [sesionCaja, setSesionCaja] = useState<CajaSesion | null>(null);
  useEffect(() => { setSesionCaja(leerSesion()); }, []);
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

  // Solo salón: los bloqueos cuelgan de `stylists`, y San Remo no tiene. Regla de oro.
  const fetchBlocks = useCallback(async () => {
    if (!orgId || orgType !== "salon") return;
    try {
      // La ventana se pide con UN DÍA DE MARGEN a cada lado, y el reparto por día lo hace
      // después `madridDateKey`. El endpoint compara contra `timestamptz`, así que un
      // 'YYYY-MM-DD' pelado se interpreta en la zona de la BD (UTC) y no en Madrid: en verano
      // eso son 2 h de desfase y un bloqueo a primera hora del lunes se quedaría fuera. Con
      // margen, el filtro del servidor solo acota y el que decide el día es el cliente.
      const desde = toKey(addDays(weekStart, -1));
      const hasta = toKey(addDays(weekStart, 7));
      const res = await fetch(`${API}/api/schedule-blocks?desde=${desde}&hasta=${hasta}`, {
        headers: await apiHeaders(orgId),
      });
      if (!res.ok) throw new Error(`La API respondió ${res.status}`);
      setBlocks(await res.json());
      setBlocksError(null);
    } catch (err) {
      // Ver el comentario de blocksError: aquí NO se hace `setBlocks([])` y se calla.
      setBlocksError(err instanceof Error ? err.message : "fallo de red");
    }
  }, [weekStart, orgId, orgType]);

  useEffect(() => {
    fetchReservas();
  }, [fetchReservas]);

  useEffect(() => {
    fetchBlocks();
  }, [fetchBlocks]);

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

  // El canal de realtime se monta UNA vez (deps []) para no dejar canales huérfanos, así que
  // sus handlers capturarían las funciones del primer render — las de la semana inicial. Con
  // el canal vivo y la vista en otra semana, un evento recargaba y pintaba los datos de la
  // semana equivocada. Las refs mantienen apuntando siempre a la última versión sin volver a
  // suscribirse. (Ya pasaba con las reservas; se arregla igual para las dos.)
  const fetchReservasRef = useRef(fetchReservas);
  const fetchBlocksRef = useRef(fetchBlocks);
  useEffect(() => {
    fetchReservasRef.current = fetchReservas;
    fetchBlocksRef.current = fetchBlocks;
  }, [fetchReservas, fetchBlocks]);

  // El importe de referencia lo resuelve el SERVIDOR (misma precedencia que Facturación), así
  // que se pide al abrir en vez de calcularlo aquí: el panel enseña cifras, no las decide.
  // Se pide solo al pulsar Cobrar — no en cada cambio de semana.
  async function abrirCobro(reserva: Reserva) {
    const base: CobroContexto = {
      appointmentId: reserva.appointment_id,
      cliente: reserva.nombre,
      service: reserva.service,
      atendio: reserva.stylist_name ?? null,
      importeReferencia: null,
    };
    try {
      const res = await fetch(`${API}/api/caja/pendientes?fecha=${reserva.fecha_cita}`, {
        headers: await apiHeaders(orgId),
      });
      if (res.ok) {
        const { citas } = await res.json();
        const encontrada = (citas ?? []).find(
          (c: { appointment_id: string }) => c.appointment_id === reserva.appointment_id,
        );
        if (encontrada) base.importeReferencia = encontrada.importe_referencia ?? null;
      }
    } catch {
      // Sin referencia se cobra igual: se teclea el importe. Nunca se bloquea el cobro.
    }
    setCobro(base);
  }

  // Realtime: actualizar agenda cuando el bot confirma o cambia una reserva
  useEffect(() => {
    const channel = supabase
      .channel("reservas-page")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "appointments" },
        () => { fetchReservasRef.current(); }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "contacts" },
        () => { fetchReservasRef.current(); }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "schedule_blocks" },
        () => { fetchBlocksRef.current(); }
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

  // El día de un bloqueo se decide en Europe/Madrid a partir del instante, igual que en el
  // resto del panel: `starts_at` es un timestamptz y partirlo por UTC desplazaría el día.
  const nombrePorEstilista = new Map(stylists.map((s) => [s.id, s.name]));
  const bloqueosDelDia = blocks
    .filter((b) => madridDateKey(b.starts_at) === selectedKey)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));

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
      >
        {/* Cerrar un hueco tiene que poder hacerse desde donde se repasa el día. Reutiliza el
            diálogo que ya existe en Agenda por estilistas: mismo endpoint, misma validación. */}
        {orgType === "salon" && (
          <Button size="sm" variant="outline" onClick={() => setShowNewBlock(true)}>
            <Ban size={14} className="mr-1.5" />
            Bloquear hueco
          </Button>
        )}
      </PageHeader>
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
            ) : reservasDelDia.length === 0 && bloqueosDelDia.length === 0 ? (
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
                  <div key={reserva.appointment_id ?? reserva.id} className="space-y-1.5">
                    <ReservaCard reserva={reserva} orgType={orgType} onClick={() => setEditReserva(reserva)} />
                    {orgType === "salon" && reserva.appointment_id && reserva.estado_cita !== "cancelled" && (
                      <div className="flex justify-end">
                        <Button size="sm" variant="ghost" onClick={() => abrirCobro(reserva)}>
                          <Banknote size={14} className="mr-1.5" />
                          Cobrar
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
                {/* Un bloqueo NO es una cita y no se abre como tal: no tiene clienta, ni
                    servicio, ni importe. Se pinta aparte y sin onClick a propósito. */}
                {bloqueosDelDia.map((b) => (
                  <div
                    key={b.id}
                    className="flex items-center gap-3 rounded-lg border border-dashed border-border bg-muted/40 px-4 py-3"
                  >
                    <Ban size={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-foreground/70">
                        Hueco bloqueado · {madridTime(b.starts_at)}–{madridTime(b.ends_at)}
                      </p>
                      <p className="truncate text-[11.5px] text-muted-foreground">
                        {nombrePorEstilista.get(b.stylist_id) ?? "Estilista dada de baja"}
                        {b.reason ? ` · ${b.reason}` : ""}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Si los bloqueos no se pudieron cargar hay que DECIRLO: callarlo pintaría como
                libre un hueco que está cerrado, y esa es la confusión que se está arreglando. */}
            {blocksError && (
              <div
                role="alert"
                className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-[12px] text-amber-700 dark:text-amber-400"
              >
                No se pudieron cargar los huecos bloqueados ({blocksError}). Puede que este día
                tenga horas cerradas que no se están viendo.
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

      <CobroSheet
        key={cobro?.appointmentId ?? "ninguno"}
        contexto={cobro}
        sesion={sesionCaja}
        orgId={orgId}
        open={!!cobro}
        onClose={() => setCobro(null)}
        onCobrado={() => { setSesionCaja(leerSesion()); toast.success("Cobro registrado"); }}
      />

      {showNewBlock && (
        <CreateBlockDialog
          stylists={stylists}
          orgId={orgId}
          onClose={() => setShowNewBlock(false)}
          onCreated={() => { setShowNewBlock(false); fetchBlocks(); }}
        />
      )}
    </>
  );
}
