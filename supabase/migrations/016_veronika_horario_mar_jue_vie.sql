-- Veronika deja de trabajar lunes, miércoles y sábado (2026-07-23).
-- Nuevo horario: martes, jueves, viernes, 10:00-19:00. Solo Sante, no afecta a San Remo.
-- Convención day_of_week (ver 004_sante_tables.sql): 0=lunes … 5=sábado.
-- Idempotente: el DELETE no hace nada si ya se aplicó.
DO $$
DECLARE
  veronika_id UUID := 'c3d4e5f6-a7b8-9012-cdef-234567890101';
BEGIN
  DELETE FROM stylist_schedules
  WHERE stylist_id = veronika_id
    AND day_of_week IN (0, 2, 5); -- lunes, miércoles, sábado
END $$;
