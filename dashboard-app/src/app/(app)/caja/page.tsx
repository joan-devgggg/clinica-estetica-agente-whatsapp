"use client";

// La pantalla del mostrador. La estilista acaba con una clienta y apunta lo que cobró sin
// buscarlo: pendientes de hoy arriba, un toque, y el día debajo.
//
// LEE Y REGISTRA, no cierra nada. El acto de cerrar el día —contar el cajón, fijar la
// diferencia, dejar el día cerrado— es otra cosa, tiene su propio diseño sin decidir, y no se
// pre-empt aquí.

import { useCallback, useEffect, useState } from "react";
import { PackagePlus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { EstilistaActivaBar } from "@/components/caja/estilista-activa-bar";
import { PendienteRow } from "@/components/caja/pendiente-row";
import { ResumenDia } from "@/components/caja/resumen-dia";
import { CobrosDelDia } from "@/components/caja/cobros-del-dia";
import { CobroSheet, type CobroContexto } from "@/components/caja/cobro-sheet";
import { API, apiHeaders, apiMutate } from "@/lib/api";
import { useOrg } from "@/lib/org-context";
import { leerSesion, renovarToken, type CajaSesion } from "@/lib/caja-session";
import type { CajaPendiente, CajaResumen, Cobro, MetodoCobro, Stylist } from "@/lib/types";

export default function CajaPage() {
  const { orgId, orgType } = useOrg();
  const [sesion, setSesion] = useState<CajaSesion | null>(null);
  const [stylists, setStylists] = useState<Stylist[]>([]);
  const [pendientes, setPendientes] = useState<CajaPendiente[]>([]);
  const [resumen, setResumen] = useState<CajaResumen | null>(null);
  const [historial, setHistorial] = useState<Cobro[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cobrando, setCobrando] = useState<string | null>(null);
  const [hoja, setHoja] = useState<CobroContexto | null>(null);

  // sessionStorage solo existe en el navegador: se lee tras montar, no durante el render.
  useEffect(() => { setSesion(leerSesion()); }, []);

  const cargar = useCallback(async () => {
    if (!orgId || orgType !== "salon") return;
    try {
      const cab = await apiHeaders(orgId);
      const [p, r, h, s] = await Promise.all([
        fetch(`${API}/api/caja/pendientes`, { headers: cab }),
        fetch(`${API}/api/caja/resumen`, { headers: cab }),
        fetch(`${API}/api/cobros?historial=1`, { headers: cab }),
        fetch(`${API}/api/stylists`, { headers: cab }),
      ]);
      if (!p.ok || !r.ok || !h.ok) throw new Error(`La API respondió ${[p, r, h].find(x => !x.ok)!.status}`);
      setPendientes((await p.json()).citas ?? []);
      setResumen(await r.json());
      setHistorial((await h.json()).cobros ?? []);
      setStylists(s.ok ? await s.json() : []);
      setError(null);
    } catch (e) {
      // Es dinero: un fallo NO puede leerse como "hoy no hay nada que cobrar" ni como caja a 0.
      setError(e instanceof Error && e.message !== "Failed to fetch"
        ? e.message
        : "No se pudo contactar con la API.");
    } finally {
      setCargando(false);
    }
  }, [orgId, orgType]);

  useEffect(() => { cargar(); }, [cargar]);

  // ── El cobro de un toque ──────────────────────────────────────────────────
  // Va con DESHACER, y las dos cosas se sostienen la una a la otra: el un-toque asume el riesgo
  // de tocar la fila equivocada, y eso solo es asumible porque se puede deshacer. Y el deshacer
  // es honesto porque ANULA —deja la fila anulada, a la vista— en vez de borrar.
  async function cobroRapido(p: CajaPendiente, metodo: MetodoCobro) {
    if (!sesion || p.importe_referencia == null) return;
    setCobrando(p.appointment_id);
    try {
      const res = await apiMutate("/api/cobros", {
        method: "POST", orgId,
        body: {
          appointmentId: p.appointment_id,
          cobradoPor: sesion.stylistId,
          metodo,
          importeTotal: p.importe_referencia,
          ...(sesion.token ? { cajaToken: sesion.token } : {}),
        },
      });
      const cobro: Cobro = await res.json();
      renovarToken(cobro.cajaToken);
      setSesion(leerSesion());
      await cargar();

      toast.success(`Cobrado ${p.importe_referencia} € · ${metodo}`, {
        duration: 8000,
        description: `${p.cliente ?? ""} · cobra ${sesion.stylistName}`,
        action: { label: "Deshacer", onClick: () => deshacer(cobro.id) },
      });
    } catch (e) {
      toast.error((e as Error).message || "No se pudo registrar el cobro");
    } finally {
      setCobrando(null);
    }
  }

  async function deshacer(cobroId: string) {
    try {
      await apiMutate(`/api/cobros/${cobroId}/anular`, {
        method: "POST", orgId, body: { motivo: "deshecho al registrarlo" },
      });
      toast.success("Deshecho");
      await cargar();
    } catch (e) {
      toast.error((e as Error).message || "No se pudo deshacer");
    }
  }

  if (orgType !== "salon") {
    return (
      <>
        <PageHeader title="Caja" />
        <p className="p-8 text-center text-muted-foreground">La caja es solo para salón.</p>
      </>
    );
  }

  const porCobrar = pendientes.filter((p) => !p.cobro);

  return (
    <>
      <PageHeader title="Caja" subtitle="Lo que entra hoy">
        <Button size="sm" variant="outline" onClick={() => setHoja({})} disabled={!sesion}>
          <PackagePlus size={14} className="mr-1.5" />
          Cobro suelto
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-6 py-6">
          <EstilistaActivaBar
            sesion={sesion}
            stylists={stylists}
            orgId={orgId}
            onCambio={setSesion}
          />

          {error && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
              No se pudo cargar la caja. {error}
            </div>
          )}

          {cargando ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[120px] w-full rounded-lg" />)}
            </div>
          ) : (
            <>
              <section className="space-y-3">
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Pendientes de cobrar ({porCobrar.length})
                </p>
                {porCobrar.length === 0 ? (
                  <p className="py-8 text-center text-[13px] text-muted-foreground">
                    No queda ninguna cita de hoy por cobrar
                  </p>
                ) : (
                  porCobrar.map((p) => (
                    <PendienteRow
                      key={p.appointment_id}
                      pendiente={p}
                      sesion={sesion}
                      cobrando={cobrando === p.appointment_id}
                      onCobroRapido={cobroRapido}
                      onAbrirHoja={(x) => setHoja({
                        appointmentId: x.appointment_id,
                        cliente: x.cliente,
                        service: x.service,
                        atendio: x.atendio,
                        importeReferencia: x.importe_referencia,
                      })}
                    />
                  ))
                )}
              </section>

              {resumen && <ResumenDia resumen={resumen} />}

              <CobrosDelDia
                historial={historial}
                sesion={sesion}
                orgId={orgId}
                onCambio={cargar}
              />
            </>
          )}
        </div>
      </div>

      <CobroSheet
        // key: reinicia el formulario al cambiar de cita, en vez de arrastrar el importe anterior.
        key={hoja?.appointmentId ?? "suelto"}
        contexto={hoja}
        sesion={sesion}
        orgId={orgId}
        open={!!hoja}
        onClose={() => setHoja(null)}
        onCobrado={async (c) => {
          setSesion(leerSesion());
          await cargar();
          toast.success("Cobro registrado", {
            duration: 8000,
            action: { label: "Deshacer", onClick: () => deshacer(c.id) },
          });
        }}
      />
    </>
  );
}
