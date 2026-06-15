CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  guest_phone TEXT NOT NULL UNIQUE,
  guest_name TEXT,
  guest_language TEXT DEFAULT 'en',
  apartment TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
  original_text TEXT NOT NULL,
  translated_text TEXT,
  language_detected TEXT,
  media_url TEXT,
  media_type TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quick_replies (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  message_es TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

INSERT INTO quick_replies (id, title, message_es, sort_order) VALUES
  (1, 'Bienvenida', '¡Bienvenido/a al apartamento! Espero que disfrute su estancia.', 1),
  (2, 'Código de acceso', 'El código del edificio es 1234 y el de la habitación es 5678.', 2),
  (3, 'WiFi', 'La red WiFi es "ApartamentoXYZ" y la contraseña es "wifi2024".', 3),
  (4, 'Check-out', 'El check-out es a las 11:00h. Por favor deje las llaves en la mesa.', 4),
  (5, 'Web de reservas', 'Puede gestionar su reserva en: https://tu-web.com/reservas', 5)
ON CONFLICT (id) DO NOTHING;
