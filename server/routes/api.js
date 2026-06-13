const express = require('express');
const router = express.Router();
const db = require('../db/db');
const webpush = require('web-push');

async function sendPush(app, payload) {
  const sub = app.get('pushSubscription');
  if (!sub || !process.env.VAPID_PUBLIC_KEY) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 410) app.set('pushSubscription', null);
  }
}

// Listar todas las conversaciones
router.get('/conversations', (req, res) => {
  const rows = db.all(`
    SELECT c.*,
      (SELECT m.translated_text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
      (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_at
    FROM conversations c
    ORDER BY last_message_at DESC
  `);
  res.json(rows);
});

// Mensajes de una conversación
router.get('/conversations/:id/messages', (req, res) => {
  const rows = db.all(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    [req.params.id]
  );
  res.json(rows);
});

// Respuestas rápidas
router.get('/quick-replies', (req, res) => {
  const rows = db.all('SELECT * FROM quick_replies WHERE active = 1 ORDER BY sort_order ASC');
  res.json(rows);
});

// Crear plantilla nueva
router.post('/quick-replies', (req, res) => {
  const { title, message_es } = req.body;
  if (!title || !message_es) return res.status(400).json({ error: 'Título y mensaje requeridos' });
  db.run('INSERT INTO quick_replies (title, message_es, sort_order) VALUES (?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM quick_replies))', [title, message_es]);
  const row = db.get('SELECT * FROM quick_replies ORDER BY id DESC LIMIT 1');
  res.json(row);
});

// Actualizar plantilla
router.put('/quick-replies/:id', (req, res) => {
  const { title, message_es } = req.body;
  db.run('UPDATE quick_replies SET title = ?, message_es = ? WHERE id = ?', [title, message_es, req.params.id]);
  res.json({ ok: true });
});

// Eliminar plantilla
router.delete('/quick-replies/:id', (req, res) => {
  db.run('DELETE FROM quick_replies WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// Crear conversación de demo
router.post('/demo/message', async (req, res) => {
  const { phone, name, text, language } = req.body;
  const { translateWithDetection } = require('../services/translate');

  let conv = db.get('SELECT * FROM conversations WHERE guest_phone = ?', [phone]);
  if (!conv) {
    db.run(
      'INSERT INTO conversations (guest_phone, guest_name, guest_language) VALUES (?, ?, ?)',
      [phone, name || 'Huésped Demo', language || 'en']
    );
    conv = db.get('SELECT * FROM conversations WHERE guest_phone = ?', [phone]);
  }

  const { translatedText: translated, detectedLanguage: detectedLang } = await translateWithDetection(text, 'es');

  db.run(
    'INSERT INTO messages (conversation_id, direction, original_text, translated_text, language_detected) VALUES (?, ?, ?, ?, ?)',
    [conv.id, 'incoming', text, translated, detectedLang]
  );

  const msg = db.get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conv.id]);

  // Emitir por Socket.io si está disponible
  if (req.app.get('io')) {
    req.app.get('io').emit('new_message', { conversation: conv, message: msg });
  }

  // Notificación push al gestor
  await sendPush(req.app, {
    title: `💬 ${conv.guest_name || conv.guest_phone}`,
    body: msg.translated_text || msg.original_text,
    phone: conv.guest_phone,
  });

  res.json({ conversation: conv, message: msg });
});

// URL de reservas (para el botón de copia rápida)
router.get('/booking-url', (req, res) => {
  res.json({ url: process.env.BOOKING_URL || 'https://tu-web.com/reservas' });
});

// Clave pública VAPID (el cliente la necesita para suscribirse)
router.get('/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || '' });
});

// Guardar suscripción push del gestor
router.post('/push-subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Suscripción inválida' });
  // Guardamos en memoria (en producción iría a la BD)
  req.app.set('pushSubscription', subscription);
  res.json({ ok: true });
});

// Eliminar suscripción push
router.post('/push-unsubscribe', (req, res) => {
  req.app.set('pushSubscription', null);
  res.json({ ok: true });
});

module.exports = router;
