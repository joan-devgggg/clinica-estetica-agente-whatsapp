# Design System — CRM Clínica Estética

## Dirección estética
"Luxury refined minimalism" — premium, calmado, profesional médico-estético.
Inspiración visual: Aesop, La Mer, clínicas privadas de lujo europeas.
El dashboard debe sentirse como una herramienta de alta gama, no como un SaaS genérico.

## Tipografía
- Display/headings: Fraunces (serif moderna, weight 400 y 600)
- UI/body: Geist Sans (weight 400/500/600)
- Datos/mono: Geist Mono
- Escala: 12 / 14 / 16 / 20 / 28 / 40px
- Line-height: 1.5 en body, 1.15 en display

## Paleta de colores (OKLCH — Tailwind v4)
:root {
  --background: oklch(0.985 0.005 80);      /* ivory cálido, no blanco puro */
  --foreground: oklch(0.22 0.02 30);        /* graphite cálido, no negro */
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.22 0.02 30);
  --muted: oklch(0.96 0.008 80);
  --muted-foreground: oklch(0.5 0.02 30);
  --primary: oklch(0.55 0.07 25);           /* terracotta apagada — acento principal */
  --primary-foreground: oklch(0.99 0 0);
  --secondary: oklch(0.92 0.02 90);         /* champagne */
  --secondary-foreground: oklch(0.22 0.02 30);
  --accent: oklch(0.78 0.04 160);           /* sage suave — acento secundario */
  --accent-foreground: oklch(0.22 0.02 30);
  --destructive: oklch(0.55 0.18 28);
  --border: oklch(0.9 0.01 80);
  --input: oklch(0.9 0.01 80);
  --ring: oklch(0.55 0.07 25);
  --radius: 0.625rem;
}

## Reglas de diseño (OBLIGATORIAS)
- Cards: border border-border/60, shadow-sm únicamente. NUNCA shadow-2xl.
- KPI cards: siempre variadas (1 con trend arrow, 1 con progress bar, 1 con sparkline, 1 comparativa). NUNCA 4 idénticas.
- Sidebar: estilo inset, iconos lucide en thin/stroke, ancho 260px.
- Botones primarios: filled con primary. Secundarios: ghost o outline.
- Inputs: height h-9, placeholder en muted-foreground.
- Tablas: alternating row subtle bg, sin grid lines verticales, header en small-caps.
- Texto: nunca negro puro (#000), siempre foreground token.
- Sin gradientes purple/blue. Sin emojis en UI. Sin bordes rainbow.
- Motion: transition-all duration-200 ease-out. Sutil, nunca decorativo.
