const db = require('../db/db');
const { translate } = require('./translate');

// Lógica de envío compartida entre el panel (Socket.io) y el cron
// de mensajes programados. Extraída de chatHandler.js sin cambiar
// su comportamiento.

// Traduce el texto en español al idioma del huésped (o al forzado)
async function translateOutgoing(conv, text, langOverride) {
  if (langOverride === 'none') return text;
  const targetLang = (langOverride && langOverride !== 'auto')
    ? langOverride
    : (conv.guest_language || 'en');
  return translate(text, targetLang, 'es');
}

// Guarda el mensaje saliente en la BD y lo devuelve
async function insertOutgoingMessage(conversationId, originalText, translatedText, senderUserId = null) {
  await db.run(
    'INSERT INTO messages (conversation_id, direction, original_text, translated_text, language_detected, sender_user_id) VALUES (?, ?, ?, ?, ?, ?)',
    [conversationId, 'outgoing', originalText, translatedText, 'es', senderUserId]
  );
  // Marca de respuesta: apaga la alerta de "conversación sin responder"
  await db.run(
    'UPDATE conversations SET last_outgoing_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [conversationId]
  );
  return db.get(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1',
    [conversationId]
  );
}

// Envía el texto por el canal de la conversación.
// Devuelve { ok, demo?, error? } — nunca lanza excepción.
async function sendViaChannel(conv, translatedText, phoneNumberId = null) {
  // ── Telegram: enviar con el bot de la empresa ──
  if (conv.channel === 'telegram') {
    const { sendMessage } = require('./telegram');
    const company = await db.get(
      'SELECT telegram_bot_token FROM companies WHERE id = ?',
      [conv.company_id || 1]
    );
    if (!company || !company.telegram_bot_token) {
      return { ok: false, error: 'Telegram no está configurado para esta empresa' };
    }
    const r = await sendMessage(company.telegram_bot_token, conv.guest_phone, translatedText);
    return r.ok
      ? { ok: true }
      : { ok: false, error: 'Telegram: ' + (r.description || 'error desconocido') };
  }

  const resolvedPhoneNumberId = phoneNumberId || conv.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;

  // Sin credenciales de Meta: modo demo (se simula el envío)
  if (!resolvedPhoneNumberId || !process.env.WHATSAPP_ACCESS_TOKEN) {
    console.log(`[DEMO] Enviaría a ${conv.guest_phone}: "${translatedText}"`);
    return { ok: true, demo: true };
  }

  try {
    const url = `https://graph.facebook.com/v19.0/${resolvedPhoneNumberId}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: conv.guest_phone,
        type: 'text',
        text: { body: translatedText },
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      // El error típico aquí es la ventana de 24h de Meta (código 131047)
      const reason = err?.error?.message || ('Error Meta API (HTTP ' + response.status + ')');
      return { ok: false, error: reason, raw: err };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'Error de red al enviar: ' + err.message };
  }
}

// Envía un archivo (mediante URL firmada) por el canal de la conversación
async function sendFileViaChannel(conv, fileUrl, mediaType, caption = null) {
  if (conv.channel === 'telegram') {
    const { sendFile } = require('./telegram');
    const company = await db.get('SELECT telegram_bot_token FROM companies WHERE id = ?', [conv.company_id || 1]);
    if (!company || !company.telegram_bot_token) {
      return { ok: false, error: 'Telegram no está configurado para esta empresa' };
    }
    const r = await sendFile(company.telegram_bot_token, conv.guest_phone, fileUrl, mediaType, caption);
    return r.ok ? { ok: true } : { ok: false, error: 'Telegram: ' + (r.description || 'error desconocido') };
  }
  // WhatsApp: el envío de archivos se activará con WhatsApp (Sprint 6). En demo se simula.
  if (!process.env.WHATSAPP_ACCESS_TOKEN) {
    console.log(`[DEMO] Enviaría archivo a ${conv.guest_phone}: ${fileUrl}`);
    return { ok: true, demo: true };
  }
  return { ok: false, error: 'El envío de archivos por WhatsApp llegará al activar WhatsApp' };
}

module.exports = { translateOutgoing, insertOutgoingMessage, sendViaChannel, sendFileViaChannel };
