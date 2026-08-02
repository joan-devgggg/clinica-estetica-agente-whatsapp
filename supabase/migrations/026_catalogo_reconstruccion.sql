-- ============================================================
-- 026_catalogo_reconstruccion.sql — Sante
-- ============================================================
-- Yulia (dueña) reordena la categoría "Reconstrucción". Queda con 3 entradas, todas
-- con el prefijo "Reconstrucción" para que la clienta vea de qué familia son:
--
--   • "Reconstrucción K18"                    35€ / 15 min  (ex "Aplicación K18")
--   • "Reconstrucción K18 + lavar y peinar"   60€ / 60 min  (ex "K18")
--   • "Reconstrucción Pro Miracle"            60€ / 60 min  (ex "Pro Miracle Repair TEMPTING", 65→60€)
--
-- Y se BORRA la entrada "Reconstrucción" a secas (35€/60min): Yulia confirma que era
-- un duplicado creado por error, no un producto distinto. Esto invalida el supuesto
-- central de la migración 024 (que la trataba como "un producto real y DISTINTO de
-- K18" y por eso dejaba las reglas de upselling intactas).
--
-- Citas existentes: la única cita de la BD que nombra alguno de estos servicios es
-- "Mechas Contouring + Matiz plus + K18" (completed, 2026-08-01), y está protegida
-- por el snapshot de facturación (precio_facturado=270.00, facturado_at=2026-08-02,
-- migración 021). computeFacturacion lee el importe congelado y NO recalcula, así que
-- renombrar el catálogo no reescribe ese periodo ya cerrado. No hay ninguna cita sin
-- snapshot que referencie estos nombres.
--
-- ── Upselling post-decoloración ──────────────────────────────────────────────
-- Las 5 reglas `cuidado_decoloracion` apuntaban al nombre exacto "Reconstrucción",
-- que deja de existir. Pasan a "Reconstrucción K18" (35€/15min), que es el correcto
-- para ese caso: tras un color el lavado y el peinado YA van incluidos, así que lo
-- que se añade son solo los 15 min de aplicar producto. Apuntarlas al de 60 min
-- habría cobrado una hora de lavar+peinar que la clienta ya tiene en el color.
--
-- "Reconstrucción molecular" (sugerencia de Color raíz) NO se toca: es una etiqueta
-- de marketing, no un nombre de catálogo, y ya se resuelve por la vía de etiquetas
-- (resolveServiceDurationMin / shouldDiscardUpsellForClosing).
--
-- ── Efecto en el matcher (ver services/helpers.js) ───────────────────────────
-- Tras el renombrado ya no existe una entrada llamada exactamente "K18", así que
-- extractServiceFromText deja de resolver un "k18" a secas (cae a null) y resuelve
-- "reconstrucción k18" al complemento de 15 min. Ambos son inseguros por sí solos,
-- por eso esta migración va acompañada de la extensión de resolveK18ComplementIfNeeded:
-- una mención genérica de K18 sin color en la sesión resuelve al de 60 min, y solo
-- resuelve al complemento cuando el servicio principal ya es una técnica de color.

DO $$
DECLARE
  sante_org UUID := 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
BEGIN
  -- ── 1) Catálogo: renombrar las 3 entradas que se quedan y borrar el duplicado ──
  -- El borrado va en el mismo paso que el renombrado (un WHERE del jsonb_agg) para
  -- que no exista un estado intermedio con nombres nuevos y el duplicado aún vivo.
  UPDATE agent_configs
  SET services = COALESCE((
    SELECT jsonb_agg(
      CASE
        WHEN e->>'categoria' = 'Reconstrucción' AND e->>'nombre' = 'Aplicación K18'
          THEN jsonb_set(e, '{nombre}', '"Reconstrucción K18"'::JSONB)
        WHEN e->>'categoria' = 'Reconstrucción' AND e->>'nombre' = 'K18'
          THEN jsonb_set(e, '{nombre}', '"Reconstrucción K18 + lavar y peinar"'::JSONB)
        WHEN e->>'categoria' = 'Reconstrucción' AND e->>'nombre' = 'Pro Miracle Repair TEMPTING'
          THEN jsonb_set(
                 jsonb_set(e, '{nombre}', '"Reconstrucción Pro Miracle"'::JSONB),
                 '{precio}', '60'::JSONB)
        ELSE e
      END
      ORDER BY ord
    )
    FROM jsonb_array_elements(services) WITH ORDINALITY AS t(e, ord)
    -- Borrado del duplicado: nombre EXACTO "Reconstrucción" (igual que su categoría). Los
    -- nombres nuevos empiezan por "Reconstrucción " pero ninguno es igual, así que este
    -- filtro no se lleva por delante una entrada renombrada arriba, y re-ejecutar el script
    -- no borra nada (idempotente).
    WHERE NOT (
      e->>'categoria' = 'Reconstrucción'
      AND e->>'nombre' = 'Reconstrucción'
    )
  ), '[]'::JSONB)
  WHERE organization_id = sante_org;

  -- ── 2) Upselling: las reglas de cuidado tras decoloración → "Reconstrucción K18" ──
  UPDATE agent_configs
  SET business_info = jsonb_set(
    business_info,
    '{upselling}',
    (
      SELECT jsonb_agg(
        CASE
          WHEN r->>'tono' = 'cuidado_decoloracion'
            THEN jsonb_set(r, '{sugerencias}', '["Reconstrucción K18"]'::JSONB)
          ELSE r
        END
        ORDER BY ord
      )
      FROM jsonb_array_elements(business_info->'upselling') WITH ORDINALITY AS t(r, ord)
    )
  )
  WHERE organization_id = sante_org
    AND business_info ? 'upselling';
END $$;
