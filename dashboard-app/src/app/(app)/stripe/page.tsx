"use client";

import { CreditCard } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";

export default function StripePage() {
  return (
    <>
      <PageHeader title="Pagos online" subtitle="Gestión de cobros y depósitos" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="rounded-2xl bg-muted p-6 mb-6">
              <CreditCard size={48} strokeWidth={1.5} className="text-muted-foreground" />
            </div>
            <h2 className="font-heading text-2xl font-semibold text-foreground mb-2">
              Pagos online
            </h2>
            <p className="text-muted-foreground max-w-md">
              Próximamente podrás cobrar depósitos y pagos online directamente desde el panel.
              Contacta con nosotros para activar esta funcionalidad.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
