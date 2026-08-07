"use client";

// Los cobros del día, con el rastro de las correcciones.
//
// ── Cómo se evita rectificar por costumbre ───────────────────────────────────
// No se impide: eso sería antifraude y esto no lo es. Se hace caro de ESCONDER, en cuatro sitios:
//   1. "Corregir" vive detrás del menú `⋯`, nunca como botón principal.
//   2. **La palabra "editar" no existe en esta interfaz.** Un cobro no se toca —el trigger de la
//      035 lo impide en la base— y la pantalla no promete otra cosa.
//   3. El rectificado se queda VISIBLE, tachado y con su sustituto debajo, en el propio día.
//      No escondido en un histórico que nadie abre.
//   4. La cabecera cuenta las correcciones del día junto a los cobros.

import { useState } from "react";
import { MoreHorizontal, CornerDownRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { apiMutate } from "@/lib/api";
import type { Cobro } from "@/lib/types";
import { madridTime } from "@/lib/date";
import { type CajaSesion, renovarToken } from "@/lib/caja-session";

const eur = (n: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n);

interface Props {
  /** El histórico del día (GET /api/cobros?historial=1): incluye anulados y rectificados. */
  historial: Cobro[];
  sesion: CajaSesion | null;
  orgId: string;
  onCambio: () => void;
}

export function CobrosDelDia({ historial, sesion, orgId, onCambio }: Props) {
  const [accion, setAccion] = useState<{ cobro: Cobro; tipo: "corregir" | "anular" } | null>(null);

  const sucesorDe = new Map<string, Cobro>();
  for (const c of historial) if (c.corrige_a) sucesorDe.set(c.corrige_a, c);
  // Las cabeceras de la lista: los que NO sustituyen a nadie. El sustituto se pinta debajo del
  // suyo, para que la corrección se lea como lo que es y no como un cobro más.
  const raices = historial.filter((c) => !c.corrige_a);
  const correcciones = historial.length - raices.length;

  if (!historial.length) return null;

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border/60 bg-card shadow-sm">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <p className="text-[13px] font-semibold text-foreground">Cobros de hoy</p>
          <p className="text-[11.5px] text-muted-foreground">
            {raices.length} cobro{raices.length === 1 ? "" : "s"}
            {correcciones > 0 && ` · ${correcciones} corrección${correcciones === 1 ? "" : "es"}`}
          </p>
        </div>
        <ul className="divide-y divide-border/60">
          {raices.map((c) => {
            const sucesor = sucesorDe.get(c.id);
            const anulado = c.estado === "anulado";
            const inerte = !!sucesor || anulado;
            return (
              <li key={c.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`text-[13px] ${inerte ? "text-muted-foreground line-through" : "font-medium text-foreground"}`}>
                      {madridTime(c.cobrado_at)} · {eur(Number(c.importe_total))} {c.metodo}
                    </p>
                    <p className="text-[11.5px] text-muted-foreground truncate">
                      {c.cobrado_por_nombre ?? "sin estilista"}
                      {c.concepto ? ` · ${c.concepto}` : ""}
                      {c.atribucion === "declarada" && " · sin PIN"}
                    </p>
                    {sucesor && (
                      <p className="mt-1 flex items-start gap-1.5 text-[12px] text-foreground">
                        <CornerDownRight size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
                        <span>
                          <span className="font-medium">
                            {eur(Number(sucesor.importe_total))} {sucesor.metodo}
                          </span>
                          {sucesor.motivo_correccion && (
                            <span className="text-muted-foreground"> · «{sucesor.motivo_correccion}»</span>
                          )}
                        </span>
                      </p>
                    )}
                    {anulado && !sucesor && (
                      <p className="mt-1 text-[12px] text-muted-foreground">
                        Anulado{c.nota ? ` · «${c.nota}»` : ""}
                      </p>
                    )}
                  </div>
                  {!inerte && (
                    <DropdownMenu>
                      {/* Base UI usa `render`, no `asChild` (ver components/ui/dialog.tsx). */}
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" />}
                      >
                        <MoreHorizontal size={16} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setAccion({ cobro: c, tipo: "corregir" })}>
                          Corregir importe
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setAccion({ cobro: c, tipo: "anular" })}>
                          Anular
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {accion && (
        <AccionDialog
          {...accion}
          sesion={sesion}
          orgId={orgId}
          onClose={() => setAccion(null)}
          onHecho={() => { setAccion(null); onCambio(); }}
        />
      )}
    </>
  );
}

function AccionDialog({
  cobro, tipo, sesion, orgId, onClose, onHecho,
}: {
  cobro: Cobro;
  tipo: "corregir" | "anular";
  sesion: CajaSesion | null;
  orgId: string;
  onClose: () => void;
  onHecho: () => void;
}) {
  const corregir = tipo === "corregir";
  const [importe, setImporte] = useState(String(Number(cobro.importe_total)));
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);

  const total = Number(importe.replace(",", "."));
  // El motivo es obligatorio en las dos: sin él, la corrección no explica nada y es la mitad de
  // su valor. El servidor ya lo impone en rectificar; aquí se pide antes de molestarle.
  const puede = motivo.trim().length > 0 && (!corregir || (Number.isFinite(total) && total >= 0)) && !enviando;

  async function enviar() {
    if (!puede) return;
    setEnviando(true);
    try {
      if (corregir) {
        const res = await apiMutate(`/api/cobros/${cobro.id}/rectificar`, {
          method: "POST", orgId,
          body: {
            importeTotal: total,
            ...(cobro.metodo === "mixto" ? { importeEfectivo: Number(cobro.importe_efectivo) } : {}),
            motivoCorreccion: motivo.trim(),
            ...(sesion?.token ? { cajaToken: sesion.token } : {}),
          },
        });
        renovarToken((await res.json())?.cajaToken);
        toast.success("Corregido");
      } else {
        await apiMutate(`/api/cobros/${cobro.id}/anular`, {
          method: "POST", orgId, body: { motivo: motivo.trim() },
        });
        toast.success("Anulado");
      }
      onHecho();
    } catch (e) {
      toast.error((e as Error).message || "No se pudo completar");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{corregir ? "Corregir el importe" : "Anular el cobro"}</DialogTitle>
          <DialogDescription>
            {corregir
              ? "El cobro original no se borra: se queda anulado y a la vista, con este encima."
              : "Se anula sin sustituto. La fila se queda en el histórico del día."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {corregir && (
            <div>
              <Label htmlFor="corr-importe">Importe correcto</Label>
              <Input
                id="corr-importe"
                inputMode="decimal"
                value={importe}
                onChange={(e) => setImporte(e.target.value)}
                className="text-[18px] font-semibold h-12"
              />
              <p className="mt-1 text-[11.5px] text-muted-foreground">
                Se registró {eur(Number(cobro.importe_total))}
              </p>
            </div>
          )}
          <div>
            <Label htmlFor="corr-motivo">¿Por qué? *</Label>
            <Input
              id="corr-motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder={corregir ? "Ej: vendió champú y no lo apunté" : "Ej: no llegó a pagar"}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>Cancelar</Button>
            <Button onClick={enviar} disabled={!puede}>
              {enviando ? "Guardando..." : corregir ? "Corregir" : "Anular"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
