const db = require('../db/db');
const { translate } = require('../services/translate');
const webpush = require('web-push');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:gestor@apartamento.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

async function sendPushNotification(app, payload) {
  const subscription = app.get('pushSubscription');
  if (!subscription || !process.env.VAPID_PUBLIC_KEY) return;
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 410) app.set('pushSubscription', null);
    else console.error('Error push:', err.message);
  }
}

function registerChatHandlers(io, app) {
  io.on('connection', (socket) => {
    console.log('Panel del gestor conectado:', socket.id);

    socket.on('manager_reply', async (data) => {
      const { conversationId, text, langOverride } = data;

      try {
        const conv = await db.get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
        if (!conv) return socket.emit('error', { msg: 'Conversación no encontrada' });

        let translatedText;
        if (langOverride === 'none') {
          translatedText = text;
        } else {
          const targetLang = (langOverride && langOverride !== 'auto') ? langOverride : (conv.guest_language || 'en');
          translatedText = await translate(text, targetLang, 'es');
        }

        await db.run(
          'INSERT INTO messages (conversation_id, direction, original_text, translated_text, language_detected) VALUES (?, ?, ?, ?, ?)',
          [conversationId, 'outgoing', text, translatedText, 'es']
        );

        const msg = await db.get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conversationId]);

        io.emit('message_sent', { conversation: conv, message: msg });

        sendPushNotification(app, {
          title: `Respuesta enviada a ${conv.guest_name || conv.guest_phone}`,
          body: msg.translated_text || msg.original_text,
          phone: conv.guest_phone,
        });

        if (process.env.TWILIO_ACCOUNT_SID && !process.env.TWILIO_ACCOUNT_SID.includes('xxx')) {
          const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await twilio.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: conv.guest_phone,
            body: translatedText,
          });
        } else {
          console.log(`[DEMO] Enviaría a ${conv.guest_phone}: "${translatedText}"`);
        }
      } catch (err) {
        console.error('Error al enviar respuesta:', err);
        socket.emit('error', { msg: err.message });
      }
    });

    socket.on('disconnect', () => {
      console.log('Panel del gestor desconectado:', socket.id);
    });
  });
}

module.exports = registerChatHandlers;
