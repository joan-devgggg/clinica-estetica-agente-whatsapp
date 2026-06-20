"use client";

import { Users, Star, Ban } from "lucide-react";
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
import type { Cliente, OrgType } from "@/lib/types";

interface ClientesTableProps {
  clientes: Cliente[];
  loading?: boolean;
  selectedId: number | null;
  onSelect: (cliente: Cliente) => void;
  orgType?: OrgType;
}

function getInitials(nombre: string) {
  return (nombre || "??")
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

function formatFechaISO(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  const day = d.toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: "Europe/Madrid" });
  const hora = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
  return `${day} · ${hora}`;
}

const LANG_LABELS: Record<string, string> = { es: "ES", en: "EN", ru: "RU", uk: "UK" };

export function ClientesTable({
  clientes,
  loading,
  selectedId,
  onSelect,
  orgType = "restaurant",
}: ClientesTableProps) {
  const isSalon = orgType === "salon";
  const col2Label = isSalon ? "Idioma" : "Personas";

  if (loading) {
    return (
      <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/60 hover:bg-muted/60">
              <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">Cliente</TableHead>
              <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">{col2Label}</TableHead>
              <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">Visitas</TableHead>
              <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">{isSalon ? "Próxima cita" : "Próxima reserva"}</TableHead>
              {isSalon && <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">Estilista</TableHead>}
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
                <TableCell><Skeleton className="h-3 w-12" /></TableCell>
                <TableCell><Skeleton className="h-3 w-8" /></TableCell>
                <TableCell><Skeleton className="h-3 w-20" /></TableCell>
                {isSalon && <TableCell><Skeleton className="h-3 w-16" /></TableCell>}
                <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  if (clientes.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-card shadow-sm flex flex-col items-center justify-center py-20 gap-3">
        <Users size={36} strokeWidth={1.25} className="text-muted-foreground/40" />
        <p className="font-heading text-[17px] font-semibold text-foreground/60">
          Sin clientes aún
        </p>
        <p className="text-[12.5px] text-muted-foreground text-center max-w-xs">
          Los clientes que escriban por WhatsApp aparecerán aquí automáticamente
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
              {col2Label}
            </TableHead>
            <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">
              Visitas
            </TableHead>
            <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">
              {isSalon ? "Próxima cita" : "Próxima reserva"}
            </TableHead>
            {isSalon && (
              <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">
                Estilista
              </TableHead>
            )}
            <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">
              Estado
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {clientes.map((cliente, idx) => (
            <TableRow
              key={cliente.id}
              onClick={() => onSelect(cliente)}
              data-selected={cliente.id === selectedId}
              className={`cursor-pointer transition-colors duration-150 border-b border-border/50 last:border-0 ${
                idx % 2 === 1 ? "bg-muted/20" : ""
              } ${cliente.id === selectedId ? "bg-secondary/50" : "hover:bg-muted/40"}`}
            >
              <TableCell className="pl-5 py-3">
                <div className="flex items-center gap-3">
                  <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarFallback className="bg-secondary text-primary text-[10.5px] font-semibold">
                      {getInitials(cliente.nombre)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <p className="text-[13px] font-medium text-foreground leading-tight">
                        {cliente.nombre || "Sin nombre"}
                      </p>
                      {cliente.is_vip && (
                        <Star size={12} className="text-amber-500 fill-amber-500" />
                      )}
                      {cliente.is_blacklisted && (
                        <Ban size={12} className="text-destructive" />
                      )}
                    </div>
                    <p className="text-[11.5px] text-muted-foreground leading-tight mt-0.5">
                      {cliente.telefono}
                    </p>
                  </div>
                </div>
              </TableCell>
              <TableCell className="text-[13px] text-foreground">
                {isSalon
                  ? LANG_LABELS[cliente.language || "es"] || cliente.language || "ES"
                  : cliente.personas ?? "—"}
              </TableCell>
              <TableCell className="text-[13px] text-foreground tabular-nums">
                {cliente.total_visitas ?? cliente.visit_count ?? 0}
              </TableCell>
              <TableCell className="text-[13px] text-muted-foreground">
                {formatFechaISO(cliente.proxima_cita)}
              </TableCell>
              {isSalon && (
                <TableCell className="text-[13px] text-muted-foreground">
                  {cliente.estilista_nombre || "—"}
                </TableCell>
              )}
              <TableCell>
                <StatusBadge estado={cliente.estado_cita} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
