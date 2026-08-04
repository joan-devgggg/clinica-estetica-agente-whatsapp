import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { Toaster } from "@/components/ui/sonner";
import { OrgProvider } from "@/lib/org-context";
import { BotStatusProvider } from "@/lib/bot-status-context";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <OrgProvider>
      {/* Envuelve barra lateral Y contenido: es lo que permite que pausar desde
          Configuración actualice la píldora del pie sin recargar la página. */}
      <BotStatusProvider>
        <TooltipProvider delay={300}>
          <SidebarProvider>
            <AppSidebar />
            <SidebarInset className="flex flex-col min-h-svh">
              {children}
            </SidebarInset>
          </SidebarProvider>
          <Toaster position="bottom-right" richColors />
        </TooltipProvider>
      </BotStatusProvider>
    </OrgProvider>
  );
}
