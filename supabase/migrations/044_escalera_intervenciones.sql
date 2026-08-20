-- 044_escalera_intervenciones.sql
--
-- ✅ APLICADA EN LA BD REMOTA EL 20/08/2026, con permiso del dueño y tras enseñarla entera
-- (regla 6). Verificado después: 16 columnas, 3 índices (la PK y los dos de abajo), RLS
-- activada, UNA política y solo para `service_role`, y CERO filas. Ninguna tabla existente
-- cambió — `appointments` 89, `contacts` 774, `messages` 997, `config` 13, los mismos de
-- antes.
--
-- Antes de aplicarla se probó EN SECO el mismo SQL dentro de un bloque `DO $$ … RAISE $$`
-- que revierte: pasaron el CREATE TABLE, los dos índices, el ENABLE RLS, la política y un
-- INSERT con la forma EXACTA que escribe `registrarIntervencionEscalera`, y se comprobó
-- contra information_schema que no quedaba ni una fila.
--
-- El código que escribe aquí TOLERA que la tabla no exista: si falta, avisa UNA vez por
-- proceso y sigue. Eso hizo que el push del commit y la migración fueran dos decisiones
-- separadas, y sigue valiendo para cualquier entorno donde la 044 no esté aplicada.
--
-- ── POR QUÉ ─────────────────────────────────────────────────────────────────────────────
--
-- La ESCALERA se come mensajes del modelo: cuando una red de agenda condena la respuesta,
-- o la reescribe (3er peldaño) o la sustituye (4º). Cada intervención ya deja el evento
-- `escalera_intervencion` con TODO lo que hace falta para juzgarla —qué red, qué peldaño,
-- qué motivo, y los dos textos, el comido y el que salió—.
--
-- El problema no es la instrumentación: es la RETENCIÓN. Producción corre en Railway, y ahí
-- hay dos sitios y los dos son efímeros:
--
--   · los logs, que no son consultables a una semana vista;
--   · `metrics.json`, que vive en el disco del contenedor y se pone a CERO en cada deploy
--     — y medido sobre el reflog de origin/main, en 30 días el hueco mayor entre dos
--     despliegues fue de 1,88 días. La ventana de medida nunca llega a dos semanas.
--
-- Consecuencia real y medida: la auditoría del 20/08/2026 encontró 12 disparos del embudo
-- («Para mirarte los huecos primero necesito saber qué servicio quieres») en 7 días, sobre
-- 8 personas, y NO PUDO DECIR qué red disparó en cada uno. El borrador que se comió la red
-- no está en `messages` —fue sustituido antes de enviarse— y el log ya había caducado. Las
-- conclusiones de esa auditoría sobre el llamador tuvieron que salir por descarte.
--
-- Esta tabla existe para que la QUINTA auditoría no tenga que descartar nada.
--
-- ── QUÉ TRAE, Y QUÉ NO ──────────────────────────────────────────────────────────────────
--
-- Una tabla nueva. NO toca ninguna existente, no hay backfill, no cambia ninguna columna y
-- no la lee nadie todavía. Es escritura de telemetría y punto.
--
-- ── LAS TRES DECISIONES QUE NO SON OBVIAS ───────────────────────────────────────────────
--
-- 1. `telefono TEXT` y NO `contact_id UUID REFERENCES contacts(id)`.
--
--    Una FK a `contacts` traería CASCADE, y borrar un contacto ya se lleva por delante en
--    silencio su conversación entera (hecho 7 de CLAUDE.md: la ficha de Olga Yarmak, 30
--    mensajes auditados, desaparecida el 11/08/2026 sin dejar un DELETE). Una tabla de
--    AUDITORÍA que se borra cuando se borra lo auditado no sirve para auditar: justo el día
--    que alguien quiera saber qué le pasó a una clienta cuya ficha se borró, es cuando
--    tiene que seguir estando.
--
--    El teléfono en texto sobrevive al borrado y sigue casando con `messages` por
--    (telefono, created_at) para recuperar QUÉ había escrito ella en ese turno — que por eso
--    tampoco se duplica aquí: el mensaje de la clienta ya vive en `messages` y copiarlo
--    crearía dos versiones de lo mismo que pueden divergir.
--
-- 2. `salida` nace NULL y hoy no la escribe nadie.
--
--    Es la columna que dirá con cuál de las salidas del sustituto se contestó cuando esas
--    salidas existan (la tanda 2 del embudo: cita_viva / servicio_sin_resolver /
--    pedir_servicio / ofrecer_persona). Va desde ya para no pedir una segunda migración
--    por una columna, y sobre todo porque una de esas salidas —ofrecer una persona— ARMA
--    UNA ESCALADA DE VERDAD y le cuesta trabajo a alguien del salón: tiene que poder
--    contarse aparte de las demás escaladas desde el primer día, no estimarse.
--
-- 3. Solo `service_role`. Sin política para `authenticated`.
--
--    Nada de dashboard-app lee esta tabla ni va a leerla en esta tanda. Abrir SELECT a los
--    usuarios de la org sería superficie a cambio de nada; cuando haya una pantalla que la
--    necesite, se añade la política entonces y se sabrá para qué. Escribe el bot, que va por
--    service_role (services/supabase.js se crea con SUPABASE_SERVICE_ROLE_KEY).
--
-- ── CRECIMIENTO ─────────────────────────────────────────────────────────────────────────
--
-- Una fila por intervención de la escalera, no por turno. En el arnés completo (33
-- escenarios) el contador local marcó 35 intervenciones; en producción no está medido, que
-- es precisamente lo que esta tabla viene a arreglar. Aunque fueran cien al día son ~36.000
-- filas al año de texto corto: no hace falta política de retención todavía, y si algún día
-- hace falta, `created_at` está indexado.

