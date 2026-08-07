"use client";

// La pantalla del mostrador. La estilista acaba con una clienta y apunta lo que cobró sin
// buscarlo: pendientes de hoy arriba, un toque, y el día debajo.
//
// LEE Y REGISTRA, no cierra nada. El acto de dar el día por revisado —contar el cajón, apuntar
// lo que dice el banco— es otra cosa y tiene su propia pantalla (Fase C).
//
// ── El día que se mira se ELIGE ──────────────────────────────────────────────
// Abre en HOY, que es como se usa el mostrador. El selector existe porque la dueña mira la caja
// desde casa y lo que le interesa suele ser el día ANTERIOR: el TPV no aparece en su banco hasta
// el día siguiente. Hasta ahora las tres consultas iban sin fecha y caían en el default del
// servidor, así que la pantalla solo sabía enseñar hoy.
//
// Ojo con la asimetría, que está dicha en voz alta más abajo: se puede MIRAR cualquier día, pero
// un cobro que se registre entra siempre en la caja de HOY (`fecha_caja` la pone el servidor con
// `diaDeCajaHoy`). Es lo correcto —el dinero entra hoy— y sería una sorpresa si no se dijera.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, PackagePlus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { EstilistaActivaBar } from "@/components/caja/estilista-activa-bar";
import { PendienteRow } from "@/components/caja/pendiente-row";
import { ResumenDia } from "@/components/caja/resumen-dia";
import { CobrosDelDia } from "@/components/caja/cobros-del-dia";
import { CobroSheet, type CobroContexto } from "@/components/caja/cobro-sheet";
import { Input } from "@/components/ui/input";
import { API, apiHeaders, apiMutate, mensajeDeFallo, mensajeDeError } from "@/lib/api";
import { useOrg } from "@/lib/org-context";
import { leerSesion, renovarToken, type CajaSesion } from "@/lib/caja-session";
import { addDays, diaDeCajaHoy, etiquetaDia, parseYmd, ymd } from "@/lib/date";
import type { CajaPendiente, CajaResumen, Cobro, MetodoCobro, Stylist } from "@/lib/types";

