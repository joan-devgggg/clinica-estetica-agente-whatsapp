-- ============================================================
-- 024_k18_suelto_vs_complemento.sql — Sante
-- ============================================================
-- Pedido por Yulia (dueña): "K18" eran en realidad dos servicios con precio y
-- duración distintos, aplanados hoy en una sola entrada (45€ / 60 min):
--
--   • K18 SUELTO (sin color asociado): lavar + aplicar + secar + peinar → 60 min reales, 60€.
--   • K18 DENTRO de un servicio de color (mechas/balayage/contouring/airtouch):
--     el lavado y el peinado ya van incluidos en el color, solo quedan los 15 min
--     de aplicar el producto → 35€.
--
-- Antes de tocar el catálogo se comprobó qué pasaría con las citas existentes que
-- llevan "K18" en `service`: en la BD real solo hay UNA, "Mechas Contouring +
-- Matiz plus + K18" (Paloma Gómez), y ya está `completed` con precio_facturado
-- congelado (270.00€, migración 021) — un cambio de catálogo no la toca. No hay
-- ninguna cita no completada con K18 pendiente de facturar.
--
-- Naming (y NO al revés) — por qué "K18" se queda con el SUELTO y no con el
-- complemento, aunque el complemento sea el uso más frecuente hoy:
--   1) extractServiceFromText (services/helpers.js) resuelve un "K18" a secas
--      por SUBSTRING: el nombre de catálogo tiene que estar CONTENIDO en lo que
--      escribe la clienta. El nombre corto "K18" siempre gana esa comparación;
--      el nombre largo del complemento solo ganaría si la clienta escribiera la
--      frase completa. No hay forma de invertir ese resultado por wording sin
--      añadir código de contexto de sesión (mirar si ya hay un color
--      seleccionado) — así que quien se queda con el nombre corto es quien debe
--      ganar por defecto, y eso es el SUELTO.
--   2) La entrada vieja ya duraba 60 min: mantener "K18"=60 min conserva ese
--      valor (solo cambia el precio 45→60); es la entrada, de las dos, que
--      menos rompe si alguna cita en vuelo asumiera la duración antigua.
--   3) El complemento se llama "Aplicación K18" (no un "K18" desnudo): al
--      llevar la palabra "k18" dentro, sigue casando con matchesServiceName
--      cuando la clienta responde solo "k18" al upsell ofrecido (bot.js:3328) —
--      no hace falta tocar ese código.
--
-- IMPORTANTE — lo que este script NO toca: business_info.upselling (las reglas de
-- "cuidado tras decoloración"). La categoría "Reconstrucción" no tenía una sola
-- entrada como sugería el comentario de la migración 018 — ya tenía 4 (Pro Miracle
-- Repair TEMPTING, K18, "Reconstrucción" a secas, y ahora "Aplicación K18"). Esas
-- reglas apuntan al nombre EXACTO de catálogo "Reconstrucción" (35€/60min), un
-- producto real y DISTINTO de K18 — es lo que la clienta recibe hoy tras una
-- decoloración, y sigue siendo así. Cambiar esas reglas para que apunten a
-- "Aplicación K18" habría sustituido en silencio ese tratamiento de 60 min por el
-- complemento de 15 min: no es lo que pidió Yulia, así que las reglas de
-- upselling se quedan exactamente como estaban.
--
-- Categoría sin cambios ("Reconstrucción") — Yulia no pidió una categoría nueva.

DO $$
DECLARE
  sante_org UUID := 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
BEGIN
  -- ── 1) Catálogo: reprecio de "K18" (suelto) + nueva entrada "Aplicación K18" ──
  UPDATE agent_configs
  SET services = (
    SELECT jsonb_agg(
      CASE
        WHEN e->>'categoria' = 'Reconstrucción' AND e->>'nombre' = 'K18'
          THEN jsonb_set(e, '{precio}', '60'::JSONB)
        ELSE e
      END
      ORDER BY ord
    )
    FROM jsonb_array_elements(services) WITH ORDINALITY AS t(e, ord)
  ) || jsonb_build_array(
    jsonb_build_object('categoria', 'Reconstrucción', 'nombre', 'Aplicación K18', 'precio', 35, 'duracion', 15)
  )
  WHERE organization_id = sante_org
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(services) e
      WHERE e->>'categoria' = 'Reconstrucción' AND e->>'nombre' = 'Aplicación K18'
    );
END $$;
