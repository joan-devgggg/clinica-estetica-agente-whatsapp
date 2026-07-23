# Inventario CRM — Clínica Estética

## 1. Páginas / Rutas existentes

El dashboard actual es un SPA de una sola página (`dashboard/index.html`) con 3 vistas navegadas por JS:

| Vista | ID | Descripción |
|---|---|---|
| Leads | `view-leads` | Lista/tabla de leads + panel de edición inline |
| Citas | `view-citas` | Calendario semanal con citas agrupadas por día |
| Configuración | `view-config` | Formularios de datos de clínica, tratamientos, horario, bot |

Ruta Express que sirve el HTML: `GET /dashboard`

## 2. Componentes visuales actuales

### Layout / Navegación
- `Sidebar` — desktop (200px), links a las 3 vistas + estado del bot + toggle on/off
- `Topbar` — mobile, nombre clínica + botón hamburguesa
- `BottomNav` — mobile, 3 tabs (Leads / Citas / Config)
- `FAB` — botón flotante "+" para crear nueva cita manual

### Vista Leads
- `StatsGrid` — 4 KPI cards (Total leads, Confirmadas, Hoy, Semana) — solo números, sin gráfico
- `LeadsTable` — tabla desktop con columnas: Nombre, Teléfono, Tratamiento, Estado, acciones
- `LeadCards` — tarjetas mobile una por lead
- `LeadEditPanel` — panel inline de edición: nombre, tratamiento, estado, fecha, hora, notas

### Vista Citas
- `CalendarWeekStrip` — selector horizontal de días de la semana activa
- `AppointmentCards` — tarjetas de cita agrupadas por secciones: HOY, PRÓXIMAS, ANTERIORES
- `WeekStats` — mini stats: semana, hoy, mañana (solo mobile)

### Vista Configuración (4 secciones)
- `ClinicaInfoForm` — campos: nombre, teléfono, email, dirección, descripción, Google Reviews link
- `InfoAdicionalList` — lista dinámica de bloques de texto libre para el bot
- `TratamientosList` — lista editable de tratamientos (nombre, duración, precio) con add/edit/delete
- `HorarioSemanal` — grid de los 7 días con apertura/cierre editables por click
- `AutomacionForm` — minutos reseña, horas recordatorio
- `BotToggle` — switch activo/pausado (aparece en sidebar y en config)

### Modales
- `Modal: Nueva cita manual` — formulario: nombre, teléfono, tratamiento, fecha, hora, notas
- `Modal: Detalle lead` — vista de lectura del lead seleccionado
- `Modal: Editar tratamiento` — nombre, duración (min), precio (€)
- `Modal: Editar horario día` — apertura, cierre + opción "cerrar este día"

### Feedback
- `Toast` — notificación temporal de éxito/error (esquina inferior)

## 3. Gestor de estado

**Ninguno.** Variables globales en scope del script:

```js
let allLeads = []
let currentLeadId = null
let allCitas = []
let configData = {}
```

Sin Zustand, sin Redux, sin Context API — JavaScript vanilla puro.

## 4. Librería de gráficos actual

**Ninguna.** Las KPI cards son solo números grandes (`font-size: 26px; font-weight: 800`). No hay sparklines, barras ni charts de ningún tipo.

## 5. Tailwind — versión

Tailwind **CDN** cargado via `<script src="https://cdn.tailwindcss.com">` — sin instalación npm, sin config, probablemente v3. Las clases de utilidad se usan mínimamente; la mayoría del estilo es CSS custom en `<style>`.

## 6. Datos que maneja el CRM

### Leads / Clientes
| Campo | Tipo | Valores |
|---|---|---|
| id | integer | autoincrement |
| nombre | texto | |
| telefono | texto | clave de búsqueda |
| tratamiento | texto | |
| estado_cita | select | pendiente / confirmado / completado / cancelado |
| fecha_cita | fecha | |
| hora_cita | texto | HH:MM |
| notas | texto largo | |
| created_at | datetime | |

### Configuración (tabla `config` en SQLite)
| Clave | Tipo de valor |
|---|---|
| `clinica_info` | JSON: {nombre, telefono, email, dirección, descripcion, google_review_link} |
| `servicios` | JSON array: [{nombre, duracion_min, precio}] |
| `horario` | JSON: {lun: {apertura, cierre, abierto}, mar: ..., ...} |
| `minutos_resena` | número |
| `horas_recordatorio` | número |
| `info_adicional` | JSON array: [{titulo, texto}] |
| `bot_activo` | boolean |

### Stats (calculadas en tiempo real)
- Total leads, Confirmadas, Citas hoy, Citas esta semana

## 7. API REST (Express — misma instancia que el bot)

| Método | Endpoint | Descripción |
|---|---|---|
| GET | `/api/leads` | Lista leads (params: limit, since, search, estado) |
| GET | `/api/leads/:id` | Detalle de un lead |
| POST | `/api/leads` | Crear lead manual |
| PUT | `/api/leads/:id` | Editar lead |
| DELETE | `/api/leads/:id` | Eliminar lead |
| GET | `/api/citas` | Citas filtradas por rango de fecha (params: desde, hasta) |
| GET | `/api/stats` | KPIs: total, confirmadas, hoy, semana |
| GET | `/api/config` | Toda la configuración |
| PUT | `/api/config/:clave` | Actualizar una clave de config |

## 8. Stack actual (resumen)

```
Servidor:    Node.js + Express (CommonJS)
Base de datos: SQLite (better-sqlite3) — archivos en /data/
Dashboard:   HTML + CSS vanilla + Tailwind CDN + JavaScript vanilla
Fuente:      system-ui (sin tipografía custom)
Gráficos:    ninguno
Framework:   ninguno (no React, no Vue, no Next.js)
Build step:  ninguno
```

## 9. Deuda de diseño actual

- Tema oscuro purple/violet (#7c3aed, #db2777) — diametralmente opuesto al nuevo design system
- Gradientes agresivos en todos los headers
- Emojis en la UI (💅, 🗑, ✓, 🕐)
- Sin tipografía cargada (system-ui)
- KPI cards sin diferenciación visual entre ellas
- Sin animaciones ni transiciones
- Sin accesibilidad (no aria-labels, no roles)
