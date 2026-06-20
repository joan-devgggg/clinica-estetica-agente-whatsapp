-- ============================================================
-- 005_source_and_fixes.sql — Source field, status constraint fix,
-- contact stats RPC for CRM enrichment
-- ============================================================

-- ── Source column on appointments ──────────────────────────────
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'bot';

-- ── Fix status CHECK to include 'pending' (San Remo bizum flow) ─
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed'));

-- ── RPC: contact appointment stats (CRM enrichment) ───────────
CREATE OR REPLACE FUNCTION get_contact_stats(p_org_id UUID)
RETURNS TABLE(
  contact_id UUID,
  total_visitas BIGINT,
  ultima_cita_real TIMESTAMPTZ,
  proxima_cita TIMESTAMPTZ,
  ultimo_servicio TEXT,
  ultimo_stylist_id UUID
) AS $$
  SELECT
    a.contact_id,
    COUNT(*) FILTER (WHERE a.status = 'completed'),
    MAX(a.starts_at) FILTER (WHERE a.status = 'completed'),
    MIN(a.starts_at) FILTER (WHERE a.status = 'confirmed' AND a.starts_at > NOW()),
    (SELECT a2.service FROM appointments a2
     WHERE a2.contact_id = a.contact_id AND a2.organization_id = p_org_id
       AND a2.status = 'completed'
     ORDER BY a2.starts_at DESC LIMIT 1),
    (SELECT a2.stylist_id FROM appointments a2
     WHERE a2.contact_id = a.contact_id AND a2.organization_id = p_org_id
       AND a2.status = 'completed'
     ORDER BY a2.starts_at DESC LIMIT 1)
  FROM appointments a
  WHERE a.organization_id = p_org_id
  GROUP BY a.contact_id;
$$ LANGUAGE SQL STABLE;
