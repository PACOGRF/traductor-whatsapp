-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN 005 — Tareas 2.0 (Sprint 4)
-- Las columnas principales de tareas ya existen desde la 001.
-- Aquí: control de avisos enviados (para no repetir el push del cron)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS remind_sent_at TIMESTAMPTZ;      -- cuándo se envió el aviso de la alerta

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS unanswered_alerted_at TIMESTAMPTZ; -- cuándo se avisó de "sin responder"

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(company_id, status);
