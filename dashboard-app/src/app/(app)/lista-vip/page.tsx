"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { toast } from "sonner";
import { Star, Search, Trash2, Plus, Check, X, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { Cliente } from "@/lib/types";
import { API, apiHeaders } from "@/lib/api";
import { useOrg } from "@/lib/org-context";

interface VipSuggestion {
  id: string;
  contact_id: number;
  payload: { nombre: string; telefono: string; visit_count: number };
}

function getInitials(nombre: string) {
  return (nombre || "??")
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

export default function ListaVipPage() {
  const [items, setItems] = useState<Cliente[]>([]);
  const [suggestions, setSuggestions] = useState<VipSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Cliente[]>([]);
  const [searching, setSearching] = useState(false);
  const supabase = createClient();
  const { orgId } = useOrg();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [vipRes, pendRes] = await Promise.all([
        fetch(`${API}/api/lista-vip`, { headers: apiHeaders(orgId) }),
        fetch(`${API}/api/pending-actions?type=vip_suggestion`, { headers: apiHeaders(orgId) }),
      ]);
      if (!vipRes.ok || !pendRes.ok) throw new Error("API no disponible");
      setItems(await vipRes.json());
      setSuggestions(await pendRes.json());
    } catch {
      setItems([]);
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    const channel = supabase
      .channel("lista-vip-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "contacts" }, () => { fetchAll(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSearch() {
    if (!search.trim()) { setResults([]); return; }
    setSearching(true);
    try {
      const res = await fetch(`${API}/api/leads?search=${encodeURIComponent(search)}&limit=5`, { headers: apiHeaders(orgId) });
      if (!res.ok) throw new Error("API no disponible");
      const data: Cliente[] = await res.json();
      setResults(data.filter((c) => !c.is_vip));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function addVip(id: number) {
    await fetch(`${API}/api/lista-vip/${id}`, { method: "POST", headers: apiHeaders(orgId) });
    toast.success("Añadido a VIP");
    setResults((r) => r.filter((c) => c.id !== id));
    await fetchAll();
  }

  async function removeVip(id: number) {
    await fetch(`${API}/api/lista-vip/${id}`, { method: "DELETE", headers: apiHeaders(orgId) });
    toast.success("Eliminado de VIP");
    await fetchAll();
  }

  async function resolveSuggestion(id: string, accion: "aceptar" | "rechazar") {
    await fetch(`${API}/api/pending-actions/${id}/resolver`, {
      method: "POST",
      headers: apiHeaders(orgId),
      body: JSON.stringify({ accion }),
    });
    toast.success(accion === "aceptar" ? "Cliente añadido a VIP" : "Sugerencia descartada");
    await fetchAll();
  }

  return (
    <>
      <PageHeader title="Lista VIP" subtitle="Clientes destacados" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6 space-y-6">

          {/* Sugerencias pendientes */}
          {suggestions.length > 0 && (
            <Card className="border-border/60 shadow-sm">
              <CardContent className="p-4 space-y-3">
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground flex items-center gap-1.5">
                  <Sparkles size={12} /> Sugerencias pendientes
                </p>
                {suggestions.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-muted/50">
                    <div>
                      <p className="text-[13px] font-medium text-foreground">{s.payload.nombre}</p>
                      <p className="text-[11.5px] text-muted-foreground">
                        {s.payload.telefono} · {s.payload.visit_count} visitas
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => resolveSuggestion(s.id, "rechazar")}>
                        <X size={13} className="mr-1" /> Descartar
                      </Button>
                      <Button size="sm" onClick={() => resolveSuggestion(s.id, "aceptar")}>
                        <Check size={13} className="mr-1" /> Añadir a VIP
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Buscar y añadir manualmente */}
          <Card className="border-border/60 shadow-sm">
            <CardContent className="p-4 space-y-3">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                Añadir cliente
              </p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Buscar por nombre o teléfono..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    className="pl-8 h-9 text-[13px]"
                  />
                </div>
                <Button size="sm" onClick={handleSearch} disabled={searching}>
                  Buscar
                </Button>
              </div>
              {results.length > 0 && (
                <div className="space-y-2 pt-1">
                  {results.map((c) => (
                    <div key={c.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-muted/50">
                      <div>
                        <p className="text-[13px] font-medium text-foreground">{c.nombre || "Sin nombre"}</p>
                        <p className="text-[11.5px] text-muted-foreground">{c.telefono}</p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => addVip(c.id)}>
                        <Plus size={13} className="mr-1" /> Añadir
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Listado */}
          {loading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <Star size={36} strokeWidth={1.25} className="text-muted-foreground/40" />
              <p className="font-heading text-[16px] font-semibold text-foreground/60">
                Sin clientes VIP
              </p>
              <p className="text-[12px] text-muted-foreground">
                Los clientes recurrentes se sugieren aquí automáticamente
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {items.map((c) => (
                <Card key={c.id} className="border-border/60 shadow-sm">
                  <CardContent className="p-3.5 flex items-center gap-3">
                    <Avatar className="h-9 w-9 flex-shrink-0">
                      <AvatarFallback className="bg-amber-500/10 text-amber-600 text-[11px] font-semibold">
                        {getInitials(c.nombre)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-foreground truncate flex items-center gap-1.5">
                        {c.nombre || "Sin nombre"}
                        <Star size={12} className="text-amber-500 fill-amber-500" />
                      </p>
                      <p className="text-[11.5px] text-muted-foreground truncate">
                        {c.telefono} · {c.visit_count} visitas
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeVip(c.id)}
                    >
                      <Trash2 size={13} className="mr-1" /> Quitar
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
