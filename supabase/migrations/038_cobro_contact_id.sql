-- De quién es esta venta. 07/08/2026.
--
-- Fase 2·B. La dueña quiere ver "la venta de cada clienta", y hoy eso no se puede contestar
-- para una VENTA SIN CITA: `cobros` llega al contacto por `appointment_id → appointments.
-- contact_id`, y en una venta suelta no hay cita. El champú que se lleva una clienta conocida
-- queda hoy como texto libre en `concepto`, sin relación con su ficha.
--
-- Es una columna, no un rediseño: el camino seguro ya está probado en esta misma tabla.
--
-- ── Por qué ON DELETE SET NULL, y por qué aquí SÍ vale ──────────────────────
--
-- La 035 descartó SET NULL para `appointment_id` con un argumento correcto: el borrado emite un
-- UPDATE sobre esta fila que choca con `cobros_congelar_importes`, así que el DELETE de la cita
-- fallaría con un error que habla de cobros. Aquí no pasa, porque la columna entra por la
-- SEGUNDA guarda del trigger —la de las FK a personas—, que ya permite ir a NULL y solo prohíbe
-- REASIGNAR. Es exactamente el trato que ya tienen `cobrado_por` y `registrado_por`.
--
-- Y RESTRICT queda descartado por experiencia, no por teoría. El 07/08/2026 el RESTRICT de
-- `appointment_id` hizo fallar el borrado del contacto falso "Close TIME" hasta que se borró a
-- mano el cobro que colgaba de él. Repetirlo aquí sería peor: convertiría a cualquier clienta
-- que alguna vez haya comprado algo en un contacto imborrable, y el panel tiene botón de borrar.
--
-- CASCADE ni se plantea: borraría dinero al borrar una ficha.
--
-- ── Lo que esta columna NO hace ─────────────────────────────────────────────
--
-- No dice QUÉ se vendió. `concepto` sigue siendo texto libre, así que "¿cuánto champú vendí
-- este mes?" sigue sin respuesta: eso pide un catálogo de productos, que es otra pieza y no
-- entra aquí. Esta columna contesta "¿quién compró y cuánto?", que es lo que se pidió.
--
-- Tampoco se toca `cobros_tiene_origen` (appointment_id o concepto). Saber QUIÉN compró no
-- sustituye a saber QUÉ compró: una venta suelta sigue necesitando su concepto.
--
-- ── Sin CHECK que prohíba tener los dos ─────────────────────────────────────
--
-- Se valoró un CHECK "o cita o contacto, no ambos" para que hubiera una sola fuente. Se descarta
-- porque bloquearía un caso real: venderle un producto a una clienta que además tenía cita ese
-- día. La unicidad se resuelve al LEER, con un único resolutor
-- (`resolveClienteDelCobro`: cobro.contact_id ?? cita.contact_id), al estilo de
-- `resolveImporteReferencia`. Una precedencia declarada en un sitio, no dos columnas peleando.

ALTER TABLE cobros
  ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL;

COMMENT ON COLUMN cobros.contact_id IS
  'De quién es la venta cuando NO hay cita (venta de producto suelta). Con cita, la clienta sale de la cita y esta columna se queda a NULL: la precedencia la resuelve resolveClienteDelCobro, no la base. ON DELETE SET NULL para que borrar una ficha no sea imposible — el trigger permite anularla pero no reasignarla.';

-- Índice parcial: solo las filas que apuntan a alguien. Hoy serían 0 de 1, y aunque crezca la
-- tabla la mayoría de cobros seguirán colgando de una cita, no de esta columna.
CREATE INDEX IF NOT EXISTS cobros_contact_idx
  ON cobros (organization_id, contact_id)
  WHERE contact_id IS NOT NULL;

-- ── El trigger: contact_id se puede ANULAR, no REASIGNAR ────────────────────
--
-- Va a la segunda guarda y no a la tupla de arriba, y esa es toda la migración en realidad. En
-- la tupla, el UPDATE que emite ON DELETE SET NULL haría fallar el borrado de la clienta; en la
-- segunda guarda, ese mismo UPDATE pasa (porque NEW.contact_id es NULL) y en cambio cualquier
-- intento de moverlo a OTRA clienta revienta. Que es lo que se quiere: un cobro no cambia de
-- dueña; si se apuntó mal, se anula y se rectifica con fila nueva, como todo lo demás aquí.
CREATE OR REPLACE FUNCTION public.cobros_congelar_importes()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
  OR (NEW.contact_id     IS NOT NULL AND NEW.contact_id     IS DISTINCT FROM OLD.contact_id)
  THEN
    RAISE EXCEPTION 'cobros: no se puede reasignar quién cobró, quién registró ni de quién es un cobro. Anula y rectifica.';
  END IF;

  RETURN NEW;
END;
$function$;

-- La vista `cobros_vigentes` hay que refrescarla, y esto es fácil de pasar por alto: aunque se
-- escribió como `SELECT c.*`, Postgres EXPANDE el asterisco al crearla y la deja clavada a las
-- columnas de ese momento. O sea que no añade `contact_id` sola. Y como `getCobrosVigentes` lee
-- de la vista y nunca de la tabla, sin esto la columna se guardaría y no habría forma de leerla
-- por el camino normal — un dato escrito e invisible, que es de los fallos más caros de ver.
--
-- CREATE OR REPLACE y NO drop+create, por dos motivos:
--   · un DROP se lleva por delante los GRANT (anon, authenticated, service_role) y las
--     reloptions. Volverían por las default privileges de Supabase, pero eso es una suposición
--     y aquí se puede no suponer.
--   · CREATE OR REPLACE VIEW exige las MISMAS columnas en el mismo orden y solo admite añadir
--     al FINAL. Es justo lo que pasa: `ALTER TABLE ADD COLUMN` deja `contact_id` la última, así
--     que el `*` se expande a la lista de siempre más una al final. Si algún día no encajara,
--     esta sentencia FALLA en vez de dejar la vista distinta a lo que dice el fichero.
CREATE OR REPLACE VIEW cobros_vigentes WITH (security_invoker = on) AS
SELECT c.*
FROM cobros c
WHERE c.estado = 'vigente'
  AND NOT EXISTS (SELECT 1 FROM cobros s WHERE s.corrige_a = c.id);
