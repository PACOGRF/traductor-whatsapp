-- Eliminación suave de conversaciones internas
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
