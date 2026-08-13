-- Sprint 6: áreas notificadas por comunicado/tarea
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS notify_areas JSONB;
