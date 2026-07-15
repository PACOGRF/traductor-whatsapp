/* ── Autenticación ──────────────────────────────────── */
const authToken = localStorage.getItem('chatlink_token');
if (!authToken) window.location.href = '/login.html';

/* ── Estado de la aplicación ────────────────────────── */
const state = {
  conversations: [],
  activeConvId: null,
  messages: [],
  quickReplies: [],
  tasks: [],
  scheduled: [],          // mensajes programados de la conversación activa
};
let editingScheduledId = null; // id del programado que se está editando en el modal

/* ── Referencias DOM ────────────────────────────────── */
const $ = id => document.getElementById(id);
const convList       = $('conv-list');
const messagesArea   = $('messages-area');
const msgInput       = $('msg-input');
const sendBtn        = $('send-btn');
const quickBar       = $('quick-replies-bar');
const chatPanel      = $('chat-panel');
const sidebar        = $('sidebar');
const welcomeScreen  = $('welcome-screen');
const modeBadge      = $('mode-badge');
const chatGuestName  = $('chat-guest-name');
const chatGuestMeta  = $('chat-guest-meta');
const backBtn        = $('back-btn');
const toast          = $('toast');
const tasksList      = $('tasks-list');

/* ── Socket.io ──────────────────────────────────────── */
const socket = io();

// Unirse a la sala del número activo cuando el servidor lo indique
socket.on('connect', () => {
  const phoneNumberId = window.CHATLINK_PHONE_NUMBER_ID;
  if (phoneNumberId) socket.emit('join_room', phoneNumberId);
});

socket.on('new_message', ({ conversation, message }) => {
  const existing = state.conversations.find(c => c.id === conversation.id);
  if (existing) {
    Object.assign(existing, conversation);
    existing.last_message = message.translated_text || message.original_text;
    existing.last_message_at = message.created_at;
  } else {
    conversation.last_message = message.translated_text || message.original_text;
    conversation.last_message_at = message.created_at;
    state.conversations.unshift(conversation);
  }
  renderConvList();

  if (state.activeConvId === conversation.id) {
    state.messages.push(message);
    renderMessages();
  } else {
    showToast(`💬 Nuevo mensaje de ${conversation.guest_name || conversation.guest_phone}`);
  }
});

socket.on('message_sent', ({ conversation, message }) => {
  if (state.activeConvId === conversation.id) {
    if (!state.messages.find(m => m.id === message.id)) {
      state.messages.push(message);
      renderMessages();
    }
  }
});

// Un mensaje programado se envió: quitarlo de la lista de pendientes
socket.on('scheduled_sent', ({ id, conversation_id }) => {
  if (state.activeConvId === conversation_id) {
    state.scheduled = state.scheduled.filter(s => s.id !== id);
    renderMessages();
  }
  showToast('🕐 Mensaje programado enviado ✓');
});

// Un mensaje programado falló: marcarlo en rojo en el hilo
socket.on('scheduled_failed', ({ id, conversation_id, reason }) => {
  const sm = state.scheduled.find(s => s.id === id);
  if (sm) { sm.status = 'failed'; sm.fail_reason = reason; }
  if (state.activeConvId === conversation_id) renderMessages();
  showToast('⚠️ Falló un mensaje programado: ' + (reason || 'error desconocido'), 5000);
});

/* ── Carga inicial ──────────────────────────────────── */
async function init() {
  const health = await apiFetch('/health');
  if (health && health.mode) {
    modeBadge.textContent = health.mode === 'DEMO' ? 'MODO DEMO' : '● EN VIVO';
    modeBadge.style.background = health.mode === 'DEMO' ? '#ffc107' : '#a3b18a';
    modeBadge.style.color = health.mode === 'DEMO' ? '#333' : 'white';
  }

  await loadConversations();
  await loadQuickReplies();
  await loadTasks();
  await initTelegramPanel();

  // En escritorio el chat siempre visible; en móvil empieza oculto
  if (window.innerWidth > 768) {
    chatPanel.classList.remove('hidden');
  }
}

async function loadConversations() {
  const data = await apiFetch('/api/conversations');
  if (data) { state.conversations = data; renderConvList(); }
}

