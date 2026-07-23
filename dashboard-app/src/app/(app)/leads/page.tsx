"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { Search } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { LeadsTable } from "@/components/leads/leads-table";
import { LeadEditSheet } from "@/components/leads/lead-edit-sheet";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import type { Lead } from "@/lib/types";
import { MOCK_LEADS } from "@/lib/mock-data";
import { API, apiHeaders } from "@/lib/api";

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [estadoFilter, setEstadoFilter] = useState<string>("todos");
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const supabase = createClient();

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (estadoFilter !== "todos") params.set("estado", estadoFilter);
      const res = await fetch(`${API}/api/leads?${params}`, { headers: apiHeaders() });
      if (!res.ok) throw new Error("API no disponible");
      setLeads(await res.json());
    } catch {
      const filtered =
        estadoFilter === "todos"
          ? MOCK_LEADS
          : MOCK_LEADS.filter((l) => l.estado_cita === estadoFilter);
      setLeads(filtered);
    } finally {
      setLoading(false);
    }
  }, [estadoFilter]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  // Realtime: actualizar lista cuando llega un lead nuevo o cambia alguno
  useEffect(() => {
    const channel = supabase
      .channel("leads-page")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "contacts" },
        () => { fetchLeads(); }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = leads.filter((l) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (l.nombre ?? "").toLowerCase().includes(q) ||
      (l.telefono ?? "").includes(q) ||
      (l.tratamiento ?? "").toLowerCase().includes(q)
    );
  });

  async function handleSave(id: number, data: Partial<Lead>) {
    await fetch(`${API}/api/leads/${id}`, {
      method: "PUT",
      headers: apiHeaders(),
      body: JSON.stringify(data),
    });
    await fetchLeads();
  }

  async function handleDelete(id: number) {
    await fetch(`${API}/api/leads/${id}`, { method: "DELETE", headers: apiHeaders() });
    await fetchLeads();
  }

  function openLead(lead: Lead) {
    setSelectedLead(lead);
    setSheetOpen(true);
  }

  function handleEstadoChange(value: string | null) {
    setEstadoFilter(value ?? "todos");
  }

  return (
    <>
      <PageHeader title="Leads" subtitle="Clientes captados">
        <Button size="sm">+ Nuevo lead</Button>
      </PageHeader>

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
                placeholder="Buscar por nombre, teléfono o tratamiento..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9 text-[13px]"
              />
            </div>
            <Select value={estadoFilter} onValueChange={handleEstadoChange}>
              <SelectTrigger className="h-9 w-44 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos los estados</SelectItem>
                <SelectItem value="pendiente">Pendiente</SelectItem>
                <SelectItem value="confirmado">Confirmada</SelectItem>
                <SelectItem value="completado">Completada</SelectItem>
                <SelectItem value="cancelado">Cancelada</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-[11.5px] text-muted-foreground ml-1">
              {filtered.length} resultado{filtered.length !== 1 ? "s" : ""}
            </span>
          </div>

          <LeadsTable
            leads={filtered}
            loading={loading}
            selectedId={selectedLead?.id ?? null}
            onSelect={openLead}
          />
        </div>
      </div>

      <LeadEditSheet
        lead={selectedLead}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onSave={handleSave}
        onDelete={handleDelete}
      />
    </>
  );
}
