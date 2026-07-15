const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { translate, translateWithDetection } = require('../services/translate');
const { webhookSecret, sendMessage, shareContactKeyboard, removeKeyboard } = require('../services/telegram');
const { insertOutgoingMessage } = require('../services/messaging');
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

    // Buscar o crear la conversación de este chat de Telegram
    let conv = await db.get(
      "SELECT * FROM conversations WHERE guest_phone = ? AND channel = 'telegram' AND company_id = ?",
      [chatId, companyId]
    );
    let isNewConversation = false;
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
      isNewConversation = true;
    }

    // ── El cliente pulsó "compartir mi contacto": crear su ficha automáticamente ──
    if (tgMsg.contact) {
      await handleSharedContact(req.app, company, conv, tgMsg);
      return;
    }

    // Texto del mensaje; si es un archivo/foto, aviso hasta que llegue el Sprint 5
    let body = tgMsg.text || tgMsg.caption || '';
    const hasMedia = !!(tgMsg.photo || tgMsg.document || tgMsg.video || tgMsg.voice || tgMsg.audio || tgMsg.sticker);
    if (!body && hasMedia) {
      body = '📎 [El cliente envió un archivo — la recepción de archivos llegará en una próxima versión]';
    }
    if (!body) return;

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

    // Primera vez que escribe: bienvenida en su idioma + botón para compartir contacto
    if (isNewConversation) await sendWelcome(req.app, company, conv);
  } catch (err) {
    console.error('Error en webhook Telegram:', err);
  }
});

// Mensaje de bienvenida automático con el botón "compartir mi contacto".
// Se envía en el idioma detectado del cliente y queda registrado en el hilo.
async function sendWelcome(app, company, conv) {
  try {
    const textEs = `¡Bienvenido/a a ${company.name}! 😊 Le atenderemos enseguida. Para darle un mejor servicio, puede compartir su número de teléfono con el botón de abajo (es opcional).`;
    const btnEs = '📱 Compartir mi contacto';

    let text = textEs, btn = btnEs;
    const lang = conv.guest_language;
    if (lang && lang !== 'es') {
      text = await translate(textEs, lang, 'es');
      btn = await translate(btnEs, lang, 'es');
    }

    const r = await sendMessage(company.telegram_bot_token, conv.guest_phone, text, shareContactKeyboard(btn));
    if (!r.ok) return console.error('⚠️ No se pudo enviar la bienvenida Telegram:', r.description);

    const msg = await insertOutgoingMessage(conv.id, textEs, text);
    const io = app.get('io');
    if (io) io.emit('message_sent', { conversation: conv, message: msg });
  } catch (err) {
    console.error('Error enviando bienvenida Telegram:', err.message);
  }
}

// El cliente compartió su contacto: crear/vincular su ficha (tabla contacts),
// avisar al panel y darle las gracias retirando el botón.
async function handleSharedContact(app, company, conv, tgMsg) {
  const c = tgMsg.contact;
  // Solo aceptar su PROPIO contacto (no tarjetas de terceros reenviadas)
  if (c.user_id && String(c.user_id) !== String(tgMsg.from.id)) return;

  let phone = (c.phone_number || '').replace(/[\s-]/g, '');
  if (!phone) return;
  if (!phone.startsWith('+')) phone = '+' + phone;

  const realName = [c.first_name, c.last_name].filter(Boolean).join(' ') || conv.guest_name;

  // Ficha: buscar por teléfono; si no existe, crearla con los datos verificados
  let contact = await db.get(
    'SELECT * FROM contacts WHERE company_id = ? AND phone = ?',
    [company.id, phone]
  );
  let created = false;
  if (!contact) {
    await db.run(
      'INSERT INTO contacts (company_id, phone, name) VALUES (?, ?, ?)',
      [company.id, phone, realName]
    );
    contact = await db.get('SELECT * FROM contacts WHERE company_id = ? AND phone = ?', [company.id, phone]);
    created = true;
  }

  await db.run(
    'UPDATE conversations SET contact_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [contact.id, conv.id]
  );

  const { logAudit } = require('../services/audit');
  await logAudit(company.id, null, created ? 'contact_autocreated' : 'contact_linked',
    { contact_id: contact.id, conversation_id: conv.id, phone, name: realName });

  // Constancia visible en el hilo
  await db.run(
    'INSERT INTO messages (conversation_id, direction, original_text) VALUES (?, ?, ?)',
    [conv.id, 'incoming', `📱 Contacto compartido: ${realName} — ${phone}`]
  );
  const msg = await db.get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conv.id]);

  const io = app.get('io');
  if (io) {
    io.emit('new_message', { conversation: conv, message: msg });
    io.emit('contact_saved', { conversation_id: conv.id, name: realName, phone });
  }
  await sendPush(app, { title: '🆕 Nuevo cliente guardado', body: `${realName} — ${phone}` });

  // Gracias en su idioma + retirar el botón
  let thanks = '¡Gracias! Hemos guardado su contacto. ¿En qué podemos ayudarle?';
  if (conv.guest_language && conv.guest_language !== 'es') {
    thanks = await translate(thanks, conv.guest_language, 'es');
  }
  await sendMessage(company.telegram_bot_token, conv.guest_phone, thanks, removeKeyboard);
  const thanksMsg = await insertOutgoingMessage(conv.id, '¡Gracias! Hemos guardado su contacto. ¿En qué podemos ayudarle?', thanks);
  if (io) io.emit('message_sent', { conversation: conv, message: thanksMsg });
}

module.exports = router;
