const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../../src/lib/prisma');
const { addProduct, updateProduct, deleteProduct, listProducts, ProductError } = require('../../src/services/catalogIngest');

// A shared in-memory store standing in for Postgres, so the $transaction body
// and the top-level reads see the same data. Scoped by tenantId exactly as the
// real delegate would be.
let state;
let realTx; let realPc; let realTd;

function makeDelegates() {
  const pc = {
    findMany: async ({ where }) => state.products.filter((r) => r.tenantId === where.tenantId),
    count: async ({ where }) => state.products.filter((r) => r.tenantId === where.tenantId).length,
    findFirst: async ({ where }) => state.products.find((r) => r.id === where.id && r.tenantId === where.tenantId) || null,
    create: async ({ data }) => { const r = { id: `p${++state.seq}`, ...data }; state.products.push(r); return r; },
    update: async ({ where, data }) => { const r = state.products.find((x) => x.id === where.id); Object.assign(r, data); return r; },
    delete: async ({ where }) => { state.products = state.products.filter((x) => x.id !== where.id); return {}; }
  };
  const td = {
    findFirst: async ({ where }) => { const d = [...state.docs.values()].find((x) => x.tenantId === where.tenantId && x.title === where.title); return d ? { id: d.id } : null; },
    create: async ({ data }) => { const id = `d${++state.seq}`; state.docs.set(id, { id, ...data }); return { id }; },
    update: async ({ where, data }) => { const d = state.docs.get(where.id); Object.assign(d, data); return d; }
  };
  return { productCatalog: pc, tenantDocument: td };
}

beforeEach(() => {
  state = { products: [], docs: new Map(), seq: 0 };
  const d = makeDelegates();
  realTx = prisma.$transaction; realPc = prisma.productCatalog; realTd = prisma.tenantDocument;
  prisma.$transaction = async (fn) => fn(d);
  prisma.productCatalog = d.productCatalog;
  prisma.tenantDocument = d.tenantDocument;
});
afterEach(() => { prisma.$transaction = realTx; prisma.productCatalog = realPc; prisma.tenantDocument = realTd; });

const docContent = () => [...state.docs.values()][0]?.content || '';

describe('catalog CRUD: add', () => {
  test('adds a product, creates the catalog doc, and reflects it in the RAG text', async () => {
    const r = await addProduct('t1', { name: 'Blue Hoodie', sku: 'BH-1', price: '$40', description: 'Cozy', category: 'Apparel', imageUrl: 'https://img.example/bh.png' });
    assert.equal(r.tenantId, 't1');
    assert.equal(r.sku, 'BH-1');
    const list = await listProducts('t1');
    assert.equal(list.length, 1);
    assert.match(docContent(), /Blue Hoodie \(SKU BH-1\) \[Apparel\] — \$40/);
  });

  test('rejects a product with no name, and a non-URL image', async () => {
    await assert.rejects(() => addProduct('t1', { sku: 'X-1' }), (e) => e instanceof ProductError && /name is required/.test(e.message));
    await assert.rejects(() => addProduct('t1', { name: 'X', sku: 'X-1', imageUrl: 'not-a-url' }), /imageUrl must be an http/);
  });
});

describe('catalog CRUD: update', () => {
  test('updates only the given fields and rebuilds the doc', async () => {
    const r = await addProduct('t1', { name: 'Mug', sku: 'M-1', price: '$5' });
    await updateProduct('t1', r.id, { price: '$6', description: 'Ceramic' });
    const [row] = await listProducts('t1');
    assert.equal(row.price, '$6');
    assert.equal(row.description, 'Ceramic');
    assert.equal(row.name, 'Mug'); // untouched
    assert.match(docContent(), /\$6/);
  });

  test("cannot touch another tenant's product (404)", async () => {
    const r = await addProduct('t1', { name: 'Mug', sku: 'M-1' });
    await assert.rejects(() => updateProduct('t2', r.id, { price: '$9' }), (e) => e instanceof ProductError && e.statusCode === 404);
  });
});

describe('catalog CRUD: delete', () => {
  test('removes the product and updates the doc', async () => {
    const a = await addProduct('t1', { name: 'A', sku: 'A-1' });
    await addProduct('t1', { name: 'B', sku: 'B-1' });
    await deleteProduct('t1', a.id);
    const list = await listProducts('t1');
    assert.deepEqual(list.map((p) => p.sku), ['B-1']);
    assert.doesNotMatch(docContent(), /SKU A-1/);
  });

  test("cannot delete another tenant's product (404)", async () => {
    const a = await addProduct('t1', { name: 'A', sku: 'A-1' });
    await assert.rejects(() => deleteProduct('t2', a.id), (e) => e instanceof ProductError && e.statusCode === 404);
  });
});
