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

// Webhook público de Telegram (verifica secreto propio en cada petición)
const webhookTelegramRouter = require('./routes/webhookTelegram');
app.use('/webhook', webhookTelegramRouter);

// Middleware JWT — protege /api (verifica token, sesión antigua y cambio de contraseña pendiente)
const { requireAuth } = require('./middleware/auth');

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
  res.send(`
    window.CHATLINK_PHONE_NUMBER_ID = ${JSON.stringify(process.env.WHATSAPP_PHONE_NUMBER_ID || null)};
    window.CHATLINK_COMPANY_NAME = ${JSON.stringify(process.env.COMPANY_NAME || 'Tecorem')};
  `);
});

// Sockets — verificación de identidad al conectar (Sprint 2: permisos por rol)
const jwtSocket = require('jsonwebtoken');
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    socket.user = jwtSocket.verify(token, process.env.JWT_SECRET || 'chatlink_secret');
    next();
  } catch {
    next(new Error('No autorizado'));
  }
});

const registerChatHandlers = require('./sockets/chatHandler');
registerChatHandlers(io, app);

// Arranque del servidor (inicializa la BD, aplica migraciones, crea gestor inicial y cron)
async function start() {
  await db.getDb();
  const { bootstrapAdmin } = require('./db/bootstrap');
  await bootstrapAdmin();
  const { startCronJobs } = require('./services/cronJobs');
  startCronJobs(io, app);
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
