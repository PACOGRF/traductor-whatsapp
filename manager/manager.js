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
  users: [],              // empleados de la empresa (desplegables de responsable)
  alerts: [],             // alertas vencidas globales (columna derecha, abajo)
  notes: [],              // notas ancladas de la conversación activa (D8)
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

/* ── Socket.io (con identidad: permisos por rol, Sprint 2) ── */
const socket = io({ auth: { token: authToken } });

socket.on('connect_error', (err) => {
  // Token caducado o inválido: volver al login
  if (err && /No autorizado/i.test(err.message || '')) {
    localStorage.removeItem('chatlink_token');
    window.location.href = '/login.html';
  }
});

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
  // Al responder se apaga la alerta "sin responder": refrescar badge y panel de alertas
  const conv = state.conversations.find(c => c.id === conversation.id);
  if (conv) {
    conv.last_direction = 'outgoing';
    conv.unanswered_hours = null;
    renderConvList();
  }
  loadAlerts();
});

// Ficha de cliente guardada o vinculada (tras confirmar, o cliente ya conocido)
socket.on('contact_saved', ({ conversation_id, name, phone }) => {
  const conv = state.conversations.find(c => c.id === conversation_id);
  if (conv) {
    conv.contact_name = name;
    conv.contact_phone = phone;
    conv.pending_contact = null;
    renderConvList();
    // Refrescar la cabecera si es la conversación abierta
    if (state.activeConvId === conversation_id) {
      const langSuffix = conv.guest_language && conv.guest_language !== 'es'
        ? ` · habla ${langName(conv.guest_language)}` : '';
      chatGuestName.textContent = `✈️ ${name}${phone ? ' · ' + phone : ''} · Telegram${langSuffix}`;
    }
  }
  showToast(`✅ Cliente en fichas: ${name} (${phone})`, 5000);
});

// Un cliente compartió su contacto: preguntar al gestor si crear la ficha
socket.on('contact_pending', ({ conversation_id, name, phone }) => {
  const conv = state.conversations.find(c => c.id === conversation_id);
  if (conv) conv.pending_contact = { name, phone };
  openContactModal(conversation_id, { name, phone });
});

// Las tareas o alertas cambiaron en el servidor (otro panel, el cron…)
socket.on('tasks_changed', async () => { await loadTasks(); await loadAlerts(); });

