-- broadcast_sends: registro de a quién se le mandó cada campaña. 02/08/2026.
--
-- Hasta ahora un broadcast no dejaba rastro: waSendMessage (bot.js) NO persiste nada —
-- solo sendWithDelay escribe en `messages`. Sin registro no se puede (a) continuar una
-- campaña al día siguiente sin repetir destinatarios, ni (b) contar cuántos envíos van en
-- las últimas 24 h para no chocar con el límite del número.
--
-- El UNIQUE es la garantía de verdad, no el SELECT previo: dos pestañas del panel dándole
-- a "enviar" a la vez pasan las dos el filtro de "ya enviados" y solo una gana el INSERT.
-- Por eso el motor RESERVA la fila (status='pending') ANTES de llamar a Meta y luego la
-- marca 'sent'/'failed'. Si el proceso muere a media tanda, el peor caso es una clienta
-- que no recibe — nunca una que recibe dos veces, que es lo que hunde la calidad del
-- número ante Meta.
--
-- `failed` NO bloquea: getBroadcastSentPhones solo devuelve 'sent', así que un fallo
-- transitorio se reintenta solo en la siguiente tanda.
CREATE TABLE IF NOT EXISTS broadcast_sends (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_key     TEXT NOT NULL,
  contact_id       UUID REFERENCES contacts(id) ON DELETE SET NULL,
  wa_phone         TEXT NOT NULL,
  -- 'free_text' (dentro de ventana de 24 h o canal wwebjs) | 'template' (fuera de ventana)
  mode             TEXT,
  template_name    TEXT,
  -- 'pending' → 'sent' | 'failed'
  status           TEXT NOT NULL DEFAULT 'pending',
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at          TIMESTAMPTZ
);

ALTER TABLE broadcast_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY "broadcast_sends_service_role" ON broadcast_sends
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "broadcast_sends_authenticated_own" ON broadcast_sends
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

-- Un destinatario, una vez por campaña. Es lo que hace idempotente el reintento de tanda.
CREATE UNIQUE INDEX IF NOT EXISTS broadcast_sends_unique_idx
  ON broadcast_sends (organization_id, campaign_key, wa_phone);

-- Filtro "¿a quién le falta?" de cada tanda.
CREATE INDEX IF NOT EXISTS broadcast_sends_org_campaign_idx
  ON broadcast_sends (organization_id, campaign_key, status);

-- Contador rodante de las últimas 24 h (tope del número). Cuenta TODAS las campañas de la
-- org, no solo la actual: el límite lo impone Meta sobre el número, no sobre la campaña.
CREATE INDEX IF NOT EXISTS broadcast_sends_org_sent_at_idx
  ON broadcast_sends (organization_id, sent_at);
