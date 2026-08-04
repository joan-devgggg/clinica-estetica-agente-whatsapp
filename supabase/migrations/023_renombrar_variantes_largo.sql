-- ============================================================
-- 023_renombrar_variantes_largo.sql — Sante
-- ============================================================
-- Pedido por Yulia (dueña del salón): las variantes de longitud del catálogo
-- se llamaban "Largo 1/2/3/4" (nomenclatura interna, poco clara para el panel).
-- Se renombran a algo legible, MISMO precio/duración, mismo orden:
--
--   Largo 1 → Corto
--   Largo 2 → Medio
--   Largo 3 → Largo
--   Largo 4 → XL      (consistente con "XL / cambio importante" que ya usa
--                       Mechas Balayage — mismo nivel 4 en classifyLargoVariant)
--
-- Alcance: solo entradas cuyo `nombre` es LITERALMENTE "Largo N" (4 categorías,
-- 14 filas — Alisado vegano y Anti-encrespamiento no tienen variante 4):
--   Alisado vegano, Anti-encrespamiento, Deco Total Blond, Mechas Airtouch.
--
-- NO toca "Color completo largo 1/2/3" (Color Premium): es un nombre propio
-- distinto ("Color completo largo N"), no el literal "Largo N" que pidió
-- renombrar Yulia. Tampoco toca "Mechas Balayage": ya usa nombres descriptivos
-- desde la migración 018.
--
-- Seguro para servicios/helpers.js sin cambios de código: classifyLargoVariant,
-- buildFullServiceName y extractServiceFromText ya soportan esta convención
-- descriptiva (fue añadida en el 018 para Mechas Balayage, ver helpers.js:1421-1442).
-- No hay citas activas afectadas: solo 1 cita histórica con "Largo N" en
-- appointments.service, y está cancelada (facturación completada usa snapshot
-- congelado, migración 021 — un rename del catálogo no la toca).

DO $$
DECLARE
  sante_org UUID := 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
BEGIN
  UPDATE agent_configs
  SET services = (
    SELECT jsonb_agg(
      CASE
        WHEN e->>'nombre' = 'Largo 1' THEN jsonb_set(e, '{nombre}', '"Corto"'::JSONB)
        WHEN e->>'nombre' = 'Largo 2' THEN jsonb_set(e, '{nombre}', '"Medio"'::JSONB)
        WHEN e->>'nombre' = 'Largo 3' THEN jsonb_set(e, '{nombre}', '"Largo"'::JSONB)
        WHEN e->>'nombre' = 'Largo 4' THEN jsonb_set(e, '{nombre}', '"XL"'::JSONB)
        ELSE e
      END
      ORDER BY ord
    )
    FROM jsonb_array_elements(services) WITH ORDINALITY AS t(e, ord)
  )
  WHERE organization_id = sante_org;
END $$;
