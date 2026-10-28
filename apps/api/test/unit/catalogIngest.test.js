const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../../src/lib/prisma');
const { CATEGORIES } = require('../../src/services/shared/documentCategory');
const { ingestCatalogCsv, replaceCatalog, getCatalogSummary } = require('../../src/services/catalogIngest');

// In-memory fakes for the Prisma calls replaceCatalog makes, so no DB is
// needed. We capture what gets written to assert tenant-scoping and shape.
let created; // { doc, rows, deletedDocIds }
let realTx;
let realCount;

beforeEach(() => {
  created = { doc: null, rows: null, deletedDocIds: null };
  realTx = prisma.$transaction;
  realCount = prisma.productCatalog;
  const tx = {
    productCatalog: {
      findMany: async () => [], // no prior catalog
      deleteMany: async () => ({ count: 0 }),
      createMany: async ({ data }) => { created.rows = data; return { count: data.length }; }
    },
    tenantDocument: {
      deleteMany: async ({ where }) => { created.deletedDocIds = where.id?.in || []; return { count: 0 }; },
      create: async ({ data }) => { created.doc = data; return { id: 'doc-1' }; }
    }
  };
  prisma.$transaction = async (fn) => fn(tx);
  prisma.productCatalog = { count: async () => (created.rows ? created.rows.length : 0) };
});
afterEach(() => { prisma.$transaction = realTx; prisma.productCatalog = realCount; });

describe('catalogIngest: replaceCatalog', () => {
  const products = [
    { name: 'Widget', sku: 'W-1', price: '$9.99', description: 'Small' },
    { name: 'Gadget', sku: 'G-2', price: '$20', description: '' }
  ];

  test('stores structured rows scoped to the tenant and tied to the new document', async () => {
    const r = await replaceCatalog('tenant-A', products);
    assert.deepEqual(r, { productCount: 2, documentId: 'doc-1' });
    assert.equal(created.rows.length, 2);
    // Every row carries the CALLER's tenantId, never anything from the product data.
    assert.ok(created.rows.every((row) => row.tenantId === 'tenant-A'));
    assert.ok(created.rows.every((row) => row.documentId === 'doc-1'));
    assert.deepEqual([created.rows[0].sku, created.rows[1].sku], ['W-1', 'G-2']);
  });

  test('also creates a readable Policy/pricing document the RAG can answer from', async () => {
    await replaceCatalog('tenant-A', products);
    assert.equal(created.doc.tenantId, 'tenant-A');
    assert.equal(created.doc.category, CATEGORIES.CUSTOM_POLICY);
    assert.match(created.doc.content, /## Product catalog/);
    assert.match(created.doc.content, /Widget \(SKU W-1\)/);
  });
});

describe('catalogIngest: ingestCatalogCsv', () => {
  test('parses a CSV then stores it; summary reflects the rows', async () => {
    const csv = 'Product Name,SKU,Price,Description\nWidget,W-1,$9.99,Small\nGadget,G-2,$20,';
    const r = await ingestCatalogCsv('tenant-A', csv);
    assert.equal(r.productCount, 2);
    assert.equal(r.skipped, 0);
    assert.deepEqual(await getCatalogSummary('tenant-A'), { hasCatalog: true, productCount: 2 });
  });

  test('a malformed CSV throws before anything is written', async () => {
    await assert.rejects(() => ingestCatalogCsv('tenant-A', 'Name,Cost\nx,1'), /missing required column/i);
    assert.equal(created.doc, null);
  });
});
