-- Una cita que a propósito NO se cobra. 07/08/2026.
--
-- Es la mitad que faltaba de la decisión del 07/08: el panel EXIGE un servicio del catálogo al
-- crear una cita a mano, y esta casilla es el escape explícito para lo que de verdad no se
-- cobra. Sin ella, exigir servicio obligaría a inventarse uno el día que haya algo fuera de
-- catálogo — o sea, a mentir; y sin exigirlo, cualquier cita creada a mano sigue apareciendo
-- en «pendientes de cobrar» para siempre.
--
-- El caso que lo motiva está en la agenda ahora mismo: tres citas `service='Cita manual'` con
-- la clienta inventada "Close TIME", que son BLOQUEOS de agenda. Salen en Caja como si
-- hubiera alguien a quien cobrar, y no hay forma de distinguirlas por esquema — son citas
-- normales. (Esas tres tienen su propio arreglo, que es pasarlas a `schedule_blocks`; esta
-- columna es para lo que sí es una cita y aun así no se cobra.)
--
-- ── Por qué una columna y no deducirlo ──────────────────────────────────────
-- Se intentó deducir y no se puede, sin romper algo:
--   · por el teléfono del contacto → hay 3 clientas REALES sin teléfono usable en Sante.
--   · por `importe_referencia IS NULL` → una cita con servicio fuera de catálogo es
--     perfectamente cobrable; solo hay que teclear el importe.
--   · por el nombre del servicio → "Cita manual" es una convención del panel, no un dato.
-- Lo único que distingue "esto no se cobra" es que alguien lo diga. Así que se dice.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS no_facturable BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN appointments.no_facturable IS
  'true = esta cita NO se cobra a propósito (bloqueo, cortesía, hueco reservado). La deja fuera de la lista de pendientes de Caja. NO afecta a Facturación, que sigue valorando la cita si su servicio resuelve: son dos preguntas distintas ("¿cuánto vale?" y "¿hay que cobrarlo?").';

-- El DEFAULT es `false` y esa dirección importa: una cita que nadie ha marcado se considera
-- COBRABLE. El error recuperable es que aparezca algo de más en la lista y se ignore; el
-- irrecuperable es que una cita real desaparezca de Caja y nadie cobre ese dinero.
--
-- NOT NULL para que no exista el tercer estado: un NULL aquí obligaría a cada consulta a
-- decidir qué significa, y una de ellas acabaría decidiendo distinto.

-- Sin backfill: las 33 citas existentes quedan cobrables, que es lo que eran hasta hoy. Las
-- tres de "Close TIME" NO se marcan desde aquí — están pendientes de una conversación con la
-- dueña y de pasar a schedule_blocks, y marcarlas las escondería en vez de arreglarlas.

-- Sin índice: la consulta de pendientes ya trae la fila por (organization_id, starts_at) y
-- filtra sobre un puñado de citas al día.
