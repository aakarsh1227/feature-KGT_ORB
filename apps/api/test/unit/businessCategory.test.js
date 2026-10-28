const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseBusinessCategory, isValidBusinessCategory, toneHintFor, CATEGORY_KEYS } = require('../../src/services/shared/businessCategory');

describe('businessCategory', () => {
  test('accepts known categories case-insensitively', () => {
    assert.deepEqual(parseBusinessCategory('ecommerce'), { ok: true, value: 'ecommerce' });
    assert.deepEqual(parseBusinessCategory(' SaaS '), { ok: true, value: 'saas' });
    assert.ok(isValidBusinessCategory('real_estate'));
  });

  test('treats unset/empty as "no choice" (null), not an error', () => {
    assert.deepEqual(parseBusinessCategory(undefined), { ok: true, value: null });
    assert.deepEqual(parseBusinessCategory(''), { ok: true, value: null });
    assert.deepEqual(parseBusinessCategory(null), { ok: true, value: null });
  });

  test('rejects an unknown category', () => {
    const r = parseBusinessCategory('crypto-casino');
    assert.equal(r.ok, false);
    assert.match(r.error, /must be one of/);
    CATEGORY_KEYS.forEach((k) => assert.match(r.error, new RegExp(k)));
  });

  test('tone hint is present for a real category and empty for other/unknown/unset', () => {
    assert.match(toneHintFor('ecommerce'), /retail|e-commerce/i);
    assert.equal(toneHintFor('other'), '');
    assert.equal(toneHintFor(null), '');
    assert.equal(toneHintFor('nonsense'), '');
  });
});
