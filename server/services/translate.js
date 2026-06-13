const DEMO_MODE = !process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  process.env.NODE_ENV === 'development' && !require('fs').existsSync(
    process.env.GOOGLE_APPLICATION_CREDENTIALS || ''
  );

async function detectLanguage(text) {
  if (DEMO_MODE) {
    // Detección muy básica por palabras clave para el modo demo
    const lower = text.toLowerCase();
    if (/\b(the|is|are|can|door|hello|hi|help|room|wifi|code)\b/.test(lower)) return 'en';
    if (/\b(le|la|les|bonjour|merci|chambre|porte|wifi)\b/.test(lower)) return 'fr';
    if (/\b(der|die|das|hallo|bitte|danke|zimmer|tür)\b/.test(lower)) return 'de';
    return 'en';
  }

  const { TranslationServiceClient } = require('@google-cloud/translate').v3;
  const client = new TranslationServiceClient();
  const [response] = await client.detectLanguage({
    parent: `projects/${process.env.GOOGLE_PROJECT_ID}/locations/global`,
    content: text,
  });
  return response.languages[0].languageCode;
}

async function translate(text, targetLang, sourceLang = null) {
  if (DEMO_MODE) {
    if (targetLang === 'es') {
      return `⚠️ [Sin traducción real en modo DEMO] ${text}`;
    }
    return `⚠️ [No real translation in DEMO mode] ${text}`;
  }

  const { TranslationServiceClient } = require('@google-cloud/translate').v3;
  const client = new TranslationServiceClient();
  const [response] = await client.translateText({
    parent: `projects/${process.env.GOOGLE_PROJECT_ID}/locations/global`,
    contents: [text],
    targetLanguageCode: targetLang,
    ...(sourceLang && { sourceLanguageCode: sourceLang }),
  });
  return response.translations[0].translatedText;
}

module.exports = { detectLanguage, translate, DEMO_MODE };
