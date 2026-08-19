-- 043_reserva_web_claim.sql
--
-- ✅ APLICADA EN LA BD REMOTA EL 19/08/2026, con permiso del dueño
-- (supabase_migrations.schema_migrations, version 20260819203018). Antes de aplicarla se
-- probó el EXCLUDE en un bloque DO $$ … RAISE $$ que revierte: se construyó sin violaciones
-- contra las 88 filas reales y quedó 0 residuo. Verificado después: constraint presente,
-- btree_gist 1.7 instalada, y EXECUTE solo para postgres y service_role.
--
-- ── POR QUÉ ─────────────────────────────────────────────────────────────────────────────
--
-- El enlace público de reserva convierte la agenda en algo que escriben dos caminos SIN
-- NADIE MIRANDO (el bot y la web), además del panel. Hoy no hay nada que impida dos citas
-- en el mismo hueco. Medido el 19/08/2026 contra `pg_indexes` y `pg_constraint`:
--
--   · `appointments` tiene 6 índices y NINGUNO es único salvo la PK.
--   · `appointments` tiene CERO restricciones EXCLUDE.
--   · La guarda de `saveAppointment` (services/db.js) tiene clave
--     (organization_id, contact_id, starts_at): sirve para que un REINTENTO de la misma
--     clienta no duplique, y para nada más. Dos clientas DISTINTAS pidiendo a Irina las
--     17:00 pasan las dos sin que nada las mire.
--   · Y es un SELECT seguido de un INSERT, sin nada detrás a nivel de datos: dos peticiones
--     simultáneas leen las dos vacío e insertan las dos.
--
-- El molde ya está escrito dos veces en este repo —`broadcast_sends` (027) y `seguimientos`
-- (041)—, con la frase que lo resume en la cabecera de la 027: «el UNIQUE es la garantía de
-- verdad, no el SELECT previo». Aquí un UNIQUE no vale: dos citas a la misma hora son filas
-- perfectamente legítimas si son de estilistas distintas. La forma correcta de «que no se
-- pisen» sobre un intervalo es un EXCLUDE con rango.
--
-- ── QUÉ TRAE, Y QUÉ NO ──────────────────────────────────────────────────────────────────
--
--   1. La extensión `btree_gist` (disponible en el proyecto, hoy SIN instalar).
--   2. Un EXCLUDE PARCIAL que solo mira las citas automáticas (`bot`, `web`).
--   3. `reservar_hueco()`: el único camino por el que la web escribe una cita.
--
-- NO toca ni una fila existente. No hay backfill. No cambia ninguna columna.
--
-- ── LA DECISIÓN DISCUTIBLE: por qué el EXCLUDE es PARCIAL ───────────────────────────────
--
-- El salón SOLAPA A PROPÓSITO. Medido el 19/08/2026: 7 pares de citas superpuestas sobre la
-- misma estilista, y los 7 son `manual` ↔ `manual` (cero implican a `bot` o `web`). Uno de
-- ellos es de más de una hora: una colorista atendiendo dos cabezas durante el tiempo de
-- exposición. Eso no es un despiste, es cómo trabaja el salón.
--
-- Una restricción global «no se puede solapar» sería por tanto (a) inaplicable —7 filas la
-- violan hoy— y (b) falsa: le prohibiría a la dueña trabajo que hace de verdad. Por eso el
-- predicado deja FUERA a `manual`, que es lo que hace que esta migración se pueda aplicar
-- sin romper nada.
--
-- ⚠️ Y AQUÍ ESTÁ EL MATIZ QUE HAY QUE ENTENDER ANTES DE FIRMAR ESTO:
--
--    Un EXCLUDE parcial solo impide el solape entre filas que CUMPLEN LAS DOS el predicado.
--    Una cita `web` que se monta sobre una cita `manual` NO la para esta restricción — y
--    ese es justamente el choque MÁS PROBABLE, porque 57 de las 58 citas activas son
--    manuales.
--
--    Quien cubre ese caso es la re-verificación de dentro de `reservar_hueco()` (paso 6),
--    que mira las citas de CUALQUIER origen. Pero el panel no toma el cerrojo consultivo
--    (no debe: tiene derecho a solapar), así que ese caso queda ESTRECHADO, NO ELIMINADO.
--    MEDIDO el 20/08/2026 (fase 4c de scripts/prueba-claim-concurrente.js, n=40 sobre
--    Postgres 17 local): la ventana interna check→INSERT es de 0,08–0,28 ms (mediana
--    0,09, p95 0,20) y la llamada entera —la cota superior, con commit— de 0,45–1,09 ms
--    (mediana 0,53). La parte interna es del servidor y representativa; en producción la
--    cota de cliente crece con la red hasta Supabase, la interna no. Una cita manual que
--    comitee DENTRO de esa ventana produce el solape sin que nadie lo vea — demostrado en
--    la misma fase con la ventana mantenida abierta. Es un residuo consciente, y lo
--    recoge el aviso del panel («Veronika ya tiene a alguien a esa hora, ¿la pones
--    igual?»), que va aparte.
--
-- ── ANTES DE APLICAR: comprobación que revierte ─────────────────────────────────────────
--
-- Correr esto ANTES. Si el EXCLUDE no se puede crear, sale por RAISE y no queda nada:
--
--   BEGIN;
--     CREATE EXTENSION IF NOT EXISTS btree_gist;
--     ALTER TABLE appointments
--       ADD CONSTRAINT tmp_probe EXCLUDE USING gist (
--         organization_id WITH =, stylist_id WITH =,
--         tstzrange(starts_at, ends_at) WITH &&
--       ) WHERE (source IN ('bot','web')
--                AND status IS DISTINCT FROM 'cancelled'
--                AND stylist_id IS NOT NULL);
--     SELECT count(*) FROM pg_constraint WHERE conname = 'tmp_probe';  -- debe dar 1
--   ROLLBACK;
--   SELECT count(*) FROM pg_constraint WHERE conname = 'tmp_probe';    -- debe dar 0


