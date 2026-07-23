-- Tabla separada de citas, desacoplada de leads
CREATE TABLE IF NOT EXISTS appointments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id     uuid REFERENCES leads(id) ON DELETE CASCADE,
    servicio    text,
    fecha       date,
    hora        text,
    estado      text NOT NULL DEFAULT 'confirmed'
                    CHECK (estado IN ('confirmed', 'cancelled', 'completed')),
    notas       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appointments_lead_id     ON appointments(lead_id);
CREATE INDEX IF NOT EXISTS idx_appointments_fecha       ON appointments(fecha);
CREATE INDEX IF NOT EXISTS idx_appointments_estado_fecha ON appointments(estado, fecha);

-- Migrar citas existentes desde leads
INSERT INTO appointments (lead_id, servicio, fecha, hora, estado, created_at)
SELECT
    id,
    tratamiento,
    fecha_cita,
    hora_cita,
    CASE estado_cita
        WHEN 'confirmado'  THEN 'confirmed'
        WHEN 'completado'  THEN 'completed'
        WHEN 'cancelado'   THEN 'cancelled'
        ELSE 'confirmed'
    END,
    COALESCE(updated_at, created_at)
FROM leads
WHERE fecha_cita IS NOT NULL;

-- Sincronizar appointment_id en leads con el id del appointment migrado
UPDATE leads l
SET appointment_id = a.id::text
FROM appointments a
WHERE a.lead_id = l.id
  AND l.appointment_id IS NULL;

-- RLS: mismas políticas que el resto (service_role bypasses RLS)
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