export default function CajaPage() {
  const { orgId, orgType } = useOrg();
  // El día de caja de Madrid, no el del navegador: el servidor agrupa por `fecha_caja`, que es
  // un DATE de Madrid. Con la zona del navegador, alguien fuera de España pediría otro día.
  const [hoy] = useState(diaDeCajaHoy);
  const [fecha, setFecha] = useState(hoy);
  const esHoy = fecha === hoy;
  const [sesion, setSesion] = useState<CajaSesion | null>(null);
  const [stylists, setStylists] = useState<Stylist[]>([]);
  const [pendientes, setPendientes] = useState<CajaPendiente[]>([]);
  const [resumen, setResumen] = useState<CajaResumen | null>(null);
  const [historial, setHistorial] = useState<Cobro[]>([]);
  // Quién tiene PIN dado de alta. Sin esto la barra ofrece "Entrar con PIN" aunque no exista
  // ninguno, y ese botón solo puede acabar en "PIN incorrecto".
  const [conPin, setConPin] = useState<Set<string>>(new Set());
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cobrando, setCobrando] = useState<string | null>(null);
  /** Citas con un cobro EN VUELO. Ref y no estado: tiene que ganarle al doble toque. */
  const enVuelo = useRef<Set<string>>(new Set());
  const [hoja, setHoja] = useState<CobroContexto | null>(null);

  // sessionStorage solo existe en el navegador: se lee tras montar, no durante el render.
  useEffect(() => { setSesion(leerSesion()); }, []);

  const cargar = useCallback(async () => {
    if (!orgId || orgType !== "salon") return;
    try {
      const cab = await apiHeaders(orgId);
      const [p, r, h, s, pin] = await Promise.all([
        fetch(`${API}/api/caja/pendientes?fecha=${fecha}`, { headers: cab }),
        fetch(`${API}/api/caja/resumen?fecha=${fecha}`, { headers: cab }),
        fetch(`${API}/api/cobros?historial=1&desde=${fecha}&hasta=${fecha}`, { headers: cab }),
        fetch(`${API}/api/stylists`, { headers: cab }),
        fetch(`${API}/api/stylists/pin-status`, { headers: cab }),
      ]);
      // `s` (estilistas) entra en la comprobación como las demás. Antes era
      // `s.ok ? await s.json() : []`, y un fallo dejaba el selector VACÍO: parecía que el
      // salón no tuviera estilistas, no que la lista no hubiera cargado. Sin ella no se
      // puede elegir quién cobra, así que callarlo bloquea la caja sin decir por qué.
      const fallo = [p, r, h, s, pin].find((x) => !x.ok);
      if (fallo) throw new Error(mensajeDeFallo(fallo.status));
      setPendientes((await p.json()).citas ?? []);
      setResumen(await r.json());
      setHistorial((await h.json()).cobros ?? []);
      setStylists(await s.json());
      setConPin(new Set(((await pin.json()) as { stylist_id: string }[]).map((e) => e.stylist_id)));
      setError(null);
    } catch (e) {
      // Es dinero: un fallo NO puede leerse como "hoy no hay nada que cobrar" ni como caja a 0.
      setError(mensajeDeError(e));
    } finally {
      setCargando(false);
    }
  }, [orgId, orgType, fecha]);

  useEffect(() => { cargar(); }, [cargar]);

  // ── El cobro de un toque ──────────────────────────────────────────────────
  // Va con DESHACER, y las dos cosas se sostienen la una a la otra: el un-toque asume el riesgo
  // de tocar la fila equivocada, y eso solo es asumible porque se puede deshacer. Y el deshacer
  // es honesto porque ANULA —deja la fila anulada, a la vista— en vez de borrar.
  // `cobradoPor` viene de la FILA, no de la sesión: la sesión solo aporta el PIN. Sin sesión
  // se cobra igual (queda sin PIN) — el cobro no se bloquea nunca.
  async function cobroRapido(p: CajaPendiente, metodo: MetodoCobro, cobradoPor: string) {
    if (!cobradoPor || p.importe_referencia == null) return;
    // Guarda SÍNCRONA contra el doble toque. `setCobrando` es estado de React y no surte
    // efecto hasta el siguiente render, así que dos toques rápidos en la misma fila pasaban
    // los dos por aquí y creaban DOS cobros. Un `useRef` se actualiza en el acto y gana esa
    // carrera; el estado sigue existiendo solo para pintar el botón deshabilitado.
    if (enVuelo.current.has(p.appointment_id)) return;
    enVuelo.current.add(p.appointment_id);
    setCobrando(p.appointment_id);
    try {
      const res = await apiMutate("/api/cobros", {
        method: "POST", orgId,
        body: {
          appointmentId: p.appointment_id,
          cobradoPor,
          metodo,
          importeTotal: p.importe_referencia,
          ...(sesion?.token ? { cajaToken: sesion.token } : {}),
        },
      });
      const cobro: Cobro = await res.json();
      renovarToken(cobro.cajaToken);
      setSesion(leerSesion());
      await cargar();

      // El aviso dice lo que el servidor GUARDÓ, no lo que se envió. Cantar el importe local
      // sería afirmar sin verificar: si por lo que fuera se guardara otra cosa, ella leería la
      // cifra que quería ver. Igual con la atribución — así se entera en el momento de que un
      // cobro quedó declarada, no días después mirando el resumen.
      toast.success(`Cobrado ${Number(cobro.importe_total)} € · ${cobro.metodo}`, {
        // 15 s y no 8: el deshacer se usa con una clienta delante, y 8 segundos se van en
        // mirar la pantalla y entender lo que pone. Si se pierde, queda ⋯ → Anular.
        duration: 15000,
        description: `${p.cliente ?? ""} · cobra ${cobro.cobrado_por_nombre ?? "—"}`
          + (cobro.atribucion === "declarada" ? " · sin PIN" : ""),
        action: { label: "Deshacer", onClick: () => deshacer(cobro.id) },
      });
    } catch (e) {
      // Si la red se cae DESPUÉS de que el servidor haya escrito, el cobro existe y aquí solo
      // se ve el error. Por eso se recarga: que el estado real esté delante antes de que
      // decida volver a cobrar, o acabaría con dos cobros de la misma cita.
      toast.error(
        `${(e as Error).message || "No se pudo registrar el cobro"} — mira abajo si ha entrado antes de volver a cobrar.`,
      );
      await cargar();
    } finally {
      enVuelo.current.delete(p.appointment_id);
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

  // Las que YA han pasado, arriba. A media tarde las que se van a cobrar son las de hace un
  // rato, y en orden ascendente quedaban al final de la lista, debajo de las de la noche.
  // Dentro de cada grupo se mantiene la hora ascendente, que es como se piensa una jornada.
  const ahora = Date.now();
  const porCobrar = pendientes
    .filter((p) => !p.cobro)
    .sort((a, b) => {
      const pasadaA = new Date(a.starts_at).getTime() <= ahora;
      const pasadaB = new Date(b.starts_at).getTime() <= ahora;
      if (pasadaA !== pasadaB) return pasadaA ? -1 : 1;
      return a.starts_at.localeCompare(b.starts_at);
    });

  // Cambiar de día vacía lo que hay en pantalla. Sin esto se quedarían las cifras del día
  // anterior bajo el rótulo del nuevo durante el fetch, y son cifras de dinero: un instante
  // enseñando el total de ayer como si fuera el de hoy ya es haberlo dicho mal.
  function irA(nueva: string) {
    if (nueva === fecha || nueva > hoy) return;
    setFecha(nueva);
    setResumen(null);
    setPendientes([]);
    setHistorial([]);
    setCargando(true);
  }

  return (
    <>
      <PageHeader title="Caja" subtitle={esHoy ? "Lo que entra hoy" : `Lo que entró ${etiquetaDia(fecha, hoy)}`}>
        {/* Ya no depende de la sesión: quién cobra se elige en la hoja. */}
        <Button size="sm" variant="outline" onClick={() => setHoja({})}>
          <PackagePlus size={14} className="mr-1.5" />
          Venta sin cita
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-6 py-6">
          {/* Selector de día. `max={hoy}` porque una caja del futuro no existe: no hay nada que
              mirar y el resumen saldría a 0, que en dinero se lee como "no entró nada". */}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Día anterior"
              onClick={() => irA(ymd(addDays(parseYmd(fecha), -1)))}>
              <ChevronLeft size={16} />
            </Button>
            <Button variant="outline" size="icon" aria-label="Día siguiente"
              disabled={esHoy}
              onClick={() => irA(ymd(addDays(parseYmd(fecha), 1)))}>
              <ChevronRight size={16} />
            </Button>
            <Input
              type="date"
              value={fecha}
              max={hoy}
              onChange={(e) => e.target.value && irA(e.target.value)}
              className="h-9 w-[10.5rem]"
              aria-label="Día de caja"
            />
            {!esHoy && (
              <Button variant="ghost" size="sm" onClick={() => irA(hoy)}>Volver a hoy</Button>
            )}
          </div>

          {/* Un cobro registrado ahora entra en la caja de HOY, la ponga el servidor con
              `diaDeCajaHoy()`. Es lo correcto —el dinero entra hoy— pero desde un día pasado
              sería una sorpresa: se cobraría una cita del día que se mira y el importe no
              aparecería en el resumen de abajo. Se dice antes, no después. */}
          {!esHoy && (
            <p className="rounded-md border border-border bg-muted/40 px-4 py-2.5 text-[13px] text-muted-foreground">
              Estás viendo <span className="font-medium text-foreground">{etiquetaDia(fecha, hoy)}</span>.
              Si registras un cobro ahora, entrará en la caja de hoy — no en la de este día.
            </p>
          )}

          <EstilistaActivaBar
            sesion={sesion}
            stylists={stylists}
            conPin={conPin}
            orgId={orgId}
            onCambio={setSesion}
          />

          {error && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
              No se pudo cargar la caja. {error}
            </div>
          )}

          {/* Con error NO se pinta nada más. Si no, saldría el aviso rojo Y "no queda ninguna
              cita por cobrar" a la vez: un cero que no se sabe si es un día tranquilo o una
              caja que no ha cargado. En dinero eso no se puede dejar a interpretación. */}
          {cargando ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[120px] w-full rounded-lg" />)}
            </div>
          ) : error ? null : (
            <>
              <section className="space-y-3">
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Pendientes de cobrar ({porCobrar.length})
                </p>
                {porCobrar.length === 0 ? (
                  <p className="py-8 text-center text-[13px] text-muted-foreground">
                    {esHoy
                      ? "No queda ninguna cita de hoy por cobrar"
                      : `No quedó ninguna cita de ${etiquetaDia(fecha, hoy)} sin cobrar`}
                  </p>
                ) : (
                  porCobrar.map((p) => (
                    <PendienteRow
                      key={p.appointment_id}
                      pendiente={p}
                      sesion={sesion}
                      stylists={stylists}
                      cobrando={cobrando === p.appointment_id}
                      onCobroRapido={cobroRapido}
                      onAbrirHoja={(x) => setHoja({
                        appointmentId: x.appointment_id,
                        cliente: x.cliente,
                        service: x.service,
                        atendio: x.atendio,
                        atendioId: x.atendio_id,
                        importeReferencia: x.importe_referencia,
                        yaCobrado: x.cobro
                          ? { importe: Number(x.cobro.importe_total), metodo: x.cobro.metodo }
                          : null,
                      })}
                    />
                  ))
                )}
              </section>

              {resumen && <ResumenDia resumen={resumen} />}

              <CobrosDelDia
                historial={historial}
                fecha={fecha}
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
        stylists={stylists}
        orgId={orgId}
        open={!!hoja}
        onClose={() => setHoja(null)}
        onCobrado={async (c) => {
          setSesion(leerSesion());
          await cargar();
          toast.success("Cobro registrado", {
            // 15 s y no 8: el deshacer se usa con una clienta delante, y 8 segundos se van en
        // mirar la pantalla y entender lo que pone. Si se pierde, queda ⋯ → Anular.
        duration: 15000,
            action: { label: "Deshacer", onClick: () => deshacer(c.id) },
          });
        }}
      />
    </>
  );
}
