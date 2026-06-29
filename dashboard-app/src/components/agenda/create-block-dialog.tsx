"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TimePickerSelect } from "@/components/ui/time-picker-select";
import { toast } from "sonner";
import { API, apiHeaders } from "@/lib/api";
import type { Stylist } from "@/lib/types";

interface Props {
  stylists: Stylist[];
  orgId: string;
  defaultStylistId?: string;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateBlockDialog({ stylists, orgId, defaultStylistId, onClose, onCreated }: Props) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    stylistId: defaultStylistId || "",
    fecha: new Date().toISOString().split("T")[0],
    horaInicio: "10:00",
    horaFin: "11:00",
    reason: "",
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.stylistId || !form.fecha || !form.horaInicio || !form.horaFin) {
      toast.error("Rellena todos los campos obligatorios");
      return;
    }

    setSaving(true);
    try {
      const startsAt = new Date(`${form.fecha}T${form.horaInicio}:00`).toISOString();
      const endsAt = new Date(`${form.fecha}T${form.horaFin}:00`).toISOString();

      const res = await fetch(`${API}/api/schedule-blocks`, {
        method: "POST",
        headers: apiHeaders(orgId),
        body: JSON.stringify({
          stylistId: form.stylistId,
          startsAt,
          endsAt,
          reason: form.reason || undefined,
        }),
      });
      if (!res.ok) throw new Error();
      toast.success("Hueco bloqueado");
      onCreated();
    } catch {
      toast.error("Error al bloquear el hueco");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Bloquear hueco</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label>Estilista *</Label>
            <Select value={form.stylistId} onValueChange={v => setForm(f => ({ ...f, stylistId: v ?? "" }))}>
              <SelectTrigger>
                <SelectValue placeholder="Seleccionar...">
                  {(() => { const s = stylists.find(x => x.id === form.stylistId); return s ? s.name : null; })()}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {stylists.map(s => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Fecha *</Label>
            <Input type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Hora inicio *</Label>
              <TimePickerSelect value={form.horaInicio} onChange={v => setForm(f => ({ ...f, horaInicio: v }))} />
            </div>
            <div>
              <Label>Hora fin *</Label>
              <TimePickerSelect value={form.horaFin} onChange={v => setForm(f => ({ ...f, horaFin: v }))} />
            </div>
          </div>
          <div>
            <Label>Motivo</Label>
            <Input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} placeholder="Ej: Descanso, vacaciones..." />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={saving}>{saving ? "Bloqueando..." : "Bloquear"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
