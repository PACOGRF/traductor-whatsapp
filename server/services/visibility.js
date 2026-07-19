const db = require('../db/db');

// Visibilidad de conversaciones por rol (D1/D2):
// - manager y supervisor ven todo
// - employee ve solo los grupos de clientes que tiene asignados
//   (con permiso "leer y responder" o "solo leer"), más las excepciones
//   individuales. Las conversaciones sin contacto o sin grupo son
//   visibles para todos (V1; se afinará cuando existan los grupos en Sprint 3).

// Carga la visibilidad del usuario. null → acceso total.
async function getVisibility(user) {
  if (!user || user.role !== 'employee') return null;
  const groups = await db.all(
    'SELECT group_id, can_reply FROM user_group_visibility WHERE user_id = ?',
    [user.user_id]
  );
  const exceptions = await db.all(
    'SELECT contact_id, access FROM user_contact_exceptions WHERE user_id = ?',
    [user.user_id]
  );
  return {
    groups: new Map(groups.map(g => [g.group_id, g.can_reply])),
    exceptions: new Map(exceptions.map(e => [e.contact_id, e.access])),
  };
}

// Nivel de acceso a una conversación: 'none' | 'read' | 'reply'
// (conv debe traer contact_id y contact_group_id)
function convAccess(vis, conv) {
  if (!vis) return 'reply';
  if (conv.contact_id && vis.exceptions.has(conv.contact_id)) {
    return vis.exceptions.get(conv.contact_id) === 'deny' ? 'none' : 'reply';
  }
  const groupId = conv.contact_group_id || null;
  if (!groupId) return 'reply';                       // sin grupo: visible (V1)
  if (!vis.groups.has(groupId)) return 'none';
  return vis.groups.get(groupId) ? 'reply' : 'read';
}

// Acceso de un usuario a una conversación concreta (consulta incluida)
async function accessForConversation(user, conversationId) {
  const conv = await db.get(
    `SELECT c.*, ct.group_id AS contact_group_id
     FROM conversations c LEFT JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.id = ?`,
    [conversationId]
  );
  if (!conv) return { conv: null, access: 'none' };
  const vis = await getVisibility(user);
  return { conv, access: convAccess(vis, conv) };
}

module.exports = { getVisibility, convAccess, accessForConversation };
