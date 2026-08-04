-- El `service` tal como estaba al sellar el importe, y reparación de la cita corrompida.
-- Auditoría del 04/08/2026.
--
-- ── El agujero ───────────────────────────────────────────────────────────────
-- La 021 congela el importe para que subir un precio del catálogo o renombrar a una
-- estilista no reescriba un mes ya cerrado. NO protege —ni debe— de que el operador
-- corrija QUÉ se hizo. Pero stampBillingSnapshot solo dispara en la transición → completed
-- y se salta las filas con facturado_at, y updateAppointment nunca toca las columnas de
-- facturación: editar el `service` de una cita ya sellada cambiaba el servicio y no el
-- dinero. El informe seguía enseñando el importe viejo como cifra buena, con "sin calcular:
-- 0". Cero avisos.
--
-- Caso real: la cita 7d32c9b0 (Gisela Almiron, Yulia) congeló 220 € el 03/08 a las 12:22 y
-- después se le añadió "Difuminado de raíz" (40 €) desde el panel. El informe mostraba 220 €.
--
-- ── Por qué NO se revaloriza sola ────────────────────────────────────────────
-- Resellar en cada edición reintroduce justo la fuga que cerró la 021: arreglar una errata
-- en octubre sobre una cita de julio le traería precios de octubre. Anular el snapshot es
-- peor todavía: pierde la congelación para siempre y deja esa cita flotando con cada cambio
-- de catálogo. Se guarda el `service` sellado y el informe AVISA cuando diverge del actual
-- —la cifra dudosa se comunica como dudosa, misma decisión que 'ambiguous'— y decide una
-- persona, con el importe manual (migración 030) como forma de zanjarlo.
--
-- Se compara el STRING del servicio, NUNCA el precio. Comparar precios marcaría cada subida
-- legítima del catálogo, que es exactamente lo que el snapshot existe para absorber. El
-- ejemplo vive en esta misma BD: la cita 3765dbbd ("Mechas Contouring + Matiz plus + K18",
-- 270 €, sellada el 02/08 a las 00:20) hoy no se puede recalcular porque las migraciones
-- 024 y 026 renombraron la entrada "K18" DESPUÉS de sellarla. Su congelado es CORRECTO y
-- esta migración la deja intacta: su `service` no ha cambiado nunca, así que no diverge.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS servicio_facturado text;

COMMENT ON COLUMN appointments.servicio_facturado IS
  'appointments.service tal como estaba al congelar el importe. NULL = cita sellada antes de esta migración; el informe no evalúa divergencia (no puede) y se comporta como hasta ahora.';

-- Backfill: sin él, TODA cita sellada antes de hoy queda ciega a divergencias para siempre.
-- Da por bueno el `service` actual de esas filas, lo cual es correcto salvo para las ya
-- editadas tras el sellado — que se auditaron una a una con scripts/auditoria-snapshot-
-- divergente.js antes de escribir esta migración. Solo apareció una y se repara justo abajo.
UPDATE appointments
   SET servicio_facturado = service
 WHERE facturado_at IS NOT NULL
   AND servicio_facturado IS NULL;

-- Reparación de la única cita corrompida.
-- service: "Mechas Contouring + Reconstrucción K18 + lavar y peinar + Difuminado de raíz".
-- Congeló 220,00 € (= 160 Contouring + 60 K18+lavar y peinar); el recálculo son 260,00 €.
--
-- Resellar aquí NO viola la 021: son precios DEL MOMENTO DEL SELLADO, no de hoy. Verificado
-- contra el histórico de migraciones — 025_difuminado_de_raiz (40 €) se aplicó el 02/08 a
-- las 11:29 y 026_catalogo_reconstruccion (que fija "Reconstrucción K18 + lavar y peinar"
-- en 60 €) el 02/08 a las 14:18, ambas ANTERIORES al sellado del 03/08 a las 12:22. La
-- única migración posterior, 029_consulta_60min, no toca ninguno de los tres servicios.
--
-- facturado_at se deja como está a propósito: registra cuándo entró la cita en facturación
-- y eso sigue siendo cierto. La corrección queda documentada aquí.
-- Idempotente por el AND del importe viejo: correrla dos veces no hace nada la segunda.
UPDATE appointments
   SET precio_facturado   = 260.00,
       servicio_facturado = service
 WHERE id = '7d32c9b0-4d32-4572-8427-40c7c3a1f582'
   AND precio_facturado = 220.00;
