-- Gestión de avisos vencidos: CONFORME / PENDIENTE
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS alert_ack_status TEXT;      -- 'conforme' | 'pendiente' | NULL
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS alert_ack_by    INTEGER REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS alert_ack_at    TIMESTAMPTZ;
