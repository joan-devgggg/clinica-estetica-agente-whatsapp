-- seguimientos: la propuesta que sale DÍAS o SEMANAS después de una cita. 13/08/2026.
--
-- ── Por qué una tabla y no un flag en appointments ──────────────────────────
-- El patrón de al lado es `appointments.resena_enviada` / `recordatorio_enviado`: un booleano
-- que dice "esto ya salió". Aquí no basta, y no por gusto de normalizar: lo que hay que
-- guardar no es que salió, es QUÉ SE PROMETIÓ.
--
-- El mensaje le dice a la clienta un servicio concreto y un precio concreto con el descuento
-- ya aplicado ("85 € en vez de 95 €"). Tres semanas después alguien tiene que cobrar eso, y
-- para entonces el catálogo puede haber cambiado de precio — pasa: la migración 023 renombró
-- variantes y la 040 renombró los tres Spa Hair. Un booleano no puede sostener una promesa.
--
-- Y hay un segundo motivo, que es el que lo decide: Facturación deriva el importe del
-- catálogo, así que un cobro con -10 % le sale descuadrado SIEMPRE. Sin esta fila, ese
-- descuadre es indistinguible de un error de caja. Con ella, se explica solo.
--
-- ── Qué NO es esta tabla ────────────────────────────────────────────────────
-- No es una cola de mensajes. No hay filas "por enviar" esperando: la lista de candidatas se
-- RECALCULA en cada barrido contra la agenda del momento (una clienta que reservó ayer deja
-- de serlo hoy). Aquí solo se escriben hechos consumados — lo que se prometió y a quién.
--
-- Es la misma lección de la campaña de verano: se guarda la exclusión, no la lista de
-- destinatarios, porque una lista congelada es una FOTO que envejece en silencio.

