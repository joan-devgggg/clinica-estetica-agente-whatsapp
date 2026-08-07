"use client";

// Dar el día por revisado.
//
// Sustituye al WhatsApp que la recepcionista manda cada noche con el efectivo, el TPV y el
// total. NO es un cierre contable: es un ACUSE de que alguien ha mirado el día. La dueña dijo
// "nunca falta dinero" y que no quiere justificar diferencias, así que la pantalla no acusa a
// nadie — enseña, deja apuntar lo que hay, y se aparta.
//
// ── Abre en AYER, y eso ordena todo lo demás ─────────────────────────────────
// El TPV no aparece en el banco hasta el día siguiente, así que lo NORMAL es revisar hoy el día
// de ayer. Por eso es una pantalla aparte de /caja, que sí abre en hoy: /caja es el mostrador
// (cobrar), esto es el repaso (revisar). Mezclarlas obligaría a una de las dos a abrir en el
// día que no le toca.
//
// ── Los campos empiezan VACÍOS ───────────────────────────────────────────────
// Con el botón "Cuadra" al lado, que los rellena con lo esperado. Prerrellenarlos sería más
// cómodo y está descartado a propósito: haría que "diferencia 0" fuese lo que pasa cuando nadie
// mira, y entonces el acuse dejaría de significar que alguien miró.

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, CheckCircle2, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { API, apiHeaders, apiMutate, mensajeDeFallo, mensajeDeError } from "@/lib/api";
import { useOrg } from "@/lib/org-context";
import { addDays, diaDeCajaHoy, etiquetaDia, parseYmd, ymd } from "@/lib/date";

const eur = (n: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n);

interface Cierre {
  id: string;
  esperado_efectivo: string; esperado_tarjeta: string; esperado_total: string;
  num_cobros: number;
  contado_efectivo: string; tpv_declarado: string;
  diferencia_efectivo: string; diferencia_tarjeta: string;
  cerrado_at: string; nota: string | null;
}
interface Estado {
  fecha: string;
  revisado: boolean;
  cierre: Cierre | null;
  esperado: { efectivo: number; tarjeta: number; total: number; numCobros: number };
  movido: boolean;
  movimiento: { efectivo: number; tarjeta: number; total: number; numCobros: number } | null;
}
interface DiaPendiente { fecha: string; numCobros: number; total: number }

