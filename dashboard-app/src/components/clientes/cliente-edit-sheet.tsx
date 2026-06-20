"use client";

import { useState } from "react";
import { Trash2, Star, Ban } from "lucide-react";
import type { Cliente, OrgType } from "@/lib/types";
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

interface ClienteEditSheetProps {
  cliente: Cliente | null;
  open: boolean;
  onClose: () => void;
  onSave: (id: number, data: Partial<Cliente>) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  orgType?: OrgType;
}

export function ClienteEditSheet({
  cliente,
  open,
  onClose,
  onSave,
  onDelete,
  orgType = "restaurant",
}: ClienteEditSheetProps) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isSalon = orgType === "salon";

  if (!cliente) return null;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!cliente) return;
    const form = new FormData(e.currentTarget);
    setSaving(true);
    await onSave(cliente.id, {
      nombre: form.get("nombre") as string,
      ...(!isSalon && { personas: Number(form.get("personas")) || undefined }),
      ...(!isSalon && { ocasion: form.get("ocasion") as string }),
      estado_cita: form.get("estado_cita") as import("@/lib/types").EstadoCita,
      fecha_cita: form.get("fecha_cita") as string,
      hora_cita: form.get("hora_cita") as string,
      allergies: form.get("allergies") as string,
      preferences: form.get("preferences") as string,
      notas: form.get("notas") as string,
    });
    setSaving(false);
    onClose();
  }

  async function handleDelete() {
    if (!cliente) return;
    setDeleting(true);
    await onDelete(cliente.id);
    setDeleting(false);
    onClose();
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-5 border-b border-border">
          <SheetTitle className="font-heading text-[18px] font-semibold text-foreground flex items-center gap-2">
            {cliente.nombre || "Sin nombre"}
            {cliente.is_vip && <Star size={14} className="text-amber-500 fill-amber-500" />}
            {cliente.is_blacklisted && <Ban size={14} className="text-destructive" />}
          </SheetTitle>
          <p className="text-[12px] text-muted-foreground">{cliente.telefono}</p>
          {cliente.is_blacklisted && cliente.blacklist_reason && (
            <p className="text-[11.5px] text-destructive">Lista negra: {cliente.blacklist_reason}</p>
          )}
          <p className="text-[11.5px] text-muted-foreground">
            Visitas registradas: {cliente.visit_count}
            {isSalon && cliente.language ? ` · Idioma: ${cliente.language.toUpperCase()}` : ""}
          </p>
        </SheetHeader>

        <form
          id="cliente-edit-form"
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto px-6 py-5 space-y-4"
        >
          <div className="space-y-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
              Nombre
            </Label>
            <Input
              name="nombre"
              defaultValue={cliente.nombre}
              className="h-9"
              placeholder="Nombre del cliente"
            />
          </div>

          {!isSalon && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                  Personas
                </Label>
                <Input
                  name="personas"
                  type="number"
                  min={1}
                  defaultValue={cliente.personas}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                  Ocasión
                </Label>
                <Input
                  name="ocasion"
                  defaultValue={cliente.ocasion}
                  className="h-9"
                  placeholder="Cumpleaños, aniversario..."
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
              Estado
            </Label>
            <Select name="estado_cita" defaultValue={cliente.estado_cita}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pendiente">Pendiente</SelectItem>
                {!isSalon && <SelectItem value="pendiente_bizum">Bizum pendiente</SelectItem>}
                <SelectItem value="confirmado">Confirmada</SelectItem>
                <SelectItem value="completado">Completada</SelectItem>
                <SelectItem value="cancelado">Cancelada</SelectItem>
                <SelectItem value="abandonado">Abandonada</SelectItem>
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
                defaultValue={cliente.fecha_cita}
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
                defaultValue={cliente.hora_cita}
                className="h-9"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
              {isSalon ? "Alergias / sensibilidades capilares" : "Alergias / intolerancias"}
            </Label>
            <Input
              name="allergies"
              defaultValue={cliente.allergies}
              className="h-9"
              placeholder={isSalon ? "Sensibilidad al tinte, cuero cabelludo..." : "Sin gluten, frutos secos..."}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
              Preferencias
            </Label>
            <Input
              name="preferences"
              defaultValue={cliente.preferences}
              className="h-9"
              placeholder={isSalon ? "Estilista habitual, tipo de corte..." : "Mesa junto a la ventana..."}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
              Notas
            </Label>
            <textarea
              name="notas"
              defaultValue={cliente.notas}
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
          <Separator orientation="vertical" className="h-6" />
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
            form="cliente-edit-form"
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
