"use client";

import { useState } from "react";
import { Trash2, Star, Ban, AlertCircle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { Cliente, OrgType } from "@/lib/types";
import { syncHoraCita, INITIAL_HORA_CITA } from "@/lib/cliente-form";
import { confirmacionBloqueo, confirmacionDesbloqueo } from "@/lib/blacklist";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

interface ClienteEditSheetProps {
  cliente: Cliente | null;
  open: boolean;
  onClose: () => void;
  onSave: (id: number, data: Partial<Cliente>) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /** Marca `is_blacklisted`. Debe lanzar si el servidor no confirma la escritura. */
  onBlock?: (id: number, motivo: string) => Promise<void>;
  /** Quita la marca Y devuelve la conversación a 'auto' — ver el comentario del call site. */
  onUnblock?: (id: number) => Promise<void>;
  orgType?: OrgType;
}

export function ClienteEditSheet({
  cliente,
  open,
  onClose,
  onSave,
  onDelete,
  onBlock,
  onUnblock,
  orgType = "restaurant",
}: ClienteEditSheetProps) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Confirmación de bloqueo/desbloqueo. `null` = ninguna abierta. Bloquear no puede ser un
  // clic suelto: es una acción sobre una persona y lo que hace no se adivina desde el botón.
  const [confirmando, setConfirmando] = useState<"bloquear" | "desbloquear" | null>(null);
  const [motivo, setMotivo] = useState("");
  const [aplicando, setAplicando] = useState(false);
  // Derivado del cliente seleccionado (el sheet nunca se desmonta): ver lib/cliente-form.
  const [horaState, setHoraState] = useState(INITIAL_HORA_CITA);
  const syncedHora = syncHoraCita(horaState, cliente);
  if (syncedHora !== horaState) setHoraState(syncedHora);
  const horaCita = syncedHora.hora;
  const setHoraCita = (hora: string) => setHoraState((s) => ({ ...s, hora }));
  const isSalon = orgType === "salon";

  if (!cliente) return null;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!cliente) return;
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setError(null);
    try {
      await onSave(cliente.id, {
        nombre: form.get("nombre") as string,
        ...(!isSalon && { personas: Number(form.get("personas")) || undefined }),
        ...(!isSalon && { ocasion: form.get("ocasion") as string }),
        estado_cita: form.get("estado_cita") as import("@/lib/types").EstadoCita,
        fecha_cita: form.get("fecha_cita") as string,
        hora_cita: horaCita,
        allergies: form.get("allergies") as string,
        preferences: form.get("preferences") as string,
        ...(isSalon && { language: form.get("language") as string }),
        ...(isSalon && { formula_coloracion: form.get("formula_coloracion") as string }),
        notas: form.get("notas") as string,
      });
    } catch (err) {
      // El sheet NO se cierra: cerrarlo daría por guardado algo que no se guardó.
      const msg = err instanceof Error ? err.message : "No se pudieron guardar los cambios";
      setError(msg);
      toast.error("No se pudieron guardar los cambios", { description: msg });
      setSaving(false);
      return;
    }
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

  // El sheet NO se cierra al bloquear: cerrarlo escondería el resultado, y lo primero que
  // quiere ver quien acaba de bloquear a alguien es que la ficha ya lo dice.
  async function aplicarBlacklist() {
    if (!cliente) return;
    const bloquear = confirmando === "bloquear";
    setAplicando(true);
    try {
      if (bloquear) await onBlock?.(cliente.id, motivo.trim());
      else await onUnblock?.(cliente.id);
      toast.success(bloquear ? "Contacto bloqueado" : "Contacto desbloqueado");
      setConfirmando(null);
      setMotivo("");
    } catch (e) {
      // Sin esto un 500 se veía igual que un bloqueo aplicado: el diálogo se cerraba y la
      // dueña se iba creyendo que el bot había dejado de hablarle a alguien.
      toast.error(
        bloquear ? "No se pudo bloquear el contacto" : "No se pudo desbloquear el contacto",
        { description: e instanceof Error ? e.message : undefined }
      );
    } finally {
      setAplicando(false);
    }
  }

  const copia = confirmando === "bloquear"
    ? confirmacionBloqueo(cliente)
    : confirmacionDesbloqueo(cliente);

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
          {/* El idioma sale de la cabecera: ahora es un campo editable del formulario y
              pintarlo aquí además mostraría el valor viejo hasta recargar. */}
          <p className="text-[11.5px] text-muted-foreground">
            Visitas registradas: {cliente.visit_count}
          </p>
        </SheetHeader>

        <form
          id="cliente-edit-form"
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto px-6 py-5 space-y-4"
        >
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive"
            >
              <AlertCircle size={14} className="mt-px shrink-0" />
              <span>
                <strong className="font-semibold">No se guardó.</strong> {error}
              </span>
            </div>
          )}

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
              <TimePickerSelect
                value={horaCita}
                onChange={setHoraCita}
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
          {isSalon && (
            <div className="space-y-1.5">
              <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                Idioma
              </Label>
              <Select name="language" defaultValue={cliente.language || "es"}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="es">Español</SelectItem>
                  <SelectItem value="en">Inglés</SelectItem>
                  <SelectItem value="ru">Ruso</SelectItem>
                  <SelectItem value="uk">Ucraniano</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {cliente.language_inferred
                  ? "Deducido de su nombre, sin confirmar: el bot no distingue ruso de ucraniano por el nombre. Si lo sabes, corrígelo."
                  : "En qué idioma le escriben el bot, los recordatorios y las campañas."}
              </p>
            </div>
          )}
          {isSalon && (
            <div className="space-y-1.5">
              <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                Fórmula de coloración
              </Label>
              <textarea
                name="formula_coloracion"
                defaultValue={cliente.formula_coloracion}
                rows={3}
                placeholder="Ej. Base 6.0 + 7.3 (30ml) · oxidante 20 vol · 35 min..."
                className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-[13.5px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring transition-shadow"
              />
              <p className="text-[11px] text-muted-foreground">
                Última fórmula usada. Se sobrescribe al guardar.
              </p>
            </div>
          )}
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

          {/* Bloquear / desbloquear. Solo salón (San Remo se queda exactamente como estaba:
              su ficha nunca ha tenido esta acción y llega a la lista negra por su menú).
              Va aquí abajo y no en el footer a propósito: el footer es "guardar/descartar
              cambios del formulario" y esto no es un campo del formulario — se aplica solo,
              al instante, sin pasar por "Guardar cambios". */}
          {isSalon && onBlock && onUnblock && (
            <div className="rounded-md border border-border/60 p-3 space-y-2">
              <p className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                Lista negra
              </p>
              {cliente.is_blacklisted ? (
                <>
                  <p className="text-[12px] text-muted-foreground">
                    Bloqueado{cliente.blacklist_reason ? ` · ${cliente.blacklist_reason}` : ""}. El bot no le contesta y no
                    entra en campañas, recordatorios ni reseñas.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmando("desbloquear")}
                  >
                    <ShieldCheck size={13} className="mr-1.5" />
                    Desbloquear contacto
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-[12px] text-muted-foreground">
                    El bot le atiende con normalidad y le pueden llegar campañas, recordatorios y
                    peticiones de reseña.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-destructive border-destructive/30 hover:bg-destructive/5 hover:text-destructive"
                    onClick={() => setConfirmando("bloquear")}
                  >
                    <Ban size={13} className="mr-1.5" />
                    Bloquear contacto
                  </Button>
                </>
              )}
            </div>
          )}
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

        {/* La confirmación DICE lo que pasa, una línea por efecto. Un "¿Estás seguro?" a secas
            haría decidir sin decir qué se decide, y aquí hay dos cosas que no se adivinan: que
            el bot todavía le contesta una vez, y que el aviso de Telegram lleva un botón que
            DESBLOQUEA. El texto vive en @/lib/blacklist, anclado al código que lo hace cierto. */}
        <Dialog open={confirmando !== null} onOpenChange={(o) => !o && !aplicando && setConfirmando(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {confirmando === "bloquear" ? (
                  <Ban size={15} className="text-destructive" />
                ) : (
                  <ShieldCheck size={15} />
                )}
                {copia.titulo}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <p className="text-[13px] text-foreground">{copia.intro}</p>
              <ul className="space-y-1.5">
                {copia.efectos.map((efecto) => (
                  <li key={efecto} className="flex gap-2 text-[12.5px] text-muted-foreground">
                    <span aria-hidden className="text-muted-foreground/60">·</span>
                    <span>{efecto}</span>
                  </li>
                ))}
              </ul>
              {confirmando === "bloquear" && (
                <div className="space-y-1.5">
                  <Label className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-muted-foreground">
                    Motivo (opcional)
                  </Label>
                  <Input
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    placeholder="Amenazas, insultos, número reasignado..."
                    className="h-9"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Se ve en la ficha y en Lista negra. Sirve para saber por qué está bloqueado
                    dentro de seis meses.
                  </p>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmando(null)}
                disabled={aplicando}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                size="sm"
                variant={confirmando === "bloquear" ? "destructive" : "default"}
                onClick={aplicarBlacklist}
                disabled={aplicando}
              >
                {aplicando ? "Aplicando..." : copia.cta}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}
