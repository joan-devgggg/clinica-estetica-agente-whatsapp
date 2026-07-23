"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { Lead } from "@/lib/types";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface LeadEditSheetProps {
  lead: Lead | null;
  open: boolean;
  onClose: () => void;
  onSave: (id: number, data: Partial<Lead>) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

export function LeadEditSheet({
  lead,
  open,
  onClose,
  onSave,
  onDelete,
}: LeadEditSheetProps) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!lead) return null;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!lead) return;
    const form = new FormData(e.currentTarget);
    setSaving(true);
    await onSave(lead.id, {
      nombre: form.get("nombre") as string,
      tratamiento: form.get("tratamiento") as string,
      estado_cita: form.get("estado_cita") as import("@/lib/types").EstadoCita,
      fecha_cita: form.get("fecha_cita") as string,
      hora_cita: form.get("hora_cita") as string,
      notas: form.get("notas") as string,
    });
    setSaving(false);
    onClose();
  }

  async function handleDelete() {
    if (!lead) return;
    setDeleting(true);
    await onDelete(lead.id);
    setDeleting(false);
    onClose();
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-5 border-b border-border">
          <SheetTitle className="font-heading text-[18px] font-semibold text-foreground">
            {lead.nombre || "Sin nombre"}
          </SheetTitle>
          <p className="text-[12px] text-muted-foreground">{lead.telefono}</p>
        </SheetHeader>

        <form
          id="lead-edit-form"
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto px-6 py-5 space-y-4"
        >
          <div className="space-y-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
              Nombre
            </Label>
            <Input
              name="nombre"
              defaultValue={lead.nombre}
              className="h-9"
              placeholder="Nombre del cliente"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
              Tratamiento
            </Label>
            <Input
              name="tratamiento"
              defaultValue={lead.tratamiento}
              className="h-9"
              placeholder="Tratamiento"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
              Estado
            </Label>
            <Select name="estado_cita" defaultValue={lead.estado_cita}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pendiente">Pendiente</SelectItem>
                <SelectItem value="confirmado">Confirmada</SelectItem>
                <SelectItem value="completado">Completada</SelectItem>
                <SelectItem value="cancelado">Cancelada</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                Fecha
              </Label>
              <Input
                name="fecha_cita"
                type="date"
                defaultValue={lead.fecha_cita}
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                Hora
              </Label>
              <Input
                name="hora_cita"
                type="time"
                defaultValue={lead.hora_cita}
                className="h-9"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
              Notas
            </Label>
            <textarea
              name="notas"
              defaultValue={lead.notas}
              rows={4}
              placeholder="Notas internas..."
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-[13.5px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring transition-shadow"
            />
          </div>
        </form>

        <SheetFooter className="px-6 py-4 border-t border-border flex-row gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-destructive border-destructive/30 hover:bg-destructive/5 hover:text-destructive"
            onClick={handleDelete}
            disabled={deleting}
          >
            <Trash2 size={13} className="mr-1.5" />
            {deleting ? "Eliminando..." : "Eliminar"}
          </Button>
          <div className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            form="lead-edit-form"
            size="sm"
            disabled={saving}
          >
            {saving ? "Guardando..." : "Guardar cambios"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
