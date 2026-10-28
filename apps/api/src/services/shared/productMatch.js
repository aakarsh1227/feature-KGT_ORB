// Finds which catalog products a chat turn is about, so the API can attach
// rich product cards. Pure and synchronous: the caller loads the tenant's
// products (services/catalogIngest.js) and passes the text to scan — usually
// the visitor's question (optionally plus the bot's answer).
//
// Scoring is fuzzy keyword relevance in [0,1] (not embeddings — we have no
// vector service): a product scores on how well the query's meaningful words
// match its name, category, description and SKU, with typo / substring /
// singular-plural tolerance. A product is matched when it scores above
// THRESHOLD (0.6 = ">60%"). Because the score is coverage-based, a stray
// adjective ("I feel blue") scores low and is dropped, while a real product
// query ("blue hoodie", "do you have Pranaa?") scores high — the same logic
// for both bots, so Support and Sales always match identically.

const DEFAULT_LIMIT = 3;
const THRESHOLD = 0.6;
const MAX_DESC_TERMS = 60; // cap long descriptions so scoring stays cheap

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'am', 'be', 'do', 'does', 'did', 'you', 'your', 'yours', 'i', 'me', 'my',
  'we', 'us', 'our', 'it', 'its', 'this', 'that', 'these', 'those', 'to', 'of', 'for', 'in', 'on', 'at',
  'by', 'with', 'and', 'or', 'but', 'if', 'about', 'any', 'some', 'all', 'please', 'can', 'could', 'would',
  'will', 'tell', 'show', 'see', 'get', 'have', 'has', 'want', 'need', 'looking', 'look', 'what', 'whats',
  'which', 'how', 'much', 'many', 'there', 'here', 'now', 'today', 'me', 'give', 'find', 'like', 'more'
]);

const PRODUCT_NOUN = /\b(products?|items?|catalog(ue)?|courses?|inventory|stock|collection|offerings?|merchandise|skus?)\b/i;
const LIST_CUE = /\b(list|show|see|view|browse|display|all|available|what|which|your)\b/i;
const SELL_VERB = /\bdo\s+you\s+(sell|stock|carry)\b/i;

function isProductListingIntent(text) {
  const s = String(text || '');
  if (SELL_VERB.test(s)) return true;
  return PRODUCT_NOUN.test(s) && LIST_CUE.test(s);
}

// Does this message look like a follow-up that refers to products shown a
// moment ago WITHOUT naming them? ("link as well", "give me their links",
// "show images of those", "can I buy those?") The cues are deliberately
// narrow — media/link words and back-reference pronouns — so a brand-new,
// unrelated question ("more about your refund policy") does not trip it.
// Used only to decide whether to carry the last turn's matched products
// forward when the current turn names none itself (services/tenantChat.js);
// it never fires on its own, only when direct matching found nothing and a
// prior product context exists.
const FOLLOWUP_REF = /\b(links?|urls?|images?|pictures?|photos?|pics?|thumbnails?|buy|purchase|those|them|these|their|theirs)\b/i;

function isProductFollowUp(text) {
  return FOLLOWUP_REF.test(String(text || ''));
}

// Meaningful lowercase word tokens, stopwords and 1-char noise removed.
function tokens(text) {
  return String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((w) => w.length >= 2 && !STOPWORDS.has(w)) || [];
}

// A bounded edit distance (returns early once it exceeds `max`).
function withinEdits(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

const depluralize = (w) => (w.length > 4 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

// Does query term `q` match field term `f`? Exact, singular/plural, substring
// (>=4 chars), or a single typo (>=4 chars).
function termMatch(q, f) {
  if (q === f) return true;
  if (depluralize(q) === depluralize(f)) return true;
  if (q.length >= 4 && f.length >= 4 && (q.includes(f) || f.includes(q))) return true;
  if (q.length >= 4 && f.length >= 4 && withinEdits(q, f, 1)) return true;
  return false;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function phraseInText(text, phrase) {
  if (!phrase) return false;
  return new RegExp(`(^|[^\\w-])${escapeRegExp(phrase)}([^\\w-]|$)`, 'i').test(text);
}

function toCard(p) {
  return {
    sku: p.sku,
    name: p.name,
    price: p.price || '',
    description: p.description || '',
    imageUrl: p.imageUrl || null,
    productUrl: p.productUrl || null
  };
}

/**
 * Relevance of `qTerms` (the query's tokens) to one product, in [0,1].
 * Exact SKU or full-name mention is a 1. Otherwise the stronger of: how much
 * of the product's NAME the query hits, and how much of the QUERY the product
 * (name + category + description + sku) explains — so both a terse "hoodie"
 * and a verbose "I'd love that blue hoodie please" score high, while a lone
 * stray adjective does not.
 */
function scoreProduct(p, qTerms, rawText) {
  const name = String(p.name || '').trim();
  const sku = String(p.sku || '').trim();
  if (sku.length >= 2 && phraseInText(rawText, sku)) return 1;
  if (name.length >= 3 && phraseInText(rawText, name)) return 1;
  if (!qTerms.length) return 0;

  const nameTerms = tokens(name);
  const fieldTerms = [...nameTerms, ...tokens(p.category), ...tokens(p.description).slice(0, MAX_DESC_TERMS)];
  if (sku) fieldTerms.push(sku.toLowerCase());
  if (!fieldTerms.length) return 0;

  const hitsIn = (pool) => qTerms.filter((q) => pool.some((f) => termMatch(q, f))).length;
  const queryCoverage = hitsIn(fieldTerms) / qTerms.length;
  const nameCoverage = nameTerms.length ? hitsIn(nameTerms) / nameTerms.length : 0;
  return Math.max(queryCoverage, nameCoverage);
}

/**
 * @param {Array<object>} products  catalog rows
 * @param {string} text  the text to scan (e.g. `${query}\n${answer}`)
 * @param {{ limit?: number, listIntent?: boolean, threshold?: number }} [opts]
 * @returns {Array<{sku,name,price,description,imageUrl,productUrl}>} best matches first, capped
 */
function matchProducts(products, text, { limit = DEFAULT_LIMIT, listIntent = false, threshold = THRESHOLD } = {}) {
  if (!Array.isArray(products) || !products.length) return [];
  const raw = String(text || '');
  if (!raw.trim() && !listIntent) return [];
  const qTerms = tokens(raw);

  const scored = products
    .map((p) => ({ p, score: scoreProduct(p, qTerms, raw) }))
    .filter((x) => x.score > threshold)
    .sort((a, b) => b.score - a.score);

  const seen = new Set();
  const out = [];
  const push = (p) => {
    const k = p.id || `${p.sku}\u0000${p.name}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(toCard(p));
  };
  for (const { p } of scored) { if (out.length >= limit) break; push(p); }
  // A listing request ("show me your products") tops up with the first items.
  if (listIntent) { for (const p of products) { if (out.length >= limit) break; push(p); } }
  return out.slice(0, limit);
}

module.exports = { matchProducts, isProductListingIntent, isProductFollowUp, scoreProduct, THRESHOLD, DEFAULT_LIMIT };
