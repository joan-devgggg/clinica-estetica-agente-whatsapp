-- Enable realtime for agenda-related tables so the dashboard
-- auto-refreshes when appointments, blocks, or blocked days change.
ALTER PUBLICATION supabase_realtime ADD TABLE appointments;
ALTER PUBLICATION supabase_realtime ADD TABLE schedule_blocks;
ALTER PUBLICATION supabase_realtime ADD TABLE blocked_days;