// Nota anclada nueva en la conversación abierta
socket.on('note_added', ({ message_id }) => {
  if (state.messages.find(m => m.id === message_id)) loadNotes(state.activeConvId);
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
  await loadUsers();
  await loadTasks();
  await loadAlerts();
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
      <div class="conv-item ${active}" data-id="${c.id}" data-name="${esc(c.contact_name || c.guest_name || '')}" data-phone="${esc(c.guest_phone || '')}">
        <div class="conv-avatar">${initials}</div>
        <div class="conv-info">
          <div class="conv-name">
            ${c.channel === 'telegram' ? '<span class="conv-channel" title="Telegram">✈️</span>' : ''}${esc(c.contact_name || c.guest_name || c.guest_phone)}
            ${c.unanswered_hours ? `<span class="conv-unanswered" title="Sin responder">⚠️ ${c.unanswered_hours}h</span>` : ''}
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

    // Notas ancladas a este mensaje (D8): post-its en el hilo
    const notesHtml = (state.notes || []).filter(n => n.message_id === m.id).map(n => `
      <div class="msg-note">
        <button class="note-del" data-id="${n.id}" title="Eliminar nota">✕</button>
        <span class="note-author">📝 ${esc(n.author || 'Equipo')}</span>${esc(n.text)}
      </div>`).join('');

    // Archivos adjuntos (Sprint 5): miniatura, reproductor o enlace según el tipo
    let mediaHtml = '';
    if (m.storage_path) {
      const u = m.signed_url || '#';
      if (m.media_type === 'image') {
        mediaHtml = `<a href="${u}" target="_blank" rel="noopener"><img class="msg-img" src="${u}" alt="${esc(m.media_url || 'imagen')}"></a>`;
      } else if (m.media_type === 'video') {
        mediaHtml = `<video class="msg-video" src="${u}" controls preload="metadata"></video>`;
      } else if (m.media_type === 'audio') {
        mediaHtml = `<audio class="msg-audio" src="${u}" controls></audio>`;
      } else {
        mediaHtml = `<a class="msg-doc" href="${u}" target="_blank" rel="noopener">📄 ${esc(m.media_url || 'documento')}</a>`;
      }
      // Si el texto es solo la etiqueta automática del archivo, no repetirlo
      if (m.original_text === `📎 ${m.media_url}`) { mainText = ''; subText = ''; }
    }

    return `${dateDivider}
      <div class="msg-bubble ${cls}" data-msg-id="${m.id}">
        <button class="msg-pin-btn" data-msg-id="${m.id}" title="Crear tarea o nota de este mensaje">📌</button>
        ${mediaHtml}
        ${mainText ? `<div class="msg-original">${mainText}</div>` : ''}
        ${subText}
        <span class="msg-time">${time}</span>
      </div>${notesHtml}`;
  }).join('') + renderScheduledHtml();

  // La chincheta 📌 abre la ventana de tarea/nota
  messagesArea.querySelectorAll('.msg-pin-btn').forEach(btn => {
    btn.addEventListener('click', () => openTaskModal({ messageId: Number(btn.dataset.msgId) }));
  });

  // Borrar notas ancladas
  messagesArea.querySelectorAll('.note-del').forEach(btn => {
    btn.addEventListener('click', () => deleteNote(Number(btn.dataset.id)));
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

/* ── Tareas 2.0 (Sprint 4) ──────────────────────────── */
const STATUS_LABELS = { pending: 'PENDIENTE', in_progress: 'EN CURSO', done: 'REALIZADA' };
const NEXT_STATUS   = { pending: 'in_progress', in_progress: 'done', done: 'pending' };

async function loadUsers() {
  const rows = await apiFetch('/api/users');
  if (Array.isArray(rows)) state.users = rows;
}

async function loadTasks() {
  const rows = await apiFetch('/api/tasks');
  if (Array.isArray(rows)) { state.tasks = rows; renderConvTasks(); renderTasksScreen(); }
}

async function loadAlerts() {
  const rows = await apiFetch('/api/alerts');
  if (Array.isArray(rows)) { state.alerts = rows; renderAlerts(); }
}

async function loadNotes(convId) {
  const rows = await apiFetch(`/api/conversations/${convId}/notes`);
  if (Array.isArray(rows)) { state.notes = rows; renderMessages(); }
}

function isOverdue(t) {
  if (t.status === 'done') return false;
  const now = Date.now();
  return (t.due_at && new Date(t.due_at).getTime() < now) ||
         (t.remind_at && new Date(t.remind_at).getTime() < now);
}

function fmtDT(v) {
  if (!v) return '';
  return new Date(v).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function changeStatus(id, current) {
  const next = NEXT_STATUS[current] || 'pending';
  const r = await apiFetch(`/api/tasks/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: next }),
  });
  if (r) { await loadTasks(); await loadAlerts(); showToast('Estado: ' + STATUS_LABELS[next]); }
  else showToast('No se pudo cambiar el estado (¿eres el responsable?)');
}

async function deleteTask(id) {
  if (!confirm('¿Eliminar esta tarea? (quedará en el histórico)')) return;
  const r = await apiFetch(`/api/tasks/${id}`, { method: 'DELETE' });
  if (r) { await loadTasks(); await loadAlerts(); showToast('Tarea eliminada 🗑️'); }
}

function taskCardHtml(t, showClient) {
  const overdue = isOverdue(t);
  return `
    <div class="task-card ${overdue ? 'overdue-card' : ''}">
      <div class="tc-top">
        <span class="tc-main">${t.high_priority ? '<span class="prio-dot">🔴</span> ' : ''}${showClient && t.client_label ? `<strong>${esc(t.client_label)}</strong> · ` : ''}${esc(truncate(t.message_text || '', 100))}</span>
        <button class="status-pill status-${t.status}" data-id="${t.id}" data-status="${t.status}" title="Cambiar estado">${STATUS_LABELS[t.status] || t.status}</button>
      </div>
      <div class="tc-bottom">
        <div class="tc-meta">
          ${t.assigned_label ? `<span>👤 ${esc(t.assigned_label)}</span>` : ''}
          ${t.remind_at ? `<span class="${t.status !== 'done' && new Date(t.remind_at) < new Date() ? 'overdue' : ''}">⏰ ${fmtDT(t.remind_at)}</span>` : ''}
          ${t.due_at ? `<span class="${t.status !== 'done' && new Date(t.due_at) < new Date() ? 'overdue' : ''}">📅 ${fmtDT(t.due_at)}</span>` : ''}
        </div>
        <div class="tc-actions">
          ${t.anchored_message_id ? `<button class="task-goto-btn" data-conv="${t.conversation_id}" data-msg="${t.anchored_message_id}" title="Ir al mensaje">💬</button>` : ''}
          <button class="task-edit-btn" data-id="${t.id}" title="Editar">✏️</button>
          <button class="task-del-btn" data-id="${t.id}" title="Eliminar">🗑️</button>
        </div>
      </div>
    </div>`;
}

function wireTaskCardEvents(rootEl) {
  rootEl.querySelectorAll('.status-pill').forEach(b =>
    b.addEventListener('click', () => changeStatus(Number(b.dataset.id), b.dataset.status)));
  rootEl.querySelectorAll('.task-del-btn').forEach(b =>
    b.addEventListener('click', () => deleteTask(Number(b.dataset.id))));
  rootEl.querySelectorAll('.task-edit-btn').forEach(b =>
    b.addEventListener('click', () => openTaskModal({ taskId: Number(b.dataset.id) })));
  rootEl.querySelectorAll('.task-goto-btn').forEach(b =>
    b.addEventListener('click', () => gotoMessage(Number(b.dataset.conv), Number(b.dataset.msg))));
}

// Mitad superior derecha: tareas (no realizadas) de la conversación abierta
function renderConvTasks() {
  if (!tasksList) return;
  const tasks = state.tasks.filter(t => t.conversation_id === state.activeConvId && t.status !== 'done');
  if (!state.activeConvId || tasks.length === 0) {
    tasksList.innerHTML = '<div class="tasks-empty">Sin tareas en esta conversación.<br>Usa 📌 en los mensajes para añadir.</div>';
    return;
  }
  tasksList.innerHTML = tasks.map(t => taskCardHtml(t, false)).join('');
  wireTaskCardEvents(tasksList);
}

// Mitad inferior derecha: alertas vencidas globales (siempre visibles, D9)
function renderAlerts() {
  const el = $('alerts-list');
  if (!el) return;
  if (!state.alerts.length) {
    el.innerHTML = '<div class="tasks-empty">Sin alertas vencidas 🎉</div>';
    return;
  }
  el.innerHTML = state.alerts.map(a => {
    const mins = Math.floor((Date.now() - new Date(a.when).getTime()) / 60000);
    const late = mins >= 1440 ? Math.floor(mins / 1440) + ' d' : mins >= 60 ? Math.floor(mins / 60) + ' h' : mins + ' min';
    return `
      <div class="alert-item" data-conv="${a.conversation_id || ''}">
        ${a.type === 'unanswered' ? `<button class="al-dismiss" data-conv="${a.conversation_id}" title="Descartar esta alerta">✕</button>` : ''}
        <span class="al-client">${a.high_priority ? '🔴 ' : ''}${esc(a.client)}</span>
        <span class="al-late">· ${a.type === 'due' ? '📅 límite' : a.type === 'unanswered' ? '⚠️ sin responder' : '⏰ aviso'} hace ${late}</span>
        <div class="al-text">${esc(truncate(a.text || '', 70))}</div>
      </div>`;
  }).join('');
  el.querySelectorAll('.alert-item').forEach(item =>
    item.addEventListener('click', () => {
      const convId = Number(item.dataset.conv);
      if (convId) { closeTasksScreen(); selectConversation(convId); }
    }));
  el.querySelectorAll('.al-dismiss').forEach(btn =>
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = await apiFetch(`/api/conversations/${btn.dataset.conv}/dismiss-alert`, { method: 'POST' });
      if (r) { await loadAlerts(); showToast('Alerta descartada (volverá si el cliente escribe de nuevo)'); }
    }));
}

// Saltar al mensaje anclado (scroll + resaltado temporal)
async function gotoMessage(convId, msgId) {
  closeTasksScreen();
  if (convId && convId !== state.activeConvId) await selectConversation(convId);
  const el = messagesArea.querySelector(`[data-msg-id="${msgId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.outline = '3px solid #ffc107';
    setTimeout(() => { el.style.outline = ''; }, 2500);
  }
}

/* ── Modal chincheta 📌 (crear/editar tarea o nota) ──── */
let taskModalCtx = {};   // { messageId?, taskId?, fromScreen? }

function fillUserSelect(sel, selectedId) {
  sel.innerHTML = '<option value="">— Sin responsable —</option>' + state.users.map(u =>
    `<option value="${u.id}" ${selectedId === u.id ? 'selected' : ''}>${esc((u.last_name ? u.last_name + ', ' : '') + u.first_name)}</option>`).join('');
}

function openTaskModal(ctx = {}) {
  taskModalCtx = ctx;
  const isEdit = !!ctx.taskId;
  const task = isEdit ? state.tasks.find(t => t.id === ctx.taskId) : null;
  const anchoredMsg = ctx.messageId ? state.messages.find(m => m.id === ctx.messageId) : null;

  $('task-title').textContent = isEdit ? '✏️ Editar tarea' : '📌 Nueva tarea';
  $('task-save').textContent  = isEdit ? 'Guardar cambios' : 'Guardar tarea';

  const prev = $('task-anchored-preview');
  if (anchoredMsg) {
    prev.textContent = '💬 ' + truncate(anchoredMsg.translated_text || anchoredMsg.original_text || '', 120);
    prev.classList.remove('hidden');
  } else prev.classList.add('hidden');

  // El checkbox tarea/nota solo tiene sentido al anclar desde un mensaje
  $('task-astask-row').style.display = (!isEdit && ctx.messageId) ? '' : 'none';
  $('task-astask').checked = true;

  // Selector de cliente: solo al crear desde la pantalla TAREAS
  const clientRow = $('task-client-row');
  if (ctx.fromScreen && !isEdit) {
    clientRow.classList.remove('hidden');
    const convs = [...state.conversations].sort((a, b) =>
      (a.contact_name || a.guest_name || a.guest_phone || '').localeCompare(b.contact_name || b.guest_name || b.guest_phone || ''));
    $('task-client').innerHTML = convs.map(c =>
      `<option value="${c.id}">${esc(c.contact_name || c.guest_name || c.guest_phone)}</option>`).join('');
  } else clientRow.classList.add('hidden');

  $('task-text').value = task ? (task.message_text || '') : '';
  fillUserSelect($('task-assigned'), task ? task.assigned_to : null);

  $('task-remind').value = task && task.remind_at ? 'custom' : '';
  const rc = $('task-remind-custom');
  if (task && task.remind_at) { rc.classList.remove('hidden'); rc.value = toLocalInputValue(new Date(task.remind_at)); }
  else { rc.classList.add('hidden'); rc.value = ''; }
  $('task-due').value = task && task.due_at ? toLocalInputValue(new Date(task.due_at)) : '';
  $('task-priority').checked = task ? !!task.high_priority : false;

  $('task-modal').classList.remove('hidden');
  $('task-overlay').classList.remove('hidden');
  $('task-text').focus();
}

function closeTaskModal() {
  $('task-modal').classList.add('hidden');
  $('task-overlay').classList.add('hidden');
  taskModalCtx = {};
}

function computeRemindAt() {
  const v = $('task-remind').value;
  if (!v) return null;
  if (v === 'custom') {
    const raw = $('task-remind-custom').value;
    return raw ? new Date(raw).toISOString() : null;
  }
  const hours = { '1h': 1, '3h': 3, '24h': 24, '48h': 48 }[v];
  return hours ? new Date(Date.now() + hours * 3600000).toISOString() : null;
}

async function saveTaskModal() {
  const text = $('task-text').value.trim();
  if (!text) { showToast('Escribe el comentario de la tarea'); return; }
  const isEdit = !!taskModalCtx.taskId;

  // Checkbox desmarcado → solo NOTA anclada al mensaje (D8)
  if (!isEdit && taskModalCtx.messageId && !$('task-astask').checked) {
    const r = await apiFetch(`/api/messages/${taskModalCtx.messageId}/notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (r) { closeTaskModal(); await loadNotes(state.activeConvId); showToast('Nota anclada al mensaje 📝'); }
    else showToast('No se pudo guardar la nota');
    return;
  }

  const body = {
    text,
    assigned_to: Number($('task-assigned').value) || null,
    high_priority: $('task-priority').checked,
    remind_at: computeRemindAt(),
    due_at: $('task-due').value ? new Date($('task-due').value).toISOString() : null,
  };

  let r;
  if (isEdit) {
    r = await apiFetch(`/api/tasks/${taskModalCtx.taskId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } else {
    body.conversation_id = taskModalCtx.fromScreen ? (Number($('task-client').value) || null) : state.activeConvId;
    body.anchored_message_id = taskModalCtx.messageId || null;
    r = await apiFetch('/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  }
  if (r) {
    closeTaskModal();
    await loadTasks(); await loadAlerts();
    showToast(isEdit ? 'Tarea actualizada ✓' : 'Tarea guardada 📌');
  } else showToast('No se pudo guardar la tarea');
}

async function deleteNote(id) {
  const r = await apiFetch(`/api/notes/${id}`, { method: 'DELETE' });
  if (r) { await loadNotes(state.activeConvId); showToast('Nota eliminada'); }
}

$('task-save').addEventListener('click', saveTaskModal);
$('task-cancel').addEventListener('click', closeTaskModal);
$('task-close').addEventListener('click', closeTaskModal);
$('task-overlay').addEventListener('click', closeTaskModal);
$('task-remind').addEventListener('change', () =>
  $('task-remind-custom').classList.toggle('hidden', $('task-remind').value !== 'custom'));

/* ── Pantalla TAREAS (tabla completa) ────────────────── */
function openTasksScreen() { $('tasks-screen').classList.remove('hidden'); renderTasksScreen(); }
function closeTasksScreen() { $('tasks-screen').classList.add('hidden'); }
$('open-tasks-screen').addEventListener('click', openTasksScreen);
$('tasks-screen-close').addEventListener('click', closeTasksScreen);
$('tasks-add-btn').addEventListener('click', () => openTaskModal({ fromScreen: true }));
$('tasks-search').addEventListener('input', renderTasksScreen);
$('tasks-filter-status').addEventListener('change', renderTasksScreen);
$('tasks-filter-assigned').addEventListener('change', renderTasksScreen);

function renderTasksScreen() {
  const tbody = $('tasks-table-body');
  if (!tbody || $('tasks-screen').classList.contains('hidden')) return;

  const fa = $('tasks-filter-assigned');
  const currentFa = fa.value;
  fa.innerHTML = '<option value="">Todos los responsables</option>' + state.users.map(u =>
    `<option value="${u.id}">${esc(u.first_name + ' ' + (u.last_name || ''))}</option>`).join('');
  fa.value = currentFa;

  const q  = ($('tasks-search').value || '').toLowerCase();
  const fs = $('tasks-filter-status').value;
  const rows = state.tasks.filter(t => {
    if (fs && t.status !== fs) return false;
    if (fa.value && t.assigned_to !== Number(fa.value)) return false;
    if (q && !((t.client_label || '').toLowerCase().includes(q) || (t.message_text || '').toLowerCase().includes(q))) return false;
    return true;
  });

  tbody.innerHTML = rows.length ? rows.map(t => {
    const overdueDue = t.due_at && new Date(t.due_at) < new Date() && t.status !== 'done';
    const resumen = esc(truncate(t.message_text || '', 80));
    return `<tr>
      <td>${t.high_priority ? '🔴 ' : ''}${esc(t.client_label || '—')}</td>
      <td>${t.anchored_message_id ? `<span class="task-link" data-conv="${t.conversation_id}" data-msg="${t.anchored_message_id}" title="Ir al mensaje">${resumen}</span>` : resumen}</td>
      <td>${esc(t.assigned_label || '—')}</td>
      <td><button class="status-pill status-${t.status}" data-id="${t.id}" data-status="${t.status}">${STATUS_LABELS[t.status]}</button></td>
      <td>${t.remind_at ? fmtDT(t.remind_at) : '—'}</td>
      <td class="${overdueDue ? 'overdue' : ''}">${t.due_at ? fmtDT(t.due_at) : '—'}</td>
      <td class="row-actions">
        <button class="task-edit-btn" data-id="${t.id}" title="Editar">✏️</button>
        <button class="task-del-btn" data-id="${t.id}" title="Eliminar">🗑️</button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" style="text-align:center;color:#999;padding:1.5rem;">No hay tareas que coincidan</td></tr>';

  wireTaskCardEvents(tbody);
  tbody.querySelectorAll('.task-link').forEach(el =>
    el.addEventListener('click', () => gotoMessage(Number(el.dataset.conv), Number(el.dataset.msg))));

  // Móvil (D11): tarjetas apiladas en lugar de tabla
  const cards = $('tasks-cards');
  cards.innerHTML = rows.map(t => taskCardHtml(t, true)).join('');
  wireTaskCardEvents(cards);
}

/* ── Seleccionar conversación ───────────────────────── */
async function selectConversation(id) {
  state.activeConvId = id;
  const conv = state.conversations.find(c => c.id === id);
  if (!conv) return;

  // Cabecera: identificación + idioma en la misma línea junto a ChatLink.
  // En Telegram el bot no conoce el teléfono (privacidad del canal): se muestra el nombre.
  const langSuffix = conv.guest_language && conv.guest_language !== 'es'
    ? ` · habla ${langName(conv.guest_language)}` : '';
  // Si el cliente compartió su contacto, mostrar su nombre y teléfono reales (ficha)
  const who = conv.channel === 'telegram'
    ? `✈️ ${conv.contact_name || conv.guest_name || 'Cliente Telegram'}${conv.contact_phone ? ' · ' + conv.contact_phone : ''} · Telegram`
    : conv.guest_phone;
  chatGuestName.textContent = `${who}${langSuffix}`;

  // Permiso de respuesta (Sprint 2): empleados "solo leer" no pueden escribir
  const readonly = conv.can_reply === false;
  $('readonly-note').classList.toggle('hidden', !readonly);
  msgInput.disabled = readonly;
  sendBtn.disabled = readonly;
  $('schedule-btn').disabled = readonly;
  $('attach-btn').disabled = readonly;

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
  state.notes = [];
  await loadMessages(id);
  await loadScheduled(id);
  await loadNotes(id);
  renderConvTasks();

  // Propuesta de ficha pendiente (llegó estando desconectado): preguntar ahora
  if (conv.pending_contact && !conv.contact_id) {
    openContactModal(conv.id, conv.pending_contact);
  }
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

/* ── Archivos (Sprint 5): clip 📎 ────────────────────── */
$('attach-btn').addEventListener('click', () => {
  if (!state.activeConvId) { showToast('Selecciona una conversación primero'); return; }
  $('file-input').click();
});

$('file-input').addEventListener('change', async () => {
  const file = $('file-input').files[0];
  $('file-input').value = '';
  if (!file || !state.activeConvId) return;
  if (file.size > 16 * 1024 * 1024) { showToast('⚠️ El archivo supera el límite de 16 MB'); return; }

  showToast('📎 Subiendo ' + file.name + '…', 8000);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch(`/api/conversations/${state.activeConvId}/files`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('chatlink_token') },
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'No se pudo enviar el archivo', 6000); return; }
    showToast('📎 Archivo enviado ✓');
    // El mensaje aparece en el hilo por el evento message_sent del socket
  } catch {
    showToast('Error de conexión al subir el archivo');
  }
});

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

/* ── Ficha de cliente (contacto compartido) ─────────── */
let contactModalConvId = null;

// Abre el aviso "¿guardar cliente?" con los datos propuestos
function openContactModal(convId, pending) {
  const pc = typeof pending === 'string' ? JSON.parse(pending) : pending;
  if (!pc || (!pc.name && !pc.phone)) return;

  contactModalConvId = convId;
  $('contact-question-text').textContent = pc.phone
    ? `${pc.name || 'Un cliente'} ha compartido su contacto (${pc.phone}). ¿Quieres guardarlo en tus fichas de clientes?`
    : `${pc.name || 'Un cliente'} es un cliente nuevo. ¿Quieres guardarlo en tus fichas de clientes?`;
  $('contact-name').value    = pc.name || '';
  $('contact-phone').value   = pc.phone || '';
  $('contact-company').value = '';
  $('contact-notes').value   = '';

  $('contact-question').classList.remove('hidden');
  $('contact-form').classList.add('hidden');
  $('contact-modal').classList.remove('hidden');
  $('contact-overlay').classList.remove('hidden');
}

// Cerrar sin decidir: la propuesta sigue pendiente y reaparece al abrir la conversación
function closeContactModal() {
  $('contact-modal').classList.add('hidden');
  $('contact-overlay').classList.add('hidden');
  contactModalConvId = null;
}

// "Sí, crear ficha" → mostrar el formulario precumplimentado y editable
$('contact-yes').addEventListener('click', () => {
  $('contact-question').classList.add('hidden');
  $('contact-form').classList.remove('hidden');
  $('contact-name').focus();
});

// "No guardar" → descartar la propuesta definitivamente
$('contact-no').addEventListener('click', async () => {
  const convId = contactModalConvId;
  closeContactModal();
  if (!convId) return;
  await apiFetch(`/api/conversations/${convId}/pending-contact`, { method: 'DELETE' });
  const conv = state.conversations.find(c => c.id === convId);
  if (conv) conv.pending_contact = null;
  showToast('No se ha guardado. Los datos quedan visibles en el hilo.');
});

// "Guardar cliente" → crear la ficha con los datos editados
$('contact-save').addEventListener('click', async () => {
  const name  = $('contact-name').value.trim();
  const phone = $('contact-phone').value.trim();
  if (!name) { showToast('El nombre es obligatorio'); return; }

  const result = await apiFetch('/api/contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: contactModalConvId,
      name,
      phone,
      company_name: $('contact-company').value.trim() || null,
      permanent_notes: $('contact-notes').value.trim() || null,
    }),
  });
  if (!result) { showToast('No se pudo guardar la ficha'); return; }
  closeContactModal();
  // El evento contact_saved del servidor actualiza lista, cabecera y muestra el toast
});

$('contact-cancel').addEventListener('click', closeContactModal);
$('contact-close').addEventListener('click', closeContactModal);
$('contact-overlay').addEventListener('click', closeContactModal);

/* ── Banner de navegación (Sprint 2) ─────────────────── */
function setActiveNav(id) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const el = $(id);
  if (el) el.classList.add('active');
}
$('nav-conversaciones').addEventListener('click', () => {
  closeTasksScreen(); closeEmployeesScreen(); closeContactsScreen(); setActiveNav('nav-conversaciones');
});
$('nav-tareas').addEventListener('click', () => {
  closeEmployeesScreen(); closeContactsScreen(); openTasksScreen(); setActiveNav('nav-tareas');
});
$('nav-empleados').addEventListener('click', () => {
  closeTasksScreen(); closeContactsScreen(); openEmployeesScreen(); setActiveNav('nav-empleados');
});
$('nav-contactos').addEventListener('click', () => {
  closeTasksScreen(); closeEmployeesScreen(); openContactsScreen(); setActiveNav('nav-contactos');
});
$('nav-configuracion').addEventListener('click', () => showToast('La pantalla CONFIGURACIÓN llegará más adelante 😉'));
if (localStorage.getItem('chatlink_role') === 'manager') $('nav-empleados').classList.remove('hidden');

/* ── Pantalla EMPLEADOS (Sprint 2, solo GESTOR) ──────── */
const ROLE_LABELS = { manager: 'Gestor', supervisor: 'Supervisor', employee: 'Empleado' };
let empState = { employees: [], positions: [], groups: [], editingId: null };

function openEmployeesScreen() { $('employees-screen').classList.remove('hidden'); loadEmployees(); }
function closeEmployeesScreen() { $('employees-screen').classList.add('hidden'); }
$('employees-screen-close').addEventListener('click', () => { closeEmployeesScreen(); setActiveNav('nav-conversaciones'); });
$('employees-add-btn').addEventListener('click', () => openEmpModal(null));

async function loadEmployees() {
  const [emps, positions, groups] = await Promise.all([
    apiFetch('/api/employees'),
    apiFetch('/api/positions'),
    apiFetch('/api/contact-groups'),
  ]);
  if (Array.isArray(emps)) empState.employees = emps;
  if (Array.isArray(positions)) empState.positions = positions;
  if (Array.isArray(groups)) empState.groups = groups;
  renderEmployees();
}

function renderEmployees() {
  const tbody = $('employees-table-body');
  const rowHtml = u => `
    <tr class="${u.active ? '' : 'emp-inactive'}">
      <td>${esc((u.last_name ? u.last_name + ', ' : '') + u.first_name)}</td>
      <td>${esc(u.position_name || '—')}</td>
      <td>${esc(u.username)}</td>
      <td><span class="role-badge role-${u.role}">${ROLE_LABELS[u.role] || u.role}</span></td>
      <td>${u.active ? '🟢 Activo' : '⚪ Inactivo'}</td>
      <td class="row-actions">
        <button class="emp-edit-btn" data-id="${u.id}" title="Editar">✏️</button>
        <button class="emp-key-btn" data-id="${u.id}" title="Resetear contraseña">🔑</button>
        <button class="emp-toggle-btn" data-id="${u.id}" title="${u.active ? 'Desactivar' : 'Reactivar'}">${u.active ? '🗑️' : '♻️'}</button>
      </td>
    </tr>`;
  tbody.innerHTML = empState.employees.map(rowHtml).join('')
    || '<tr><td colspan="6" style="text-align:center;color:#999;padding:1.5rem;">Sin empleados aún</td></tr>';

  // Móvil: tarjetas apiladas (D11)
  $('employees-cards').innerHTML = empState.employees.map(u => `
    <div class="task-card ${u.active ? '' : 'emp-inactive'}">
      <div class="tc-top"><strong>${esc((u.last_name ? u.last_name + ', ' : '') + u.first_name)}</strong>
        <span class="role-badge role-${u.role}">${ROLE_LABELS[u.role] || u.role}</span></div>
      <div class="tc-meta"><span>${esc(u.position_name || '—')}</span><span>👤 ${esc(u.username)}</span><span>${u.active ? '🟢 Activo' : '⚪ Inactivo'}</span></div>
      <div class="tc-actions">
        <button class="emp-edit-btn" data-id="${u.id}">✏️</button>
        <button class="emp-key-btn" data-id="${u.id}">🔑</button>
        <button class="emp-toggle-btn" data-id="${u.id}">${u.active ? '🗑️' : '♻️'}</button>
      </div>
    </div>`).join('');

  ['employees-table-body', 'employees-cards'].forEach(rootId => {
    const root = $(rootId);
    root.querySelectorAll('.emp-edit-btn').forEach(b => b.addEventListener('click', () => openEmpModal(Number(b.dataset.id))));
    root.querySelectorAll('.emp-key-btn').forEach(b => b.addEventListener('click', () => resetEmployeePassword(Number(b.dataset.id))));
    root.querySelectorAll('.emp-toggle-btn').forEach(b => b.addEventListener('click', () => toggleEmployeeActive(Number(b.dataset.id))));
  });
}

function fillPositionSelect(selectedId) {
  $('emp-position').innerHTML = '<option value="">— Elegir puesto —</option>' +
    empState.positions.map(p => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name)}</option>`).join('') +
    '<option value="__new__">➕ Añadir puesto nuevo…</option>';
}
$('emp-position').addEventListener('change', () =>
  $('emp-position-new').classList.toggle('hidden', $('emp-position').value !== '__new__'));

function renderGroupChecks(assigned) {
  const box = $('emp-groups');
  if (!empState.groups.length) {
    box.innerHTML = '<div class="emp-groups-empty">Aún no hay grupos de clientes (se crearán en la pantalla CONTACTOS). De momento el empleado verá las conversaciones sin grupo.</div>';
    return;
  }
  const map = new Map((assigned || []).map(g => [g.group_id, g.can_reply]));
  box.innerHTML = empState.groups.map(g => {
    const checked = assigned ? map.has(g.id) : true;   // en el alta: todos marcados (D2)
    const canReply = assigned ? (map.get(g.id) !== false) : true;
    return `<label class="emp-group-row">
      <input type="checkbox" class="emp-group-check" data-id="${g.id}" ${checked ? 'checked' : ''}>
      <span>${esc(g.name)}</span>
      <select class="emp-group-mode" data-id="${g.id}">
        <option value="reply" ${canReply ? 'selected' : ''}>Leer y responder</option>
        <option value="read" ${!canReply ? 'selected' : ''}>Solo leer</option>
      </select>
    </label>`;
  }).join('');
}

function collectGroups() {
  if (!empState.groups.length) return [];
  return [...document.querySelectorAll('.emp-group-check')].filter(c => c.checked).map(c => ({
    group_id: Number(c.dataset.id),
    can_reply: document.querySelector(`.emp-group-mode[data-id="${c.dataset.id}"]`).value === 'reply',
  }));
}

function openEmpModal(id) {
  empState.editingId = id;
  const u = id ? empState.employees.find(e => e.id === id) : null;
  $('emp-title').textContent = u ? '✏️ Editar empleado' : '👥 Añadir empleado';
  $('emp-save').textContent  = u ? 'Guardar cambios' : 'Guardar empleado';
  $('emp-save').style.display = '';
  $('emp-first').value = u ? u.first_name : '';
  $('emp-last').value  = u ? (u.last_name || '') : '';
  fillPositionSelect(u ? u.position_id : null);
  $('emp-position-new').classList.add('hidden');
  $('emp-position-new').value = '';
  $('emp-role').value = u ? u.role : 'employee';
  $('emp-username').value = u ? u.username : '';
  $('emp-username').disabled = !!u;    // el login no se cambia al editar
  renderGroupChecks(u ? u.groups : null);
  $('emp-temp-result').classList.add('hidden');
  $('emp-modal').classList.remove('hidden');
  $('emp-overlay').classList.remove('hidden');
  $('emp-first').focus();
}
function closeEmpModal() {
  $('emp-modal').classList.add('hidden');
  $('emp-overlay').classList.add('hidden');
  empState.editingId = null;
}

async function saveEmployee() {
  const body = {
    first_name: $('emp-first').value.trim(),
    last_name:  $('emp-last').value.trim(),
    role: $('emp-role').value,
    groups: collectGroups(),
  };
  const posVal = $('emp-position').value;
  if (posVal === '__new__') body.position_name = $('emp-position-new').value.trim();
  else if (posVal) body.position_id = Number(posVal);

  if (!body.first_name || !body.last_name) { showToast('Nombre y apellidos son obligatorios'); return; }
  if (!body.position_id && !body.position_name) { showToast('Elige un puesto o crea uno nuevo'); return; }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + localStorage.getItem('chatlink_token'),
  };

  if (empState.editingId) {
    const res = await fetch(`/api/employees/${empState.editingId}`, { method: 'PUT', headers, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'No se pudo guardar'); return; }
    closeEmpModal();
    await loadEmployees(); await loadUsers();
    showToast('Empleado actualizado ✓');
  } else {
    body.username = $('emp-username').value.trim();
    if (!body.username) { showToast('El usuario (login) es obligatorio'); return; }
    const res = await fetch('/api/employees', { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'No se pudo crear el empleado'); return; }
    // Mostrar la contraseña temporal UNA sola vez
    $('emp-temp-result').innerHTML =
      `✅ Empleado creado.<br>Usuario: <code>${esc(data.username)}</code> — Contraseña temporal: <code>${esc(data.temp_password)}</code>` +
      `<br><small>Cópiala y dásela al empleado: la cambiará obligatoriamente en su primer acceso. No se volverá a mostrar.</small>`;
    $('emp-temp-result').classList.remove('hidden');
    $('emp-save').style.display = 'none';
    await loadEmployees(); await loadUsers();
  }
}

async function toggleEmployeeActive(id) {
  const u = empState.employees.find(e => e.id === id);
  if (!u) return;
  const q = u.active
    ? `¿Desactivar a ${u.first_name} ${u.last_name || ''}? No podrá entrar en ChatLink (podrás reactivarlo).`
    : `¿Reactivar a ${u.first_name} ${u.last_name || ''}?`;
  if (!confirm(q)) return;
  const res = await fetch(`/api/employees/${id}/active`, {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + localStorage.getItem('chatlink_token') },
  });
  const data = await res.json();
  if (!res.ok) { showToast(data.error || 'No se pudo cambiar el estado'); return; }
  await loadEmployees(); await loadUsers();
  showToast(data.active ? 'Empleado reactivado ♻️' : 'Empleado desactivado');
}

async function resetEmployeePassword(id) {
  const u = empState.employees.find(e => e.id === id);
  if (!u) return;
  if (!confirm(`¿Generar una contraseña temporal nueva para ${u.first_name}? La actual dejará de valer.`)) return;
  const r = await apiFetch(`/api/employees/${id}/reset-password`, { method: 'POST' });
  if (r && r.temp_password) {
    prompt(`Contraseña temporal de ${u.first_name} (cópiala; no se mostrará de nuevo):`, r.temp_password);
  } else showToast('No se pudo resetear la contraseña');
}

$('emp-save').addEventListener('click', saveEmployee);
$('emp-cancel').addEventListener('click', closeEmpModal);
$('emp-close').addEventListener('click', closeEmpModal);
$('emp-overlay').addEventListener('click', closeEmpModal);

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
  es: 'español',
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

/* ═══════════ SPRINT 3: CONTACTOS ═══════════ */

let ctState = { contacts: [], groups: [], filterGroupId: null, editingId: null };

function openContactsScreen() {
  $('contacts-screen').classList.remove('hidden');
  loadContacts();
}
function closeContactsScreen() {
  $('contacts-screen').classList.add('hidden');
}

async function loadContacts() {
  const [contacts, groups] = await Promise.all([
    apiFetch('/api/contacts'),
    apiFetch('/api/contact-groups'),
  ]);
  if (Array.isArray(contacts)) ctState.contacts = contacts;
  if (Array.isArray(groups)) ctState.groups = groups;
  renderContactsGroupsBar();
  renderContacts();
}

function renderContactsGroupsBar() {
  const bar = $('contacts-groups-bar');
  const allActive = ctState.filterGroupId === null;
  let html = '<button class="cg-filter ' + (allActive ? 'active' : '') + '" data-gid="">Todos</button>';
  ctState.groups.forEach(g => {
    html += '<button class="cg-filter ' + (ctState.filterGroupId === g.id ? 'active' : '') + '" data-gid="' + g.id + '">' + esc(g.name) + '</button>';
  });
  bar.innerHTML = html;
  bar.querySelectorAll('.cg-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      const gid = btn.dataset.gid;
      ctState.filterGroupId = gid ? Number(gid) : null;
      renderContactsGroupsBar();
      renderContacts();
    });
  });
}

function renderContacts() {
  const q = ($('contacts-search').value || '').toLowerCase().trim();
  let list = ctState.contacts;
  if (ctState.filterGroupId !== null) {
    list = list.filter(c => c.group_id === ctState.filterGroupId);
  }
  if (q) {
    list = list.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.phone || '').toLowerCase().includes(q) ||
      (c.company_name || '').toLowerCase().includes(q)
    );
  }
  const tbody = $('contacts-table-body');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;padding:2rem">Sin resultados</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(c =>
    '<tr>' +
    '<td>' + esc(c.name || '—') + '</td>' +
    '<td>' + esc(c.phone || '—') + '</td>' +
    '<td>' + esc(c.company_name || '—') + '</td>' +
    '<td>' + (c.group_name ? '<span class="ct-group-badge">' + esc(c.group_name) + '</span>' : '—') + '</td>' +
    '<td>' + esc(c.preferred_language || '—') + '</td>' +
    '<td class="row-actions">' +
      '<button title="Editar" onclick="openCtModal(' + c.id + ')">✏️</button>' +
      '<button title="Nueva conv." onclick="openNewConvModal(' + c.id + ')">💬</button>' +
      '<button title="Eliminar" onclick="deleteContact(' + c.id + ')">🗑️</button>' +
    '</td>' +
    '</tr>'
  ).join('');
}

/* ── Modal editar/crear contacto ─────────── */
function openCtModal(id) {
  ctState.editingId = id || null;
  const isNew = !id;
  $('ct-title').textContent = isNew ? '👤 Nuevo contacto' : '✏️ Editar contacto';
  const c = isNew ? {} : (ctState.contacts.find(x => x.id === id) || {});
  $('ct-name').value = c.name || '';
  $('ct-phone').value = c.phone || '';
  $('ct-company').value = c.company_name || '';
  $('ct-notes').value = c.permanent_notes || '';
  const gsel = $('ct-group');
  let ghtml = '<option value="">Sin grupo</option>';
  ctState.groups.forEach(g => {
    ghtml += '<option value="' + g.id + '"' + (c.group_id === g.id ? ' selected' : '') + '>' + esc(g.name) + '</option>';
  });
  ghtml += '<option value="_new">+ A\xF1adir grupo nuevo…</option>';
  gsel.innerHTML = ghtml;
  $('ct-group-new').classList.add('hidden');
  $('ct-group-new').value = '';
  $('ct-lang').value = c.preferred_language || '';
  $('ct-overlay').classList.remove('hidden');
  $('ct-modal').classList.remove('hidden');
  $('ct-name').focus();
}

function closeCtModal() {
  $('ct-overlay').classList.add('hidden');
  $('ct-modal').classList.add('hidden');
  ctState.editingId = null;
}

$('ct-close').addEventListener('click', closeCtModal);
$('ct-cancel').addEventListener('click', closeCtModal);
$('ct-overlay').addEventListener('click', closeCtModal);

$('ct-group').addEventListener('change', () => {
  const newInput = $('ct-group-new');
  if ($('ct-group').value === '_new') {
    newInput.classList.remove('hidden');
    newInput.focus();
  } else {
    newInput.classList.add('hidden');
    newInput.value = '';
  }
});

async function saveContact() {
  const name = $('ct-name').value.trim();
  if (!name) { showToast('El nombre es obligatorio'); return; }
  const gsel = $('ct-group');
  const groupNewVal = $('ct-group-new').value.trim();
  const body = {
    name,
    phone: $('ct-phone').value.trim() || null,
    company_name: $('ct-company').value.trim() || null,
    preferred_language: $('ct-lang').value || null,
    permanent_notes: $('ct-notes').value.trim() || null,
  };
  if (gsel.value === '_new' && groupNewVal) {
    body.group_name = groupNewVal;
  } else if (gsel.value && gsel.value !== '_new') {
    body.group_id = Number(gsel.value);
  } else {
    body.group_id = null;
  }
  try {
    const jsonHeaders = { 'Content-Type': 'application/json' };
    if (ctState.editingId) {
      await apiFetch('/api/contacts/' + ctState.editingId, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(body) });
    } else {
      // POST crea el contacto (sin grupo); si hay grupo se aplica con PUT
      const hasGroup = body.group_id || body.group_name;
      const createBody = { name: body.name, phone: body.phone, company_name: body.company_name, permanent_notes: body.permanent_notes };
      const created = await apiFetch('/api/contacts', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(createBody) });
      if (created && created.id && hasGroup) {
        await apiFetch('/api/contacts/' + created.id, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(body) });
      }
    }
    closeCtModal();
    await loadContacts();
    showToast('Contacto guardado');
  } catch (err) {
    showToast('Error: ' + (err.message || 'no se pudo guardar'));
  }
}

