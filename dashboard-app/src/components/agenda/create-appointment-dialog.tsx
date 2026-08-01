"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TimePickerSelect } from "@/components/ui/time-picker-select";
import { ServiceField } from "@/components/agenda/service-field";
import { toast } from "sonner";
import { API, apiHeaders } from "@/lib/api";
import { ymd } from "@/lib/date";
import type { Stylist } from "@/lib/types";
import { useServiceCatalog, stylistsForCategoria, findCatalogEntryByFullName, type ServiceCatalogEntry } from "@/lib/service-catalog";

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
    duracion: "60",
    stylistId: defaultStylistId || "",
  });
  const { catalog } = useServiceCatalog(orgId, true);

  function handleSelectServiceEntry(entry: ServiceCatalogEntry | null, servicioText: string) {
    setForm((f) => {
      const next = { ...f, servicio: servicioText };
      if (entry) {
        next.duracion = String(entry.duracion);
        if (!f.stylistId) {
          const eligibles = stylistsForCategoria(stylists, entry.categoria);
          if (eligibles.length === 1) next.stylistId = eligibles[0].id;
        }
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
          servicio: form.servicio || "Cita manual",
          fecha: form.fecha,
          hora: form.hora,
          duracionMin: parseInt(form.duracion),
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
          <ServiceField
            catalog={catalog}
            servicio={form.servicio}
            onSelectEntry={handleSelectServiceEntry}
            placeholder="Ej: Corte mujer"
          />
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
                value={form.duracion}
                onChange={e => setForm(f => ({ ...f, duracion: e.target.value }))}
                disabled={!!findCatalogEntryByFullName(catalog, form.servicio)}
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
