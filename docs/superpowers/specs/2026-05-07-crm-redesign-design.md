# CRM Clínica Estética — Rediseño Visual

**Fecha:** 2026-05-07
**Scope:** Rediseño visual completo del dashboard Next.js (`dashboard-app/`). Cero cambios a lógica de negocio, API, estado o rutas.

## Contexto

El CRM actual es un HTML vanilla de 1230 líneas con tema oscuro purple/violet servido por Express. Se migra a Next.js 16 App Router (scaffolded en `dashboard-app/`) con shadcn/ui + Tremor + Fraunces + Geist.

Stack nuevo: Next.js 16.2.5 · React 19 · Tailwind v4 · shadcn 4.7 · recharts · lucide-react · geist font.
API backend: Express en puerto 3000 — no se toca.

## Dirección estética

"Luxury refined minimalism" — Aesop, La Mer, clínica privada europea.
Aprobado visualmente: ivory background, terracotta primary, sage accent, tipografía Fraunces+Geist, badges semánticos suaves, KPI cards diferenciadas.
Referencia completa en `/DESIGN.md`.

## Paleta (OKLCH Tailwind v4)

| Token | Valor | Uso |
|---|---|---|
| `--background` | `oklch(0.985 0.005 80)` | Ivory cálido |
| `--foreground` | `oklch(0.22 0.02 30)` | Graphite |
| `--primary` | `oklch(0.55 0.07 25)` | Terracotta — CTAs, active nav |
| `--secondary` | `oklch(0.92 0.02 90)` | Champagne — active nav bg |
| `--accent` | `oklch(0.78 0.04 160)` | Sage — bot activo, tendencia positiva |
| `--muted` | `oklch(0.96 0.008 80)` | Alt rows, hover bg |
| `--muted-foreground` | `oklch(0.5 0.02 30)` | Labels, placeholders |
| `--card` | `oklch(1 0 0)` | Superficie de cards y sidebar |
| `--border` | `oklch(0.9 0.01 80)` | Bordes sutiles |
| `--destructive` | `oklch(0.55 0.18 28)` | Errores, cancelado |

## Tipografía

- **Display/headings:** Fraunces (Google Fonts) — weight 400/600, line-height 1.15
- **UI/body:** Geist Sans (npm `geist`) — weight 400/500/600, line-height 1.5
- **Mono/datos:** Geist Mono
- **Escala:** 11 / 12 / 13.5 / 14 / 16 / 20 / 28 / 32 / 40px

## Estructura de rutas (App Router)

```
src/app/
├── layout.tsx          ← Root layout: fuentes, SidebarProvider, TooltipProvider
├── globals.css         ← Tokens CSS (OKLCH), @import fuentes, resets
├── page.tsx            ← Dashboard home: KPIs + actividad reciente
├── leads/
│   └── page.tsx        ← Tabla leads + filtros + panel edición
├── citas/
│   └── page.tsx        ← Agenda semanal + appointment cards
└── configuracion/
    └── page.tsx        ← Formularios: clínica, tratamientos, horario, bot

src/components/
├── layout/
│   ├── app-sidebar.tsx     ← Sidebar shadcn con nav + bot status
│   └── page-header.tsx     ← Header con Fraunces + fecha
├── dashboard/
│   ├── kpi-cards.tsx       ← 4 KPI cards diferenciadas
│   └── recent-activity.tsx ← Lista actividad reciente
├── leads/
│   ├── leads-table.tsx     ← Table shadcn con avatares y badges
│   ├── lead-filters.tsx    ← Input search + Select estado
│   └── lead-edit-sheet.tsx ← Sheet shadcn para edición
├── citas/
│   ├── week-strip.tsx      ← Selector de días horizontal
│   └── appointment-card.tsx ← Card de cita con badge estado
├── configuracion/
│   ├── clinica-form.tsx    ← Datos de la clínica
│   ├── tratamientos-list.tsx ← CRUD tratamientos
│   ├── horario-grid.tsx    ← 7 días editables
│   └── bot-toggle.tsx      ← Switch activo/pausado
└── ui/                     ← shadcn auto-generados (no tocar)
```

## Reglas de implementación

- Nunca modificar: handlers, fetch calls, validaciones, nombres de props, rutas, config files
- Solo tocar: JSX estructura/clases, globals.css, reemplazar divs custom por componentes shadcn
- Cards: `shadow-sm` únicamente, `border border-border/60`
- Tablas: alternating rows suaves, header small-caps, sin grid lines verticales
- Botones: `variant="default"` (primary) o `variant="ghost"` / `variant="outline"`
- Sin gradientes purple/blue, sin emojis en UI, sin `shadow-2xl`
- Motion: `transition-all duration-200 ease-out`

## Badges de estado

| Estado | bg | color |
|---|---|---|
| confirmado | sage/15% | sage oscuro |
| pendiente | champagne/60% | warm brown |
| completado | cool blue/20% | cool blue oscuro |
| cancelado | terracotta/10% | terracotta oscuro |

## KPI cards (variación obligatoria)

1. Total leads — número + flecha de tendencia + % vs mes anterior
2. Citas semana — número + sparkline CSS (7 barras)
3. Confirmadas — número + progress bar hacia objetivo mensual
4. Citas hoy — número + próxima cita (nombre + hora + tratamiento)

## API calls (datos reales desde Express :3000)

```ts
GET  /api/stats          → { total, confirmadas, hoy, semana }
GET  /api/leads          → Lead[]
GET  /api/leads/:id      → Lead
POST /api/leads          → Lead
PUT  /api/leads/:id      → Lead
DEL  /api/leads/:id      → void
GET  /api/citas          → Cita[] (params: desde, hasta)
GET  /api/config         → Config
PUT  /api/config/:clave  → void
```

## Orden de ejecución

1. `globals.css` — tokens, fuentes, chart vars
2. `layout.tsx` — SidebarProvider, TooltipProvider, Fraunces+Geist
3. `app-sidebar.tsx` + `page-header.tsx`
4. `page.tsx` — KPI cards + actividad reciente
5. `leads/page.tsx` + componentes de tabla
6. `citas/page.tsx` + week strip + appointment cards
7. `configuracion/page.tsx` + formularios
8. Empty states, loading skeletons, toast

## Verificación por paso

Después de cada sección: `npx tsc --noEmit` sin errores, datos siguen renderizando.
Al terminar: `npm run build` limpio.