$('ct-save').addEventListener('click', saveContact);

async function deleteContact(id) {
  const c = ctState.contacts.find(x => x.id === id);
  if (!confirm('Eliminar a ' + (c ? c.name : 'este contacto') + '?')) return;
  try {
    await apiFetch('/api/contacts/' + id, { method: 'DELETE' });
    await loadContacts();
    showToast('Contacto eliminado');
  } catch (err) {
    showToast('Error: ' + (err.message || 'no se pudo eliminar'));
  }
}

$('contacts-add-btn').addEventListener('click', () => openCtModal(null));
$('contacts-screen-close').addEventListener('click', () => { closeContactsScreen(); setActiveNav('nav-conversaciones'); });
$('contacts-search').addEventListener('input', renderContacts);

/* ── Modal nueva conversacion ─────────── */
function openNewConvModal(preselectedId) {
  $('newconv-search').value = '';
  $('newconv-result').classList.add('hidden');
  $('newconv-result').innerHTML = '';
  if (ctState.contacts.length === 0) loadContacts().then(() => renderNewConvList(''));
  else renderNewConvList('');
  $('newconv-overlay').classList.remove('hidden');
  $('newconv-modal').classList.remove('hidden');
  if (preselectedId) {
    startConversation(preselectedId);
  } else {
    $('newconv-search').focus();
  }
}

