const crypto = require('crypto');

// Cliente mínimo de la Bot API de Telegram (Sprint 1).
// Sin dependencias: usa fetch nativo de Node 18+.

const TG_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

// Llamada genérica a un método de la Bot API. Nunca lanza excepción:
// devuelve { ok, result?, description? }
async function tgCall(botToken, method, payload = {}) {
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: !!data.ok,
      result: data.result,
      description: data.description || (!res.ok ? 'HTTP ' + res.status : undefined),
    };
  } catch (err) {
    return { ok: false, description: 'Error de red: ' + err.message };
  }
}

// Datos del bot (sirve también para validar que el token es correcto)
function getMe(botToken) {
  return tgCall(botToken, 'getMe');
}

// Enviar texto a un chat
function sendMessage(botToken, chatId, text) {
  return tgCall(botToken, 'sendMessage', { chat_id: chatId, text });
}

// Registrar el webhook del bot apuntando a nuestro servidor
function setWebhook(botToken, url, secretToken) {
  return tgCall(botToken, 'setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
}

// Secreto del webhook derivado del token del bot: Telegram lo reenvía en
// cada petición y así verificamos que la llamada es auténtica (sin guardar
// nada extra en la base de datos).
function webhookSecret(botToken) {
  const key = process.env.JWT_SECRET || 'chatlink_secret';
  return crypto.createHmac('sha256', key).update(botToken).digest('hex').slice(0, 48);
}

module.exports = { getMe, sendMessage, setWebhook, webhookSecret };
