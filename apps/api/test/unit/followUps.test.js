const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { pickFollowUps, GENERIC_FOLLOW_UPS } = require('../../src/services/followUps');

const SUPPORT_FAQS = [
  'How do I reset my password?',
  'How do I upload a payment screenshot?',
  'Where can I download my invoice?'
];

describe('pickFollowUps', () => {
  test("prefers the tenant's own FAQs, most related to the turn first, never the question just asked", () => {
    const picks = pickFollowUps({
      botType: 'support', faqs: SUPPORT_FAQS,
      query: 'How do I reset my password?', answer: 'Open Settings, then choose Reset password and check your invoice email.'
    });
    assert.deepEqual(picks, ['Where can I download my invoice?', 'How do I upload a payment screenshot?']);
  });

  test('skips questions asked earlier in the conversation, whatever their case or punctuation', () => {
    const picks = pickFollowUps({
      botType: 'support', faqs: SUPPORT_FAQS, asked: ['how do i upload a payment screenshot'], query: 'How do I reset my password?'
    });
    assert.ok(!picks.includes('How do I upload a payment screenshot?'));
  });

  test('tops up with the bot\'s generic follow-ups when fewer than two tenant questions are left', () => {
    const support = pickFollowUps({ botType: 'support', faqs: [], query: 'hello' });
    const sales = pickFollowUps({ botType: 'sales', faqs: ['Do you offer annual billing?'], query: 'hello' });
    assert.deepEqual(support, GENERIC_FOLLOW_UPS.support);
    assert.equal(sales[0], 'Do you offer annual billing?');
    assert.deepEqual(sales.slice(1), GENERIC_FOLLOW_UPS.sales.slice(0, 2));
  });

  test('support and sales get their own generic questions, at most three', () => {
    const support = pickFollowUps({ botType: 'support', query: 'x' });
    const sales = pickFollowUps({ botType: 'sales', query: 'x' });
    assert.ok(support.length >= 2 && support.length <= 3);
    assert.ok(sales.includes('Can I schedule a demo?'));
    assert.ok(!support.some((q) => sales.includes(q)));
  });

  test('under Hindi, tenant Hindi FAQs and Hindi generic fallbacks are used', () => {
    const DEVANAGARI = /[ऀ-ॿ]/;
    // Tenant questions passed in Hindi are returned as-is.
    const withFaqs = pickFollowUps({ botType: 'support', faqs: ['मैं कैसे शुरू करूँ?', 'रिफ़ंड नीति क्या है?'], query: 'नमस्ते', language: 'hi' });
    assert.ok(withFaqs.every((q) => DEVANAGARI.test(q)));
    // With no tenant questions, the generic fallbacks come back in Hindi.
    const generic = pickFollowUps({ botType: 'sales', faqs: [], query: 'x', language: 'hi' });
    assert.ok(generic.length >= 2 && generic.every((q) => DEVANAGARI.test(q)));
  });
});
