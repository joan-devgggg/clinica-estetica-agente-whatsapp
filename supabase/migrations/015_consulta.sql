-- ============================================================
-- 015_consulta.sql — Servicio "Consulta" (valoración) para Sante
-- ============================================================
-- Consulta de valoración: la estilista asesora a la clienta cuando no sabe qué
-- servicio quiere. La consulta en sí dura 20 min, pero se reserva un bloque de
-- 300 min (5 h) en la agenda por si la clienta hace el servicio recomendado a
-- continuación. Precio no fijo → se confirma en el salón (precio = null).
-- Lo hacen las 4 estilistas de pelo general: Veronika, Irina, Yulia, Natalia.

DO $$
DECLARE
  sante_org   UUID := 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
  veronika_id UUID := 'c3d4e5f6-a7b8-9012-cdef-234567890101';
  irina_id    UUID := 'c3d4e5f6-a7b8-9012-cdef-234567890102';
  yulia_id    UUID := 'c3d4e5f6-a7b8-9012-cdef-234567890103';
  natalia_id  UUID := 'c3d4e5f6-a7b8-9012-cdef-234567890107';
BEGIN
  -- Catálogo: añadir la categoría/servicio "Consulta" (idempotente)
  UPDATE agent_configs
  SET services = services || '[{"categoria":"Consulta","nombre":"Consulta","precio":null,"duracion":300}]'::JSONB
  WHERE organization_id = sante_org
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(services) AS e
      WHERE e->>'categoria' = 'Consulta'
    );

  -- Skill "Consulta" a las 4 estilistas de pelo general (idempotente).
  -- NO se añade a Yulia-Tricóloga (…0108), Tetiana (…0106), Olgha ni Larisa.
  UPDATE stylists
  SET skills = skills || '["Consulta"]'::JSONB
  WHERE organization_id = sante_org
    AND id IN (veronika_id, irina_id, yulia_id, natalia_id)
    AND NOT (skills @> '["Consulta"]'::JSONB);
END $$;
