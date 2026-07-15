const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { translateWithDetection } = require('../services/translate');
const { webhookSecret } = require('../services/telegram');
const webpush = require('web-push');

// Aviso push al gestor (misma suscripción que el resto de la app)
async function sendPush(app, payload) {
  const sub = app && app.get('pushSubscription');
  if (!sub || !process.env.VAPID_PUBLIC_KEY) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 410) app.set('pushSubscription', null);
  }
}

// Webhook de la Bot API de Telegram — una URL por empresa cliente
router.post('/telegram/:companyId', express.json(), async (req, res) => {
  // Telegram espera 200 rápido; el procesado sigue después
  res.sendStatus(200);

  try {
    const companyId = Number(req.params.companyId);
    if (!companyId) return;

    const company = await db.get(
      'SELECT * FROM companies WHERE id = ? AND active = true',
      [companyId]
    );
    if (!company || !company.telegram_bot_token) return;

    // Verificar autenticidad: Telegram reenvía el secreto que le dimos en setWebhook
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (secret !== webhookSecret(company.telegram_bot_token)) {
      console.warn('⚠️ Webhook Telegram: secreto inválido (empresa ' + companyId + ')');
      return;
    }

    const tgMsg = req.body?.message;
    // Solo mensajes de personas en chat privado (ni bots, ni grupos, ni ediciones)
    if (!tgMsg || tgMsg.from?.is_bot || tgMsg.chat?.type !== 'private') return;

    const chatId = String(tgMsg.chat.id);
    const from = tgMsg.from || {};
    const contactName = [from.first_name, from.last_name].filter(Boolean).join(' ')
      || from.username || chatId;

    // Texto del mensaje; si es un archivo/foto, aviso hasta que llegue el Sprint 5
    let body = tgMsg.text || tgMsg.caption || '';
    const hasMedia = !!(tgMsg.photo || tgMsg.document || tgMsg.video || tgMsg.voice || tgMsg.audio || tgMsg.sticker);
    if (!body && hasMedia) {
      body = '📎 [El cliente envió un archivo — la recepción de archivos llegará en una próxima versión]';
    }
    if (!body) return;

    // Buscar o crear la conversación de este chat de Telegram
    let conv = await db.get(
      "SELECT * FROM conversations WHERE guest_phone = ? AND channel = 'telegram' AND company_id = ?",
      [chatId, companyId]
    );
    if (!conv) {
      await db.run(
        `INSERT INTO conversations (guest_phone, guest_name, guest_language, channel, company_id)
         VALUES (?, ?, ?, 'telegram', ?)`,
        [chatId, contactName, from.language_code || 'en', companyId]
      );
      conv = await db.get(
        "SELECT * FROM conversations WHERE guest_phone = ? AND channel = 'telegram' AND company_id = ?",
        [chatId, companyId]
      );
    }

    // Mismo flujo que WhatsApp: detectar idioma → traducir al español
    const { translatedText, detectedLanguage: detectedLang } = await translateWithDetection(body, 'es');

    if (detectedLang && detectedLang !== conv.guest_language) {
      await db.run(
        'UPDATE conversations SET guest_language = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [detectedLang, conv.id]
      );
      conv.guest_language = detectedLang;
    }
    await db.run(
      'UPDATE conversations SET last_incoming_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [conv.id]
    );

    await db.run(
      'INSERT INTO messages (conversation_id, direction, original_text, translated_text, language_detected) VALUES (?, ?, ?, ?, ?)',
      [conv.id, 'incoming', body, translatedText, detectedLang]
    );
    const msg = await db.get(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1',
      [conv.id]
    );

    const io = req.app.get('io');
    if (io) io.emit('new_message', { conversation: conv, message: msg });

    await sendPush(req.app, {
      title: `✈️ ${conv.guest_name || 'Cliente Telegram'}`,
      body: msg.translated_text || msg.original_text,
    });
  } catch (err) {
    console.error('Error en webhook Telegram:', err);
  }
});

module.exports = router;
