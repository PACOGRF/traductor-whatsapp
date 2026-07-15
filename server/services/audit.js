const db = require('../db/db');

// Registra una acción en el log de auditoría (D5).
// Nunca lanza error: un fallo al auditar no debe tumbar la operación principal.
async function logAudit(companyId, userId, action, detail = {}) {
  try {
    await db.run(
      'INSERT INTO audit_log (company_id, user_id, action, detail) VALUES (?, ?, ?, ?)',
      [companyId || null, userId || null, action, JSON.stringify(detail)]
    );
  } catch (err) {
    console.error('⚠️ No se pudo registrar en audit_log:', err.message);
  }
}

module.exports = { logAudit };
