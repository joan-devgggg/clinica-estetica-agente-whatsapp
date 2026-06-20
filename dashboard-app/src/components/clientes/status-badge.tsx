import { Badge } from "@/components/ui/badge";

type Estado =
  | "pendiente"
  | "pendiente_bizum"
  | "confirmado"
  | "completado"
  | "cancelado"
  | "abandonado";

const config: Record<Estado, { label: string; className: string }> = {
  confirmado: {
    label: "Confirmada",
    className:
      "bg-[oklch(0.78_0.04_160/0.15)] text-[oklch(0.35_0.06_160)] border-transparent hover:bg-[oklch(0.78_0.04_160/0.2)]",
  },
  pendiente: {
    label: "Pendiente",
    className:
      "bg-[oklch(0.92_0.02_90/0.7)] text-[oklch(0.38_0.05_60)] border-transparent hover:bg-[oklch(0.92_0.02_90/0.9)]",
  },
  pendiente_bizum: {
    label: "Bizum pendiente",
    className:
      "bg-[oklch(0.85_0.12_85/0.3)] text-[oklch(0.45_0.12_55)] border-transparent hover:bg-[oklch(0.85_0.12_85/0.4)]",
  },
  completado: {
    label: "Completada",
    className:
      "bg-[oklch(0.78_0.03_230/0.15)] text-[oklch(0.38_0.04_230)] border-transparent hover:bg-[oklch(0.78_0.03_230/0.2)]",
  },
  cancelado: {
    label: "Cancelada",
    className:
      "bg-[oklch(0.55_0.07_25/0.1)] text-[oklch(0.48_0.07_25)] border-transparent hover:bg-[oklch(0.55_0.07_25/0.15)]",
  },
  abandonado: {
    label: "Abandonada",
    className:
      "bg-[oklch(0.9_0_0/0.6)] text-[oklch(0.5_0_0)] border-transparent hover:bg-[oklch(0.9_0_0/0.8)]",
  },
};

// appointments.status guarda valores en inglés; contacts.estado en español.
// Normalizamos ambos a las claves español de `config`.
const ALIAS: Record<string, Estado> = {
  confirmed: "confirmado",
  pending: "pendiente",
  completed: "completado",
  cancelled: "cancelado",
};

export function StatusBadge({ estado }: { estado: string }) {
  const key = ALIAS[estado] ?? (estado as Estado);
  const cfg = config[key] ?? config.pendiente;
  return (
    <Badge className={`text-[10.5px] font-medium px-2 py-0.5 ${cfg.className}`}>
      {cfg.label}
    </Badge>
  );
}
