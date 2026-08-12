-- ============================================================
-- 040_renombrar_spa_hair.sql — Sante
-- ============================================================
-- Yulia pide que los tres servicios de Spa Hair se llamen igual que en su web, sin
-- los minutos en el nombre:
--
--   Relax 45min            → Spa Hair Relax          (85 €  / 45 min)
--   Detox 60min            → Spa Hair Detox          (115 € / 60 min)
--   Spa Hidratación 60min  → Spa Hair Hidratación    (110 € / 60 min)
--
-- SOLO el `nombre`. Precio, duración y categoría se quedan como están: los tres ya
-- cuadraban con la web (verificado entrada por entrada), así que aquí no hay ningún
-- precio que corregir. Copia del array completo de 81 servicios ANTES de esto en
-- data/sante-catalogo-backup-2026-08-12.json; el diff verificado son estas tres líneas
-- y nada más (mismo orden, mismas claves, mismos importes).
--
-- ── Por qué esta migración renombra TAMBIÉN dos citas ────────────────────────
-- `appointments.service` guarda un NOMBRE y la facturación lo casa contra el catálogo,
-- así que renombrar solo el JSONB mueve dinero de citas ya reservadas. Es la lección de
-- las 024/026 (K18) y la del aviso de la 028. Lo que hay hoy, medido sobre las 62 citas
-- de Sante:
--
--   • 2 citas con service = 'Relax 45min' (confirmed, 13/08/2026 11:00Z y 12:00Z,
--     Mariola Mira Lopez con Larisa), las dos con precio_facturado / servicio_facturado
--     / precio_manual a NULL — o sea SIN sellar.
--   • 0 citas con 'Detox 60min' y 0 con 'Spa Hidratación 60min'.
--
-- Y el daño de dejarlas NO sería el del K18 ("sin poder calcular", visible). Sería peor,
-- porque es SILENCIOSO:
--
--   computeServiceBilling('Relax 45min', catálogo renombrado)  →  75 €, status 'ok'
--
-- Al fallar el nombre exacto, computeServiceBilling cae a extractServiceFromText, el
-- fuzzy manda 'relax' a la categoría 'Masajes y SPA' (CATEGORY_KEYWORDS, helpers.js:1012
-- — no hay entrada para 'Spa Hair') y resuelve a 'Aromaterapia relax', 75 €/60 min. Otro
-- servicio, otra categoría, y devuelto como 'ok': no cae en unmatched, no lo cuenta
-- ningún contador de "sin calcular", no avisa nadie. 10 € menos por cita.
--
-- Peor aún, la ventana se cierra sola: stampBillingSnapshot sella al pasar a completed
-- con computeServiceBilling(cita.service, catálogo) (db.js:1612), así que con el catálogo
-- renombrado y las filas sin tocar, esos 75 € quedan CONGELADOS — y no salta el aviso de
-- divergencia, porque isBillingServiceDiverged compara servicio_facturado contra service
-- y los dos dirían 'Relax 45min'. Renombrar las filas después de que sellen es el caso
-- malo simétrico: ahí sí divergen y el importe pasa a 'divergente' (no cuenta, hay que
-- revisarlo a mano).
--
-- Segundo motivo, y no es de dinero pero se le nota a la clienta:
-- hasPreviousSpaOrMassage (helpers.js:2379) casa los nombres del catálogo VIVO contra el
-- historial. Con la fila en 'Relax 45min' y el catálogo renombrado devuelve false, así
-- que a Mariola se le volvería a ofrecer el 10% de PRIMERA visita a Spa Hair habiendo
-- estado ya. Con el nombre nuevo casa por la vía de la categoría ('spa hair' va dentro
-- del propio nombre) y deja de depender de la lista.
--
-- ── Lo que se comprobó que NO se rompe ───────────────────────────────────────
-- La protección de la 028 sigue en pie: 'hidratacion', 'detox' y 'quiero una hidratación'
-- a secas siguen devolviendo null (el bot pregunta) porque 'spa' y 'hair' tienen 3 y 4
-- letras y MIN_DISTINCTIVE_TOKEN son 5 — el token distintivo no cambia. La ida y vuelta
-- de las 81 entradas (buildFullServiceName → extractServiceFromText) da 0 desajustes.
-- Ningún sitio parsea la duración del nombre (sale siempre de `duracion`), ninguna regla
-- de business_info.upselling apunta a estos tres, y SPA_PROMO_CATEGORIES va por CATEGORÍA.
-- De hecho el renombrado ARREGLA algo: hoy extractServiceFromText('Spa Hair Relax')
-- devuelve Aromaterapia relax a 75 €, o sea que el nombre de la web resuelve mal.
--
-- Lo único que se pierde: 'el de 45min' hoy resuelve a Relax 45min y después devuelve
-- null. ('el de 60min' ya devolvía null: lo comparten Detox y Spa Hidratación.)
--
-- Queda un hallazgo APARTE, preexistente y que esto no cambia: bot.js:2451 recupera
-- 'Aromaterapia relax' al rehidratar una cita de Spa Hair, porque matchesServiceName casa
-- por el token 'relax' y Masajes y SPA va delante en el array. Sigue igual antes y después.

