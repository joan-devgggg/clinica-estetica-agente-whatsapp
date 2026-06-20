-- ============================================================
-- 006_proxima_stylist.sql — Añade proxima_stylist_id al RPC de
-- stats de contacto (estilista de la PRÓXIMA cita confirmada),
-- para que el CRM muestre la estilista de citas creadas a mano.
-- ============================================================

-- DROP necesario: cambia el tipo de retorno (no permitido por CREATE OR REPLACE).
DROP FUNCTION IF EXISTS get_contact_stats(uuid);

CREATE FUNCTION get_contact_stats(p_org_id UUID)
RETURNS TABLE(
  contact_id UUID,
  total_visitas BIGINT,
  ultima_cita_real TIMESTAMPTZ,
  proxima_cita TIMESTAMPTZ,
  ultimo_servicio TEXT,
  ultimo_stylist_id UUID,
  proxima_stylist_id UUID
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
     ORDER BY a2.starts_at DESC LIMIT 1),
    (SELECT a2.stylist_id FROM appointments a2
     WHERE a2.contact_id = a.contact_id AND a2.organization_id = p_org_id
       AND a2.status = 'confirmed' AND a2.starts_at > NOW()
     ORDER BY a2.starts_at ASC LIMIT 1)
  FROM appointments a
  WHERE a.organization_id = p_org_id
  GROUP BY a.contact_id;
$$ LANGUAGE SQL STABLE;