async function loadQuickReplies() {
  const data = await apiFetch('/api/quick-replies');
  if (data) { state.quickReplies = data; renderQuickReplies(); }
}

async function loadMessages(convId) {
  const data = await apiFetch(`/api/conversations/${convId}/messages`);
  if (data) { state.messages = data; renderMessages(); }
}

async function loadScheduled(convId) {
  const data = await apiFetch(`/api/conversations/${convId}/scheduled`);
  if (data && Array.isArray(data)) { state.scheduled = data; renderMessages(); }
}

/* ── Renderizado: lista de conversaciones ───────────── */
function renderConvList() {
  if (state.conversations.length === 0) {
    convList.innerHTML = `<div class="conv-empty">Aún no hay conversaciones.<br>Usa el panel amarillo de abajo para<br>simular un mensaje de huésped.</div>`;
    return;
  }

  convList.innerHTML = state.conversations.map(c => {
    const initials = (c.guest_name || c.guest_phone || '?')[0].toUpperCase();
    const preview  = c.last_message ? truncate(c.last_message, 40) : 'Sin mensajes';
    const time     = c.last_message_at ? formatTime(c.last_message_at) : '';
    const active   = c.id === state.activeConvId ? 'active' : '';
    return `
      <div class="conv-item ${active}" data-id="${c.id}">
        <div class="conv-avatar">${initials}</div>
        <div class="conv-info">
          <div class="conv-name">
            ${c.channel === 'telegram' ? '<span class="conv-channel" title="Telegram">✈️</span>' : ''}${esc(c.guest_name || c.guest_phone)}
            ${c.guest_language && c.guest_language !== 'es' ? `<span class="conv-lang">${langName(c.guest_language)}</span>` : ''}
          </div>
          <div class="conv-preview">${esc(preview)}</div>
        </div>
        <div class="conv-time">${time}</div>
      </div>`;
  }).join('');

  convList.querySelectorAll('.conv-item').forEach(el => {
    el.addEventListener('click', () => selectConversation(Number(el.dataset.id)));
  });
}

/* ── Renderizado: mensajes ──────────────────────────── */
function renderMessages() {
  if (state.messages.length === 0 && state.scheduled.length === 0) {
    messagesArea.innerHTML = '<div style="text-align:center;color:#aaa;margin-top:2rem;">No hay mensajes aún</div>';
    return;
  }

  let lastDate = null;
  messagesArea.innerHTML = state.messages.map(m => {
    const msgDate = new Date(m.created_at.endsWith('Z') ? m.created_at : m.created_at + 'Z');
    const dateStr = msgDate.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
    let dateDivider = '';
    if (dateStr !== lastDate) {
      lastDate = dateStr;
      dateDivider = `<div class="msg-date-divider"><span>${dateStr}</span></div>`;
    }

    const time = msgDate.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const cls  = m.direction === 'incoming' ? 'incoming' : 'outgoing';

    let mainText, subText;
    if (m.direction === 'incoming') {
      mainText = esc(m.original_text);
      const label = m.language_detected
        ? `Traducido del <strong>${langName(m.language_detected)}</strong> al español`
        : 'Traducido al español';
      subText = m.translated_text ? `
        <div class="msg-translated">
          <span class="msg-lang-label">${label}</span>
          <em>${esc(m.translated_text)}</em>
        </div>` : '';
    } else {
      mainText = esc(m.original_text);
      const conv = state.conversations.find(c => c.id === m.conversation_id);
      const targetLang = conv ? langName(conv.guest_language) : 'idioma del huésped';
      subText = m.translated_text ? `
        <div class="msg-translated">
          <span class="msg-lang-label">Enviado en <strong>${targetLang}</strong></span>
          <em>${esc(m.translated_text)}</em>
        </div>` : '';
    }

    return `${dateDivider}
      <div class="msg-bubble ${cls}" data-msg-id="${m.id}">
        <button class="msg-pin-btn" data-msg-id="${m.id}" title="Añadir a tareas pendientes">📌</button>
        <div class="msg-original">${mainText}</div>
        ${subText}
        <span class="msg-time">${time}</span>
      </div>`;
  }).join('') + renderScheduledHtml();

  // Eventos para los botones de pin
  messagesArea.querySelectorAll('.msg-pin-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const msgId = Number(btn.dataset.msgId);
      const msg  = state.messages.find(m => m.id === msgId);
      const conv = state.conversations.find(c => c.id === state.activeConvId);
      if (msg && conv) addTask(msg, conv);
    });
  });

  // Eventos de los mensajes programados (editar / cancelar)
  messagesArea.querySelectorAll('.sched-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openScheduleModal(Number(btn.dataset.id)))
  );
  messagesArea.querySelectorAll('.sched-del-btn').forEach(btn =>
    btn.addEventListener('click', () => cancelScheduled(Number(btn.dataset.id)))
  );

  messagesArea.scrollTop = messagesArea.scrollHeight;
}

