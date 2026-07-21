-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN 008 — Chat interno + Trazabilidad de lectura (Sprint 5)
-- conversation_participants ya existe (001); channel='internal' ya en conversations
-- ═══════════════════════════════════════════════════════════════

-- Índices en conversation_participants (pueden no existir aún)
CREATE INDEX IF NOT EXISTS idx_conv_parts_conv ON conversation_participants(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_parts_user ON conversation_participants(user_id);

-- Trazabilidad de lectura de mensajes (todos los chats, lado empleado)
CREATE TABLE IF NOT EXISTS message_reads (
  id         SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  company_id INTEGER NOT NULL,
  read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_reads_msg  ON message_reads(message_id);
CREATE INDEX IF NOT EXISTS idx_msg_reads_user ON message_reads(user_id);

-- Confirmaciones de lectura obligatoria en tareas
CREATE TABLE IF NOT EXISTS task_confirmations (
  id           SERIAL PRIMARY KEY,
  task_id      INTEGER NOT NULL REFERENCES tasks(id)  ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  company_id   INTEGER NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(task_id, user_id)
);

-- Columnas de confirmación en tareas
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS requires_confirmation BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS confirm_user_ids INTEGER[];   -- IDs de usuarios obligados a confirmar

-- Nombre del chat interno en conversations
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS internal_name TEXT;           -- "Chat con María, Juan..."
