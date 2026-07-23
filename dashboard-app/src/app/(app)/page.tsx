"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import { PageHeader } from "@/components/layout/page-header";
import { KpiCards } from "@/components/dashboard/kpi-cards";
import { RecentActivity } from "@/components/dashboard/recent-activity";
import { MOCK_STATS, MOCK_LEADS } from "@/lib/mock-data";

import { API, apiHeaders } from "@/lib/api";

interface Stats {
  total: number;
  confirmadas: number;
  hoy: number;
  semana: number;
  proximaCita?: { nombre: string; hora: string; tratamiento: string } | null;
}

interface Lead {
  id: number;
  nombre: string;
  tratamiento: string;
  estado_cita: "pendiente" | "confirmado" | "completado" | "cancelado";
  hora_cita?: string;
  fecha_cita?: string;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  const load = useCallback(async () => {
    try {
      const [statsRes, leadsRes] = await Promise.all([
        fetch(`${API}/api/stats`, { headers: apiHeaders() }),
        fetch(`${API}/api/leads?limit=10`, { headers: apiHeaders() }),
      ]);
      if (!statsRes.ok || !leadsRes.ok) throw new Error("API no disponible");
      setStats(await statsRes.json());
      setLeads(await leadsRes.json());
    } catch {
      setStats(MOCK_STATS);
      setLeads(MOCK_LEADS.slice(0, 10) as Lead[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Realtime: actualizar dashboard cuando cambia cualquier lead
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
          <KpiCards stats={stats} loading={loading} />
          <RecentActivity leads={leads} loading={loading} />
        </div>
      </div>
    </>
  );
}
