"use client";

import { useEffect, useState, useCallback, Fragment } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronLeft, ChevronRight, AlertTriangle, ChevronDown, ChevronUp, Pencil } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/lib/org-context";
import { API, apiHeaders, apiMutate } from "@/lib/api";
import { ymd, madridDateKey } from "@/lib/date";

// ─── Rangos de periodo ────────────────────────────────────────────────────────

function getWeekRange(offset: number) {
  const now = new Date();
  const day = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + 1 + offset * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    start: ymd(monday),
    end: ymd(sunday),
    label: `${monday.toLocaleDateString("es-ES", { day: "numeric", month: "short" })} — ${sunday.toLocaleDateString("es-ES", { day: "numeric", month: "short" })}`,
  };
}

function getMonthRange(offset: number) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const last = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  return {
    start: ymd(first),
    end: ymd(last),
    label: first.toLocaleDateString("es-ES", { month: "long", year: "numeric" }),
  };
}

// ─── Tipos del informe (lo que devuelve GET /api/facturacion) ─────────────────

type SegmentStatus = "ok" | "unpriced" | "unmatched" | "ambiguous";

// De dónde sale el importe de una cita. Lo decide el backend (helpers.js) y es la ÚNICA
// fuente para lo que pinta esta pantalla: el panel no recalcula dinero ni deduce precedencia.
//   manual       → lo fijó una persona; manda sobre todo lo demás
//   congelado    → snapshot del momento de completar la cita
//   divergente   → hay snapshot, pero el `service` cambió después: no se suma, hay que revisar
//   calculado    → recálculo en vivo contra el catálogo
//   sin_calcular → no se pudo valorar (sin precio, sin match o nombre ambiguo)
type BillingOrigen = "manual" | "congelado" | "divergente" | "calculado" | "sin_calcular";

interface BillingSegment {
  name: string;
  precio: number | null;
  status: SegmentStatus;
}

interface BillingCita {
  appointment_id: string;
  cliente: string | null;
  service: string | null;
  starts_at: string | null;
  precio: number | null;
  calculable: boolean;
  congelado: boolean;
  origen: BillingOrigen;
  // Lo que daría el catálogo hoy (null si no se puede valorar). Viene SIEMPRE, gane la rama
  // que gane, justamente para que esta pantalla no tenga que calcularlo por su cuenta a
  // partir del catálogo que ya tiene cargado en otras vistas.
  precio_calculado: number | null;
  precio_manual_motivo: string | null;
  precio_manual_at: string | null;
  servicio_facturado: string | null;
  segments: BillingSegment[];
}

interface BillingStylist {
  stylist_id: string | null;
  stylist_name: string | null;
  numCitas: number;
  sinCalcular: number;
  numDivergentes: number;
  numManuales: number;
  totalConIva: number;
  totalSinIva: number;
  iva: number;
  citas: BillingCita[];
}

interface BillingStylistOption {
  stylist_id: string;
  stylist_name: string | null;
}

interface BillingReport {
  estilistas: BillingStylist[];
  totales: { totalConIva: number; totalSinIva: number; iva: number; numCitas: number };
  sinCalcularTotal: number;
  // Citas cuyo servicio se editó DESPUÉS de facturarse. Contador aparte de sinCalcularTotal
  // a propósito: "el servicio cambió" y "no supe calcularlo" son avisos distintos, y
  // fusionarlos haría que los dos banners dijeran algo que no es.
  divergentesTotal: number;
  manualesTotal: number;
  ivaRate: number;
  // Opciones del selector: las estilistas activas de la org + las que tengan citas en el
  // periodo + "Sin estilista asignada". No dependen del filtro aplicado.
  estilistasDisponibles: BillingStylistOption[];
  stylistFiltro: string | null;
}

// Centinela del grupo "citas sin estilista asignada" (mismo valor en helpers.js y en la API).
const NO_STYLIST_KEY = "__sin_estilista__";

const eur = (n: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n);

