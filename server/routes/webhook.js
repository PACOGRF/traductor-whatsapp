const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { detectLanguage, translate } = require('../services/translate');

// Twilio envía los mensajes como form-urlencoded
router.post('/whatsapp', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { From, Body, MediaUrl0, MediaContentType0 } = req.body;
    const guestPhone = From; // ej: "whatsapp:+447911123456"

    // Buscar o crear conversación
    let conv = db.get('SELECT * FROM conversations WHERE guest_phone = ?', [guestPhone]);
    if (!conv) {
      db.run('INSERT INTO conversations (guest_phone, guest_name) VALUES (?, ?)', [guestPhone, guestPhone]);
      conv = db.get('SELECT * FROM conversations WHERE guest_phone = ?', [guestPhone]);
    }

    // Detectar idioma y traducir al español
    const detectedLang = await detectLanguage(Body || '');
    const translatedText = await translate(Body || '', 'es', detectedLang);

    // Guardar idioma del huésped en la conversación
    if (detectedLang && detectedLang !== conv.guest_language) {
      db.run('UPDATE conversations SET guest_language = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [detectedLang, conv.id]);
      conv.guest_language = detectedLang;
    }

    // Guardar mensaje
    db.run(
      'INSERT INTO messages (conversation_id, direction, original_text, translated_text, language_detected, media_url, media_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [conv.id, 'incoming', Body || '', translatedText, detectedLang, MediaUrl0 || null, MediaContentType0 || null]
    );

    const msg = db.get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conv.id]);

    // Avisar al panel del gestor en tiempo real
    if (router.io) {
      router.io.emit('new_message', { conversation: conv, message: msg });
    }

    // Respuesta vacía a Twilio (el gestor responderá manualmente desde el panel)
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
  } catch (err) {
    console.error('Error en webhook:', err);
    res.status(500).send('<Response></Response>');
  }
});

module.exports = router;
