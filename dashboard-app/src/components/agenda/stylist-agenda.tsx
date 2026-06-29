"use client";

import { Card } from "@/components/ui/card";
import type { Stylist, Reserva, ScheduleBlock, StylistSchedule, BlockedDay } from "@/lib/types";
import { ymd, parseYmd, addDays, madridDateKey } from "@/lib/date";

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

const HOURS = Array.from({ length: 10 }, (_, i) => i + 10); // 10:00 to 19:00
const DAY_NAMES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

// El esquema usa day_of_week 0 = Lunes … 6 = Domingo, y weekStart es siempre un
// lunes, así que el índice del día (0..6) coincide con day_of_week.
function getWeekDays(weekStart: string, schedule: StylistSchedule[]) {
  const start = parseYmd(weekStart);
  const todayKey = ymd(new Date());
  const byDow = new Map(schedule.map((r) => [r.day_of_week, r]));
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(start, i);
    const key = ymd(d);
    const row = byDow.get(i);
    return {
      date: key,
      dayName: DAY_NAMES[i],
      dayNum: d.getDate(),
      isToday: key === todayKey,
      // Jornada de la estilista ese día (null = libra).
      worksStartH: row ? parseInt(row.start_time.split(":")[0]) : null,
      worksEndH: row ? parseInt(row.end_time.split(":")[0]) : null,
    };
  });
}

function timeToRow(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  return (h - 10) * 4 + Math.floor(m / 15);
}

function getApptPosition(appt: Reserva) {
  if (!appt.hora_cita) return null;
  const startRow = timeToRow(appt.hora_cita);
  const duration = appt.ends_at && appt.starts_at
    ? (new Date(appt.ends_at).getTime() - new Date(appt.starts_at).getTime()) / 60000
    : 60;
  const span = Math.max(1, Math.round(duration / 15));
  return { startRow, span };
}

function getBlockPosition(block: ScheduleBlock, dateStr: string) {
  const start = new Date(block.starts_at);
  const end = new Date(block.ends_at);
  const startH = madridDateKey(block.starts_at) === dateStr ? start.getHours() * 60 + start.getMinutes() : 600;
  const endH = madridDateKey(block.ends_at) === dateStr ? end.getHours() * 60 + end.getMinutes() : 1140;
  const startRow = Math.max(0, Math.floor((startH - 600) / 15));
  const endRow = Math.min(36, Math.ceil((endH - 600) / 15));
  return { startRow, span: endRow - startRow };
}

const MOTIVO_LABELS: Record<string, string> = {
  vacaciones: "Vacaciones",
  festivo: "Festivo",
  cierre: "Cierre",
  otro: "Bloqueado",
};

