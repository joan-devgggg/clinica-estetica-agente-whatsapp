"use client";

import { useState, useEffect } from "react";
import { Trash2 } from "lucide-react";
import type { Reserva, Stylist, OrgType } from "@/lib/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { TimePickerSelect } from "@/components/ui/time-picker-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { API, apiHeaders } from "@/lib/api";

interface Props {
  reserva: Reserva | null;
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
  orgId: string;
  orgType?: OrgType;
  stylists?: Stylist[];
}

const STATUS_OPTIONS = [
  { value: "confirmed", label: "Confirmada" },
  { value: "completed", label: "Completada" },
  { value: "cancelled", label: "Cancelada" },
  { value: "no_show", label: "No-show" },
];

export function AppointmentEditSheet({
  reserva,
  open,
  onClose,
  onUpdated,
  orgId,
  orgType = "restaurant",
  stylists = [],
}: Props) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isSalon = orgType === "salon";

  function formFromReserva(r: Reserva | null) {
    return {
      servicio: r?.service || "",
      fecha: r?.fecha_cita || "",
      hora: r?.hora_cita || "",
      duracion: r?.starts_at && r?.ends_at
        ? String(Math.round((new Date(r.ends_at).getTime() - new Date(r.starts_at).getTime()) / 60000))
        : "60",
      estado: r?.estado_cita || "confirmed",
      stylistId: r?.stylist_id || "",
      notas: r?.notas || "",
      personas: r?.personas ?? undefined,
    };
  }

  const [form, setForm] = useState(() => formFromReserva(reserva));

  useEffect(() => {
    if (reserva) setForm(formFromReserva(reserva));
    setConfirmDelete(false);
  }, [reserva?.appointment_id]);

  if (!reserva) return null;

  const appointmentId = reserva.appointment_id;

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/citas/${appointmentId}`, {
        method: "PUT",
        headers: apiHeaders(orgId),
        body: JSON.stringify({
          servicio: form.servicio,
          fecha: form.fecha,
          hora: form.hora,
          duracionMin: parseInt(form.duracion) || 60,
          estado: form.estado,
          stylistId: form.stylistId || undefined,
          notas: form.notas,
          personas: form.personas,
        }),
      });
      if (!res.ok) throw new Error();
      toast.success("Cita actualizada");
      onUpdated();
      onClose();
    } catch {
      toast.error("Error al actualizar la cita");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`${API}/api/citas/${appointmentId}`, {
        method: "DELETE",
        headers: apiHeaders(orgId),
        body: "{}",
      });
      if (!res.ok) throw new Error();
      toast.success("Cita eliminada");
      onUpdated();
      onClose();
    } catch {
      toast.error("Error al eliminar la cita");
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const selectedStylist = stylists.find(s => s.id === form.stylistId);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) { onClose(); setConfirmDelete(false); } }}>
      <SheetContent className="w-full sm:max-w-md flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-5 border-b border-border">
          <SheetTitle className="font-heading text-[18px] font-semibold text-foreground">
            Editar cita
          </SheetTitle>
          <p className="text-[12px] text-muted-foreground">
            {reserva.nombre || "Sin nombre"} · {reserva.telefono}
          </p>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
              {isSalon ? "Servicio" : "Descripción"}
            </Label>
            <Input
              value={form.servicio}
              onChange={e => setForm(f => ({ ...f, servicio: e.target.value }))}
              className="h-9"
              placeholder={isSalon ? "Ej: Corte mujer" : "Reserva mesa"}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
              Estado
            </Label>
            <Select value={form.estado} onValueChange={v => setForm(f => ({ ...f, estado: v ?? f.estado }))}>
              <SelectTrigger className="h-9">
                <SelectValue>
                  {STATUS_OPTIONS.find(o => o.value === form.estado)?.label ?? form.estado}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                Fecha
              </Label>
              <Input
                type="date"
                value={form.fecha}
                onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))}
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                Hora
              </Label>
              <TimePickerSelect
                value={form.hora}
                onChange={v => setForm(f => ({ ...f, hora: v }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                Duración
              </Label>
              <Input
                type="number"
                value={form.duracion}
                onChange={e => setForm(f => ({ ...f, duracion: e.target.value }))}
                className="h-9"
                min={15}
                step={15}
              />
            </div>
          </div>

          {isSalon && stylists.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                Estilista
              </Label>
              <Select value={form.stylistId} onValueChange={v => setForm(f => ({ ...f, stylistId: v ?? f.stylistId }))}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Sin asignar">
                    {selectedStylist ? `${selectedStylist.name} — ${selectedStylist.role}` : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {stylists.map(s => (
                    <SelectItem key={s.id} value={s.id}>{s.name} — {s.role}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {!isSalon && (
            <div className="space-y-1.5">
              <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                Personas
              </Label>
              <Input
                type="number"
                value={form.personas ?? ""}
                onChange={e => setForm(f => ({ ...f, personas: e.target.value ? Number(e.target.value) : undefined }))}
                className="h-9"
                min={1}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
              Notas
            </Label>
            <textarea
              value={form.notas}
              onChange={e => setForm(f => ({ ...f, notas: e.target.value }))}
              rows={3}
              placeholder="Notas internas..."
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-[13.5px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring transition-shadow"
            />
          </div>
        </div>

        <SheetFooter className="px-6 py-4 border-t border-border flex-row gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={confirmDelete
              ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
              : "text-destructive border-destructive/30 hover:bg-destructive/5 hover:text-destructive"
            }
            onClick={handleDelete}
            disabled={deleting}
          >
            <Trash2 size={13} className="mr-1.5" />
            {deleting ? "Eliminando..." : confirmDelete ? "Confirmar eliminación" : "Eliminar"}
          </Button>
          <Separator orientation="vertical" className="h-6" />
          <div className="flex-1" />
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancelar
          </Button>
          <Button size="sm" disabled={saving} onClick={handleSave}>
            {saving ? "Guardando..." : "Guardar"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
