-- Snapshot del importe facturado. Auditoría de integridad de datos, 30/07/2026.
--
-- La facturación RECALCULABA el precio en vuelo cruzando appointments.service contra
-- agent_configs.services cada vez que se abría el informe. Consecuencia: subir un precio en el
-- catálogo reescribía la facturación de meses ya cerrados, y editar el `service` (campo de texto
-- libre en el panel) o el stylist_id de una cita pasada movía el dinero retroactivamente.
--
-- Al pasar la cita a 'completed' se congela lo que se cobró (db.stampBillingSnapshot). El
-- informe lee el snapshot si existe y solo recalcula cuando falta: citas anteriores a esta
-- migración, o servicios que no se pudieron valorar. Idempotente.
--
-- Aplicada en la BD remota el 30/07/2026 junto con 022 (una sola migración,
-- `auditoria_integridad_visit_count_y_snapshot_facturacion`); aquí van separadas por tema.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS precio_facturado numeric(10,2),
  ADD COLUMN IF NOT EXISTS iva_rate         numeric(5,4),
  ADD COLUMN IF NOT EXISTS facturado_at     timestamptz,
  -- Nombre de la estilista en el momento de facturar: el informe lo resuelve por JOIN, así
  -- que renombrar a una estilista reescribía su histórico.
  ADD COLUMN IF NOT EXISTS stylist_name_facturado text;

COMMENT ON COLUMN appointments.precio_facturado IS
  'Importe CON IVA congelado al completar la cita. NULL = recalcular desde el catálogo (citas previas a la auditoría 30/07/2026) o servicio no calculable.';