CREATE TABLE IF NOT EXISTS seguimientos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- ── El origen ─────────────────────────────────────────────────────────────
  --
  -- ON DELETE SET NULL, y aquí sí es la opción correcta — al revés que en `cobros`.
  --
  -- En `cobros` el SET NULL estaba descartado porque emite un UPDATE sobre la fila y eso
  -- choca con el trigger `cobros_congelar_importes`, convirtiendo un DELETE de cita en un
  -- fallo que habla de dinero. Esta tabla NO tiene trigger de congelación, así que ese
  -- problema no existe.
  --
  -- Y RESTRICT sería activamente malo: haría que borrar una cita fallara porque le mandamos
  -- un WhatsApp, que es exactamente el atolladero de los "Close TIME" del 07/08/2026 (un
  -- cobro anulado impedía borrar un contacto entero). Un seguimiento no es dinero; no puede
  -- secuestrar una cita.
  --
  -- Lo que no se pierde al borrar la cita: las cuatro columnas congeladas de abajo. La fila
  -- sigue diciendo qué le prometimos a quién, que es para lo que existe.
  appointment_origen_id UUID REFERENCES appointments(id) ON DELETE SET NULL,

  -- CONGELADOS, misma lección que `stylist_name_facturado` (021) y `cobrado_por_nombre` (035):
  -- si esto se resolviera por JOIN, borrar la cita o renombrar un servicio reescribiría el
  -- histórico de lo que se prometió.
  servicio_origen  TEXT        NOT NULL,   -- appointments.service tal cual estaba
  categoria_origen TEXT        NOT NULL,   -- la categoría que disparó la regla
  cita_origen_at   TIMESTAMPTZ NOT NULL,   -- de aquí se cuentan los días, no de created_at

  -- Qué regla lo produjo, para poder auditar "¿por qué le llegó esto?" sin adivinar.
  regla_key        TEXT NOT NULL,

  -- ── El destino, congelado ENTERO ──────────────────────────────────────────
  --
  -- `destino_key` es "categoria|nombre", la MISMA identidad que ya emite
  -- GET /api/service-catalog y a la que se atan los desplegables del panel. No es un id
  -- porque el catálogo no tiene ids: es un array JSONB en agent_configs.services. Medido
  -- sobre el catálogo real: 81 claves distintas para 81 entradas, cero colisiones — mientras
  -- que `nombre` a secas colisiona ("Corto" existe 4 veces con 4 precios).
  destino_key      TEXT NOT NULL,
  -- El nombre tal como se le ESCRIBIÓ a la clienta (buildFullServiceName). Puede diferir del
  -- catálogo de dentro de tres semanas, y lo que vale es lo que ella leyó.
  destino_nombre   TEXT NOT NULL,

  -- ── El dinero prometido ───────────────────────────────────────────────────
  --
  -- Las tres cifras se guardan, incluida la que se puede recalcular. `precio_con_descuento`
  -- es redondeo de `destino_precio` y `descuento_pct`, sí — y aun así va a columna, porque es
  -- LA CIFRA QUE LEYÓ LA CLIENTA. Recalcularla al cobrar reabriría la discusión en el
  -- mostrador por un céntimo de redondeo, que es justo lo que el importe en euros venía a
  -- cerrar. Con IVA incluido, como el catálogo y como `cobros.importe_total`.
  destino_precio   NUMERIC(10,2) NOT NULL CHECK (destino_precio >= 0),
  descuento_pct    NUMERIC(5,2)  NOT NULL CHECK (descuento_pct >= 0 AND descuento_pct <= 100),
  precio_con_descuento NUMERIC(10,2) NOT NULL CHECK (precio_con_descuento >= 0),

  -- ── El envío ──────────────────────────────────────────────────────────────
  --
  -- 'resena_2h'        → viajó DENTRO del mensaje de reseña (cero WhatsApps añadidos)
  -- 'seguimiento_dias' → mensaje propio el día N
  via              TEXT NOT NULL CHECK (via IN ('resena_2h', 'seguimiento_dias')),

  -- 'pendiente' es el CLAIM: la fila se reserva ANTES de enviar, igual que
  -- broadcast_sends. Sin eso, dos barridos solapados o un proceso que se cae a media tanda
  -- mandan el mismo WhatsApp dos veces — y aquí el destinatario es una clienta, no un log.
  -- 'fallido' se limpia y se reintenta; 'enviado' no se toca nunca.
  estado           TEXT NOT NULL DEFAULT 'pendiente'
                   CHECK (estado IN ('pendiente', 'enviado', 'fallido', 'aceptado', 'caducado')),
  enviado_at       TIMESTAMPTZ,
  motivo_fallo     TEXT,

  -- El texto EXACTO que se envió. No es decoración: cuando la clienta diga "me dijisteis
  -- 85 €", esto es lo único que puede confirmarlo o desmentirlo. Los cuatro idiomas pasan
  -- por aquí y ninguno se puede reconstruir a posteriori (el catálogo habrá cambiado).
  mensaje_enviado  TEXT,

  -- ── Qué pasó después ──────────────────────────────────────────────────────
  --
  -- La cita que salió de esto, si salió. SET NULL por el mismo motivo que el origen.
  appointment_destino_id UUID REFERENCES appointments(id) ON DELETE SET NULL,

  -- El cobro donde se aplicó el descuento. Vive AQUÍ y no como `cobros.seguimiento_id` a
  -- propósito: `cobros` tiene el trigger de congelación, y las migraciones 036 y 038 ya
  -- tuvieron que reescribirlo entero solo por añadirle una columna. Poner el enlace en este
  -- lado lo evita, y falla hacia el lado recuperable — si esta escritura falla se pierde el
  -- enlace, nunca el dinero.
  cobro_id         UUID REFERENCES cobros(id) ON DELETE SET NULL,

  -- Una promesa no dura para siempre. Sin esto, un -10 % de hace ocho meses reaparece en el
  -- mostrador y nadie sabe si sigue en pie. Lo pone el worker (destino + margen), no un
  -- default de la BD, porque depende de la regla.
  caduca_at        TIMESTAMPTZ NOT NULL,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Un enviado dice cuándo. Es el campo del que se cuenta "¿cuánto hace que le escribimos?".
  CONSTRAINT seguimientos_enviado_con_fecha CHECK (estado <> 'enviado' OR enviado_at IS NOT NULL),
  -- Un fallo dice por qué, o no sirve de nada. Misma lección que los 4 importes manuales de
  -- `cobros` con el motivo a NULL: un registro sin motivo no significa nada.
  CONSTRAINT seguimientos_fallo_con_motivo CHECK (estado <> 'fallido' OR motivo_fallo IS NOT NULL),
  -- El precio con descuento no puede ser MAYOR que el de catálogo. Un signo invertido en el
  -- cálculo saldría por WhatsApp como una subida de precio.
  CONSTRAINT seguimientos_descuento_no_sube CHECK (precio_con_descuento <= destino_precio)
);

