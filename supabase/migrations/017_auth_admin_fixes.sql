-- 017_auth_admin_fixes.sql
--
-- Dos arreglos sobre la gestión de usuarios del dashboard (Supabase Auth):
--
-- 1) REPARACIÓN DE DATOS. GoTrue (el servicio Auth) escanea columnas de token de
--    auth.users como texto NO nulo. Filas creadas por magic-link / generateLink
--    (dev-login) las dejan en NULL, y entonces el endpoint admin /admin/users
--    (usado por admin.listUsers) revienta con:
--      "Scan error on column ... confirmation_token: converting NULL to string is unsupported"
--    → "500: Database error finding users". Ponemos '' (el valor que GoTrue
--    espera) en las filas afectadas. No borra ni cambia ningún usuario.
--
-- 2) RPC auth_user_id_by_email. Permite al script create-dashboard-user.js buscar
--    el id de un usuario por email con una query específica, SIN depender de
--    admin.listUsers (que fallaba globalmente por lo anterior). security definer
--    para poder leer auth.users; ejecución restringida a service_role.

-- ── 1) Reparación de tokens NULL ────────────────────────────────────────────
UPDATE auth.users
   SET confirmation_token         = COALESCE(confirmation_token, ''),
       recovery_token             = COALESCE(recovery_token, ''),
       email_change               = COALESCE(email_change, ''),
       email_change_token_new     = COALESCE(email_change_token_new, ''),
       email_change_token_current = COALESCE(email_change_token_current, ''),
       phone_change               = COALESCE(phone_change, ''),
       phone_change_token         = COALESCE(phone_change_token, ''),
       reauthentication_token     = COALESCE(reauthentication_token, '')
 WHERE confirmation_token IS NULL OR recovery_token IS NULL OR email_change IS NULL
    OR email_change_token_new IS NULL OR email_change_token_current IS NULL
    OR phone_change IS NULL OR phone_change_token IS NULL OR reauthentication_token IS NULL;

-- ── 2) Búsqueda de id por email (query específica, no listUsers) ─────────────
CREATE OR REPLACE FUNCTION public.auth_user_id_by_email(p_email text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT id FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
$$;

-- Solo service_role (el backend / scripts) puede ejecutarla; nunca anon/authenticated.
REVOKE ALL ON FUNCTION public.auth_user_id_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_user_id_by_email(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_user_id_by_email(text) TO service_role;
