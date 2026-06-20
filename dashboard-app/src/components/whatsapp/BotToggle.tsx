"use client";

import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface BotToggleProps {
  active: boolean;
  onToggleRequest: (next: boolean) => void;
  loading?: boolean;
}

export function BotToggle({ active, onToggleRequest, loading }: BotToggleProps) {
  return (
    <div className="flex items-center gap-3">
      <Badge
        variant="secondary"
        className={cn(
          "text-[11px] font-medium px-2.5 py-0.5 border transition-all duration-200",
          active
            ? "text-[oklch(0.42_0.06_160)] bg-[oklch(0.96_0.02_160)] border-[oklch(0.86_0.04_160)]"
            : "text-primary bg-[oklch(0.97_0.01_25)] border-[oklch(0.88_0.03_25)]"
        )}
      >
        {active ? "Bot activo" : "Manual"}
      </Badge>

      <Tooltip>
        <TooltipTrigger>
          <Switch
            checked={active}
            disabled={loading}
            onCheckedChange={(next) => onToggleRequest(next)}
            className={cn(
              "transition-all duration-200",
              active
                ? "[&>span]:bg-[oklch(0.65_0.12_160)]"
                : "[&>span]:bg-primary"
            )}
          />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[12px]">
          {active
            ? "El agente de IA está respondiendo automáticamente"
            : "Tú controlas las respuestas. El bot no responderá."}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
