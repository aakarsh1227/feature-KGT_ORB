const { tokenize } = require('./shared/lexicalSearch');
const { normalizeQuestion } = require('../engine/answerCache');

// Follow-up question chips shown under a bot's latest reply (the widget and
// the Test Bots sandbox). No LLM call: they're picked from the tenant's own
// starter FAQs (services/tenantFaqs.js — written from its documents, so the
// bot can usually answer them), those sharing the most words with the turn
// just answered first. Questions already asked in the conversation are
// skipped. When fewer than MIN_FOLLOW_UPS tenant questions are left, the
// bot's generic follow-ups below fill in.

const MIN_FOLLOW_UPS = 2;
const MAX_FOLLOW_UPS = 3;

const GENERIC_FOLLOW_UPS = Object.freeze({
  support: ['How do I update my payment method?', 'What if my ticket is delayed?', 'How do I contact your support team?'],
  // Every one of these is safe for any tenant: the first and last are handoff
  // requests (domains/handoffActions.js), never a question about facts a
  // tenant's documents may not have (an earlier "What are the enterprise
  // pricing tiers?" invited exactly that).
  sales: ['Can I schedule a demo?', 'How do I get started?', 'Can I talk to someone on your team?']
});

// Hindi equivalents, shown when the selected language is Hindi so the generic
// fallback chips aren't English under a Hindi conversation.
const GENERIC_FOLLOW_UPS_HI = Object.freeze({
  support: ['मैं अपनी भुगतान विधि कैसे बदलूँ?', 'अगर मेरा टिकट देर से हल हो तो क्या होगा?', 'मैं आपकी सहायता टीम से कैसे संपर्क करूँ?'],
  sales: ['क्या मैं डेमो शेड्यूल कर सकता हूँ?', 'मैं कैसे शुरू करूँ?', 'क्या मैं आपकी टीम से बात कर सकता हूँ?']
});

/**
 * @param {{ botType: 'support'|'sales', faqs?: string[], asked?: string[], query: string, answer?: string, language?: 'en'|'hi' }} params
 *   faqs: the tenant's FAQs for this bot IN THE ACTIVE LANGUAGE (the caller
 *   picks the English or Hindi list); asked: questions already asked this
 *   session; language: which generic fallback set to use when the tenant's
 *   own questions run out.
 * @returns {string[]} 0-3 questions, most relevant first
 */
function pickFollowUps({ botType, faqs = [], asked = [], query, answer = '', language }) {
  const seen = new Set([...asked, query].map(normalizeQuestion));
  const fresh = (questions) => questions.filter((q) => {
    const key = normalizeQuestion(q);
    if (!key || seen.has(key)) return false;
    seen.add(key); // also drops duplicates within the list
    return true;
  });

  const context = new Set(tokenize(`${query} ${answer}`));
  const overlap = (q) => tokenize(q).filter((t) => context.has(t)).length;
  const tenantPicks = fresh(faqs)
    .map((q, i) => ({ q, i, score: overlap(q) }))
    .sort((a, b) => b.score - a.score || a.i - b.i) // stable: the FAQ list's own order breaks ties
    .map((x) => x.q)
    .slice(0, MAX_FOLLOW_UPS);

  if (tenantPicks.length >= MIN_FOLLOW_UPS) return tenantPicks;
  const generics = (language === 'hi' ? GENERIC_FOLLOW_UPS_HI : GENERIC_FOLLOW_UPS)[botType] || [];
  return [...tenantPicks, ...fresh(generics)].slice(0, MAX_FOLLOW_UPS);
}

module.exports = { pickFollowUps, GENERIC_FOLLOW_UPS, GENERIC_FOLLOW_UPS_HI, MIN_FOLLOW_UPS, MAX_FOLLOW_UPS };
