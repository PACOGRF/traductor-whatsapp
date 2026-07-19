const db = require('../db/db');
const { translateOutgoing, insertOutgoingMessage, sendViaChannel } = require('../services/messaging');
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

    socket.on('join_room', (phoneNumberId) => {
      if (phoneNumberId) socket.join(phoneNumberId);
    });

    socket.on('manager_reply', async (data) => {
      const { conversationId, text, langOverride, phoneNumberId } = data;

      try {
        const conv = await db.get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
        if (!conv) return socket.emit('error', { msg: 'Conversación no encontrada' });

        // Permisos por rol (Sprint 2): los empleados solo responden donde tienen permiso
        const { accessForConversation } = require('../services/visibility');
        const { access } = await accessForConversation(socket.user, conversationId);
        if (access !== 'reply') {
          return socket.emit('error', { msg: 'No tienes permiso para responder en esta conversación' });
        }

        const translatedText = await translateOutgoing(conv, text, langOverride);
        const msg = await insertOutgoingMessage(conversationId, text, translatedText, socket.user?.user_id || null);

        io.emit('message_sent', { conversation: conv, message: msg });

        sendPushNotification(app, {
          title: `Respuesta enviada a ${conv.guest_name || conv.guest_phone}`,
          body: msg.translated_text || msg.original_text,
          phone: conv.guest_phone,
        });

        const result = await sendViaChannel(conv, translatedText, phoneNumberId);
        if (!result.ok) console.error('Error Meta API:', result.error);
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