/* ── Renderizado: mensajes programados en el hilo ───── */
function renderScheduledHtml() {
  if (!state.scheduled.length) return '';
  return state.scheduled.map(s => {
    const when = new Date(s.send_at).toLocaleString('es-ES', {
      day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
    });
    const failed = s.status === 'failed';
    const badge  = failed
      ? '❌ Falló el envío programado'
      : `🕐 Programado para el ${when}`;
    const reason = failed && s.fail_reason
      ? `<div class="sched-reason">${esc(s.fail_reason)}</div>` : '';
    const actions = failed
      ? `<div class="sched-actions">
           <button class="sched-edit-btn" data-id="${s.id}">Reprogramar</button>
           <button class="sched-del-btn" data-id="${s.id}">Descartar</button>
         </div>`
      : `<div class="sched-actions">
           <button class="sched-edit-btn" data-id="${s.id}">✏️ Editar</button>
           <button class="sched-del-btn" data-id="${s.id}">✕ Cancelar</button>
         </div>`;
    return `
      <div class="msg-bubble outgoing scheduled ${failed ? 'sched-failed' : ''}" data-sched-id="${s.id}">
        <span class="sched-badge">${badge}</span>
        <div class="msg-original">${esc(s.text_es)}</div>
        ${reason}
        ${actions}
      </div>`;
  }).join('');
}

/* ── Renderizado: quick replies ─────────────────────── */
function renderQuickReplies() {
  quickBar.innerHTML = state.quickReplies.map(qr =>
    `<button class="qr-btn" data-msg="${esc(qr.message_es)}" title="${esc(qr.message_es)}">${esc(qr.title)}</button>`
  ).join('');

  quickBar.querySelectorAll('.qr-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      msgInput.value = btn.dataset.msg;
      msgInput.focus();
      autoResize();
    });
  });
}

/* ── Tareas pendientes ──────────────────────────────── */
async function loadTasks() {
  try {
    const rows = await apiFetch('/api/tasks');
    if (Array.isArray(rows)) { state.tasks = rows; renderTasks(); }
  } catch (e) { console.error('Error cargando tareas', e); }
}

async function addTask(msg, conv) {
  if (state.tasks.find(t => t.msg_id === msg.id)) {
    showToast('Este mensaje ya está en tareas pendientes');
    return;
  }
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + localStorage.getItem('chatlink_token'),
      },
      body: JSON.stringify({
        msg_id: msg.id,
        guest_name: conv.guest_name || conv.guest_phone,
        message_text: msg.original_text || msg.translated_text || '',
      }),
    });
    if (res.status === 409) { showToast('Este mensaje ya está en tareas pendientes'); return; }
    const task = await res.json();
    state.tasks.unshift(task);
    renderTasks();
    showToast('Añadido a tareas pendientes 📌');
  } catch (e) { showToast('Error al guardar tarea'); }
}

async function removeTask(id) {
  try {
    await apiFetch(`/api/tasks/${id}`, { method: 'DELETE' });
    state.tasks = state.tasks.filter(t => t.id !== id);
    renderTasks();
  } catch (e) { showToast('Error al eliminar tarea'); }
}

async function togglePriority(id) {
  try {
    await apiFetch(`/api/tasks/${id}/priority`, { method: 'PATCH' });
    const task = state.tasks.find(t => t.id === id);
    if (task) { task.priority = !task.priority; renderTasks(); }
  } catch (e) { showToast('Error al cambiar prioridad'); }
}

