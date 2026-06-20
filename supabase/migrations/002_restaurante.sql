-- ============================================================
-- 002_restaurante.sql — Adaptación a Restaurante San Remo
-- - Completa columnas de "reserva activa" en contacts que db.js
--   ya esperaba pero faltaban en 001_schema.sql
-- - Añade lista negra / VIP / preferencias a contacts
-- - Añade personas, ocasión y estado de Bizum a appointments
-- - Crea pending_actions (cola de verificación por Telegram)
-- ============================================================

-- ────────────────────────────────────────────────
-- contacts — caché de la reserva activa + ficha de cliente
-- ────────────────────────────────────────────────
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS estado               TEXT DEFAULT 'pendiente',
  ADD COLUMN IF NOT EXISTS fecha_cita           DATE,
  ADD COLUMN IF NOT EXISTS hora_cita            TEXT,
  ADD COLUMN IF NOT EXISTS party_size           INT,
  ADD COLUMN IF NOT EXISTS occasion             TEXT,
  ADD COLUMN IF NOT EXISTS notas                TEXT,
  ADD COLUMN IF NOT EXISTS origen               TEXT,
  ADD COLUMN IF NOT EXISTS appointment_id       TEXT,
  ADD COLUMN IF NOT EXISTS bot_mode             TEXT DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS recordatorio_enviado BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS is_blacklisted       BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS blacklist_reason     TEXT,
  ADD COLUMN IF NOT EXISTS is_vip               BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS visit_count          INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allergies            TEXT,
  ADD COLUMN IF NOT EXISTS preferences          TEXT;

CREATE INDEX IF NOT EXISTS contacts_blacklist_idx ON contacts (organization_id, is_blacklisted) WHERE is_blacklisted;
CREATE INDEX IF NOT EXISTS contacts_vip_idx ON contacts (organization_id, is_vip) WHERE is_vip;

-- ────────────────────────────────────────────────
-- appointments — reservas (personas, ocasión, bizum, no-show)
-- ────────────────────────────────────────────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS party_size    INT,
  ADD COLUMN IF NOT EXISTS occasion      TEXT,
  ADD COLUMN IF NOT EXISTS bizum_status  TEXT CHECK (bizum_status IN ('pending', 'confirmed', 'rejected', 'not_required')) DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS bizum_amount  NUMERIC,
  ADD COLUMN IF NOT EXISTS no_show       BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS appointments_bizum_status_idx ON appointments (organization_id, bizum_status);

-- ────────────────────────────────────────────────
-- pending_actions — cola de verificaciones para Telegram (Alberto)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_actions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('bizum_review', 'vip_suggestion', 'escalation')),
  contact_id       UUID REFERENCES contacts(id) ON DELETE CASCADE,
  appointment_id   UUID REFERENCES appointments(id) ON DELETE CASCADE,
  payload          JSONB DEFAULT '{}'::JSONB,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'resolved')) DEFAULT 'pending',
  resolution       TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ
);

ALTER TABLE pending_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pending_actions_service_role" ON pending_actions
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "pending_actions_authenticated_own" ON pending_actions
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS pending_actions_org_status_idx ON pending_actions (organization_id, type, status);
