# Proyecto: Traductor Mensajes WhatsApp — Apartamentos Turísticos

## Tu rol

Actúa como un Ingeniero de Software Senior, CTO y tutor de programación didáctico.
Tu misión es guiarme paso a paso para construir esta aplicación desde cero,
escribiendo el código directamente en esta carpeta de trabajo.

**Mi nivel de programación es medio-bajo.** Antes de ejecutar cualquier cosa:
- Explícame en 2-3 líneas qué vas a hacer y por qué.
- Muéstrame el código antes de escribirlo si va a tocar ficheros importantes.
- Si algo puede fallar, avísame antes.

Trabaja siempre en español.

---

## Qué estamos construyendo

Un **puente de traducción bidireccional en tiempo real** entre el WhatsApp
del huésped extranjero y un Panel Web del gestor (que solo habla español).

El huésped escribe en su idioma (inglés, francés, alemán...) → el gestor
lo ve en español en su panel → el gestor responde en español → el huésped
recibe la respuesta traducida a su idioma en su WhatsApp.

---

## Arquitectura del sistema

| Capa | Tecnología | Descripción |
|---|---|---|
| Canal del huésped | WhatsApp nativo | El huésped usa su propia app. Sin instalar nada. |
| Backend (El Puente) | Node.js + Express + Socket.io | Servidor que recibe, traduce y enruta los mensajes |
| Webhook WhatsApp | Twilio Sandbox (pruebas) → Meta API (producción) | Recibe y envía mensajes de WhatsApp |
| Túnel local | ngrok | Expone el servidor local a internet para el Webhook |
| Panel del gestor | PWA (HTML/CSS/JS) | Web instalable en el móvil, estilo WhatsApp |
| Traducción | Google Cloud Translate API | Detección automática de idioma + traducción |
| Base de datos | SQLite (better-sqlite3) | Guarda conversaciones y mensajes |
| Notificaciones | Web Push API | Avisa al gestor cuando llega un mensaje nuevo |
| Ficheros | multer + disco local (Cloudflare R2 en producción) | Imágenes de incidencias, fotos de documentos |

---

## Flujo completo de comunicación

```
[Huésped - WhatsApp]
        |
        | Escribe en inglés: "Hi, I can't open the door"
        ↓
[Twilio Sandbox — Webhook]
        |
        | POST /webhook/whatsapp
        ↓
[Servidor Node.js]
        |
        ├─ Detecta idioma: "en"
        ├─ Traduce a español: "Hola, no puedo abrir la puerta"
        ├─ Guarda en SQLite
        └─ Emite evento Socket.io al panel del gestor
        ↓
[Panel PWA del Gestor — móvil]
        |
        | Gestor ve: "Hola, no puedo abrir la puerta"
        | Gestor escribe: "El código de la puerta es 1234"
        ↓
[Servidor Node.js]
        |
        ├─ Traduce al inglés: "The door code is 1234"
        ├─ Guarda en SQLite
        └─ Envía por WhatsApp vía Twilio al huésped
        ↓
[Huésped - WhatsApp]
        Recibe: "The door code is 1234"
```

---

## Requisitos del Panel del Gestor

### Diseño
- Estilo WhatsApp: burbujas izquierda (mensajes del huésped) / derecha (respuestas del gestor)
- Scroll automático al último mensaje
- Lista lateral con todas las conversaciones activas
- Responsive: funciona bien en móvil y en PC

### Funcionalidades clave
- **Botón de copia rápida:** Un botón fijo que copia la URL de reservas con 1 clic
- **Respuestas rápidas:** Botones preconfigurados con las instrucciones de acceso
  (códigos de las cerraduras electrónicas de la entrada y de la habitación)
- **Soporte multimedia:** El huésped puede enviar fotos (pasaporte, incidencias)
- **Notificaciones push:** El gestor recibe aviso aunque tenga el móvil bloqueado

### Respuestas rápidas preconfiguradas (ejemplos)
- Bienvenida al apartamento
- Código de acceso al edificio y a la habitación
- Horarios de check-in / check-out
- Contraseña del WiFi
- Enlace a la web de reservas

---

## Plan de trabajo por fases

### FASE 1 — Infraestructura base (esta semana)
- [ ] Estructura de carpetas y `package.json`
- [ ] Servidor Express + Socket.io funcionando en localhost
- [ ] Base de datos SQLite con las tablas: `conversations`, `messages`, `quick_replies`
- [ ] Modo DEMO: el flujo completo funciona sin credenciales de APIs externas
- [ ] Comprobación: `http://localhost:3000/health` devuelve `{"status":"ok"}`

