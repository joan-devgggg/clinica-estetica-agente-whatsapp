"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { Search } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { ClientesTable } from "@/components/clientes/clientes-table";
import { ClienteEditSheet } from "@/components/clientes/cliente-edit-sheet";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Cliente } from "@/lib/types";
import { API, apiHeaders, apiMutate } from "@/lib/api";
import { useOrg } from "@/lib/org-context";

export default function ClientesPage() {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [estadoFilter, setEstadoFilter] = useState<string>("todos");
  const [selectedCliente, setSelectedCliente] = useState<Cliente | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const supabase = createClient();
  const { orgId, orgType } = useOrg();

  const fetchClientes = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (estadoFilter !== "todos") params.set("estado", estadoFilter);
      const res = await fetch(`${API}/api/clientes?${params}`, { headers: await apiHeaders(orgId) });
      if (!res.ok) throw new Error("API no disponible");
      setClientes(await res.json());
    } catch {
      setClientes([]);
    } finally {
      setLoading(false);
    }
  }, [estadoFilter, orgId]);

  useEffect(() => {
    fetchClientes();
  }, [fetchClientes]);

  // Realtime: actualizar lista cuando llega un cliente nuevo o cambia alguno
  useEffect(() => {
    const channel = supabase
      .channel("clientes-page")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "contacts" },
        () => { fetchClientes(); }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = clientes.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (c.nombre ?? "").toLowerCase().includes(q) ||
      (c.telefono ?? "").includes(q) ||
      (c.ocasion ?? "").toLowerCase().includes(q)
    );
  });

  async function handleSave(id: number, data: Partial<Cliente>) {
    const res = await fetch(`${API}/api/leads/${id}`, {
      method: "PUT",
      headers: await apiHeaders(orgId),
      body: JSON.stringify(data),
    });
    // Sin esta comprobación un 500 se veía igual que un guardado correcto.
    if (!res.ok) {
      const detalle = await res
        .json()
        .then((b) => b?.error as string | undefined)
        .catch(() => undefined);
      throw new Error(detalle || `El servidor respondió ${res.status}`);
    }
    await fetchClientes();
  }

  async function handleDelete(id: number) {
    const res = await fetch(`${API}/api/leads/${id}`, {
      method: "DELETE",
      headers: await apiHeaders(orgId),
    });
    // Un borrado rechazado (409 si alguna cita tiene un cobro en caja) devolvía `ok` para el
    // panel: la lista se refrescaba y la ficha seguía ahí, sin decir por qué.
    if (!res.ok) {
      const detalle = await res
        .json()
        .then((b) => b?.error as string | undefined)
        .catch(() => undefined);
      throw new Error(detalle || `El servidor respondió ${res.status}`);
    }
    await fetchClientes();
  }

  // Solo lectura: alimenta el texto de la confirmación de borrado (cuántos mensajes, citas y
  // escaladas se lleva el CASCADE). Devuelve null si no se puede contar — el diálogo lo dice
  // en vez de enseñar un 0 inventado.
  async function fetchImpactoBorrado(id: number) {
    const res = await fetch(`${API}/api/leads/${id}/impacto-borrado`, {
      headers: await apiHeaders(orgId),
    });
    if (!res.ok) return null;
    return res.json();
  }

  // La ficha abierta es estado aparte de la lista: sin esto, bloquear no se vería hasta cerrar
  // y volver a abrir, y el propio botón seguiría diciendo "Bloquear contacto".
  function patchSeleccionado(id: number, cambios: Partial<Cliente>) {
    setSelectedCliente((prev) => (prev && prev.id === id ? { ...prev, ...cambios } : prev));
  }

  async function handleBlock(id: number, motivo: string) {
    await apiMutate(`/api/lista-negra/${id}`, { method: "POST", body: { motivo }, orgId });
    patchSeleccionado(id, { is_blacklisted: true, blacklist_reason: motivo || undefined });
    await fetchClientes();
  }

  // Desbloquear son DOS escrituras, y el orden no es indiferente.
  //
  // Bloquear deja la conversación en `bot_mode='manual'` con `escalation_reason='lista_negra'`
  // (bot.js, rama de lista negra), y quitar solo `is_blacklisted` NO deshace eso: el bot
  // seguiría mudo, y `auto-return` no la rescata nunca porque no devuelve a 'auto' nada que
  // tenga una escalada sin resolver. O sea que un "desbloqueado" a medias es un contacto que
  // el panel da por atendido y al que no le contesta nadie.
  //
  // Por eso primero 'auto' —que además limpia `escalation_reason` y resuelve la pending_action
  // (webhook.js: PUT /api/leads/:id/bot-mode)— y después la marca. Si falla el segundo paso,
  // el contacto sigue BLOQUEADO, que es el lado recuperable: el bot sigue callado, se ve el
  // error, y su siguiente mensaje lo vuelve a dejar en manual él solo.
  //
  // No se le manda ningún mensaje, al revés que el "Sí, continuar" de Telegram y que el botón
  // de reactivar del Monitor: desde una ficha se desbloquea a alguien que igual ni sabe que
  // estaba bloqueado, y escribirle sin querer es peor que no escribirle.
  async function handleUnblock(id: number) {
    await apiMutate(`/api/leads/${id}/bot-mode`, { method: "PUT", body: { mode: "auto" }, orgId });
    await apiMutate(`/api/lista-negra/${id}`, { method: "DELETE", orgId });
    patchSeleccionado(id, { is_blacklisted: false, blacklist_reason: undefined, bot_mode: "auto" });
    await fetchClientes();
  }

  function openCliente(cliente: Cliente) {
    setSelectedCliente(cliente);
    setSheetOpen(true);
  }

  function handleEstadoChange(value: string | null) {
    setEstadoFilter(value ?? "todos");
  }

  return (
    <>
      <PageHeader title="Clientes" subtitle="Fichas de clientes" />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-6 py-6 space-y-4">
          {/* Filters */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                placeholder="Buscar por nombre, teléfono u ocasión..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9 text-[13px]"
              />
            </div>
            <Select value={estadoFilter} onValueChange={handleEstadoChange}>
              <SelectTrigger className="h-9 w-48 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos los estados</SelectItem>
                <SelectItem value="pendiente">Pendiente</SelectItem>
                <SelectItem value="pendiente_bizum">Bizum pendiente</SelectItem>
                <SelectItem value="confirmado">Confirmada</SelectItem>
                <SelectItem value="completado">Completada</SelectItem>
                <SelectItem value="cancelado">Cancelada</SelectItem>
                <SelectItem value="abandonado">Abandonada</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-[11.5px] text-muted-foreground ml-1">
              {filtered.length} resultado{filtered.length !== 1 ? "s" : ""}
            </span>
          </div>

          <ClientesTable
            clientes={filtered}
            loading={loading}
            selectedId={selectedCliente?.id ?? null}
            onSelect={openCliente}
            orgType={orgType}
          />
        </div>
      </div>

      <ClienteEditSheet
        cliente={selectedCliente}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onSave={handleSave}
        onDelete={handleDelete}
        onBlock={handleBlock}
        onUnblock={handleUnblock}
        onImpactoBorrado={fetchImpactoBorrado}
        orgType={orgType}
      />
    </>
  );
}
