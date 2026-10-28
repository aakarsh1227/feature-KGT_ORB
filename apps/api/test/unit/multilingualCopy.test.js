const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createTenantSupportProfile, createTenantSalesProfile } = require('../../src/domains/tenantProfile');
const { AnswerCache } = require('../../src/engine/answerCache');

// Every non-LLM response path must honour the UI-selected language, not just
// the LLM answer. These check the static/fallback copy the engine returns
// directly (small talk, handoff, no-answer, out-of-scope, degraded) and that
// the answer cache keeps the two languages apart.

const DEVANAGARI = /[ऀ-ॿ]/;
const tenant = {
  slug: 'acme', name: 'Acme', industryLabel: 'software', minConfidence: 0.3,
  outOfScopeMessage: 'I can only help with Acme.', botPreference: 'both', persona: ''
};
const support = createTenantSupportProfile(tenant);
const sales = createTenantSalesProfile(tenant);

describe('multilingual copy: small talk follows the selected language', () => {
  test('Hindi selector yields Devanagari greetings, English stays English', () => {
    for (const profile of [support, sales]) {
      assert.match(profile.smallTalkCopy('hi').greeting, DEVANAGARI);
      assert.match(profile.smallTalkCopy('hi').thanks, DEVANAGARI);
      assert.doesNotMatch(profile.smallTalkCopy('en').greeting, DEVANAGARI);
    }
  });

  test('an absent/unknown language defaults to English (unchanged behaviour)', () => {
    assert.doesNotMatch(support.smallTalkCopy(undefined).greeting, DEVANAGARI);
    assert.doesNotMatch(support.smallTalkCopy('fr').greeting, DEVANAGARI);
    assert.match(support.smallTalkCopy().greeting, /^Hello there! Welcome to Acme support/);
  });
});

describe('multilingual copy: handoff / lead-capture prompts follow the language', () => {
  test('ask-email and demo prompts are Hindi under the Hindi selector', () => {
    for (const profile of [support, sales]) {
      assert.match(profile.handoffCopy('hi').askEmail, DEVANAGARI);
      assert.match(profile.handoffCopy('hi').demo, DEVANAGARI);
      assert.match(profile.handoffCopy('hi').thanks('a@b.com'), DEVANAGARI);
      // The email itself is preserved verbatim inside the Hindi sentence.
      assert.match(profile.handoffCopy('hi').thanks('a@b.com'), /a@b\.com/);
      assert.doesNotMatch(profile.handoffCopy('en').askEmail, DEVANAGARI);
    }
  });
});

describe('multilingual copy: fallback / no-answer / degraded follow the language', () => {
  test('support fallbacks are Hindi for hi, English for en', () => {
    assert.match(support.formatFallback({ language: 'hi' }, 0.1).answer, DEVANAGARI);
    assert.match(support.formatNoAnswer({ language: 'hi' }, 0.4).answer, DEVANAGARI);
    assert.match(support.formatDegraded(null, { language: 'hi' }).answer, DEVANAGARI);
    assert.doesNotMatch(support.formatDegraded(null, { language: 'en' }).answer, DEVANAGARI);
    // English out-of-scope still uses the tenant's own configured message.
    assert.equal(support.formatFallback({ language: 'en' }, 0.1).answer, tenant.outOfScopeMessage);
  });

  test('sales fallbacks are Hindi for hi, English for en', () => {
    assert.match(sales.formatFallback({ language: 'hi' }, 0.1).answer, DEVANAGARI);
    assert.match(sales.formatNoAnswer({ language: 'hi' }, 0.4).answer, DEVANAGARI);
    assert.match(sales.formatDegraded(null, { language: 'hi' }).answer, DEVANAGARI);
    assert.doesNotMatch(sales.formatDegraded(null, { language: 'en' }).answer, DEVANAGARI);
  });
});

describe('multilingual copy: the answer cache separates languages', () => {
  test('the same question cached under hi is not served to en and vice versa', async () => {
    const c = new AnswerCache();
    await c.set('t', 'support', 'what is the price', { text: 'EN answer' }, 0, 'en');
    await c.set('t', 'support', 'what is the price', { text: 'HI answer' }, 0, 'hi');
    assert.equal(c.get('t', 'support', 'what is the price', 0, 'en').value.text, 'EN answer');
    assert.equal(c.get('t', 'support', 'what is the price', 0, 'hi').value.text, 'HI answer');
    // A request with no language is treated as English.
    assert.equal(c.get('t', 'support', 'what is the price', 0).value.text, 'EN answer');
  });
});
