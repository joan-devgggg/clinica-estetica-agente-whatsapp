-- ============================================================
-- 018_balayage_precios_upsell_decoloracion.sql — Sante
-- ============================================================
-- Cambios pedidos por Yulia (dueña del salón):
--
-- 1) Precios de Mechas Balayage: corto 170→180, medio 170→190, largo 190→200.
--    "XL / cambio importante" se queda en 230. Las duraciones no cambian.
--
-- 2) Upselling de Reconstrucción tras CUALQUIER técnica de decoloración. Hasta
--    ahora la regla genérica "Mechas" alcanzaba por substring a Airtouch,
--    Contouring y clásicas, pero "Deco Total Blond" se quedaba fuera. Ahora hay
--    una regla explícita por categoría, con `tono: "cuidado_decoloracion"` para
--    que el bot lo ofrezca como consejo de cuidado y no como venta (la plantilla
--    vive en services/helpers.js → buildSanteConfirmationMessage).
--
--    La sugerencia apunta al nombre EXACTO de catálogo "Reconstrucción"
--    (35 € / 60 min): así resolveServiceDurationMin la resuelve por match exacto
--    —no por fuzzy— y el nombre que acaba en appointments.service si la clienta
--    la acepta es un nombre de catálogo real.
--
-- OJO: la fila viva de agent_configs había divergido de las migraciones (Mechas
-- Balayage y las reglas de upsell actuales no estaban en ningún .sql). Este
-- script está escrito contra la forma VIVA. Es idempotente: reejecutarlo deja
-- exactamente los mismos valores.

DO $$
DECLARE
  sante_org UUID := 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
BEGIN
  -- ── 1) Precios de Mechas Balayage ──────────────────────────────────────────
  -- Se reconstruye el array preservando el orden original (WITH ORDINALITY) y el
  -- resto de servicios intactos.
  UPDATE agent_configs
  SET services = (
    SELECT jsonb_agg(
      CASE
        WHEN e->>'categoria' = 'Mechas Balayage' AND e->>'nombre' = 'Cabello corto'
          THEN jsonb_set(e, '{precio}', '180'::JSONB)
        WHEN e->>'categoria' = 'Mechas Balayage' AND e->>'nombre' = 'Cabello medio'
          THEN jsonb_set(e, '{precio}', '190'::JSONB)
        WHEN e->>'categoria' = 'Mechas Balayage' AND e->>'nombre' = 'Cabello largo'
          THEN jsonb_set(e, '{precio}', '200'::JSONB)
        ELSE e
      END
      ORDER BY ord
    )
    FROM jsonb_array_elements(services) WITH ORDINALITY AS t(e, ord)
  )
  WHERE organization_id = sante_org;

  -- ── 2) Reglas de upselling ─────────────────────────────────────────────────
  UPDATE agent_configs
  SET business_info = jsonb_set(
    business_info,
    '{upselling}',
    '[
      {"servicio":"Color raíz",       "sugerencias":["Manicura","Ampolla de cuidado","Retocar","Reconstrucción molecular"]},
      {"servicio":"Mechas Balayage",  "sugerencias":["Reconstrucción"], "tono":"cuidado_decoloracion"},
      {"servicio":"Mechas Airtouch",  "sugerencias":["Reconstrucción"], "tono":"cuidado_decoloracion"},
      {"servicio":"Mechas Contouring","sugerencias":["Reconstrucción"], "tono":"cuidado_decoloracion"},
      {"servicio":"Mechas clásicas",  "sugerencias":["Reconstrucción"], "tono":"cuidado_decoloracion"},
      {"servicio":"Deco Total Blond", "sugerencias":["Reconstrucción"], "tono":"cuidado_decoloracion"},
      {"servicio":"Corte",            "sugerencias":["Exfoliación del cuero cabelludo","Matiz","Tratamiento capilar personalizado"]},
      {"servicio":"Lavar y peinar",   "sugerencias":["Exfoliación del cuero cabelludo","Tratamiento hidratación"]}
    ]'::JSONB,
    true
  )
  WHERE organization_id = sante_org;
END $$;
