-- Ejecutar en el SQL Editor de Supabase (https://supabase.com/dashboard)
-- Proyecto: bteoncgjpfqllnknwjdf
-- Seleccionar todo (Cmd+A) y pulsar RUN

CREATE TABLE IF NOT EXISTS leads (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre                TEXT,
  telefono              TEXT,
  tratamiento           TEXT,
  preferencia_horaria   TEXT,
  fecha_cita            DATE,
  hora_cita             TEXT,
  estado_cita           TEXT DEFAULT 'pendiente',
  bot_mode              TEXT DEFAULT 'auto',
  resena_enviada        BOOLEAN DEFAULT FALSE,
  recordatorio_enviado  BOOLEAN DEFAULT FALSE,
  origen                TEXT DEFAULT 'instagram_ads',
  notas                 TEXT,
  appointment_id        TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS config (
  clave       TEXT PRIMARY KEY,
  valor       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id     BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  telefono    TEXT NOT NULL,
  direccion   TEXT NOT NULL CHECK (direccion IN ('entrante', 'saliente')),
  contenido   TEXT NOT NULL,
  es_manual   BOOLEAN DEFAULT FALSE,
  timestamp   TIMESTAMPTZ DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS leads_telefono_idx     ON leads (telefono);
CREATE INDEX IF NOT EXISTS leads_estado_idx       ON leads (estado_cita);
CREATE INDEX IF NOT EXISTS leads_fecha_cita_idx   ON leads (fecha_cita);
CREATE INDEX IF NOT EXISTS leads_created_at_idx   ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS messages_lead_id_idx   ON messages (lead_id);
CREATE INDEX IF NOT EXISTS messages_telefono_idx  ON messages (telefono);
CREATE INDEX IF NOT EXISTS messages_timestamp_idx ON messages (timestamp DESC);

-- RLS
ALTER TABLE leads    ENABLE ROW LEVEL SECURITY;
ALTER TABLE config   ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Realtime: habilitar cambios en tiempo real para el dashboard
ALTER PUBLICATION supabase_realtime ADD TABLE leads;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;

-- Políticas de lectura para el dashboard (publishable/anon key)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dashboard_read_leads') THEN
    CREATE POLICY "dashboard_read_leads"    ON leads    FOR SELECT TO anon USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dashboard_read_messages') THEN
    CREATE POLICY "dashboard_read_messages" ON messages FOR SELECT TO anon USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dashboard_read_config') THEN
    CREATE POLICY "dashboard_read_config"   ON config   FOR SELECT TO anon USING (true);
  END IF;
END $$;
