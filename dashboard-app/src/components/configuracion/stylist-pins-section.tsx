"use client";

// PIN de caja por estilista. Sin esta sección la API de la 036 no tiene interfaz y NINGÚN cobro
// puede quedar confirmado — el PIN entero no serviría de nada.
//
// No hay recuperación, a propósito: si una estilista lo olvida, aquí se le pone otro. Un flujo
// de recuperación sería aparato de seguridad, y esto es atribución, no seguridad.

import { useCallback, useEffect, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { API, apiHeaders, apiMutate } from "@/lib/api";
import type { Stylist, StylistPinStatus } from "@/lib/types";

export function StylistPinsSection({ orgId }: { orgId: string }) {
  const [stylists, setStylists] = useState<Stylist[]>([]);
  const [conPin, setConPin] = useState<Set<string>>(new Set());
  const [cargando, setCargando] = useState(true);
  const [editando, setEditando] = useState<string | null>(null);
  const [pin, setPin] = useState("");

  const cargar = useCallback(async () => {
    if (!orgId) return;
    try {
      const cab = await apiHeaders(orgId);
      const [s, p] = await Promise.all([
        fetch(`${API}/api/stylists`, { headers: cab }),
        fetch(`${API}/api/stylists/pin-status`, { headers: cab }),
      ]);
      setStylists(s.ok ? await s.json() : []);
      const estados: StylistPinStatus[] = p.ok ? await p.json() : [];
      setConPin(new Set(estados.map((e) => e.stylist_id)));
    } finally {
      setCargando(false);
    }
  }, [orgId]);

  useEffect(() => { cargar(); }, [cargar]);

  async function guardar(stylistId: string) {
    try {
      await apiMutate(`/api/stylists/${stylistId}/pin`, { method: "PUT", orgId, body: { pin } });
      toast.success("PIN guardado");
      setEditando(null); setPin("");
      await cargar();
    } catch (e) {
      toast.error((e as Error).message || "No se pudo guardar el PIN");
    }
  }

  async function quitar(stylistId: string) {
    try {
      await apiMutate(`/api/stylists/${stylistId}/pin`, { method: "DELETE", orgId });
      toast.success("PIN retirado");
      await cargar();
    } catch (e) {
      toast.error((e as Error).message || "No se pudo retirar el PIN");
    }
  }

  return (
    <Card className="border-border/60 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <KeyRound size={16} className="text-muted-foreground" />
          <p className="font-heading text-[15px] font-semibold">PIN de caja</p>
        </div>
        <p className="text-[12px] text-muted-foreground">
          Sirve para saber quién cobró, no para dar permisos: quien no tenga PIN puede cobrar
          igual, y su cobro queda registrado como <strong>declarado</strong>. Si alguien lo
          olvida, pon otro aquí.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {cargando ? (
          <Skeleton className="h-[160px] w-full rounded-lg" />
        ) : (
          stylists.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[13px] font-medium text-foreground truncate">{s.name}</span>
                {conPin.has(s.id) ? (
                  <span className="flex items-center gap-1 text-[11.5px] text-[oklch(0.35_0.06_160)]">
                    <ShieldCheck size={12} /> con PIN
                  </span>
                ) : (
                  <span className="text-[11.5px] text-muted-foreground">sin PIN</span>
                )}
              </div>

              {editando === s.id ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    className="w-32"
                    placeholder="4 a 6 dígitos"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  />
                  <Button size="sm" disabled={pin.length < 4} onClick={() => guardar(s.id)}>Guardar</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setEditando(null); setPin(""); }}>
                    Cancelar
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setEditando(s.id); setPin(""); }}>
                    {conPin.has(s.id) ? "Cambiar" : "Poner PIN"}
                  </Button>
                  {conPin.has(s.id) && (
                    <Button size="sm" variant="ghost" onClick={() => quitar(s.id)}>Quitar</Button>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