CREATE TABLE IF NOT EXISTS escalera_intervenciones (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Con quién pasó. Texto y no FK: ver decisión 1 de la cabecera.
  telefono         TEXT,

  -- ── Qué pasó ──────────────────────────────────────────────────────────────
  clase            TEXT NOT NULL,            -- 'agenda' (la única clase que existe hoy)
  red              TEXT NOT NULL,            -- proposesTimingWithoutService | respondsWithInventedSlots | respondsWithInventedDates
  peldano          TEXT NOT NULL,            -- 'regenerar' (3º, se rescató) | 'sustituir' (4º, derrota)
  motivo           TEXT,                     -- por qué NO se rescató: politica_directa_4, regen_timing_sin_servicio, …
  latencia_regen_ms INTEGER,                 -- null si no se llegó a llamar al modelo

  -- Con cuál de las salidas del sustituto se contestó. NULL hasta la tanda 2: ver
  -- decisión 2 de la cabecera.
  salida           TEXT,

  -- ── Los dos textos: el comido y el que salió ──────────────────────────────
  -- Son NUESTROS, no de la clienta. Lo que ella escribió está en `messages` y se recupera
  -- por (telefono, created_at) — no se copia aquí para no tener dos versiones del mismo
  -- mensaje que puedan divergir.
  respuesta_original TEXT,
  respuesta_final    TEXT,

  -- ── El contexto que DECIDE el sustituto ───────────────────────────────────
  -- Sin esto la fila dice qué salió pero no por qué salió eso, que es la mitad que hacía
  -- falta para clasificar los 12 disparos del 20/08 y no estaba en ningún sitio.
  tiene_servicio   BOOLEAN,                  -- session.selectedService != null
  huecos_cargados  INTEGER,                  -- session.availableSlots.length
  sin_servicio_streak INTEGER,               -- el contador que decide pregunta vs menú vs persona
  idioma           TEXT
);

-- La consulta de una auditoría: "todas las intervenciones de esta org desde tal día".
CREATE INDEX IF NOT EXISTS escalera_intervenciones_org_fecha_idx
  ON escalera_intervenciones (organization_id, created_at DESC);

-- El reparto por red y motivo, que es el número que tiene que bajar.
CREATE INDEX IF NOT EXISTS escalera_intervenciones_reparto_idx
  ON escalera_intervenciones (organization_id, red, peldano);

ALTER TABLE escalera_intervenciones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "escalera_intervenciones_service_role" ON escalera_intervenciones
  TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE escalera_intervenciones IS
  'Una fila por vez que la ESCALERA se come una respuesta del modelo (redes de agenda del salón). Existe por RETENCIÓN, no por instrumentación: el evento escalera_intervencion ya lo logueaba todo, pero los logs de Railway caducan en días y metrics.json se pone a cero en cada deploy, así que la auditoría del 20/08/2026 no pudo decir qué red disparó en 12 disparos del embudo. No la lee nadie todavía.';

COMMENT ON COLUMN escalera_intervenciones.telefono IS
  'Texto, no FK a contacts: una FK traería CASCADE y borrar un contacto se lleva su conversación entera en silencio (hecho 7). Una auditoría que desaparece con lo auditado no audita.';

COMMENT ON COLUMN escalera_intervenciones.salida IS
  'Cuál de las salidas del sustituto contestó. NULL hasta que existan (tanda 2 del embudo). Va desde ya porque una de ellas, ofrecer una persona, arma una escalada real y tiene que poder contarse aparte de las demás desde el primer día.';

COMMENT ON COLUMN escalera_intervenciones.peldano IS
  'regenerar = el 3er peldaño rescató la respuesta. sustituir = derrota del contrato: el mensaje del modelo se perdió y salió el de la causa. El % de "sustituir" es el número que tiene que bajar.';
