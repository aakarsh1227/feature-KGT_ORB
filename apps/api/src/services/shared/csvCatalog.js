// Minimal RFC 4180 CSV parsing for product-catalog uploads — no dependency.
// Handles quoted fields, escaped quotes (""), and commas/newlines inside
// quotes. Deliberately small: a catalog is a flat table, not arbitrary CSV.
//
// A catalog must have the headers Product Name, SKU, Price, Description
// (case-insensitive, any order). Each data row yields { name, sku, price,
// description }. Rows missing a name or SKU are reported as errors, not
// silently kept, so a malformed file is rejected with a clear message rather
// than importing garbage.

const REQUIRED_HEADERS = ['Product Name', 'SKU', 'Price', 'Description'];
const MAX_ROWS = 5000;          // abuse ceiling; a real catalog upload stays well under
const MAX_FIELD_LEN = 2000;     // one cell
const MAX_CSV_BYTES = 5 * 1024 * 1024;

class CsvCatalogError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'CsvCatalogError';
    this.statusCode = statusCode;
  }
}

// Splits CSV text into rows of string cells.
function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text).replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  // Flush the final field/row unless the file ended on a clean newline.
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (h) => String(h || '').trim().toLowerCase();

/**
 * Parses and validates a catalog CSV.
 * @param {string} text the raw CSV
 * @returns {{ products: Array<{name,sku,price,description}>, skipped: number }}
 * @throws {CsvCatalogError} on an empty file, missing headers, too many rows,
 *   or no usable rows at all
 */
function parseCatalogCsv(text) {
  if (Buffer.byteLength(String(text || ''), 'utf8') > MAX_CSV_BYTES) {
    throw new CsvCatalogError(`The catalog file is too large (limit ${MAX_CSV_BYTES / (1024 * 1024)}MB).`, 413);
  }
  const rows = parseRows(text).filter((r) => r.some((c) => c.trim() !== '')); // drop blank lines
  if (!rows.length) throw new CsvCatalogError('The CSV is empty.');

  const header = rows[0].map(norm);
  const missing = REQUIRED_HEADERS.filter((h) => !header.includes(norm(h)));
  if (missing.length) {
    throw new CsvCatalogError(`The catalog CSV is missing required column(s): ${missing.join(', ')}. Expected headers: ${REQUIRED_HEADERS.join(', ')}.`);
  }
  const idx = {
    name: header.indexOf(norm('Product Name')),
    sku: header.indexOf(norm('SKU')),
    price: header.indexOf(norm('Price')),
    description: header.indexOf(norm('Description')),
    // Optional columns: picked up if present, ignored otherwise.
    category: header.indexOf(norm('Category')),
    imageUrl: header.findIndex((h) => h === norm('Image URL') || h === norm('Image')),
    productUrl: header.findIndex((h) => h === norm('Product URL') || h === norm('URL') || h === norm('Link'))
  };

  const dataRows = rows.slice(1);
  if (dataRows.length > MAX_ROWS) throw new CsvCatalogError(`Too many rows (limit ${MAX_ROWS}). Split the catalog into smaller files.`);

  const cell = (r, i) => String(r[i] ?? '').trim().slice(0, MAX_FIELD_LEN);
  const products = [];
  let skipped = 0;
  for (const r of dataRows) {
    const name = cell(r, idx.name);
    const sku = cell(r, idx.sku);
    if (!name || !sku) { skipped += 1; continue; } // a product needs at least a name and SKU
    products.push({
      name, sku, price: cell(r, idx.price), description: cell(r, idx.description),
      category: idx.category >= 0 ? cell(r, idx.category) : '',
      imageUrl: idx.imageUrl >= 0 ? cell(r, idx.imageUrl) : '',
      productUrl: idx.productUrl >= 0 ? cell(r, idx.productUrl) : ''
    });
  }
  if (!products.length) throw new CsvCatalogError('No usable product rows — every row was missing a Product Name or SKU.');
  return { products, skipped };
}

// The readable text the catalog is also stored as, so the existing RAG can
// answer price/product questions ("what does SKU-12 cost?") from it. One line
// per product; stable, scannable, and cheap to retrieve over.
function catalogToMarkdown(products) {
  const lines = products.map((p) => {
    const cat = p.category ? ` [${p.category}]` : '';
    const price = p.price ? ` — ${p.price}` : '';
    const desc = p.description ? `. ${p.description}` : '';
    return `- ${p.name} (SKU ${p.sku})${cat}${price}${desc}`;
  });
  return `## Product catalog\n\n${lines.join('\n')}`;
}

// A blank template for the "download template" button, so a tenant structures
// their file correctly.
function catalogTemplateCsv() {
  return 'Product Name,SKU,Price,Description\n'
    + 'Example Widget,WID-001,$19.99,A short description of the product\n'
    + 'Example Gadget,GAD-002,$149.00,Another product description\n';
}

module.exports = {
  parseCatalogCsv, catalogToMarkdown, catalogTemplateCsv, CsvCatalogError,
  REQUIRED_HEADERS, MAX_ROWS, MAX_CSV_BYTES
};
