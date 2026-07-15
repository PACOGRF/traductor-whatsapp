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
      SELECT c.*, ct.name AS contact_name, ct.phone AS contact_phone,
        (SELECT m.translated_text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_at
      FROM conversations c
      LEFT JOIN contacts ct ON ct.id = c.contact_id
      ORDER BY last_message_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mensajes de una conversación
router.get('/conversations/:id/messages', async (req, res) => {
  try {
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

// ── Tareas pendientes ──────────────────────────────────
router.get('/tasks', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM tasks ORDER BY id DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/tasks', async (req, res) => {
  try {
    const { msg_id, guest_name, message_text } = req.body;
    const exists = await db.get('SELECT id FROM tasks WHERE msg_id = ?', [msg_id]);
    if (exists) return res.status(409).json({ error: 'Ya existe' });
    await db.run(
      'INSERT INTO tasks (msg_id, guest_name, message_text) VALUES (?, ?, ?)',
      [msg_id, guest_name, message_text]
    );
    const row = await db.get('SELECT * FROM tasks ORDER BY id DESC LIMIT 1');
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/tasks/:id/priority', async (req, res) => {
  try {
    const task = await db.get('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'No encontrado' });
    await db.run('UPDATE tasks SET priority = ? WHERE id = ?', [!task.priority, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/tasks/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM tasks WHERE id = ?', [req.params.id]);
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
