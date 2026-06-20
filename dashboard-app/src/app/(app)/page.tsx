"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { PageHeader } from "@/components/layout/page-header";
import { KpiCards } from "@/components/dashboard/kpi-cards";
import { RecentActivity } from "@/components/dashboard/recent-activity";
import { useOrg } from "@/lib/org-context";
import type { Cliente } from "@/lib/types";

import { API, apiHeaders } from "@/lib/api";

interface Stats {
  total: number;
  reservasMes: number;
  noShows: number;
  bizumsPendientes: number;
  resenasPendientes: number;
  citasHoy: number;
  proximaReserva?: { nombre: string; personas: number; hora: string } | null;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [leads, setLeads] = useState<Cliente[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();
  const { orgId, orgType } = useOrg();

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const [statsRes, leadsRes] = await Promise.all([
        fetch(`${API}/api/stats`, { headers: apiHeaders(orgId) }),
        fetch(`${API}/api/leads?limit=10`, { headers: apiHeaders(orgId) }),
      ]);
      if (!statsRes.ok || !leadsRes.ok) throw new Error("API no disponible");
      setStats(await statsRes.json());
      setLeads(await leadsRes.json());
    } catch {
      setStats({
        total: 0,
        reservasMes: 0,
        noShows: 0,
        bizumsPendientes: 0,
        resenasPendientes: 0,
        citasHoy: 0,
        proximaReserva: null,
      });
      setLeads([]);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const channel = supabase
      .channel("dashboard-contacts")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "contacts" },
        () => { load(); }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Panel principal" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-6 py-8 space-y-6">
          <KpiCards stats={stats} loading={loading} orgType={orgType} />
          <RecentActivity leads={leads} loading={loading} />
        </div>
      </div>
    </>
  );
}
