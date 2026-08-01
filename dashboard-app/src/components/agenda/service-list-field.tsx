"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";
import { ServiceField } from "@/components/agenda/service-field";
import {
  findCatalogEntryByFullName,
  serviceRows,
  addServiceRow,
  setServiceRow,
  removeServiceRow,
  type ServiceRowsState,
  type ServiceCatalogEntry,
} from "@/lib/service-catalog";

interface Props {
  catalog: ServiceCatalogEntry[];
  servicio: string;
  onChange: (servicioText: string, totalDuracion: number, categoriaPrimera: string | null) => void;
  labelClassName?: string;
  placeholder?: string;
}

// Una visita puede llevar varios servicios (Contouring + Matiz plus + K18). El modelo de datos
// es el MISMO que usa el bot al aceptar un upsell: UNA fila de appointments cuyo `service` es
// el join por " + " de los nombres de catálogo, y ends_at la suma de duraciones. No son filas
// separadas — el guard de idempotencia de saveAppointment es (contact_id, starts_at) y dos
// filas a la misma hora se colapsarían en una.
//
// Antes esto no existía: la recepcionista elegía UN servicio y escribía el resto en Notas con
// el total sumado a mano. La facturación no lee Notas (getCompletedAppointmentsForBilling ni
// selecciona la columna), así que se facturaba solo el servicio del desplegable.
//
// Las transiciones de filas son puras y viven en lib/service-names.ts (tests/service-rows.test.js);
// aquí solo queda el render.
export function ServiceListField({ catalog, servicio, onChange, labelClassName, placeholder }: Props) {
  // Solo el NÚMERO de filas es estado local: los nombres se derivan de `servicio`, que es la
  // fuente de verdad del formulario padre. El padre pasa `key` por cita, así que al abrir otra
  // cita esto se remonta y se reinicia.
  const [numFilas, setNumFilas] = useState(1);
  const state: ServiceRowsState = { servicio, numFilas };

  const filas = serviceRows(state, catalog);
  const entradas = filas.map((n) => (n ? findCatalogEntryByFullName(catalog, n) : null));
  const rellenas = filas.filter(Boolean);

  function aplicar(next: ServiceRowsState) {
    setNumFilas(next.numFilas);
    const nombres = serviceRows(next, catalog).filter(Boolean);
    const resueltas = nombres.map((n) => findCatalogEntryByFullName(catalog, n));
    // Un servicio fuera de catálogo no aporta duración conocida; el padre rehabilita el input
    // de duración en ese caso para poder ponerla a mano.
    const totalDuracion = resueltas.reduce((sum, e) => sum + (e?.duracion ?? 0), 0);
    onChange(next.servicio, totalDuracion, resueltas[0]?.categoria ?? null);
  }

  // Los servicios sin precio (ej. Consulta, "se confirma en salón") NO suman 0 en silencio: se
  // avisan aparte, igual que hace la facturación con los segmentos 'unpriced'.
  const totalPrecio = entradas.reduce((sum, e) => sum + (e?.precio ?? 0), 0);
  const totalDuracion = entradas.reduce((sum, e) => sum + (e?.duracion ?? 0), 0);
  const sinPrecio = entradas.filter((e) => e != null && e.precio == null).length;
  const fueraDeCatalogo = filas.filter((n, i) => n && !entradas[i]).length;

  return (
    <div className="space-y-2">
      {filas.map((nombre, idx) => (
        // key por índice a propósito: el valor cambia en cada pulsación cuando la fila está en
        // modo texto libre, y una key derivada del valor remontaría el input y perdería el foco.
        <div key={idx} className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <ServiceField
              catalog={catalog}
              servicio={nombre}
              onSelectEntry={(_entry, texto) => aplicar(setServiceRow(state, idx, texto, catalog))}
              labelClassName={labelClassName}
              placeholder={placeholder}
              label={filas.length > 1 ? `Servicio ${idx + 1}` : "Servicio"}
            />
          </div>
          {filas.length > 1 && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => aplicar(removeServiceRow(state, idx, catalog))}
              aria-label={`Quitar servicio ${idx + 1}`}
              className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 size={14} />
            </Button>
          )}
        </div>
      ))}

      <Button
        type="button"
        variant="ghost"
        onClick={() => setNumFilas(addServiceRow(state, catalog).numFilas)}
        className="h-8 gap-1.5 px-2 text-[12px] text-muted-foreground hover:text-foreground"
      >
        <Plus size={13} /> Añadir otro servicio
      </Button>

      {rellenas.length > 1 && (
        <p className="text-[11px] text-muted-foreground">
          {rellenas.length} servicios · {totalDuracion} min · {totalPrecio} €
          {sinPrecio > 0 && " + a confirmar en salón"}
          {fueraDeCatalogo > 0 && ` · ${fueraDeCatalogo} fuera de catálogo (no se factura)`}
        </p>
      )}
    </div>
  );
}