function renderTasks() {
  if (!tasksList) return;
  if (state.tasks.length === 0) {
    tasksList.innerHTML = '<div class="tasks-empty">Sin tareas pendientes.<br>Usa 📌 en los mensajes para añadir.</div>';
    return;
  }

  tasksList.innerHTML = state.tasks.map(t => {
    const date = formatTime(t.created_at);
    const text = t.message_text && t.message_text.length > 80 ? t.message_text.slice(0, 80) + '…' : (t.message_text || '');
    const pClass = t.priority ? 'priority-on' : '';
    return `
      <div class="task-item ${pClass}">
        <div class="task-info">
          <div class="task-name">${esc(t.guest_name)}</div>
          <div class="task-date">${date}</div>
          <div class="task-text">${esc(text)}</div>
        </div>
        <div class="task-estado">
          <button class="task-priority-btn ${pClass}" data-id="${t.id}" title="Marcar prioridad"></button>
          <button class="task-del-btn" data-id="${t.id}" title="Eliminar tarea">🗑</button>
        </div>
      </div>`;
  }).join('');

  tasksList.querySelectorAll('.task-priority-btn').forEach(btn =>
    btn.addEventListener('click', () => togglePriority(Number(btn.dataset.id)))
  );
  tasksList.querySelectorAll('.task-del-btn').forEach(btn =>
    btn.addEventListener('click', () => removeTask(Number(btn.dataset.id)))
  );
}

/* ── Seleccionar conversación ───────────────────────── */
async function selectConversation(id) {
  state.activeConvId = id;
  const conv = state.conversations.find(c => c.id === id);
  if (!conv) return;

  // Cabecera: teléfono + idioma en la misma línea junto a ChatLink
  const langSuffix = conv.guest_language && conv.guest_language !== 'es'
    ? ` · habla ${langName(conv.guest_language)}` : '';
  chatGuestName.textContent = `${conv.guest_phone}${langSuffix}`;

  // Mostrar chat, ocultar bienvenida
  welcomeScreen.style.display = 'none';
  messagesArea.style.display  = 'flex';

  // Móvil: ocultar sidebar, mostrar chat
  if (window.innerWidth <= 768) {
    sidebar.classList.add('hidden');
    chatPanel.classList.remove('hidden');
  }

  renderConvList();
  state.scheduled = [];
  await loadMessages(id);
  await loadScheduled(id);
}

/* ── Enviar respuesta ───────────────────────────────── */
async function sendReply() {
  const text = msgInput.value.trim();
  if (!text || !state.activeConvId) return;

  sendBtn.disabled = true;
  msgInput.value = '';
  autoResize();

  const langOverride = $('lang-override').value;
  const conv = state.conversations.find(c => c.id === state.activeConvId);
  const phoneNumberId = conv?.phone_number_id || window.CHATLINK_PHONE_NUMBER_ID || null;
  socket.emit('manager_reply', { conversationId: state.activeConvId, text, langOverride, phoneNumberId });
  sendBtn.disabled = false;
  msgInput.focus();
}

/* ── Programar mensaje ──────────────────────────────── */
const scheduleModal   = $('schedule-modal');
const scheduleOverlay = $('schedule-overlay');

