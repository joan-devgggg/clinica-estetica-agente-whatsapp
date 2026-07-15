"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  Settings,
  Bot,
  MessageCircle,
  Banknote,
  Ban,
  Star,
  Scissors,
  MessageSquareText,
  CreditCard,
  Megaphone,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { useOrg } from "@/lib/org-context";
import type { LucideIcon } from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
}

const restaurantNavItems: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/reservas", label: "Reservas", icon: CalendarDays },
  { href: "/clientes", label: "Clientes", icon: Users },
  { href: "/bizums", label: "Bizums", icon: Banknote },
  { href: "/whatsapp", label: "WhatsApp", icon: MessageCircle },
];

const restaurantSettingsItems: NavItem[] = [
  { href: "/lista-vip", label: "Lista VIP", icon: Star },
  { href: "/lista-negra", label: "Lista negra", icon: Ban },
  { href: "/configuracion", label: "Configuración", icon: Settings },
];

const salonNavItems: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/agenda-estilistas", label: "Agenda estilistas", icon: Scissors },
  { href: "/reservas", label: "Citas", icon: CalendarDays },
  { href: "/clientes", label: "Clientes", icon: Users },
  { href: "/whatsapp", label: "WhatsApp", icon: MessageCircle },
];

const salonSettingsItems: NavItem[] = [
  { href: "/lista-vip", label: "Lista VIP", icon: Star },
  { href: "/campanas", label: "Campañas", icon: Megaphone },
  { href: "/lista-negra", label: "Lista negra", icon: Ban },
  { href: "/resenas", label: "Reseñas", icon: MessageSquareText },
  { href: "/stripe", label: "Pagos", icon: CreditCard, disabled: true },
  { href: "/configuracion", label: "Configuración", icon: Settings },
];

export function AppSidebar() {
  const pathname = usePathname();
  const { orgName, orgType, loading } = useOrg();

  const navItems = orgType === "salon" ? salonNavItems : restaurantNavItems;
  const settingsItems = orgType === "salon" ? salonSettingsItems : restaurantSettingsItems;
  const displayName = loading ? "Panel de control" : orgName || "Panel de control";

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="px-5 py-5 border-b border-sidebar-border">
        <div>
          <p className="font-heading text-[18px] font-semibold leading-tight tracking-tight text-sidebar-foreground">
            {displayName}
          </p>
          <p className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
            Panel de control
          </p>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70 font-semibold">
            Principal
          </SidebarGroupLabel>
          <SidebarMenu>
            {navItems.map(({ href, label, icon: Icon }) => {
              const active =
                href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton
                    isActive={active}
                    tooltip={label}
                    className="gap-2.5"
                    render={<Link href={href} />}
                  >
                    <Icon
                      size={15}
                      strokeWidth={active ? 2 : 1.5}
                      className={
                        active ? "text-primary" : "text-muted-foreground"
                      }
                    />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupLabel className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70 font-semibold">
            Gestión
          </SidebarGroupLabel>
          <SidebarMenu>
            {settingsItems.map(({ href, label, icon: Icon, disabled }) => {
              const active = pathname.startsWith(href);
              return (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton
                    isActive={active}
                    tooltip={disabled ? `${label} (próximamente)` : label}
                    className={`gap-2.5 ${disabled ? "opacity-50" : ""}`}
                    render={<Link href={disabled ? "#" : href} />}
                  >
                    <Icon
                      size={15}
                      strokeWidth={active ? 2 : 1.5}
                      className={
                        active ? "text-primary" : "text-muted-foreground"
                      }
                    />
                    <span>{label}</span>
                    {disabled && (
                      <span className="ml-auto text-[9px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
                        soon
                      </span>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-3 border-t border-sidebar-border">
        <div className="flex items-center gap-2.5 rounded-lg bg-muted px-3 py-2.5">
          <div className="relative flex-shrink-0">
            <Bot size={15} strokeWidth={1.5} className="text-muted-foreground" />
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent border border-card" />
          </div>
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-foreground leading-none truncate">
              Bot WhatsApp
            </p>
            <p className="mt-0.5 text-[10.5px] text-muted-foreground leading-none truncate">
              Activo
            </p>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