export default function FacturacionPage() {
  const [periodMode, setPeriodMode] = useState<"week" | "month">("week");
  const [offset, setOffset] = useState(0);
  const [report, setReport] = useState<BillingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [stylistFilter, setStylistFilter] = useState<string>("all");
  // Las opciones viven aparte del informe: si una carga falla, el selector no puede
  // vaciarse y aparentar "Todas las estilistas" mientras hay un filtro aplicado.
  const [stylistOptions, setStylistOptions] = useState<BillingStylistOption[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Cita cuyo importe se está corrigiendo a mano (null = diálogo cerrado).
  const [editando, setEditando] = useState<BillingCita | null>(null);

  const { orgId } = useOrg();
  const range = periodMode === "week" ? getWeekRange(offset) : getMonthRange(offset);

  // El filtro por estilista se aplica en el servidor: el informe que llega ya es el de la
  // estilista elegida (mismos importes que su fila en "todas"). El panel no recalcula dinero.
  const loadData = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const filtro = stylistFilter === "all" ? "" : `&stylist=${encodeURIComponent(stylistFilter)}`;
      const res = await fetch(
        `${API}/api/facturacion?desde=${range.start}&hasta=${range.end}${filtro}`,
        { headers: await apiHeaders(orgId) }
      );
      if (!res.ok) throw new Error();
      const data: BillingReport = await res.json();
      setReport(data);
      if (data.estilistasDisponibles?.length) setStylistOptions(data.estilistasDisponibles);
    } catch {
      toast.error("Error cargando la facturación");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [orgId, range.start, range.end, stylistFilter]);

  useEffect(() => { loadData(); }, [loadData]);

  // Al cambiar de semana a mes, reseteamos el offset (no son comparables).
  function switchMode(mode: "week" | "month") {
    setPeriodMode(mode);
    setOffset(0);
  }

  const rows = report?.estilistas ?? [];
  const visibleTotals = report?.totales;
  const visibleSinCalcular = report?.sinCalcularTotal ?? 0;
  const visibleDivergentes = report?.divergentesTotal ?? 0;
  // Las dos cosas que piden intervención, en un solo número. Los avisos de debajo siguen
  // separados porque la acción que toca en cada caso no es la misma.
  const visibleARevisar = visibleSinCalcular + visibleDivergentes;
  const ivaPct = Math.round((report?.ivaRate ?? 0.21) * 100);

  const selectedName =
    stylistFilter === "all"
      ? null
      : stylistOptions.find(o => o.stylist_id === stylistFilter)?.stylist_name ?? null;

  function toggle(id: string) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <>
      <PageHeader title="Facturación" subtitle="Por estilista · citas completadas" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-6 py-6 space-y-4">
          {/* Controles: modo periodo + navegación + filtro estilista */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {/* Toggle semana / mes */}
              <div className="flex rounded-lg border border-border p-0.5">
                <button
                  onClick={() => switchMode("week")}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    periodMode === "week" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Semana
                </button>
                <button
                  onClick={() => switchMode("month")}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    periodMode === "month" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Mes
                </button>
              </div>

              {/* Navegación anterior / siguiente */}
              <Button variant="outline" size="icon" onClick={() => setOffset(o => o - 1)}>
                <ChevronLeft size={16} />
              </Button>
              <span className="text-sm font-medium min-w-[170px] text-center capitalize">
                {range.label}
              </span>
              <Button variant="outline" size="icon" onClick={() => setOffset(o => o + 1)}>
                <ChevronRight size={16} />
              </Button>
              {offset !== 0 && (
                <Button variant="ghost" size="sm" onClick={() => setOffset(0)}>
                  Hoy
                </Button>
              )}
            </div>

            {/* Filtro estilista */}
            <Select value={stylistFilter} onValueChange={v => setStylistFilter(v ?? "all")}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Todas las estilistas" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas las estilistas</SelectItem>
                {stylistOptions.map(o => (
                  <SelectItem key={o.stylist_id} value={o.stylist_id}>
                    {o.stylist_name ??
                      (o.stylist_id === NO_STYLIST_KEY ? "Sin estilista asignada" : "—")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* KPIs */}
          {loading ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[110px] w-full rounded-lg" />)}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard label="Total con IVA" value={eur(visibleTotals?.totalConIva ?? 0)} />
              <KpiCard label="Base sin IVA" value={eur(visibleTotals?.totalSinIva ?? 0)} />
              <KpiCard label="Citas completadas" value={String(visibleTotals?.numCitas ?? 0)} />
              <KpiCard
                label="Citas a revisar"
                value={String(visibleARevisar)}
                highlight={visibleARevisar > 0}
              />
            </div>
          )}

          {/* Aviso citas sin calcular */}
          {!loading && visibleSinCalcular > 0 && (
            <div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" />
              <p className="text-sm text-destructive">
                {visibleSinCalcular === 1
                  ? "1 cita no se ha podido calcular automáticamente"
                  : `${visibleSinCalcular} citas no se han podido calcular automáticamente`}
                {" "}(servicio sin precio fijo o no encontrado en el catálogo). Haz clic en su importe para fijarlo a mano — hasta entonces no se suman al total.
              </p>
            </div>
          )}

          {/* Aviso citas cuyo servicio cambió después de facturarse */}
          {!loading && visibleDivergentes > 0 && (
            <div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" />
              <p className="text-sm text-destructive">
                {visibleDivergentes === 1
                  ? "1 cita cambió de servicio después de facturarse."
                  : `${visibleDivergentes} citas cambiaron de servicio después de facturarse.`}
                {" "}El importe congelado ya no corresponde al servicio registrado. Revísalas y confirma el importe — no se suman al total.
              </p>
            </div>
          )}

          {/* Tabla por estilista */}
          {loading ? (
            <Skeleton className="h-[300px] w-full rounded-lg" />
          ) : rows.length === 0 ? (
            <p className="text-center text-muted-foreground py-12">
              {selectedName
                ? `No hay citas completadas de ${selectedName} en este periodo`
                : "No hay citas completadas en este periodo"}
            </p>
          ) : (
            <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/60 hover:bg-muted/60">
                    <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">Estilista</TableHead>
                    <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground text-right">Citas</TableHead>
                    <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground text-right">Base sin IVA</TableHead>
                    <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground text-right">IVA ({ivaPct}%)</TableHead>
                    <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground text-right">Total con IVA</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(e => {
                    const key = e.stylist_id ?? "__sin_estilista__";
                    const isOpen = !!expanded[key];
                    return (
                      <Fragment key={key}>
                        <TableRow className="cursor-pointer" onClick={() => toggle(key)}>
                          <TableCell className="font-medium">
                            <span className="flex items-center gap-2">
                              {e.stylist_name ?? "Sin estilista asignada"}
                              {e.sinCalcular > 0 && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
                                  <AlertTriangle size={10} />
                                  {e.sinCalcular} sin calcular
                                </span>
                              )}
                              {e.numDivergentes > 0 && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
                                  <AlertTriangle size={10} />
                                  {e.numDivergentes} servicio cambiado
                                </span>
                              )}
                              {/* Ámbar, nunca rojo: el rojo está reservado a "no lo sé". Un
                                  importe que decidió una persona no puede parecer un error. */}
                              {e.numManuales > 0 && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-500">
                                  <Pencil size={10} />
                                  {e.numManuales} manual
                                </span>
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{e.numCitas}</TableCell>
                          <TableCell className="text-right tabular-nums">{eur(e.totalSinIva)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{eur(e.iva)}</TableCell>
                          <TableCell className="text-right tabular-nums font-semibold">{eur(e.totalConIva)}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {isOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow className="hover:bg-transparent">
                            <TableCell colSpan={6} className="bg-muted/30 p-0">
                              <div className="px-4 py-3">
                                <CitaBreakdown citas={e.citas} onEdit={setEditando} />
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>

      <PrecioManualDialog
        cita={editando}
        orgId={orgId}
        onClose={() => setEditando(null)}
        onSaved={loadData}
      />
    </>
  );
}

function KpiCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <Card className={`border-border/60 shadow-sm ${highlight ? "border-destructive/50" : ""}`}>
      <CardHeader className="pb-1 pt-5 px-5">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          {label}
        </p>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <p className={`font-heading text-[30px] font-semibold leading-none ${highlight ? "text-destructive" : ""}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function CitaBreakdown({ citas, onEdit }: { citas: BillingCita[]; onEdit: (c: BillingCita) => void }) {
  if (!citas.length) {
    return <p className="text-sm text-muted-foreground">Sin citas.</p>;
  }
  return (
    <div className="space-y-1.5">
      {citas.map(c => (
        <div
          key={c.appointment_id}
          className="flex items-center justify-between gap-3 rounded-md bg-card px-3 py-2 text-sm"
        >
          <div className="min-w-0">
            <span className="text-muted-foreground tabular-nums">
              {c.starts_at ? madridDateKey(c.starts_at) : "—"}
            </span>
            <span className="mx-2 text-border">·</span>
            <span className="font-medium">{c.cliente ?? "—"}</span>
            <span className="mx-2 text-border">·</span>
            <span className="text-muted-foreground">{c.service ?? "—"}</span>
            {c.origen === "divergente" && (
              <p className="mt-0.5 text-xs text-destructive">
                Se facturó como «{c.servicio_facturado}» y el servicio se editó después.
                {c.precio_calculado != null && ` Ahora el catálogo daría ${eur(c.precio_calculado)}.`}
              </p>
            )}
            {c.origen === "manual" && c.precio_manual_motivo && (
              <p className="mt-0.5 text-xs text-muted-foreground">Motivo: {c.precio_manual_motivo}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onEdit(c)}
            title="Corregir el importe a mano"
            className="shrink-0 tabular-nums rounded px-1.5 py-0.5 hover:bg-muted transition-colors"
          >
            {c.origen === "manual" ? (
              <span className="inline-flex items-center gap-1 font-medium text-amber-600 dark:text-amber-500">
                <Pencil size={11} />
                {eur(c.precio ?? 0)}
              </span>
            ) : c.origen === "divergente" ? (
              <span className="inline-flex items-center gap-1 text-destructive text-xs font-semibold">
                <AlertTriangle size={11} />
                servicio cambiado
              </span>
            ) : c.calculable ? (
              <span className="font-medium">{eur(c.precio ?? 0)}</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-destructive text-xs font-semibold">
                <AlertTriangle size={11} />
                revisar
              </span>
            )}
          </button>
        </div>
      ))}
    </div>
  );
}

// Diálogo para fijar o limpiar el importe de una cita a mano.
//
// Manda un número y recarga: NO calcula la base sin IVA, NO decide precedencia y NO deriva
// del catálogo a qué importe volvería al limpiar. Todo eso llega ya resuelto en
// `precio_calculado`. Es deliberado — el catálogo está a mano en esta app (useServiceCatalog)
// y duplicar aquí la aritmética del backend es exactamente como se desincronizan las dos
// capas. El único sitio donde se decide dinero es services/helpers.js.
function PrecioManualDialog({
  cita, orgId, onClose, onSaved,
}: {
  cita: BillingCita | null;
  orgId: string | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [valor, setValor] = useState("");
  const [motivo, setMotivo] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!cita) return;
    // Se precarga con el importe que se está viendo: corregir suele ser un retoque sobre él,
    // no escribirlo de cero.
    const base = cita.origen === "manual" ? cita.precio : (cita.precio ?? cita.precio_calculado);
    setValor(base != null ? String(base) : "");
    setMotivo(cita.precio_manual_motivo ?? "");
  }, [cita]);

  if (!cita) return null;
  const esManual = cita.origen === "manual";

  async function guardar(limpiar: boolean) {
    if (!cita) return;
    let precio: number | null = null;
    if (!limpiar) {
      // Coma decimal: en un teclado español es lo que se teclea de forma natural.
      const n = Number(valor.replace(",", "."));
      if (!Number.isFinite(n) || n < 0) {
        toast.error("Escribe un importe válido (0 o más)");
        return;
      }
      precio = Math.round(n * 100) / 100;
    }
    setSaving(true);
    try {
      await apiMutate(`/api/citas/${cita.appointment_id}/precio`, {
        method: "PATCH",
        orgId,
        body: { precio, motivo: limpiar ? null : motivo.trim() || null },
      });
      toast.success(limpiar ? "Importe devuelto al calculado" : "Importe actualizado");
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo guardar el importe");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!cita} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Corregir importe</DialogTitle>
          <DialogDescription>
            {cita.cliente ?? "—"} · {cita.service ?? "—"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="precio-manual">Total con IVA</Label>
            <Input
              id="precio-manual"
              inputMode="decimal"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              placeholder="0,00"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="motivo-manual">Motivo (opcional)</Label>
            <Input
              id="motivo-manual"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Descuento fidelidad, error al registrar…"
              maxLength={300}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            {cita.precio_calculado != null
              ? <>Calculado desde el catálogo: <span className="tabular-nums font-medium">{eur(cita.precio_calculado)}</span></>
              : "El catálogo no puede calcular este servicio automáticamente."}
          </p>
          {cita.origen === "divergente" && (
            <p className="text-xs text-destructive">
              Se facturó por «{cita.servicio_facturado}» y el servicio se editó después. Confirma
              el importe correcto para que vuelva a contar en el total.
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {esManual ? (
            <Button variant="ghost" onClick={() => guardar(true)} disabled={saving}>
              Volver al importe calculado
            </Button>
          ) : <span />}
          <Button onClick={() => guardar(false)} disabled={saving}>
            {saving ? "Guardando…" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
