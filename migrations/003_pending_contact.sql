-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN 003 — Contacto compartido pendiente de confirmar
-- Cuando un cliente comparte su contacto por Telegram, los datos
-- quedan aquí hasta que el gestor decide si crear la ficha o no.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS pending_contact JSONB;   -- { name, phone } propuestos
