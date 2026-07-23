-- Migración: índices compuestos y constraint UNIQUE en wa_message_id
-- Aplica en producción con: supabase db push

-- 1. UNIQUE en messages.wa_message_id (evita duplicados de mensajes WA)
ALTER TABLE messages
  ADD CONSTRAINT messages_wa_message_id_unique UNIQUE (wa_message_id);

-- 2. Índice compuesto messages(lead_id, timestamp DESC) — acelera el historial por lead
CREATE INDEX IF NOT EXISTS idx_messages_lead_timestamp
  ON messages (lead_id, timestamp DESC);

-- 3. Índice compuesto leads(estado_cita, fecha_cita) — acelera filtros de citas por estado
CREATE INDEX IF NOT EXISTS idx_leads_estado_fecha
  ON leads (estado_cita, fecha_cita);
