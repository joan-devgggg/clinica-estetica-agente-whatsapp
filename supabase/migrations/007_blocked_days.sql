-- Blocked days: whole-day blocking per stylist or for the entire salon
CREATE TABLE IF NOT EXISTS blocked_days (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stylist_id       UUID REFERENCES stylists(id) ON DELETE CASCADE,  -- NULL = whole salon
  fecha            DATE NOT NULL,
  motivo           TEXT NOT NULL DEFAULT 'otro',  -- vacaciones, festivo, cierre, otro
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE blocked_days ENABLE ROW LEVEL SECURITY;

CREATE POLICY "blocked_days_service_role" ON blocked_days
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "blocked_days_authenticated_own" ON blocked_days
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS blocked_days_org_fecha_idx
  ON blocked_days (organization_id, fecha);

CREATE INDEX IF NOT EXISTS blocked_days_stylist_fecha_idx
  ON blocked_days (stylist_id, fecha)
  WHERE stylist_id IS NOT NULL;

-- Prevent duplicate blocks for the same org+date+stylist combo
CREATE UNIQUE INDEX IF NOT EXISTS blocked_days_unique_idx
  ON blocked_days (organization_id, fecha, COALESCE(stylist_id, '00000000-0000-0000-0000-000000000000'));
