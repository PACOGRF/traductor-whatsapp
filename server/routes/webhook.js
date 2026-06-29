const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { translateWithDetection } = require('../services/translate');

// Verificación de webhook para Meta WhatsApp Business API
router.get('/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || 'chatlink_verify';

  if (mode === 'subscribe' && token === verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

router.post('/whatsapp', express.json(), async (req, res) => {
  // Meta requiere respuesta 200 inmediata
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value?.messages?.length) return;

    const metaMsg = value.messages[0];
    const guestPhone = metaMsg.from;
    const Body = metaMsg.text?.body || '';
    const mediaId = metaMsg.image?.id || metaMsg.document?.id || null;
    const mediaType = metaMsg.image ? 'image' : metaMsg.document ? 'document' : null;
    const phoneNumberId = value.metadata?.phone_number_id || null;

    // Nombre del contacto si Meta lo envía
    const contactName = value.contacts?.[0]?.profile?.name || guestPhone;

    let conv = await db.get(
      'SELECT * FROM conversations WHERE guest_phone = ? AND phone_number_id = ?',
      [guestPhone, phoneNumberId]
    );
    if (!conv) {
      await db.run(
        'INSERT INTO conversations (guest_phone, guest_name, phone_number_id) VALUES (?, ?, ?)',
        [guestPhone, contactName, phoneNumberId]
      );
      conv = await db.get(
        'SELECT * FROM conversations WHERE guest_phone = ? AND phone_number_id = ?',
        [guestPhone, phoneNumberId]
      );
    }

    const { translatedText, detectedLanguage: detectedLang } = await translateWithDetection(Body, 'es');

    if (detectedLang && detectedLang !== conv.guest_language) {
      await db.run('UPDATE conversations SET guest_language = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [detectedLang, conv.id]);
      conv.guest_language = detectedLang;
    }

    await db.run(
      'INSERT INTO messages (conversation_id, direction, original_text, translated_text, language_detected, media_url, media_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [conv.id, 'incoming', Body, translatedText, detectedLang, mediaId, mediaType]
    );

    const msg = await db.get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conv.id]);

    if (router.io) {
      // Emitir en la sala del cliente para enrutamiento futuro
      const room = phoneNumberId || 'default';
      router.io.to(room).emit('new_message', { conversation: conv, message: msg });
      router.io.emit('new_message', { conversation: conv, message: msg });
    }
  } catch (err) {
    console.error('Error en webhook Meta:', err);
  }
});

module.exports = router;