export function StylistAgenda({ weekStart, appointments, blocks, blockedDays = [], schedule, stylist, onBlockClick, onAppointmentClick }: StylistAgendaProps) {
  const days = getWeekDays(weekStart, schedule);
  const blockedDateSet = new Set(blockedDays.map(b => b.fecha));
  const blockedByDate = new Map<string, BlockedDay>();
  for (const b of blockedDays) {
    if (!blockedByDate.has(b.fecha)) blockedByDate.set(b.fecha, b);
  }

  return (
    <Card className="border-border/60 shadow-sm overflow-hidden">
      <div className="grid grid-cols-[60px_repeat(7,1fr)] text-xs">
        {/* Header row */}
        <div className="border-b border-r border-border bg-muted/50 px-2 py-2" />
        {days.map(day => {
          const libra = day.worksStartH === null;
          const blocked = blockedDateSet.has(day.date);
          const blockedInfo = blockedByDate.get(day.date);
          return (
            <div
              key={day.date}
              className={`border-b border-r border-border px-2 py-2 text-center ${
                blocked
                  ? "bg-destructive/10"
                  : libra ? "bg-muted/30" : day.isToday ? "bg-primary/90 font-semibold" : "bg-muted/50"
              }`}
            >
              <p className={day.isToday && !blocked && !libra ? "text-primary-foreground/80" : "text-muted-foreground"}>{day.dayName}</p>
              <p
                className={`text-lg font-semibold ${
                  blocked
                    ? "text-destructive"
                    : libra ? "text-muted-foreground/50" : day.isToday ? "text-primary-foreground" : "text-foreground"
                }`}
              >
                {day.dayNum}
              </p>
              {blocked && (
                <p className="text-[9px] uppercase tracking-wider text-destructive/80">
                  {MOTIVO_LABELS[blockedInfo?.motivo ?? ""] ?? blockedInfo?.motivo ?? "Bloqueado"}
                </p>
              )}
              {!blocked && libra && <p className="text-[9px] uppercase tracking-wider text-muted-foreground/60">Libra</p>}
            </div>
          );
        })}

        {/* Time grid */}
        {HOURS.map(hour => (
          <div key={hour} className="contents">
            <div className="border-r border-b border-border px-2 py-3 text-right text-muted-foreground bg-muted/30 text-[11px]">
              {String(hour).padStart(2, "0")}:00
            </div>
            {days.map(day => {
              const isBlocked = blockedDateSet.has(day.date);
              const dayBlockedInfo = blockedByDate.get(day.date);
              const dayAppts = appointments.filter(a => a.fecha_cita === day.date);
              const dayBlocks = blocks.filter(b => {
                const bStart = madridDateKey(b.starts_at);
                const bEnd = madridDateKey(b.ends_at);
                return bStart <= day.date && bEnd >= day.date;
              });

              const offHour =
                day.worksStartH === null ||
                day.worksEndH === null ||
                hour < day.worksStartH ||
                hour >= day.worksEndH;

              return (
                <div
                  key={day.date}
                  className={`border-r border-b border-border relative h-14 ${
                    isBlocked
                      ? "bg-destructive/8 bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,rgba(220,38,38,0.06)_6px,rgba(220,38,38,0.06)_12px)]"
                      : offHour ? "bg-muted/40 bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,rgba(0,0,0,0.03)_6px,rgba(0,0,0,0.03)_12px)]" : ""
                  }`}
                >
                  {isBlocked ? (
                    <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
                      {hour === HOURS[0] && (
                        <span className="text-[10px] text-destructive/60 uppercase tracking-wider font-medium">
                          {MOTIVO_LABELS[dayBlockedInfo?.motivo ?? ""] ?? dayBlockedInfo?.motivo ?? "Bloqueado"}
                        </span>
                      )}
                    </div>
                  ) : (
                    <>
                      {dayAppts
                        .filter(a => {
                          if (!a.hora_cita) return false;
                          const apptHour = parseInt(a.hora_cita.split(":")[0]);
                          return apptHour === hour;
                        })
                        .map(a => {
                          const pos = getApptPosition(a);
                          if (!pos) return null;
                          return (
                            <button
                              type="button"
                              key={a.appointment_id}
                              onClick={() => onAppointmentClick?.(a)}
                              className="absolute inset-x-0.5 bg-primary/15 border border-primary/30 rounded px-1 py-0.5 text-[10px] leading-tight overflow-hidden z-10 text-left cursor-pointer hover:bg-primary/25 hover:border-primary/50 transition-colors"
                              style={{ top: 0, minHeight: "100%" }}
                            >
                              <p className="font-medium text-primary truncate">{a.nombre}</p>
                              <p className="text-muted-foreground truncate">{a.service || "Cita"}</p>
                            </button>
                          );
                        })}

                      {dayBlocks
                        .filter(b => {
                          const start = new Date(b.starts_at);
                          const end = new Date(b.ends_at);
                          const blockStartH = madridDateKey(b.starts_at) === day.date ? start.getHours() : 0;
                          const blockEndH = madridDateKey(b.ends_at) === day.date ? end.getHours() : 24;
                          return hour >= blockStartH && hour < blockEndH;
                        })
                        .map(b => (
                          <button
                            key={b.id}
                            type="button"
                            onClick={() => onBlockClick?.(b)}
                            title="Eliminar bloqueo"
                            className="absolute inset-0 bg-muted/60 border border-dashed border-muted-foreground/30 flex items-center justify-center cursor-pointer hover:bg-destructive/15 hover:border-destructive/40 transition-colors z-20"
                          >
                            <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                              {b.reason || "Bloqueado"}
                            </span>
                          </button>
                        ))}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Card>
  );
}
