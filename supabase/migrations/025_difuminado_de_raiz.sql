-- ============================================================
-- 025_difuminado_de_raiz.sql — Sante
-- ============================================================
-- Pedido por Yulia: nuevo servicio "Difuminado de raíz" — 40€, 30 min.
--
-- Categoría: "Color Premium", la misma que su servicio hermano "Color raíz".
-- Confirmado con Yulia antes de aplicar (no era autoevidente: "Color raíz" y
-- "Difuminado de raíz" son técnicas distintas y podrían haber ido en categorías
-- separadas).
--
-- Efecto en asignación de estilista (services/calendar-sante.js:49-68 y
-- bot.js:383-387, stylistCanDoService): el filtro es un match EXACTO
-- (case-insensitive) de `categoria` contra `stylists.skills`. Las únicas
-- estilistas con "Color Premium" en `skills` son las 4 coloristas generales
-- (Irina, Natalia, Veronika, Yulia) — Larisa (masajes), Olgha (manicura),
-- Tetiana (extensiones) y Yulia-Tricóloga (diagnóstico/dermapen) quedan fuera,
-- que es lo esperado.
--
-- No hace falta tocar services/helpers.js: la palabra clave "raiz"/"raíz" en
-- CATEGORY_KEYWORDS ya resuelve a "Color Premium" (línea 368) y el matching de
-- nombre de servicio (extractServiceFromText) es dirigido por catálogo, no por
-- código — el nuevo `nombre` entra automáticamente al añadirse aquí.

DO $$
DECLARE
  sante_org UUID := 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
BEGIN
  UPDATE agent_configs
  SET services = services || jsonb_build_array(
    jsonb_build_object('categoria', 'Color Premium', 'nombre', 'Difuminado de raíz', 'precio', 40, 'duracion', 30)
  )
  WHERE organization_id = sante_org
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(services) e
      WHERE e->>'categoria' = 'Color Premium' AND e->>'nombre' = 'Difuminado de raíz'
    );
END $$;