export default function RevisionCajaPage() {
  const { orgId, orgType } = useOrg();
  const [hoy] = useState(diaDeCajaHoy);
  // AYER por defecto. Es el caso normal, no una comodidad.
  const [fecha, setFecha] = useState(() => ymd(addDays(parseYmd(diaDeCajaHoy()), -1)));
  const [estado, setEstado] = useState<Estado | null>(null);
  const [pendientes, setPendientes] = useState<DiaPendiente[]>([]);
  const [efectivo, setEfectivo] = useState("");
  const [tpv, setTpv] = useState("");
  const [nota, setNota] = useState("");
  const [motivo, setMotivo] = useState("");
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!orgId || orgType !== "salon") return;
    try {
      const cab = await apiHeaders(orgId);
      const [e, p] = await Promise.all([
        fetch(`${API}/api/caja/cierre?fecha=${fecha}`, { headers: cab }),
        fetch(`${API}/api/caja/cierre/pendientes`, { headers: cab }),
      ]);
      const fallo = [e, p].find((x) => !x.ok);
      if (fallo) throw new Error(mensajeDeFallo(fallo.status));
      setEstado(await e.json());
      setPendientes((await p.json()).dias ?? []);
      setError(null);
    } catch (err) {
      // Es dinero: un fallo no puede leerse como "este día está sin revisar", porque invitaría
      // a revisarlo otra vez.
      setError(mensajeDeError(err));
    } finally {
      setCargando(false);
    }
  }, [orgId, orgType, fecha]);

  useEffect(() => { cargar(); }, [cargar]);

  function irA(nueva: string) {
    if (nueva === fecha || nueva > hoy) return;
    setFecha(nueva);
    setEstado(null);
    setEfectivo(""); setTpv(""); setNota(""); setMotivo("");
    setCargando(true);
  }

  async function revisar() {
    if (!estado || !puedeGuardar) return;
    setGuardando(true);
    try {
      await apiMutate("/api/caja/cierre", {
        method: "POST", orgId,
        body: {
          fecha,
          contadoEfectivo: Number(efectivo.replace(",", ".")),
          tpvDeclarado: Number(tpv.replace(",", ".")),
          ...(nota.trim() ? { nota: nota.trim() } : {}),
          ...(estado.revisado && estado.cierre
            ? { corrigeA: estado.cierre.id, motivoCorreccion: motivo.trim() || "vuelto a revisar" }
            : {}),
        },
      });
      toast.success(`${etiquetaDia(fecha, hoy)} queda revisado`);
      setEfectivo(""); setTpv(""); setNota(""); setMotivo("");
      await cargar();
    } catch (e) {
      toast.error((e as Error).message || "No se pudo guardar la revisión");
      await cargar();
    } finally {
      setGuardando(false);
    }
  }

  if (orgType !== "salon") {
    return (
      <>
        <PageHeader title="Revisión de caja" />
        <p className="p-8 text-center text-muted-foreground">La caja es solo para salón.</p>
      </>
    );
  }

  const numEfectivo = Number(efectivo.replace(",", "."));
  const numTpv = Number(tpv.replace(",", "."));
  const efectivoOk = efectivo !== "" && Number.isFinite(numEfectivo) && numEfectivo >= 0;
  const tpvOk = tpv !== "" && Number.isFinite(numTpv) && numTpv >= 0;
  const puedeGuardar = !!estado && efectivoOk && tpvOk && !guardando;
  // Se enseña ANTES de guardar, para que no haya sorpresa: la cifra que se va a apuntar.
  const difEfectivo = estado && efectivoOk ? numEfectivo - estado.esperado.efectivo : null;
  const difTpv = estado && tpvOk ? numTpv - estado.esperado.tarjeta : null;

  function cuadrar() {
    if (!estado) return;
    setEfectivo(String(estado.esperado.efectivo));
    setTpv(String(estado.esperado.tarjeta));
  }

  return (
    <>
      <PageHeader title="Revisión de caja" subtitle="Lo que entró, día a día" />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-5 px-6 py-6">
          {/* La cola. Es lo que sustituye al "¿me mandó el WhatsApp anoche?": si hay días sin
              mirar, se ven aquí antes que nada. HOY no entra — el día no ha acabado y el TPV
              no está en el banco hasta mañana. */}
          {pendientes.length > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
              <p className="text-[13px] font-semibold text-foreground">
                {pendientes.length === 1 ? "Queda 1 día sin revisar" : `Quedan ${pendientes.length} días sin revisar`}
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {pendientes.map((d) => (
                  <li key={d.fecha}>
                    <button
                      onClick={() => irA(d.fecha)}
                      className={`rounded-md border px-2.5 py-1 text-[12.5px] transition-colors hover:bg-muted ${
                        d.fecha === fecha ? "border-foreground/40 bg-muted" : "border-border"
                      }`}
                    >
                      {etiquetaDia(d.fecha, hoy)} · {eur(d.total)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Día anterior"
              onClick={() => irA(ymd(addDays(parseYmd(fecha), -1)))}>
              <ChevronLeft size={16} />
            </Button>
            <Button variant="outline" size="icon" aria-label="Día siguiente"
              disabled={fecha >= hoy}
              onClick={() => irA(ymd(addDays(parseYmd(fecha), 1)))}>
              <ChevronRight size={16} />
            </Button>
            <Input type="date" value={fecha} max={hoy}
              onChange={(e) => e.target.value && irA(e.target.value)}
              className="h-9 w-[10.5rem]" aria-label="Día a revisar" />
          </div>

          {error && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
              No se pudo cargar el día. {error}
            </div>
          )}

          {cargando ? (
            <Skeleton className="h-[320px] w-full rounded-lg" />
          ) : error || !estado ? null : (
            <>
              {/* Lo que dice el sistema. Estas tres cifras SON el WhatsApp de cada noche. */}
              <div className="rounded-lg border border-border/60 bg-card p-4 shadow-sm">
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {etiquetaDia(fecha, hoy)} · {estado.esperado.numCobros} cobro{estado.esperado.numCobros === 1 ? "" : "s"}
                </p>
                <div className="mt-3 grid grid-cols-3 gap-4">
                  <div>
                    <p className="text-[11.5px] text-muted-foreground">Efectivo</p>
                    <p className="text-lg font-semibold tabular-nums">{eur(estado.esperado.efectivo)}</p>
                  </div>
                  <div>
                    <p className="text-[11.5px] text-muted-foreground">Tarjeta y Bizum</p>
                    <p className="text-lg font-semibold tabular-nums">{eur(estado.esperado.tarjeta)}</p>
                  </div>
                  <div>
                    <p className="text-[11.5px] text-muted-foreground">Total</p>
                    <p className="text-lg font-semibold tabular-nums">{eur(estado.esperado.total)}</p>
                  </div>
                </div>
              </div>

              {/* Ya revisado: lo que se dijo entonces, tal cual. */}
              {estado.revisado && estado.cierre && (
                <div className="rounded-lg border border-emerald-600/30 bg-emerald-600/5 px-4 py-3">
                  <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                    <CheckCircle2 size={15} className="text-emerald-600" />
                    Revisado el {new Date(estado.cierre.cerrado_at).toLocaleString("es-ES", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}
                  </p>
                  <p className="mt-1.5 text-[12.5px] text-muted-foreground">
                    Se contó {eur(Number(estado.cierre.contado_efectivo))} en efectivo y {eur(Number(estado.cierre.tpv_declarado))} de TPV
                    {Number(estado.cierre.diferencia_efectivo) === 0 && Number(estado.cierre.diferencia_tarjeta) === 0
                      ? " · cuadraba"
                      : ` · diferencia ${eur(Number(estado.cierre.diferencia_efectivo))} en efectivo y ${eur(Number(estado.cierre.diferencia_tarjeta))} en TPV`}
                  </p>
                  {estado.cierre.nota && (
                    <p className="mt-1 text-[12.5px] italic text-muted-foreground">“{estado.cierre.nota}”</p>
                  )}
                </div>
              )}

              {/* MOVIDO. No se bloquea nada: se dice y se puede volver a revisar. Con el acuse
                  asíncrono esto es corriente, no una rareza. */}
              {estado.movido && estado.movimiento && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
                  <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                    <AlertTriangle size={15} className="text-amber-600" />
                    Este día se ha movido desde que se revisó
                  </p>
                  <p className="mt-1.5 text-[12.5px] text-muted-foreground">
                    {estado.movimiento.numCobros !== 0 && (
                      <>{estado.movimiento.numCobros > 0 ? "Han entrado" : "Han salido"}{" "}
                      {Math.abs(estado.movimiento.numCobros)} cobro{Math.abs(estado.movimiento.numCobros) === 1 ? "" : "s"} · </>
                    )}
                    ahora suma {eur(estado.esperado.total)} y al revisarlo sumaba {eur(Number(estado.cierre?.esperado_total ?? 0))}.
                    Puedes volver a revisarlo abajo.
                  </p>
                </div>
              )}

              {/* El formulario. Vacío, con "Cuadra" al lado. */}
              <div className="space-y-4 rounded-lg border border-border/60 bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <p className="text-[13px] font-semibold">
                    {estado.revisado ? "Volver a revisar" : "Dar el día por revisado"}
                  </p>
                  <Button variant="outline" size="sm" onClick={cuadrar}>Cuadra</Button>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="rev-efectivo">Efectivo contado</Label>
                    <Input id="rev-efectivo" inputMode="decimal" placeholder="0,00"
                      value={efectivo} onChange={(e) => setEfectivo(e.target.value)} />
                    {difEfectivo !== null && difEfectivo !== 0 && (
                      <p className="mt-1 text-[12px] text-muted-foreground">
                        {difEfectivo > 0 ? "Sobran" : "Faltan"} {eur(Math.abs(difEfectivo))}
                      </p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="rev-tpv">TPV según el banco</Label>
                    <Input id="rev-tpv" inputMode="decimal" placeholder="0,00"
                      value={tpv} onChange={(e) => setTpv(e.target.value)} />
                    {difTpv !== null && difTpv !== 0 && (
                      <p className="mt-1 text-[12px] text-muted-foreground">
                        {difTpv > 0 ? "Sobran" : "Faltan"} {eur(Math.abs(difTpv))}
                      </p>
                    )}
                  </div>
                </div>

                {estado.revisado && (
                  <div>
                    <Label htmlFor="rev-motivo">Por qué se vuelve a revisar</Label>
                    <Input id="rev-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)}
                      placeholder="Ej: entró un cobro después" />
                  </div>
                )}

                <div>
                  {/* Opcional y libre. Nada de lista cerrada de motivos: la diferencia se
                      apunta, no se justifica. */}
                  <Label htmlFor="rev-nota">Nota <span className="font-normal text-muted-foreground">(opcional)</span></Label>
                  <Textarea id="rev-nota" rows={2} value={nota} onChange={(e) => setNota(e.target.value)}
                    placeholder="Si hay algo que contar de este día" />
                </div>

                <Button className="w-full" disabled={!puedeGuardar} onClick={revisar}>
                  {guardando ? "Guardando…" : "Dar el día por revisado"}
                </Button>
                {!efectivoOk || !tpvOk ? (
                  <p className="text-center text-[12px] text-muted-foreground">
                    Escribe el efectivo contado y el TPV, o pulsa «Cuadra» si coinciden.
                  </p>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
