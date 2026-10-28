const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseCatalogCsv, catalogToMarkdown, catalogTemplateCsv, CsvCatalogError } = require('../../src/services/shared/csvCatalog');

describe('csvCatalog: parseCatalogCsv', () => {
  test('parses a well-formed catalog, headers in any case/order', () => {
    const csv = 'SKU,price,Product Name,Description\nWID-1,$9.99,Widget,A small widget\nGAD-2,$20,Gadget,A gadget';
    const { products, skipped } = parseCatalogCsv(csv);
    assert.equal(skipped, 0);
    assert.deepEqual(products[0], { name: 'Widget', sku: 'WID-1', price: '$9.99', description: 'A small widget', category: '', imageUrl: '', productUrl: '' });
    assert.equal(products[1].sku, 'GAD-2');
  });

  test('picks up the optional Category and Image URL columns when present', () => {
    const csv = 'Product Name,SKU,Price,Description,Category,Image URL\nIntro Course,C-1,$99,Beginner,Courses,https://img.example/c.png';
    const { products } = parseCatalogCsv(csv);
    assert.equal(products[0].category, 'Courses');
    assert.equal(products[0].imageUrl, 'https://img.example/c.png');
  });

  test('handles quoted fields with commas, quotes and newlines', () => {
    const csv = 'Product Name,SKU,Price,Description\n"Deluxe, Pro","D-1","$1,299","Line one\nLine two, with ""quotes"""';
    const { products } = parseCatalogCsv(csv);
    assert.equal(products[0].name, 'Deluxe, Pro');
    assert.equal(products[0].price, '$1,299');
    assert.match(products[0].description, /Line one\nLine two, with "quotes"/);
  });

  test('rejects a file missing required headers', () => {
    assert.throws(() => parseCatalogCsv('Name,Cost\nWidget,9'), (e) => e instanceof CsvCatalogError && /missing required column/i.test(e.message));
  });

  test('rejects an empty file', () => {
    assert.throws(() => parseCatalogCsv('   '), /empty/i);
  });

  test('skips rows missing a name or SKU (blank lines ignored), and rejects when none are usable', () => {
    // Row 1 is valid; the ",,," line is blank (ignored); ",NO-NAME,5,x" has no
    // Product Name, so it is skipped.
    const ok = parseCatalogCsv('Product Name,SKU,Price,Description\nWidget,W-1,1,\n,,,\n,NO-NAME,5,x');
    assert.equal(ok.products.length, 1);
    assert.equal(ok.skipped, 1);
    assert.throws(() => parseCatalogCsv('Product Name,SKU,Price,Description\n, ,,\nx, ,,'), /No usable product rows/);
  });
});

describe('csvCatalog: text output', () => {
  test('catalogToMarkdown renders one scannable line per product', () => {
    const md = catalogToMarkdown([{ name: 'Widget', sku: 'W-1', price: '$9.99', description: 'Small' }]);
    assert.match(md, /## Product catalog/);
    assert.match(md, /Widget \(SKU W-1\) — \$9\.99\. Small/);
  });

  test('the template has exactly the required headers', () => {
    assert.match(catalogTemplateCsv().split('\n')[0], /^Product Name,SKU,Price,Description$/);
  });
});
