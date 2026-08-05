-- De dónde salió el idioma de cada ficha. Backfill de metadata.language_source, 05/08/2026.
--
-- APLICADA el 05/08/2026 (versión 20260805142644). Reparto resultante, verificado leyendo
-- después: 537 default (535 Sante + 2 San Remo) · 184 inferred · 3 observed · 0 sin marca.
-- El UPDATE de abajo es idempotente, así que volver a pasarla no rehace nada.
--
-- ── El agujero ───────────────────────────────────────────────────────────────
-- `contacts.language` decide en qué idioma le habla el bot a una clienta y qué plantilla de
-- Meta recibe en una campaña. La columna mezcla TRES calidades y nada las distingue:
--
--   · ~20 idiomas observados (la clienta escribió y se detectó),
--   · 184 deducidos del nombre por scripts/classify-sante-language-by-name.js,
--   · 534 con el 'es' del INSERT que no eligió nadie.
--
-- Ese tercer grupo no es un idioma: es la ausencia de uno. Pero se comportaba como los otros
-- dos. Caso que lo destapó (05/08/2026): el contacto 19542240982 (+1, EEUU) escribió
-- "Thursday", su ficha llevaba el 'es' por defecto, y el prompt se lo anunció al LLM como
-- «Último idioma detectado: "es"» — el bot le contestó en castellano, a ella y a la foto que
-- mandó 36 s después. Y en campaña, esas 534 fichas reciben la plantilla española sin que
-- nadie pueda saber a cuántas les corresponde de verdad.
--
-- ── Qué hace esta migración ──────────────────────────────────────────────────
-- Escribe metadata.language_source con uno de tres valores: 'observed' | 'inferred' |
-- 'default'. NO toca `contacts.language`: las campañas siguen exactamente igual el día que
-- esto se aplique. Lo único que cambia es que a partir de ahora se puede saber de qué fiarse.
--
-- Va en metadata y no en una columna nueva porque sigue siendo segmentable en SQL
-- (`where metadata->>'language_source' = 'default'`) sin migrar el esquema ni tocar RLS.
--
-- ── Cómo se clasifica lo que ya existe ───────────────────────────────────────
-- Las escrituras anteriores no dejaron traza, así que se deduce de lo que sí se puede
-- afirmar. Las reglas son las mismas que aplica resolveLanguageSource() en services/helpers.js
-- para una fila sin marca — código y datos tienen que decir lo mismo o el backfill sería una
-- foto que se despega de la lógica en cuanto llegue una fila nueva:
--
--   1. metadata.language_inferred = true  → 'inferred'   (184 filas; las 184 son 'ru')
--   2. language <> 'es'                   → 'observed'   (3 filas: 2 'ru' + 1 'en')
--      El default es SIEMPRE 'es', así que un valor distinto no pudo salir de ahí: o lo
--      escribió updateContactLanguage viendo escribir a la clienta, o lo puso una persona.
--   3. el resto                           → 'default'    (534 Sante + 2 San Remo)
--
-- El punto 3 es deliberadamente conservador y conviene entender qué se paga. De los 22
-- contactos de Sante con algún mensaje entrante, 18 están en 'es' y quedan marcados
-- 'default' aunque puede que su castellano sí se observara en su día. No se les da el
-- beneficio de la duda por un motivo concreto: el criterio alternativo —"tiene mensajes
-- entrantes, luego se observó"— marcaría como 'observed' justo a 19542240982, que tiene un
-- mensaje entrante ("Thursday") y NO tiene idioma observado. Perpetuaría el caso que
-- motivó todo esto.
--
-- Y equivocarse hacia 'default' no cuesta casi nada: en el siguiente mensaje de esa clienta,
-- detectLanguage vuelve a leer su castellano y updateContactLanguage la deja en 'observed'.
-- El único efecto entretanto es un turno en el que el LLM decide el idioma leyendo el
-- mensaje, que es lo que hace bien. Al revés no se recupera solo: se queda mudo y mintiendo.
--
-- Idempotente: solo escribe donde la marca no está, así que se puede repetir sin pisar nada
-- de lo que el código haya ido marcando después.

begin;

update contacts c
set metadata = coalesce(c.metadata, '{}'::jsonb)
             || jsonb_build_object(
                    'language_source',
                    case
                        when c.metadata->'language_inferred' = 'true'::jsonb then 'inferred'
                        when c.language is not null and c.language <> 'es'   then 'observed'
                        else 'default'
                    end,
                    'language_source_backfill_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                )
where c.metadata->>'language_source' is null;

-- Reparto esperado tras aplicar (Sante b2c3d4e5-…): 534 default · 184 inferred · 3 observed.
-- San Remo: 2 default. Si no cuadra, algo escribió entre el recuento y el UPDATE.
commit;

-- ── Comprobación (leer, no escribe nada) ─────────────────────────────────────
-- select metadata->>'language_source' as fuente, language, count(*)
-- from contacts group by 1,2 order by 1,2;
--
-- ── Lo que esto desbloquea ───────────────────────────────────────────────────
-- Antes de una campaña, a quién NO se le puede afirmar el idioma:
-- select count(*) from contacts
-- where organization_id = 'b2c3d4e5-f6a7-8901-bcde-f12345678901'
--   and metadata->>'language_source' = 'default';
