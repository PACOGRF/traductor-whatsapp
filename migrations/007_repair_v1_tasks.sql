-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN 007 — Reparar tareas antiguas (creadas antes de Tareas 2.0)
-- Las tareas v1 guardaban solo el mensaje (msg_id) pero no la conversación:
-- se vinculan ahora para que aparezcan dentro de su chat.
-- ═══════════════════════════════════════════════════════════════

-- El mensaje anclado es el msg_id antiguo
UPDATE tasks SET anchored_message_id = msg_id
  WHERE anchored_message_id IS NULL AND msg_id IS NOT NULL;

-- La conversación se deduce del mensaje anclado
UPDATE tasks SET conversation_id = m.conversation_id
  FROM messages m
  WHERE tasks.conversation_id IS NULL AND tasks.anchored_message_id = m.id;

-- Y la ficha del cliente, de la conversación
UPDATE tasks SET contact_id = c.contact_id
  FROM conversations c
  WHERE tasks.contact_id IS NULL AND tasks.conversation_id = c.id;

UPDATE tasks SET company_id = 1 WHERE company_id IS NULL;
