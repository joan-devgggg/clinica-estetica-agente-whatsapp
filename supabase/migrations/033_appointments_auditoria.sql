-- Una cita no sabía cuándo la tocaron por última vez, ni quién, ni desde dónde.
-- Auditoría mínima de appointments, 05/08/2026.
--
-- ── El agujero ───────────────────────────────────────────────────────────────
-- `appointments` tenía `created_at` y nada más. Todo lo demás se pisa en el sitio:
-- reagendar hace UPDATE in-place (rescheduleAppointment, a propósito — duplicar la fila era
-- peor), cancelar cambia `status`, el panel edita servicio y estilista, y los workers marcan
-- recordatorio_enviado / resena_enviada / status='completed'.
--
-- Consecuencia: cuando una clienta dice "yo no pedí esa hora", no hay NADA que mirar. La
-- fila enseña el estado actual y punto. No se puede distinguir una cita que nadie ha tocado
-- desde que se creó de una que se movió tres veces, ni saber si la movió una persona desde
-- el panel o el bot desde una conversación.
--
-- ── Qué se añade y por qué así ───────────────────────────────────────────────
--   · `updated_at` lo mantiene un TRIGGER, no el código. Hay una docena de sitios que
--     escriben en appointments y van a seguir apareciendo más; cualquiera que se olvide de
--     poner la columna deja un `updated_at` que miente, y una fecha que a veces miente no
--     sirve para nada. El trigger no se puede olvidar.
--   · `updated_by` lo pone el código, porque el trigger no puede saberlo: la conexión es
--     siempre la misma service_role. Formato 'panel:<uuid del usuario>', 'bot',
--     'worker:review', 'worker:auto-complete'. NULL = escritura anterior a esto, o un
--     camino que aún no lo declara: "no consta", que es distinto de "fue el bot".
--   · `last_change` guarda SOLO el último cambio ({at, by, de:{...}, a:{...}}), no un
--     historial. Es la respuesta a la pregunta que se hace de verdad ("¿de qué hora a qué
--     hora la movieron?") sin montar una tabla de auditoría, sus índices y su purga para un
--     salón que hace ~15 citas vivas.
--
-- ── Sobre el relleno de updated_at ───────────────────────────────────────────
-- La columna se añade SIN default y se rellena con `created_at`, y solo después se le pone
-- el default. Añadirla directamente con DEFAULT NOW() habría escrito la hora de la
-- migración en las 700 filas existentes: todas las citas del histórico dirían que se
-- modificaron el mismo segundo, que es exactamente lo contrario de lo que se busca.
--
-- Aditiva y reversible: ninguna columna existente se toca, ninguna fila cambia de sentido.

ALTER TABLE public.appointments
    ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_by  TEXT,
    ADD COLUMN IF NOT EXISTS last_change JSONB;

UPDATE public.appointments SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE public.appointments ALTER COLUMN updated_at SET DEFAULT NOW();

-- El trigger es la razón de que updated_at se pueda creer. Se define genérico y por eso
-- lleva `IF NOT EXISTS`-equivalente (CREATE OR REPLACE): si otra migración futura lo
-- necesita para otra tabla, reutiliza esta función en vez de escribir una gemela.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointments_set_updated_at ON public.appointments;

CREATE TRIGGER appointments_set_updated_at
    BEFORE UPDATE ON public.appointments
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

COMMENT ON COLUMN public.appointments.updated_at IS
    'Última escritura sobre la fila. La mantiene el trigger appointments_set_updated_at, NO el código: hay muchos caminos que escriben aquí y uno que se olvide deja una fecha que miente.';

COMMENT ON COLUMN public.appointments.updated_by IS
    'Quién hizo la última escritura: panel:<user uuid> | bot | worker:review | worker:auto-complete. NULL = no consta (escritura anterior a la migración 033 o camino que todavía no lo declara). No lo puede poner el trigger: la conexión es siempre service_role.';

COMMENT ON COLUMN public.appointments.last_change IS
    'Solo el ÚLTIMO cambio, no un historial: { at, by, de:{campo:valor}, a:{campo:valor} }. Responde "¿de qué hora a qué hora la movieron, y quién?" sin una tabla de auditoría aparte.';