-- ── 1 · La extensión ────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- ── 2 · El EXCLUDE parcial ──────────────────────────────────────────────────────────────
--
-- `status IS DISTINCT FROM 'cancelled'` y no `status <> 'cancelled'`: la columna es
-- NULLABLE (hoy 0 nulos, pero el esquema los permite) y con `<>` un NULL haría que el
-- predicado fuese NULL, o sea que la fila quedaría FUERA de la restricción sin que nadie lo
-- pidiera. Una cita sin estado tiene que estar protegida como cualquier otra.
ALTER TABLE appointments
  ADD CONSTRAINT appointments_sin_solape_automatico
  EXCLUDE USING gist (
    organization_id WITH =,
    stylist_id      WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  )
  WHERE (
    source IN ('bot','web')
    AND status IS DISTINCT FROM 'cancelled'
    AND stylist_id IS NOT NULL
  );

COMMENT ON CONSTRAINT appointments_sin_solape_automatico ON appointments IS
  'Dos citas AUTOMÁTICAS (bot/web) no pueden solapar sobre la misma estilista. Parcial a '
  'propósito: `manual` queda fuera porque el salón solapa a propósito (7 pares reales el '
  '19/08/2026, todos manual↔manual). No cubre web↔manual: eso lo estrecha el cerrojo de '
  'reservar_hueco() y lo recoge el aviso del panel.';