// Convierte una fecha a formato del input datetime-local (hora local)
function toLocalInputValue(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

// Abre el modal. Sin id → programar nuevo (con el texto de la caja);
// con id → editar/reprogramar uno existente.
function openScheduleModal(schedId = null) {
  if (!state.activeConvId) { showToast('Selecciona una conversación primero'); return; }

  editingScheduledId = schedId;
  const textArea = $('schedule-text');
  const dtInput  = $('schedule-datetime');

  if (schedId) {
    const sm = state.scheduled.find(s => s.id === schedId);
    if (!sm) return;
    textArea.value = sm.text_es;
    const sendAt = new Date(sm.send_at);
    dtInput.value = toLocalInputValue(sendAt > new Date() ? sendAt : new Date(Date.now() + 3600000));
    $('schedule-title').textContent = '🕐 Editar mensaje programado';
    $('schedule-save').textContent  = 'Guardar cambios';
  } else {
    textArea.value = msgInput.value.trim();
    dtInput.value  = toLocalInputValue(new Date(Date.now() + 3600000)); // por defecto: dentro de 1h
    $('schedule-title').textContent = '🕐 Programar mensaje';
    $('schedule-save').textContent  = 'Programar';
  }

  dtInput.min = toLocalInputValue(new Date());
  updateScheduleWarning();
  scheduleModal.classList.remove('hidden');
  scheduleOverlay.classList.remove('hidden');
  textArea.focus();
}

function closeScheduleModal() {
  scheduleModal.classList.add('hidden');
  scheduleOverlay.classList.add('hidden');
  editingScheduledId = null;
}

// Aviso de la ventana de 24h de WhatsApp: si a la hora elegida el cliente
// llevará más de 24h sin escribir, el envío puede fallar (Telegram no tiene límite)
function updateScheduleWarning() {
  const warning = $('schedule-warning');
  const conv = state.conversations.find(c => c.id === state.activeConvId);
  const value = $('schedule-datetime').value;
  if (!conv || !value || conv.channel === 'telegram') {
    warning.classList.add('hidden');
    return;
  }
  const sendAt = new Date(value);
  const lastIncoming = [...state.messages].reverse().find(m => m.direction === 'incoming');
  let windowClosed;
  if (!lastIncoming) {
    windowClosed = true; // nunca ha escrito: la ventana no está abierta
  } else {
    const ts = lastIncoming.created_at.endsWith('Z') ? lastIncoming.created_at : lastIncoming.created_at + 'Z';
    windowClosed = sendAt.getTime() > new Date(ts).getTime() + 24 * 3600 * 1000;
  }
  warning.classList.toggle('hidden', !windowClosed);
}

async function saveScheduled() {
  const text  = $('schedule-text').value.trim();
  const value = $('schedule-datetime').value;
  if (!text)  { showToast('Escribe el mensaje a programar'); return; }
  if (!value) { showToast('Elige fecha y hora de envío'); return; }
  const sendAt = new Date(value);
  if (sendAt <= new Date()) { showToast('La fecha debe ser futura'); return; }

  const body = {
    conversation_id: state.activeConvId,
    text,
    lang_override: $('lang-override').value,
    send_at: sendAt.toISOString(),
  };

  let result;
  if (editingScheduledId) {
    result = await apiFetch(`/api/scheduled/${editingScheduledId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Al reprogramar un fallido, el servidor lo rechaza (solo edita pendientes):
    // en ese caso se crea uno nuevo y se descarta el fallido
    if (!result) {
      const old = state.scheduled.find(s => s.id === editingScheduledId);
      if (old && old.status === 'failed') {
        result = await apiFetch('/api/scheduled', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (result) await apiFetch(`/api/scheduled/${old.id}`, { method: 'DELETE' });
      }
    }
  } else {
    result = await apiFetch('/api/scheduled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  if (!result) { showToast('No se pudo guardar el mensaje programado'); return; }

  if (!editingScheduledId) { msgInput.value = ''; autoResize(); }
  closeScheduleModal();
  await loadScheduled(state.activeConvId);
  const when = sendAt.toLocaleString('es-ES', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  showToast(`🕐 Mensaje programado para el ${when}`);
}

async function cancelScheduled(id) {
  const sm = state.scheduled.find(s => s.id === id);
  const verb = sm && sm.status === 'failed' ? 'descartar este mensaje fallido' : 'cancelar este mensaje programado';
  if (!confirm('¿Seguro que quieres ' + verb + '?')) return;
  const result = await apiFetch(`/api/scheduled/${id}`, { method: 'DELETE' });
  if (result) {
    state.scheduled = state.scheduled.filter(s => s.id !== id);
    renderMessages();
    showToast(sm && sm.status === 'failed' ? 'Mensaje descartado' : 'Envío programado cancelado');
  }
}

$('schedule-btn').addEventListener('click', () => openScheduleModal());
$('schedule-save').addEventListener('click', saveScheduled);
$('schedule-cancel').addEventListener('click', closeScheduleModal);
$('schedule-close').addEventListener('click', closeScheduleModal);
scheduleOverlay.addEventListener('click', closeScheduleModal);
$('schedule-datetime').addEventListener('change', updateScheduleWarning);
$('schedule-datetime').addEventListener('input', updateScheduleWarning);

/* ── Canal Telegram (configuración, solo GESTOR) ────── */
async function initTelegramPanel() {
  const panel = $('tg-panel');
  if (!panel) return;
  // Solo el gestor ve la configuración del canal
  if (localStorage.getItem('chatlink_role') !== 'manager') return;
  panel.classList.remove('hidden');

  const cfg = await apiFetch('/api/telegram/config');
  if (cfg && cfg.configured) showTelegramStatus(cfg);
}

function showTelegramStatus(cfg) {
  $('tg-status').textContent = cfg.bot_username ? ('conectado: @' + cfg.bot_username) : 'conectado';
  if (cfg.link) {
    const info = $('tg-info');
    info.innerHTML = `✅ Tus clientes ya pueden escribirte en <a href="${cfg.link}" target="_blank">${cfg.link}</a> — comparte ese enlace (o su QR) para invitarles.`;
    info.classList.remove('hidden');
  }
}

$('tg-save-btn').addEventListener('click', async () => {
  const token = $('tg-token').value.trim();
  if (!token) { showToast('Pega el token que te dio @BotFather'); return; }

  const btn = $('tg-save-btn');
  btn.disabled = true;
  btn.textContent = 'Conectando…';

  try {
    const res = await fetch('/api/telegram/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + localStorage.getItem('chatlink_token'),
      },
      body: JSON.stringify({ bot_token: token }),
    });
    const data = await res.json();
    if (res.ok) {
      showTelegramStatus(data);
      $('tg-token').value = '';
      showToast('✈️ Bot de Telegram conectado ✓');
    } else {
      showToast(data.error || 'No se pudo conectar el bot', 4000);
    }
  } catch {
    showToast('Error de conexión al configurar Telegram');
  }
  btn.disabled = false;
  btn.textContent = 'Conectar bot';
});

/* ── Demo ───────────────────────────────────────────── */
$('demo-send-btn').addEventListener('click', async () => {
  const phone = $('demo-phone').value.trim() || '+447911123456';
  const name  = $('demo-name').value.trim()  || 'Huésped Demo';
  const text  = $('demo-text').value.trim();
  if (!text) return showToast('Escribe un mensaje de demo primero');

  const res = await apiFetch('/api/demo/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, name, text }),
  });
  if (res) showToast('Mensaje de demo enviado ✓');
});

/* ── Panel de plantillas ────────────────────────────── */
const templatesPanel   = $('templates-panel');
const templatesOverlay = $('templates-overlay');

function openTemplates() {
  templatesPanel.classList.remove('hidden');
  templatesOverlay.classList.remove('hidden');
  renderTemplatesPanel();
}
function closeTemplates() {
  templatesPanel.classList.add('hidden');
  templatesOverlay.classList.add('hidden');
}

$('templates-btn').addEventListener('click', openTemplates);
$('templates-close').addEventListener('click', closeTemplates);
$('templates-overlay').addEventListener('click', closeTemplates);

function renderTemplatesPanel() {
  const list = $('templates-list');
  if (state.quickReplies.length === 0) {
    list.innerHTML = '<div style="padding:1rem;color:#aaa;text-align:center;">No hay plantillas aún</div>';
    return;
  }
  list.innerHTML = state.quickReplies.map(qr => `
    <div class="tpl-item">
      <div class="tpl-item-info">
        <div class="tpl-item-title">${esc(qr.title)}</div>
        <div class="tpl-item-msg">${esc(qr.message_es)}</div>
      </div>
      <button class="tpl-use-btn" data-msg="${esc(qr.message_es)}">Usar</button>
      <button class="tpl-del-btn" data-id="${qr.id}" title="Eliminar">✕</button>
    </div>
  `).join('');

  list.querySelectorAll('.tpl-use-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      msgInput.value = btn.dataset.msg;
      msgInput.focus();
      autoResize();
      closeTemplates();
    });
  });

  list.querySelectorAll('.tpl-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta plantilla?')) return;
      await apiFetch(`/api/quick-replies/${btn.dataset.id}`, { method: 'DELETE' });
      state.quickReplies = state.quickReplies.filter(qr => qr.id !== Number(btn.dataset.id));
      renderQuickReplies();
      renderTemplatesPanel();
    });
  });
}

$('new-tpl-save').addEventListener('click', async () => {
  const title      = $('new-tpl-title').value.trim();
  const message_es = $('new-tpl-msg').value.trim();
  if (!title || !message_es) return showToast('Rellena el nombre y el mensaje');
  const newQr = await apiFetch('/api/quick-replies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, message_es }),
  });
  if (newQr) {
    state.quickReplies.push(newQr);
    renderQuickReplies();
    renderTemplatesPanel();
    $('new-tpl-title').value = '';
    $('new-tpl-msg').value = '';
    showToast('Plantilla guardada ✓');
  }
});

/* ── Botón volver (móvil) ───────────────────────────── */
backBtn.addEventListener('click', () => {
  if (window.innerWidth <= 768) {
    chatPanel.classList.add('hidden');
    sidebar.classList.remove('hidden');
  }
  welcomeScreen.style.display = 'flex';
  messagesArea.style.display  = 'none';
  chatGuestName.textContent   = 'Panel del Gestor';
  chatGuestMeta.textContent   = '';
  state.activeConvId = null;
  renderConvList();
});

/* ── Input ──────────────────────────────────────────── */
msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
});
msgInput.addEventListener('input', autoResize);
sendBtn.addEventListener('click', sendReply);

function autoResize() {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
}

/* ── Nombres de idioma ──────────────────────────────── */
const LANG_NAMES = {
  en: 'inglés', fr: 'francés', de: 'alemán', it: 'italiano',
  pt: 'portugués', nl: 'neerlandés', ru: 'ruso', zh: 'chino',
  ja: 'japonés', ko: 'coreano', ar: 'árabe', pl: 'polaco',
  sv: 'sueco', da: 'danés', fi: 'finlandés', nb: 'noruego',
  cs: 'checo', ro: 'rumano', tr: 'turco', uk: 'ucraniano',
  el: 'griego', hu: 'húngaro', sk: 'eslovaco', bg: 'búlgaro',
  hr: 'croata', ca: 'catalán/valenciano', eu: 'euskera', gl: 'gallego',
};
function langName(code) { return LANG_NAMES[code] || code || 'idioma desconocido'; }

/* ── Utilidades ─────────────────────────────────────── */
async function apiFetch(url, options = {}) {
  try {
    const token = localStorage.getItem('chatlink_token');
    options.headers = { ...(options.headers || {}), 'Authorization': `Bearer ${token}` };
    const r = await fetch(url, options);
    if (r.status === 401) { localStorage.removeItem('chatlink_token'); window.location.href = '/login.html'; return null; }
    if (r.status === 403) {
      const body = await r.clone().json().catch(() => ({}));
      if (body.code === 'MUST_CHANGE_PASSWORD') { window.location.href = '/change-password.html'; return null; }
    }
    if (!r.ok) throw new Error(r.statusText);
    return r.json();
  } catch (e) {
    console.error('apiFetch error:', url, e);
    return null;
  }
}

function showToast(msg, duration = 2500) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, n) {
  return str && str.length > n ? str.slice(0, n) + '…' : str;
}

function formatTime(iso) {
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  return isToday
    ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

/* ── Tareas pendientes: navegación móvil ────────────── */
const tasksMobileBtn = $('tasks-mobile-btn');
const tasksBackBtn   = $('tasks-back-btn');
const tasksPanel     = $('tasks-panel');

if (tasksMobileBtn) {
  tasksMobileBtn.addEventListener('click', () => {
    sidebar.classList.add('hidden');
    tasksPanel.classList.add('mobile-visible');
  });
}

if (tasksBackBtn) {
  tasksBackBtn.addEventListener('click', () => {
    tasksPanel.classList.remove('mobile-visible');
    sidebar.classList.remove('hidden');
  });
}

/* ── Arrancar ───────────────────────────────────────── */
// Ocultar messages-area hasta que se seleccione conversación
messagesArea.style.display = 'none';
init();

// Recargar tareas cuando el usuario vuelve a la pestaña/app
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadTasks();
});
