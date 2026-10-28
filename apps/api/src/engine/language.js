// Multilingual support for tenant chat (English + Hindi). Two jobs:
//
//   1. Resolve the reply language — the UI's top-level selector
//      (body.language) is authoritative: the bot answers in it whatever the
//      question is typed in. Only when no selector is sent do we fall back to
//      detecting the message's own language (so a customer calling the chat
//      API directly still gets a sensible match).
//
//   2. Prompt fragment — a language directive appended to the user prompt,
//      where models follow a closing instruction most reliably (see
//      promptBuilder.js).
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
 * The language the bot must answer in. The UI's top-level selector wins: when
 * the widget/dashboard sends a language, that is the definitive reply
 * language, whatever the message is written in — so with the toggle on Hindi
 * an English question still gets a Hindi answer, and vice versa. Detection
 * from the message is only a fallback for callers that send no selector (e.g.
 * a customer hitting the chat API directly).
 * @param {unknown} uiHint  the UI's selected language (body.language)
 * @param {string} text     the visitor's message
 * @returns {'en'|'hi'}
 */
function resolveLanguage(uiHint, text) {
  return normalizeLanguage(uiHint) || detectLanguage(text) || DEFAULT_LANGUAGE;
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
      '\n\nCRITICAL INSTRUCTION (overrides everything else): Generate your ENTIRE response exclusively ' +
      'in natural, conversational Hindi written in Devanagari script. Disregard the language of the ' +
      "user's input text completely — reply in Hindi even if they wrote in English. Keep proper nouns, " +
      'brand and product names, email addresses, URLs and numbers exactly as they appear, and do not ' +
      'add any English translation.'
    );
  }
  return (
    '\n\nCRITICAL INSTRUCTION (overrides everything else): Generate your ENTIRE response exclusively in ' +
    "English. Disregard the language of the user's input text completely — reply in English even if they " +
    'wrote in another language.'
  );
}

module.exports = {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  detectLanguage,
  normalizeLanguage,
  resolveLanguage,
  languageDirective
};
