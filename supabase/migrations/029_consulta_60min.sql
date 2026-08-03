-- ============================================================
-- 029_consulta_60min.sql — La Consulta de valoración pasa de 300 a 60 min
-- ============================================================
-- 015_consulta.sql reservaba un bloque de 300 min (5 h) "por si acaso": la consulta
-- dura 20 min, pero se guardaba la tarde entera por si la clienta se hacía en el momento
-- el servicio recomendado. En la práctica ese bloque hacía que el servicio casi nunca se
-- pudiera ofrecer, porque computeFreeSlots (services/calendar-sante.js) exige que el
-- servicio ENTERO quepa en una ventana libre y termine antes del cierre:
--
--   for (let t = winStart; t + serviceDuration <= winEnd && t + serviceDuration < workEnd; ...)
--
-- Con jornada 10:00–19:00 (540 min) y 300 de servicio, eso significaba:
--   · último inicio ofrecible 13:30 — a partir de las 14:00 la Consulta no existía,
--     aunque la estilista tuviera la tarde entera libre;
--   · una sola cita de 2 h en el día dejaba 0 huecos (ninguna de las dos ventanas
--     resultantes llegaba a 300).
-- Medido sobre la agenda real: un día con "color 10–12 + corte 16–17" daba 0 huecos con
-- 300 min y 9 con 60. El 03/08/2026 hubo que recortar a mano un bloque de Consulta a
-- 150 min (16:30→cierre) para poder darle a una clienta un hueco de tarde.
--
-- Yulia prefiere una hora. Con 60 min la Consulta se comporta como un Corte mujer y el
-- caso "0 huecos" vuelve a significar lo que dice: agenda llena.
--
-- Efecto lateral bueno: con 300 min, un cero se clasificaba como AGENDA_LLENA (300 sí
-- cabe en una jornada vacía, así que cabeEnAlgunaJornada era true) y el bot le decía a la
-- clienta "está completo" cuando la verdad era "no cabe tu bloque". Ese falso positivo
-- desaparece.
--
-- NO afecta a ninguna cita existente: starts_at/ends_at se materializan al escribir la
-- fila (bookAppointment pasa duracionMin al guardar) y no se recalculan desde el catálogo.
-- A fecha de esta migración no hay ninguna cita con service = 'Consulta' en la BD.
--
-- La duración VISIBLE para la clienta no cambia: buildSanteConfirmationMessage siempre
-- muestra "Consulta de valoración (20 min)" y el precio sigue siendo null ("se confirma
-- en el salón"). Lo que sí se retira, en services/helpers.js, es la promesa de "ya
-- tendrás tiempo reservado a continuación sin esperar": con 60 min totales y 20 de
-- consulta quedan 40 de margen, que no dan para un color ni un balayage.

DO $$
DECLARE
  sante_org UUID := 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
BEGIN
  -- Idempotente por el EXISTS: si ya está en 60, no reescribe el array.
  -- WITH ORDINALITY + ORDER BY conserva el orden original del catálogo.
  UPDATE agent_configs
  SET services = (
    SELECT jsonb_agg(
             CASE WHEN e->>'categoria' = 'Consulta'
                  THEN jsonb_set(e, '{duracion}', '60'::JSONB)
                  ELSE e
             END
             ORDER BY ord
           )
    FROM jsonb_array_elements(services) WITH ORDINALITY AS t(e, ord)
  )
  WHERE organization_id = sante_org
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(services) AS e
      WHERE e->>'categoria' = 'Consulta'
        AND e->>'duracion' IS DISTINCT FROM '60'
    );
END $$;
