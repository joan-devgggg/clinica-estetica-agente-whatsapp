import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { Toaster } from "@/components/ui/sonner";
import { OrgProvider } from "@/lib/org-context";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <OrgProvider>
      <TooltipProvider delay={300}>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset className="flex flex-col min-h-svh">
            {children}
          </SidebarInset>
        </SidebarProvider>
        <Toaster position="bottom-right" richColors />
      </TooltipProvider>
    </OrgProvider>
  );
}
