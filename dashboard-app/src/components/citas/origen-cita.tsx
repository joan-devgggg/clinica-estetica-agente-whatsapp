"use client";

/**
 * De dónde viene una cita, pintado. El vocabulario y la decisión de si hay etiqueta viven en
 * `@/lib/origen-cita` (fichero puro, probado desde Node); aquí solo está el dibujo.
 *
 * Los dos componentes comparten el mapa de iconos A PROPÓSITO: la tarjeta de Reservas y la
 * celda de la agenda enseñan lo mismo con distinto tamaño, y con dos mapas el día que alguien
 * cambiara el icono de «por internet» lo cambiaría en una pantalla y no en la otra.
 *
 * Los dos devuelven `null` cuando el origen no se reconoce. No hay caso «desconocido» con su
 * propio dibujo: una cita antigua sin dato no lleva nada, que es distinto de llevar una
 * etiqueta que dice que no se sabe — y sobre todo es distinto de llevar una equivocada.
 */
import { Globe, MessageCircle, PencilLine } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { origenDeCita, type EtiquetaOrigen } from "@/lib/origen-cita";

const ICONOS = {
  internet: Globe,
  whatsapp: MessageCircle,
  mano: PencilLine,
} as const;

const TONOS: Record<EtiquetaOrigen["tono"], string> = {
  destacado: "bg-primary/12 text-primary border-transparent",
  normal: "bg-secondary text-muted-foreground border-transparent",
  apagado: "bg-transparent text-muted-foreground/70 border-border/70",
};

export function OrigenBadge({ source }: { source?: string | null }) {
  const o = origenDeCita(source);
  if (!o) return null;
  const Icono = ICONOS[o.icono];
  return (
    <Badge
      variant="outline"
      title={o.frase}
      className={`text-[10px] px-1.5 py-0 gap-1 font-medium ${TONOS[o.tono]}`}
    >
      <Icono size={10} strokeWidth={2} />
      {o.corta}
    </Badge>
  );
}

/** Solo el icono, para la rejilla de la agenda: ahí una celda son tres líneas de 10 px. */
export function OrigenIcono({ source, size = 10 }: { source?: string | null; size?: number }) {
  const o = origenDeCita(source);
  if (!o) return null;
  const Icono = ICONOS[o.icono];
  const color = o.tono === "destacado" ? "text-primary" : "text-muted-foreground/70";
  // `aria-label` y no solo el `title` del botón de fuera: aquí el dibujo ES la información,
  // y quien no vea el color tiene que poder llegar a la palabra.
  return <Icono size={size} strokeWidth={2} className={`shrink-0 ${color}`} aria-label={o.corta} />;
}

/** La leyenda de la agenda: sin ella, tres iconos de 10 px son un jeroglífico. */
export function LeyendaOrigenes({ fuentes }: { fuentes: (string | null | undefined)[] }) {
  const vistos: EtiquetaOrigen[] = [];
  for (const f of fuentes) {
    const o = origenDeCita(f);
    if (o && !vistos.some((v) => v.corta === o.corta)) vistos.push(o);
  }
  if (!vistos.length) return null;
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {vistos.map((o) => {
        const Icono = ICONOS[o.icono];
        return (
          <span key={o.corta} className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Icono size={11} strokeWidth={2} className={o.tono === "destacado" ? "text-primary" : ""} />
            {o.corta}
          </span>
        );
      })}
    </div>
  );
}
