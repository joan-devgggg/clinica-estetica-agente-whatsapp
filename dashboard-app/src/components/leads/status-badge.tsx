import { Badge } from "@/components/ui/badge";

type Estado = "pendiente" | "confirmado" | "completado" | "cancelado";

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
};

export function StatusBadge({ estado }: { estado: string }) {
  const cfg = config[estado as Estado] ?? config.pendiente;
  return (
    <Badge className={`text-[10.5px] font-medium px-2 py-0.5 ${cfg.className}`}>
      {cfg.label}
    </Badge>
  );
}
