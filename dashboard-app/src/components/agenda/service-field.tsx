"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ServiceCatalogEntry } from "@/lib/service-catalog";
import { findCatalogEntryByFullName } from "@/lib/service-catalog";

interface Props {
  catalog: ServiceCatalogEntry[];
  servicio: string;
  onSelectEntry: (entry: ServiceCatalogEntry | null, servicioText: string) => void;
  labelClassName?: string;
  placeholder?: string;
  // Lo usa ServiceListField para numerar las filas ("Servicio 1", "Servicio 2"). Por defecto
  // "Servicio", que es lo que ve quien usa el campo suelto.
  label?: string;
}

// Desplegable del catálogo real de la organización. Camino normal: elegir un servicio
// de la lista autorrellena duración y precio (nunca texto libre que pueda no casar con
// el catálogo — ver auditoría de facturación). Fallback a texto libre solo si el
// servicio no está en catálogo (caso raro) o el catálogo aún no ha cargado.
//
// El modo (catálogo/libre) se deriva en cada render a partir de `servicio`+`catalog` —
// nada de useEffect. `manualMode` solo guarda que la recepcionista TOCÓ el toggle; si el
// componente se reutiliza para OTRA cita (parent debe pasar `key` distinta por cita) React
// lo remonta y el override se pierde, que es justo lo que queremos.
export function ServiceField({ catalog, servicio, onSelectEntry, labelClassName, placeholder, label = "Servicio" }: Props) {
  const matched = findCatalogEntryByFullName(catalog, servicio);
  const [manualFreeText, setManualFreeText] = useState<boolean | null>(null);
  const defaultFreeText = !matched && !!servicio;
  const showFreeText = catalog.length === 0 || (manualFreeText ?? defaultFreeText);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className={labelClassName}>{label}</Label>
        {catalog.length > 0 && (
          <button
            type="button"
            onClick={() => setManualFreeText(!showFreeText)}
            className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {showFreeText ? "Elegir del catálogo" : "Servicio fuera de catálogo"}
          </button>
        )}
      </div>
      {showFreeText ? (
        <Input
          value={servicio}
          onChange={(e) => onSelectEntry(null, e.target.value)}
          placeholder={placeholder}
        />
      ) : (
        <>
          <Select
            value={matched?.key ?? ""}
            onValueChange={(key) => {
              const entry = catalog.find((e) => e.key === key) || null;
              onSelectEntry(entry, entry?.fullName ?? "");
            }}
          >
            <SelectTrigger className="w-full h-9">
              <SelectValue placeholder="Selecciona un servicio">{matched?.fullName}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {catalog.map((e) => (
                <SelectItem key={e.key} value={e.key}>
                  {e.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {matched && (
            <p className="text-[11px] text-muted-foreground">
              {matched.duracion} min · {matched.precio != null ? `${matched.precio} €` : "precio a confirmar en salón"}
            </p>
          )}
        </>
      )}
    </div>
  );
}
