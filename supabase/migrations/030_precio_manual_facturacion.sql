-- Importe manual de una cita. Pedido por Yulia (dueña), 04/08/2026.
--
-- Revierte la decisión de no dejar tocar el importe a mano. Dos usos reales: corregir un
-- error (el `service` guardado no describe lo que se hizo) y aplicar un descuento, que el
-- catálogo no sabe representar. Hasta ahora la única salida era editar el `service` hasta
-- que el recálculo diera otra cifra — falsear el histórico de lo que se hizo para mover el
-- dinero, que es justo lo que la auditoría del 30/07/2026 (migración 021) quería impedir.
--
-- Columna SEPARADA de precio_facturado a propósito. precio_facturado es lo que calculó la
-- máquina; precio_manual es lo que decidió una persona. Mezclarlos impide (a) distinguir
-- las dos cosas en el informe —un importe a mano tiene que VERSE— y (b) volver a sellar el
-- snapshot algún día sin pisar la decisión humana. El informe da prioridad a precio_manual
-- sobre el snapshot y sobre el recálculo, y una cita con importe manual SÍ cuenta como
-- calculable: ese es su uso más valioso, rescatar una cita ambigua o sin match que hoy no
-- suma nada (ver el caso "Largo 2" en la migración 023).
--
-- precio_manual = 0 es un valor VÁLIDO (cortesía, 100 % de descuento). La presencia se
-- comprueba SIEMPRE con `!= null`, jamás por truthiness ni con Number(x) || 0: ese mismo
-- error ya facturó una cita a 0,00 € presentándola como cifra buena (ver el comentario de
-- precio_facturado en la 021 y el test "un facturado_at sin precio_facturado NO cuenta
-- como snapshot").
--
-- Estas columnas se escriben en UN solo sitio: db.setManualPrice, vía
-- PATCH /api/citas/:id/precio. updateAppointment no las toca — igual que no toca las de la
-- 021. Ese invariante es lo que garantiza que un resellado no pueda pisar el importe manual.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS precio_manual        numeric(10,2),
  -- Por qué se cambió. Texto libre de quien lo cambia; el informe lo enseña en el tooltip.
  ADD COLUMN IF NOT EXISTS precio_manual_motivo text,
  ADD COLUMN IF NOT EXISTS precio_manual_at     timestamptz,
  -- profiles.id (= auth.users.id) del usuario del panel, tomado del token ya verificado
  -- (req.authUserId), NUNCA del body. ON DELETE SET NULL: dar de baja a un usuario no puede
  -- borrar un importe facturado.
  ADD COLUMN IF NOT EXISTS precio_manual_por    uuid REFERENCES profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN appointments.precio_manual IS
  'Importe CON IVA fijado a mano desde el panel. Misma convención que el catálogo: base sin IVA = importe / (1 + iva_rate). Manda sobre precio_facturado y sobre el recálculo. NULL = sin corrección manual; 0 = cortesía (valor legítimo, NO ausencia).';

-- Sin índice: el informe ya trae la fila por (organization_id, status, starts_at) y nunca
-- filtra por precio_manual. RLS: las políticas de appointments son de tabla, las columnas
-- nuevas heredan sin cambios.
