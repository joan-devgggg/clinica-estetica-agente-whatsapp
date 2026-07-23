import { Clock, Phone, MessageSquare } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/leads/status-badge";
import type { Cita } from "@/lib/types";

interface AppointmentCardProps {
  cita: Cita;
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

export function AppointmentCard({ cita, onClick }: AppointmentCardProps) {
  return (
    <Card
      onClick={onClick}
      className="border-border/60 shadow-sm cursor-pointer hover:shadow-md hover:border-border transition-all duration-200 group"
    >
      <CardContent className="p-4 flex items-center gap-3">
        <Avatar className="h-10 w-10 flex-shrink-0">
          <AvatarFallback className="bg-secondary text-primary text-[11.5px] font-semibold">
            {getInitials(cita.nombre)}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <p className="text-[13.5px] font-semibold text-foreground truncate">
              {cita.nombre || "Sin nombre"}
            </p>
            <StatusBadge estado={cita.estado_cita} />
          </div>
          <p className="text-[12.5px] text-muted-foreground truncate">
            {cita.tratamiento || "—"}
          </p>
          <div className="flex items-center gap-3 mt-1.5">
            {cita.hora_cita && (
              <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
                <Clock size={11} strokeWidth={1.5} />
                {cita.hora_cita}
              </span>
            )}
            {cita.telefono && (
              <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
                <Phone size={11} strokeWidth={1.5} />
                {cita.telefono}
              </span>
            )}
          </div>
          {cita.notas && (
            <p className="flex items-start gap-1 mt-1.5 text-[11.5px] text-muted-foreground/80 italic line-clamp-1">
              <MessageSquare size={11} strokeWidth={1.5} className="mt-0.5 shrink-0" />
              {cita.notas}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