DO $$
DECLARE
  sante_org UUID := 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
  viejo TEXT;
  nuevo TEXT;
  renombres TEXT[][] := ARRAY[
    ARRAY['Relax 45min',           'Spa Hair Relax'],
    ARRAY['Detox 60min',           'Spa Hair Detox'],
    ARRAY['Spa Hidratación 60min', 'Spa Hair Hidratación']
  ];
  sin_sellar INT;
  selladas INT;
BEGIN
  -- ── 1) Las citas PRIMERO ────────────────────────────────────────────────────
  -- Antes que el catálogo para que en ningún instante de la transacción exista un
  -- catálogo renombrado con filas que apunten al nombre viejo.
  --
  -- `replace` y no `=`: una cita multi-servicio guarda "A + B" en una sola fila
  -- (splitServiceNames), y una igualdad se la dejaría atrás. Ninguno de los tres
  -- nombres viejos es subcadena de otro nombre del catálogo, así que el replace no
  -- puede tocar de más. Hoy no hay ninguna fila concatenada con estos nombres, pero
  -- una migración se aplica más tarde de cuando se escribe — es el aviso de la 028.
  --
  -- `facturado_at IS NULL` es la red: una cita con el importe ya congelado se deja
  -- INTACTA a propósito. Su dinero lo protege el snapshot (resolveBillingAmount lee el
  -- congelado y no recalcula, migración 021), y reescribirle el `service` la marcaría
  -- como divergente sin que nada hubiera cambiado de verdad. El coste conocido de
  -- dejarla es que hasPreviousSpaOrMassage no la reconozca; se dice y no se tapa.
  FOR i IN 1 .. array_length(renombres, 1) LOOP
    viejo := renombres[i][1];
    nuevo := renombres[i][2];

    SELECT count(*) INTO sin_sellar FROM appointments
    WHERE organization_id = sante_org AND service LIKE '%' || viejo || '%'
      AND facturado_at IS NULL;

    SELECT count(*) INTO selladas FROM appointments
    WHERE organization_id = sante_org AND service LIKE '%' || viejo || '%'
      AND facturado_at IS NOT NULL;

    IF sin_sellar > 0 THEN
      RAISE NOTICE 'Renombrando % cita(s) sin sellar: "%" → "%"', sin_sellar, viejo, nuevo;
      UPDATE appointments
      SET service = replace(service, viejo, nuevo)
      WHERE organization_id = sante_org AND service LIKE '%' || viejo || '%'
        AND facturado_at IS NULL;
    END IF;

    -- No es un error, pero tiene que verse: quien aplique esto decide qué hacer con el
    -- snapshot de esas filas. Un WARNING para que no pase por debajo de los NOTICE.
    IF selladas > 0 THEN
      RAISE WARNING '% cita(s) con "%" YA tienen importe congelado: se dejan intactas (su dinero es correcto), pero seguirán con el nombre viejo', selladas, viejo;
    END IF;
  END LOOP;

  -- ── 2) El catálogo ──────────────────────────────────────────────────────────
  -- ORDER BY ord es obligatorio, no cosmético: el orden del array es significativo.
  -- extractServiceFromText recorre el catálogo y varios desempates dependen de cuál se
  -- encuentra primero (la pasada de último recurso, sin ir más lejos). Un jsonb_agg sin
  -- orden explícito podría reordenar el catálogo entero.
  --
  -- El CASE exige categoría 'Spa Hair' Y nombre exacto: hay otras entradas con esas
  -- palabras en otras categorías (Aromaterapia relax, Green Purity Detox, Fresh
  -- Hidratación, Orising hidratación intensa) y ninguna se toca.
  UPDATE agent_configs
  SET services = (
    SELECT jsonb_agg(
      CASE
        WHEN e->>'categoria' = 'Spa Hair' AND e->>'nombre' = 'Relax 45min'
          THEN jsonb_set(e, '{nombre}', '"Spa Hair Relax"'::JSONB)
        WHEN e->>'categoria' = 'Spa Hair' AND e->>'nombre' = 'Detox 60min'
          THEN jsonb_set(e, '{nombre}', '"Spa Hair Detox"'::JSONB)
        WHEN e->>'categoria' = 'Spa Hair' AND e->>'nombre' = 'Spa Hidratación 60min'
          THEN jsonb_set(e, '{nombre}', '"Spa Hair Hidratación"'::JSONB)
        ELSE e
      END
      ORDER BY ord
    )
    FROM jsonb_array_elements(services) WITH ORDINALITY AS t(e, ord)
  )
  WHERE organization_id = sante_org
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(services) e
      WHERE e->>'categoria' = 'Spa Hair'
        AND e->>'nombre' IN ('Relax 45min', 'Detox 60min', 'Spa Hidratación 60min')
    );
END $$;
