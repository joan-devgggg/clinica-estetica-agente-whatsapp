-- Incremento ATÓMICO de visit_count. Auditoría de integridad de datos, 30/07/2026.
--
-- Antes era un read-modify-write en db.js: dos escrituras simultáneas (el worker de
-- autoCompleteAppointments corre cada 5 min por org, y el panel puede completar la misma cita
-- a la vez) leían el mismo valor y escribían el mismo +1, perdiendo una visita. Como
-- visit_count alimenta el umbral de sugerencia VIP, la clienta se quedaba sin su sugerencia.
--
-- Devuelve el nuevo contador, o NULL si ninguna fila casó (id inexistente o de otra org), que
-- es el caso que db.incrementVisitCount ya distinguía devolviendo null. Idempotente.
--
-- Aplicada en la BD remota el 30/07/2026 junto con 021 (una sola migración,
-- `auditoria_integridad_visit_count_y_snapshot_facturacion`); aquí van separadas por tema.
CREATE OR REPLACE FUNCTION increment_visit_count(p_contact_id uuid, p_organization_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE contacts
       SET visit_count = COALESCE(visit_count, 0) + 1,
           updated_at  = now()
     WHERE id = p_contact_id
       AND organization_id = p_organization_id
    RETURNING visit_count;
$$;
