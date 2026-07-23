"use client";

import { ArrowRight, CalendarClock } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

interface Lead {
  id: number;
  nombre: string;
  tratamiento: string;
  estado_cita: "pendiente" | "confirmado" | "completado" | "cancelado";
  hora_cita?: string;
  fecha_cita?: string;
}

interface RecentActivityProps {
  leads: Lead[];
  loading?: boolean;
}

const estadoConfig = {
  confirmado: {
    label: "Confirmada",
    className:
      "bg-[oklch(0.78_0.04_160/0.15)] text-[oklch(0.38_0.06_160)] border-transparent",
  },
  pendiente: {
    label: "Pendiente",
    className:
      "bg-[oklch(0.92_0.02_90/0.6)] text-[oklch(0.38_0.04_60)] border-transparent",
  },
  completado: {
    label: "Completada",
    className:
      "bg-[oklch(0.78_0.03_230/0.15)] text-[oklch(0.38_0.04_230)] border-transparent",
  },
  cancelado: {
    label: "Cancelada",
    className:
      "bg-[oklch(0.55_0.07_25/0.1)] text-[oklch(0.45_0.07_25)] border-transparent",
  },
};

function getInitials(nombre: string) {
  return nombre
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
          render={<a href="/leads" />}
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
              Los nuevos leads aparecerán aquí
            </p>
          </div>
        ) : (
          leads.slice(0, 8).map((lead) => {
            const cfg = estadoConfig[lead.estado_cita] ?? estadoConfig.pendiente;
            return (
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
                    {lead.tratamiento || "Tratamiento pendiente"} ·{" "}
                    {formatFecha(lead.fecha_cita, lead.hora_cita)}
                  </p>
                </div>
                <Badge className={`text-[10.5px] px-2 py-0.5 ${cfg.className}`}>
                  {cfg.label}
                </Badge>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
