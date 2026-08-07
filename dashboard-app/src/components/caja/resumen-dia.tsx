"use client";

// El resumen del día. Es lo que hace VISIBLE la distinción confirmada/declarada — sin esto, la
// columna `atribucion` sería un campo que nadie mira y el PIN no habría servido de nada.
//
// Reparte por QUIEN COBRÓ, no por quien atendió, y el subtítulo lo dice con esas palabras.
// Facturación responde a la otra pregunta ("¿cuánto trabajo hizo cada una?", por
// appointments.stylist_id). Son dos informes distintos y ninguno sustituye al otro: la primera
// vez que las dos cifras no cuadren para alguien, hay que poder saber por qué.

import { Card, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { AlertTriangle } from "lucide-react";
import { diaDeCajaHoy, etiquetaDia } from "@/lib/date";
import type { CajaResumen } from "@/lib/types";

const eur = (n: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n);

export function ResumenDia({ resumen }: { resumen: CajaResumen }) {
  const t = resumen.totales;
  // El día sale del propio resumen (`fecha` ya venía en la respuesta y no se usaba), no de un
  // prop nuevo: así el componente no puede pintar un rótulo que contradiga a sus cifras.
  const esHoy = resumen.fecha === diaDeCajaHoy();
  // La cifra que da sentido al PIN: la tarjeta la verifica el banco, así que el efectivo que
  // nadie confirmó es el dinero del que menos se puede afirmar.
  const efectivoSinPin = t.declarada.efectivo;

  // Un día tranquilo decía CUATRO veces que no había pasado nada: "Pendientes (0)", "no queda
  // ninguna cita por cobrar", cuatro tarjetas a 0,00 € y "todavía no se ha cobrado nada".
  // Cuatro tarjetas vacías ocupan media pantalla sin informar de nada, y repetir el mismo cero
  // en varios sitios entrena a no leer ninguno. Con cero cobros basta una línea.
  if (resumen.totales.numCobros === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-[13px] text-muted-foreground">
        {/* El día ya no es siempre hoy: en pasado la frase tiene que ser "no se cobró nada",
            no "aún no se ha cobrado nada", que insinúa que puede llegar. */}
        {esHoy ? "Aún no se ha cobrado nada hoy" : `No se cobró nada ${etiquetaDia(resumen.fecha)}`}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className={`grid grid-cols-2 gap-4 ${efectivoSinPin > 0 ? "xl:grid-cols-4" : "xl:grid-cols-3"}`}>
        <Kpi label="Efectivo" value={eur(t.efectivo)} />
        <Kpi label="Tarjeta y Bizum" value={eur(t.tarjeta)} />
        <Kpi label="Total del día" value={eur(t.total)} />
        {efectivoSinPin > 0 && (
          <Kpi
            label="Efectivo sin PIN"
            value={eur(efectivoSinPin)}
            alerta
            pie={`${t.declarada.num} cobro${t.declarada.num === 1 ? "" : "s"} sin PIN`}
          />
        )}
      </div>

      {resumen.estilistas.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border/60 bg-card shadow-sm">
          <div className="border-b border-border/60 px-4 py-3">
            <p className="text-[13px] font-semibold text-foreground">Por quien cobró</p>
            <p className="text-[11.5px] text-muted-foreground">
              Quién tiene el dinero en su caja — no quién atendió. Eso lo dice Facturación.
            </p>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/60 hover:bg-muted/60">
                  {["Estilista", "Cobros", "Efectivo", "Tarjeta", "Total", "¿Con PIN?"].map((h) => (
                    <TableHead key={h} className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {resumen.estilistas.map((e) => (
                  <TableRow key={e.stylist_id ?? "sin"}>
                    <TableCell className="font-medium">{e.stylist_name ?? "Sin estilista"}</TableCell>
                    <TableCell>{e.numCobros}</TableCell>
                    <TableCell className="font-medium">{eur(e.efectivo)}</TableCell>
                    <TableCell className="text-muted-foreground">{eur(e.tarjeta)}</TableCell>
                    <TableCell className="font-semibold">{eur(e.total)}</TableCell>
                    <TableCell className="text-[12px]">
                      {e.confirmada.num > 0 && (
                        <span className="text-[oklch(0.35_0.06_160)]">{eur(e.confirmada.total)} con PIN</span>
                      )}
                      {e.confirmada.num > 0 && e.declarada.num > 0 && <span className="text-muted-foreground"> · </span>}
                      {e.declarada.num > 0 && (
                        <span className="text-[oklch(0.45_0.12_55)]">{eur(e.declarada.total)} sin PIN</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, alerta, pie }: { label: string; value: string; alerta?: boolean; pie?: string }) {
  return (
    <Card className={`border-border/60 shadow-sm ${alerta ? "border-[oklch(0.85_0.12_85/0.6)] bg-[oklch(0.85_0.12_85/0.07)]" : ""}`}>
      <CardContent className="p-4">
        <p className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.07em] font-semibold text-muted-foreground">
          {alerta && <AlertTriangle size={12} className="text-[oklch(0.45_0.12_55)]" />}
          {label}
        </p>
        <p className="mt-1 font-heading text-[24px] font-semibold leading-tight text-foreground">{value}</p>
        {pie && <p className="mt-0.5 text-[11px] text-muted-foreground">{pie}</p>}
      </CardContent>
    </Card>
  );
}