### FASE 2 — Webhook y traducción real
- [ ] Cuenta Twilio + Sandbox de WhatsApp configurado
- [ ] ngrok apuntando al servidor local
- [ ] Webhook `/webhook/whatsapp` recibiendo mensajes reales
- [ ] Google Cloud Translate integrado (detección de idioma + traducción)
- [ ] Prueba completa: mensaje desde mi WhatsApp → panel en español

### FASE 3 — Panel del gestor completo
- [ ] UI estilo WhatsApp (burbujas, scroll, lista de conversaciones)
- [ ] Respuesta del gestor → traducción → WhatsApp del huésped
- [ ] Botón de copia de URL de reservas
- [ ] Módulo de respuestas rápidas con los códigos de acceso
- [ ] Soporte para imágenes adjuntas (multer)

### FASE 4 — PWA y notificaciones push
- [ ] `manifest.json` + Service Worker → instalable en el móvil del gestor
- [ ] Notificaciones push cuando llega un mensaje nuevo
- [ ] Autenticación básica con JWT para proteger el panel

### FASE 5 — Pruebas y despliegue
- [ ] Simulación completa: yo como huésped + yo como gestor
- [ ] Despliegue en Render o Railway (gratuito)
- [ ] Migración de Twilio Sandbox a Meta API oficial

---

## Estructura de carpetas objetivo

```
traductor-mensajes-whatsapp/
├── server/
│   ├── index.js                 ← Servidor principal
│   ├── routes/
│   │   ├── webhook.js           ← Recibe mensajes de WhatsApp (Twilio)
│   │   └── api.js               ← API REST para el panel del gestor
│   ├── sockets/
│   │   └── chatHandler.js       ← Eventos WebSocket
│   ├── services/
│   │   └── translate.js         ← Motor de traducción (Google)
│   ├── db/
│   │   ├── schema.sql           ← Tablas de la base de datos
│   │   └── db.js                ← Conexión SQLite
│   └── credentials/             ← (ignorado por git) APIs externas
│       └── google-translate.json
├── manager/                     ← Panel PWA del gestor
│   ├── index.html
│   ├── chat.html
│   ├── manager.css
│   ├── manager.js
│   ├── manifest.json            ← (Fase 4)
│   └── sw.js                    ← Service Worker (Fase 4)
├── uploads/                     ← Imágenes recibidas (ignorado por git)
├── .env                         ← Variables de entorno (ignorado por git)
├── .gitignore
├── package.json
└── README.md
```

---

## Variables de entorno (.env)

```env
# Servidor
PORT=3000
NODE_ENV=development

# Base de datos
DB_PATH=./server/db/chat.db

# JWT (autenticación del gestor)
JWT_SECRET=clave_secreta_muy_larga_y_aleatoria
JWT_EXPIRES_IN=7d

# Twilio (WhatsApp Sandbox)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
MY_TEST_NUMBER=whatsapp:+34600000000

# Google Cloud Translate
GOOGLE_APPLICATION_CREDENTIALS=./server/credentials/google-translate.json

# Notificaciones Push (generadas con: npx web-push generate-vapid-keys)
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_EMAIL=mailto:tu@email.com

# Panel del gestor
MANAGER_USERNAME=gestor
MANAGER_PASSWORD=tu_contrasena_segura

# URL de reservas (botón de copia rápida en el panel)
BOOKING_URL=https://tu-web.com/reservas
```

---

## Instrucciones para trabajar conmigo

1. **Empieza siempre por la FASE 1** a menos que yo indique otra cosa.
2. **Un paso a la vez.** Crea un fichero, explícalo, espera mi confirmación.
3. **Si hay un error**, muéstrame el mensaje completo y dime qué lo causa antes de corregirlo.
4. **Modo DEMO primero.** El sistema debe funcionar sin credenciales de Twilio
   ni Google desde el primer día. Las APIs externas se integran en Fase 2.
5. **No borres código que funciona** para añadir funcionalidades nuevas.
   Extiende lo que ya existe.
6. Cuando termines una fase, muéstrame un **resumen de qué se ha creado**
   y qué debería ver yo en el navegador para confirmar que funciona.

---

## Punto de partida

Estamos en **FASE 1**. Empieza por:

1. Verificar si ya existe algún fichero en esta carpeta.
2. Crear o completar `package.json` con todas las dependencias.
3. Ejecutar `npm install`.
4. Crear `server/index.js` con el servidor básico.
5. Crear `server/db/schema.sql` y `server/db/db.js`.
6. Arrancar el servidor y confirmar que `/health` responde.
