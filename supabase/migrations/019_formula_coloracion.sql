-- Fórmula de coloración de la clienta (texto libre, solo la última se conserva).
-- Solo se usa en Sante (isSalon); el bot nunca la rellena, solo el panel.
-- Ya aplicada en la BD remota vía migración ad-hoc (add_formula_coloracion_to_contacts,
-- 2026-07-17); este fichero la deja versionada en el repo. Idempotente.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS formula_coloracion text;
