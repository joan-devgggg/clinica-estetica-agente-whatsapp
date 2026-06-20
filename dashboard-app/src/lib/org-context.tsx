"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createClient } from "@/utils/supabase/client";

export type OrgType = "restaurant" | "salon";

interface OrgContextValue {
  orgId: string;
  orgName: string;
  orgType: OrgType;
  orgSlug: string;
  loading: boolean;
}

const OrgContext = createContext<OrgContextValue>({
  orgId: "",
  orgName: "",
  orgType: "restaurant",
  orgSlug: "",
  loading: true,
});

export function useOrg() {
  return useContext(OrgContext);
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<OrgContextValue>({
    orgId: "",
    orgName: "",
    orgType: "restaurant",
    orgSlug: "",
    loading: true,
  });

  useEffect(() => {
    const supabase = createClient();

    async function loadOrg() {
      if (process.env.NEXT_PUBLIC_DEV_SKIP_AUTH === "true") {
        setValue({
          orgId: process.env.NEXT_PUBLIC_DEV_ORG_ID ?? "",
          orgName: process.env.NEXT_PUBLIC_DEV_ORG_NAME ?? "Dev Org",
          orgType: (process.env.NEXT_PUBLIC_DEV_ORG_TYPE as OrgType) ?? "salon",
          orgSlug: process.env.NEXT_PUBLIC_DEV_ORG_SLUG ?? "dev",
          loading: false,
        });
        return;
      }

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setValue(v => ({ ...v, loading: false }));
        return;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("organization_id")
        .eq("id", user.id)
        .maybeSingle();

      if (!profile?.organization_id) {
        setValue(v => ({ ...v, loading: false }));
        return;
      }

      const orgId = profile.organization_id;

      const { data: org } = await supabase
        .from("organizations")
        .select("name, slug")
        .eq("id", orgId)
        .maybeSingle();

      const { data: agentCfg } = await supabase
        .from("agent_configs")
        .select("business_info")
        .eq("organization_id", orgId)
        .maybeSingle();

      const businessInfo = agentCfg?.business_info as Record<string, unknown> | null;
      const orgType: OrgType = businessInfo?.equipo ? "salon" : "restaurant";

      setValue({
        orgId,
        orgName: org?.name ?? "",
        orgType,
        orgSlug: org?.slug ?? "",
        loading: false,
      });
    }

    loadOrg();
  }, []);

  return <OrgContext value={value}>{children}</OrgContext>;
}
