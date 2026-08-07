-- cobros: lo que de verdad entró en caja. Fase 1 del cierre de caja, 07/08/2026.
--
-- ── Por qué una tabla y no columnas en appointments ──────────────────────────
-- Facturación deriva TODO de `appointments`: cruza `service` contra el catálogo y suma. Eso
-- responde "¿cuánto valía esto?", no "¿cuánto entró?". Son dos números distintos y no tienen
-- por qué cuadrar — la diferencia ES el dato (propina, descuento, producto).
--
-- Y hay hechos de caja que NO son una cita: un producto suelto, dos citas pagadas juntas, una
-- señal. Si el cobro fueran columnas de `appointments` esos casos no tendrían dónde ir, y se
-- volverían a colar por `precio_manual` — que es exactamente lo que pasa hoy: 4 de las 15
-- citas completadas de Sante llevan un importe manual (85→105, 190→205, 50→60, 270→260) y las
-- CUATRO con `motivo` NULL. Ya hay un cierre de caja escrito ahí, en el único campo que había,
-- y sin forma de saber si un +20 € fue propina, producto o corrección.
--
-- ── Qué NO es esta tabla ─────────────────────────────────────────────────────
-- No es un control antifraude. Nadie puede impedir con software que se declare mal lo que se
-- cobró; eso es cámaras y responsabilidad de cada estilista. Esto existe para que auditar sea
-- CÓMODO. De ahí que no haya ni una restricción que obligue a cuadrar nada.
--
-- ── El eje es el EFECTIVO ────────────────────────────────────────────────────
-- La tarjeta se verifica sola contra el banco. El único número que nadie más va a contar es el
-- efectivo, así que es el único que tiene que ser exacto — y por eso `importe_efectivo` es
-- columna propia con un CHECK que impide que `metodo` mienta, en vez de un campo libre.

