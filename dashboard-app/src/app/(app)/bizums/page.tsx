"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { toast } from "sonner";
import { Banknote, Check, X, Phone, Users } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { API, apiHeaders } from "@/lib/api";
import { useOrg } from "@/lib/org-context";

interface BizumRow {
  id: string;
  contact_id: number;
  party_size?: number;
  occasion?: string | null;
  starts_at: string;
  bizum_status: string;
  bizum_amount?: number;
  contacts?: { id: number; full_name: string; wa_phone: string };
  full_name?: string;
  wa_phone?: string;
}

function getInitials(nombre: string) {
  return (nombre || "??")
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

function formatFecha(iso: string) {
  const d = new Date(iso);
  const dia = d.toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short" });
  const hora = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
  return `${dia} · ${hora}`;
}

export default function BizumsPage() {
  const [bizums, setBizums] = useState<BizumRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const supabase = createClient();
  const { orgId } = useOrg();

  const fetchBizums = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/bizums`, { headers: await apiHeaders(orgId) });
      if (!res.ok) throw new Error("API no disponible");
      setBizums(await res.json());
    } catch {
      setBizums([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBizums();
  }, [fetchBizums]);

  useEffect(() => {
    const channel = supabase
      .channel("bizums-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments" }, () => { fetchBizums(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function resolver(appointmentId: string, confirmado: boolean) {
    setResolving(appointmentId);
    try {
      const res = await fetch(`${API}/api/bizums/${appointmentId}/resolver`, {
        method: "POST",
        headers: await apiHeaders(orgId),
        body: JSON.stringify({ confirmado }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(confirmado ? "Reserva confirmada" : "Reserva rechazada");
      await fetchBizums();
    } catch {
      toast.error("Error al resolver el Bizum");
    } finally {
      setResolving(null);
    }
  }

  return (
    <>
      <PageHeader title="Bizums" subtitle="Verificación de señales pendientes" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6 space-y-3">
          {loading ? (
            [...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)
          ) : bizums.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <Banknote size={36} strokeWidth={1.25} className="text-muted-foreground/40" />
              <p className="font-heading text-[17px] font-semibold text-foreground/60">
                Sin Bizums pendientes
              </p>
              <p className="text-[12.5px] text-muted-foreground text-center max-w-xs">
                Cuando un cliente confirme que ha hecho el Bizum, aparecerá aquí para que lo verifiques
              </p>
            </div>
          ) : (
            bizums.map((b) => {
              const nombre = b.contacts?.full_name ?? b.full_name ?? "Sin nombre";
              const telefono = b.contacts?.wa_phone ?? b.wa_phone ?? "";
              return (
                <Card key={b.id} className="border-border/60 shadow-sm">
                  <CardContent className="p-4 flex items-center gap-3">
                    <Avatar className="h-10 w-10 flex-shrink-0">
                      <AvatarFallback className="bg-secondary text-primary text-[11.5px] font-semibold">
                        {getInitials(nombre)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13.5px] font-semibold text-foreground truncate">{nombre}</p>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
                          <Phone size={11} strokeWidth={1.5} /> {telefono}
                        </span>
                        <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
                          <Users size={11} strokeWidth={1.5} /> {b.party_size ?? "—"} pax
                        </span>
                      </div>
                      <p className="text-[11.5px] text-muted-foreground mt-1 capitalize">
                        {formatFecha(b.starts_at)}
                        {b.occasion ? ` · ${b.occasion}` : ""}
                        {b.bizum_amount ? ` · Señal: ${b.bizum_amount}€` : ""}
                      </p>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-destructive border-destructive/30 hover:bg-destructive/5 hover:text-destructive"
                        disabled={resolving === b.id}
                        onClick={() => resolver(b.id, false)}
                      >
                        <X size={13} className="mr-1" /> Rechazar
                      </Button>
                      <Button
                        size="sm"
                        disabled={resolving === b.id}
                        onClick={() => resolver(b.id, true)}
                      >
                        <Check size={13} className="mr-1" /> Confirmar
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
