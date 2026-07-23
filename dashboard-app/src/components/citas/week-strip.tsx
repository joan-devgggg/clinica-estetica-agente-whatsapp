"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface WeekStripProps {
  weekStart: Date;
  selectedDate: Date;
  citasByDate: Record<string, number>;
  onSelectDate: (date: Date) => void;
  onPrevWeek: () => void;
  onNextWeek: () => void;
}

const DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

function toKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function WeekStrip({
  weekStart,
  selectedDate,
  citasByDate,
  onSelectDate,
  onPrevWeek,
  onNextWeek,
}: WeekStripProps) {
  const monthLabel = weekStart.toLocaleDateString("es-ES", {
    month: "long",
    year: "numeric",
  });
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <div className="bg-card border-b border-border px-6 py-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-heading text-[17px] font-semibold text-foreground capitalize">
          {monthLabel}
        </h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onPrevWeek}
          >
            <ChevronLeft size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onNextWeek}
          >
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {DAYS.map((dayName, i) => {
          const date = addDays(weekStart, i);
          const key = toKey(date);
          const isSelected = toKey(selectedDate) === key;
          const isToday = toKey(today) === key;
          const count = citasByDate[key] ?? 0;

          return (
            <button
              key={key}
              onClick={() => onSelectDate(date)}
              className={`flex flex-col items-center gap-1 rounded-lg px-1 py-2 transition-all duration-150 ${
                isSelected
                  ? "bg-primary text-primary-foreground"
                  : isToday
                    ? "bg-secondary text-foreground"
                    : "hover:bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="text-[10px] font-semibold uppercase tracking-wide">
                {dayName}
              </span>
              <span
                className={`text-[15px] font-semibold leading-none ${
                  isSelected ? "text-primary-foreground" : "text-foreground"
                }`}
              >
                {date.getDate()}
              </span>
              {count > 0 ? (
                <span
                  className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${
                    isSelected
                      ? "bg-primary-foreground/20 text-primary-foreground"
                      : "bg-primary/10 text-primary"
                  }`}
                >
                  {count}
                </span>
              ) : (
                <span className="h-[16px]" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
