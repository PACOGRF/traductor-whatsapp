const cron = require('node-cron');
const db = require('../db/db');
const webpush = require('web-push');
const { translateOutgoing, insertOutgoingMessage, sendViaChannel } = require('./messaging');

// Aviso push al gestor (misma suscripción que usa el resto de la app)
async function sendPush(app, payload) {
  const sub = app && app.get('pushSubscription');
  if (!sub || !process.env.VAPID_PUBLIC_KEY) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 410) app.set('pushSubscription', null);
  }
}

// Procesa los mensajes programados cuya hora de envío ya llegó.
// Exportada para poder probarla y para reutilizarla si hace falta.
async function processScheduledMessages(io, app) {
  let due;
  try {
    due = await db.all(
      `SELECT * FROM scheduled_messages
       WHERE status = 'pending' AND send_at <= NOW()
       ORDER BY send_at ASC`
    );
  } catch (err) {
    console.error('⚠️ Cron mensajes programados: error leyendo pendientes:', err.message);
    return;
  }

  for (const sm of due) {
    try {
      const conv = await db.get('SELECT * FROM conversations WHERE id = ?', [sm.conversation_id]);
      if (!conv) {
        await markFailed(sm, 'Conversación no encontrada', io, app, null);
        continue;
      }

      const translatedText = await translateOutgoing(conv, sm.text_es, sm.lang_override);
      const result = await sendViaChannel(conv, translatedText);

      if (!result.ok) {
        // Caso típico: ventana de 24h de WhatsApp cerrada (Meta error 131047)
        await markFailed(sm, result.error, io, app, conv);
        continue;
      }

      const msg = await insertOutgoingMessage(conv.id, sm.text_es, translatedText, sm.created_by);
      await db.run(
        `UPDATE scheduled_messages SET status = 'sent', sent_message_id = ?, updated_at = NOW() WHERE id = ?`,
        [msg.id, sm.id]
      );

      if (io) {
        io.emit('message_sent', { conversation: conv, message: msg });
        io.emit('scheduled_sent', { id: sm.id, conversation_id: conv.id });
      }
      console.log(`🕐 Mensaje programado #${sm.id} enviado a ${conv.guest_phone}`);
    } catch (err) {
      await markFailed(sm, err.message, io, app, null);
    }
  }
}

async function markFailed(sm, reason, io, app, conv) {
  try {
    await db.run(
      `UPDATE scheduled_messages SET status = 'failed', fail_reason = ?, updated_at = NOW() WHERE id = ?`,
      [reason, sm.id]
    );
  } catch (err) {
    console.error('⚠️ No se pudo marcar como fallido el programado #' + sm.id + ':', err.message);
    return;
  }
  console.error(`❌ Mensaje programado #${sm.id} falló: ${reason}`);
  if (io) io.emit('scheduled_failed', { id: sm.id, conversation_id: sm.conversation_id, reason });
  sendPush(app, {
    title: '⚠️ Falló un mensaje programado',
    body: (conv ? (conv.guest_name || conv.guest_phone) + ': ' : '') + reason,
  });
}

// Tareas programadas del servidor
function startCronJobs(io, app) {
  // Cada 5 minutos: mensajes programados (en Sprint 4 se añadirá aquí el motor de alertas)
  cron.schedule('*/5 * * * *', () => processScheduledMessages(io, app));

  // Lunes a las 08:00: ping a Supabase para evitar la pausa del plan gratuito
  cron.schedule('0 8 * * 1', async () => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) return;

    try {
      const res = await fetch(url.replace(/\/$/, '') + '/rest/v1/', {
        headers: { apikey: key }
      });
      console.log('🏓 Ping semanal a Supabase: HTTP ' + res.status);
    } catch (err) {
      console.error('⚠️ Falló el ping a Supabase:', err.message);
    }
  });

  console.log('⏰ Cron activo: mensajes programados (cada 5 min) + ping Supabase (lunes 08:00)');
}

module.exports = { startCronJobs, processScheduledMessages };
