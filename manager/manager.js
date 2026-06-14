/* ── Estado de la aplicación ────────────────────────── */
const state = {
  conversations: [],
  activeConvId: null,
  messages: [],
  quickReplies: [],
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

/* ── Socket.io ──────────────────────────────────────── */
const socket = io();

socket.on('new_message', ({ conversation, message }) => {
  // Actualizar o añadir la conversación en la lista
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

  // Si es la conversación activa, añadir el mensaje
  if (state.activeConvId === conversation.id) {
    state.messages.push(message);
    renderMessages();
  } else {
    showToast(`💬 Nuevo mensaje de ${conversation.guest_name || conversation.guest_phone}`);
  }
});

socket.on('message_sent', ({ conversation, message }) => {
  if (state.activeConvId === conversation.id) {
    // Evitar duplicados (puede que ya lo hayamos añadido optimistamente)
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
    modeBadge.style.background = health.mode === 'DEMO' ? '#ffc107' : '#25d366';
    modeBadge.style.color = health.mode === 'DEMO' ? '#333' : 'white';
  }

  await loadConversations();
  await loadQuickReplies();
}

async function loadConversations() {
  const data = await apiFetch('/api/conversations');
  if (data) {
    state.conversations = data;
    renderConvList();
  }
}

async function loadQuickReplies() {
  const data = await apiFetch('/api/quick-replies');
  if (data) {
    state.quickReplies = data;
    renderQuickReplies();
  }
}

async function loadMessages(convId) {
  const data = await apiFetch(`/api/conversations/${convId}/messages`);
  if (data) {
    state.messages = data;
    renderMessages();
  }
}

/* ── Renderizado ────────────────────────────────────── */
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

function renderMessages() {
  if (state.messages.length === 0) {
    messagesArea.innerHTML = '<div style="text-align:center;color:#aaa;margin-top:2rem;">No hay mensajes aún</div>';
    return;
  }

  let lastDate = null;
  messagesArea.innerHTML = state.messages.map(m => {
    const msgDate  = new Date(m.created_at.endsWith('Z') ? m.created_at : m.created_at + 'Z');
    const dateStr  = msgDate.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
    let dateDivider = '';
    if (dateStr !== lastDate) {
      lastDate = dateStr;
      dateDivider = `<div class="msg-date-divider"><span>${dateStr}</span></div>`;
    }

    const time = msgDate.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const cls  = m.direction === 'incoming' ? 'incoming' : 'outgoing';

    let mainText, subText;
    if (m.direction === 'incoming') {
      // Burbuja del huésped: original arriba, etiqueta + traducción abajo
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
      // Burbuja del gestor: texto en español arriba, traducción enviada abajo
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
      <div class="msg-bubble ${cls}">
        <div class="msg-original">${mainText}</div>
        ${subText}
        <span class="msg-time">${time}</span>
      </div>`;
  }).join('');

  messagesArea.scrollTop = messagesArea.scrollHeight;
}

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

/* ── Seleccionar conversación ───────────────────────── */
async function selectConversation(id) {
  state.activeConvId = id;
  const conv = state.conversations.find(c => c.id === id);
  if (!conv) return;

  chatGuestName.textContent = conv.guest_name || conv.guest_phone;
  const langLabel = conv.guest_language && conv.guest_language !== 'es'
    ? `${conv.guest_phone} · habla ${langName(conv.guest_language)}`
    : conv.guest_phone;
  chatGuestMeta.textContent = langLabel;

  // Móvil: ocultar sidebar, mostrar chat
  sidebar.classList.add('hidden');
  chatPanel.classList.remove('hidden');
  welcomeScreen.style.display = 'none';

  renderConvList(); // resalta la activa
  await loadMessages(id);
}

/* ── Enviar respuesta del gestor ────────────────────── */
async function sendReply() {
  const text = msgInput.value.trim();
  if (!text || !state.activeConvId) return;

  sendBtn.disabled = true;
  msgInput.value = '';
  autoResize();

  socket.emit('manager_reply', { conversationId: state.activeConvId, text });
  sendBtn.disabled = false;
  msgInput.focus();
}

/* ── Demo: simular mensaje de huésped ───────────────── */
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
  const title = $('new-tpl-title').value.trim();
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

/* ── Volver al sidebar en móvil ─────────────────────── */
backBtn.addEventListener('click', () => {
  chatPanel.classList.add('hidden');
  sidebar.classList.remove('hidden');
  welcomeScreen.style.display = 'flex';
  state.activeConvId = null;
});

/* ── Input: enviar con Enter (Shift+Enter = nueva línea) */
msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendReply();
  }
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
};
function langName(code) {
  return LANG_NAMES[code] || code || 'idioma desconocido';
}

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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
init();
