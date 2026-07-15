const jwt = require('jsonwebtoken');

// Verifica el JWT y deja los datos del usuario en req.user
// (payload: user_id, company_id, role, username, must_change_password)
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'chatlink_secret');

    // Tokens antiguos (v1) no llevan user_id: se fuerza nuevo login
    if (!payload.user_id) {
      return res.status(401).json({ error: 'Sesión antigua. Vuelve a iniciar sesión.' });
    }

    // Si tiene pendiente el cambio de contraseña obligatorio, no puede usar la API
    if (payload.must_change_password) {
      return res.status(403).json({
        error: 'Debes cambiar tu contraseña antes de continuar',
        code: 'MUST_CHANGE_PASSWORD'
      });
    }

    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o caducado' });
  }
}

// Restringe una ruta a ciertos roles: requireRole('manager', 'supervisor')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No tienes permisos para esta acción' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