function closeNewConvModal() {
  $('newconv-overlay').classList.add('hidden');
  $('newconv-modal').classList.add('hidden');
}

$('newconv-close').addEventListener('click', closeNewConvModal);
$('newconv-close2').addEventListener('click', closeNewConvModal);
$('newconv-overlay').addEventListener('click', closeNewConvModal);

function renderNewConvList(q) {
  const lower = q.toLowerCase().trim();
  const list = ctState.contacts.filter(c =>
    !lower || (c.name || '').toLowerCase().includes(lower) || (c.phone || '').includes(lower)
  ).slice(0, 30);
  const ul = $('newconv-list');
  if (!list.length) {
    ul.innerHTML = '<div style="padding:10px 12px;color:#999;font-size:0.82rem">Sin contactos</div>';
    return;
  }
  ul.innerHTML = list.map(c =>
    '<div class="newconv-item" data-cid="' + c.id + '">' +
    '<span class="newconv-item-name">' + esc(c.name || '—') + '</span>' +
    '<span class="newconv-item-sub">' + esc(c.phone || '') + (c.company_name ? ' \xB7 ' + esc(c.company_name) : '') + '</span>' +
    '</div>'
  ).join('');
  ul.querySelectorAll('.newconv-item').forEach(el => {
    el.addEventListener('click', () => startConversation(Number(el.dataset.cid)));
  });
}

