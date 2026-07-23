"use client";

import { Users } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "./status-badge";
import type { Lead } from "@/lib/types";

interface LeadsTableProps {
  leads: Lead[];
  loading?: boolean;
  selectedId: number | null;
  onSelect: (lead: Lead) => void;
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
  const dayStr = d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  return hora ? `${dayStr} · ${hora}` : dayStr;
}

export function LeadsTable({
  leads,
  loading,
  selectedId,
  onSelect,
}: LeadsTableProps) {
  if (loading) {
    return (
      <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/60 hover:bg-muted/60">
              <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">Cliente</TableHead>
              <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">Tratamiento</TableHead>
              <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">Cita</TableHead>
              <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">Estado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...Array(6)].map((_, i) => (
              <TableRow key={i}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <div>
                      <Skeleton className="h-3 w-28 mb-1.5" />
                      <Skeleton className="h-3 w-22" />
                    </div>
                  </div>
                </TableCell>
                <TableCell><Skeleton className="h-3 w-24" /></TableCell>
                <TableCell><Skeleton className="h-3 w-20" /></TableCell>
                <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  if (leads.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-card shadow-sm flex flex-col items-center justify-center py-20 gap-3">
        <Users size={36} strokeWidth={1.25} className="text-muted-foreground/40" />
        <p className="font-heading text-[17px] font-semibold text-foreground/60">
          Sin leads aún
        </p>
        <p className="text-[12.5px] text-muted-foreground text-center max-w-xs">
          Los leads de Instagram aparecerán aquí automáticamente
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/60 hover:bg-muted/60 border-b border-border">
            <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground pl-5">
              Cliente
            </TableHead>
            <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">
              Tratamiento
            </TableHead>
            <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">
              Cita
            </TableHead>
            <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">
              Estado
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {leads.map((lead, idx) => (
            <TableRow
              key={lead.id}
              onClick={() => onSelect(lead)}
              data-selected={lead.id === selectedId}
              className={`cursor-pointer transition-colors duration-150 border-b border-border/50 last:border-0 ${
                idx % 2 === 1 ? "bg-muted/20" : ""
              } ${lead.id === selectedId ? "bg-secondary/50" : "hover:bg-muted/40"}`}
            >
              <TableCell className="pl-5 py-3">
                <div className="flex items-center gap-3">
                  <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarFallback className="bg-secondary text-primary text-[10.5px] font-semibold">
                      {getInitials(lead.nombre)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-[13px] font-medium text-foreground leading-tight">
                      {lead.nombre || "Sin nombre"}
                    </p>
                    <p className="text-[11.5px] text-muted-foreground leading-tight mt-0.5">
                      {lead.telefono}
                    </p>
                  </div>
                </div>
              </TableCell>
              <TableCell className="text-[13px] text-foreground">
                {lead.tratamiento || "—"}
              </TableCell>
              <TableCell className="text-[13px] text-muted-foreground">
                {formatFecha(lead.fecha_cita, lead.hora_cita)}
              </TableCell>
              <TableCell>
                <StatusBadge estado={lead.estado_cita} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
