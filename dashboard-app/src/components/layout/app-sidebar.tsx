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
  Receipt,
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
import { useBotStatus, type BotStatus } from "@/lib/bot-status-context";
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
  { href: "/facturacion", label: "Facturación", icon: Receipt },
  { href: "/lista-vip", label: "Lista VIP", icon: Star },
  { href: "/campanas", label: "Campañas", icon: Megaphone },
  { href: "/lista-negra", label: "Lista negra", icon: Ban },
  { href: "/resenas", label: "Reseñas", icon: MessageSquareText },
  { href: "/stripe", label: "Pagos", icon: CreditCard, disabled: true },
  { href: "/configuracion", label: "Configuración", icon: Settings },
];

// Píldora del pie: lo que ve quien mira el panel de reojo. Decía "Activo" en texto fijo,
// también con la organización pausada y también mientras el estado ni siquiera había
// cargado. Los cuatro estados son explícitos a propósito: no hay rama por defecto que
// afirme que el bot responde.
const BOT_STATUS_PILL: Record<BotStatus, { label: string; dot: string; text: string; title: string }> = {
  active: {
    label: "Activo",
    dot: "bg-accent",
    text: "text-muted-foreground",
    title: "El bot responde a todas las clientas",
  },
  paused: {
    label: "Pausado",
    // Mismo rojo que la tarjeta de Configuración (text-destructive), para que las dos
    // pantallas se lean igual de un vistazo.
    dot: "bg-destructive",
    text: "text-destructive font-medium",
    title: "Pausado para TODAS las clientas — reactívalo en Configuración",
  },
  loading: {
    label: "Comprobando…",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    title: "Comprobando el estado del bot",
  },
  unknown: {
    label: "Estado no disponible",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    title: "No se ha podido leer el estado del bot",
  },
};

export function AppSidebar() {
  const pathname = usePathname();
  const { orgName, orgType, loading } = useOrg();
  const { status: botStatus } = useBotStatus();
  const pill = BOT_STATUS_PILL[botStatus];

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
        <div
          className="flex items-center gap-2.5 rounded-lg bg-muted px-3 py-2.5"
          title={pill.title}
        >
          <div className="relative flex-shrink-0">
            <Bot
              size={15}
              strokeWidth={1.5}
              className={
                botStatus === "paused" ? "text-destructive" : "text-muted-foreground"
              }
            />
            <span
              className={`absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full border border-card ${pill.dot}`}
            />
          </div>
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-foreground leading-none truncate">
              Bot WhatsApp
            </p>
            <p
              className={`mt-0.5 text-[10.5px] leading-none truncate ${pill.text}`}
              aria-live="polite"
            >
              {pill.label}
            </p>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
