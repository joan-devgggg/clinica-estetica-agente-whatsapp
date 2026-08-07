-- PIN por estilista: ATRIBUCIÓN, no seguridad. 07/08/2026.
--
-- Sante tiene UN login compartido (`sante@crm.local`, rol owner) para todo el salón, así que
-- `cobros.registrado_por` apunta siempre al mismo uuid y no atribuye nada. `cobros.cobrado_por`
-- dice qué estilista cobró, pero hoy es una opción de un desplegable: la elige quien esté
-- delante y nadie la respalda.
--
-- Esto NO es un control de acceso. No bloquea el panel, no autoriza nada y no impide que
-- alguien declare mal lo que cobró — eso es cámaras y responsabilidad de cada una. Lo único que
-- añade es poder distinguir "consta" de "se dijo".
--
-- ── Por qué AHORA y no después de la pantalla de cobro ──────────────────────
-- `cobros` está a 0 filas. La columna `atribucion` entra NOT NULL y sin backfill. Si la
-- pantalla llegara primero, las primeras semanas de caja quedarían atribuidas por
-- autodeclaración y eso no se arregla hacia atrás: habría que rellenarlas con un default que
-- miente sobre cómo se registraron.

-- ── 1. Dónde vive el PIN ────────────────────────────────────────────────────
--
-- Tabla aparte y NO una columna en `stylists`, por un motivo comprobado: `getStylistsByOrg`
-- hace `select('*')` y su resultado viaja al navegador en cada carga del panel. Cualquier
-- columna nueva ahí se publicaría sola. Una tabla propia no puede colarse en ninguna consulta
-- que ya existe.
CREATE TABLE IF NOT EXISTS stylist_pins (
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stylist_id       UUID PRIMARY KEY REFERENCES stylists(id) ON DELETE CASCADE,
  -- scrypt (crypto de Node, cero dependencias nuevas) con salt por fila.
  --
  -- Cuatro dígitos no son un secreto fuerte: 10.000 combinaciones se prueban en un instante y
  -- el hash NO pretende resistir eso. Lo que compra es que el PIN de Irina no se lea a simple
  -- vista en la tabla, en un export o en un log — y que nadie lo reutilice al verlo. Para lo
  -- que se pide, con eso basta; montar más sería el aparato de seguridad que se ha descartado.
  pin_hash         TEXT NOT NULL,
  pin_salt         TEXT NOT NULL,
  actualizado_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Quién lo puso (la dueña, desde el panel). No hay autoservicio: no existe login por
  -- estilista, y crearlo sería justo el auth que no se quiere.
  actualizado_por  UUID REFERENCES profiles(id) ON DELETE SET NULL
);

ALTER TABLE stylist_pins ENABLE ROW LEVEL SECURITY;

-- SOLO service_role. A propósito no hay política para `authenticated`: el panel habla con la
-- API de Express (que usa service_role), nunca con PostgREST para esto, y no hay realtime sobre
-- esta tabla. Sin política, un cliente autenticado no puede leer ni un hash. Es la diferencia
-- con `stylists`/`cobros`, que sí necesitan lectura directa.
CREATE POLICY "stylist_pins_service_role" ON stylist_pins
  TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE stylist_pins IS
  'PIN de atribución por estilista. Tabla aparte y no columna de stylists porque getStylistsByOrg hace select(*) y publicaría la columna al navegador. Sin política para authenticated: solo la API (service_role) la toca. No es control de acceso: no autoriza nada, solo permite distinguir una atribución confirmada de una declarada.';

-- ── 2. Qué añade a un cobro ─────────────────────────────────────────────────
--
-- El PIN CALIFICA la atribución, no la autoriza. Un cobro se registra SIEMPRE: si el PIN
-- bloqueara el registro, el día que alguien lo olvide el dinero no se apunta —o se apunta bajo
-- el nombre que ya estuviera puesto—, y el agujero vuelve sin marca.
--
-- El DEFAULT es 'declarada' y esa dirección importa: un camino que se olvide de declarar la
-- atribución cae en la afirmación MÁS HUMILDE, nunca en la más fuerte. Al revés, un olvido
-- convertiría en "consta" algo que nadie confirmó.
ALTER TABLE cobros
  ADD COLUMN IF NOT EXISTS atribucion TEXT NOT NULL DEFAULT 'declarada'
    CHECK (atribucion IN ('confirmada', 'declarada'));

COMMENT ON COLUMN cobros.atribucion IS
  'confirmada = la estilista metió su PIN en esa sesión de caja · declarada = solo se eligió su nombre. El cobro se registra igual en los dos casos; esto solo dice de qué te puedes fiar. Inmutable como el resto: subir una declarada a confirmada después es exactamente la mentira que la columna existe para evitar.';

-- ── 3. La atribución se congela como el dinero ──────────────────────────────
--
-- `atribucion` entra en la lista de columnas inmutables del trigger. Sin esto, un UPDATE podría
-- ascender una 'declarada' a 'confirmada' después del hecho — que es precisamente la afirmación
-- que la columna existe para poder negar. Corregir una atribución equivocada es lo mismo que
-- corregir un importe: se rectifica con una fila nueva.
CREATE OR REPLACE FUNCTION public.cobros_congelar_importes()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.organization_id, NEW.appointment_id, NEW.cobrado_por_nombre,
      NEW.fecha_caja, NEW.cobrado_at, NEW.metodo, NEW.importe_total, NEW.importe_efectivo,
      NEW.iva_rate, NEW.concepto, NEW.importe_referencia, NEW.motivo_diferencia,
      NEW.corrige_a, NEW.motivo_correccion, NEW.created_at, NEW.atribucion)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.appointment_id, OLD.cobrado_por_nombre,
      OLD.fecha_caja, OLD.cobrado_at, OLD.metodo, OLD.importe_total, OLD.importe_efectivo,
      OLD.iva_rate, OLD.concepto, OLD.importe_referencia, OLD.motivo_diferencia,
      OLD.corrige_a, OLD.motivo_correccion, OLD.created_at, OLD.atribucion)
  THEN
    RAISE EXCEPTION 'cobros: un cobro no se edita. Para corregirlo, anúlalo y escribe otro con corrige_a (solo estado, anulado_at, anulado_por y nota son modificables).';
  END IF;

  IF (NEW.cobrado_por    IS NOT NULL AND NEW.cobrado_por    IS DISTINCT FROM OLD.cobrado_por)
  OR (NEW.registrado_por IS NOT NULL AND NEW.registrado_por IS DISTINCT FROM OLD.registrado_por)
  THEN
    RAISE EXCEPTION 'cobros: no se puede reasignar quién cobró ni quién registró un cobro. Anula y rectifica.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- La vista `cobros_vigentes` hace SELECT c.* y recoge la columna nueva sola. Se recrea igual
-- para que quede explícito en el histórico de migraciones que se revisó.
CREATE OR REPLACE VIEW cobros_vigentes
  WITH (security_invoker = on) AS
  SELECT c.*
    FROM cobros c
   WHERE c.estado = 'vigente'
     AND NOT EXISTS (SELECT 1 FROM cobros s WHERE s.corrige_a = c.id);

-- Sin índice sobre `atribucion`: el resumen de caja ya trae la fila por
-- (organization_id, fecha_caja, estado) y reparte en memoria. No hay consulta que filtre por
-- atribución sola.
