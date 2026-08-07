"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TimePickerSelect } from "@/components/ui/time-picker-select";
import { ServiceListField } from "@/components/agenda/service-list-field";
import { toast } from "sonner";
import { API, apiHeaders } from "@/lib/api";
import { ymd } from "@/lib/date";
import type { Stylist } from "@/lib/types";
import { useServiceCatalog, stylistsForCategoria, splitServiceNames, catalogDurationTotal } from "@/lib/service-catalog";

interface Props {
  stylists: Stylist[];
  orgId: string;
  defaultStylistId?: string;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateAppointmentDialog({ stylists, orgId, defaultStylistId, onClose, onCreated }: Props) {
  const [saving, setSaving] = useState(false);
  // Contacto en lista negra: se avisa y se pide confirmación, pero NO se bloquea — la
  // recepcionista tiene la última palabra. Antes el alta manual ignoraba la lista negra
  // por completo y se podía dar cita a alguien bloqueado sin enterarse.
  const [avisoListaNegra, setAvisoListaNegra] = useState<{ nombre: string; motivo: string | null } | null>(null);
  const [form, setForm] = useState({
    nombre: "",
    telefono: "",
    servicio: "",
    fecha: ymd(new Date()),
    hora: "10:00",
    // Duración MANUAL: solo cuenta cuando los servicios no dan una suma de catálogo (texto
    // libre). Con servicios de catálogo manda `duracionCatalogo`, derivada de `servicio`.
    duracion: "60",
    stylistId: defaultStylistId || "",
    // Escape explícito: esta cita NO se va a cobrar (bloqueo, cortesía, hueco reservado).
    // Sin él, exigir servicio del catálogo obligaría a inventarse uno el día que haya algo
    // fuera de catálogo. Con él, lo que no se cobra se DICE en vez de disfrazarse.
    noFacturable: false,
  });
  const { catalog } = useServiceCatalog(orgId, true);

  const duracionCatalogo = catalogDurationTotal(form.servicio, catalog);
  const duracionEfectiva = duracionCatalogo != null ? String(duracionCatalogo) : form.duracion;

  function handleServicesChange(servicioText: string, categoriaPrimera: string | null) {
    setForm((f) => {
      const next = { ...f, servicio: servicioText };
      // La preselección de estilista solo tiene sentido con UN servicio: con varios, cada uno
      // puede pedir una estilista distinta (Contouring → colorista, manicura → Olgha) y
      // autoasignar por el primero sería elegir mal en silencio.
      const unSoloServicio = splitServiceNames(servicioText, catalog).length === 1;
      if (unSoloServicio && !f.stylistId && categoriaPrimera) {
        const eligibles = stylistsForCategoria(stylists, categoriaPrimera);
        if (eligibles.length === 1) next.stylistId = eligibles[0].id;
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.nombre || !form.telefono || !form.fecha || !form.hora) {
      toast.error("Rellena todos los campos obligatorios");
      return;
    }

    setSaving(true);
    try {
      // First create or find contact
      const leadRes = await fetch(`${API}/api/leads`, {
        method: "POST",
        headers: await apiHeaders(orgId),
        body: JSON.stringify({ nombre: form.nombre, telefono: form.telefono }),
      });
      if (!leadRes.ok) {
        const err = await leadRes.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "Error al crear el contacto");
      }
      const lead = await leadRes.json();
      if (!lead?.id) throw new Error("Respuesta inválida al crear contacto");

      // Primera vez que se ve que está bloqueado: parar aquí y avisar. El contacto ya está
      // creado/encontrado, así que un segundo envío continúa sin repetir el aviso.
      if (lead.is_blacklisted && !avisoListaNegra) {
        setAvisoListaNegra({ nombre: lead.nombre || form.nombre, motivo: lead.blacklist_reason ?? null });
        setSaving(false);
        return;
      }

      // Then create appointment
      const apptRes = await fetch(`${API}/api/appointments`, {
        method: "POST",
        headers: await apiHeaders(orgId),
        body: JSON.stringify({
          contactId: lead.id,
          servicio: form.servicio.trim(),
          noFacturable: form.noFacturable,
          fecha: form.fecha,
          hora: form.hora,
          duracionMin: parseInt(duracionEfectiva) || 60,
          stylistId: form.stylistId || undefined,
        }),
      });
      if (!apptRes.ok) {
        const err = await apptRes.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "Error al crear la cita");
      }
      toast.success("Cita creada");
      onCreated();
    } catch (e) {
      toast.error((e as Error).message || "Error al crear la cita");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nueva cita manual</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {avisoListaNegra && (
            <div
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <strong>{avisoListaNegra.nombre}</strong> está en la lista negra
              {avisoListaNegra.motivo ? ` (${avisoListaNegra.motivo})` : ""}. Pulsa de nuevo para
              darle cita de todas formas.
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Nombre *</Label>
              <Input value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} />
            </div>
            <div>
              <Label>Teléfono *</Label>
              <Input value={form.telefono} onChange={e => setForm(f => ({ ...f, telefono: e.target.value }))} />
            </div>
          </div>
          {/* Con la casilla puesta el servicio deja de ser obligatorio, pero SIGUE pidiéndose
              una descripción: un hueco cerrado tiene que decir de qué es, o dentro de un mes
              nadie sabe por qué está ahí. Es justo lo que les falta a las tres "Cita manual". */}
          {form.noFacturable ? (
            <div>
              <Label>¿Qué es? *</Label>
              <Input
                value={form.servicio}
                onChange={e => setForm(f => ({ ...f, servicio: e.target.value }))}
                placeholder="Ej: Hueco reservado, descanso, cortesía..."
              />
            </div>
          ) : (
            <ServiceListField
              catalog={catalog}
              servicio={form.servicio}
              onChange={handleServicesChange}
              placeholder="Ej: Corte mujer"
            />
          )}

          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-3 py-2.5">
            <Switch
              checked={form.noFacturable}
              onCheckedChange={(v: boolean) => setForm(f => ({ ...f, noFacturable: v }))}
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-foreground">Esta cita no se cobra</span>
              <span className="block text-[11.5px] text-muted-foreground">
                Para bloqueos, cortesías o huecos reservados. No saldrá en Caja como pendiente
                de cobrar.
              </span>
            </span>
          </label>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Fecha *</Label>
              <Input type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
            </div>
            <div>
              <Label>Hora *</Label>
              <TimePickerSelect value={form.hora} onChange={v => setForm(f => ({ ...f, hora: v }))} />
            </div>
            <div>
              <Label>Duración (min)</Label>
              <Input
                type="number"
                value={duracionEfectiva}
                onChange={e => setForm(f => ({ ...f, duracion: e.target.value }))}
                disabled={duracionCatalogo != null}
              />
            </div>
          </div>
          <div>
            <Label>Estilista</Label>
            <Select value={form.stylistId} onValueChange={v => setForm(f => ({ ...f, stylistId: v ?? "" }))}>
              <SelectTrigger>
                <SelectValue placeholder="Seleccionar...">
                  {(() => { const s = stylists.find(x => x.id === form.stylistId); return s ? `${s.name} — ${s.role}` : null; })()}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {stylists.map(s => (
                  <SelectItem key={s.id} value={s.id}>{s.name} — {s.role}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={saving} variant={avisoListaNegra ? "destructive" : "default"}>
              {saving ? "Creando..." : avisoListaNegra ? "Crear de todas formas" : "Crear cita"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
