-- ============================================================
-- 004_sante_tables.sql — Tablas de estilistas, horarios y bloqueos
-- + columnas nuevas en appointments/contacts para salón
-- ============================================================

-- ────────────────────────────────────────────────
-- stylists (equipo del salón)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stylists (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL,
  skills           JSONB DEFAULT '[]'::JSONB,
  active           BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE stylists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stylists_service_role" ON stylists
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "stylists_authenticated_own" ON stylists
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS stylists_org_idx ON stylists (organization_id);

-- ────────────────────────────────────────────────
-- stylist_schedules (horario semanal recurrente)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stylist_schedules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stylist_id       UUID NOT NULL REFERENCES stylists(id) ON DELETE CASCADE,
  day_of_week      INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time       TIME NOT NULL,
  end_time         TIME NOT NULL,
  UNIQUE (stylist_id, day_of_week)
);

ALTER TABLE stylist_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stylist_schedules_service_role" ON stylist_schedules
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "stylist_schedules_authenticated_own" ON stylist_schedules
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS stylist_schedules_stylist_idx ON stylist_schedules (stylist_id, day_of_week);

-- ────────────────────────────────────────────────
-- schedule_blocks (bloqueos manuales: vacaciones, descansos, etc.)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schedule_blocks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stylist_id       UUID NOT NULL REFERENCES stylists(id) ON DELETE CASCADE,
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ NOT NULL,
  reason           TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE schedule_blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "schedule_blocks_service_role" ON schedule_blocks
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "schedule_blocks_authenticated_own" ON schedule_blocks
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS schedule_blocks_stylist_range_idx ON schedule_blocks (stylist_id, starts_at, ends_at);

-- ────────────────────────────────────────────────
-- appointments — columna de estilista (nullable para San Remo)
-- ────────────────────────────────────────────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS stylist_id UUID REFERENCES stylists(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS appointments_stylist_idx ON appointments (stylist_id) WHERE stylist_id IS NOT NULL;

-- ────────────────────────────────────────────────
-- contacts — estilista habitual + idioma
-- ────────────────────────────────────────────────
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS preferred_stylist_id UUID REFERENCES stylists(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'es';

-- ────────────────────────────────────────────────
-- Seed: Estilistas de Sante
-- ────────────────────────────────────────────────
DO $$
DECLARE
  sante_org UUID := 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
  veronika_id UUID := 'c3d4e5f6-a7b8-9012-cdef-234567890101';
  irina_id    UUID := 'c3d4e5f6-a7b8-9012-cdef-234567890102';
  yulia_id    UUID := 'c3d4e5f6-a7b8-9012-cdef-234567890103';
  olgha_id    UUID := 'c3d4e5f6-a7b8-9012-cdef-234567890104';
  larisa_id   UUID := 'c3d4e5f6-a7b8-9012-cdef-234567890105';

  hair_skills JSONB := '["Alisado vegano","Anti-encrespamiento","Brillo Glow","Color Premium","Cortes","Deco Total Blond","Exfoliación cabeza","Lavar y peinar","Matiz mujer","Mechas Airtouch","Mechas clásicas","Mechas Contouring","Reconstrucción","Retocar","Spa Hair","Tratamiento Orgánico"]';
  tricho_skills JSONB := '["Diagnóstico Capilar","Dermapen Hair Loss"]';
  nail_skills JSONB := '["Manicura/Pedicura"]';
  spa_skills JSONB := '["Masajes y SPA"]';
BEGIN
  -- Estilistas
  INSERT INTO stylists (id, organization_id, name, role, skills) VALUES
    (veronika_id, sante_org, 'Veronika', 'colorista/estilista', hair_skills),
    (irina_id,    sante_org, 'Irina',    'colorista/estilista', hair_skills),
    (yulia_id,    sante_org, 'Yulia',    'colorista/estilista + diagnóstico capilar', hair_skills || tricho_skills),
    (olgha_id,    sante_org, 'Olgha',    'manicura/pedicura', nail_skills),
    (larisa_id,   sante_org, 'Larisa',   'masajes/spa', spa_skills)
  ON CONFLICT (id) DO NOTHING;

  -- Horarios semanales
  -- Veronika, Irina, Yulia, Larisa: lunes(0) a sábado(5) 10:00-19:00
  INSERT INTO stylist_schedules (organization_id, stylist_id, day_of_week, start_time, end_time)
  SELECT sante_org, s.id, d.dow, '10:00'::TIME, '19:00'::TIME
  FROM (VALUES (veronika_id), (irina_id), (yulia_id), (larisa_id)) AS s(id)
  CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5)) AS d(dow)
  ON CONFLICT (stylist_id, day_of_week) DO NOTHING;

  -- Olgha: solo martes(1), jueves(3), viernes(4) 10:00-19:00
  INSERT INTO stylist_schedules (organization_id, stylist_id, day_of_week, start_time, end_time)
  VALUES
    (sante_org, olgha_id, 1, '10:00'::TIME, '19:00'::TIME),
    (sante_org, olgha_id, 3, '10:00'::TIME, '19:00'::TIME),
    (sante_org, olgha_id, 4, '10:00'::TIME, '19:00'::TIME)
  ON CONFLICT (stylist_id, day_of_week) DO NOTHING;
END $$;

-- Config de Telegram admins para Sante (placeholder — la dueña pondrá su ID)
INSERT INTO config (organization_id, clave, valor)
VALUES ('b2c3d4e5-f6a7-8901-bcde-f12345678901', 'telegram_admins', '[]')
ON CONFLICT (organization_id, clave) DO NOTHING;

-- Config de Telegram admins para San Remo (migrar los ALLOWED_USERS del .env)
INSERT INTO config (organization_id, clave, valor)
VALUES ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'telegram_admins', '[]')
ON CONFLICT (organization_id, clave) DO NOTHING;
