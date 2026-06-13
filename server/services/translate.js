const https = require('https');

const API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
const DEMO_MODE = !API_KEY;

function googleRequest(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'translation.googleapis.com',
      path: `${path}?key=${API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Devuelve { translatedText, detectedLanguage }
async function translateWithDetection(text, targetLang) {
  if (DEMO_MODE) {
    return {
      translatedText: `⚠️ [Sin traducción real en modo DEMO] ${text}`,
      detectedLanguage: detectDemo(text),
    };
  }
  // Sin 'source': Google detecta el idioma automáticamente y lo devuelve en la respuesta
  const res = await googleRequest('/language/translate/v2', { q: text, target: targetLang, format: 'text' });
  const t = res.data?.translations?.[0];
  return {
    translatedText: t?.translatedText || text,
    detectedLanguage: t?.detectedSourceLanguage || 'en',
  };
}

async function detectLanguage(text) {
  if (DEMO_MODE) return detectDemo(text);
  const res = await googleRequest('/language/translate/v2/detect', { q: text });
  return res.data?.detections?.[0]?.[0]?.language || 'en';
}

async function translate(text, targetLang, sourceLang = null) {
  if (DEMO_MODE) {
    return targetLang === 'es'
      ? `⚠️ [Sin traducción real en modo DEMO] ${text}`
      : `⚠️ [No real translation in DEMO mode] ${text}`;
  }
  const body = { q: text, target: targetLang, format: 'text' };
  if (sourceLang) body.source = sourceLang;
  const res = await googleRequest('/language/translate/v2', body);
  return res.data?.translations?.[0]?.translatedText || text;
}

// Detección básica para modo demo
function detectDemo(text) {
  const lower = text.toLowerCase();
  if (/\b(the|is|are|can|door|hello|hi|help|room|wifi|code)\b/.test(lower)) return 'en';
  if (/\b(le|la|les|bonjour|merci|chambre|porte)\b/.test(lower)) return 'fr';
  if (/\b(der|die|das|hallo|bitte|danke|zimmer|guten)\b/.test(lower)) return 'de';
  return 'en';
}

module.exports = { detectLanguage, translate, translateWithDetection, DEMO_MODE };
