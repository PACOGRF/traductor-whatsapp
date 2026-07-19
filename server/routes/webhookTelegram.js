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

    // ── Archivos adjuntos (fotos, documentos, vídeo, audio): descargar y guardar ──
    const media = extractTelegramMedia(tgMsg);
    if (media) {
      await handleIncomingFile(req.app, company, conv, tgMsg, media, isNewConversation);
      return;
    }

    // Texto del mensaje
    let body = tgMsg.text || '';
    if (!body) return;

    // Los comandos de Telegram (/start, etc.) no son texto del cliente:
    // no se guardan ni se pasan al detector de idioma (falseaba el idioma)
    const isCommand = body.startsWith('/');

    if (!isCommand) {
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
    }

    // Primera vez que escribe: bienvenida en su idioma + botón para compartir
    // contacto, y proponer al gestor guardar el cliente nuevo en fichas
    if (isNewConversation) {
      await sendWelcome(req.app, company, conv);
      await proposeNewClient(req.app, conv);
    }
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

// Cliente nuevo detectado: proponer al gestor guardarlo en fichas
// (con el nombre del perfil; el teléfono llegará si comparte su contacto)
async function proposeNewClient(app, conv) {
  const pending = { name: conv.guest_name || 'Cliente Telegram', phone: null };
  await db.run(
    'UPDATE conversations SET pending_contact = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [JSON.stringify(pending), conv.id]
  );
  const io = app.get('io');
  if (io) io.emit('contact_pending', { conversation_id: conv.id, name: pending.name, phone: null });
  await sendPush(app, { title: '🆕 Cliente nuevo', body: `${pending.name} · ¿Guardar su ficha de cliente?` });
}

// El cliente compartió su contacto (teléfono verificado por Telegram).
// Según el estado: completa su ficha, vincula una existente o actualiza la propuesta.
async function handleSharedContact(app, company, conv, tgMsg) {
  const c = tgMsg.contact;
  // Solo aceptar su PROPIO contacto (no tarjetas de terceros reenviadas)
  if (c.user_id && String(c.user_id) !== String(tgMsg.from.id)) return;

  let phone = (c.phone_number || '').replace(/[\s-]/g, '');
  if (!phone) return;
  if (!phone.startsWith('+')) phone = '+' + phone;

  const realName = [c.first_name, c.last_name].filter(Boolean).join(' ') || conv.guest_name;
  const io = app.get('io');
  const { logAudit } = require('../services/audit');

  // Constancia visible en el hilo
  await db.run(
    'INSERT INTO messages (conversation_id, direction, original_text) VALUES (?, ?, ?)',
    [conv.id, 'incoming', `📱 Contacto compartido: ${realName} — ${phone}`]
  );
  const msg = await db.get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conv.id]);
  if (io) io.emit('new_message', { conversation: conv, message: msg });

  if (conv.contact_id) {
    // La conversación ya tiene ficha: completar el teléfono verificado
    try {
      await db.run('UPDATE contacts SET phone = ? WHERE id = ?', [phone, conv.contact_id]);
    } catch (err) {
      console.warn('⚠️ No se pudo actualizar el teléfono de la ficha:', err.message);
    }
    const ficha = await db.get('SELECT * FROM contacts WHERE id = ?', [conv.contact_id]);
    await logAudit(company.id, null, 'contact_phone_verified',
      { contact_id: conv.contact_id, conversation_id: conv.id, phone });
    if (io && ficha) io.emit('contact_saved', { conversation_id: conv.id, name: ficha.name, phone: ficha.phone });
    await sendPush(app, { title: '📱 Teléfono verificado', body: `${realName} — ${phone}` });
  } else {
    const existing = await db.get(
      'SELECT * FROM contacts WHERE company_id = ? AND phone = ?',
      [company.id, phone]
    );
    if (existing) {
      // Cliente ya conocido: vincular su ficha sin molestar al gestor
      await db.run(
        'UPDATE conversations SET contact_id = ?, pending_contact = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [existing.id, conv.id]
      );
      await logAudit(company.id, null, 'contact_linked',
        { contact_id: existing.id, conversation_id: conv.id, phone });
      if (io) io.emit('contact_saved', { conversation_id: conv.id, name: existing.name, phone: existing.phone });
      await sendPush(app, { title: '📱 Cliente reconocido', body: `${existing.name} — ${existing.phone}` });
    } else {
      // Actualizar la propuesta pendiente con el teléfono y volver a avisar
      await db.run(
        'UPDATE conversations SET pending_contact = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [JSON.stringify({ name: realName, phone }), conv.id]
      );
      await logAudit(company.id, null, 'contact_share_received',
        { conversation_id: conv.id, phone, name: realName });
      if (io) io.emit('contact_pending', { conversation_id: conv.id, name: realName, phone });
      await sendPush(app, { title: '📱 Contacto recibido', body: `${realName} — ${phone} · ¿Crear su ficha de cliente?` });
    }
  }

  // Gracias en su idioma + retirar el botón
  let thanks = '¡Gracias! Hemos guardado su contacto. ¿En qué podemos ayudarle?';
  if (conv.guest_language && conv.guest_language !== 'es') {
    thanks = await translate(thanks, conv.guest_language, 'es');
  }
  await sendMessage(company.telegram_bot_token, conv.guest_phone, thanks, removeKeyboard);
  const thanksMsg = await insertOutgoingMessage(conv.id, '¡Gracias! Hemos guardado su contacto. ¿En qué podemos ayudarle?', thanks);
  if (io) io.emit('message_sent', { conversation: conv, message: thanksMsg });
}

