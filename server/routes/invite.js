const express = require('express');
const router = express.Router();
const db = require('../db/db');
const bcrypt = require('bcryptjs');

// GET /invite/:token → sirve la página de establecer contraseña
router.get('/:token', async (req, res) => {
  try {
    const inv = await db.get(
      `SELECT it.*, u.first_name FROM invitation_tokens it
       JOIN users u ON u.id = it.user_id
       WHERE it.token = ?`,
      [req.params.token]
    );
    if (!inv)       return res.status(404).send(invitePage(null, 'Enlace no válido'));
    if (inv.used_at) return res.status(410).send(invitePage(null, 'Este enlace ya fue utilizado'));
    if (new Date(inv.expires_at) < new Date())
      return res.status(410).send(invitePage(null, 'Este enlace ha caducado (válido 48 h)'));
    res.send(invitePage(inv.first_name, null));
  } catch (err) {
    console.error('Error invite GET:', err);
    res.status(500).send(invitePage(null, 'Error interno'));
  }
});

// POST /invite/:token → guarda la contraseña elegida por el empleado
router.post('/:token', async (req, res) => {
  try {
    const { new_password } = req.body || {};
    if (!new_password || new_password.length < 8)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });

    const inv = await db.get(
      `SELECT * FROM invitation_tokens
       WHERE token = ? AND used_at IS NULL AND expires_at > NOW()`,
      [req.params.token]
    );
    if (!inv) return res.status(400).json({ error: 'Enlace no válido o caducado' });

    const hash = await bcrypt.hash(new_password, 10);
    await db.run(
      'UPDATE users SET password_hash = ?, must_change_password = false WHERE id = ?',
      [hash, inv.user_id]
    );
    await db.run('UPDATE invitation_tokens SET used_at = NOW() WHERE id = ?', [inv.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error invite POST:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function invitePage(firstName, error) {
  const greeting = firstName ? `Hola, <strong>${esc(firstName)}</strong>` : 'Bienvenido';
  const errorBlock = error
    ? `<div class="inv-error">${esc(error)}</div>`
    : '';
  const formBlock = error ? '' : `
    <p class="inv-sub">Establece tu contraseña de acceso al panel de ChatLink.</p>
    <form id="inv-form">
      <input id="inv-pass"  type="password" placeholder="Nueva contraseña (mín. 8 caracteres)" required minlength="8">
      <input id="inv-pass2" type="password" placeholder="Confirmar contraseña" required>
      <div id="inv-msg" class="inv-error" style="display:none"></div>
      <button type="submit" id="inv-btn">Acceder a ChatLink</button>
    </form>
    <script>
      document.getElementById('inv-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        var p1  = document.getElementById('inv-pass').value;
        var p2  = document.getElementById('inv-pass2').value;
        var msg = document.getElementById('inv-msg');
        var btn = document.getElementById('inv-btn');
        if (p1 !== p2)   { msg.textContent = 'Las contraseñas no coinciden'; msg.style.display = ''; return; }
        if (p1.length < 8) { msg.textContent = 'Mínimo 8 caracteres'; msg.style.display = ''; return; }
        btn.disabled = true; btn.textContent = 'Guardando…';
        var r = null;
        try {
          r = await fetch(location.pathname, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_password: p1 })
          }).then(function(x){ return x.json(); });
        } catch(_) {}
        if (r && r.ok) {
          document.getElementById('inv-form').innerHTML =
            '<div class="inv-ok">Contraseña establecida correctamente.<br>Redirigiendo al panel…</div>';
          setTimeout(function(){ location.href = '/'; }, 1800);
        } else {
          msg.textContent = (r && r.error) || 'Error al guardar. Inténtalo de nuevo.';
          msg.style.display = '';
          btn.disabled = false; btn.textContent = 'Acceder a ChatLink';
        }
      });
    </script>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acceso a ChatLink</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #f0f2f5; display: flex; align-items: center;
    justify-content: center; min-height: 100vh; padding: 16px;
  }
  .inv-card {
    background: white; border-radius: 16px; padding: 36px 32px;
    width: min(400px, 100%); box-shadow: 0 4px 20px rgba(0,0,0,.12);
  }
  .inv-logo { font-size: 1.6rem; font-weight: 800; color: #00796b; margin-bottom: 20px; text-align: center; }
  .inv-greeting { font-size: 1.15rem; font-weight: 600; color: #222; margin-bottom: 8px; text-align: center; }
  .inv-sub { color: #666; font-size: 0.9rem; text-align: center; margin-bottom: 22px; line-height: 1.5; }
  input[type=password] {
    width: 100%; border: 1.5px solid #ddd; border-radius: 8px;
    padding: 11px 14px; font-size: 0.95rem; font-family: inherit;
    outline: none; margin-bottom: 12px; display: block;
  }
  input[type=password]:focus { border-color: #00796b; }
  button[type=submit] {
    width: 100%; background: #00796b; color: white; border: none;
    border-radius: 8px; padding: 12px; font-size: 1rem;
    font-weight: 600; cursor: pointer; margin-top: 4px;
  }
  button[type=submit]:hover { background: #00695c; }
  button:disabled { opacity: .6; cursor: not-allowed; }
  .inv-error {
    background: #fdecea; color: #c62828; border-radius: 8px;
    padding: 10px 14px; font-size: 0.88rem; margin-bottom: 14px;
  }
  .inv-ok {
    background: #e8f5e9; color: #2e7d32; border-radius: 8px;
    padding: 16px; text-align: center; font-weight: 600; line-height: 1.6;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #111; }
    .inv-card { background: #1e1e1e; }
    .inv-greeting { color: #eee; }
    .inv-sub { color: #aaa; }
    input[type=password] { background: #2a2a2a; border-color: #444; color: #eee; }
  }
</style>
</head>
<body>
<div class="inv-card">
  <div class="inv-logo">💬 ChatLink</div>
  <div class="inv-greeting">${greeting}</div>
  ${errorBlock}
  ${formBlock}
</div>
</body>
</html>`;
}

module.exports = router;
