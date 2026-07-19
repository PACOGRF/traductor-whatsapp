-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN 006 — Descartar alertas de "sin responder"
-- El gestor puede quitar manualmente la alerta de una conversación
-- desatendida; reaparece solo si el cliente vuelve a escribir.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS unanswered_dismissed_at TIMESTAMPTZ;
