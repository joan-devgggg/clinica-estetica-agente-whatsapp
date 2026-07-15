"use client";

import { Card } from "@/components/ui/card";
import type { Stylist, Reserva, ScheduleBlock, StylistSchedule, BlockedDay } from "@/lib/types";
import { ymd, parseYmd, addDays, madridDateKey, madridTime } from "@/lib/date";

interface StylistAgendaProps {
  weekStart: string;
  appointments: Reserva[];
  blocks: ScheduleBlock[];
  blockedDays?: BlockedDay[];
  schedule: StylistSchedule[];
  stylist: Stylist;
  onBlockClick?: (block: ScheduleBlock) => void;
  onAppointmentClick?: (appointment: Reserva) => void;
}

const DAY_NAMES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const SLOT_MIN = 30;
const START_MIN = 10 * 60;   // 10:00
const END_MIN = 19 * 60;     // 19:00
const TOTAL_SLOTS = (END_MIN - START_MIN) / SLOT_MIN; // 18 slots (10:00…18:30)
const SLOTS = Array.from({ length: TOTAL_SLOTS }, (_, i) => START_MIN + i * SLOT_MIN);

// El esquema usa day_of_week 0 = Lunes … 6 = Domingo, weekStart es siempre un lunes.
function getWeekDays(weekStart: string, schedule: StylistSchedule[]) {
  const start = parseYmd(weekStart);
  const todayKey = ymd(new Date());
  const byDow = new Map(schedule.map((r) => [r.day_of_week, r]));
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(start, i);
    const key = ymd(d);
    const row = byDow.get(i);
    const parseMin = (t: string) => {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + m;
    };
    return {
      date: key,
      dayName: DAY_NAMES[i],
      dayNum: d.getDate(),
      isToday: key === todayKey,
      worksStart: row ? parseMin(row.start_time) : null,
      worksEnd: row ? parseMin(row.end_time) : null,
    };
  });
}

function getApptGridRow(appt: Reserva) {
  if (!appt.hora_cita) return null;
  const [h, m] = appt.hora_cita.split(":").map(Number);
  const startMin = h * 60 + m;
  const startSlot = Math.max(0, Math.floor((startMin - START_MIN) / SLOT_MIN));
  if (startSlot >= TOTAL_SLOTS) return null;
  const duration =
    appt.ends_at && appt.starts_at
      ? (new Date(appt.ends_at).getTime() - new Date(appt.starts_at).getTime()) / 60000
      : 60;
  const span = Math.max(1, Math.round(duration / SLOT_MIN));
  return { startSlot, span };
}

function getBlockGridRow(block: ScheduleBlock, dateStr: string) {
  const s = new Date(block.starts_at);
  const e = new Date(block.ends_at);
  const startMin =
    madridDateKey(block.starts_at) === dateStr ? s.getHours() * 60 + s.getMinutes() : START_MIN;
  const endMin =
    madridDateKey(block.ends_at) === dateStr ? e.getHours() * 60 + e.getMinutes() : END_MIN;
  const startSlot = Math.max(0, Math.floor((startMin - START_MIN) / SLOT_MIN));
  const endSlot = Math.min(TOTAL_SLOTS, Math.ceil((endMin - START_MIN) / SLOT_MIN));
  return { startSlot, span: Math.max(1, endSlot - startSlot) };
}

const MOTIVO_LABELS: Record<string, string> = {
  vacaciones: "Vacaciones",
  festivo: "Festivo",
  cierre: "Cierre",
  otro: "Bloqueado",
};

