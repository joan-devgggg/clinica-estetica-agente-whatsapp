-- ============================================================
-- 028_spa_hidratacion.sql — Sante
-- ============================================================
-- Renombra "Hidratación 60min" (Spa Hair) → "Spa Hidratación 60min".
--
-- Motivo: el catálogo tiene TRES servicios cuyo nombre contiene "hidratación", a
-- tres precios muy distintos:
--
--   • Hidratación 60min            — Spa Hair            — 110 €  / 60 min
--   • Orising hidratación intensa  — Tratamiento Orgánico —  85 €  / 90 min
--   • Fresh Hidratación            — Tratamiento Orgánico —  45 €  / 40 min
--
-- Pasó en producción el 02/08/2026: una clienta escribió "Hidratación" a secas y se
-- le reservó la de 110 € sin preguntarle.
--
-- ⚠️ ESTA MIGRACIÓN NO ARREGLA ESA AMBIGÜEDAD. Se intentó y se comprobó que no basta.
-- La idea era que "Hidratación 60min" dejara de ser prefijo puro para que las tres
-- entradas empataran y extractServiceFromText devolviera null (→ el bot pregunta). No
-- funciona: el filtro de tokens distintivos de la pasada de último recurso descarta las
-- palabras de menos de 5 letras (MIN_DISTINCTIVE_TOKEN), así que "spa" no cuenta y
-- "hidratacion" sigue encabezando el nombre. Verificado:
--
--   extractServiceFromText("hidratacion")  →  Spa Hidratación 60min, 110 €   (igual que antes)
--
-- El arreglo real va por CÓDIGO, en la pasada de último recurso de
-- services/helpers.js: cuando el empate cruza CATEGORÍAS distintas casando exactamente
-- los mismos tokens, no se aplica el desempate por prefijo → null → el bot pregunta.
-- Cubre también "detox" (35 € vs 115 €), que este renombrado dejaba intacto. Dentro de
-- una misma categoría el desempate sigue vivo, que es el caso que esa pasada rescata.
--
-- Esta migración se conserva porque el nombre igualmente queda más claro: "Spa" es su
-- categoría (Spa Hair) y lo distingue de las dos hidrataciones de Tratamiento Orgánico.
-- Pero es cosmética, no un arreglo.
--
-- Sin migración de datos: a fecha de esta migración NINGUNA fila de `appointments`
-- referencia "Hidratación 60min" (verificado con
--   SELECT service, count(*) FROM appointments
--   WHERE organization_id = '…' AND service ILIKE '%hidrataci%' GROUP BY service;
-- → 0 filas). Si al aplicarla existieran citas antiguas con el nombre viejo, habría
-- que renombrarlas también: la facturación por estilista casa `appointments.service`
-- contra el catálogo por nombre EXACTO y las no matcheables no suman.

DO $$
DECLARE
  sante_org UUID := 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
  huerfanas INT;
BEGIN
  -- Guarda: si alguien aplica esto más tarde y sí hay citas con el nombre viejo,
  -- que se entere en vez de romper la facturación en silencio.
  SELECT count(*) INTO huerfanas FROM appointments
  WHERE organization_id = sante_org AND service = 'Hidratación 60min';
  IF huerfanas > 0 THEN
    RAISE NOTICE 'Renombrando también % cita(s) con el nombre viejo', huerfanas;
    UPDATE appointments SET service = 'Spa Hidratación 60min'
    WHERE organization_id = sante_org AND service = 'Hidratación 60min';
  END IF;

  -- ORDER BY ord es obligatorio, no cosmético: el orden del array es significativo.
  -- extractServiceFromText recorre el catálogo y varios desempates dependen de cuál
  -- se encuentra primero (la pasada de último recurso, sin ir más lejos). Un
  -- jsonb_agg sin orden explícito podría reordenar el catálogo entero.
  UPDATE agent_configs
  SET services = (
    SELECT jsonb_agg(
      CASE
        WHEN e->>'categoria' = 'Spa Hair' AND e->>'nombre' = 'Hidratación 60min'
          THEN jsonb_set(e, '{nombre}', '"Spa Hidratación 60min"')
        ELSE e
      END
      ORDER BY ord
    )
    FROM jsonb_array_elements(services) WITH ORDINALITY AS t(e, ord)
  )
  WHERE organization_id = sante_org
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(services) e
      WHERE e->>'categoria' = 'Spa Hair' AND e->>'nombre' = 'Hidratación 60min'
    );
END $$;
