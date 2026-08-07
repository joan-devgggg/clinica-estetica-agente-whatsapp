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

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check } from "lucide-react";
import type { CajaPendiente, MetodoCobro, Stylist } from "@/lib/types";
import { madridTime } from "@/lib/date";
import { type CajaSesion, estilistaPorDefecto, saldraSinPin } from "@/lib/caja-session";

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
  stylists: Stylist[];
  cobrando: boolean;
  onCobroRapido: (p: CajaPendiente, metodo: MetodoCobro, cobradoPor: string) => void;
  onAbrirHoja: (p: CajaPendiente) => void;
}

export function PendienteRow({ pendiente, sesion, stylists, cobrando, onCobroRapido, onAbrirHoja }: Props) {
  const ya = pendiente.cobro;
  const ref = pendiente.importe_referencia;

  // Quién cobra ESTE cobro. Por defecto, la estilista de la CITA — no la de la sesión de PIN.
  //
  // Que una haga el servicio y cobre otra es lo normal en un mostrador compartido, así que el
  // valor de partida tiene que ser el del trabajo (appointments.stylist_id) y cambiarlo tiene
  // que costar un toque. Antes se atribuía siempre a la de la sesión, que obligaba a cambiar de
  // sesión —y a meter otro PIN— para decir algo que no tiene nada que ver con quién ha entrado.
  const [cobradoPor, setCobradoPor] = useState<string>(
    estilistaPorDefecto(pendiente.atendio_id, sesion),
  );
  const elegida = stylists.find((s) => s.id === cobradoPor);

  // Sin importe de referencia no hay cobro de un toque: no hay nada que poner. Va por la hoja.
  // NO se exige sesión: el cobro nunca se bloquea, y desde que la estilista se elige en la fila
  // la sesión solo aporta el PIN. Sin ella se cobra igual, marcado «sin PIN».
  const puedeUnToque = ref != null && !!cobradoPor && !cobrando;

  // Lo que va a quedar registrado, ANTES de tocar nada. Si al elegir a otra el cobro va a salir
  // sin PIN, se dice aquí y no después en el resumen: enterarse tarde es lo que hace que la
  // marca no sirva para nada.
  const sinPin = saldraSinPin(sesion, cobradoPor);
  const atendioDistinta = !!pendiente.atendio && pendiente.atendio_id !== cobradoPor;

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
              <p className="text-[10.5px] text-muted-foreground">sin precio en el catálogo</p>
            )}
          </button>
        </div>

        {ya ? (
          <p className="mt-2.5 flex items-center gap-1.5 text-[12px] font-medium text-[oklch(0.35_0.06_160)]">
            <Check size={14} />
            Cobrado {eur(Number(ya.importe_total))} · {ya.metodo}
            {ya.atribucion === "declarada" && (
              <span className="font-normal text-muted-foreground">· sin PIN</span>
            )}
          </p>
        ) : (
          <>
            {/* Quién cobra va AQUÍ, donde está el pulgar, y se puede CAMBIAR aquí mismo. Un
                cobro de un toque con la atribución fuera de la vista es lo contrario del
                modelo; y obligar a cambiar de sesión de PIN para decir que cobró otra sería
                pedir un trámite que no tiene nada que ver. */}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <span className="text-[11.5px] text-muted-foreground">Cobra</span>
              <Select value={cobradoPor} onValueChange={(v) => setCobradoPor(v ?? "")}>
                <SelectTrigger className="h-8 w-auto min-w-[130px] text-[12.5px]">
                  <SelectValue placeholder="¿quién?">{elegida?.name ?? null}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {stylists.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Es correcto que quien atendió y quien cobra difieran; callarlo parecería un
                  error y alguien lo "arreglaría" cambiando el selector sin motivo. */}
              {atendioDistinta && (
                <span className="text-[11.5px] text-muted-foreground">
                  atendió {pendiente.atendio}
                </span>
              )}
              {sinPin && (
                <span className="text-[11.5px] font-medium text-[oklch(0.45_0.12_55)]">
                  · quedará sin PIN
                </span>
              )}
            </div>
            {/* Sin importe de referencia NO se enseñan tres botones apagados: una fila que no
                se puede cobrar tiene que decir qué HACER, no dejar tres controles muertos con
                la explicación en la otra punta de la tarjeta. Un solo botón que lleva a la
                hoja, donde se teclea el importe. */}
            {ref == null ? (
              <Button
                size="sm"
                variant="secondary"
                className="mt-2 h-10 w-full"
                onClick={() => onAbrirHoja(pendiente)}
              >
                Poner importe y cobrar
              </Button>
            ) : (
              <div className="mt-2 grid grid-cols-3 gap-2">
                {RAPIDOS.map((m) => (
                  <Button
                    key={m.valor}
                    size="sm"
                    // `secondary` y no `outline`: un borde fino en gris sobre una tarjeta clara
                    // se lee como deshabilitado aunque no lo esté, y estos son los botones que
                    // más se pulsan de la pantalla.
                    variant="secondary"
                    className="h-11 font-medium"
                    disabled={!puedeUnToque}
                    onClick={() => onCobroRapido(pendiente, m.valor, cobradoPor)}
                  >
                    {m.etiqueta}
                  </Button>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
