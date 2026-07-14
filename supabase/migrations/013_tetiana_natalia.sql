-- Nuevas estilistas de Sante: Tetiana (extensiones, solo agenda manual) y Natalia
-- (mismos skills que Irina, todos los servicios de pelo).
DO $$
DECLARE
  sante_org UUID := 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
  tetiana_id UUID := 'c3d4e5f6-a7b8-9012-cdef-234567890106';
  natalia_id UUID := 'c3d4e5f6-a7b8-9012-cdef-234567890107';
  irina_skills JSONB;
BEGIN
  SELECT skills INTO irina_skills FROM stylists
  WHERE id = 'c3d4e5f6-a7b8-9012-cdef-234567890102';

  INSERT INTO stylists (id, organization_id, name, role, skills) VALUES
    (tetiana_id, sante_org, 'Tetiana', 'extensiones de cabello', '["Extensiones de cabello"]'::JSONB),
    (natalia_id, sante_org, 'Natalia', 'colorista/estilista', irina_skills)
  ON CONFLICT (id) DO NOTHING;

  -- Tetiana: martes(1), miércoles(2), jueves(3), sábado(5) 10:00-19:00
  INSERT INTO stylist_schedules (organization_id, stylist_id, day_of_week, start_time, end_time)
  VALUES
    (sante_org, tetiana_id, 1, '10:00'::TIME, '19:00'::TIME),
    (sante_org, tetiana_id, 2, '10:00'::TIME, '19:00'::TIME),
    (sante_org, tetiana_id, 3, '10:00'::TIME, '19:00'::TIME),
    (sante_org, tetiana_id, 5, '10:00'::TIME, '19:00'::TIME)
  ON CONFLICT (stylist_id, day_of_week) DO NOTHING;

  -- Natalia: miércoles(2), jueves(3), viernes(4), sábado(5) 10:00-19:00
  INSERT INTO stylist_schedules (organization_id, stylist_id, day_of_week, start_time, end_time)
  VALUES
    (sante_org, natalia_id, 2, '10:00'::TIME, '19:00'::TIME),
    (sante_org, natalia_id, 3, '10:00'::TIME, '19:00'::TIME),
    (sante_org, natalia_id, 4, '10:00'::TIME, '19:00'::TIME),
    (sante_org, natalia_id, 5, '10:00'::TIME, '19:00'::TIME)
  ON CONFLICT (stylist_id, day_of_week) DO NOTHING;
END $$;
