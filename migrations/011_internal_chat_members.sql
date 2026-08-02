-- Sprint 6: gestión de miembros en chats internos
-- Quién creó el chat (creador + gestores pueden gestionar miembros)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);

-- Permiso de escritura por participante (true = puede escribir, false = solo leer)
ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS can_reply BOOLEAN NOT NULL DEFAULT TRUE;
