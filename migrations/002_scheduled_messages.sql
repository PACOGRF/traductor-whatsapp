-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN 002 — Mensajes programados
-- Un mensaje escrito en español que se traduce y envía automáticamente
-- a la hora indicada (cron cada 5 minutos).
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  created_by INTEGER REFERENCES users(id),
  text_es TEXT NOT NULL,                       -- texto en español; se traduce al enviar
  lang_override VARCHAR(10),                   -- igual que el selector de envío (auto/none/en/…)
  storage_path TEXT,                           -- adjunto opcional (se usará con Sprint 5)
  send_at TIMESTAMPTZ NOT NULL,                -- fecha/hora programada de envío
  status VARCHAR(20) DEFAULT 'pending',        -- pending / sent / cancelled / failed
  fail_reason TEXT,                            -- motivo si status = failed
  sent_message_id INTEGER REFERENCES messages(id),  -- mensaje real creado al enviarse
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_pending
  ON scheduled_messages(status, send_at);
