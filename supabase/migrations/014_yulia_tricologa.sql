-- Nueva estilista de Sante: Yulia-Tricóloga (dueña real del salón), distinta de la
-- estilista "Yulia" ya existente. Solo atiende Dermapen Hair Loss y Diagnóstico
-- Capilar (consulta tricológica) — nada de pelo general.
DO $$
DECLARE
  sante_org UUID := 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
  yulia_tricologa_id UUID := 'c3d4e5f6-a7b8-9012-cdef-234567890108';
BEGIN
  INSERT INTO stylists (id, organization_id, name, role, skills) VALUES
    (yulia_tricologa_id, sante_org, 'Yulia-Tricóloga', 'tricóloga (dueña del salón)',
     '["Dermapen Hair Loss","Diagnóstico Capilar"]'::JSONB)
  ON CONFLICT (id) DO NOTHING;

  -- Lunes(0) y miércoles(2) 10:00-19:00
  INSERT INTO stylist_schedules (organization_id, stylist_id, day_of_week, start_time, end_time)
  VALUES
    (sante_org, yulia_tricologa_id, 0, '10:00'::TIME, '19:00'::TIME),
    (sante_org, yulia_tricologa_id, 2, '10:00'::TIME, '19:00'::TIME)
  ON CONFLICT (stylist_id, day_of_week) DO NOTHING;
END $$;
