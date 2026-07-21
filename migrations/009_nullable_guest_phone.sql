-- Sprint 5: guest_phone nullable para permitir conversaciones internas sin teléfono
ALTER TABLE conversations ALTER COLUMN guest_phone DROP NOT NULL;
