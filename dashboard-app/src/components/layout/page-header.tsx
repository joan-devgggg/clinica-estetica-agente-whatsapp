import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}

export function PageHeader({ title, subtitle, children }: PageHeaderProps) {
  const now = new Date();
  const fecha = now.toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <header className="flex items-center gap-3 border-b border-border bg-card px-6 py-4">
      <SidebarTrigger className="-ml-1 text-muted-foreground hover:text-foreground" />
      <Separator orientation="vertical" className="h-5 bg-border" />
      <div className="flex flex-1 items-center justify-between gap-4">
        <div>
          {subtitle && (
            <p className="text-[10.5px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
              {subtitle}
            </p>
          )}
          <h1 className="font-heading text-[22px] font-semibold leading-tight text-foreground tracking-tight">
            {title}
          </h1>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground capitalize">
            {fecha}
          </p>
        </div>
        {children && <div className="flex items-center gap-2">{children}</div>}
      </div>
    </header>
  );
}
