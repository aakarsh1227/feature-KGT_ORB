const { store, keys } = require('../lib/sharedStore');

// LRU cache of LLM answers, so a repeated question costs nothing.
//
// Key: `${tenantId}:${botType}:${normalizedQuestion}`. Tenant and bot are
// both in every key, so a lookup can only ever reach entries written for the
// same tenant AND the same bot: Tenant A's answers are unreachable from
// Tenant B, and a Sales answer is never served to a Support question.
//
// Why caching the answer is safe: a bot's prompt is built only from the
// tenant's settings, its knowledge base and the question (promptBuilder.js
// does not include conversation history). So the cache is dropped for a
// tenant whenever either of those changes: invalidateTenantKnowledge()
// (every document add/edit/delete/import) and a tenant settings update both
// call invalidateTenant() here.
//
// The ANSWERS are held per process; the per-tenant GENERATION that decides
// whether they are still valid lives in lib/sharedStore.js. That split is
// deliberate:
//   - answer text never crosses the network, so a cache hit stays free;
//   - but an invalidation is seen by every instance. With the counter held
//     locally, a document edited on instance A left instance B serving
//     answers written from the old content indefinitely, with no event that
//     would ever clear it. That is a correctness bug, not a hit-rate one.
// A generation read also guards the race where documents change while an
// answer is being generated: set() refuses to store it afterwards.
//
// Node runs this on one thread, so the local Map needs no locking. Entries
// hold the raw model text plus what it cost, which is what a later hit
// reports as saved.

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
// Shared across every tenant, so this divides by tenant count: 5000 left
// only ~70 cached questions per company at 70 tenants, and each eviction is a
// paid LLM call the next time that question is asked. Entries are small (the
// model's answer text plus its token counts).
const DEFAULT_MAX_ENTRIES = 20000;
const MAX_QUESTION_KEY_LEN = 500;

function config() {
  const ttlHours = Number(process.env.ANSWER_CACHE_TTL_HOURS);
  const max = Number(process.env.ANSWER_CACHE_MAX_ENTRIES);
  return {
    enabled: String(process.env.ANSWER_CACHE_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    ttlMs: Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours * 60 * 60 * 1000 : DEFAULT_TTL_MS,
    maxEntries: Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_ENTRIES
  };
}

/**
 * Lowercase, Unicode-normalized, punctuation and symbols stripped, whitespace
 * collapsed: "What's your PRICING??" and "whats your pricing" share an entry.
 * Apostrophes are dropped rather than turned into spaces, so "what's" and
 * "whats" match. Digits are kept: "plan 2" and "plan 3" stay different.
 */
function normalizeQuestion(question) {
  return String(question || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’‘`´]/g, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUESTION_KEY_LEN);
}

class AnswerCache {
  constructor() {
    this.entries = new Map(); // key -> { tenantId, value, expiresAt, generation }; Map order = LRU order
    this.byTenant = new Map(); // tenantId -> Set<key>, for O(entries of that tenant) invalidation
    this.stats = { hits: 0, misses: 0, stores: 0, evictions: 0, invalidations: 0 };
  }

  // language is part of the key because the reply language is now dictated by
  // the UI selector, not the question text (engine/language.js): the same
  // question asked under the English and the Hindi toggle must not share an
  // entry, or one language's cached answer would be served to the other.
  static key(tenantId, botType, question, language) {
    const normalized = normalizeQuestion(question);
    if (!tenantId || !botType || !normalized) return null;
    const lang = language === 'hi' ? 'hi' : 'en';
    return `${tenantId}:${botType}:${lang}:${normalized}`;
  }

  /**
   * This tenant's current knowledge generation, from the shared store, so
   * every instance agrees on it.
   * @returns {Promise<number>}
   */
  generation(tenantId) {
    if (!tenantId) return Promise.resolve(0);
    return store().number(keys.knowledgeGeneration(tenantId));
  }

  /**
   * @param {number} generation the caller's current generation — read once per
   *   request (chatEngine.js does it before loading the knowledge) and passed
   *   both here and to set(), so one turn costs one generation read.
   * @returns {{ value: object|null }}
   */
  get(tenantId, botType, question, generation, language) {
    const { enabled } = config();
    const key = AnswerCache.key(tenantId, botType, question, language);
    if (!enabled || !key) return { value: null };

    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= Date.now() || entry.generation !== generation) {
      if (entry) this.delete(key);
      this.stats.misses += 1;
      return { value: null };
    }
    // Refresh recency: re-inserting moves the key to the end of the Map.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.stats.hits += 1;
    return { value: entry.value };
  }

  /**
   * Stores an answer, unless this tenant's knowledge changed while it was
   * being generated — the generation is re-read here, not trusted from the
   * caller, which is the whole point of the check.
   * @returns {Promise<boolean>}
   */
  async set(tenantId, botType, question, value, generation, language) {
    const { enabled, ttlMs, maxEntries } = config();
    const key = AnswerCache.key(tenantId, botType, question, language);
    if (!enabled || !key) return false;
    if (generation !== await this.generation(tenantId)) return false; // knowledge changed mid-call: may be stale

    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { tenantId, value, expiresAt: Date.now() + ttlMs, generation });
    if (!this.byTenant.has(tenantId)) this.byTenant.set(tenantId, new Set());
    this.byTenant.get(tenantId).add(key);
    this.stats.stores += 1;

    while (this.entries.size > maxEntries) {
      this.delete(this.entries.keys().next().value); // least recently used
      this.stats.evictions += 1;
    }
    return true;
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    const keySet = this.byTenant.get(entry.tenantId);
    if (keySet) {
      keySet.delete(key);
      if (!keySet.size) this.byTenant.delete(entry.tenantId);
    }
  }

  /**
   * Drops every cached answer for one tenant (both bots), on EVERY instance:
   * the shared generation is bumped, which invalidates entries the other
   * instances are holding the moment they next check.
   * @returns {Promise<number>} the new generation
   */
  async invalidateTenant(tenantId) {
    for (const key of this.byTenant.get(tenantId) || []) this.entries.delete(key);
    this.byTenant.delete(tenantId);
    this.stats.invalidations += 1;
    if (!tenantId) return 0;
    return store().incr(keys.knowledgeGeneration(tenantId));
  }

  /** Local entries only; the shared generations are left alone. */
  clear() {
    this.entries.clear();
    this.byTenant.clear();
    this.stats = { hits: 0, misses: 0, stores: 0, evictions: 0, invalidations: 0 };
  }

  describe() {
    return { ...config(), size: this.entries.size, tenants: this.byTenant.size, ...this.stats };
  }
}

// One shared instance per process.
const answerCache = new AnswerCache();

module.exports = { answerCache, AnswerCache, normalizeQuestion };
