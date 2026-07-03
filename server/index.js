require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const db = require('./db/db');
const { DEMO_MODE } = require('./services/translate');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Rutas públicas (antes del static y del auth)
const authRouter = require('./routes/auth');
app.use('/auth', authRouter);

// Webhook público — Meta necesita acceso sin token
const webhookRouter = require('./routes/webhook');
webhookRouter.io = io;
app.use('/webhook', webhookRouter);

// Middleware JWT — protege /api y el panel
const jwt = require('jsonwebtoken');
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'chatlink_secret');
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o caducado' });
  }
}

const apiRouter = require('./routes/api');
app.use('/api', requireAuth, apiRouter);

// Archivos estáticos del panel (login.html es público, index.html protegido)
app.use(express.static(path.join(__dirname, '../manager')));

// Compartir io con rutas y sockets
app.set('io', io);

// Endpoint de comprobación de salud
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: DEMO_MODE ? 'DEMO' : 'PRODUCCIÓN',
    timestamp: new Date().toISOString()
  });
});

// Panel del gestor — inyecta el phone_number_id activo como variable global JS
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../manager/index.html'));
});

app.get('/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`window.CHATLINK_PHONE_NUMBER_ID = ${JSON.stringify(process.env.WHATSAPP_PHONE_NUMBER_ID || null)};`);
});

// Sockets
const registerChatHandlers = require('./sockets/chatHandler');
registerChatHandlers(io, app);

// Arranque del servidor (inicializa la BD primero)
async function start() {
  await db.getDb();
  server.listen(PORT, () => {
    console.log('');
    console.log('🚀 Servidor arrancado en http://localhost:' + PORT);
    console.log('📋 Modo: ' + (DEMO_MODE ? 'DEMO (sin APIs externas)' : 'PRODUCCIÓN'));
    console.log('❤️  Health check: http://localhost:' + PORT + '/health');
    console.log('📱 Panel del gestor: http://localhost:' + PORT);
    console.log('');
  });
}

start().catch(err => {
  console.error('Error al arrancar el servidor:', err);
  process.exit(1);
});
