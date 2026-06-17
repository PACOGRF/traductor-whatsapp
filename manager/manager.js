/* ── Estado de la aplicación ────────────────────────── */
const state = {
  conversations: [],
  activeConvId: null,
  messages: [],
  quickReplies: [],
  tasks: JSON.parse(localStorage.getItem('chatlink_tasks') || '[]'),
};

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
  renderTasks();

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
            ${esc(c.guest_name || c.guest_phone)}
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
  if (state.messages.length === 0) {
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
  }).join('');

  // Eventos para los botones de pin
  messagesArea.querySelectorAll('.msg-pin-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const msgId = Number(btn.dataset.msgId);
      const msg  = state.messages.find(m => m.id === msgId);
      const conv = state.conversations.find(c => c.id === state.activeConvId);
      if (msg && conv) addTask(msg, conv);
    });
  });

  messagesArea.scrollTop = messagesArea.scrollHeight;
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
function saveTasks() {
  localStorage.setItem('chatlink_tasks', JSON.stringify(state.tasks));
}

function addTask(msg, conv) {
  if (state.tasks.find(t => t.msgId === msg.id)) {
    showToast('Este mensaje ya está en tareas pendientes');
    return;
  }
  state.tasks.unshift({
    id: Date.now(),
    msgId: msg.id,
    guestName: conv.guest_name || conv.guest_phone,
    createdAt: msg.created_at,
    text: msg.original_text || msg.translated_text || '',
    priority: false,
  });
  saveTasks();
  renderTasks();
  showToast('Añadido a tareas pendientes 📌');
}

function removeTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  saveTasks();
  renderTasks();
}

function togglePriority(id) {
  const task = state.tasks.find(t => t.id === id);
  if (task) { task.priority = !task.priority; saveTasks(); renderTasks(); }
}

function renderTasks() {
  if (!tasksList) return;
  if (state.tasks.length === 0) {
    tasksList.innerHTML = '<div class="tasks-empty">Sin tareas pendientes.<br>Usa 📌 en los mensajes para añadir.</div>';
    return;
  }

  tasksList.innerHTML = state.tasks.map(t => {
    const date = formatTime(t.createdAt);
    const text = t.text && t.text.length > 80 ? t.text.slice(0, 80) + '…' : (t.text || '');
    const pClass = t.priority ? 'priority-on' : '';
    return `
      <div class="task-item ${pClass}">
        <div class="task-info">
          <div class="task-name">${esc(t.guestName)}</div>
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
  await loadMessages(id);
}

/* ── Enviar respuesta ───────────────────────────────── */
async function sendReply() {
  const text = msgInput.value.trim();
  if (!text || !state.activeConvId) return;

  sendBtn.disabled = true;
  msgInput.value = '';
  autoResize();

  const langOverride = $('lang-override').value;
  socket.emit('manager_reply', { conversationId: state.activeConvId, text, langOverride });
  sendBtn.disabled = false;
  msgInput.focus();
}

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
async function apiFetch(url, options) {
  try {
    const r = await fetch(url, options);
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

/* ── Arrancar ───────────────────────────────────────── */
// Ocultar messages-area hasta que se seleccione conversación
messagesArea.style.display = 'none';
init();
