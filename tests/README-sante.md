# Pruebas del bot de Sante (salón)

Dos suites para validar el flujo de Sante antes de producción.

## 1. Deterministas (sin LLM) — rápidas y fiables

```bash
node tests/sante-deterministic.js
```

Cubre el motor de huecos (`calendar-sante`), la extracción (`helpers`), los workers
de recordatorio/reseña y la sincronización con el panel (capa `db`):

- Manicura → solo Olgha (Mar/Jue/Vie); masaje → solo Larisa y huecos < 16:00.
- Estilista preferida en día que trabaja vs. día libre (alternativas reales + flag).
- Domingo cerrado, preferencia "mañana", filtrado por skill.
- Detección de idioma, servicio, estilista, segunda cita, intención cancelar/cambiar.
- Reminder worker encuentra la cita denormalizada; review worker encuentra completadas.
- Cita manual del panel aparece en Citas/Agenda; marcar completada → `visit_count +1`.

> Las aserciones contra Supabase reintentan ante el lag read-after-write de la Data API.

## 2. Flujos con LLM real — conversaciones completas

```bash
node tests/sante-llm-flows.js                 # todos los escenarios
node tests/sante-llm-flows.js s1_manicura     # uno
node tests/sante-llm-flows.js s8_english,s9   # varios (coma)
```

Conduce conversaciones vía `handleIncomingMessage` con un cliente WA simulado y verifica
el estado final (cita en Supabase, estilista correcta, idioma, calidad de mensajes:
sin markdown y ≤ 1000 caracteres). Requiere `OPENROUTER_API_KEY` y Supabase.

Escenarios: manicura, corte con Veronika (día válido / día libre), masaje, color + upselling,
segunda cita para acompañante, clienta recurrente, inglés/ruso, cambio de idioma,
cancelación (48h), lista negra, toggle del bot.

> Nota: la latencia de OpenRouter puede superar los 30 s; el harness espera hasta 90 s por
> turno y trata "Un momento" como mensaje no final (valida el patrón espera → respuesta real).

Los datos de prueba usan teléfonos `34600000xxx` y se limpian al terminar.
