const https = require('https');

const API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
const DEMO_MODE = !API_KEY;

function googleRequest(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'translation.googleapis.com',
      path: `/language/translate/v2?key=${API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function detectLanguage(text) {
  if (DEMO_MODE) return detectDemo(text);
  const res = await googleRequest({ q: text });
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
  const res = await googleRequest(body);
  return res.data?.translations?.[0]?.translatedText || text;
}

// Detección básica para modo demo
function detectDemo(text) {
  const lower = text.toLowerCase();
  if (/\b(the|is|are|can|door|hello|hi|help|room|wifi|code)\b/.test(lower)) return 'en';
  if (/\b(le|la|les|bonjour|merci|chambre|porte)\b/.test(lower)) return 'fr';
  if (/\b(der|die|das|hallo|bitte|danke|zimmer)\b/.test(lower)) return 'de';
  return 'en';
}

module.exports = { detectLanguage, translate, DEMO_MODE };