-- ── La reserva que impide el envío doble ────────────────────────────────────
--
-- Una cita puede disparar DOS reglas distintas (hidratación a los 18 días y matiz a los 28),
-- así que la clave lleva `regla_key`: sin él, la segunda regla no podría reservar nunca.
--
-- Lo que este UNIQUE garantiza es lo otro: que la MISMA regla sobre la MISMA cita no pueda
-- reservarse dos veces. El SELECT previo del worker no basta como exclusión —dos barridos
-- solapados lo pasan los dos—; quien decide es este índice, igual que en broadcast_sends.
--
-- Con `appointment_origen_id` a NULL (cita borrada) el índice deja de aplicar, y está bien:
-- esa fila ya es histórico, no hay nada que volver a enviar.
CREATE UNIQUE INDEX IF NOT EXISTS seguimientos_claim_unico
  ON seguimientos (organization_id, appointment_origen_id, regla_key)
  WHERE appointment_origen_id IS NOT NULL;

-- "¿Le hemos escrito hace poco?" — el tope de un seguimiento por clienta cada N días, que es
-- lo que impide que dos reglas con días parecidos le manden dos WhatsApps casi seguidos.
CREATE INDEX IF NOT EXISTS seguimientos_contacto_idx
  ON seguimientos (organization_id, contact_id, enviado_at DESC);

-- "¿Esta cita tiene un descuento prometido?" — lo consulta la caja al abrir el cobro.
CREATE INDEX IF NOT EXISTS seguimientos_destino_idx
  ON seguimientos (organization_id, appointment_destino_id)
  WHERE appointment_destino_id IS NOT NULL;

-- La promesa viva de una clienta: lo que la caja precarga y lo que el bot siembra en sesión.
CREATE INDEX IF NOT EXISTS seguimientos_vivos_idx
  ON seguimientos (organization_id, contact_id, caduca_at)
  WHERE estado = 'enviado' AND appointment_destino_id IS NULL;

ALTER TABLE seguimientos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "seguimientos_service_role" ON seguimientos
  TO service_role USING (true) WITH CHECK (true);

-- FOR SELECT, no FOR ALL. Todas las escrituras vienen del worker, que va por service_role
-- (services/supabase.js se crea con SUPABASE_SERVICE_ROLE_KEY); el panel solo necesita LEER.
-- Con FOR ALL, un usuario autenticado podría reescribir desde el navegador el precio que se
-- le prometió a una clienta — una promesa de dinero es superficie que no hace falta abrir.
-- Comprobado antes de cerrarlo: dashboard-app no toca esta tabla por ningún sitio, y sí usa
-- el cliente de navegador para otras (reservas, lista-negra, resenas), así que la ausencia
-- es real y no un descuido del grep.
CREATE POLICY "seguimientos_authenticated_own" ON seguimientos
  FOR SELECT TO authenticated
  USING (organization_id = (
    SELECT organization_id FROM profiles WHERE id = auth.uid()
  ));

COMMENT ON TABLE seguimientos IS
  'La propuesta que sale días o semanas después de una cita (hidratación tras mechas, matiz al mes), con su descuento. Guarda lo que se PROMETIÓ —servicio, precio y precio con descuento, congelados— porque el catálogo cambia y alguien tiene que cobrar eso semanas después. No es una cola: las candidatas se recalculan en cada barrido.';

COMMENT ON COLUMN seguimientos.destino_key IS
  'Identidad del servicio en el catálogo: "categoria|nombre", la misma que emite GET /api/service-catalog. El catálogo es un array JSONB sin ids, y `nombre` a secas no es único ("Corto" existe 4 veces con 4 precios).';

COMMENT ON COLUMN seguimientos.precio_con_descuento IS
  'La cifra EN EUROS que leyó la clienta. Se guarda aunque sea recalculable: recalcularla al cobrar reabre la discusión en el mostrador por un redondeo. Con IVA, como el catálogo.';

COMMENT ON COLUMN seguimientos.estado IS
  'pendiente = fila RESERVADA antes de enviar (el claim que impide el envío doble, patrón broadcast_sends) · enviado = salió · fallido = se limpia y se reintenta · aceptado = acabó en cita · caducado = se pasó caduca_at sin usarse.';
