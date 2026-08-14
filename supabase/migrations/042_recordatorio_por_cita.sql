-- 042_recordatorio_por_cita.sql
--
-- ⚠️ ESCRITA EN LA SESIÓN NOCTURNA DEL 14/08/2026 Y **NO APLICADA** (regla de la noche:
-- ninguna migración se aplica sin permiso). Revisar entera antes de aplicar.
--
-- CONTEXTO. El recordatorio de 24 h del salón colgaba de la FICHA
-- (contacts.estado='confirmado' + contacts.recordatorio_enviado + contacts.fecha_cita),
-- tres campos que la conversación y el panel pisan. Medido el 14/08 sobre las 19 citas
-- futuras confirmadas de Sante:
--   · Dasha Kotenko: cita creada desde el panel sin tocar la ficha (estado 'pendiente')
--     → recordatorio que no salía NUNCA, sin síntoma.
--   · Barbora Jalova: respondió al recordatorio y el propio turno del bot le regresó la
--     ficha a 'pendiente' (bot.js, saveLead de fin de turno con estado_cita en duro).
--   · Nieves Armengol: ficha con fecha_cita=2026-08-08 (vieja) y cita real el 29/08 →
--     ventana calculada con la fecha equivocada, envío imposible.
-- Desde el commit de esta noche, getAppointmentsPendientesRecordatorio enruta el salón a
-- appointments (status='confirmed' + recordatorio_enviado=false + starts_at futuro).
--
-- QUÉ HACE ESTA MIGRACIÓN. Backfill de la marca: copia a appointments.recordatorio_enviado
-- los recordatorios que el sistema VIEJO ya entregó, para que la cita quede como única
-- fuente. Criterio: la ficha dice enviado Y su fecha_cita es EXACTAMENTE el día (Madrid)
-- de esa cita — es decir, la marca habla de ESTA cita y no de una anterior. Con la marca
-- vieja o de otro día NO se copia: esa clienta no recibió el de esta cita.
--
-- ORDEN DE DESPLIEGUE. El código lleva una guarda de transición equivalente
-- (construirPendientesDesdeCitas, services/db.js), así que NO hay carrera aunque el
-- código llegue antes que la migración. Aplicarla deja appointments como fuente única y
-- permite retirar la guarda cuando ya no queden citas futuras marcadas solo en ficha.
--
-- MEDIDO ANTES DE ESCRIBIRLA (14/08, ~01:00 Madrid): afectaría a 6 filas —
-- Barbora Jalova, Victoria Nazarenko, Victoria, Gisvell G·Perez, Tatiana Krol y
-- Tatiana Reka (todas con cita el 14/08 y recordatorio ya recibido el 13/08).
-- Ejecutar el SELECT de abajo antes del UPDATE y comprobar que salen esas u otras con el
-- mismo patrón (ya-recordadas de citas aún futuras).
--
-- SELECT de comprobación (solo lectura):
--   SELECT a.id, coalesce(nullif(c.full_name,''), a.full_name) AS quien, a.starts_at
--   FROM appointments a JOIN contacts c ON c.id = a.contact_id
--   WHERE c.organization_id = a.organization_id
--     AND a.status = 'confirmed' AND a.starts_at > now()
--     AND a.recordatorio_enviado = false
--     AND c.recordatorio_enviado = true
--     AND c.fecha_cita = (a.starts_at AT TIME ZONE 'Europe/Madrid')::date;
--
-- Idempotente: re-ejecutarla no toca nada nuevo.

UPDATE appointments a
SET recordatorio_enviado = true
FROM contacts c
WHERE c.id = a.contact_id
  AND c.organization_id = a.organization_id
  AND a.status = 'confirmed'
  AND a.starts_at > now()
  AND a.recordatorio_enviado = false
  AND c.recordatorio_enviado = true
  AND c.fecha_cita = (a.starts_at AT TIME ZONE 'Europe/Madrid')::date;