CREATE TABLE IF NOT EXISTS cobros (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Referencia OPCIONAL a la cita. NULL = venta sin cita (producto suelto).
  --
  -- ON DELETE RESTRICT, y las tres alternativas están descartadas por un motivo concreto:
  --
  --   · CASCADE borraría el dinero al borrar la cita. Es exactamente la trampa que tiene hoy
  --     `appointments.contact_id` (CASCADE), descubierta el 07/08/2026 al mirar qué se llevaba
  --     por delante el contacto falso "Close TIME": 4 citas, una con servicio real.
  --   · SET NULL parece inofensivo y no lo es: el borrado de la cita emite un UPDATE sobre
  --     esta fila, que choca con el trigger cobros_congelar_importes y hace fallar el DELETE
  --     con un error que habla de cobros. `DELETE /api/citas/:id` existe y borra de verdad
  --     (webhook.js), así que sería un fallo alcanzable desde el panel. Además dejaría un
  --     cobro sin origen, violando cobros_tiene_origen.
  --   · Sin FK se pierde la integridad y aparecen cobros apuntando a citas que ya no existen.
  --
  -- RESTRICT convierte eso en lo que debe ser: borrar una cita con dinero registrado FALLA, en
  -- voz alta, y la API lo traduce a "esta cita tiene un cobro; anúlalo primero". De paso vuelve
  -- ruidoso el CASCADE de contacts→appointments para todo lo que tenga caja detrás.
  appointment_id   UUID REFERENCES appointments(id) ON DELETE RESTRICT,

  -- Quién COBRÓ. Distinto de appointments.stylist_id, que es quién ATENDIÓ: el objetivo de la
  -- dueña es que cada estilista responda de su propia caja, y quien cobra es el eje de eso.
  cobrado_por      UUID REFERENCES stylists(id) ON DELETE SET NULL,
  -- El nombre congelado, misma lección que `appointments.stylist_name_facturado` (migración
  -- 021): el informe resolvía el nombre por JOIN y renombrar a una estilista le reescribía el
  -- histórico. Un cierre de caja de hace tres meses tiene que seguir diciendo quién lo cerró.
  cobrado_por_nombre TEXT,

  -- El DÍA de caja, como DATE de MADRID, NO derivado de un timestamp al leer.
  --
  -- Tres razones. (1) Derivarlo de un timestamptz haría que el día dependiera de la zona del
  -- que lee. (2) `appointments.facturado_at` ya demostró el problema: la cita del 01/08 a las
  -- 08:30 se selló el 02/08 a las 00:20 — cruza el día. (3) La sesión de esta base corre en
  -- **UTC** (comprobado el 07/08/2026: current_setting('TimeZone') = 'UTC'), y Madrid va por
  -- DELANTE, así que la ventana en la que UTC y Madrid discrepan es 00:00–02:00 hora local:
  -- un cobro a las 00:30 tiene fecha UTC del día ANTERIOR. Es justo la hora de cerrar la
  -- caja, y un solo cobro mal fechado descuadra DOS cierres a la vez (le sobra a uno y le
  -- falta al otro).
  --
  -- Quién lo calcula: `db.createCobro`, con `toLocalDateStr()` de services/date-utils.js
  -- (BUSINESS_TZ = Europe/Madrid, vía Intl) — NUNCA `toISOString().slice(0,10)`, que es UTC.
  -- La API acepta un `fechaCaja` explícito para el caso deliberado de imputar un cobro de
  -- madrugada a la jornada anterior.
  --
  -- El DEFAULT es la red, y es Madrid explícito: si algún camino futuro se olvida de pasarlo,
  -- el valor que sale sigue siendo el correcto en vez de un día desplazado.
  fecha_caja       DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'Europe/Madrid')::date),
  -- Cuándo se registró de verdad. Auditoría, no agrupación.
  cobrado_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  metodo           TEXT NOT NULL CHECK (metodo IN ('efectivo', 'tarjeta', 'bizum', 'mixto')),

  -- CON IVA, misma convención que el catálogo y que precio_facturado/precio_manual: base sin
  -- IVA = importe / (1 + iva_rate). Así las dos vistas (Facturación y Caja) se comparan sin
  -- conversiones.  0 es un importe VÁLIDO (cortesía, 100 % de descuento).
  importe_total    NUMERIC(10,2) NOT NULL CHECK (importe_total >= 0),
  -- La parte en efectivo. En un cobro mixto es LO ÚNICO que se teclea; el resto es tarjeta por
  -- resta (importe_total - importe_efectivo).
  importe_efectivo NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (importe_efectivo >= 0),
  iva_rate         NUMERIC(5,4)  NOT NULL DEFAULT 0.21,

  -- Qué se cobró cuando no hay cita (producto suelto). Texto libre.
  concepto         TEXT,

  -- Lo que decía Facturación en el momento de cobrar, CONGELADO. Sin esto, la Fase 3 tendría
  -- que recalcular el precio de referencia meses después contra un catálogo que ya cambió —
  -- justo la fuga que cerró la migración 021. NULL = no había importe de referencia (cita sin
  -- servicio resoluble, o venta sin cita).
  importe_referencia NUMERIC(10,2),
  -- Por qué difiere del de referencia. De una sola pulsación, no texto libre: las 4
  -- correcciones manuales que hay hoy tienen `motivo` NULL, y por eso no significan nada.
  motivo_diferencia TEXT CHECK (motivo_diferencia IN ('propina', 'producto', 'descuento', 'servicio_extra', 'otro')),
  nota             TEXT,

  -- ── Rectificación ─────────────────────────────────────────────────────────
  -- Un cobro no se edita: se escribe otro que lo sustituye, apuntándole con `corrige_a`.
  --
  -- **El sucesor ES la anulación.** Rectificar es UNA sola escritura, y eso no es una
  -- comodidad: hacerlo en dos (anular el viejo + insertar el nuevo) tiene un estado roto en
  -- medio pase lo que pase, porque aquí no hay transacción multi-sentencia. Si falla la
  -- segunda, o el día pierde dinero (anulado sin sustituto) o lo cuenta dos veces (dos
  -- vigentes). Con el sucesor como única marca, ese hueco no existe: o la fila entró o no.
  --
  -- `estado` cubre el caso que el sucesor NO puede cubrir: anular SIN sustituto ("esto no se
  -- llegó a cobrar", "lo registré por error"). Por eso sigue existiendo y por eso es lo único
  -- que un UPDATE puede tocar.
  --
  -- CUENTA en el día  ⟺  estado = 'vigente'  Y  nadie le apunta con corrige_a.
  -- Un cobro rectificado NO cuenta aunque su `estado` siga en 'vigente': no hace falta
  -- tocarlo, y no tocarlo es justo lo que lo hace atómico.
  estado           TEXT NOT NULL DEFAULT 'vigente' CHECK (estado IN ('vigente', 'anulado')),
  corrige_a        UUID REFERENCES cobros(id) ON DELETE RESTRICT,
  motivo_correccion TEXT,
  anulado_at       TIMESTAMPTZ,
  anulado_por      UUID REFERENCES profiles(id) ON DELETE SET NULL,

  -- El usuario del panel que lo tecleó, del token ya verificado (req.authUserId), NUNCA del
  -- body. Hoy Sante tiene UN login compartido (`sante@crm.local`), así que esta columna sola
  -- no atribuye nada: quien atribuye es `cobrado_por`. El PIN por estilista es la pieza que
  -- falta y va aparte.
  registrado_por   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- `metodo` no puede mentir sobre el efectivo. Sin esto, un cobro marcado 'tarjeta' con
  -- efectivo a 40 € (o al revés) descuadraría el cierre sin que nada lo delatara, y el cierre
  -- entero se apoya en que `importe_efectivo` sea de fiar.
  CONSTRAINT cobros_metodo_coherente CHECK (
    (metodo = 'efectivo'             AND importe_efectivo = importe_total) OR
    (metodo IN ('tarjeta', 'bizum')  AND importe_efectivo = 0) OR
    (metodo = 'mixto'                AND importe_efectivo > 0 AND importe_efectivo < importe_total)
  ),
  -- Un cobro dice de qué es: o apunta a una cita, o lleva concepto. Si no, en el cierre
  -- aparece un importe del que nadie puede decir de dónde salió.
  CONSTRAINT cobros_tiene_origen CHECK (appointment_id IS NOT NULL OR concepto IS NOT NULL),
  -- Una rectificación SIEMPRE dice por qué. Es la mitad del valor de rectificar.
  CONSTRAINT cobros_correccion_motivada CHECK (corrige_a IS NULL OR motivo_correccion IS NOT NULL),
  CONSTRAINT cobros_no_se_corrige_a_si_mismo CHECK (corrige_a IS DISTINCT FROM id),
  -- Un anulado sabe cuándo lo anularon.
  CONSTRAINT cobros_anulado_con_fecha CHECK (estado <> 'anulado' OR anulado_at IS NOT NULL)
);

