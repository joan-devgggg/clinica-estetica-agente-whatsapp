# Dashboard CRM — Clínica Estética

**Fecha:** 2026-05-04  
**Estado:** Aprobado, listo para implementación

## Objetivo

Reemplazar Airtable con un dashboard web propio integrado en el servidor Express de Railway. Cero coste, sin dependencias externas para los datos. La clínica gestiona leads, citas y configuración desde una URL pública.

## Stack

- **Backend:** Express (ya existente en `server.js`) — se añaden rutas `/dashboard/*`
- **Base de datos:** SQLite via `better-sqlite3` (ya en `package.json`) — reemplaza Airtable completamente
- **Frontend:** HTML + Tailwind CSS via CDN — sin build step, sin framework
- **Acceso:** URL pública en Railway, sin login por ahora
- **Calendario:** Interno — el bot gestiona disponibilidad mirando SQLite. Sin Calendly ni Google Calendar.

## Estilo visual

App premium oscura con acento morado/rosa:
- Fondo: `#0f0f13`
- Superficie: `#1a1a2e`
- Header: gradiente `linear-gradient(135deg, #7c3aed, #db2777)`
- Texto principal: `#e2e8f0`
- Texto secundario: `#64748b`
- Acento: `#a78bfa` (morado), `#db2777` (rosa)

Navegación inferior fija: Leads / Citas / Config.

## Pantallas

### 1. Leads

**Lista principal:**
- Tarjeta por lead: nombre, tratamiento, badge de estado (color), fecha y hora de cita
- Colores de estado: confirmado `#34d399`, en chat `#a78bfa`, pendiente `#f59e0b`, cancelado `#ef4444`, completado `#64748b`
- Orden: primero los más recientes

**Detalle de lead (al hacer clic):**
- Header con gradiente: nombre, teléfono, badge de estado
- Campos editables: tratamiento (select), estado (select), fecha cita, hora cita
- Campo de notas internas (textarea)
- Botón "Guardar cambios"
- Botón "Eliminar lead" (destructivo, con confirmación)

### 2. Citas (Calendario)

**Vista semanal:**
- Header con gradiente: semana actual, navegación anterior/hoy/siguiente
- Resumen rápido: citas esta semana / hoy / mañana
- Botón "＋ Nueva cita" (blanco, prominente)
- Columnas L–V con franjas horarias (10–14 y 16–20)
- Pausa de mediodía marcada automáticamente según horario configurado
- Huecos libres visibles (cuadro con borde punteado)
- Citas coloreadas por tipo de tratamiento con leyenda

**Colores por tratamiento:**
- Botox/Toxina: `#a78bfa`
- Rellenos: `#f59e0b`
- Láser/Peeling: `#34d399`
- Facial/Hidratación: `#38bdf8`
- Otros: `#db2777`

**Modal "Nueva cita" (reserva manual):**
- Campos: nombre, teléfono, tratamiento (select), fecha, hora, notas
- Se guarda en SQLite como un lead con `origen = 'manual'` y `estado = 'confirmado'`

### 3. Configuración

Pantalla única con scroll, dividida en 5 secciones:

**🏥 Información de la clínica**
- Nombre, teléfono, email, dirección
- Descripción larga (el bot la usa en conversación)
- Link Google Reviews
- Botón "Guardar información"

**📌 Información adicional**
- Bloques libres: título + texto (ej: "Aparcamiento", "Formas de pago", "Preguntas frecuentes")
- Botón "＋ Añadir información"
- Cada bloque: botón ✕ para eliminar
- El bot carga todos estos bloques en su contexto para responder preguntas

**✨ Tratamientos**
- Lista: nombre, duración (min), precio (€)
- Por tratamiento: botón ✎ editar, botón ✕ eliminar
- Botón "＋ Añadir tratamiento"
- Edición en modal (mismo estilo que "Nueva cita")

**🕐 Horario por día**
- 7 columnas (L–D), cada una con franja mañana y tarde (o cerrado)
- Click en día para editar horas

**🤖 Automatizaciones**
- Tiempo reseña tras cita (minutos, editable)
- Tiempo recordatorio antes de cita (horas, editable)
- Toggle on/off bot WhatsApp

## Base de datos SQLite

Reemplaza Airtable. Mismos datos, sin API externa.

### Tabla `leads`
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
nombre TEXT
telefono TEXT
tratamiento TEXT
preferencia_horaria TEXT
fecha_cita TEXT
hora_cita TEXT
estado_cita TEXT  -- pendiente | en_conversacion | confirmado | completado | cancelado
resena_enviada INTEGER DEFAULT 0
recordatorio_enviado INTEGER DEFAULT 0
origen TEXT  -- instagram_ads | manual
notas TEXT
airtable_record_id TEXT  -- legacy, puede ser null
created_at TEXT DEFAULT (datetime('now'))
updated_at TEXT DEFAULT (datetime('now'))
```

### Tabla `config`
```sql
clave TEXT PRIMARY KEY
valor TEXT  -- JSON serializado
updated_at TEXT DEFAULT (datetime('now'))
```

Claves de config:
- `clinica_info` → `{nombre, telefono, email, direccion, descripcion, google_review_link}`
- `info_adicional` → `[{titulo, texto}, ...]`
- `servicios` → `[{nombre, duracion_min, precio}, ...]`
- `horario` → `{lunes: {manana: "10:00-14:00", tarde: "16:00-20:00"}, martes: ..., ...}`
- `minutos_resena` → número
- `horas_recordatorio` → número
- `bot_activo` → boolean

## Arquitectura de rutas Express

```
GET  /dashboard              → HTML del dashboard (SPA simple)
GET  /api/leads              → lista de leads
POST /api/leads              → crear lead manual
GET  /api/leads/:id          → detalle de lead
PUT  /api/leads/:id          → actualizar lead
DELETE /api/leads/:id        → eliminar lead
GET  /api/citas              → citas en rango de fechas (?desde=&hasta=)
POST /api/citas              → nueva cita manual
GET  /api/config/:clave      → obtener valor de config
PUT  /api/config/:clave      → guardar valor de config
```

## Migración desde Airtable

1. Se crea `services/db.js` con SQLite — mismo interface que `services/airtable.js`
2. Se actualiza `services/airtable.js` para delegar a SQLite (o se reemplaza directamente)
3. Las variables `AIRTABLE_API_KEY` y `AIRTABLE_BASE_ID` dejan de ser requeridas
4. El bot y los workers (review, reminder) usan el mismo módulo `db.js`

## Archivos nuevos / modificados

| Archivo | Acción |
|---|---|
| `services/db.js` | Nuevo — SQLite, mismo interface que airtable.js |
| `services/airtable.js` | Reemplazar por wrapper a db.js (o eliminar) |
| `dashboard/index.html` | Nuevo — SPA del dashboard |
| `dashboard/leads.js` | Nuevo — lógica pantalla leads |
| `dashboard/citas.js` | Nuevo — lógica pantalla citas/calendario |
| `dashboard/config.js` | Nuevo — lógica pantalla configuración |
| `server.js` | Añadir rutas `/dashboard` y `/api/*` |

## Fuera de alcance (por ahora)

- Login / autenticación
- Integración con calendario externo (Calendly, Google Calendar)
- Exportación de datos a CSV/Excel
- Notificaciones push en el dashboard
- Vista de estadísticas/métricas avanzadas