$('newconv-search').addEventListener('input', () => renderNewConvList($('newconv-search').value));

async function startConversation(contactId) {
  try {
    const res = await apiFetch('/api/conversations/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact_id: contactId }),
    });
    const resultEl = $('newconv-result');
    resultEl.classList.remove('hidden');
    if (res.conversation_id) {
      resultEl.innerHTML = 'Conversaci\xF3n existente encontrada. <a href="#" id="newconv-open-link">Abrir chat →</a>';
      $('newconv-open-link').addEventListener('click', e => {
        e.preventDefault();
        closeNewConvModal();
        closeContactsScreen();
        setActiveNav('nav-conversaciones');
        selectConversation(res.conversation_id);
      });
    } else if (res.invite_link) {
      const contact = ctState.contacts.find(c => c.id === contactId);
      resultEl.innerHTML = 'Comparte este enlace con ' + esc(contact ? contact.name : 'el contacto') + ':<br>' +
        '<a href="' + res.invite_link + '" target="_blank" rel="noopener">' + res.invite_link + '</a>';
    } else {
      resultEl.innerHTML = '<span style="color:#c62828">' + esc(res.reason || 'No se pudo iniciar la conversaci\xF3n') + '</span>';
    }
  } catch (err) {
    showToast('Error: ' + (err.message || 'no se pudo iniciar la conversaci\xF3n'));
  }
}

