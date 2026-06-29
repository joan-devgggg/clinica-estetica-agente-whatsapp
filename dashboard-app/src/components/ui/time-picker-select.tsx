"use client";

import { cn } from "@/lib/utils";

interface TimePickerSelectProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  minuteStep?: number;
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));

function getMinutes(step: number) {
  const mins: string[] = [];
  for (let m = 0; m < 60; m += step) mins.push(String(m).padStart(2, "0"));
  return mins;
}

export function TimePickerSelect({ value, onChange, className, minuteStep = 5 }: TimePickerSelectProps) {
  const [hh, mm] = (value || "00:00").split(":");
  const minutes = getMinutes(minuteStep);

  const selectClass =
    "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50 appearance-none cursor-pointer";

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <select
        value={hh}
        onChange={(e) => onChange(`${e.target.value}:${mm}`)}
        className={cn(selectClass, "w-[60px]")}
        aria-label="Hora"
      >
        {HOURS.map((h) => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>
      <span className="text-muted-foreground font-medium">:</span>
      <select
        value={mm}
        onChange={(e) => onChange(`${hh}:${e.target.value}`)}
        className={cn(selectClass, "w-[60px]")}
        aria-label="Minutos"
      >
        {minutes.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
    </div>
  );
}
