const express = require('express');
const router = express.Router();
const db = require('../db/db');
const webpush = require('web-push');

async function sendPush(app, payload) {
  const sub = app.get('pushSubscription');
  if (!sub || !process.env.VAPID_PUBLIC_KEY) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 410) app.set('pushSubscription', null);
  }
}

// Listar todas las conversaciones (clientes + chats internos del usuario)
router.get('/conversations', async (req, res) => {
  try {
    const userId = req.user?.user_id || null;
    const rows = await db.all(`
      SELECT c.*, ct.name AS contact_name, ct.phone AS contact_phone, ct.group_id AS contact_group_id,
        cp.user_id AS is_member,
        (SELECT COUNT(*) FROM conversation_participants WHERE conversation_id = c.id) AS member_count,
        (SELECT m.translated_text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_at,
        (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_direction
      FROM conversations c
      LEFT JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = ?
      ORDER BY last_message_at DESC NULLS LAST
    `, [userId]);
    // Marca "sin responder": el último mensaje es del cliente y supera el umbral de la empresa
    const company = await db.get('SELECT alert_hours FROM companies WHERE id = 1');
    const alertHours = (company && company.alert_hours) || 4;
    const now = Date.now();
    // Visibilidad por rol (D1/D2): los empleados solo ven sus grupos
    const { getVisibility, convAccess } = require('../services/visibility');
    const vis = await getVisibility(req.user);
    const result = [];
    for (const r of rows) {
      if (r.channel === 'internal') {
        if (!r.is_member) continue; // solo miembros ven el chat interno
        result.push({ ...r, unanswered_hours: null, can_reply: true });
        continue;
      }
      const access = convAccess(vis, r);
      if (access === 'none') continue;
      let unanswered_hours = null;
      if (r.last_direction === 'incoming' && r.last_message_at) {
        const h = (now - new Date(r.last_message_at).getTime()) / 3600000;
        if (h >= alertHours) unanswered_hours = Math.floor(h);
      }
      result.push({ ...r, unanswered_hours, can_reply: access === 'reply' });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mensajes de una conversación (los empleados solo si la conversación es visible)
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const conv = await db.get('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

    if (conv.channel === 'internal') {
      // Chat interno: solo accesible para miembros
      const member = await db.get(
        'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?',
        [req.params.id, req.user?.user_id]
      );
      if (!member) return res.status(403).json({ error: 'Sin acceso a este chat' });
    } else if (req.user?.role === 'employee') {
      const { accessForConversation } = require('../services/visibility');
      const { access } = await accessForConversation(req.user, req.params.id);
      if (access === 'none') return res.status(403).json({ error: 'Sin acceso a esta conversación' });
    }

    const myId = req.user?.user_id || null;
    const rows = await db.all(
      `SELECT m.*,
              u.first_name AS sender_first_name, u.last_name AS sender_last_name,
              (SELECT COUNT(*) FROM message_acks WHERE message_id = m.id) AS ack_count,
              (SELECT acked_at FROM message_acks WHERE message_id = m.id AND user_id = ?) AS acked_by_me
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_user_id
       WHERE m.conversation_id = ? ORDER BY m.created_at ASC`,
      [myId, req.params.id]
    );
    // Archivos: añadir URL firmada temporal para ver/descargar (Sprint 5)
    const { signedUrl } = require('../services/storage');
    for (const r of rows) {
      if (r.storage_path) r.signed_url = await signedUrl(r.storage_path);
      if (r.sender_first_name) r.sender_name = `${r.sender_first_name} ${r.sender_last_name || ''}`.trim();
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ARCHIVOS (Sprint 5): subir y enviar por el canal ──
const multer = require('multer');
const uploadMw = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

router.post('/conversations/:id/files', (req, res) => {
  uploadMw.single('file')(req, res, async (err) => {
    try {
      if (err) {
        return res.status(400).json({
          error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera el límite de 16 MB' : 'Error al subir el archivo',
        });
      }
      if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

      const storage = require('../services/storage');
      const filename = req.file.originalname || 'archivo';
      if (!storage.extensionAllowed(filename)) {
        return res.status(400).json({ error: 'Tipo de archivo no admitido. Permitidos: imagen, vídeo mp4, audio, PDF, Word y Excel.' });
      }
      if (!storage.storageEnabled()) {
        return res.status(400).json({ error: 'El almacenamiento no está configurado (falta SUPABASE_SERVICE_KEY en Render)' });
      }

      // Permiso de respuesta (los empleados "solo leer" no envían)
      const { accessForConversation } = require('../services/visibility');
      const { conv, access } = await accessForConversation(req.user, req.params.id);
      if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });
      if (access !== 'reply') return res.status(403).json({ error: 'No tienes permiso para enviar en esta conversación' });

      const mediaType = storage.mediaTypeFor(filename);
      const pathInBucket = `companies/${req.user?.company_id || 1}/conversations/${conv.id}/${Date.now()}_${storage.safeName(filename)}`;
      const up = await storage.uploadBuffer(pathInBucket, req.file.buffer, req.file.mimetype);
      if (!up.ok) return res.status(502).json({ error: up.error });

      const fileUrl = await storage.signedUrl(pathInBucket, 3600);
      const { sendFileViaChannel } = require('../services/messaging');
      const sent = await sendFileViaChannel(conv, fileUrl, mediaType);
      if (!sent.ok) return res.status(502).json({ error: 'No se pudo enviar por el canal: ' + sent.error });

      await db.run(
        `INSERT INTO messages (conversation_id, direction, original_text, media_url, media_type, storage_path, sender_user_id)
         VALUES (?, 'outgoing', ?, ?, ?, ?, ?)`,
        [conv.id, `📎 ${filename}`, filename, mediaType, pathInBucket, req.user?.user_id || null]
      );
      await db.run('UPDATE conversations SET last_outgoing_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conv.id]);
      const msg = await db.get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conv.id]);
      msg.signed_url = fileUrl;

      const io = req.app.get('io');
      if (io) io.emit('message_sent', { conversation: conv, message: msg });
      res.json(msg);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// Respuestas rápidas
router.get('/quick-replies', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM quick_replies WHERE active = 1 ORDER BY sort_order ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear plantilla nueva
router.post('/quick-replies', async (req, res) => {
  try {
    const { title, message_es } = req.body;
    if (!title || !message_es) return res.status(400).json({ error: 'Título y mensaje requeridos' });
    await db.run(
      'INSERT INTO quick_replies (title, message_es, sort_order) VALUES (?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM quick_replies))',
      [title, message_es]
    );
    const row = await db.get('SELECT * FROM quick_replies ORDER BY id DESC LIMIT 1');
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Actualizar plantilla
router.put('/quick-replies/:id', async (req, res) => {
  try {
    const { title, message_es } = req.body;
    await db.run('UPDATE quick_replies SET title = ?, message_es = ? WHERE id = ?', [title, message_es, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar plantilla
router.delete('/quick-replies/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM quick_replies WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear conversación de demo
router.post('/demo/message', async (req, res) => {
  try {
    const { phone, name, text, language } = req.body;
    const { translateWithDetection } = require('../services/translate');

    let conv = await db.get('SELECT * FROM conversations WHERE guest_phone = ?', [phone]);
    if (!conv) {
      await db.run(
        'INSERT INTO conversations (guest_phone, guest_name, guest_language) VALUES (?, ?, ?)',
        [phone, name || 'Huésped Demo', language || 'en']
      );
      conv = await db.get('SELECT * FROM conversations WHERE guest_phone = ?', [phone]);
    }

    const { translatedText: translated, detectedLanguage: detectedLang } = await translateWithDetection(text, 'es');

    await db.run(
      'INSERT INTO messages (conversation_id, direction, original_text, translated_text, language_detected) VALUES (?, ?, ?, ?, ?)',
      [conv.id, 'incoming', text, translated, detectedLang]
    );
    await db.run(
      'UPDATE conversations SET last_incoming_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [conv.id]
    );

    const msg = await db.get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conv.id]);

    if (req.app.get('io')) {
      req.app.get('io').emit('new_message', { conversation: conv, message: msg });
    }

    await sendPush(req.app, {
      title: `💬 ${conv.guest_name || conv.guest_phone}`,
      body: msg.translated_text || msg.original_text,
      phone: conv.guest_phone,
    });

    res.json({ conversation: conv, message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Usuarios de la empresa (para desplegables de responsable) ──
router.get('/users', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT u.id, u.first_name, u.last_name, u.role, u.position_id, p.name AS position_name
       FROM users u LEFT JOIN positions p ON p.id = u.position_id
       WHERE u.company_id = ? AND u.active = true
       ORDER BY u.last_name, u.first_name`,
      [req.user?.company_id || 1]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tareas 2.0 (Sprint 4) ──────────────────────────────
// Aviso a otros paneles conectados de que las tareas cambiaron
function emitTasksChanged(req) {
  const io = req.app.get('io');
  if (io) io.emit('tasks_changed');
}

// Todas las tareas vivas (borrado lógico fuera) con nombres para mostrar
router.get('/tasks', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    const rows = await db.all(
      `SELECT t.*,
              c.guest_name  AS conv_guest_name,
              c.channel     AS conv_channel,
              ct.name       AS contact_name,
              u.first_name  AS assigned_first_name,
              u.last_name   AS assigned_last_name,
              COALESCE(tcc.confirmation_count, 0) AS confirmation_count,
              tc_me.confirmed_at AS confirmed_by_me_at
       FROM tasks t
       LEFT JOIN conversations c ON c.id = t.conversation_id
       LEFT JOIN contacts ct     ON ct.id = t.contact_id
       LEFT JOIN users u         ON u.id = t.assigned_to
       LEFT JOIN (
         SELECT task_id, COUNT(*) AS confirmation_count
         FROM task_confirmations GROUP BY task_id
       ) tcc ON tcc.task_id = t.id
       LEFT JOIN task_confirmations tc_me ON tc_me.task_id = t.id AND tc_me.user_id = ?
       WHERE t.deleted_at IS NULL
       ORDER BY t.id DESC`,
      [userId]
    );
    res.json(rows.map(r => ({
      ...r,
      client_label: r.contact_name || r.conv_guest_name || r.guest_name || '—',
      assigned_label: r.assigned_first_name ? `${r.assigned_first_name} ${r.assigned_last_name || ''}`.trim() : null,
      confirmation_count: Number(r.confirmation_count) || 0,
      confirmed_by_me: !!r.confirmed_by_me_at,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Crear tarea (desde la chincheta 📌 o desde la pantalla TAREAS)
router.post('/tasks', async (req, res) => {
  try {
    const { conversation_id, anchored_message_id, text, assigned_to,
            notify_also, high_priority, remind_at, due_at,
            requires_confirmation, confirm_user_ids } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'El comentario es obligatorio' });

    let conv = null, guestLabel = null, contactId = null;
    if (conversation_id) {
      conv = await db.get('SELECT * FROM conversations WHERE id = ?', [conversation_id]);
      if (conv) {
        contactId = conv.contact_id || null;
        const ficha = contactId ? await db.get('SELECT name FROM contacts WHERE id = ?', [contactId]) : null;
        guestLabel = (ficha && ficha.name) || conv.guest_name || conv.guest_phone;
      }
    }

    await db.run(
      `INSERT INTO tasks (company_id, contact_id, conversation_id, anchored_message_id,
                          msg_id, guest_name, message_text,
                          assigned_to, notify_also, status, high_priority,
                          remind_at, due_at, created_by,
                          requires_confirmation, confirm_user_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      [req.user?.company_id || 1, contactId, conversation_id || null, anchored_message_id || null,
       anchored_message_id || null, guestLabel, text.trim(),
       assigned_to || null, notify_also && notify_also.length ? notify_also : null,
       !!high_priority, remind_at || null, due_at || null, req.user?.user_id || null,
       !!requires_confirmation, confirm_user_ids && confirm_user_ids.length ? confirm_user_ids : null]
    );
    const row = await db.get('SELECT * FROM tasks ORDER BY id DESC LIMIT 1');

    const { logAudit } = require('../services/audit');
    await logAudit(req.user?.company_id, req.user?.user_id, 'task_created',
      { task_id: row.id, conversation_id: conversation_id || null });

    emitTasksChanged(req);
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cambiar estado (D4): solo el responsable o gestor/supervisor
router.patch('/tasks/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending', 'in_progress', 'done'].includes(status)) {
      return res.status(400).json({ error: 'Estado no válido' });
    }
    const task = await db.get('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'No encontrada' });

    const isBoss = ['manager', 'supervisor'].includes(req.user?.role);
    const isOwner = task.assigned_to && req.user?.user_id === task.assigned_to;
    if (task.assigned_to && !isBoss && !isOwner) {
      return res.status(403).json({ error: 'Solo el responsable o el gestor pueden cambiar el estado' });
    }

    await db.run(
      'UPDATE tasks SET status = ?, status_changed_at = CURRENT_TIMESTAMP, status_changed_by = ? WHERE id = ?',
      [status, req.user?.user_id || null, req.params.id]
    );
    const { logAudit } = require('../services/audit');
    await logAudit(req.user?.company_id, req.user?.user_id, 'task_status_change',
      { task_id: task.id, from: task.status, to: status });

    emitTasksChanged(req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Editar tarea
router.put('/tasks/:id', async (req, res) => {
  try {
    const task = await db.get('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'No encontrada' });

    const { text, assigned_to, notify_also, high_priority, remind_at, due_at,
            requires_confirmation, confirm_user_ids } = req.body;
    const remindChanged = (remind_at || null) !== (task.remind_at ? new Date(task.remind_at).toISOString() : null);

    await db.run(
      `UPDATE tasks SET message_text = ?, assigned_to = ?, notify_also = ?,
              high_priority = ?, remind_at = ?, due_at = ?,
              requires_confirmation = ?, confirm_user_ids = ?
              ${remindChanged ? ', remind_sent_at = NULL' : ''}
       WHERE id = ?`,
      [text !== undefined ? text : task.message_text,
       assigned_to !== undefined ? assigned_to : task.assigned_to,
       notify_also !== undefined ? (notify_also && notify_also.length ? notify_also : null) : task.notify_also,
       high_priority !== undefined ? !!high_priority : task.high_priority,
       remind_at !== undefined ? remind_at : task.remind_at,
       due_at !== undefined ? due_at : task.due_at,
       requires_confirmation !== undefined ? !!requires_confirmation : task.requires_confirmation,
       confirm_user_ids !== undefined ? (confirm_user_ids && confirm_user_ids.length ? confirm_user_ids : null) : task.confirm_user_ids,
       req.params.id]
    );
    emitTasksChanged(req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Prioridad alta on/off (círculo rojo)
router.patch('/tasks/:id/priority', async (req, res) => {
  try {
    const task = await db.get('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'No encontrada' });
    await db.run('UPDATE tasks SET high_priority = ? WHERE id = ?', [!task.high_priority, req.params.id]);
    emitTasksChanged(req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Borrado LÓGICO (D4): la tarea se oculta pero queda en la base de datos
router.delete('/tasks/:id', async (req, res) => {
  try {
    await db.run('UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
    const { logAudit } = require('../services/audit');
    await logAudit(req.user?.company_id, req.user?.user_id, 'task_deleted', { task_id: Number(req.params.id) });
    emitTasksChanged(req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Alertas vencidas globales (columna derecha, mitad inferior) ──
router.get('/alerts', async (req, res) => {
  try {
    const now = Date.now();
    const tasks = await db.all(
      `SELECT t.*, c.guest_name AS conv_guest_name, ct.name AS contact_name
       FROM tasks t
       LEFT JOIN conversations c ON c.id = t.conversation_id
       LEFT JOIN contacts ct ON ct.id = t.contact_id
       WHERE t.deleted_at IS NULL AND t.status <> 'done'
         AND (t.remind_at IS NOT NULL OR t.due_at IS NOT NULL)`
    );
    const alerts = [];
    for (const t of tasks) {
      const client = t.contact_name || t.conv_guest_name || t.guest_name || '—';
      if (t.remind_at && new Date(t.remind_at).getTime() <= now) {
        alerts.push({ type: 'remind', task_id: t.id, conversation_id: t.conversation_id,
          client, text: t.message_text, when: t.remind_at, high_priority: t.high_priority });
      }
      if (t.due_at && new Date(t.due_at).getTime() <= now) {
        alerts.push({ type: 'due', task_id: t.id, conversation_id: t.conversation_id,
          client, text: t.message_text, when: t.due_at, high_priority: t.high_priority });
      }
    }
    // Conversaciones sin responder (mismo umbral que el cron y el badge ⚠️)
    const company = await db.get('SELECT alert_hours FROM companies WHERE id = 1');
    const alertHours = (company && company.alert_hours) || 4;
    const convs = await db.all(`
      SELECT c.id, c.guest_name, c.guest_phone, c.unanswered_dismissed_at, ct.name AS contact_name,
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_at,
        (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_direction
      FROM conversations c
      LEFT JOIN contacts ct ON ct.id = c.contact_id
    `);
    for (const c of convs) {
      if (c.last_direction !== 'incoming' || !c.last_message_at) continue;
      const hours = (now - new Date(c.last_message_at).getTime()) / 3600000;
      if (hours < alertHours) continue;
      // Descartada manualmente y sin mensajes nuevos desde entonces: no mostrar
      if (c.unanswered_dismissed_at && new Date(c.unanswered_dismissed_at) >= new Date(c.last_message_at)) continue;
      alerts.push({
        type: 'unanswered', task_id: null, conversation_id: c.id,
        client: c.contact_name || c.guest_name || c.guest_phone,
        text: 'Cliente esperando respuesta', when: c.last_message_at, high_priority: false,
      });
    }

    alerts.sort((a, b) => new Date(a.when) - new Date(b.when));
    res.json(alerts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Notas ancladas a mensajes (D8, post-its en el hilo) ──
router.get('/conversations/:id/notes', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT n.*, u.first_name, u.last_name
       FROM message_notes n
       JOIN messages m ON m.id = n.message_id
       LEFT JOIN users u ON u.id = n.user_id
       WHERE m.conversation_id = ?
       ORDER BY n.created_at ASC`,
      [req.params.id]
    );
    res.json(rows.map(r => ({
      ...r,
      author: r.first_name ? `${r.first_name} ${r.last_name || ''}`.trim() : 'Equipo',
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/messages/:id/notes', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'La nota no puede estar vacía' });
    await db.run(
      'INSERT INTO message_notes (message_id, user_id, text) VALUES (?, ?, ?)',
      [req.params.id, req.user?.user_id || null, text.trim()]
    );
    const row = await db.get('SELECT * FROM message_notes ORDER BY id DESC LIMIT 1');
    const io = req.app.get('io');
    if (io) io.emit('note_added', { message_id: Number(req.params.id) });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/notes/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM message_notes WHERE id = ?', [req.params.id]);
    const { logAudit } = require('../services/audit');
    await logAudit(req.user?.company_id, req.user?.user_id, 'note_deleted', { note_id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Configuración del canal Telegram (Sprint 1) ────────
const { requireRole } = require('../middleware/auth');

// Estado actual: ¿hay bot configurado para la empresa del usuario?
router.get('/telegram/config', async (req, res) => {
  try {
    const companyId = req.user?.company_id || 1;
    const company = await db.get('SELECT telegram_bot_token FROM companies WHERE id = ?', [companyId]);
    if (!company || !company.telegram_bot_token) return res.json({ configured: false });

    const { getMe } = require('../services/telegram');
    const me = await getMe(company.telegram_bot_token);
    if (!me.ok) return res.json({ configured: true, bot_username: null });
    res.json({
      configured: true,
      bot_username: me.result.username,
      link: 'https://t.me/' + me.result.username,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Guardar el token del bot y registrar el webhook (solo GESTOR)
router.post('/telegram/config', requireRole('manager'), async (req, res) => {
  try {
    const token = (req.body.bot_token || '').trim();
    if (!token) return res.status(400).json({ error: 'Pega el token del bot' });

    const { getMe, setWebhook, webhookSecret } = require('../services/telegram');

    // 1. Validar el token preguntando a Telegram quién es el bot
    const me = await getMe(token);
    if (!me.ok) {
      return res.status(400).json({ error: 'Token no válido. Revisa que lo copiaste entero de @BotFather.' });
    }

    // 2. Guardar el token en la empresa del gestor
    const companyId = req.user.company_id || 1;
    await db.run('UPDATE companies SET telegram_bot_token = ? WHERE id = ?', [token, companyId]);

    // 3. Registrar el webhook del bot apuntando a este servidor
    const host = req.get('host');
    const base = (host.includes('localhost') ? 'http' : 'https') + '://' + host;
    const hook = await setWebhook(token, `${base}/webhook/telegram/${companyId}`, webhookSecret(token));
    if (!hook.ok) {
      return res.status(502).json({ error: 'Telegram rechazó el webhook: ' + (hook.description || 'error') });
    }

    const { logAudit } = require('../services/audit');
    await logAudit(companyId, req.user.user_id, 'telegram_configured', { bot: me.result.username });

    res.json({
      ok: true,
      bot_username: me.result.username,
      link: 'https://t.me/' + me.result.username,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── EMPLEADOS, PUESTOS Y GRUPOS (Sprint 2, solo GESTOR) ──

// Contraseña temporal legible (el empleado la cambia obligatoriamente al entrar)
function genTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Resuelve el puesto: por id, o por nombre creándolo si no existe (D3)
async function resolvePosition(companyId, positionId, positionName) {
  if (positionId) return Number(positionId);
  const name = (positionName || '').trim();
  if (!name) return null;
  let p = await db.get('SELECT id FROM positions WHERE company_id = ? AND LOWER(name) = LOWER(?)', [companyId, name]);
  if (!p) {
    await db.run('INSERT INTO positions (company_id, name) VALUES (?, ?)', [companyId, name]);
    p = await db.get('SELECT id FROM positions WHERE company_id = ? AND LOWER(name) = LOWER(?)', [companyId, name]);
  }
  return p.id;
}

// Guarda los grupos visibles del empleado (D2)
async function saveEmployeeGroups(userId, groups) {
  if (!Array.isArray(groups)) return;
  await db.run('DELETE FROM user_group_visibility WHERE user_id = ?', [userId]);
  for (const g of groups) {
    if (!g || !g.group_id) continue;
    await db.run(
      'INSERT INTO user_group_visibility (user_id, group_id, can_reply) VALUES (?, ?, ?)',
      [userId, g.group_id, g.can_reply !== false]
    );
  }
}

// Puestos de la empresa (autocompletado del alta)
router.get('/positions', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM positions WHERE company_id = ? ORDER BY name', [req.user?.company_id || 1]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Grupos de clientes (checkboxes de visibilidad; el CRUD llega en Sprint 3)
router.get('/contact-groups', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM contact_groups WHERE company_id = ? ORDER BY name', [req.user?.company_id || 1]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Listado de empleados
router.get('/employees', requireRole('manager'), async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT u.id, u.first_name, u.last_name, u.username, u.role, u.active,
              u.position_id, u.must_change_password, u.created_at, p.name AS position_name
       FROM users u LEFT JOIN positions p ON p.id = u.position_id
       WHERE u.company_id = ?
       ORDER BY u.active DESC, u.last_name, u.first_name`,
      [req.user.company_id || 1]
    );
    const visibility = await db.all('SELECT * FROM user_group_visibility');
    res.json(rows.map(u => ({
      ...u,
      groups: visibility.filter(v => v.user_id === u.id).map(v => ({ group_id: v.group_id, can_reply: v.can_reply })),
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Alta de empleado → devuelve la contraseña temporal UNA sola vez
router.post('/employees', requireRole('manager'), async (req, res) => {
  try {
    const { first_name, last_name, username, role, position_id, position_name, groups } = req.body;
    if (!first_name || !first_name.trim() || !last_name || !last_name.trim()) {
      return res.status(400).json({ error: 'Nombre y apellidos son obligatorios' });
    }
    if (!username || !username.trim()) return res.status(400).json({ error: 'El usuario (login) es obligatorio' });
    if (!['manager', 'supervisor', 'employee'].includes(role)) {
      return res.status(400).json({ error: 'Rol no válido' });
    }
    const clean = username.trim().toLowerCase();
    const exists = await db.get('SELECT id FROM users WHERE username = ?', [clean]);
    if (exists) return res.status(409).json({ error: 'Ese nombre de usuario ya existe' });

    const companyId = req.user.company_id || 1;
    const posId = await resolvePosition(companyId, position_id, position_name);

    const bcrypt = require('bcryptjs');
    const temp = genTempPassword();
    const hash = await bcrypt.hash(temp, 10);

    await db.run(
      `INSERT INTO users (company_id, first_name, last_name, position_id, username, password_hash, role, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, true)`,
      [companyId, first_name.trim(), last_name.trim(), posId, clean, hash, role]
    );
    const user = await db.get('SELECT * FROM users WHERE username = ?', [clean]);
    await saveEmployeeGroups(user.id, groups);

    const { logAudit } = require('../services/audit');
    await logAudit(companyId, req.user.user_id, 'user_created',
      { new_user_id: user.id, username: clean, role, position_id: posId });

    res.json({ id: user.id, username: clean, temp_password: temp });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Edición de empleado (datos, puesto, rol y grupos)
router.put('/employees/:id', requireRole('manager'), async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ? AND company_id = ?', [req.params.id, req.user.company_id || 1]);
    if (!user) return res.status(404).json({ error: 'Empleado no encontrado' });

    const { first_name, last_name, role, position_id, position_name, groups } = req.body;
    if (role && !['manager', 'supervisor', 'employee'].includes(role)) {
      return res.status(400).json({ error: 'Rol no válido' });
    }
    // El gestor no puede quitarse a sí mismo el rol de gestor (quedaría la empresa sin gestor)
    if (user.id === req.user.user_id && role && role !== 'manager') {
      return res.status(400).json({ error: 'No puedes quitarte a ti mismo el rol de gestor' });
    }
    const posId = await resolvePosition(req.user.company_id || 1, position_id, position_name);

    await db.run(
      'UPDATE users SET first_name = ?, last_name = ?, role = ?, position_id = ? WHERE id = ?',
      [(first_name || user.first_name).trim(), (last_name || user.last_name).trim(),
       role || user.role, posId !== null ? posId : user.position_id, user.id]
    );
    if (groups !== undefined) await saveEmployeeGroups(user.id, groups);

    const { logAudit } = require('../services/audit');
    await logAudit(req.user.company_id, req.user.user_id, 'permission_change',
      { user_id: user.id, role: role || user.role, groups: groups || null });

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Activar/desactivar (borrado lógico de empleados)
router.patch('/employees/:id/active', requireRole('manager'), async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ? AND company_id = ?', [req.params.id, req.user.company_id || 1]);
    if (!user) return res.status(404).json({ error: 'Empleado no encontrado' });
    if (user.id === req.user.user_id) return res.status(400).json({ error: 'No puedes desactivarte a ti mismo' });

    await db.run('UPDATE users SET active = ? WHERE id = ?', [!user.active, user.id]);
    const { logAudit } = require('../services/audit');
    await logAudit(req.user.company_id, req.user.user_id, user.active ? 'user_deactivated' : 'user_reactivated',
      { user_id: user.id, username: user.username });
    res.json({ ok: true, active: !user.active });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resetear contraseña → nueva temporal (y desbloquea la cuenta)
router.post('/employees/:id/reset-password', requireRole('manager'), async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ? AND company_id = ?', [req.params.id, req.user.company_id || 1]);
    if (!user) return res.status(404).json({ error: 'Empleado no encontrado' });

    const bcrypt = require('bcryptjs');
    const temp = genTempPassword();
    const hash = await bcrypt.hash(temp, 10);
    await db.run(
      'UPDATE users SET password_hash = ?, must_change_password = true, failed_attempts = 0, locked_until = NULL WHERE id = ?',
      [hash, user.id]
    );
    const { logAudit } = require('../services/audit');
    await logAudit(req.user.company_id, req.user.user_id, 'password_reset', { user_id: user.id });
    res.json({ ok: true, temp_password: temp });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CONTACTOS Y GRUPOS (Sprint 3) ──────────────────────

// Listado de contactos (pantalla CONTACTOS; visible para todos los roles)
router.get('/contacts', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT ct.*, g.name AS group_name
       FROM contacts ct
       LEFT JOIN contact_groups g ON g.id = ct.group_id
       WHERE ct.company_id = ? AND ct.deleted_at IS NULL
       ORDER BY ct.name`,
      [req.user?.company_id || 1]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Crear grupo de clientes (mismo patrón que los puestos, D2/D3)
router.post('/contact-groups', requireRole('manager', 'supervisor'), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'El nombre del grupo es obligatorio' });
    const companyId = req.user.company_id || 1;
    let g = await db.get('SELECT * FROM contact_groups WHERE company_id = ? AND LOWER(name) = LOWER(?)', [companyId, name]);
    if (!g) {
      await db.run('INSERT INTO contact_groups (company_id, name) VALUES (?, ?)', [companyId, name]);
      g = await db.get('SELECT * FROM contact_groups WHERE company_id = ? AND LOWER(name) = LOWER(?)', [companyId, name]);
      const { logAudit } = require('../services/audit');
      await logAudit(companyId, req.user.user_id, 'group_created', { group_id: g.id, name });
    }
    res.json(g);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Editar ficha (gestor y supervisor)
router.put('/contacts/:id', requireRole('manager', 'supervisor'), async (req, res) => {
  try {
    const companyId = req.user.company_id || 1;
    const contact = await db.get('SELECT * FROM contacts WHERE id = ? AND company_id = ? AND deleted_at IS NULL', [req.params.id, companyId]);
    if (!contact) return res.status(404).json({ error: 'Contacto no encontrado' });

    const { name, phone, company_name, group_id, group_name, preferred_language, permanent_notes } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });

    const cleanPhone = (phone || '').trim() || null;
    if (cleanPhone && cleanPhone !== contact.phone) {
      const dup = await db.get('SELECT id FROM contacts WHERE company_id = ? AND phone = ? AND id <> ?', [companyId, cleanPhone, contact.id]);
      if (dup) return res.status(409).json({ error: 'Ya existe otro contacto con ese teléfono' });
    }

    // Grupo: por id, o por nombre creándolo (patrón "+ Añadir grupo")
    let gid = group_id !== undefined ? (group_id || null) : contact.group_id;
    if (group_name && group_name.trim()) {
      const gname = group_name.trim();
      let g = await db.get('SELECT id FROM contact_groups WHERE company_id = ? AND LOWER(name) = LOWER(?)', [companyId, gname]);
      if (!g) {
        await db.run('INSERT INTO contact_groups (company_id, name) VALUES (?, ?)', [companyId, gname]);
        g = await db.get('SELECT id FROM contact_groups WHERE company_id = ? AND LOWER(name) = LOWER(?)', [companyId, gname]);
      }
      gid = g.id;
    }

    await db.run(
      `UPDATE contacts SET name = ?, phone = ?, company_name = ?, group_id = ?, preferred_language = ?, permanent_notes = ?
       WHERE id = ?`,
      [name.trim(), cleanPhone, company_name || null, gid, preferred_language || null, permanent_notes || null, contact.id]
    );

    // Idioma preferido: se aplica a sus conversaciones para la traducción
    if (preferred_language) {
      await db.run('UPDATE conversations SET guest_language = ? WHERE contact_id = ?', [preferred_language, contact.id]);
    }

    const { logAudit } = require('../services/audit');
    await logAudit(companyId, req.user.user_id, 'contact_updated', { contact_id: contact.id });
    res.json(await db.get('SELECT * FROM contacts WHERE id = ?', [contact.id]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Borrado lógico de ficha
router.delete('/contacts/:id', requireRole('manager', 'supervisor'), async (req, res) => {
  try {
    await db.run('UPDATE contacts SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [req.params.id, req.user.company_id || 1]);
    const { logAudit } = require('../services/audit');
    await logAudit(req.user.company_id, req.user.user_id, 'contact_deleted', { contact_id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Iniciar conversación con un contacto (botón ➕ de la lista)
// Si ya tiene conversación → se abre. Si nunca escribió → enlace de invitación t.me
router.post('/conversations/start', async (req, res) => {
  try {
    const companyId = req.user?.company_id || 1;
    const contact = await db.get('SELECT * FROM contacts WHERE id = ? AND company_id = ? AND deleted_at IS NULL', [req.body.contact_id, companyId]);
    if (!contact) return res.status(404).json({ error: 'Contacto no encontrado' });

    const conv = await db.get(
      'SELECT * FROM conversations WHERE contact_id = ? ORDER BY updated_at DESC LIMIT 1',
      [contact.id]
    );
    if (conv) return res.json({ conversation_id: conv.id });

    // Restricción del canal: Telegram no permite que la empresa escriba primero.
    // Enlace de invitación con el contacto vinculado (al pulsarlo, ChatLink lo reconoce)
    const company = await db.get('SELECT telegram_bot_token FROM companies WHERE id = ?', [companyId]);
    if (!company || !company.telegram_bot_token) {
      return res.json({ invite_link: null, reason: 'Telegram no está configurado todavía' });
    }
    const { getMe } = require('../services/telegram');
    const me = await getMe(company.telegram_bot_token);
    if (!me.ok) return res.json({ invite_link: null, reason: 'No se pudo consultar el bot' });
    res.json({ invite_link: `https://t.me/${me.result.username}?start=c${contact.id}`, contact_name: contact.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Descartar la alerta "sin responder" de una conversación (reaparece si el cliente escribe de nuevo)
router.post('/conversations/:id/dismiss-alert', async (req, res) => {
  try {
    await db.run('UPDATE conversations SET unanswered_dismissed_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
    const { logAudit } = require('../services/audit');
    await logAudit(req.user?.company_id, req.user?.user_id, 'alert_dismissed', { conversation_id: Number(req.params.id) });
    const io = req.app.get('io');
    if (io) io.emit('tasks_changed');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Búsqueda en el texto de los mensajes (lupa 🔍 de la lista)
router.get('/conversations-search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const rows = await db.all(
      'SELECT DISTINCT conversation_id FROM messages WHERE original_text ILIKE ? OR translated_text ILIKE ?',
      ['%' + q + '%', '%' + q + '%']
    );
    res.json(rows.map(r => r.conversation_id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fichas de clientes (contacts) ──────────────────────
// Crear/actualizar la ficha de un cliente (p. ej. al confirmar un contacto
// compartido por Telegram). Vincula la conversación y limpia la propuesta.
router.post('/contacts', async (req, res) => {
  try {
    const { conversation_id, name, phone, company_name, permanent_notes } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'El nombre es obligatorio' });
    }
    const companyId = req.user?.company_id || 1;
    const cleanPhone = (phone || '').trim() || null;   // teléfono opcional (llega si el cliente lo comparte)

    // Resolver la ficha: la ya vinculada a la conversación > por teléfono > nueva
    let contact = null;
    const conv = conversation_id
      ? await db.get('SELECT * FROM conversations WHERE id = ?', [conversation_id])
      : null;
    if (conv && conv.contact_id) {
      contact = await db.get('SELECT * FROM contacts WHERE id = ?', [conv.contact_id]);
    }
    if (!contact && cleanPhone) {
      contact = await db.get('SELECT * FROM contacts WHERE company_id = ? AND phone = ?', [companyId, cleanPhone]);
    }

    if (contact) {
      await db.run(
        'UPDATE contacts SET name = ?, phone = ?, company_name = ?, permanent_notes = ? WHERE id = ?',
        [name.trim(), cleanPhone || contact.phone, company_name || contact.company_name,
         permanent_notes || contact.permanent_notes, contact.id]
      );
      contact = await db.get('SELECT * FROM contacts WHERE id = ?', [contact.id]);
    } else {
      await db.run(
        'INSERT INTO contacts (company_id, phone, name, company_name, permanent_notes) VALUES (?, ?, ?, ?, ?)',
        [companyId, cleanPhone, name.trim(), company_name || null, permanent_notes || null]
      );
      contact = await db.get('SELECT * FROM contacts WHERE company_id = ? ORDER BY id DESC LIMIT 1', [companyId]);
    }

    if (conversation_id) {
      await db.run(
        'UPDATE conversations SET contact_id = ?, pending_contact = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [contact.id, conversation_id]
      );
    }

    const { logAudit } = require('../services/audit');
    await logAudit(companyId, req.user?.user_id, 'contact_created',
      { contact_id: contact.id, conversation_id: conversation_id || null, phone: cleanPhone });

    const io = req.app.get('io');
    if (io && conversation_id) {
      io.emit('contact_saved', { conversation_id, name: contact.name, phone: contact.phone });
    }
    res.json(contact);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Descartar la propuesta de contacto de una conversación (el gestor dijo que no)
router.delete('/conversations/:id/pending-contact', async (req, res) => {
  try {
    await db.run('UPDATE conversations SET pending_contact = NULL WHERE id = ?', [req.params.id]);
    const { logAudit } = require('../services/audit');
    await logAudit(req.user?.company_id, req.user?.user_id, 'contact_declined',
      { conversation_id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Mensajes programados ───────────────────────────────
// Pendientes y fallidos de una conversación (para mostrar en el hilo)
router.get('/conversations/:id/scheduled', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT * FROM scheduled_messages
       WHERE conversation_id = ? AND status IN ('pending', 'failed')
       ORDER BY send_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Programar un mensaje nuevo
router.post('/scheduled', async (req, res) => {
  try {
    const { conversation_id, text, lang_override, send_at } = req.body;
    if (!conversation_id || !text || !text.trim() || !send_at) {
      return res.status(400).json({ error: 'Faltan datos: conversación, texto y fecha de envío' });
    }
    const sendAt = new Date(send_at);
    if (isNaN(sendAt.getTime()) || sendAt <= new Date()) {
      return res.status(400).json({ error: 'La fecha de envío debe ser futura' });
    }
    const conv = await db.get('SELECT * FROM conversations WHERE id = ?', [conversation_id]);
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

    await db.run(
      `INSERT INTO scheduled_messages (company_id, conversation_id, created_by, text_es, lang_override, send_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.user?.company_id || 1, conversation_id, req.user?.user_id || null,
       text.trim(), lang_override || 'auto', sendAt.toISOString()]
    );
    const row = await db.get('SELECT * FROM scheduled_messages ORDER BY id DESC LIMIT 1');

    const { logAudit } = require('../services/audit');
    await logAudit(req.user?.company_id, req.user?.user_id, 'scheduled_message_created',
      { scheduled_id: row.id, conversation_id, send_at: sendAt.toISOString() });

    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Editar un mensaje programado (solo si sigue pendiente)
router.put('/scheduled/:id', async (req, res) => {
  try {
    const sm = await db.get('SELECT * FROM scheduled_messages WHERE id = ?', [req.params.id]);
    if (!sm) return res.status(404).json({ error: 'No encontrado' });
    if (sm.status !== 'pending') {
      return res.status(409).json({ error: 'Este mensaje ya no se puede editar (estado: ' + sm.status + ')' });
    }
    const { text, lang_override, send_at } = req.body;
    const sendAt = new Date(send_at || sm.send_at);
    if (!text || !text.trim()) return res.status(400).json({ error: 'El texto no puede estar vacío' });
    if (isNaN(sendAt.getTime()) || sendAt <= new Date()) {
      return res.status(400).json({ error: 'La fecha de envío debe ser futura' });
    }
    await db.run(
      `UPDATE scheduled_messages
       SET text_es = ?, lang_override = ?, send_at = ?, updated_at = NOW() WHERE id = ?`,
      [text.trim(), lang_override || sm.lang_override, sendAt.toISOString(), req.params.id]
    );
    const row = await db.get('SELECT * FROM scheduled_messages WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cancelar un mensaje programado (borrado lógico: queda con estado cancelled)
router.delete('/scheduled/:id', async (req, res) => {
  try {
    const sm = await db.get('SELECT * FROM scheduled_messages WHERE id = ?', [req.params.id]);
    if (!sm) return res.status(404).json({ error: 'No encontrado' });
    if (sm.status === 'sent') return res.status(409).json({ error: 'Ya se envió, no se puede cancelar' });

    await db.run(
      `UPDATE scheduled_messages SET status = 'cancelled', updated_at = NOW() WHERE id = ?`,
      [req.params.id]
    );
    const { logAudit } = require('../services/audit');
    await logAudit(req.user?.company_id, req.user?.user_id, 'scheduled_message_cancelled',
      { scheduled_id: sm.id, conversation_id: sm.conversation_id });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CHAT INTERNO (Sprint 5) ────────────────────────────────

// Crear conversación interna con un grupo de empleados
router.post('/internal-conversations', async (req, res) => {
  try {
    const companyId = req.user?.company_id || 1;
    const userId    = req.user?.user_id;
    const { member_ids, name } = req.body;

    if (!Array.isArray(member_ids) || member_ids.length === 0) {
      return res.status(400).json({ error: 'Selecciona al menos un participante' });
    }
    // Incluir al creador si no está en la lista
    const allIds = Array.from(new Set([userId, ...member_ids.map(Number)].filter(Boolean)));

    const conv = await db.get(
      `INSERT INTO conversations (company_id, channel, status, internal_name, updated_at)
       VALUES (?, 'internal', 'open', ?, NOW())
       RETURNING id`,
      [companyId, name || null]
    );

    for (const uid of allIds) {
      await db.run(
        'INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
        [conv.id, uid]
      );
    }

    const { logAudit } = require('../services/audit');
    await logAudit(companyId, userId, 'internal_conv_created',
      { conv_id: conv.id, members: allIds });

    const io = req.app.get('io');
    if (io) io.emit('conv_list_changed');

    res.json({ id: conv.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Miembros de una conversación interna
router.get('/conversations/:id/members', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT u.id, u.first_name, u.last_name, u.role, p.name AS position_name
       FROM conversation_participants cp
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN positions p ON p.id = u.position_id
       WHERE cp.conversation_id = ?
       ORDER BY u.last_name, u.first_name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TRAZABILIDAD DE LECTURA (Sprint 5) ────────────────────

// Marcar mensajes como leídos (batch)
router.post('/messages/mark-read', async (req, res) => {
  try {
    const { message_ids } = req.body;
    if (!Array.isArray(message_ids) || !message_ids.length) return res.json({ ok: true });

    const userId    = req.user?.user_id;
    const companyId = req.user?.company_id || 1;

    for (const mid of message_ids) {
      await db.run(
        `INSERT INTO message_reads (message_id, user_id, company_id)
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        [mid, userId, companyId]
      );
    }

    // Obtener los reads recién insertados para broadcast
    const placeholders = message_ids.map(() => '?').join(',');
    const reads = await db.all(
      `SELECT mr.message_id, mr.user_id, mr.read_at, u.first_name, u.last_name
       FROM message_reads mr JOIN users u ON u.id = mr.user_id
       WHERE mr.message_id IN (${placeholders}) AND mr.user_id = ?`,
      [...message_ids, userId]
    );

    const io = req.app.get('io');
    if (io && reads.length) {
      // Obtener conv_id del primer mensaje para saber a qué sala emitir
      const msg = await db.get('SELECT conversation_id FROM messages WHERE id = ?', [message_ids[0]]);
      if (msg) {
        io.emit('messages_read', {
          conversation_id: msg.conversation_id,
          reads: reads.map(r => ({
            message_id: r.message_id,
            user_id: r.user_id,
            user_name: `${r.first_name} ${r.last_name || ''}`.trim(),
            read_at: r.read_at,
          })),
        });
      }
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Read receipts de una conversación (para renderizar ✓✓ al abrir el chat)
router.get('/conversations/:id/read-receipts', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT mr.message_id, mr.user_id, mr.read_at, u.first_name, u.last_name
       FROM message_reads mr
       JOIN messages m ON m.id = mr.message_id
       JOIN users u ON u.id = mr.user_id
       WHERE m.conversation_id = ?
       ORDER BY mr.read_at ASC`,
      [req.params.id]
    );
    res.json(rows.map(r => ({
      ...r,
      user_name: `${r.first_name} ${r.last_name || ''}`.trim(),
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CONFIRMACIONES DE TAREAS (Sprint 5) ───────────────────

// Confirmar lectura de una tarea
router.post('/tasks/:id/confirm', async (req, res) => {
  try {
    const userId    = req.user?.user_id;
    const companyId = req.user?.company_id || 1;
    const task = await db.get('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });

    await db.run(
      `INSERT INTO task_confirmations (task_id, user_id, company_id)
       VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      [req.params.id, userId, companyId]
    );

    emitTasksChanged(req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Confirmaciones de una tarea (quién confirmó y cuándo)
router.get('/tasks/:id/confirmations', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT tc.user_id, tc.confirmed_at, u.first_name, u.last_name
       FROM task_confirmations tc JOIN users u ON u.id = tc.user_id
       WHERE tc.task_id = ?
       ORDER BY tc.confirmed_at ASC`,
      [req.params.id]
    );
    res.json(rows.map(r => ({
      ...r,
      user_name: `${r.first_name} ${r.last_name || ''}`.trim(),
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// URL de reservas
router.get('/booking-url', (req, res) => {
  res.json({ url: process.env.BOOKING_URL || 'https://tu-web.com/reservas' });
});

// Clave pública VAPID
router.get('/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || '' });
});

// Guardar suscripción push del gestor
router.post('/push-subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Suscripción inválida' });
  req.app.set('pushSubscription', subscription);
  res.json({ ok: true });
});

// Eliminar suscripción push
router.post('/push-unsubscribe', (req, res) => {
  req.app.set('pushSubscription', null);
  res.json({ ok: true });
});

module.exports = router;
