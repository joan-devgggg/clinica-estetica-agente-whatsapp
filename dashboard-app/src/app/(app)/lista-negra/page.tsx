"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { toast } from "sonner";
import { Ban, Search, Trash2, Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { Cliente } from "@/lib/types";
import { API, apiHeaders } from "@/lib/api";
import { useOrg } from "@/lib/org-context";

function getInitials(nombre: string) {
  return (nombre || "??")
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

export default function ListaNegraPage() {
  const [items, setItems] = useState<Cliente[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Cliente[]>([]);
  const [searching, setSearching] = useState(false);
  const supabase = createClient();
  const { orgId } = useOrg();

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/lista-negra`, { headers: await apiHeaders(orgId) });
      if (!res.ok) throw new Error("API no disponible");
      setItems(await res.json());
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    const channel = supabase
      .channel("lista-negra-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "contacts" }, () => { fetchItems(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSearch() {
    if (!search.trim()) { setResults([]); return; }
    setSearching(true);
    try {
      const res = await fetch(`${API}/api/leads?search=${encodeURIComponent(search)}&limit=5`, { headers: await apiHeaders(orgId) });
      if (!res.ok) throw new Error("API no disponible");
      const data: Cliente[] = await res.json();
      setResults(data.filter((c) => !c.is_blacklisted));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function addToBlacklist(id: number) {
    const motivo = window.prompt("Motivo (opcional):", "") ?? "";
    await fetch(`${API}/api/lista-negra/${id}`, {
      method: "POST",
      headers: await apiHeaders(orgId),
      body: JSON.stringify({ motivo }),
    });
    toast.success("Añadido a la lista negra");
    setResults((r) => r.filter((c) => c.id !== id));
    await fetchItems();
  }

  async function removeFromBlacklist(id: number) {
    await fetch(`${API}/api/lista-negra/${id}`, { method: "DELETE", headers: await apiHeaders(orgId) });
    toast.success("Eliminado de la lista negra");
    await fetchItems();
  }

  return (
    <>
      <PageHeader title="Lista negra" subtitle="Clientes bloqueados" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6 space-y-6">

          {/* Buscar y añadir */}
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
                      <Button size="sm" variant="outline" onClick={() => addToBlacklist(c.id)}>
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
              <Ban size={36} strokeWidth={1.25} className="text-muted-foreground/40" />
              <p className="font-heading text-[16px] font-semibold text-foreground/60">
                Lista negra vacía
              </p>
              <p className="text-[12px] text-muted-foreground">
                Los no-shows y rechazos de Bizum se añaden aquí automáticamente
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {items.map((c) => (
                <Card key={c.id} className="border-border/60 shadow-sm">
                  <CardContent className="p-3.5 flex items-center gap-3">
                    <Avatar className="h-9 w-9 flex-shrink-0">
                      <AvatarFallback className="bg-destructive/10 text-destructive text-[11px] font-semibold">
                        {getInitials(c.nombre)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-foreground truncate">{c.nombre || "Sin nombre"}</p>
                      <p className="text-[11.5px] text-muted-foreground truncate">
                        {c.telefono}
                        {c.blacklist_reason ? ` · ${c.blacklist_reason}` : ""}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeFromBlacklist(c.id)}
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
