-- Enable REPLICA IDENTITY FULL on tables used with Supabase Realtime filters
-- Required for filters on non-PK columns (organization_id, conversation_id) to work
ALTER TABLE contacts REPLICA IDENTITY FULL;
ALTER TABLE conversations REPLICA IDENTITY FULL;
ALTER TABLE messages REPLICA IDENTITY FULL;
