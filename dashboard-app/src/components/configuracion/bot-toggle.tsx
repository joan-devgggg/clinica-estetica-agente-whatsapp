"use client";

import { useState } from "react";
import { Bot, Power } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

interface BotToggleProps {
  active: boolean;
  onToggle: (next: boolean) => Promise<void>;
  loading?: boolean;
}

// Este interruptor apaga el bot de la ORGANIZACIÓN ENTERA. Es el único sitio desde el que
// se puede hacer: había otro en el Monitor de WhatsApp, pegado al "modo manual" de cada
// conversación, y el 01/08 se apagó Sante entera 4 h creyendo que se pausaba una clienta.
// Para pausar UNA conversación está el botón dentro del chat.
export function BotToggle({ active, onToggle, loading }: BotToggleProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <ToggleCard
        active={active}
        loading={loading}
        onRequest={() => setConfirmOpen(true)}
      />
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-heading text-[17px]">
              {active ? "¿Pausar el bot de toda la organización?" : "¿Reactivar el bot?"}
            </DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed">
              {active
                ? "Afecta a TODAS las clientas, no solo a la conversación que estés mirando. Mientras esté pausado, los mensajes que lleguen no se responden — y tampoco se contestan al reactivarlo. Para pausar una sola conversación, usa el botón dentro de ese chat."
                : "El agente volverá a responder automáticamente a todas las clientas."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="ghost"
              size="sm"
              className="text-[13px]"
              onClick={() => setConfirmOpen(false)}
            >
              Cancelar
            </Button>
            <Button
              size="sm"
              className="text-[13px]"
              variant={active ? "destructive" : "default"}
              onClick={async () => {
                setConfirmOpen(false);
                await onToggle(!active);
              }}
            >
              {active ? "Pausar para todas" : "Reactivar bot"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ToggleCard({
  active,
  loading,
  onRequest,
}: {
  active: boolean;
  loading?: boolean;
  onRequest: () => void;
}) {
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
                Bot WhatsApp — todas las clientas
              </p>
              <p
                className={`text-[11.5px] font-medium ${
                  active ? "text-[oklch(0.42_0.06_160)]" : "text-destructive"
                }`}
              >
                {active
                  ? "Activo — respondiendo mensajes"
                  : "Pausado para TODAS las clientas"}
              </p>
            </div>
          </div>
          <Button
            variant={active ? "outline" : "default"}
            size="sm"
            disabled={loading}
            onClick={onRequest}
            className="gap-1.5"
          >
            <Power size={13} strokeWidth={1.75} />
            {active ? "Pausar para todas" : "Activar"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
