-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN 004 — Teléfono opcional en fichas de clientes
-- En Telegram el bot no conoce el teléfono del cliente: la ficha
-- puede crearse solo con el nombre y completarse después si el
-- cliente comparte su contacto.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;
