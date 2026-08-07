-- Dar un día por revisado. 07/08/2026. Fase 2·C.
--
-- NO es un cierre contable, y esa distinción es la que da forma a toda la tabla. La dueña no
-- quiere detectar descuadres: quiere dejar de depender del WhatsApp que la recepcionista le
-- manda cada noche con el efectivo, el TPV y el total, y poder mirarlo ella desde casa. Sus
-- palabras sobre el dinero fueron "nunca falta". Así que esto es un ACUSE DE REVISIÓN: alguien
-- ha mirado este día y deja constancia. Si hay diferencia se apunta, y no se le pide a nadie
-- que la justifique.
--
-- ── Por qué es un hecho nuevo y no un informe ───────────────────────────────
--
-- El resumen del día se recalcula cada vez que se abre la pantalla: si mañana entra un cobro
-- con `fecha_caja` de ayer, el resumen de ayer cambia solo. Para un resumen está bien; para un
-- acuse es inaceptable. Un día revisado tiene que seguir diciendo lo que decía cuando se
-- revisó, y por eso los `esperado_*` se CONGELAN aquí en vez de derivarse al leer. Es la
-- lección de la 021 (`precio_facturado`) un piso más arriba.
--
-- ── UNA caja, no una por estilista ──────────────────────────────────────────
--
-- El plan original repartía el cierre por estilista. La dueña lo descartó: la caja del salón es
-- una sola. Por eso aquí NO hay `stylist_id`. El PIN no desaparece — sigue diciendo quién cobró
-- cada cobro (`cobros.atribucion`), que es otra pregunta y sigue teniendo respuesta.
--
-- ── El cierre es ASÍNCRONO, y ese es el caso NORMAL ─────────────────────────
--
-- El TPV no aparece en el banco hasta el día siguiente, así que lo corriente es cerrar HOY el
-- día de AYER. La tabla no lo impone —`fecha_caja` es el día revisado y `cerrado_at` el momento
-- de revisarlo, y pueden distar lo que sea— pero conviene tenerlo escrito, porque de ahí sale
-- que la pantalla abra en ayer y que "revisado y luego movido" sea corriente y no una rareza.
--
-- ── Sin identidad, a propósito ──────────────────────────────────────────────
--
-- `cerrado_por` se guarda pero dice muy poco: todo el salón entra con el mismo usuario
-- (`sante@crm.local`) y los tres perfiles son `role='owner'`. La dueña confirmó que puede
-- cobrar cualquiera —ella, las estilistas, o una estilista distinta de la que hizo el
-- servicio—, así que un candado por rol sería un candado que no cierra. Se guarda el HECHO y la
-- HORA, no la persona. Mismo trato honesto que `cobros.registrado_por`.

CREATE TABLE IF NOT EXISTS cierres_caja (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- El día REVISADO, como DATE de Madrid. NO es el día en que se revisa: eso es `cerrado_at`.
  -- Se compara y se agrupa contra `cobros.fecha_caja`, que es la misma clase de dato.
  fecha_caja       DATE NOT NULL,

  -- ── Lo CONGELADO: lo que sumaban sus cobros en el momento de revisar ──────
  -- Sale de `buildCajaResumen` sobre la vista `cobros_vigentes`, que es la única definición de
  -- "qué cuenta". `esperado_tarjeta` incluye bizum, igual que en el resumen: la partición real
  -- es "efectivo / lo que verifica el banco".
  esperado_efectivo NUMERIC(10,2) NOT NULL CHECK (esperado_efectivo >= 0),
  esperado_tarjeta  NUMERIC(10,2) NOT NULL CHECK (esperado_tarjeta  >= 0),
  esperado_total    NUMERIC(10,2) NOT NULL CHECK (esperado_total    >= 0),
  -- Cuántos cobros había al revisar. Es lo que permite detectar que el día SE HA MOVIDO desde
  -- entonces sin tener que comparar importes: si hoy hay más cobros que los que se contaron, el
  -- acuse ya no habla del mismo día.
  num_cobros        INTEGER NOT NULL CHECK (num_cobros >= 0),

  -- ── Lo que dice la persona ────────────────────────────────────────────────
  contado_efectivo  NUMERIC(10,2) NOT NULL CHECK (contado_efectivo >= 0),
  tpv_declarado     NUMERIC(10,2) NOT NULL CHECK (tpv_declarado    >= 0),

  -- Las diferencias se GUARDAN, no se derivan. Podrían salir restando dos columnas de esta
  -- misma fila y darían igual, pero son LA cifra del acuse: una cifra que se recalcula al leer
  -- acaba dependiendo de cómo se lea. Pueden ser negativas — es su único sentido.
  diferencia_efectivo NUMERIC(10,2) NOT NULL,
  diferencia_tarjeta  NUMERIC(10,2) NOT NULL,

  cerrado_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Ver la cabecera: con login compartido esto no identifica a nadie. Se guarda para el día que
  -- haya usuarios de verdad, no porque hoy signifique algo.
  cerrado_por      UUID REFERENCES profiles(id) ON DELETE SET NULL,

  -- Libre y OPCIONAL. Nada de la lista cerrada de `cobros.motivo_diferencia`: la dueña dijo
  -- que no quiere justificar diferencias, y pedir un motivo obligatorio convertiría el acuse en
  -- un interrogatorio — que es la forma más rápida de que se deje de usar.
  nota             TEXT,

  -- Mismo esquema de corrección que `cobros`: no se edita, se sustituye. Volver a revisar un
  -- día no reescribe lo que se dijo la primera vez.
  estado           TEXT NOT NULL DEFAULT 'vigente' CHECK (estado IN ('vigente','anulado')),
  corrige_a        UUID REFERENCES cierres_caja(id) ON DELETE RESTRICT,
  motivo_correccion TEXT,
  anulado_at       TIMESTAMPTZ,
  anulado_por      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cierres_correccion_motivada CHECK (corrige_a IS NULL OR motivo_correccion IS NOT NULL),
  CONSTRAINT cierres_no_se_corrige_a_si_mismo CHECK (corrige_a IS DISTINCT FROM id),
  CONSTRAINT cierres_anulado_con_fecha CHECK (estado <> 'anulado' OR anulado_at IS NOT NULL)
);

