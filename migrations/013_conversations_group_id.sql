-- Segmentación por departamento: grupo asignado directamente a la conversación
-- (complementa contact_group_id que se infiere del contacto vinculado)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES contact_groups(id);
CREATE INDEX IF NOT EXISTS idx_conversations_group_id ON conversations(group_id);
