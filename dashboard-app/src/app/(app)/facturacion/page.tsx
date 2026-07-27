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
import { ChevronLeft, ChevronRight, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/lib/org-context";
import { API, apiHeaders } from "@/lib/api";
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

type SegmentStatus = "ok" | "unpriced" | "unmatched";

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
  segments: BillingSegment[];
}

interface BillingStylist {
  stylist_id: string | null;
  stylist_name: string | null;
  numCitas: number;
  sinCalcular: number;
  totalConIva: number;
  totalSinIva: number;
  iva: number;
  citas: BillingCita[];
}

interface BillingReport {
  estilistas: BillingStylist[];
  totales: { totalConIva: number; totalSinIva: number; iva: number; numCitas: number };
  sinCalcularTotal: number;
  ivaRate: number;
}

const eur = (n: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n);

export default function FacturacionPage() {
  const [periodMode, setPeriodMode] = useState<"week" | "month">("week");
  const [offset, setOffset] = useState(0);
  const [report, setReport] = useState<BillingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [stylistFilter, setStylistFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { orgId } = useOrg();
  const range = periodMode === "week" ? getWeekRange(offset) : getMonthRange(offset);

  const loadData = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await fetch(
        `${API}/api/facturacion?desde=${range.start}&hasta=${range.end}`,
        { headers: await apiHeaders(orgId) }
      );
      if (!res.ok) throw new Error();
      setReport(await res.json());
    } catch {
      toast.error("Error cargando la facturación");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [orgId, range.start, range.end]);

  useEffect(() => { loadData(); }, [loadData]);

  // Al cambiar de semana a mes, reseteamos el offset (no son comparables).
  function switchMode(mode: "week" | "month") {
    setPeriodMode(mode);
    setOffset(0);
  }

  const rows = (report?.estilistas ?? []).filter(
    e => stylistFilter === "all" || (e.stylist_id ?? "__sin_estilista__") === stylistFilter
  );

  // Totales visibles: si hay filtro por estilista, recalculamos sobre la fila filtrada.
  const visibleTotals = stylistFilter === "all"
    ? report?.totales
    : rows.reduce(
        (acc, e) => ({
          totalConIva: acc.totalConIva + e.totalConIva,
          totalSinIva: acc.totalSinIva + e.totalSinIva,
          iva: acc.iva + e.iva,
          numCitas: acc.numCitas + e.numCitas,
        }),
        { totalConIva: 0, totalSinIva: 0, iva: 0, numCitas: 0 }
      );
  const visibleSinCalcular = stylistFilter === "all"
    ? report?.sinCalcularTotal ?? 0
    : rows.reduce((n, e) => n + e.sinCalcular, 0);

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
                {(report?.estilistas ?? []).map(e => (
                  <SelectItem
                    key={e.stylist_id ?? "__sin_estilista__"}
                    value={e.stylist_id ?? "__sin_estilista__"}
                  >
                    {e.stylist_name ?? "Sin estilista asignada"}
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
                label="Citas sin calcular"
                value={String(visibleSinCalcular)}
                highlight={visibleSinCalcular > 0}
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
                {" "}(servicio sin precio fijo o no encontrado en el catálogo). Revísalas manualmente — no se suman al total.
              </p>
            </div>
          )}

          {/* Tabla por estilista */}
          {loading ? (
            <Skeleton className="h-[300px] w-full rounded-lg" />
          ) : rows.length === 0 ? (
            <p className="text-center text-muted-foreground py-12">
              No hay citas completadas en este periodo
            </p>
          ) : (
            <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/60 hover:bg-muted/60">
                    <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">Estilista</TableHead>
                    <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground text-right">Citas</TableHead>
                    <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground text-right">Base sin IVA</TableHead>
                    <TableHead className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground text-right">IVA (21%)</TableHead>
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
                                <CitaBreakdown citas={e.citas} />
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

function CitaBreakdown({ citas }: { citas: BillingCita[] }) {
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
          </div>
          <div className="shrink-0 tabular-nums">
            {c.calculable ? (
              <span className="font-medium">{eur(c.precio ?? 0)}</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-destructive text-xs font-semibold">
                <AlertTriangle size={11} />
                revisar
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
