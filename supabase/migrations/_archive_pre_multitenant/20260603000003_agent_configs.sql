-- Tabla de configuración del agente editable desde el dashboard
CREATE TABLE IF NOT EXISTS agent_configs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    system_prompt   text,
    tone            text NOT NULL DEFAULT 'amigable',
    services        jsonb NOT NULL DEFAULT '[]',
    business_hours  jsonb NOT NULL DEFAULT '{}',
    handoff_message text,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Seed con valores actuales de config.json
INSERT INTO agent_configs (tone, services, business_hours, handoff_message)
VALUES (
    'amigable',
    '[
        {"nombre":"Consulta inicial","duracion":30,"precio":0},
        {"nombre":"Botox","duracion":45,"precio":0},
        {"nombre":"Relleno de labios","duracion":60,"precio":0},
        {"nombre":"Limpieza facial","duracion":60,"precio":0},
        {"nombre":"Mesoterapia","duracion":60,"precio":0}
    ]'::jsonb,
    '{
        "lunes":    {"apertura":"10:00","cierre":"20:00"},
        "martes":   {"apertura":"10:00","cierre":"20:00"},
        "miercoles":{"apertura":"10:00","cierre":"20:00"},
        "jueves":   {"apertura":"10:00","cierre":"20:00"},
        "viernes":  {"apertura":"10:00","cierre":"20:00"},
        "sabado":   {"apertura":"10:00","cierre":"14:00"},
        "domingo":  null
    }'::jsonb,
    'Un momento, te paso con un miembro del equipo.'
);

ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;