-- Una corrección por original: impide que dos revisiones del mismo día queden ambas vigentes.
-- Idéntico a `cobros_corrige_a_unico`, y por el mismo motivo.
CREATE UNIQUE INDEX IF NOT EXISTS cierres_corrige_a_unico
  ON cierres_caja (corrige_a) WHERE corrige_a IS NOT NULL;

-- Un solo acuse ABIERTO por día. No se puede expresar como índice único a secas —durante una
-- corrección conviven el original y su sucesor, los dos con estado='vigente'— así que lo que
-- se indexa es el par (día, cabeza de cadena): solo las filas que NO corrigen a nadie. Una
-- segunda revisión del mismo día tiene que apuntar a la anterior con `corrige_a`, y entonces
-- ya no entra aquí.
CREATE UNIQUE INDEX IF NOT EXISTS cierres_un_acuse_por_dia
  ON cierres_caja (organization_id, fecha_caja)
  WHERE corrige_a IS NULL AND estado = 'vigente';

CREATE INDEX IF NOT EXISTS cierres_org_fecha_idx ON cierres_caja (organization_id, fecha_caja, estado);

ALTER TABLE cierres_caja ENABLE ROW LEVEL SECURITY;

-- Sin política para `authenticated`: igual que `stylist_pins` (036), esta tabla la toca solo la
-- API con service_role. El panel no habla con Supabase directamente para esto.

-- ── La vista: qué acuse CUENTA ─────────────────────────────────────────────
-- "Cuenta ⟺ estado='vigente' Y nadie le apunta con corrige_a", definido UNA vez aquí. Si cada
-- consulta lo filtrara a mano habría dos definiciones y una acabaría contando de más.
CREATE OR REPLACE VIEW cierres_vigentes WITH (security_invoker = on) AS
SELECT c.*
FROM cierres_caja c
WHERE c.estado = 'vigente'
  AND NOT EXISTS (SELECT 1 FROM cierres_caja s WHERE s.corrige_a = c.id);

-- ── Congelación ────────────────────────────────────────────────────────────
-- Un acuse dice lo que alguien afirmó en un momento. Editarlo a posteriori es reescribir esa
-- afirmación, así que solo se permite anular (y la nota, que no cambia ninguna cifra).
CREATE OR REPLACE FUNCTION public.cierres_congelar()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (NEW.organization_id, NEW.fecha_caja, NEW.esperado_efectivo, NEW.esperado_tarjeta,
      NEW.esperado_total, NEW.num_cobros, NEW.contado_efectivo, NEW.tpv_declarado,
      NEW.diferencia_efectivo, NEW.diferencia_tarjeta, NEW.cerrado_at,
      NEW.corrige_a, NEW.motivo_correccion, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.fecha_caja, OLD.esperado_efectivo, OLD.esperado_tarjeta,
      OLD.esperado_total, OLD.num_cobros, OLD.contado_efectivo, OLD.tpv_declarado,
      OLD.diferencia_efectivo, OLD.diferencia_tarjeta, OLD.cerrado_at,
      OLD.corrige_a, OLD.motivo_correccion, OLD.created_at)
  THEN
    RAISE EXCEPTION 'cierres_caja: un día revisado no se edita. Vuelve a revisarlo con una fila nueva que apunte a la anterior con corrige_a (solo estado, anulado_at, anulado_por y nota son modificables).';
  END IF;

  -- Las FK a personas pueden ir a NULL (lo hace ON DELETE SET NULL al borrar un perfil) pero no
  -- reasignarse. Mismo patrón que `cobros`.
  IF (NEW.cerrado_por IS NOT NULL AND NEW.cerrado_por IS DISTINCT FROM OLD.cerrado_por)
  OR (NEW.anulado_por IS NOT NULL AND NEW.anulado_por IS DISTINCT FROM OLD.anulado_por)
  THEN
    RAISE EXCEPTION 'cierres_caja: no se puede reasignar quién revisó un día. Anula y vuelve a revisar.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS cierres_congelar ON cierres_caja;
CREATE TRIGGER cierres_congelar BEFORE UPDATE ON cierres_caja
  FOR EACH ROW EXECUTE FUNCTION cierres_congelar();

COMMENT ON TABLE cierres_caja IS
  'Acuse de REVISIÓN de un día de caja, no un cierre contable: alguien ha mirado el día y deja constancia. Una caja por salón (no por estilista). Los esperado_* se congelan al revisar; si el día se mueve después, la diferencia contra lo congelado es un DATO visible, no un cambio silencioso. La diferencia se apunta sin pedir motivo.';
COMMENT ON COLUMN cierres_caja.fecha_caja IS
  'El día REVISADO (DATE de Madrid). Distinto de cerrado_at: lo normal es revisar hoy el día de ayer, porque el TPV no aparece en el banco hasta el día siguiente.';
COMMENT ON COLUMN cierres_caja.num_cobros IS
  'Cuántos cobros vigentes había AL REVISAR. Es lo que permite decir "este día se ha movido desde que se revisó" sin recalcular importes.';
COMMENT ON COLUMN cierres_caja.cerrado_por IS
  'Quién lo revisó. Hoy dice muy poco: el salón entra con un login compartido. Se guarda para cuando haya usuarios de verdad, no porque hoy identifique a nadie.';
