"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { MessageSquareText, Send, Clock } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/lib/org-context";
import { API, apiHeaders } from "@/lib/api";

interface PendingReview {
  id: string;
  full_name: string;
  phone: string;
  service: string;
  ends_at: string;
  stylist_id?: string;
  contacts?: { full_name: string; wa_phone: string; language: string };
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "hace menos de 1h";
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} día${days === 1 ? "" : "s"}`;
}

export default function ResenasPage() {
  const [reviews, setReviews] = useState<PendingReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<string | null>(null);
  const { orgId } = useOrg();
  const supabase = createClient();

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await fetch(`${API}/api/reviews-pending`, { headers: apiHeaders(orgId) });
      if (!res.ok) throw new Error();
      setReviews(await res.json());
    } catch {
      setReviews([]);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const channel = supabase
      .channel("resenas-appointments")
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments" }, () => { load(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSend(appointmentId: string) {
    setSending(appointmentId);
    try {
      const res = await fetch(`${API}/api/reviews/${appointmentId}/send`, {
        method: "POST",
        headers: apiHeaders(orgId),
      });
      if (!res.ok) throw new Error();
      toast.success("Reseña enviada");
      setReviews(prev => prev.filter(r => r.id !== appointmentId));
    } catch {
      toast.error("Error al enviar la reseña");
    } finally {
      setSending(null);
    }
  }

  return (
    <>
      <PageHeader title="Reseñas pendientes" subtitle="Citas completadas sin reseña enviada" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-6 py-8">
          {loading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-20 w-full rounded-lg" />
              ))}
            </div>
          ) : reviews.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="rounded-2xl bg-muted p-6 mb-4">
                <MessageSquareText size={32} strokeWidth={1.5} className="text-muted-foreground" />
              </div>
              <p className="text-muted-foreground">No hay reseñas pendientes</p>
            </div>
          ) : (
            <div className="space-y-3">
              {reviews.map((r) => (
                <Card key={r.id} className="flex items-center justify-between px-5 py-4 border-border/60 shadow-sm">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      {r.contacts?.full_name || r.full_name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.service}
                    </p>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        <Clock size={10} className="mr-1" />
                        {timeAgo(r.ends_at)}
                      </Badge>
                      {r.contacts?.language && r.contacts.language !== "es" && (
                        <Badge variant="secondary" className="text-[10px]">
                          {r.contacts.language.toUpperCase()}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => handleSend(r.id)}
                    disabled={sending === r.id}
                  >
                    <Send size={14} className="mr-1.5" />
                    {sending === r.id ? "Enviando..." : "Enviar reseña"}
                  </Button>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
