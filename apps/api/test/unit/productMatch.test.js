const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { matchProducts, isProductListingIntent, isProductFollowUp } = require('../../src/services/shared/productMatch');
const prisma = require('../../src/lib/prisma');
const { matchCatalogProducts } = require('../../src/services/catalogIngest');

const PRODUCTS = [
  { id: '1', name: 'Blue Hoodie', sku: 'BH-1', price: '$40', description: 'Cozy', imageUrl: 'https://img/bh.png' },
  { id: '2', name: 'Red Cap', sku: 'RC-2', price: '$15', description: '', imageUrl: null },
  { id: '3', name: 'Pen', sku: 'P-9', price: '$2', description: '', imageUrl: null }
];

describe('productMatch: matchProducts', () => {
  test('matches by product name and returns the full card fields', () => {
    const cards = matchProducts(PRODUCTS, 'Do you have the Blue Hoodie in stock?');
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0], { sku: 'BH-1', name: 'Blue Hoodie', price: '$40', description: 'Cozy', imageUrl: 'https://img/bh.png', productUrl: null });
  });

  test('matches by SKU, hyphens and case ignored', () => {
    assert.equal(matchProducts(PRODUCTS, 'what about rc-2?')[0].sku, 'RC-2');
  });

  test('matches a distinctive word of a multi-word name (brand/type query)', () => {
    // "do you have Pranaa?" style: a brand/type token, not the full name.
    assert.equal(matchProducts(PRODUCTS, 'do you have any Hoodie?')[0].sku, 'BH-1');
    assert.equal(matchProducts([{ id: '9', name: 'Pranaa Scarf', sku: 'PR-1' }], 'tell me about Pranaa')[0].sku, 'PR-1');
  });

  test('a fuzzy/typo and a plural still match above threshold', () => {
    assert.equal(matchProducts(PRODUCTS, 'how much is the hoodee?')[0].sku, 'BH-1'); // 1-char typo
    assert.equal(matchProducts([{ id: '9', name: 'Cap', sku: 'C-1' }], 'do you sell caps?')[0].sku, 'C-1'); // plural
  });

  test('matches both a SKU mention and a name mention in one query', () => {
    const skus = matchProducts(PRODUCTS, 'The Blue Hoodie is like SKU RC-2', { limit: 2 }).map((c) => c.sku);
    assert.equal(skus.length, 2);
    assert.ok(skus.includes('BH-1') && skus.includes('RC-2'));
  });

  test('below the 60% threshold is dropped: a stray adjective does not match', () => {
    // "blue" alone is only half of "Blue Hoodie" and 1/3 of the query → < 0.6.
    assert.equal(matchProducts(PRODUCTS, 'I feel a bit blue this morning').length, 0);
    // "Pen" must not fire on "open"/"happening".
    assert.equal(matchProducts(PRODUCTS, 'Please open the happening window').length, 0);
    assert.equal(matchProducts(PRODUCTS, 'I need a Pen please')[0].sku, 'P-9');
  });

  test('de-duplicates and caps at the limit', () => {
    const cards = matchProducts(PRODUCTS, 'Blue Hoodie Blue Hoodie Red Cap Pen', { limit: 2 });
    assert.equal(cards.length, 2);
    assert.equal(new Set(cards.map((c) => c.sku)).size, 2);
  });

  test('empty text or empty catalog yields no cards', () => {
    assert.deepEqual(matchProducts(PRODUCTS, '   '), []);
    assert.deepEqual(matchProducts([], 'Blue Hoodie'), []);
  });

  test('listIntent fills with the first products even when none are named', () => {
    const cards = matchProducts(PRODUCTS, 'list products', { listIntent: true, limit: 2 });
    assert.equal(cards.length, 2);
    assert.deepEqual(cards.map((c) => c.sku), ['BH-1', 'RC-2']); // catalog order
  });

  test('listIntent still puts a named match first, then fills', () => {
    const cards = matchProducts(PRODUCTS, 'show me the Red Cap and other products', { listIntent: true, limit: 2 });
    assert.equal(cards[0].sku, 'RC-2');
    assert.equal(cards.length, 2);
  });
});

describe('productMatch: isProductListingIntent', () => {
  test('catches listing / browse / "do you sell" phrasings', () => {
    ['list products', 'show me your products', 'what items do you have', 'do you sell shoes', 'browse the catalog', 'see all courses']
      .forEach((q) => assert.ok(isProductListingIntent(q), q));
  });

  test('does not fire on non-catalog questions', () => {
    ["what's your refund policy?", 'do you have a privacy policy', 'how do I reset my password', 'where are you located']
      .forEach((q) => assert.ok(!isProductListingIntent(q), q));
  });
});

describe('productMatch: isProductFollowUp', () => {
  test('catches follow-ups that refer to previously shown items without naming them', () => {
    ['link as well', 'give me their links', 'show images of those', 'can I see pictures?',
      'send me the urls', 'how about a photo', 'can I buy those', 'I want to purchase them', 'thumbnails please']
      .forEach((q) => assert.ok(isProductFollowUp(q), q));
  });

  test('does not fire on a brand-new, unrelated question (no stale carryover)', () => {
    ['more about your refund policy', 'what are your opening hours', 'how do I reset my password',
      'tell me about shipping', 'is there a discount']
      .forEach((q) => assert.ok(!isProductFollowUp(q), q));
  });
});

describe('catalogIngest: matchCatalogProducts (tenant-scoped loader)', () => {
  let realFindMany;
  beforeEach(() => {
    realFindMany = prisma.productCatalog.findMany;
    prisma.productCatalog.findMany = async ({ where }) => (where.tenantId === 't1' ? PRODUCTS : []);
  });
  afterEach(() => { prisma.productCatalog.findMany = realFindMany; });

  test('loads the tenant\'s products and matches against the text', async () => {
    const cards = await matchCatalogProducts('t1', 'price of the Blue Hoodie?');
    assert.equal(cards[0].sku, 'BH-1');
  });

  test('a tenant with no catalog gets no cards', async () => {
    assert.deepEqual(await matchCatalogProducts('other', 'Blue Hoodie'), []);
  });
});
