const llmClient = require('./llmClient'); // through the module so a test's mock is used
const { store } = require('../lib/sharedStore');

// Cross-lingual retrieval. Uploaded documents and scraped pages are English,
// and retrieval is lexical (services/shared/lexicalSearch.js), so a question
// typed in Hindi (Devanagari) shares no words with the English chunks and
// matches nothing. Before retrieval we translate such a question to English
// and search with that; the model still receives the user's real question and
// answers in the selected language (engine/language.js).
//
// Only the RETRIEVAL query is translated — the prompt and the answer cache key
// keep the original text. One cheap LLM call per distinct question, cached in
// the shared store so every instance and every later turn reuses it.

const DEVANAGARI = /[ऀ-ॿ]/;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a question's English form doesn't change
const MAX_LEN = 1000; // same ceiling as a chat query (services/tenantChat.js)

function cacheKey(query) {
  // Collapse whitespace and cap length so the key is bounded and stable.
  return `qtr:${query.replace(/\s+/g, ' ').trim().slice(0, MAX_LEN)}`;
}

const SYSTEM_PROMPT =
  'You are a translation engine. Translate the user\'s message into English for a keyword search. ' +
  'Output ONLY the English translation — no quotes, no notes. Keep proper nouns, brand and product ' +
  'names, email addresses, URLs and numbers unchanged. If it is already English, return it unchanged.';

/**
 * The query to run retrieval with. Returns the original unchanged when it has
 * no Devanagari (nothing to translate) or when translation is unavailable —
 * retrieval then simply behaves as it did before, so this can never make a
 * turn fail.
 * @param {string} query the visitor's message
 * @returns {Promise<string>}
 */
async function translateQueryForRetrieval(query) {
  const text = String(query || '');
  if (!DEVANAGARI.test(text)) return text; // English / romanized: search as-is

  const key = cacheKey(text);
  try {
    const cached = await store().get(key);
    if (typeof cached === 'string' && cached) return cached;
  } catch { /* cache unavailable: fall through to a fresh translation */ }

  try {
    const { text: translated } = await llmClient.generateAnswer({ systemPrompt: SYSTEM_PROMPT, userPrompt: text });
    const english = String(translated || '').trim();
    if (!english) return text;
    store().set(key, english, CACHE_TTL_MS).catch(() => {}); // best-effort; don't block the turn
    return english;
  } catch {
    return text; // LLM down: search with the original (likely no match → a graceful fallback reply)
  }
}

module.exports = { translateQueryForRetrieval };
