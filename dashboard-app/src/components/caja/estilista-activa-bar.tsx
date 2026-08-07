"use client";

// Quién está cobrando, siempre a la vista y siempre arriba.
//
// En un modelo de atribución la protección es que sea VISIBLE, no que esté cerrado. Esta barra
// dice dos cosas sin que haya que buscarlas: a quién se van a atribuir los cobros, y si esa
// atribución va a constar (PIN metido) o solo declararse.
//
// Que se vea ANTES de cobrar y no después en un informe: enterarse de que un día entero quedó
// declarado al mirar el resumen es exactamente lo que hace que la marca no sirva de nada.

import { useState } from "react";
import { UserRound, ShieldCheck, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { apiMutate } from "@/lib/api";
import type { Stylist } from "@/lib/types";
import { type CajaSesion, escribirSesion } from "@/lib/caja-session";

interface Props {
  sesion: CajaSesion | null;
  stylists: Stylist[];
  orgId: string;
  onCambio: (s: CajaSesion) => void;
}

export function EstilistaActivaBar({ sesion, stylists, orgId, onCambio }: Props) {
  const [abierto, setAbierto] = useState(false);
  const confirmada = !!sesion?.token;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-card px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3 min-w-0">
          <UserRound size={18} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">
              Cobra
            </p>
            <p className="font-heading text-[19px] font-semibold leading-tight text-foreground truncate">
              {sesion?.stylistName ?? "Nadie todavía"}
            </p>
          </div>
          {sesion && (
            confirmada ? (
              <span className="flex items-center gap-1.5 rounded-full bg-[oklch(0.78_0.04_160/0.18)] px-2.5 py-1 text-[11.5px] font-medium text-[oklch(0.35_0.06_160)]">
                <ShieldCheck size={13} /> PIN
              </span>
            ) : (
              // Sin PIN NO se bloquea nada: se avisa de qué va a quedar registrado.
              <span className="flex items-center gap-1.5 rounded-full bg-[oklch(0.85_0.12_85/0.28)] px-2.5 py-1 text-[11.5px] font-medium text-[oklch(0.45_0.12_55)]">
                <ShieldAlert size={13} /> sin PIN — quedará como declarada
              </span>
            )
          )}
        </div>
        <Button variant={sesion ? "outline" : "default"} size="sm" onClick={() => setAbierto(true)}>
          {sesion ? "Cambiar" : "Elegir estilista"}
        </Button>
      </div>

      {abierto && (
        <CambiarEstilistaDialog
          stylists={stylists}
          orgId={orgId}
          actual={sesion?.stylistId ?? ""}
          onClose={() => setAbierto(false)}
          onHecho={(s) => { onCambio(s); setAbierto(false); }}
        />
      )}
    </>
  );
}

function CambiarEstilistaDialog({
  stylists, orgId, actual, onClose, onHecho,
}: {
  stylists: Stylist[];
  orgId: string;
  actual: string;
  onClose: () => void;
  onHecho: (s: CajaSesion) => void;
}) {
  const [stylistId, setStylistId] = useState(actual);
  const [pin, setPin] = useState("");
  const [enviando, setEnviando] = useState(false);
  const elegida = stylists.find((s) => s.id === stylistId);

  // Entrar SIN PIN es un camino de primera clase, con su propio botón: si sin PIN no se pudiera
  // cobrar, el día que alguien lo olvide el dinero no se apunta — o se apunta bajo el nombre
  // que ya estuviera puesto, que es peor porque nadie lo nota.
  function entrarSinPin() {
    if (!elegida) return;
    const s: CajaSesion = { stylistId: elegida.id, stylistName: elegida.name, token: null, expiraEn: null };
    escribirSesion(s);
    onHecho(s);
  }

  async function entrarConPin(e: React.FormEvent) {
    e.preventDefault();
    if (!elegida) return;
    setEnviando(true);
    try {
      // apiMutate y no `fetch` a pelo: lanza con el mensaje REAL del servidor. Antes se
      // traducía el 401 a "PIN incorrecto" y todo lo demás a un genérico, así que un
      // DASHBOARD_API_SECRET sin configurar —que hace imposible confirmar NINGUNA
      // atribución— se leía como "no se pudo abrir la sesión" y nadie sabía por qué.
      // El 401 del servidor ya dice "PIN incorrecto" y no distingue "PIN mal" de "sin PIN",
      // que es deliberado: distinguirlos enseñaría a quién se puede atribuir sin más.
      const res = await apiMutate("/api/caja/sesion", {
        method: "POST", orgId,
        body: { stylistId: elegida.id, pin },
      });
      const { token, minutos } = await res.json();
      const s: CajaSesion = {
        stylistId: elegida.id,
        stylistName: elegida.name,
        token,
        expiraEn: Date.now() + (Number(minutos) || 30) * 60_000,
      };
      escribirSesion(s);
      onHecho(s);
      toast.success(`Cobra ${elegida.name}`);
    } catch (err) {
      toast.error((err as Error).message || "No se pudo abrir la sesión de caja");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>¿Quién cobra?</DialogTitle>
          <DialogDescription>
            Con PIN, el cobro queda confirmado. Sin PIN se registra igual, como declarado.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={entrarConPin} className="space-y-4">
          <div>
            <Label>Estilista</Label>
            <Select value={stylistId} onValueChange={(v) => setStylistId(v ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder="Seleccionar...">{elegida?.name ?? null}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {stylists.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="caja-pin">PIN</Label>
            <Input
              id="caja-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              placeholder="4 a 6 dígitos"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
          </div>
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-between">
            <Button type="button" variant="ghost" disabled={!elegida} onClick={entrarSinPin}>
              Entrar sin PIN
            </Button>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
              <Button type="submit" disabled={enviando || !elegida || pin.length < 4}>
                {enviando ? "Comprobando..." : "Entrar"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
