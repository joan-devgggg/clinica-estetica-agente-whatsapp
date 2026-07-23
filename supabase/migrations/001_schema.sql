-- ============================================================
-- 001_schema.sql — Schema multi-tenant completo
-- Proyecto: Clínica Estética - Agente WhatsApp
-- ============================================================

-- ────────────────────────────────────────────────
-- organizations
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'Europe/Madrid',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_service_role" ON organizations
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "org_authenticated_own" ON organizations
  FOR SELECT TO authenticated
  USING (id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

-- ────────────────────────────────────────────────
-- profiles (extiende auth.users)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id               UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id  UUID REFERENCES organizations(id) ON DELETE CASCADE,
  full_name        TEXT,
  role             TEXT CHECK (role IN ('owner', 'staff')) DEFAULT 'owner',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_service_role" ON profiles
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "profiles_authenticated_own" ON profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY "profiles_authenticated_update" ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid());

-- ────────────────────────────────────────────────
-- whatsapp_configs (Cloud API — placeholder para migración futura)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_configs (
  organization_id       UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  phone_number_id       TEXT NOT NULL DEFAULT '',
  waba_id               TEXT NOT NULL DEFAULT '',
  access_token_encrypted TEXT NOT NULL DEFAULT '',
  verify_token          TEXT NOT NULL DEFAULT '',
  app_secret_encrypted  TEXT NOT NULL DEFAULT '',
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE whatsapp_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wa_configs_service_role" ON whatsapp_configs
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "wa_configs_authenticated_own" ON whatsapp_configs
  FOR SELECT TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

-- ────────────────────────────────────────────────
-- google_calendar_configs
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS google_calendar_configs (
  organization_id         UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  calendar_id             TEXT NOT NULL DEFAULT '',
  refresh_token_encrypted TEXT NOT NULL DEFAULT '',
  access_token_encrypted  TEXT DEFAULT '',
  token_expires_at        TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE google_calendar_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gcal_configs_service_role" ON google_calendar_configs
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "gcal_configs_authenticated_own" ON google_calendar_configs
  FOR SELECT TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

-- ────────────────────────────────────────────────
-- agent_configs
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_configs (
  organization_id  UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  system_prompt    TEXT NOT NULL DEFAULT '',
  tone             TEXT NOT NULL DEFAULT 'profesional y cálido',
  business_info    JSONB NOT NULL DEFAULT '{}'::JSONB,
  services         JSONB NOT NULL DEFAULT '[]'::JSONB,
  business_hours   JSONB NOT NULL DEFAULT '{}'::JSONB,
  handoff_message  TEXT DEFAULT 'Te paso con un agente en un momento.',
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_configs_service_role" ON agent_configs
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "agent_configs_authenticated_own" ON agent_configs
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

-- ────────────────────────────────────────────────
-- config (key-value global por organización)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config (
  organization_id  UUID REFERENCES organizations(id) ON DELETE CASCADE,
  clave            TEXT NOT NULL,
  valor            TEXT,
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (organization_id, clave)
);

ALTER TABLE config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "config_service_role" ON config
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "config_authenticated_own" ON config
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

-- ────────────────────────────────────────────────
-- contacts (clientes que han escrito por WhatsApp)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  wa_phone         TEXT NOT NULL,
  full_name        TEXT,
  is_new_patient   BOOLEAN,
  metadata         JSONB DEFAULT '{}'::JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (organization_id, wa_phone)
);

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "contacts_service_role" ON contacts
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "contacts_authenticated_own" ON contacts
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS contacts_org_phone_idx ON contacts (organization_id, wa_phone);
CREATE INDEX IF NOT EXISTS contacts_created_at_idx ON contacts (created_at DESC);

-- ────────────────────────────────────────────────
-- conversations (hilo por contacto)
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  bot_active       BOOLEAN DEFAULT TRUE,
  last_message_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversations_service_role" ON conversations
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "conversations_authenticated_own" ON conversations
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS conversations_org_last_msg_idx ON conversations (organization_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_contact_id_idx ON conversations (contact_id);

-- ────────────────────────────────────────────────
-- messages
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  wa_message_id    TEXT UNIQUE,
  direction        TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender           TEXT NOT NULL CHECK (sender IN ('contact', 'bot', 'human')),
  content          TEXT,
  raw              JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "messages_service_role" ON messages
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "messages_authenticated_own" ON messages
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS messages_conv_created_idx ON messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_org_created_idx ON messages (organization_id, created_at DESC);

-- ────────────────────────────────────────────────
-- appointments
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id            UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  service               TEXT NOT NULL,
  starts_at             TIMESTAMPTZ NOT NULL,
  ends_at               TIMESTAMPTZ NOT NULL,
  google_event_id       TEXT,
  status                TEXT CHECK (status IN ('confirmed', 'cancelled', 'completed')) DEFAULT 'confirmed',
  is_new_patient        BOOLEAN,
  full_name             TEXT NOT NULL,
  phone                 TEXT NOT NULL,
  notes                 TEXT,
  resena_enviada        BOOLEAN DEFAULT FALSE,
  recordatorio_enviado  BOOLEAN DEFAULT FALSE,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "appointments_service_role" ON appointments
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "appointments_authenticated_own" ON appointments
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS appointments_org_starts_idx ON appointments (organization_id, starts_at);
CREATE INDEX IF NOT EXISTS appointments_contact_id_idx ON appointments (contact_id);
CREATE INDEX IF NOT EXISTS appointments_status_idx ON appointments (status);

-- ────────────────────────────────────────────────
-- Realtime
-- ────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
