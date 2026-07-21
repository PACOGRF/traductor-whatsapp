-- Sprint 5 ext.: confirmacion explicita "leido y entendido" en mensajes internos
ALTER TABLE messages ADD COLUMN IF NOT EXISTS requires_ack BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS message_acks (
  id         SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  company_id INTEGER NOT NULL,
  acked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_acks_msg  ON message_acks(message_id);
CREATE INDEX IF NOT EXISTS idx_msg_acks_user ON message_acks(user_id);
