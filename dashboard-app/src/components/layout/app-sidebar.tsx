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
  Megaphone,
  Receipt,
  ClipboardCheck,
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

// PANTALLAS DE SANTE QUE NO ESTÁN EN EL MENÚ Y NO SE PUEDEN BORRAR (07/08/2026)
//
// `/lista-negra` y `/resenas` se quitaron de aquí porque la dueña no las abre a diario, pero
// las páginas siguen vivas y se llega a ellas escribiendo la URL. No son código muerto:
//
//   · /lista-negra — el filtro de lista negra SIGUE CORRIENDO por debajo (el bot no contesta
//     a quien esté marcada). Sin pantalla no habría ninguna forma de desbloquear a nadie:
//     el bloqueo sería definitivo y silencioso.
//   · /resenas — el 06/08/2026 aparecieron cinco reseñas marcadas como enviadas que nunca
//     salieron. Esta pantalla es el único sitio donde se ve la cola: el día que el worker
//     (`services/review.js`) vuelva a fallar, sin ella no se entera nadie.
//
// Si algún día se borran de verdad, hay que sustituir antes esas dos capacidades —
// desbloquear una clienta y ver la cola de reseñas—, no solo la ruta.
//
// «Pagos» (`/stripe`) sí se borró entero el 07/08/2026: era un placeholder con badge SOON
// que no hacía nada, y su hueco lo ocupa ahora Caja.
const salonSettingsItems: NavItem[] = [
  // Caja y Facturación van juntas y en este orden: una registra lo que entra, la otra lo
  // valora. Caja estuvo en PRINCIPAL hasta el 07/08/2026.
  { href: "/caja", label: "Caja", icon: Banknote },
  // Entrada propia y no una pestaña dentro de Caja: son dos usos distintos, con dos días por
  // defecto distintos. Caja es el mostrador y abre en HOY; Revisión es el repaso de la dueña
  // desde casa y abre en AYER, porque el TPV no está en el banco hasta el día siguiente.
  { href: "/caja/revision", label: "Revisión de caja", icon: ClipboardCheck },
  { href: "/facturacion", label: "Facturación", icon: Receipt },
  { href: "/lista-vip", label: "Lista VIP", icon: Star },
  { href: "/campanas", label: "Campañas", icon: Megaphone },
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

/**
 * ¿Es ESTE el item que corresponde a la ruta actual?
 *
 * Gana el href MÁS LARGO que casa. Con `startsWith` a secas, una ruta anidada encendía dos
 * entradas a la vez: desde el 07/08/2026 `/caja/revision` cuelga de `/caja`, y las dos se
 * pintaban activas. Y casar por prefijo crudo tiene otra trampa —`/caja` casaría con
 * `/cajaX`—, así que el prefijo se exige con la barra.
 */
function esActivo(href: string, pathname: string, hrefs: string[]): boolean {
  if (href === "/") return pathname === "/";
  const casa = (h: string) => pathname === h || pathname.startsWith(`${h}/`);
  if (!casa(href)) return false;
  return !hrefs.some((otro) => otro !== href && otro.length > href.length && casa(otro));
}

export function AppSidebar() {
  const pathname = usePathname();
  const { orgName, orgType, loading } = useOrg();
  const { status: botStatus } = useBotStatus();
  const pill = BOT_STATUS_PILL[botStatus];

  const navItems = orgType === "salon" ? salonNavItems : restaurantNavItems;
  const settingsItems = orgType === "salon" ? salonSettingsItems : restaurantSettingsItems;
  // Los dos grupos juntos: el desempate por href más largo tiene que mirar TODAS las entradas
  // visibles, no solo las de su grupo.
  const todosLosHrefs = [...navItems, ...settingsItems].map((i) => i.href);
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

      {/* Tallas del menú (07/08/2026, con las dos organizaciones a la vez — no hay variante
          por orgType: dos sidebars por 2px sería deuda permanente). Los tres overrides de
          abajo se repiten en los dos grupos y van explicados una sola vez aquí:
            · SidebarMenu gap-0.5 — las filas iban pegadas (gap-0), y como el estado activo
              es un fondo relleno se leía como una banda soldada al hover de al lado en vez
              de como una pastilla.
            · SidebarMenuButton h-9 — 32px es densidad de menú de quince entradas; con diez
              el icono y el texto dejan de ir apretados. En modo icono manda igual el
              size-8! de la base, así que la barra plegada no cambia.
            · SidebarGroupLabel h-7 — con la h-8 de la base la etiqueta medía lo mismo que
              una fila y pesaba como un item más en vez de como un encabezado. El -mt-7 va
              EMPAREJADO a esa altura: el -mt-8 de la base existe para plegarla en modo
              icono, y sobre 28px tiraría 4px de más y subiría el grupo entero.
          Los iconos no llevan size: el variant del botón impone [&_svg]:size-4 por CSS, que
          gana al atributo del SVG. El size={15} que hubo aquí no hacía nada. El del pie sí
          cuenta —está fuera del botón— y por eso se queda. */}
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="h-7 group-data-[collapsible=icon]:-mt-7 text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70 font-semibold">
            Principal
          </SidebarGroupLabel>
          <SidebarMenu className="gap-0.5">
            {navItems.map(({ href, label, icon: Icon }) => {
              const active =
                esActivo(href, pathname, todosLosHrefs);
              return (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton
                    isActive={active}
                    tooltip={label}
                    className="h-9 gap-2.5"
                    render={<Link href={href} />}
                  >
                    <Icon
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
          <SidebarGroupLabel className="h-7 group-data-[collapsible=icon]:-mt-7 text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70 font-semibold">
            Gestión
          </SidebarGroupLabel>
          <SidebarMenu className="gap-0.5">
            {settingsItems.map(({ href, label, icon: Icon }) => {
              const active = esActivo(href, pathname, todosLosHrefs);
              return (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton
                    isActive={active}
                    tooltip={label}
                    className="h-9 gap-2.5"
                    render={<Link href={href} />}
                  >
                    <Icon
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
