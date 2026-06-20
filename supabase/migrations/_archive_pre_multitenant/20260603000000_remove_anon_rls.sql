-- Elimina las políticas que permitían lectura sin autenticación (USING (true) para anon).
-- El backend usa service_role_key (que bypasa RLS por diseño), por lo que sigue funcionando.
-- Los realtime channels del dashboard solo notifican cambios; la lectura de datos
-- va ahora a través de la API Express protegida con DASHBOARD_API_SECRET.
--
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run

DROP POLICY IF EXISTS "dashboard_read_leads"    ON leads;
DROP POLICY IF EXISTS "dashboard_read_messages" ON messages;
DROP POLICY IF EXISTS "dashboard_read_config"   ON config;
