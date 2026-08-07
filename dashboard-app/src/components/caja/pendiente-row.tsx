"use client";

// La fila de un toque.
//
// ── EL TRÍPODE: estas tres decisiones se sostienen entre sí ──────────────────
//   1. El cobro de UN TOQUE asume el riesgo de tocar la fila equivocada.
//   2. Ese riesgo solo es asumible porque hay DESHACER (~8 s en el aviso).
//   3. Y el deshacer solo es honesto porque ANULA DE VERDAD y deja rastro — no borra la fila.
//
// Quitar una deja a las otras dos sin sentido: sin deshacer, el un-toque es temerario; con un
// deshacer que borrara, el registro dejaría de ser contable. Si algún día hay que tocar esto,
// se tocan las tres o ninguna.

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";
import type { CajaPendiente, MetodoCobro } from "@/lib/types";
import { madridTime } from "@/lib/date";
import type { CajaSesion } from "@/lib/caja-session";

const eur = (n: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n);

const RAPIDOS: { valor: MetodoCobro; etiqueta: string }[] = [
  { valor: "efectivo", etiqueta: "Efectivo" },
  { valor: "tarjeta", etiqueta: "Tarjeta" },
  { valor: "bizum", etiqueta: "Bizum" },
];

interface Props {
  pendiente: CajaPendiente;
  sesion: CajaSesion | null;
  cobrando: boolean;
  onCobroRapido: (p: CajaPendiente, metodo: MetodoCobro) => void;
  onAbrirHoja: (p: CajaPendiente) => void;
}

export function PendienteRow({ pendiente, sesion, cobrando, onCobroRapido, onAbrirHoja }: Props) {
  const ya = pendiente.cobro;
  const ref = pendiente.importe_referencia;
  // Sin importe de referencia no hay cobro de un toque: no hay nada que poner. Va por la hoja.
  const puedeUnToque = ref != null && !!sesion && !cobrando;
  const atendioDistinta = !!pendiente.atendio && pendiente.atendio !== sesion?.stylistName;

  return (
    <Card className={`border-border/60 shadow-sm ${ya ? "opacity-60" : ""}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={() => onAbrirHoja(pendiente)}
            className="min-w-0 flex-1 text-left group"
          >
            <p className="text-[13.5px] font-semibold text-foreground truncate">
              <span className="text-muted-foreground font-normal mr-2">
                {madridTime(pendiente.starts_at)}
              </span>
              {pendiente.cliente || "Sin nombre"}
            </p>
            <p className="text-[12px] text-muted-foreground truncate">
              {pendiente.service || "Sin servicio"}
            </p>
          </button>
          <button
            type="button"
            onClick={() => onAbrirHoja(pendiente)}
            className="shrink-0 text-right"
          >
            <p className="font-heading text-[17px] font-semibold text-foreground">
              {ref != null ? eur(ref) : "—"}
            </p>
            {ref == null && (
              <p className="text-[10.5px] text-muted-foreground">sin referencia</p>
            )}
          </button>
        </div>

        {ya ? (
          <p className="mt-2.5 flex items-center gap-1.5 text-[12px] font-medium text-[oklch(0.35_0.06_160)]">
            <Check size={14} />
            Cobrado {eur(Number(ya.importe_total))} · {ya.metodo}
            {ya.atribucion === "declarada" && (
              <span className="font-normal text-muted-foreground">· declarada</span>
            )}
          </p>
        ) : (
          <>
            {/* La atribución va AQUÍ, donde está el pulgar. Un cobro de un toque con el nombre
                fuera de la vista es lo contrario del modelo. Y cuando quien atendió no es quien
                cobra, se dicen las dos: es correcto que difieran y callarlo parece un error. */}
            <p className="mt-2.5 text-[11.5px] text-muted-foreground">
              {atendioDistinta && <span>atendió {pendiente.atendio} · </span>}
              <span className="font-medium text-foreground">
                cobra {sesion?.stylistName ?? "— elige quién cobra"}
              </span>
            </p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {RAPIDOS.map((m) => (
                <Button
                  key={m.valor}
                  size="sm"
                  variant="outline"
                  className="h-10"
                  disabled={!puedeUnToque}
                  onClick={() => onCobroRapido(pendiente, m.valor)}
                >
                  {m.etiqueta}
                </Button>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