export function StylistAgenda({
  weekStart,
  appointments,
  blocks,
  blockedDays = [],
  schedule,
  stylist: _stylist,
  onBlockClick,
  onAppointmentClick,
}: StylistAgendaProps) {
  const days = getWeekDays(weekStart, schedule);
  const blockedDateSet = new Set(blockedDays.map((b) => b.fecha));
  const blockedByDate = new Map<string, BlockedDay>();
  for (const b of blockedDays) {
    if (!blockedByDate.has(b.fecha)) blockedByDate.set(b.fecha, b);
  }

  return (
    <Card className="border-border/60 shadow-sm overflow-hidden">
      <div
        className="grid text-xs"
        style={{
          gridTemplateColumns: "60px repeat(7, 1fr)",
          gridTemplateRows: `auto repeat(${TOTAL_SLOTS}, 28px)`,
        }}
      >
        {/* ── Row 1: cabecera ───────────────────────────────────── */}
        <div className="border-b border-r border-border bg-muted/50 px-2 py-2" />
        {days.map((day) => {
          const libra = day.worksStart === null;
          const blocked = blockedDateSet.has(day.date);
          const info = blockedByDate.get(day.date);
          return (
            <div
              key={day.date}
              className={`border-b border-r border-border px-2 py-2 text-center ${
                blocked
                  ? "bg-destructive/10"
                  : libra
                  ? "bg-muted/30"
                  : day.isToday
                  ? "bg-primary/90 font-semibold"
                  : "bg-muted/50"
              }`}
            >
              <p
                className={
                  day.isToday && !blocked && !libra
                    ? "text-primary-foreground/80"
                    : "text-muted-foreground"
                }
              >
                {day.dayName}
              </p>
              <p
                className={`text-lg font-semibold ${
                  blocked
                    ? "text-destructive"
                    : libra
                    ? "text-muted-foreground/50"
                    : day.isToday
                    ? "text-primary-foreground"
                    : "text-foreground"
                }`}
              >
                {day.dayNum}
              </p>
              {blocked && (
                <p className="text-[9px] uppercase tracking-wider text-destructive/80">
                  {MOTIVO_LABELS[info?.motivo ?? ""] ?? info?.motivo ?? "Bloqueado"}
                </p>
              )}
              {!blocked && libra && (
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground/60">
                  Libra
                </p>
              )}
            </div>
          );
        })}

        {/* ── Columna de horas (col 1, filas 2…TOTAL_SLOTS+1) ─── */}
        {SLOTS.map((slotMin, si) => {
          const h = Math.floor(slotMin / 60);
          const m = slotMin % 60;
          const isHour = m === 0;
          return (
            <div
              key={slotMin}
              style={{ gridColumn: 1, gridRow: si + 2 }}
              className={`border-r border-border px-2 bg-muted/30 flex items-start justify-end pt-0.5 ${
                isHour
                  ? "border-b border-border text-muted-foreground text-[11px]"
                  : "border-b border-border/30 text-muted-foreground/40 text-[9px]"
              }`}
            >
              {isHour ? `${String(h).padStart(2, "0")}:00` : `:30`}
            </div>
          );
        })}

        {/* ── Celdas de fondo (cols 2-8, filas 2…TOTAL_SLOTS+1) ── */}
        {SLOTS.map((slotMin, si) =>
          days.map((day, di) => {
            const isBlocked = blockedDateSet.has(day.date);
            const offSlot =
              day.worksStart === null ||
              day.worksEnd === null ||
              slotMin < day.worksStart ||
              slotMin >= day.worksEnd;
            const isHour = slotMin % 60 === 0;
            return (
              <div
                key={`bg-${slotMin}-${day.date}`}
                style={{ gridColumn: di + 2, gridRow: si + 2 }}
                className={`border-r border-border ${
                  isHour ? "border-b border-border" : "border-b border-border/30"
                } ${
                  isBlocked
                    ? "bg-destructive/8 bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,rgba(220,38,38,0.06)_6px,rgba(220,38,38,0.06)_12px)]"
                    : offSlot
                    ? "bg-muted/40 bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,rgba(0,0,0,0.03)_6px,rgba(0,0,0,0.03)_12px)]"
                    : ""
                }`}
              />
            );
          })
        )}

        {/* ── Etiqueta de día bloqueado (centrada en la columna) ── */}
        {days.map((day, di) => {
          if (!blockedDateSet.has(day.date)) return null;
          const info = blockedByDate.get(day.date);
          return (
            <div
              key={`blocked-label-${day.date}`}
              style={{
                gridColumn: di + 2,
                gridRow: `2 / span ${TOTAL_SLOTS}`,
                zIndex: 2,
                pointerEvents: "none",
              }}
              className="flex items-center justify-center"
            >
              <span className="text-[10px] text-destructive/60 uppercase tracking-wider font-medium">
                {MOTIVO_LABELS[info?.motivo ?? ""] ?? info?.motivo ?? "Bloqueado"}
              </span>
            </div>
          );
        })}

        {/* ── Bloqueos de horario ──────────────────────────────── */}
        {days.map((day, di) =>
          blocks
            .filter((b) => {
              const bStart = madridDateKey(b.starts_at);
              const bEnd = madridDateKey(b.ends_at);
              return bStart <= day.date && bEnd >= day.date;
            })
            .map((b) => {
              const pos = getBlockGridRow(b, day.date);
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onBlockClick?.(b)}
                  title="Eliminar bloqueo"
                  style={{
                    gridColumn: di + 2,
                    gridRow: `${pos.startSlot + 2} / span ${pos.span}`,
                    zIndex: 5,
                  }}
                  className="bg-muted/60 border border-dashed border-muted-foreground/30 flex items-center justify-center cursor-pointer hover:bg-destructive/15 hover:border-destructive/40 transition-colors"
                >
                  <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                    {b.reason || "Bloqueado"}
                  </span>
                </button>
              );
            })
        )}

        {/* ── Citas (spanning por duración real) ──────────────── */}
        {days.map((day, di) =>
          appointments
            .filter((a) => a.fecha_cita === day.date)
            .map((a) => {
              const pos = getApptGridRow(a);
              if (!pos) return null;
              return (
                <button
                  key={a.appointment_id}
                  type="button"
                  onClick={() => onAppointmentClick?.(a)}
                  style={{
                    gridColumn: di + 2,
                    gridRow: `${pos.startSlot + 2} / span ${pos.span}`,
                    zIndex: 10,
                  }}
                  className="bg-primary/15 border border-primary/30 rounded mx-0.5 px-1 py-0.5 text-[10px] leading-tight overflow-hidden text-left cursor-pointer hover:bg-primary/25 hover:border-primary/50 transition-colors"
                >
                  <p className="font-medium text-primary truncate">{a.nombre}</p>
                  <p className="text-muted-foreground truncate">{a.service || "Cita"}</p>
                  {a.starts_at && a.ends_at && (
                    <p className="text-[9px] text-muted-foreground/60 truncate">
                      {madridTime(a.starts_at)} – {madridTime(a.ends_at)}
                    </p>
                  )}
                </button>
              );
            })
        )}
      </div>
    </Card>
  );
}
