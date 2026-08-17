-- Pin por usuario (cada usuario fija sus propios chats)
CREATE TABLE IF NOT EXISTS user_conversation_pins (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  pinned_at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, conversation_id)
);
-- El campo global pinned_at de conversations ya no se usa (queda por compatibilidad)
