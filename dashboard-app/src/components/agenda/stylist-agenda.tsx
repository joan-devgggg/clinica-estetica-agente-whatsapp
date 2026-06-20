"use client";

import { Card } from "@/components/ui/card";
import type { Stylist, Reserva, ScheduleBlock } from "@/lib/types";
import { ymd, parseYmd, addDays, madridDateKey } from "@/lib/date";

interface StylistAgendaProps {
  weekStart: string;
  appointments: Reserva[];
  blocks: ScheduleBlock[];
  stylist: Stylist;
}

const HOURS = Array.from({ length: 10 }, (_, i) => i + 10); // 10:00 to 19:00
const DAY_NAMES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

function getWeekDays(weekStart: string) {
  const start = parseYmd(weekStart);
  const todayKey = ymd(new Date());
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(start, i);
    const key = ymd(d);
    return {
      date: key,
      dayName: DAY_NAMES[i],
      dayNum: d.getDate(),
      isToday: key === todayKey,
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

export function StylistAgenda({ weekStart, appointments, blocks, stylist }: StylistAgendaProps) {
  const days = getWeekDays(weekStart);

  return (
    <Card className="border-border/60 shadow-sm overflow-hidden">
      <div className="grid grid-cols-[60px_repeat(7,1fr)] text-xs">
        {/* Header row */}
        <div className="border-b border-r border-border bg-muted/50 px-2 py-2" />
        {days.map(day => (
          <div
            key={day.date}
            className={`border-b border-r border-border px-2 py-2 text-center ${
              day.isToday ? "bg-primary/5 font-semibold" : "bg-muted/50"
            }`}
          >
            <p className="text-muted-foreground">{day.dayName}</p>
            <p className={`text-lg font-semibold ${day.isToday ? "text-primary" : "text-foreground"}`}>
              {day.dayNum}
            </p>
          </div>
        ))}

        {/* Time grid */}
        {HOURS.map(hour => (
          <div key={hour} className="contents">
            <div className="border-r border-b border-border px-2 py-3 text-right text-muted-foreground bg-muted/30 text-[11px]">
              {String(hour).padStart(2, "0")}:00
            </div>
            {days.map(day => {
              const dayAppts = appointments.filter(a => a.fecha_cita === day.date);
              const dayBlocks = blocks.filter(b => {
                const bStart = madridDateKey(b.starts_at);
                const bEnd = madridDateKey(b.ends_at);
                return bStart <= day.date && bEnd >= day.date;
              });

              return (
                <div key={day.date} className="border-r border-b border-border relative h-14">
                  {/* Appointment blocks for this hour */}
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
                        <div
                          key={a.appointment_id}
                          className="absolute inset-x-0.5 bg-primary/15 border border-primary/30 rounded px-1 py-0.5 text-[10px] leading-tight overflow-hidden z-10"
                          style={{ top: 0, minHeight: "100%" }}
                        >
                          <p className="font-medium text-primary truncate">{a.nombre}</p>
                          <p className="text-muted-foreground truncate">{a.service || "Cita"}</p>
                        </div>
                      );
                    })}

                  {/* Block overlays for this hour */}
                  {dayBlocks
                    .filter(b => {
                      const start = new Date(b.starts_at);
                      const end = new Date(b.ends_at);
                      const blockStartH = madridDateKey(b.starts_at) === day.date ? start.getHours() : 0;
                      const blockEndH = madridDateKey(b.ends_at) === day.date ? end.getHours() : 24;
                      return hour >= blockStartH && hour < blockEndH;
                    })
                    .map(b => (
                      <div
                        key={b.id}
                        className="absolute inset-0 bg-muted/60 border border-dashed border-muted-foreground/30 flex items-center justify-center"
                      >
                        <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                          {b.reason || "Bloqueado"}
                        </span>
                      </div>
                    ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Card>
  );
}
