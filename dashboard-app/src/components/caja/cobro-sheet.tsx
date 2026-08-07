"use client";

// La hoja de cobro: todo lo que NO es el caso normal.
//
// El caso normal (importe correcto, un método) se resuelve en un toque desde la fila y no pasa
// por aquí. Aquí se llega para cambiar el importe, partir un cobro mixto o vender algo sin cita.
//
// La monta tanto /caja como la cita en Reservas: un solo componente, para que cobrar sea lo
// mismo se entre por donde se entre.

import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { apiMutate } from "@/lib/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Cobro, MetodoCobro, MotivoDiferencia, Stylist } from "@/lib/types";
import { type CajaSesion, renovarToken, estilistaPorDefecto, saldraSinPin } from "@/lib/caja-session";

const METODOS: { valor: MetodoCobro; etiqueta: string }[] = [
  { valor: "efectivo", etiqueta: "Efectivo" },
  { valor: "tarjeta", etiqueta: "Tarjeta" },
  { valor: "bizum", etiqueta: "Bizum" },
  { valor: "mixto", etiqueta: "Mixto" },
];

// Chips, no texto libre: el motivo tiene que costar UNA pulsación. Las 4 correcciones manuales
// que hay hoy en la BD tienen el motivo a NULL, y por eso no significan nada.
const MOTIVOS: { valor: MotivoDiferencia; etiqueta: string }[] = [
  { valor: "propina", etiqueta: "Propina" },
  { valor: "producto", etiqueta: "Producto" },
  { valor: "descuento", etiqueta: "Descuento" },
  { valor: "servicio_extra", etiqueta: "Servicio extra" },
  { valor: "otro", etiqueta: "Otro" },
];

const eur = (n: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n);

export interface CobroContexto {
  appointmentId?: string | null;
  cliente?: string | null;
  service?: string | null;
  /** Quién ATENDIÓ. Se enseña junto a quién cobra cuando no coinciden. */
  atendio?: string | null;
  /** La estilista de la CITA: es el valor por defecto de quién cobra, no la de la sesión. */
  atendioId?: string | null;
  importeReferencia?: number | null;
  /**
   * Si la cita YA tiene un cobro vigente. Se avisa en vez de bloquear: una cita puede
   * cobrarse en dos veces (parte hoy, parte al recoger), así que impedirlo obligaría a
   * mentir. Pero cobrar dos veces sin enterarse es peor, y desde Reservas el botón de
   * cobrar no sabía nada de esto.
   */
  yaCobrado?: { importe: number; metodo: string } | null;
}

interface Props {
  contexto: CobroContexto | null;
  sesion: CajaSesion | null;
  stylists: Stylist[];
  orgId: string;
  open: boolean;
  onClose: () => void;
  onCobrado: (c: Cobro) => void;
}