// Detecta el adjunto de un mensaje de Telegram (stickers y otros se ignoran)
function extractTelegramMedia(tgMsg) {
  if (tgMsg.photo && tgMsg.photo.length) {
    const p = tgMsg.photo[tgMsg.photo.length - 1];   // mayor resolución
    return { file_id: p.file_id, size: p.file_size, filename: 'foto_' + Date.now() + '.jpg', mediaType: 'image', mime: 'image/jpeg' };
  }
  if (tgMsg.document) {
    const d = tgMsg.document;
    return { file_id: d.file_id, size: d.file_size, filename: d.file_name || 'documento.pdf', mediaType: null, mime: d.mime_type };
  }
  if (tgMsg.video) {
    return { file_id: tgMsg.video.file_id, size: tgMsg.video.file_size, filename: 'video_' + Date.now() + '.mp4', mediaType: 'video', mime: 'video/mp4' };
  }
  if (tgMsg.voice) {
    return { file_id: tgMsg.voice.file_id, size: tgMsg.voice.file_size, filename: 'audio_' + Date.now() + '.ogg', mediaType: 'audio', mime: 'audio/ogg' };
  }
  if (tgMsg.audio) {
    return { file_id: tgMsg.audio.file_id, size: tgMsg.audio.file_size, filename: tgMsg.audio.file_name || ('audio_' + Date.now() + '.mp3'), mediaType: 'audio', mime: tgMsg.audio.mime_type || 'audio/mpeg' };
  }
  return null;
}

// Descarga el archivo del canal, lo sube a Supabase Storage y lo registra en el hilo
async function handleIncomingFile(app, company, conv, tgMsg, media, isNewConversation) {
  const io = app.get('io');
  const storage = require('../services/storage');
  const { getFile, downloadFile } = require('../services/telegram');
  const caption = tgMsg.caption || '';

  // Mensaje de aviso en el hilo cuando el archivo no se puede guardar
  async function saveNotice(text) {
    await db.run('INSERT INTO messages (conversation_id, direction, original_text) VALUES (?, ?, ?)', [conv.id, 'incoming', text]);
    const m = await db.get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conv.id]);
    if (io) io.emit('new_message', { conversation: conv, message: m });
  }

  const mediaType = media.mediaType || storage.mediaTypeFor(media.filename);
  if (!storage.extensionAllowed(media.filename)) {
    return saveNotice(`📎 [El cliente envió un tipo de archivo no admitido: ${media.filename}]`);
  }
  if (media.size && media.size > storage.MAX_FILE_BYTES) {
    return saveNotice(`📎 [Archivo demasiado grande (máx. 16 MB): ${media.filename}]`);
  }
  if (!storage.storageEnabled()) {
    return saveNotice(`📎 [${media.filename} recibido, pero el almacenamiento de archivos no está configurado]`);
  }

  const info = await getFile(company.telegram_bot_token, media.file_id);
  if (!info.ok || !info.result?.file_path) {
    return saveNotice(`📎 [No se pudo descargar el archivo del canal: ${media.filename}]`);
  }
  const buffer = await downloadFile(company.telegram_bot_token, info.result.file_path);
  if (!buffer) return saveNotice(`📎 [No se pudo descargar el archivo: ${media.filename}]`);
  if (buffer.length > storage.MAX_FILE_BYTES) {
    return saveNotice(`📎 [Archivo demasiado grande (máx. 16 MB): ${media.filename}]`);
  }

  const pathInBucket = `companies/${company.id}/conversations/${conv.id}/${Date.now()}_${storage.safeName(media.filename)}`;
  const up = await storage.uploadBuffer(pathInBucket, buffer, media.mime);
  if (!up.ok) return saveNotice(`📎 [Error guardando ${media.filename}: ${up.error}]`);

  // El pie de foto se traduce como un mensaje normal
  let original = caption || `📎 ${media.filename}`;
  let translated = null, lang = null;
  if (caption) {
    const r = await translateWithDetection(caption, 'es');
    translated = r.translatedText;
    lang = r.detectedLanguage;
    if (lang && lang !== conv.guest_language) {
      await db.run('UPDATE conversations SET guest_language = ? WHERE id = ?', [lang, conv.id]);
      conv.guest_language = lang;
    }
  }

  await db.run(
    'UPDATE conversations SET last_incoming_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [conv.id]
  );
  await db.run(
    `INSERT INTO messages (conversation_id, direction, original_text, translated_text, language_detected, media_url, media_type, storage_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [conv.id, 'incoming', original, translated, lang, media.filename, mediaType, pathInBucket]
  );
  const msg = await db.get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conv.id]);
  msg.signed_url = await storage.signedUrl(pathInBucket);

  if (io) io.emit('new_message', { conversation: conv, message: msg });
  await sendPush(app, {
    title: `✈️ ${conv.guest_name || 'Cliente Telegram'}`,
    body: `📎 ${media.filename}`,
  });

  if (isNewConversation) {
    await sendWelcome(app, company, conv);
    await proposeNewClient(app, conv);
  }
}

module.exports = router;
