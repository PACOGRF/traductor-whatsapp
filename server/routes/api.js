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

// Listar todas las conversaciones
router.get('/conversations', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT c.*, ct.name AS contact_name, ct.phone AS contact_phone, ct.group_id AS contact_group_id,
        (SELECT m.translated_text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_at,
        (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_direction
      FROM conversations c
      LEFT JOIN contacts ct ON ct.id = c.contact_id
      ORDER BY last_message_at DESC
    `);
    // Marca "sin responder": el último mensaje es del cliente y supera el umbral de la empresa
    const company = await db.get('SELECT alert_hours FROM companies WHERE id = 1');
    const alertHours = (company && company.alert_hours) || 4;
    const now = Date.now();
    // Visibilidad por rol (D1/D2): los empleados solo ven sus grupos
    const { getVisibility, convAccess } = require('../services/visibility');
    const vis = await getVisibility(req.user);
    const result = [];
    for (const r of rows) {
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
    if (req.user?.role === 'employee') {
      const { accessForConversation } = require('../services/visibility');
      const { access } = await accessForConversation(req.user, req.params.id);
      if (access === 'none') return res.status(403).json({ error: 'Sin acceso a esta conversación' });
    }
    const rows = await db.all(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
      `SELECT id, first_name, last_name, role FROM users
       WHERE company_id = ? AND active = true
       ORDER BY last_name, first_name`,
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
    const rows = await db.all(
      `SELECT t.*,
              c.guest_name  AS conv_guest_name,
              c.channel     AS conv_channel,
              ct.name       AS contact_name,
              u.first_name  AS assigned_first_name,
              u.last_name   AS assigned_last_name
       FROM tasks t
       LEFT JOIN conversations c ON c.id = t.conversation_id
       LEFT JOIN contacts ct     ON ct.id = t.contact_id
       LEFT JOIN users u         ON u.id = t.assigned_to
       WHERE t.deleted_at IS NULL
       ORDER BY t.id DESC`
    );
    res.json(rows.map(r => ({
      ...r,
      client_label: r.contact_name || r.conv_guest_name || r.guest_name || '—',
      assigned_label: r.assigned_first_name ? `${r.assigned_first_name} ${r.assigned_last_name || ''}`.trim() : null,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Crear tarea (desde la chincheta 📌 o desde la pantalla TAREAS)
router.post('/tasks', async (req, res) => {
  try {
    const { conversation_id, anchored_message_id, text, assigned_to,
            notify_also, high_priority, remind_at, due_at } = req.body;
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
                          remind_at, due_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [req.user?.company_id || 1, contactId, conversation_id || null, anchored_message_id || null,
       anchored_message_id || null, guestLabel, text.trim(),
       assigned_to || null, notify_also && notify_also.length ? notify_also : null,
       !!high_priority, remind_at || null, due_at || null, req.user?.user_id || null]
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

    const { text, assigned_to, notify_also, high_priority, remind_at, due_at } = req.body;
    // Si cambia la alerta, se reactiva el aviso del cron
    const remindChanged = (remind_at || null) !== (task.remind_at ? new Date(task.remind_at).toISOString() : null);

    await db.run(
      `UPDATE tasks SET message_text = ?, assigned_to = ?, notify_also = ?,
              high_priority = ?, remind_at = ?, due_at = ?
              ${remindChanged ? ', remind_sent_at = NULL' : ''}
       WHERE id = ?`,
      [text !== undefined ? text : task.message_text,
       assigned_to !== undefined ? assigned_to : task.assigned_to,
       notify_also !== undefined ? (notify_also && notify_also.length ? notify_also : null) : task.notify_also,
       high_priority !== undefined ? !!high_priority : task.high_priority,
       remind_at !== undefined ? remind_at : task.remind_at,
       due_at !== undefined ? due_at : task.due_at,
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
      SELECT c.id, c.guest_name, c.guest_phone, ct.name AS contact_name,
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_at,
        (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_direction
      FROM conversations c
      LEFT JOIN contacts ct ON ct.id = c.contact_id
    `);
    for (const c of convs) {
      if (c.last_direction !== 'incoming' || !c.last_message_at) continue;
      const hours = (now - new Date(c.last_message_at).getTime()) / 3600000;
      if (hours < alertHours) continue;
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
