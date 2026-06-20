-- ============================================================
-- 002_seed.sql — Organización inicial y configuración base
-- Restaurante San Remo (Palencia)
-- ============================================================

-- Organización del restaurante (UUID fijo para referenciarlo en .env)
INSERT INTO organizations (id, name, slug, timezone)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'Restaurante San Remo',
  'restaurante-san-remo',
  'Europe/Madrid'
)
ON CONFLICT (id) DO NOTHING;

-- Configuración del agente con valores de config.json
INSERT INTO agent_configs (organization_id, system_prompt, tone, business_info, services, business_hours, handoff_message)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  '',
  'elegante y cercano',
  '{
    "companyName": "Restaurante San Remo",
    "botName": "PENDIENTE - Nombre del Bot",
    "owner": "Alberto",
    "direccion": "PENDIENTE - Dirección del restaurante (Palencia)",
    "bizum": {
      "numero": "PENDIENTE - Número Bizum",
      "importe": 0
    },
    "faqs": {
      "horarios": "PENDIENTE - Horarios de apertura",
      "carta": "PENDIENTE - Información sobre la carta",
      "parking": "PENDIENTE - Información sobre parking",
      "alergias": "PENDIENTE - Información sobre alérgenos"
    },
    "vip": {
      "visitasParaSugerir": 3
    }
  }'::JSONB,
  '[]'::JSONB,
  '{
    "lunes":    {"apertura": "13:00", "cierre": "16:00"},
    "martes":   {"apertura": "13:00", "cierre": "16:00"},
    "miercoles":{"apertura": "13:00", "cierre": "16:00"},
    "jueves":   {"apertura": "13:00", "cierre": "16:00"},
    "viernes":  {"apertura": "13:00", "cierre": "23:30"},
    "sabado":   {"apertura": "13:00", "cierre": "23:30"},
    "domingo":  {"apertura": "13:00", "cierre": "16:00"}
  }'::JSONB,
  'Un momento, le paso tu mensaje a Alberto.'
)
ON CONFLICT (organization_id) DO NOTHING;

-- Configuración general
INSERT INTO config (organization_id, clave, valor) VALUES
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'bot_activo', 'true'),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'minutos_recordatorio', '1440')
ON CONFLICT (organization_id, clave) DO NOTHING;
