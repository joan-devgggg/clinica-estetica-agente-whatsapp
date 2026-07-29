-- Yulia sustituye al admin de Telegram de Sante (2026-07-29).
-- Ya aplicada en la BD remota vía services/db.js (setConfigValue); este fichero la deja
-- versionada en el repo. Solo Sante, no afecta a San Remo (su telegram_admins sigue en '[]').
-- Idempotente.
UPDATE config
SET valor = '[5344724990]', updated_at = now()
WHERE organization_id = 'b2c3d4e5-f6a7-8901-bcde-f12345678901'
  AND clave = 'telegram_admins';
