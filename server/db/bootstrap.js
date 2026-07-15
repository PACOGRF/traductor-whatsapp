const bcrypt = require('bcryptjs');
const db = require('./db');

// Crea el usuario GESTOR inicial de la empresa 1 (Tecorem) si no existe ningún usuario.
// Usa MANAGER_USERNAME / MANAGER_PASSWORD del entorno (las mismas credenciales que v1)
// y fuerza el cambio de contraseña en el primer login (D5).
async function bootstrapAdmin() {
  const existing = await db.get('SELECT id FROM users LIMIT 1');
  if (existing) return;

  const username = process.env.MANAGER_USERNAME || 'gestor';
  const password = process.env.MANAGER_PASSWORD;

  if (!password) {
    console.warn('⚠️ No hay MANAGER_PASSWORD en el entorno: no se crea el usuario gestor inicial.');
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await db.run(
    `INSERT INTO users (company_id, first_name, last_name, username, password_hash, role, must_change_password)
     VALUES (1, 'Gestor', 'Tecorem', ?, ?, 'manager', true)`,
    [username, hash]
  );

  const { logAudit } = require('../services/audit');
  await logAudit(1, null, 'user_created', { username, role: 'manager', origin: 'bootstrap' });

  console.log('👤 Usuario gestor inicial creado: "' + username + '" (deberá cambiar la contraseña en el primer login)');
}

module.exports = { bootstrapAdmin };
