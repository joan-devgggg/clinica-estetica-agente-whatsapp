import { Clock, Phone, MessageSquare, Users, Star, Ban, Scissors } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/clientes/status-badge";
import { Badge } from "@/components/ui/badge";
import type { Reserva, OrgType } from "@/lib/types";

interface ReservaCardProps {
  reserva: Reserva;
  orgType?: OrgType;
  onClick?: () => void;
}

function getInitials(nombre: string) {
  return (nombre || "??")
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

const BIZUM_LABELS: Record<string, { label: string; className: string }> = {
  pending: {
    label: "Bizum pendiente",
    className: "bg-[oklch(0.85_0.12_85/0.3)] text-[oklch(0.45_0.12_55)] border-transparent",
  },
  confirmed: {
    label: "Bizum confirmado",
    className: "bg-[oklch(0.78_0.04_160/0.15)] text-[oklch(0.35_0.06_160)] border-transparent",
  },
  rejected: {
    label: "Bizum rechazado",
    className: "bg-[oklch(0.55_0.07_25/0.1)] text-[oklch(0.48_0.07_25)] border-transparent",
  },
};

export function ReservaCard({ reserva, orgType = "restaurant", onClick }: ReservaCardProps) {
  const isSalon = orgType === "salon";
  const bizum = !isSalon && reserva.bizum_status ? BIZUM_LABELS[reserva.bizum_status] : null;

  return (
    <Card
      onClick={onClick}
      className="border-border/60 shadow-sm cursor-pointer hover:shadow-md hover:border-border transition-all duration-200 group"
    >
      <CardContent className="p-4 flex items-center gap-3">
        <Avatar className="h-10 w-10 flex-shrink-0">
          <AvatarFallback className="bg-secondary text-primary text-[11.5px] font-semibold">
            {getInitials(reserva.nombre)}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <p className="text-[13.5px] font-semibold text-foreground truncate flex items-center gap-1.5">
              {reserva.nombre || "Sin nombre"}
              {reserva.is_vip && <Star size={12} className="text-amber-500 fill-amber-500" />}
              {reserva.is_blacklisted && <Ban size={12} className="text-destructive" />}
            </p>
            <StatusBadge estado={reserva.estado_cita} />
          </div>
          <p className="text-[12.5px] text-muted-foreground truncate flex items-center gap-1">
            {isSalon ? (
              <>
                <Scissors size={11} strokeWidth={1.5} />
                {reserva.service || "Cita"}
                {reserva.stylist_name ? ` · ${reserva.stylist_name}` : ""}
              </>
            ) : (
              <>
                <Users size={11} strokeWidth={1.5} />
                {reserva.personas ?? "—"} pax
                {reserva.ocasion ? ` · ${reserva.ocasion}` : ""}
              </>
            )}
          </p>
          <div className="flex items-center gap-3 mt-1.5">
            {reserva.hora_cita && (
              <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
                <Clock size={11} strokeWidth={1.5} />
                {reserva.hora_cita}
              </span>
            )}
            {reserva.telefono && (
              <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
                <Phone size={11} strokeWidth={1.5} />
                {reserva.telefono}
              </span>
            )}
            {bizum && (
              <Badge className={`text-[10px] px-1.5 py-0 ${bizum.className}`}>
                {bizum.label}
              </Badge>
            )}
          </div>
          {reserva.notas && (
            <p className="flex items-start gap-1 mt-1.5 text-[11.5px] text-muted-foreground/80 italic line-clamp-1">
              <MessageSquare size={11} strokeWidth={1.5} className="mt-0.5 shrink-0" />
              {reserva.notas}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