export function CobroSheet({ contexto, sesion, stylists, orgId, open, onClose, onCobrado }: Props) {
  const referencia = contexto?.importeReferencia ?? null;
  // Defecto: la estilista de la CITA. En una venta sin cita no hay de dónde sacarla, así que
  // ahí se parte de la que tiene la sesión de PIN — y se puede cambiar igual.
  const [cobradoPor, setCobradoPor] = useState<string>(
    estilistaPorDefecto(contexto?.atendioId, sesion),
  );
  const [importe, setImporte] = useState<string>(referencia != null ? String(referencia) : "");
  const [efectivo, setEfectivo] = useState<string>("");
  const [metodo, setMetodo] = useState<MetodoCobro>("efectivo");
  const [motivo, setMotivo] = useState<MotivoDiferencia | null>(null);
  const [concepto, setConcepto] = useState("");
  const [nota, setNota] = useState("");
  const [guardando, setGuardando] = useState(false);

  const total = Number(importe.replace(",", "."));
  const totalValido = importe !== "" && Number.isFinite(total) && total >= 0;
  const enEfectivo = Number(efectivo.replace(",", "."));
  const restoTarjeta = totalValido && Number.isFinite(enEfectivo) ? total - enEfectivo : null;
  const difiere = referencia != null && totalValido && total !== referencia;
  const sinCita = !contexto?.appointmentId;
  const elegida = stylists.find((s) => s.id === cobradoPor);
  const sinPin = saldraSinPin(sesion, cobradoPor);

  // Mixto: solo se teclea el EFECTIVO y la tarjeta sale por resta. La tarjeta la verifica el
  // banco; el efectivo es lo único que alguien tiene que contar.
  const mixtoValido = metodo !== "mixto" || (restoTarjeta != null && enEfectivo > 0 && restoTarjeta > 0);
  const puedeGuardar = totalValido && mixtoValido && !!cobradoPor
    && (!sinCita || concepto.trim().length > 0) && !guardando;

  async function guardar() {
    if (!puedeGuardar) return;
    setGuardando(true);
    try {
      const res = await apiMutate("/api/cobros", {
        method: "POST",
        orgId,
        body: {
          appointmentId: contexto?.appointmentId ?? null,
          cobradoPor: cobradoPor || null,
          metodo,
          importeTotal: total,
          ...(metodo === "mixto" ? { importeEfectivo: enEfectivo } : {}),
          ...(sinCita ? { concepto: concepto.trim() } : {}),
          ...(difiere && motivo ? { motivoDiferencia: motivo } : {}),
          ...(nota.trim() ? { nota: nota.trim() } : {}),
          ...(sesion?.token ? { cajaToken: sesion.token } : {}),
        },
      });
      const cobro: Cobro = await res.json();
      renovarToken(cobro.cajaToken);
      onCobrado(cobro);
      onClose();
    } catch (e) {
      // apiMutate lanza con el mensaje real del servidor: nada de "guardado" inventado.
      toast.error((e as Error).message || "No se pudo registrar el cobro");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-md flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-5 border-b border-border">
          <SheetTitle className="font-heading text-[18px] font-semibold">
            {contexto?.cliente || "Venta sin cita"}
          </SheetTitle>
          {contexto?.service && (
            <p className="text-[12.5px] text-muted-foreground">{contexto.service}</p>
          )}
          {/* Quién atendió, cuando no es quien va a cobrar. Es correcto que difieran. */}
          {contexto?.atendio && contexto.atendioId !== cobradoPor && (
            <p className="text-[12px] text-muted-foreground">atendió {contexto.atendio}</p>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div>
            <Label>¿Quién cobra?</Label>
            <Select value={cobradoPor} onValueChange={(v) => setCobradoPor(v ?? "")}>
              <SelectTrigger className="h-11">
                <SelectValue placeholder="Elige quién cobra">{elegida?.name ?? null}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {stylists.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Lo que va a quedar registrado, antes de darle a cobrar. Elegir a otra NO bloquea
                nada: el cobro entra igual y se marca sin PIN, que es lo que ya hacía el
                desajuste de atribución. */}
            {sinPin && cobradoPor && (
              <p className="mt-1 text-[11.5px] text-[oklch(0.45_0.12_55)]">
                Este cobro quedará <strong>sin PIN</strong>
                {sesion?.token ? ` (el PIN activo es el de ${sesion.stylistName})` : ""}.
              </p>
            )}
          </div>

          {contexto?.yaCobrado && (
            <div role="alert" className="rounded-lg border border-[oklch(0.85_0.12_85/0.6)] bg-[oklch(0.85_0.12_85/0.12)] px-4 py-3 text-[12.5px] text-[oklch(0.45_0.12_55)]">
              Esta cita ya tiene un cobro de{" "}
              <strong>{eur(contexto.yaCobrado.importe)} en {contexto.yaCobrado.metodo}</strong>.
              Si cobras otra vez quedarán los dos. Para cambiar el importe del anterior,
              corrígelo desde Caja.
            </div>
          )}

          {sinCita && (
            <div>
              <Label htmlFor="cobro-concepto">Qué se ha vendido *</Label>
              <Input
                id="cobro-concepto"
                value={concepto}
                onChange={(e) => setConcepto(e.target.value)}
                placeholder="Ej: Champú K18, ampollas..."
              />
            </div>
          )}

          <div>
            <Label htmlFor="cobro-importe">Importe cobrado</Label>
            <Input
              id="cobro-importe"
              inputMode="decimal"
              value={importe}
              onChange={(e) => setImporte(e.target.value)}
              className="text-[22px] font-semibold h-14"
            />
            {referencia != null && (
              <p className="mt-1 text-[11.5px] text-muted-foreground">
                Catálogo: {eur(referencia)}
                {difiere && (
                  <span className="font-medium text-foreground">
                    {" "}· diferencia {total > referencia ? "+" : ""}{eur(total - referencia)}
                  </span>
                )}
              </p>
            )}
            {referencia == null && !sinCita && (
              // Se dice, no se inventa un 0: esta cita no entra en ningún descuadre.
              <p className="mt-1 text-[11.5px] text-muted-foreground">
                Esta cita no tiene importe de referencia (el servicio no resuelve en el catálogo).
              </p>
            )}
          </div>

          {difiere && (
            <div>
              <Label>¿Por qué es distinto?</Label>
              <div className="flex flex-wrap gap-2 mt-1.5">
                {MOTIVOS.map((m) => (
                  <button
                    key={m.valor}
                    type="button"
                    onClick={() => setMotivo(motivo === m.valor ? null : m.valor)}
                    className={`rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                      motivo === m.valor
                        ? "bg-primary text-primary-foreground border-transparent"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {m.etiqueta}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <Label>Método</Label>
            <div className="grid grid-cols-2 gap-2 mt-1.5">
              {METODOS.map((m) => (
                <Button
                  key={m.valor}
                  type="button"
                  variant={metodo === m.valor ? "default" : "outline"}
                  className="h-12"
                  onClick={() => setMetodo(m.valor)}
                >
                  {m.etiqueta}
                </Button>
              ))}
            </div>
          </div>

          {metodo === "mixto" && (
            <div>
              <Label htmlFor="cobro-efectivo">¿Cuánto en efectivo?</Label>
              <Input
                id="cobro-efectivo"
                inputMode="decimal"
                value={efectivo}
                onChange={(e) => setEfectivo(e.target.value)}
                className="text-[18px] font-semibold h-12"
              />
              {/* El botón se deshabilita si el mixto no lo es, pero un botón apagado sin
                  explicación no dice qué hacer. La base rechaza estos dos casos con un CHECK,
                  así que más vale decirlo aquí y en cristiano que dejarla chocar contra él. */}
              {efectivo !== "" && enEfectivo >= total && totalValido ? (
                <p className="mt-1 text-[11.5px] text-[oklch(0.45_0.12_55)]">
                  Si lo pagó todo en efectivo, elige <strong>Efectivo</strong> arriba.
                </p>
              ) : efectivo !== "" && enEfectivo <= 0 ? (
                <p className="mt-1 text-[11.5px] text-[oklch(0.45_0.12_55)]">
                  Si no puso nada en efectivo, elige <strong>Tarjeta</strong> o <strong>Bizum</strong> arriba.
                </p>
              ) : (
                <p className="mt-1 text-[11.5px] text-muted-foreground">
                  {restoTarjeta != null && restoTarjeta > 0
                    ? `Tarjeta: ${eur(restoTarjeta)}`
                    : "Solo se teclea el efectivo; la tarjeta sale por resta."}
                </p>
              )}
            </div>
          )}

          <div>
            <Label htmlFor="cobro-nota">Nota (opcional)</Label>
            <Textarea
              id="cobro-nota"
              rows={2}
              value={nota}
              onChange={(e) => setNota(e.target.value)}
            />
          </div>
        </div>

        <div className="border-t border-border px-6 py-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={guardar} disabled={!puedeGuardar}>
            {guardando ? "Registrando..." : totalValido ? `Cobrar ${eur(total)}` : "Cobrar"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
