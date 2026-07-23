-- ============================================================
-- 002_seed.sql — Organización inicial y configuración base
-- ============================================================

-- Organización de la clínica (UUID fijo para referenciarlo en .env)
INSERT INTO organizations (id, name, slug, timezone)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'Clínica Estética',
  'clinica-estetica',
  'Europe/Madrid'
)
ON CONFLICT (id) DO NOTHING;

-- Configuración del agente con valores de config.json
INSERT INTO agent_configs (organization_id, system_prompt, tone, business_info, services, business_hours, handoff_message)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  '',
  'profesional y cálido',
  '{
    "companyName": "PENDIENTE - Nombre de la Clínica",
    "botName": "PENDIENTE - Nombre del Bot",
    "direccion": "PENDIENTE - Dirección de la clínica",
    "googleReviewLink": "PENDIENTE - Link de Google Reviews"
  }'::JSONB,
  '[
    {"nombre": "Consulta inicial", "duracion": 30, "precio": 0},
    {"nombre": "Botox", "duracion": 45, "precio": 0},
    {"nombre": "Relleno de labios", "duracion": 60, "precio": 0},
    {"nombre": "Limpieza facial", "duracion": 60, "precio": 0},
    {"nombre": "Mesoterapia", "duracion": 60, "precio": 0}
  ]'::JSONB,
  '{
    "lunes":    {"apertura": "10:00", "cierre": "20:00"},
    "martes":   {"apertura": "10:00", "cierre": "20:00"},
    "miercoles":{"apertura": "10:00", "cierre": "20:00"},
    "jueves":   {"apertura": "10:00", "cierre": "20:00"},
    "viernes":  {"apertura": "10:00", "cierre": "20:00"},
    "sabado":   {"apertura": "10:00", "cierre": "14:00"},
    "domingo":  null
  }'::JSONB,
  'Te paso con un agente en un momento.'
)
ON CONFLICT (organization_id) DO NOTHING;

-- Configuración de recordatorios y reseñas
INSERT INTO config (organization_id, clave, valor) VALUES
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'bot_activo', 'true'),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'minutos_resena', '30'),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'minutos_recordatorio', '60')
ON CONFLICT (organization_id, clave) DO NOTHING;
