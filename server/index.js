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
app.use(express.static(path.join(__dirname, '../manager')));

// Compartir io con rutas y sockets
app.set('io', io);

// Rutas
const webhookRouter = require('./routes/webhook');
const apiRouter = require('./routes/api');

webhookRouter.io = io;
app.use('/webhook', webhookRouter);
app.use('/api', apiRouter);

// Endpoint de comprobación de salud
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: DEMO_MODE ? 'DEMO' : 'PRODUCCIÓN',
    timestamp: new Date().toISOString()
  });
});

// Panel del gestor
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../manager/index.html'));
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