$('newconv-new-contact').addEventListener('click', () => {
  closeNewConvModal();
  openCtModal(null);
});

$('conv-new-btn').addEventListener('click', () => {
  if (ctState.contacts.length === 0) loadContacts().then(() => openNewConvModal());
  else openNewConvModal();
});

/* ── Buscador en sidebar ────────────────── */
$('conv-search-btn').addEventListener('click', () => {
  const bar = $('conv-search-bar');
  bar.classList.toggle('hidden');
  if (!bar.classList.contains('hidden')) {
    $('conv-search-input').value = '';
    $('conv-search-input').focus();
    filterConvList('');
  } else {
    filterConvList('');
  }
});

$('conv-search-input').addEventListener('input', () => filterConvList($('conv-search-input').value));

function filterConvList(q) {
  const lower = q.toLowerCase().trim();
  document.querySelectorAll('.conv-item').forEach(el => {
    if (!lower) { el.classList.remove('search-hidden'); return; }
    const name = (el.dataset.name || '').toLowerCase();
    const phone = (el.dataset.phone || '').toLowerCase();
    el.classList.toggle('search-hidden', !name.includes(lower) && !phone.includes(lower));
  });
  if (lower) searchConvMessages(lower);
}

async function searchConvMessages(q) {
  try {
    const ids = await apiFetch('/api/conversations-search?q=' + encodeURIComponent(q));
    if (!Array.isArray(ids)) return;
    const matchIds = new Set(ids);
    document.querySelectorAll('.conv-item').forEach(el => {
      if (matchIds.has(Number(el.dataset.id))) el.classList.remove('search-hidden');
    });
  } catch (_) {}
}

