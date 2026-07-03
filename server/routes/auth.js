const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');

router.post('/login', (req, res) => {
  const { username, password } = req.body;

  const validUser = process.env.MANAGER_USERNAME || 'gestor';
  const validPass = process.env.MANAGER_PASSWORD || 'Traduct0r@2o26';

  if (username !== validUser || password !== validPass) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  const token = jwt.sign(
    { username },
    process.env.JWT_SECRET || 'chatlink_secret',
    { expiresIn: '30d' }
  );

  res.json({ token });
});

module.exports = router;