-- Un cobro se rectifica UNA vez. Sin esto, dos rectificaciones del mismo original quedarían
-- las dos vigentes y el día contaría el importe dos veces. Encadenar sí vale (A anulado ←
-- B anulado ← C vigente): cada eslabón corrige a uno distinto.
CREATE UNIQUE INDEX IF NOT EXISTS cobros_corrige_a_unico
  ON cobros (corrige_a) WHERE corrige_a IS NOT NULL;

-- El cierre del día por estilista (Fase 2) y el listado de caja.
CREATE INDEX IF NOT EXISTS cobros_org_fecha_idx    ON cobros (organization_id, fecha_caja, estado);
CREATE INDEX IF NOT EXISTS cobros_org_estilista_idx ON cobros (organization_id, cobrado_por, fecha_caja);
-- "¿Esta cita ya está cobrada?" desde la ficha.
CREATE INDEX IF NOT EXISTS cobros_appointment_idx  ON cobros (organization_id, appointment_id)
  WHERE appointment_id IS NOT NULL;

ALTER TABLE cobros ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cobros_service_role" ON cobros
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "cobros_authenticated_own" ON cobros
  FOR ALL TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

-- ── El ÚNICO sitio que decide qué cobro cuenta ──────────────────────────────
--
-- "Cuenta en el día ⟺ estado='vigente' Y nadie le apunta con corrige_a" es un invariante de
-- CONSULTA: ningún CHECK puede imponerlo, porque habla de la relación entre dos filas en el
-- momento de leer. Si cada pantalla lo reescribe a mano, tarde o temprano una suma mal — y en
-- una caja eso no se nota, solo descuadra.
--
-- Así que vive aquí y en ningún otro sitio. Todo lo que cuente dinero lee de esta vista; la
-- tabla `cobros` solo se consulta en crudo para ver el HISTÓRICO (lo anulado y lo rectificado,
-- que es justo lo que la vista esconde). Mismo criterio que el catálogo: el filtro en un solo
-- lugar, no repartido por los call sites.
--
-- `security_invoker = on` NO es opcional: sin él la vista se ejecuta con los permisos de su
-- propietario y se salta el RLS de `cobros`, de modo que una org vería la caja de la otra.
-- Con él, las políticas de la tabla se aplican igual que en una consulta directa.
-- (Postgres 17.6 en este proyecto; security_invoker existe desde la 15.)
CREATE OR REPLACE VIEW cobros_vigentes
  WITH (security_invoker = on) AS
  SELECT c.*
    FROM cobros c
   WHERE c.estado = 'vigente'
     AND NOT EXISTS (SELECT 1 FROM cobros s WHERE s.corrige_a = c.id);

