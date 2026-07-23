"use client";

import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";

interface Stats {
  total: number;
  confirmadas: number;
  hoy: number;
  semana: number;
  proximaCita?: { nombre: string; hora: string; tratamiento: string } | null;
}

interface KpiCardsProps {
  stats: Stats | null;
  loading?: boolean;
}

const OBJETIVO_MENSUAL = 34;

// Tiny sparkline — 7 barras proporcionales a datos simulados de la semana
function Sparkline({ value }: { value: number }) {
  // Barras relativas — la última representa el valor actual (hoy)
  const bars = [0.35, 0.55, 0.4, 0.7, 0.5, 0.9, Math.min(value / 10, 1)];
  return (
    <div className="flex items-end gap-[3px] h-7 mt-2">
      {bars.map((h, i) => {
        const isPeak = i === 5;
        const isLast = i === 6;
        return (
          <div
            key={i}
            className="w-[6px] rounded-sm transition-all duration-300"
            style={{
              height: `${h * 100}%`,
              backgroundColor: isPeak
                ? "oklch(0.55 0.07 25)"
                : isLast
                  ? "oklch(0.55 0.07 25 / 0.7)"
                  : "oklch(0.9 0.01 80)",
            }}
          />
        );
      })}
    </div>
  );
}

function TrendBadge({ value }: { value: number }) {
  if (value > 0)
    return (
      <span className="flex items-center gap-1 text-[11.5px] text-emerald-700">
        <TrendingUp size={12} strokeWidth={2} />
        {value}% vs mes anterior
      </span>
    );
  if (value < 0)
    return (
      <span className="flex items-center gap-1 text-[11.5px] text-destructive">
        <TrendingDown size={12} strokeWidth={2} />
        {Math.abs(value)}% vs mes anterior
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
      <Minus size={12} strokeWidth={2} />
      Sin cambios
    </span>
  );
}

export function KpiCards({ stats, loading }: KpiCardsProps) {
  if (loading || !stats) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <Card key={i} className="border-border/60 shadow-sm">
            <CardHeader className="pb-2">
              <Skeleton className="h-3 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-9 w-16 mb-2" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const progreso = Math.round((stats.confirmadas / OBJETIVO_MENSUAL) * 100);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {/* Card 1 — Total leads + trend */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-1 pt-5 px-5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            Total leads
          </p>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <p className="font-heading text-[36px] font-semibold leading-none text-foreground mb-2">
            {stats.total}
          </p>
          <TrendBadge value={12} />
        </CardContent>
      </Card>

      {/* Card 2 — Citas semana + sparkline */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-1 pt-5 px-5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            Citas esta semana
          </p>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <p className="font-heading text-[36px] font-semibold leading-none text-foreground">
            {stats.semana}
          </p>
          <Sparkline value={stats.semana} />
        </CardContent>
      </Card>

      {/* Card 3 — Confirmadas + progress bar */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-1 pt-5 px-5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            Confirmadas
          </p>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <p className="font-heading text-[36px] font-semibold leading-none text-foreground mb-3">
            {stats.confirmadas}
          </p>
          <Progress value={progreso} className="h-[3px] bg-muted" />
          <p className="mt-1.5 text-[10.5px] text-muted-foreground">
            {progreso}% del objetivo mensual ({OBJETIVO_MENSUAL})
          </p>
        </CardContent>
      </Card>

      {/* Card 4 — Hoy + próxima cita */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-1 pt-5 px-5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            Citas hoy
          </p>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <p className="font-heading text-[36px] font-semibold leading-none text-foreground mb-2">
            {stats.hoy}
          </p>
          {stats.proximaCita ? (
            <div>
              <p className="text-[11.5px] text-muted-foreground">
                Próxima:{" "}
                <span className="font-medium text-foreground">
                  {stats.proximaCita.nombre}
                </span>{" "}
                · {stats.proximaCita.hora}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {stats.proximaCita.tratamiento}
              </p>
            </div>
          ) : (
            <p className="text-[11.5px] text-muted-foreground">
              Sin más citas hoy
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
