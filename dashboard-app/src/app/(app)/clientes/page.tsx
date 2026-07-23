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
import { API, apiHeaders } from "@/lib/api";
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
    await fetch(`${API}/api/leads/${id}`, {
      method: "PUT",
      headers: await apiHeaders(orgId),
      body: JSON.stringify(data),
    });
    await fetchClientes();
  }

  async function handleDelete(id: number) {
    await fetch(`${API}/api/leads/${id}`, { method: "DELETE", headers: await apiHeaders(orgId) });
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
        orgType={orgType}
      />
    </>
  );
}
