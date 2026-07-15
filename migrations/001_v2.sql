-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN 001 — ChatLink 2.0 (Sprint 0)
-- Crea las tablas nuevas del esquema v2 y amplía las existentes.
-- Idempotente: puede ejecutarse más de una vez sin romper nada.
-- ═══════════════════════════════════════════════════════════════

-- ═══════════ NUEVAS TABLAS ═══════════

-- Empresas (multi-tenant real)
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  plan VARCHAR(20) DEFAULT 'starter',        -- starter / pro / business
  active BOOLEAN DEFAULT true,
  alert_hours INTEGER DEFAULT 4,             -- horas sin respuesta para alerta automática
  telegram_bot_token VARCHAR(100),           -- bot de Telegram del cliente
  whatsapp_phone_number_id VARCHAR(50),      -- se rellenará cuando Meta desbloquee
  whatsapp_access_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Puestos de trabajo normalizados (D3)
CREATE TABLE IF NOT EXISTS positions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  name VARCHAR(80) NOT NULL,
  UNIQUE(company_id, name)
);

-- Usuarios/empleados (D1, D5)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  first_name VARCHAR(60) NOT NULL,
  last_name VARCHAR(120) NOT NULL DEFAULT '',
  position_id INTEGER REFERENCES positions(id),
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,       -- bcrypt SIEMPRE
  role VARCHAR(20) DEFAULT 'employee',       -- manager / supervisor / employee
  must_change_password BOOLEAN DEFAULT true, -- forzar cambio en primer login
  failed_attempts INTEGER DEFAULT 0,
  locked_until TIMESTAMPTZ,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Grupos de clientes (D2)
CREATE TABLE IF NOT EXISTS contact_groups (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  name VARCHAR(80) NOT NULL,
  UNIQUE(company_id, name)
);

-- Contactos/clientes
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  phone VARCHAR(30) NOT NULL,
  name VARCHAR(100) NOT NULL,
  company_name VARCHAR(120),                 -- empresa del contacto
  group_id INTEGER REFERENCES contact_groups(id),
  preferred_language VARCHAR(10),            -- aprovecha la traducción
  permanent_notes TEXT,                      -- notas permanentes del cliente
  deleted_at TIMESTAMPTZ,                    -- borrado lógico
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, phone)
);

-- Visibilidad: qué grupos ve cada empleado (D2)
CREATE TABLE IF NOT EXISTS user_group_visibility (
  user_id INTEGER REFERENCES users(id),
  group_id INTEGER REFERENCES contact_groups(id),
  can_reply BOOLEAN DEFAULT true,            -- true: leer+responder / false: solo leer
  PRIMARY KEY (user_id, group_id)
);

-- Excepciones individuales de visibilidad (uso puntual)
CREATE TABLE IF NOT EXISTS user_contact_exceptions (
  user_id INTEGER REFERENCES users(id),
  contact_id INTEGER REFERENCES contacts(id),
  access VARCHAR(10) NOT NULL,               -- 'grant' / 'deny'
  PRIMARY KEY (user_id, contact_id)
);

-- Notas internas ancladas a mensajes (D8)
CREATE TABLE IF NOT EXISTS message_notes (
  id SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id),
  user_id INTEGER REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Log de auditoría (D5)
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  user_id INTEGER REFERENCES users(id),
  action VARCHAR(50) NOT NULL,               -- login / login_failed / permission_change / user_created / etc.
  detail JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════ MODIFICAR TABLAS EXISTENTES ═══════════

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id),
  ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES contacts(id),
  ADD COLUMN IF NOT EXISTS channel VARCHAR(20) DEFAULT 'whatsapp',   -- whatsapp / telegram / internal
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'open',        -- open / closed
  ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS last_incoming_at TIMESTAMPTZ,             -- para alerta "sin responder"
  ADD COLUMN IF NOT EXISTS last_outgoing_at TIMESTAMPTZ;

-- Participantes de conversaciones internas (D7: 1-a-1 y grupos)
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id INTEGER REFERENCES conversations(id),
  user_id INTEGER REFERENCES users(id),
  PRIMARY KEY (conversation_id, user_id)
);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sender_user_id INTEGER REFERENCES users(id),  -- quién del equipo envió
  ADD COLUMN IF NOT EXISTS storage_path TEXT;                            -- ruta en Supabase Storage

-- Tareas: rediseño ampliado (D4, D10)
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id),
  ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES contacts(id),
  ADD COLUMN IF NOT EXISTS conversation_id INTEGER REFERENCES conversations(id),
  ADD COLUMN IF NOT EXISTS anchored_message_id INTEGER REFERENCES messages(id), -- LA CHINCHETA
  ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS notify_also INTEGER[],                   -- otros usuarios a avisar
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending',    -- pending / in_progress / done
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_changed_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS high_priority BOOLEAN DEFAULT false,     -- círculo rojo
  ADD COLUMN IF NOT EXISTS remind_at TIMESTAMPTZ,                   -- alerta (aviso)
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ,                      -- fecha límite (compromiso, D10)
  ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;                  -- borrado lógico (D4)

ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);

-- ═══════════ DATOS INICIALES Y BACKFILL ═══════════

-- Empresa 1 = Tecorem (instancia de pruebas). Los datos v1 existentes pasan a ella.
INSERT INTO companies (id, name, plan)
  VALUES (1, 'Tecorem', 'starter')
  ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('companies', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM companies), 1));

UPDATE conversations SET company_id = 1 WHERE company_id IS NULL;
UPDATE tasks         SET company_id = 1 WHERE company_id IS NULL;
UPDATE quick_replies SET company_id = 1 WHERE company_id IS NULL;

-- Índices útiles para las consultas más frecuentes
CREATE INDEX IF NOT EXISTS idx_conversations_company ON conversations(company_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_company         ON tasks(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_company         ON audit_log(company_id, created_at);
