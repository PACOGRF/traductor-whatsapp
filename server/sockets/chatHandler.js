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

async function sendPushToUsers(userIds, payload) {
  if (!process.env.VAPID_PUBLIC_KEY || !userIds.length) return;
  const qmarks = userIds.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT user_id, subscription FROM push_subscriptions WHERE user_id IN (${qmarks})`,
    userIds
  );
  for (const row of rows) {
    try {
      const sub = typeof row.subscription === 'string' ? JSON.parse(row.subscription) : row.subscription;
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (err) {
      if (err.statusCode === 410) {
        db.run('DELETE FROM push_subscriptions WHERE user_id = ?', [row.user_id]).catch(() => {});
      } else {
        console.error('Error push usuario:', err.message);
      }
    }
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

    // Mensaje en chat interno (no traduce, no envía por canal externo)
    socket.on('internal_message', async ({ conversationId, text, requiresAck }) => {
      if (!text || !text.trim()) return;
      try {
        const member = await db.get(
          'SELECT can_reply FROM conversation_participants WHERE conversation_id = ? AND user_id = ?',
          [conversationId, socket.user?.user_id]
        );
        if (!member) return socket.emit('error', { msg: 'No perteneces a este chat' });
        if (member.can_reply === false) return socket.emit('error', { msg: 'Solo puedes leer este chat' });

        await db.run(
          `INSERT INTO messages (conversation_id, direction, original_text, translated_text, sender_user_id, requires_ack)
           VALUES (?, 'outgoing', ?, ?, ?, ?)`,
          [conversationId, text.trim(), text.trim(), socket.user?.user_id || null, requiresAck ? true : false]
        );
        await db.run(
          'UPDATE conversations SET updated_at = NOW() WHERE id = ?',
          [conversationId]
        );
        const msg = await db.get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conversationId]);
        const u = socket.user?.user_id
          ? await db.get('SELECT first_name, last_name FROM users WHERE id = ?', [socket.user.user_id])
          : null;
        if (u) msg.sender_name = `${u.first_name} ${u.last_name || ''}`.trim();

        const conv = await db.get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
        io.emit('message_sent', { conversation: conv, message: msg });

        // Push a los demás miembros del chat
        const senderId = socket.user?.user_id;
        const members = await db.all(
          'SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id != ?',
          [conversationId, senderId]
        );
        if (members.length) {
          const senderName = msg.sender_name || 'Mensaje interno';
          const bodyText = text.trim().length > 100 ? text.trim().slice(0, 100) + '…' : text.trim();
          await sendPushToUsers(
            members.map(m => m.user_id),
            {
              title: senderName,
              body: bodyText,
              tag: 'internal-' + conversationId,
            }
          );
        }
      } catch (err) {
        console.error('Error en internal_message:', err);
        socket.emit('error', { msg: err.message });
      }
    });

    socket.on('disconnect', () => {
      console.log('Panel del gestor desconectado:', socket.id);
    });
  });
}

module.exports = registerChatHandlers;
