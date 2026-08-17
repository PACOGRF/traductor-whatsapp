-- Pin y alias para conversaciones (gear menu chats externos)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned_at  TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS nickname   TEXT;
