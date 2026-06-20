"use client";

import { ArrowRight, CalendarClock } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/clientes/status-badge";
import type { Cliente } from "@/lib/types";

interface RecentActivityProps {
  leads: Cliente[];
  loading?: boolean;
}

function getInitials(nombre: string) {
  return (nombre || "??")
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

function formatFecha(fecha?: string, hora?: string) {
  if (!fecha) return "—";
  const d = new Date(fecha);
  const dayStr = d.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
  });
  return hora ? `${dayStr} · ${hora}` : dayStr;
}

export function RecentActivity({ leads, loading }: RecentActivityProps) {
  if (loading) {
    return (
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="flex-row items-center justify-between pb-3 pt-5 px-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-16" />
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {[...Array(5)].map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 px-5 py-3 border-t border-border/50"
            >
              <Skeleton className="h-8 w-8 rounded-full flex-shrink-0" />
              <div className="flex-1">
                <Skeleton className="h-3 w-32 mb-1.5" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  const empty = leads.length === 0;

  return (
    <Card className="border-border/60 shadow-sm">
      <CardHeader className="flex-row items-center justify-between pb-3 pt-5 px-5">
        <h2 className="text-[13.5px] font-semibold text-foreground">
          Actividad reciente
        </h2>
        <Button
          variant="ghost"
          size="sm"
          render={<a href="/clientes" />}
          className="text-[11.5px] h-7 px-2 text-muted-foreground hover:text-foreground"
        >
          Ver todos <ArrowRight size={12} className="ml-1" />
        </Button>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {empty ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <CalendarClock
              size={32}
              strokeWidth={1.25}
              className="text-muted-foreground/50"
            />
            <p className="font-heading text-[16px] font-semibold text-foreground/70">
              Sin actividad reciente
            </p>
            <p className="text-[12px] text-muted-foreground">
              Los nuevos clientes aparecerán aquí
            </p>
          </div>
        ) : (
          leads.slice(0, 8).map((lead) => (
            <div
              key={lead.id}
              className="flex items-center gap-3 px-5 py-3 border-t border-border/50 hover:bg-muted/50 transition-colors duration-150"
            >
              <Avatar className="h-8 w-8 flex-shrink-0">
                <AvatarFallback className="bg-secondary text-primary text-[11px] font-semibold">
                  {getInitials(lead.nombre || "?")}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium text-foreground truncate">
                  {lead.nombre || "Sin nombre"}
                </p>
                <p className="text-[11.5px] text-muted-foreground truncate">
                  {lead.personas ? `${lead.personas} pax` : "Sin reserva"}
                  {lead.ocasion ? ` · ${lead.ocasion}` : ""} ·{" "}
                  {formatFecha(lead.fecha_cita, lead.hora_cita)}
                </p>
              </div>
              <StatusBadge estado={lead.estado_cita} />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
