// Multilingual support for tenant chat (English + Hindi). Two jobs:
//
//   1. Contextual language matching — look at what the visitor actually
//      typed and decide which language the bot must answer in, so a Hindi
//      question gets a Hindi answer and an English question an English one,
//      regardless of the UI language the widget picked. The widget's selected
//      language is only a hint, used when the message itself gives no signal
//      (a bare "ok", an emoji, a number).
//
//   2. Prompt fragments — a language directive appended to the user prompt
//      (where models follow a closing instruction most reliably, see
//      promptBuilder.js), and a self-contained translation prompt for the
//      per-message "Translate" button (services/tenantChat.js runTranslate).
//
// Only en/hi are supported; everything normalizes to one of those two.

const LANGUAGES = Object.freeze({ en: 'English', hi: 'Hindi' });
const DEFAULT_LANGUAGE = 'en';

// Devanagari block: the clearest possible signal that a message is in Hindi.
const DEVANAGARI = /[ऀ-ॿ]/;

// Romanized Hindi ("Hinglish") written in the Latin alphabet — no Devanagari
// to key on, so we match a curated set of common, reasonably Hindi-specific
// tokens. Deliberately conservative (words that rarely occur in English
// text) to avoid flipping genuine English messages to Hindi. A single hit is
// enough: romanized Hindi almost always carries several of these.
const ROMANIZED_HINDI = new Set([
  'kya', 'kyaa', 'kyun', 'kyon', 'kyunki', 'kyoki', 'hai', 'hain', 'hei',
  'nahi', 'nahin', 'nhi', 'haan', 'haa', 'ji',
  'kaise', 'kaisa', 'kaisi', 'kahan', 'kaha', 'kab', 'kaun', 'kitna', 'kitni',
  'kitne', 'kitna', 'kyonki',
  'aap', 'tum', 'main', 'mein', 'mera', 'meri', 'mere', 'mujhe', 'muje',
  'hum', 'humein', 'hamein', 'hamara', 'hamari', 'tumhara', 'aapka', 'aapke', 'aapki',
  'karna', 'karne', 'karo', 'kare', 'karen', 'krna', 'krne', 'kiya', 'karta', 'karti',
  'chahiye', 'chahie', 'sakta', 'sakti', 'sakte', 'hoga', 'hogi', 'hoga',
  'batao', 'bataye', 'bataiye', 'samajh', 'samjha', 'matlab',
  'acha', 'accha', 'achha', 'theek', 'thik', 'bilkul',
  'kripya', 'kripaya', 'dhanyavaad', 'dhanyawad', 'shukriya', 'namaste', 'namaskar',
  'paisa', 'paise', 'rupaye', 'rupay', 'kitna', 'jankari', 'madad', 'sahayata'
]);

/**
 * Best guess at the language a message is written in.
 * @param {string} text
 * @returns {'en'|'hi'|null} 'hi'/'en' when there's a clear signal, null when
 *   the text carries none (empty, punctuation/emoji/numbers only) — the
 *   caller then falls back to the UI's selected language.
 */
function detectLanguage(text) {
  const str = String(text || '');
  if (DEVANAGARI.test(str)) return 'hi';

  const tokens = str.toLowerCase().match(/[a-z]+/g);
  if (!tokens || !tokens.length) return null; // no letters to judge — ambiguous
  if (tokens.some((t) => ROMANIZED_HINDI.has(t))) return 'hi';
  return 'en';
}

/**
 * Normalizes an arbitrary language value (from a request body or the widget)
 * to a supported code, or null if it isn't one.
 * @param {unknown} value
 * @returns {'en'|'hi'|null}
 */
function normalizeLanguage(value) {
  const code = String(value || '').trim().toLowerCase();
  return code === 'en' || code === 'hi' ? code : null;
}

/**
 * The language the bot must answer in: what the visitor actually wrote wins,
 * so a Hindi message always gets a Hindi answer and an English message an
 * English one. The UI hint (the widget's selected language) is used only when
 * the message itself is too short/ambiguous to tell.
 * @param {unknown} uiHint  the widget's selected language (body.language)
 * @param {string} text     the visitor's message
 * @returns {'en'|'hi'}
 */
function resolveLanguage(uiHint, text) {
  return detectLanguage(text) || normalizeLanguage(uiHint) || DEFAULT_LANGUAGE;
}

/**
 * Closing instruction appended to the user prompt pinning the reply language.
 * Placed by promptBuilder.js right after the question (and before the
 * citation line), where models honour a short directive most reliably.
 * @param {'en'|'hi'} lang
 */
function languageDirective(lang) {
  if (lang === 'hi') {
    return (
      '\n\nLANGUAGE (highest priority): The user is writing in Hindi, so write your ENTIRE reply in ' +
      'natural, conversational Hindi using Devanagari script. Keep proper nouns, brand and product ' +
      'names, email addresses, URLs and numbers exactly as they appear. Do not add an English ' +
      'translation or restate anything in English.'
    );
  }
  return '\n\nLANGUAGE (highest priority): Write your entire reply in English.';
}

/**
 * Self-contained system prompt for the per-message translation helper. It
 * translates one already-written bot reply; it never answers questions, so it
 * needs no tenant persona or knowledge — and runs outside the chat session,
 * leaving conversation state untouched.
 * @param {'en'|'hi'} target
 */
function translationSystemPrompt(target) {
  const name = LANGUAGES[target] || LANGUAGES.en;
  return (
    `You are a translation engine. Translate the user's message into ${name}.\n` +
    'Rules:\n' +
    '- Output ONLY the translation — no preamble, no quotation marks, no notes, no explanation.\n' +
    '- Preserve the meaning, tone and formatting: keep line breaks, "• " bullet markers and ' +
    'numbered steps exactly as they are.\n' +
    '- Keep proper nouns, brand and product names, email addresses, URLs and numbers unchanged.\n' +
    `- If the text is already in ${name}, return it unchanged.`
  );
}

module.exports = {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  detectLanguage,
  normalizeLanguage,
  resolveLanguage,
  languageDirective,
  translationSystemPrompt
};
