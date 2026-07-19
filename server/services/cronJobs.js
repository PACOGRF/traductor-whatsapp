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

// ── Motor de alertas (Sprint 4) ────────────────────────────────
// 1) Tareas cuya alerta (remind_at) ha llegado → push una sola vez
// 2) Conversaciones sin responder más de alert_hours → push una sola vez
async function processAlerts(io, app) {
  const now = Date.now();
  try {
    // 1. Tareas con aviso vencido y aún no notificado
    const dueTasks = await db.all(
      `SELECT t.*, c.guest_name AS conv_guest_name, ct.name AS contact_name
       FROM tasks t
       LEFT JOIN conversations c ON c.id = t.conversation_id
       LEFT JOIN contacts ct ON ct.id = t.contact_id
       WHERE t.deleted_at IS NULL AND t.status <> 'done'
         AND t.remind_at IS NOT NULL AND t.remind_sent_at IS NULL`
    );
    for (const t of dueTasks) {
      if (new Date(t.remind_at).getTime() > now) continue;
      const client = t.contact_name || t.conv_guest_name || t.guest_name || '';
      await sendPush(app, {
        title: '⏰ Alerta de tarea' + (t.high_priority ? ' 🔴' : ''),
        body: (client ? client + ': ' : '') + (t.message_text || '').slice(0, 120),
      });
      await db.run('UPDATE tasks SET remind_sent_at = CURRENT_TIMESTAMP WHERE id = ?', [t.id]);
      if (io) io.emit('tasks_changed');
      console.log('⏰ Alerta enviada de la tarea #' + t.id);
    }

    // 2. Conversaciones sin responder (umbral por empresa, defecto 4h)
    const company = await db.get('SELECT * FROM companies WHERE id = 1');
    const alertHours = (company && company.alert_hours) || 4;
    const convs = await db.all(
      `SELECT * FROM conversations
       WHERE last_incoming_at IS NOT NULL
         AND (last_outgoing_at IS NULL OR last_outgoing_at < last_incoming_at)`
    );
    for (const c of convs) {
      const waitedMs = now - new Date(c.last_incoming_at).getTime();
      if (waitedMs < alertHours * 3600 * 1000) continue;
      // Ya avisada de este mensaje: no repetir
      if (c.unanswered_alerted_at && new Date(c.unanswered_alerted_at) >= new Date(c.last_incoming_at)) continue;

      const hours = Math.floor(waitedMs / 3600000);
      await sendPush(app, {
        title: '⚠️ Conversación sin responder',
        body: `${c.guest_name || c.guest_phone} lleva ${hours}h esperando respuesta`,
      });
      await db.run('UPDATE conversations SET unanswered_alerted_at = CURRENT_TIMESTAMP WHERE id = ?', [c.id]);
      if (io) io.emit('tasks_changed');
      console.log('⚠️ Aviso de sin responder: conversación #' + c.id);
    }
  } catch (err) {
    console.error('⚠️ Error en el motor de alertas:', err.message);
  }
}

// Tareas programadas del servidor
function startCronJobs(io, app) {
  // Cada 5 minutos: mensajes programados + motor de alertas
  cron.schedule('*/5 * * * *', () => processScheduledMessages(io, app));
  cron.schedule('*/5 * * * *', () => processAlerts(io, app));

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

  console.log('⏰ Cron activo: mensajes programados + alertas (cada 5 min) + ping Supabase (lunes 08:00)');
}

module.exports = { startCronJobs, processScheduledMessages, processAlerts };