COMMENT ON VIEW cobros_vigentes IS
  'Los cobros que CUENTAN: vigentes y no rectificados. Es la única definición de ese invariante en todo el sistema — cualquier suma de caja sale de aquí. Para el histórico (anulados y rectificados) se consulta la tabla cobros directamente. security_invoker=on para que el RLS de cobros siga aplicando.';

-- ── Congelar los importes: el trigger es la garantía, no la disciplina ───────
--
-- "Los importes se congelan al escribirlos" no puede depender de que todo el código futuro se
-- acuerde. `precio_manual` es la prueba: se escribe en UN solo sitio y aun así hoy no queda
-- rastro de que una cita valía 85 € y alguien la puso en 105 — se sobreescribió en el sitio.
--
-- Aquí lo único que puede cambiar en una fila ya escrita es su ANULACIÓN. Todo lo demás
-- —importe, método, efectivo, fecha de caja, quién cobró, a qué cita apunta— es inmutable. El
-- camino para cambiar un importe es escribir otro cobro con `corrige_a`, que es justo lo que
-- se decidió el 07/08/2026.
--
-- Nombre con prefijo de tabla a propósito: esta base de datos está COMPARTIDA con otros
-- proyectos, y un `set_updated_at` genérico ya se identificó como riesgo en la migración 033.
CREATE OR REPLACE FUNCTION public.cobros_congelar_importes()
RETURNS TRIGGER AS $$
BEGIN
  -- Inmutables sin excepción: el dinero, cuándo y de qué es.
  -- `nota` queda FUERA a propósito: es una anotación que no mueve un céntimo, y obligar a
  -- rectificar para arreglar una errata generaría rectificaciones falsas — ruido en el único
  -- registro que existe para poder auditar con comodidad. `motivo_diferencia` sí entra: es la
  -- explicación de una diferencia de dinero, y cambiarla cambia lo que la fila afirma.
  IF (NEW.organization_id, NEW.appointment_id, NEW.cobrado_por_nombre,
      NEW.fecha_caja, NEW.cobrado_at, NEW.metodo, NEW.importe_total, NEW.importe_efectivo,
      NEW.iva_rate, NEW.concepto, NEW.importe_referencia, NEW.motivo_diferencia,
      NEW.corrige_a, NEW.motivo_correccion, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.appointment_id, OLD.cobrado_por_nombre,
      OLD.fecha_caja, OLD.cobrado_at, OLD.metodo, OLD.importe_total, OLD.importe_efectivo,
      OLD.iva_rate, OLD.concepto, OLD.importe_referencia, OLD.motivo_diferencia,
      OLD.corrige_a, OLD.motivo_correccion, OLD.created_at)
  THEN
    RAISE EXCEPTION 'cobros: un cobro no se edita. Para corregirlo, anúlalo y escribe otro con corrige_a (solo estado, anulado_at, anulado_por y nota son modificables).';
  END IF;

  -- Las referencias a PERSONAS solo pueden ir a NULL, nunca a otra persona. Ese NULL lo escribe
  -- el ON DELETE SET NULL al dar de baja una estilista o un usuario del panel, y sin esta
  -- excepción esas bajas fallarían con un error que habla de cobros — el mismo fallo que
  -- appointment_id evita con RESTRICT, pero aquí la baja SÍ debe poder ocurrir.
  -- No se pierde la atribución: `cobrado_por_nombre` está congelado arriba.
  IF (NEW.cobrado_por    IS NOT NULL AND NEW.cobrado_por    IS DISTINCT FROM OLD.cobrado_por)
  OR (NEW.registrado_por IS NOT NULL AND NEW.registrado_por IS DISTINCT FROM OLD.registrado_por)
  THEN
    RAISE EXCEPTION 'cobros: no se puede reasignar quién cobró ni quién registró un cobro. Anula y rectifica.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cobros_congelar_importes ON public.cobros;

