-- ============================================================
-- 000_drop_legacy.sql — Elimina el esquema antiguo de la clínica
-- (leads, messages, config con estructura pre-multitenant)
-- para dejar paso al esquema multi-tenant de 001_schema.sql.
-- Tablas casi vacías (leads: 0, config: 0, messages: 1 fila).
-- ============================================================

DROP TABLE IF EXISTS leads CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS config CASCADE;
