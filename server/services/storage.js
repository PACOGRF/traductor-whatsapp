// Archivos en Supabase Storage (Sprint 5 — bucket privado 'chatlink-files').
// Regla: los archivos NUNCA van a la base de datos ni al disco de Render.
// Se sirven con URLs firmadas temporales (datos confidenciales).

const BUCKET = 'chatlink-files';
const MAX_FILE_BYTES = 16 * 1024 * 1024;   // 16 MB (límite del canal, decisión cerrada)

// Tipos permitidos (decisión cerrada + doc/xls por comodidad)
const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'ogg', 'mp3', 'm4a', 'pdf', 'doc', 'docx', 'xls', 'xlsx'];

let client = null;
function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  if (!client) {
    const { createClient } = require('@supabase/supabase-js');
    client = createClient(url, key);
  }
  return client;
}

function storageEnabled() { return !!getClient(); }

// Clasifica el tipo de media a partir de la extensión
function mediaTypeFor(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image';
  if (ext === 'mp4') return 'video';
  if (['ogg', 'mp3', 'm4a'].includes(ext)) return 'audio';
  return 'document';
}

function extensionAllowed(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext);
}

// Nombre seguro para la ruta del bucket
function safeName(filename) {
  return (filename || 'archivo').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
}

// Sube un buffer → { ok, path?, error? }
async function uploadBuffer(path, buffer, contentType) {
  const c = getClient();
  if (!c) return { ok: false, error: 'Almacenamiento no configurado (falta SUPABASE_SERVICE_KEY en Render)' };
  const { error } = await c.storage.from(BUCKET).upload(path, buffer, {
    contentType: contentType || 'application/octet-stream',
    upsert: false,
  });
  if (error) return { ok: false, error: 'Storage: ' + error.message };
  return { ok: true, path };
}

// URL firmada temporal para ver/descargar (1 hora por defecto)
async function signedUrl(path, seconds = 3600) {
  const c = getClient();
  if (!c || !path) return null;
  const { data, error } = await c.storage.from(BUCKET).createSignedUrl(path, seconds);
  if (error || !data) return null;
  return data.signedUrl;
}

module.exports = { storageEnabled, uploadBuffer, signedUrl, mediaTypeFor, extensionAllowed, safeName, MAX_FILE_BYTES, ALLOWED_EXTENSIONS };