CREATE TRIGGER cobros_congelar_importes
  BEFORE UPDATE ON public.cobros
  FOR EACH ROW
  EXECUTE FUNCTION public.cobros_congelar_importes();

-- NO se pone un trigger que prohíba DELETE, y no por descuido: `organization_id` es
-- ON DELETE CASCADE, así que borrar una organización emite DELETEs sobre esta tabla y un
-- guard los haría fallar — dejando la org imposible de borrar por un motivo que nadie
-- relacionaría con la caja. Es la misma clase de rotura silenciosa que el CASCADE de
-- contacts→appointments. La vía para deshacer un cobro es anularlo, y la API no expone DELETE.

COMMENT ON TABLE cobros IS
  'Lo que entró en caja. Registro contable: se escribe una vez y se congela; corregir es anular + fila nueva con corrige_a. Distinto de Facturación, que CALCULA lo que valía el servicio — que los dos números difieran es normal y la diferencia es el dato.';

COMMENT ON COLUMN cobros.fecha_caja IS
  'Día de caja al que pertenece el cobro (fecha LOCAL, la decide quien registra). No se deriva de cobrado_at: un cobro de las 00:30 puede ser de la jornada anterior, y facturado_at ya demostró que los timestamps cruzan el día.';

COMMENT ON COLUMN cobros.importe_efectivo IS
  'Parte cobrada en efectivo, CON IVA. Es el único importe que nadie más va a contar (la tarjeta la verifica el banco), así que es el que tiene que ser exacto. El CHECK cobros_metodo_coherente impide que `metodo` lo contradiga.';

COMMENT ON COLUMN cobros.cobrado_por IS
  'Estilista que COBRÓ (stylists.id). Distinto de appointments.stylist_id, que es quién atendió. cobrado_por_nombre lo congela para que renombrar a una estilista no reescriba cierres pasados.';

COMMENT ON COLUMN cobros.importe_referencia IS
  'Lo que decía Facturación al cobrar, congelado. NULL = no había referencia (cita sin servicio resoluble, o venta sin cita). Sin esto, la alerta de descuadre tendría que recalcular meses después contra un catálogo ya cambiado.';

COMMENT ON COLUMN cobros.estado IS
  'vigente | anulado. anulado = anulado SIN sustituto (no se llegó a cobrar, o se registró por error). Un cobro RECTIFICADO no se marca aquí: basta con que otro le apunte por corrige_a. Cuenta en el día ⟺ estado=vigente Y nadie le apunta. Nada se borra nunca: lo anulado es el histórico.';

COMMENT ON COLUMN cobros.corrige_a IS
  'El cobro al que sustituye. Es la ANULACIÓN del anterior, no un adorno: por eso rectificar es una sola escritura y no puede quedar a medias. El índice único cobros_corrige_a_unico impide que dos rectificaciones del mismo original queden ambas vigentes.';
