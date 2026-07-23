"use client";

import { Bot, Power } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface BotToggleProps {
  active: boolean;
  onToggle: (next: boolean) => Promise<void>;
  loading?: boolean;
}

export function BotToggle({ active, onToggle, loading }: BotToggleProps) {
  return (
    <Card className="border-border/60 shadow-sm">
      <CardHeader className="pb-2 pt-5 px-5">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          Estado del bot
        </p>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-9 w-9 items-center justify-center rounded-full ${
                active ? "bg-accent/20" : "bg-muted"
              }`}
            >
              <Bot
                size={16}
                strokeWidth={1.5}
                className={active ? "text-accent-foreground" : "text-muted-foreground"}
              />
            </div>
            <div>
              <p className="text-[13.5px] font-medium text-foreground">
                Bot WhatsApp
              </p>
              <p
                className={`text-[11.5px] font-medium ${
                  active ? "text-[oklch(0.42_0.06_160)]" : "text-destructive"
                }`}
              >
                {active ? "Activo — respondiendo mensajes" : "Pausado"}
              </p>
            </div>
          </div>
          <Button
            variant={active ? "outline" : "default"}
            size="sm"
            disabled={loading}
            onClick={() => onToggle(!active)}
            className="gap-1.5"
          >
            <Power size={13} strokeWidth={1.75} />
            {active ? "Pausar" : "Activar"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
