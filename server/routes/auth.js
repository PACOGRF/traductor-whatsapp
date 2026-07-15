const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const db      = require('../db/db');
const { logAudit } = require('../services/audit');

const JWT_SECRET   = () => process.env.JWT_SECRET || 'chatlink_secret';
const MAX_ATTEMPTS = 5;    // intentos fallidos antes de bloquear (D5)
const LOCK_MINUTES = 15;   // duración del bloqueo

function signToken(user) {
  return jwt.sign(
    {
      user_id: user.id,
      company_id: user.company_id,
      role: user.role,
      username: user.username,
      must_change_password: !!user.must_change_password
    },
    JWT_SECRET(),
    { expiresIn: '30d' }
  );
}

// ── POST /auth/login ──────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Introduce usuario y contraseña' });
    }

    const user = await db.get(
      'SELECT * FROM users WHERE username = ? AND active = true',
      [username.trim()]
    );

    // Mensaje genérico: no revelar si el usuario existe o no
    if (!user) {
      await logAudit(null, null, 'login_failed', { username: username.trim(), reason: 'unknown_user' });
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    // ¿Cuenta bloqueada temporalmente?
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      await logAudit(user.company_id, user.id, 'login_blocked', { minutes_left: minutes });
      return res.status(423).json({
        error: 'Cuenta bloqueada por intentos fallidos. Inténtalo en ' + minutes + ' min.'
      });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      const attempts = (user.failed_attempts || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await db.run(
          `UPDATE users SET failed_attempts = 0,
             locked_until = NOW() + INTERVAL '${LOCK_MINUTES} minutes' WHERE id = ?`,
          [user.id]
        );
        await logAudit(user.company_id, user.id, 'account_locked', { attempts });
        return res.status(423).json({
          error: 'Cuenta bloqueada ' + LOCK_MINUTES + ' min por ' + MAX_ATTEMPTS + ' intentos fallidos.'
        });
      }
      await db.run('UPDATE users SET failed_attempts = ? WHERE id = ?', [attempts, user.id]);
      await logAudit(user.company_id, user.id, 'login_failed', { attempts });
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    // Login correcto: resetear contador y bloqueo
    await db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [user.id]);
    await logAudit(user.company_id, user.id, 'login', {});

    res.json({
      token: signToken(user),
      must_change_password: !!user.must_change_password,
      name: user.first_name + ' ' + user.last_name,
      role: user.role
    });
  } catch (err) {
    console.error('Error en /auth/login:', err.message);
    res.status(500).json({ error: 'Error del servidor. Inténtalo de nuevo.' });
  }
});

// ── POST /auth/change-password ────────────────────────────────────
// Requiere token válido (aunque tenga must_change_password pendiente).
router.post('/change-password', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'No autenticado' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET());
    } catch {
      return res.status(401).json({ error: 'Token inválido o caducado' });
    }
    if (!payload.user_id) {
      return res.status(401).json({ error: 'Sesión antigua. Vuelve a iniciar sesión.' });
    }

    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Faltan datos' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
    }
    if (new_password === current_password) {
      return res.status(400).json({ error: 'La nueva contraseña debe ser distinta de la actual' });
    }

    const user = await db.get('SELECT * FROM users WHERE id = ? AND active = true', [payload.user_id]);
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'La contraseña actual no es correcta' });

    const hash = await bcrypt.hash(new_password, 10);
    await db.run(
      'UPDATE users SET password_hash = ?, must_change_password = false WHERE id = ?',
      [hash, user.id]
    );
    await logAudit(user.company_id, user.id, 'password_change', {});

    // Nuevo token ya sin la marca de cambio pendiente
    user.password_hash = hash;
    user.must_change_password = false;
    res.json({ token: signToken(user) });
  } catch (err) {
    console.error('Error en /auth/change-password:', err.message);
    res.status(500).json({ error: 'Error del servidor. Inténtalo de nuevo.' });
  }
});

module.exports = router;
