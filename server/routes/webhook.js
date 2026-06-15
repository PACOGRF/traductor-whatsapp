const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { translateWithDetection } = require('../services/translate');

router.post('/whatsapp', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { From, Body, MediaUrl0, MediaContentType0 } = req.body;
    const guestPhone = From;

    let conv = await db.get('SELECT * FROM conversations WHERE guest_phone = ?', [guestPhone]);
    if (!conv) {
      await db.run('INSERT INTO conversations (guest_phone, guest_name) VALUES (?, ?)', [guestPhone, guestPhone]);
      conv = await db.get('SELECT * FROM conversations WHERE guest_phone = ?', [guestPhone]);
    }

    const { translatedText, detectedLanguage: detectedLang } = await translateWithDetection(Body || '', 'es');

    if (detectedLang && detectedLang !== conv.guest_language) {
      await db.run('UPDATE conversations SET guest_language = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [detectedLang, conv.id]);
      conv.guest_language = detectedLang;
    }

    await db.run(
      'INSERT INTO messages (conversation_id, direction, original_text, translated_text, language_detected, media_url, media_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [conv.id, 'incoming', Body || '', translatedText, detectedLang, MediaUrl0 || null, MediaContentType0 || null]
    );

    const msg = await db.get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conv.id]);

    if (router.io) {
      router.io.emit('new_message', { conversation: conv, message: msg });
    }

    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
  } catch (err) {
    console.error('Error en webhook:', err);
    res.status(500).send('<Response></Response>');
  }
});

module.exports = router;