-- ── 3 · reservar_hueco() ────────────────────────────────────────────────────────────────
--
-- El ÚNICO camino por el que la web escribe una cita. Se llama desde DENTRO de
-- `db.saveAppointment`, en la rama `source === 'web'`, para que siga habiendo un solo
-- camino de creación: dos caminos es el patrón que ya nos costó caro.
--
-- DÓNDE VA LA RAYA, que es la parte de diseño: esta función comprueba solo «¿el hueco
-- FÍSICO está libre?» — horario, bloqueos y citas. La skill de la estilista, la duración y
-- la resolución del servicio se quedan en JS, ANTES de llamar. Duplicar esas reglas aquí
-- sería crear la segunda versión del motor de huecos, que es exactamente lo que el enlace
-- no puede tener.
--
-- DEVUELVE UN MOTIVO, NO UN NULL (regla 3: nada de defaults silenciosos). El conjunto es
-- CERRADO, misma doctrina que MOTIVOS_OFRECIBLES:
--
--     ok              la cita se ha escrito; `cita_id` trae su id
--     hueco_ocupado   se acaba de ocupar — la página lo dice y recarga los huecos
--     fuera_de_horario  la estilista no trabaja ese día, o no a esa hora
--     bloqueado       día bloqueado (blocked_days) o franja bloqueada (schedule_blocks)
--     tope_citas      el contacto ya tiene el máximo de citas web futuras
--     rango_invalido  fin <= inicio. NUNCA debería llegar: significa que nuestro JS
--                     construyó mal el rango. Se devuelve en vez de reventar para que el
--                     fallo se vea en el log y no tumbe la petición.
--
-- SEGURIDAD. `SECURITY DEFINER` porque no hay usuario autenticado detrás de una página
-- pública: la llamada entra por Express con la service key. Eso significa que la función
-- SALTA RLS, así que el REVOKE de abajo NO es higiene, es la cerradura: sin él, `anon`
-- hereda EXECUTE de PUBLIC y cualquiera con la clave pública de Supabase podría reservar
-- llamando a la RPC directamente. `SET search_path = public`, molde de la 022.
CREATE OR REPLACE FUNCTION reservar_hueco(
    p_org         uuid,
    p_contact     uuid,
    p_stylist     uuid,
    p_starts_at   timestamptz,
    p_ends_at     timestamptz,
    p_servicio    text,
    p_full_name   text,
    p_phone       text,
    p_notas       text    DEFAULT NULL,
    p_max_futuras integer DEFAULT 2
)
RETURNS TABLE (ok boolean, motivo text, cita_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_fecha   date;
    v_dow     integer;
    v_ini     time;
    v_fin     time;
    v_futuras integer;
    v_id      uuid;
BEGIN
    -- (0) Forma. Un rango vacío o invertido haría reventar a tstzrange más abajo.
    IF p_ends_at <= p_starts_at THEN
        RETURN QUERY SELECT false, 'rango_invalido', NULL::uuid;
        RETURN;
    END IF;

    -- Todo lo que sigue se mide en hora de PARED de Madrid, porque así están guardados
    -- `stylist_schedules.start_time` / `end_time` (time without time zone). Es la misma
    -- decisión que toMinutes/toLocalDateStr en services/date-utils.js: las horas de trabajo
    -- son texto de pared, las citas son instantes, y para compararlos hay que traer el
    -- instante a la TZ del NEGOCIO — nunca a la del proceso.
    v_fecha := (p_starts_at AT TIME ZONE 'Europe/Madrid')::date;
    v_ini   := (p_starts_at AT TIME ZONE 'Europe/Madrid')::time;
    v_fin   := (p_ends_at   AT TIME ZONE 'Europe/Madrid')::time;

    -- (1) EL CERROJO. Serializa SOLO las escrituras sobre la misma estilista el mismo día;
    -- se suelta solo al hacer commit. Sin esto, bajo READ COMMITTED las comprobaciones de
    -- abajo no VEN la fila que la otra transacción todavía no ha comiteado, y las dos
    -- llegan al INSERT. La colisión de hashtext entre orgs/días distintos solo produce
    -- serialización de más, nunca un resultado incorrecto.
    PERFORM pg_advisory_xact_lock(
        hashtext(p_org::text || ':' || p_stylist::text || ':' || v_fecha::text)::bigint
    );

    -- (2) Tope de citas web futuras de este contacto.
    -- Cuenta SOLO las de origen web: una clienta con dos citas puestas por el salón no
    -- puede quedarse sin poder reservar por el enlace.
    SELECT count(*) INTO v_futuras
      FROM appointments
     WHERE organization_id = p_org
       AND contact_id      = p_contact
       AND source          = 'web'
       AND status IS DISTINCT FROM 'cancelled'
       AND starts_at > now();
    IF v_futuras >= p_max_futuras THEN
        RETURN QUERY SELECT false, 'tope_citas', NULL::uuid;
        RETURN;
    END IF;

    -- (3) Día bloqueado. OJO: son DOS tablas distintas y el motor lee las dos.
    --   · `blocked_days`   → días ENTEROS, por fecha. `stylist_id` NULLABLE: a NULL
    --                        significa el salón entero (hoy 0 filas así, 17 por estilista).
    --   · `schedule_blocks`→ rangos DENTRO de un día, `stylist_id` NOT NULL (paso 5).
    -- Mirar solo una de las dos deja pasar reservas en días cerrados. El espejo en JS es
    -- db.getBlockedDays + db.getScheduleBlocks, los dos consumidos por calendar-sante.js.
    IF EXISTS (
        SELECT 1 FROM blocked_days
         WHERE organization_id = p_org
           AND fecha = v_fecha
           AND (stylist_id = p_stylist OR stylist_id IS NULL)
    ) THEN
        RETURN QUERY SELECT false, 'bloqueado', NULL::uuid;
        RETURN;
    END IF;

    -- (4) ¿Trabaja ese día, y la cita entera cabe en su franja?
    -- `day_of_week` es 0=lunes … 6=domingo (convención de mondayDow en date-utils.js,
    -- confirmada contra los datos: Larisa tiene 0..5 y el salón cierra domingo). ISODOW da
    -- 1=lunes, de ahí el -1.
    --
    -- Se usa `v_fin <= end_time` (permisivo) y no `<` (estricto). El motor hoy es ESTRICTO
    -- —computeFreeSlots exige `t + duracion < workEnd`, que es el defecto D3 por el que se
    -- pierde el último hueco legítimo de cada jornada— así que hoy esta rama nunca ve una
    -- cita que acabe justo al cierre. Se deja permisiva A PROPÓSITO: cuando D3 se arregle y
    -- el motor empiece a ofrecer ese hueco, la función ya lo acepta y no hay que volver a
    -- tocar una migración aplicada. Al revés —función estricta, motor permisivo— sería una
    -- reserva ofrecida y luego rechazada con un mensaje incomprensible.
    --
    -- Una cita que cruzara la medianoche daría v_fin < v_ini y caería aquí como
    -- 'fuera_de_horario'. Es el lado correcto: el motor no las genera y no queremos que la
    -- web sea el primer sitio que las escriba.
    v_dow := EXTRACT(ISODOW FROM v_fecha)::integer - 1;
    IF NOT EXISTS (
        SELECT 1 FROM stylist_schedules
         WHERE organization_id = p_org
           AND stylist_id      = p_stylist
           AND day_of_week     = v_dow
           AND v_ini >= start_time
           AND v_fin <= end_time
    ) THEN
        RETURN QUERY SELECT false, 'fuera_de_horario', NULL::uuid;
        RETURN;
    END IF;

    -- (5) Bloqueo dentro del día (vacaciones, descansos, «Close TIME»).
    IF EXISTS (
        SELECT 1 FROM schedule_blocks
         WHERE organization_id = p_org
           AND stylist_id      = p_stylist
           AND tstzrange(starts_at, ends_at) && tstzrange(p_starts_at, p_ends_at)
    ) THEN
        RETURN QUERY SELECT false, 'bloqueado', NULL::uuid;
        RETURN;
    END IF;

    -- (6) ¿Hay ya una cita encima? DE CUALQUIER ORIGEN, incluido `manual`.
    -- Esta es la única cobertura de web-sobre-manual: el EXCLUDE de arriba no la da, porque
    -- deja `manual` fuera del predicado a propósito.
    IF EXISTS (
        SELECT 1 FROM appointments
         WHERE organization_id = p_org
           AND stylist_id      = p_stylist
           AND status IS DISTINCT FROM 'cancelled'
           AND tstzrange(starts_at, ends_at) && tstzrange(p_starts_at, p_ends_at)
    ) THEN
        RETURN QUERY SELECT false, 'hueco_ocupado', NULL::uuid;
        RETURN;
    END IF;

    -- (7) Escribir. `full_name` y `phone` son NOT NULL en el esquema; el formulario los
    -- garantiza y por eso la cita web nace en mejores condiciones que muchas de hoy (existe
    -- `informe:nombres` precisamente porque faltan nombres).
    INSERT INTO appointments (
        organization_id, contact_id, stylist_id, service,
        starts_at, ends_at, status, source, updated_by,
        full_name, phone, notes, recordatorio_enviado
    ) VALUES (
        p_org, p_contact, p_stylist, p_servicio,
        p_starts_at, p_ends_at, 'confirmed', 'web', 'web',
        p_full_name, p_phone, p_notas, false
    )
    RETURNING id INTO v_id;

    RETURN QUERY SELECT true, 'ok', v_id;

EXCEPTION
    -- 23P01 = exclusion_violation. Con el cerrojo puesto no debería llegarse aquí nunca;
    -- está para que, si alguien quita el cerrojo o aparece un camino nuevo, la perdedora
    -- reciba el MISMO motivo limpio que recibiría normalmente en vez de una excepción que
    -- aguas arriba nadie sabe leer.
    WHEN exclusion_violation THEN
        RETURN QUERY SELECT false, 'hueco_ocupado', NULL::uuid;
END;
$$;

COMMENT ON FUNCTION reservar_hueco IS
  'Claim atómico del enlace público. Único camino de escritura de una cita source=web. '
  'Devuelve (ok, motivo, cita_id) con motivo de conjunto cerrado. SECURITY DEFINER: salta '
  'RLS, y por eso EXECUTE está revocado de PUBLIC.';

-- La cerradura. Sin esto `anon` hereda EXECUTE de PUBLIC y la función queda expuesta a
-- cualquiera que tenga la clave pública del proyecto.
REVOKE EXECUTE ON FUNCTION reservar_hueco(uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reservar_hueco(uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text, integer) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION reservar_hueco(uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text, integer) TO service_role;
