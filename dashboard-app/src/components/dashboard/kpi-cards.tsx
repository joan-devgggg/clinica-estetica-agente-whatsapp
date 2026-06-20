"use client";

import { Banknote, AlertTriangle, MessageSquareText } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { OrgType } from "@/lib/types";

interface Stats {
  total: number;
  reservasMes: number;
  noShows: number;
  bizumsPendientes: number;
  resenasPendientes?: number;
  citasHoy: number;
  proximaReserva?: { nombre: string; personas: number; hora: string } | null;
}

interface KpiCardsProps {
  stats: Stats | null;
  loading?: boolean;
  orgType?: OrgType;
}

export function KpiCards({ stats, loading, orgType = "restaurant" }: KpiCardsProps) {
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

  const isSalon = orgType === "salon";

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {/* Card 1 — Total clientes */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-1 pt-5 px-5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            Total clientes
          </p>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <p className="font-heading text-[36px] font-semibold leading-none text-foreground mb-2">
            {stats.total}
          </p>
          <p className="text-[11.5px] text-muted-foreground">
            Clientes registrados en total
          </p>
        </CardContent>
      </Card>

      {/* Card 2 — Reservas/Citas este mes */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-1 pt-5 px-5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            {isSalon ? "Citas este mes" : "Reservas este mes"}
          </p>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <p className="font-heading text-[36px] font-semibold leading-none text-foreground mb-2">
            {stats.reservasMes}
          </p>
          <p className="text-[11.5px] text-muted-foreground">
            {stats.noShows > 0
              ? `${stats.noShows} no-show${stats.noShows === 1 ? "" : "s"} este mes`
              : "Sin no-shows este mes"}
          </p>
        </CardContent>
      </Card>

      {/* Card 3 — Bizums (restaurant) / Reseñas pendientes (salon) */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-1 pt-5 px-5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            {isSalon ? "Reseñas pendientes" : "Bizums pendientes"}
          </p>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <p className="font-heading text-[36px] font-semibold leading-none text-foreground mb-2">
            {isSalon ? (stats.resenasPendientes ?? 0) : stats.bizumsPendientes}
          </p>
          {isSalon ? (
            <p className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
              <MessageSquareText size={12} strokeWidth={2} />
              {(stats.resenasPendientes ?? 0) > 0 ? "Pendientes de enviar" : "Todo enviado"}
            </p>
          ) : stats.bizumsPendientes > 0 ? (
            <p className="flex items-center gap-1 text-[11.5px] text-amber-600">
              <AlertTriangle size={12} strokeWidth={2} />
              Requieren verificación
            </p>
          ) : (
            <p className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
              <Banknote size={12} strokeWidth={2} />
              Todo verificado
            </p>
          )}
        </CardContent>
      </Card>

      {/* Card 4 — Citas hoy */}
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="pb-1 pt-5 px-5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            {isSalon ? "Citas hoy" : "Reservas hoy"}
          </p>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <p className="font-heading text-[36px] font-semibold leading-none text-foreground mb-2">
            {stats.citasHoy}
          </p>
          {stats.proximaReserva ? (
            <p className="text-[11.5px] text-muted-foreground">
              Próxima:{" "}
              <span className="font-medium text-foreground">
                {stats.proximaReserva.nombre}
              </span>{" "}
              {!isSalon && stats.proximaReserva.personas
                ? `· ${stats.proximaReserva.personas} pax `
                : ""}
              · {stats.proximaReserva.hora}
            </p>
          ) : (
            <p className="text-[11.5px] text-muted-foreground">
              {isSalon ? "Sin más citas hoy" : "Sin más reservas hoy"}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
