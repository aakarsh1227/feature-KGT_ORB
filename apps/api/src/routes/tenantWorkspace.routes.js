const express = require('express');
const multer = require('multer');
const { Prisma } = require('@prisma/client');
const prisma = require('../lib/prisma');
const { issueApiKey } = require('../utils/tenantApiKeys');
const { invalidateTenantKnowledge } = require('../domains/tenantProfile');
const { crawlSite, CrawlerError } = require('../services/shared/crawler');
const { pdfToDocuments, PdfIngestError } = require('../services/shared/pdfIngest');
const { parseCategory, suggestCategory } = require('../services/shared/documentCategory');
const { crawlConsentRecord, hostOf } = require('../services/shared/crawlConsent');
const { createIpRateLimiter } = require('../utils/ipRateLimit');
const { handleChat } = require('../services/tenantChat');
const { getMaskedConfig, upsertConfig, testConfig, SmtpConfigError } = require('../services/tenantSmtp');
const { ingestCatalogCsv, getCatalogSummary, listProducts, addProduct, updateProduct, deleteProduct, ProductError } = require('../services/catalogIngest');
const { CsvCatalogError, catalogTemplateCsv, MAX_CSV_BYTES } = require('../services/shared/csvCatalog');
const { scheduleFaqGeneration, isFaqGenerationRunning } = require('../services/tenantFaqs');
const { usageBreakdowns } = require('../services/usageStats');
const { wrapRouterAsync } = require('../utils/wrapAsync');
const { parseBotScope, parseBotPreference, scopeCounts } = require('../services/shared/botScope');
const { answerCache } = require('../engine/answerCache');
const { ingestUpload, FileIngestError, MAX_UPLOAD_BYTES } = require('../services/shared/fileIngest');
const { documentChunks } = require('../domains/tenantProfile');
const { auditTenant, tenantReadiness } = require('../services/botAuditor');
const { runSessionSummary, claimSession } = require('../services/chatSessions');
const { teamRecipients, parseTeamEmail, lowConfidenceBelow } = require('../services/teamAlerts');

// Everything one tenant can do with its own bots: documents, PDF upload,
// website import, API keys, test chat, tickets, leads and usage.
//
// ISOLATION CONTRACT. Mounted twice, behind two different gatekeepers:
//   /api/v1/client/workspace          requireClient  (tenant from the client's TenantUser row)
//   /api/v1/tenants/:tenantId         requireOperator + loadTenantFromParam (KGT staff)
// Both set req.tenant and req.actor ('client' | 'operator') before any
// route here runs. Routes read the tenant ONLY from req.tenant; ids taken
// from the URL (document, key) are always looked up together with
// req.tenant.id, so another tenant's row reads exactly like a missing one.
const router = express.Router({ mergeParams: true });

const DOC_FIELDS = {
  id: true, title: true, content: true, category: true, botScope: true, sourceUrl: true, createdAt: true, updatedAt: true
};
const API_KEY_PUBLIC_FIELDS = { id: true, keyPrefix: true, label: true, createdAt: true, lastUsedAt: true, revokedAt: true };
const MAX_TITLE_LEN = 200;
const MAX_CONTENT_LEN = 20000;
const MAX_DOCUMENTS_PER_TENANT = 500;

// Website imports from client dashboards: a few per hour per tenant.
const isClientCrawlLimited = createIpRateLimiter({ name: 'workspace-crawl', max: 5, windowMs: 60 * 60 * 1000 });
// Manual starter-FAQ refreshes: each one is an LLM call, so a few per hour per tenant.
const isFaqRegenLimited = createIpRateLimiter({ name: 'workspace-faq-regen', max: 5, windowMs: 60 * 60 * 1000 });
// Readiness audits: each is an LLM call billed to the tenant.
const isAuditLimited = createIpRateLimiter({ name: 'workspace-audit', max: 6, windowMs: 60 * 60 * 1000 });

// ── PDF upload (same parser and 10MB limit as the signup wizard)
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 2 },
  fileFilter: (_req, file, cb) => {
    // Some browsers send application/octet-stream for a .pdf; the %PDF-
    // magic-byte check in pdfToDocuments is the real gate.
    const looksPdf = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname || '');
    cb(looksPdf ? null : new PdfIngestError('Only PDF files are accepted', 400), looksPdf);
  }
});

function pdfUploadMiddleware(req, res, next) {
  pdfUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof PdfIngestError) return res.status(err.statusCode).json({ error: err.message });
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `That PDF is larger than ${MAX_PDF_BYTES / (1024 * 1024)}MB` });
      }
      return res.status(400).json({ error: 'Upload exactly one PDF in a field named "file"' });
    }
    next(err);
  });
}

async function roomForDocuments(tenantId, adding) {
  const count = await prisma.tenantDocument.count({ where: { tenantId } });
  return count + adding <= MAX_DOCUMENTS_PER_TENANT;
}
const TOO_MANY_DOCS = { error: `A tenant can hold up to ${MAX_DOCUMENTS_PER_TENANT} documents — delete some to add more.` };

// ── Documents

// Optional ?category=FAQ filter; without it, every document is returned.
router.get('/documents', async (req, res) => {
  const where = { tenantId: req.tenant.id };
  if (req.query.category !== undefined) {
    const category = parseCategory(req.query.category, null);
    if (!category.ok || !category.value) return res.status(400).json({ error: category.error || 'category is empty' });
    where.category = category.value;
  }
  res.json(await prisma.tenantDocument.findMany({ where, orderBy: { createdAt: 'desc' }, select: DOC_FIELDS }));
});

router.post('/documents', async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, MAX_TITLE_LEN);
  const content = String(req.body?.content || '').trim().slice(0, MAX_CONTENT_LEN);
  if (!title || !content) return res.status(400).json({ error: 'title and content are required' });
  const category = parseCategory(req.body?.category);
  if (!category.ok) return res.status(400).json({ error: category.error });
  const botScope = parseBotScope(req.body?.botScope);
  if (!botScope.ok) return res.status(400).json({ error: botScope.error });
  if (!(await roomForDocuments(req.tenant.id, 1))) return res.status(409).json(TOO_MANY_DOCS);

  const doc = await prisma.tenantDocument.create({
    data: { tenantId: req.tenant.id, title, content, category: category.value, botScope: botScope.value },
    select: DOC_FIELDS
  });
  await invalidateTenantKnowledge(req.tenant.id); // next chat request re-reads from the DB
  res.status(201).json(doc);
});

// ── Any supported file (PDF, .docx, .txt, .md, or a .zip of them), parsed
// by services/shared/fileIngest.js. multipart: file, optional category and
// botScope applied to every document created. Returns files[] so the client
// can show which files in a zip were skipped and why.
const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 3 } });

// Product catalog CSV upload. Small, single file, memory only. The extension
// is checked here; the content is validated by the parser (services/shared/csvCatalog.js).
const catalogUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CSV_BYTES, files: 1, fields: 2 } });

router.post('/documents/file', (req, res, next) => fileUpload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      error: err.code === 'LIMIT_FILE_SIZE' ? `Uploads are limited to ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB` : 'Upload exactly one file in a field named "file"'
    });
  }
  next(err);
}), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a file in a field named "file"' });
  const chosen = req.body?.category ? parseCategory(req.body.category) : null;
  if (chosen && !chosen.ok) return res.status(400).json({ error: chosen.error });
  const botScope = parseBotScope(req.body?.botScope);
  if (!botScope.ok) return res.status(400).json({ error: botScope.error });

  let parsed;
  try {
    parsed = await ingestUpload(req.file.buffer, req.file.originalname);
  } catch (e) {
    if (e instanceof FileIngestError || e instanceof PdfIngestError) return res.status(e.statusCode).json({ error: e.message });
    throw e;
  }
  if (!(await roomForDocuments(req.tenant.id, parsed.pages.length))) return res.status(409).json(TOO_MANY_DOCS);

  const docs = parsed.pages.map((p) => ({
    tenantId: req.tenant.id,
    title: p.title.slice(0, MAX_TITLE_LEN),
    content: p.markdown,
    category: chosen ? chosen.value : suggestCategory({ title: p.title, markdown: p.markdown, source: 'pdf' }),
    botScope: botScope.value
  }));
  await prisma.tenantDocument.createMany({ data: docs });
  await invalidateTenantKnowledge(req.tenant.id);
  scheduleFaqGeneration(req.tenant.id);
  res.status(201).json({ fileName: req.file.originalname, documentsCreated: docs.length, files: parsed.files });
});

// multipart: file (the PDF), optional category. With a category, every
// section is filed there; without one, each section gets the suggestion
// the signup wizard would make.
router.post('/documents/pdf', pdfUploadMiddleware, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a PDF in a field named "file"' });
  const chosen = req.body?.category ? parseCategory(req.body.category) : null;
  if (chosen && !chosen.ok) return res.status(400).json({ error: chosen.error });

  let parsed;
  try {
    parsed = await pdfToDocuments(req.file.buffer, req.file.originalname);
  } catch (e) {
    if (e instanceof PdfIngestError) return res.status(e.statusCode).json({ error: e.message });
    throw e;
  }
  if (!(await roomForDocuments(req.tenant.id, parsed.pages.length))) return res.status(409).json(TOO_MANY_DOCS);

  const docs = parsed.pages.map((p) => ({
    tenantId: req.tenant.id,
    title: p.title.slice(0, MAX_TITLE_LEN),
    content: p.markdown,
    category: chosen ? chosen.value : suggestCategory({ title: p.title, markdown: p.markdown, source: 'pdf' })
  }));
  await prisma.tenantDocument.createMany({ data: docs });
  await invalidateTenantKnowledge(req.tenant.id);
  scheduleFaqGeneration(req.tenant.id); // new content -> fresh sandbox starter questions

  res.status(201).json({
    fileName: req.file.originalname,
    title: parsed.title,
    documentsCreated: docs.length,
    truncated: parsed.truncated,
    categories: docs.reduce((m, d) => ({ ...m, [d.category]: (m[d.category] || 0) + 1 }), {})
  });
});

router.patch('/documents/:documentId', async (req, res) => {
  const existing = await prisma.tenantDocument.findFirst({
    where: { id: req.params.documentId, tenantId: req.tenant.id }
  });
  if (!existing) return res.status(404).json({ error: 'Document not found' });

  const data = {};
  if (req.body?.title !== undefined) {
    const title = String(req.body.title).trim().slice(0, MAX_TITLE_LEN);
    if (!title) return res.status(400).json({ error: 'title cannot be empty' });
    data.title = title;
  }
  if (req.body?.content !== undefined) {
    const content = String(req.body.content).trim().slice(0, MAX_CONTENT_LEN);
    if (!content) return res.status(400).json({ error: 'content cannot be empty' });
    data.content = content;
  }
  if (req.body?.category !== undefined) {
    const category = parseCategory(req.body.category, null);
    if (!category.ok || !category.value) return res.status(400).json({ error: category.error || 'category cannot be empty' });
    data.category = category.value;
  }
  // Which bot may use it: AUTO | BOTH | SUPPORT | SALES (services/shared/botScope.js).
  if (req.body?.botScope !== undefined) {
    const botScope = parseBotScope(req.body.botScope, null);
    if (!botScope.ok || !botScope.value) return res.status(400).json({ error: botScope.error || 'botScope cannot be empty' });
    data.botScope = botScope.value;
  }
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update' });

  const updated = await prisma.tenantDocument.update({ where: { id: existing.id }, data, select: DOC_FIELDS });
  await invalidateTenantKnowledge(req.tenant.id); // an edited chunk must be re-read on the very next chat request
  res.json(updated);
});

router.delete('/documents/:documentId', async (req, res) => {
  const { count } = await prisma.tenantDocument.deleteMany({
    where: { id: req.params.documentId, tenantId: req.tenant.id }
  });
  if (!count) return res.status(404).json({ error: 'Document not found' });
  await invalidateTenantKnowledge(req.tenant.id); // a deleted chunk must stop being retrievable immediately
  res.status(204).end();
});

// ── Website import
// Operators get the headless-browser tier (Chromium runs --no-sandbox, so
// it stays behind staff auth); clients get the static crawler only, must
// confirm they're authorized to crawl the domain (recorded as a
// TenantConsent row), and are rate-limited per tenant.
router.post('/scrape', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url || !hostOf(url)) return res.status(400).json({ error: 'A valid website URL is required' });
  const isClient = req.actor === 'client';
  if (isClient) {
    if (req.body?.authorized !== true) {
      return res.status(400).json({ error: 'You must confirm you are authorized to let us crawl this domain' });
    }
    if (await isClientCrawlLimited(req.tenant.id)) {
      return res.status(429).json({ error: 'Too many website imports. Please try again in an hour.' });
    }
  }

  let result;
  try {
    result = await crawlSite(url, { browserFallback: !isClient });
  } catch (e) {
    if (e instanceof CrawlerError) return res.status(e.statusCode).json({ error: e.message });
    throw e; // an unexpected failure — let the global error handler log and 500 it
  }
  if (!(await roomForDocuments(req.tenant.id, result.pages.length))) return res.status(409).json(TOO_MANY_DOCS);

  const created = await prisma.$transaction(async (tx) => {
    if (isClient) {
      await tx.tenantConsent.create({
        data: { tenantId: req.tenant.id, ...crawlConsentRecord({ url, email: req.tenantUser.email, req }) }
      });
    }
    return Promise.all(result.pages.map((page) => tx.tenantDocument.create({
      data: {
        tenantId: req.tenant.id,
        title: page.title.slice(0, MAX_TITLE_LEN),
        content: page.markdown,
        sourceUrl: page.url,
        // No review step here; the Documents list can re-file it afterwards.
        category: suggestCategory({ title: page.title, url: page.url, markdown: page.markdown, source: 'crawl' })
      },
      select: { id: true, title: true, sourceUrl: true, category: true }
    })));
  });
  await invalidateTenantKnowledge(req.tenant.id);
  scheduleFaqGeneration(req.tenant.id);

  res.status(201).json({
    message:
      `Imported ${created.length} page${created.length === 1 ? '' : 's'} from ${result.baseHost} — both bots can use them now` +
      (result.rendered ? ` (${result.rendered} rendered in a headless browser)` : '') +
      (result.skipped ? `. Skipped ${result.skipped} low-content page${result.skipped === 1 ? '' : 's'}.` : '.'),
    crawled: result.crawled,
    skipped: result.skipped,
    rendered: result.rendered,
    documents: created
  });
});

// ── Starter FAQs: questions generated from this tenant's own documents
// (services/tenantFaqs.js), shown as one-click chips in the Test Bots sandbox.
// status: none (no documents yet) | pending | ready | failed. After a failed
// refresh the previous questions, if any, are still returned.
router.get('/faqs', async (req, res) => {
  const row = await prisma.tenantFaq.findUnique({ where: { tenantId: req.tenant.id } });
  let status = row?.status || 'none';

  // No row yet (a tenant from before this feature, or one whose only content
  // was typed in by hand), or a run lost to a restart: start one now.
  const stale = status === 'pending' && !isFaqGenerationRunning(req.tenant.id);
  if ((status === 'none' || stale) && await prisma.tenantDocument.count({ where: { tenantId: req.tenant.id } })) {
    scheduleFaqGeneration(req.tenant.id);
    status = 'pending';
  }

  res.json({
    status,
    supportFaqs: row?.supportFaqs || [],
    salesFaqs: row?.salesFaqs || [],
    // Hindi variants (index-aligned); the dashboard shows these when its
    // language toggle is on Hindi (components/workspace/BotSandbox.js).
    supportFaqsHi: row?.supportFaqsHi || [],
    salesFaqsHi: row?.salesFaqsHi || [],
    generatedAt: row?.generatedAt || null,
    // The failure reason names providers and config: staff only.
    ...(req.actor === 'operator' && row?.error ? { error: row.error } : {})
  });
});

// ── Product catalog: a CSV of products stored as structured, tenant-scoped
// rows plus a readable document the bots answer price/product questions from
// (services/catalogIngest.js). Strictly scoped to req.tenant.id.
router.get('/catalog', async (req, res) => {
  res.json(await getCatalogSummary(req.tenant.id));
});

// Per-item CRUD for the editable catalog table. All tenant-scoped; the
// catalog document the RAG reads is rebuilt after every change.
router.get('/catalog/products', async (req, res) => {
  res.json({ products: await listProducts(req.tenant.id) });
});

router.post('/catalog/products', async (req, res, next) => {
  try { res.status(201).json(await addProduct(req.tenant.id, req.body)); }
  catch (e) { if (e instanceof ProductError) return res.status(e.statusCode).json({ error: e.message }); next(e); }
});

router.patch('/catalog/products/:id', async (req, res, next) => {
  try { res.json(await updateProduct(req.tenant.id, req.params.id, req.body)); }
  catch (e) { if (e instanceof ProductError) return res.status(e.statusCode).json({ error: e.message }); next(e); }
});

router.delete('/catalog/products/:id', async (req, res, next) => {
  try { res.json(await deleteProduct(req.tenant.id, req.params.id)); }
  catch (e) { if (e instanceof ProductError) return res.status(e.statusCode).json({ error: e.message }); next(e); }
});

// A blank CSV template so tenants structure their catalog correctly.
router.get('/catalog/template', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="product-catalog-template.csv"');
  res.send(catalogTemplateCsv());
});

router.post('/catalog', (req, res, next) => catalogUpload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      error: err.code === 'LIMIT_FILE_SIZE' ? `Catalog files are limited to ${MAX_CSV_BYTES / (1024 * 1024)}MB` : 'Upload exactly one file in a field named "file"'
    });
  }
  next(err);
}), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a .csv file in a field named "file"' });
  if (!/\.csv$/i.test(req.file.originalname || '')) {
    return res.status(415).json({ error: 'Product catalogs must be a .csv file.' });
  }
  try {
    const result = await ingestCatalogCsv(req.tenant.id, req.file.buffer.toString('utf8'));
    res.status(201).json({ fileName: req.file.originalname, ...result });
  } catch (e) {
    if (e instanceof CsvCatalogError) return res.status(e.statusCode).json({ error: e.message });
    next(e);
  }
});

// ── Custom SMTP: a tenant's own mail server for ticket alerts, lead emails
// and notifications (services/tenantSmtp.js, services/mailer.js). The
// password is encrypted at rest and never returned — GET masks it.
router.get('/smtp-config', async (req, res) => {
  res.json(await getMaskedConfig(req.tenant.id));
});

router.put('/smtp-config', async (req, res, next) => {
  try {
    res.json(await upsertConfig(req.tenant.id, req.body));
  } catch (err) {
    if (err instanceof SmtpConfigError) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// Verifies credentials against the mail server without saving. Returns
// { ok, reason?, error?, hint? }; a bad login is a 200 with ok:false (it's a
// validation result, not a server error).
router.post('/smtp-config/test', async (req, res, next) => {
  try {
    res.json(await testConfig(req.tenant.id, req.body));
  } catch (err) {
    next(err);
  }
});

router.post('/faqs/regenerate', async (req, res) => {
  if (isFaqGenerationRunning(req.tenant.id)) return res.status(202).json({ status: 'pending' });
  if (!(await prisma.tenantDocument.count({ where: { tenantId: req.tenant.id } }))) {
    return res.status(409).json({ error: 'Add a document or import a website first — questions are written from your content.' });
  }
  if (await isFaqRegenLimited(req.tenant.id)) {
    return res.status(429).json({ error: 'Suggested questions were refreshed several times recently. Please try again in an hour.' });
  }
  scheduleFaqGeneration(req.tenant.id);
  res.status(202).json({ status: 'pending' });
});

// ── Readiness audit and the Sales / Support knowledge split.

// Runs the pre-flight audit on this tenant's documents now and saves it
// (services/botAuditor.js). Synchronous — the caller is waiting on the report.
router.post('/preflight-audit', async (req, res) => {
  if (!(await prisma.tenantDocument.count({ where: { tenantId: req.tenant.id } }))) {
    return res.status(409).json({ error: 'Add a document or import a website first — the audit reads your content.' });
  }
  if (await isAuditLimited(req.tenant.id)) {
    return res.status(429).json({ error: 'The readiness audit ran several times recently. Please try again in an hour.' });
  }
  res.json(await auditTenant(req.tenant.id));
});

// The latest saved report; stale = documents changed since it was written.
router.get('/readiness', async (req, res) => {
  res.json(await tenantReadiness(req.tenant.id));
});

// How the knowledge splits between the bots, overall and per document:
// sections each bot can use (support / sales / both), from the same
// classifier retrieval uses (domains/tenantProfile.js documentChunks).
router.get('/knowledge/distribution', async (req, res) => {
  const docs = await prisma.tenantDocument.findMany({
    where: { tenantId: req.tenant.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, content: true, category: true, botScope: true }
  });
  const botPreference = req.tenant.botPreference || 'both';
  const perDoc = docs.map((doc) => {
    const chunks = documentChunks(doc);
    return {
      id: doc.id, title: doc.title, category: doc.category, botScope: doc.botScope,
      sections: chunks.map((c) => ({ title: c.title, scope: c.scope })),
      counts: scopeCounts(chunks, botPreference)
    };
  });
  res.json({ botPreference, totals: scopeCounts(perDoc.flatMap((d) => d.sections), botPreference), documents: perDoc });
});

// Which bots this company deploys: { botPreference: 'support' | 'sales' | 'both' }.
// Changes what each bot may answer from (one bot alone uses all the
// knowledge) and what the readiness audit judges, so cached answers are
// dropped and the saved report shows as stale until re-run.
router.patch('/bot-preference', async (req, res) => {
  const botPreference = parseBotPreference(req.body?.botPreference, null);
  if (!botPreference.ok || !botPreference.value) return res.status(400).json({ error: botPreference.error || 'botPreference is required' });
  const updated = await prisma.tenant.update({
    where: { id: req.tenant.id }, data: { botPreference: botPreference.value }, select: { botPreference: true }
  });
  await answerCache.invalidateTenant(req.tenant.id);
  res.json(updated);
});

// ── API keys. Plaintext is returned only by the POST that issues a key;
// the list shows prefixes and dates. Rotation is issue-then-revoke, so a
// live widget never has a moment without a valid key.

router.get('/api-keys', async (req, res) => {
  res.json(await prisma.tenantApiKey.findMany({
    where: { tenantId: req.tenant.id },
    orderBy: { createdAt: 'desc' },
    select: API_KEY_PUBLIC_FIELDS
  }));
});

router.post('/api-keys', async (req, res) => {
  const live = await prisma.tenantApiKey.count({ where: { tenantId: req.tenant.id, revokedAt: null } });
  if (live >= 10) return res.status(409).json({ error: 'A tenant can have up to 10 active keys — revoke one first.' });
  const label = String(req.body?.label || '').trim().slice(0, 80) || 'Default';
  const { key, row } = await issueApiKey(prisma, req.tenant.id, label);
  res.status(201).json({ id: row.id, keyPrefix: row.keyPrefix, label: row.label, createdAt: row.createdAt, apiKey: key });
});

router.delete('/api-keys/:keyId', async (req, res) => {
  const key = await prisma.tenantApiKey.findFirst({ where: { id: req.params.keyId, tenantId: req.tenant.id } });
  if (!key) return res.status(404).json({ error: 'API key not found' });
  if (key.revokedAt) return res.json({ id: key.id, revokedAt: key.revokedAt });

  const liveCount = await prisma.tenantApiKey.count({ where: { tenantId: req.tenant.id, revokedAt: null } });
  if (liveCount <= 1 && req.query.force !== 'true') {
    return res.status(409).json({
      error: 'This is the last active key — revoking it takes every embedded widget offline. Issue a new key first, or pass ?force=true.'
    });
  }
  res.json(await prisma.tenantApiKey.update({
    where: { id: key.id },
    data: { revokedAt: new Date() },
    select: API_KEY_PUBLIC_FIELDS
  }));
});

// ── Test chat: the tenant's own bots, authenticated by the session instead
// of an API key (keys are stored hashed and can't be read back).
router.post('/chat', handleChat);

// ── Tickets and usage

router.get('/tickets', async (req, res) => {
  res.json(await prisma.supportTicket.findMany({
    where: { tenantId: req.tenant.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, query: true, confidence: true, kind: true, botType: true, contactEmail: true, status: true, createdAt: true }
  }));
});

// ── Leads: visitors who left an email in a chat, with the conversation and
// its AI summary (services/leads.js). A Lead row only exists once an email
// was captured and saved (email is NOT NULL), so every row here is a real
// lead — a conversation without an email never appears.
//
// GET /leads?botType=sales|support&status=NEW|CONTACTED (either omitted or
// "all" = no filter). Filters run in the database, so the 200-row page is
// the newest 200 MATCHING leads. counts covers all of this tenant's leads,
// unfiltered, for the filter labels.
const LEAD_STATUSES = ['NEW', 'CONTACTED'];
const LEAD_BOT_TYPES = ['sales', 'support'];
const MAX_LEADS = 200;
const LEAD_FIELDS = {
  id: true, botType: true, sessionId: true, email: true, chatSummary: true, summaryStatus: true, fullTranscript: true,
  status: true, confirmationSentAt: true, createdAt: true, updatedAt: true
};

// undefined/"all" -> no filter; a known value -> that value; anything else -> error.
function leadFilter(raw, allowed, normalize) {
  if (raw === undefined || raw === '' || String(raw).toLowerCase() === 'all') return { ok: true, value: undefined };
  const value = normalize(String(raw).trim());
  return allowed.includes(value) ? { ok: true, value } : { ok: false };
}

router.get('/leads', async (req, res) => {
  const botType = leadFilter(req.query.botType, LEAD_BOT_TYPES, (v) => v.toLowerCase());
  if (!botType.ok) return res.status(400).json({ error: `botType must be one of: all, ${LEAD_BOT_TYPES.join(', ')}` });
  const status = leadFilter(req.query.status, LEAD_STATUSES, (v) => v.toUpperCase());
  if (!status.ok) return res.status(400).json({ error: `status must be one of: all, ${LEAD_STATUSES.join(', ')}` });

  const where = { tenantId: req.tenant.id };
  if (botType.value) where.botType = botType.value;
  if (status.value) where.status = status.value;

  const [leads, groups] = await Promise.all([
    prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' }, take: MAX_LEADS, select: LEAD_FIELDS }),
    prisma.lead.groupBy({ by: ['botType', 'status'], where: { tenantId: req.tenant.id }, _count: { _all: true } })
  ]);
  const counts = { total: 0, sales: 0, support: 0, NEW: 0, CONTACTED: 0 };
  for (const g of groups) {
    const n = g._count._all;
    counts.total += n;
    if (g.botType in counts) counts[g.botType] += n;
    if (g.status in counts) counts[g.status] += n;
  }
  res.json({ leads, counts, filters: { botType: botType.value || 'all', status: status.value || 'all' } });
});

// Body: { status: 'NEW' | 'CONTACTED' }
router.patch('/leads/:leadId', async (req, res) => {
  const status = String(req.body?.status || '').toUpperCase();
  if (!LEAD_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${LEAD_STATUSES.join(', ')}` });
  const lead = await prisma.lead.findFirst({ where: { id: req.params.leadId, tenantId: req.tenant.id }, select: { id: true } });
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json(await prisma.lead.update({ where: { id: lead.id }, data: { status }, select: LEAD_FIELDS }));
});

// ── Sessions: every conversation with its AI summary (services/chatSessions.js),
// newest activity first, for the Sessions view of Leads & Summaries.
//
// GET /sessions?botType=all|sales|support&cursor=<session id> — 30 per page;
// nextCursor is null on the last page. Each row carries the leads captured in
// it (id, email, status), so staff can mark them contacted from the list.
const SESSIONS_PAGE = 30;
const SESSION_FIELDS = {
  id: true, externalUserId: true, botType: true, startedAt: true, lastMessageAt: true, messageCount: true,
  endedAt: true, summary: true, summaryStatus: true, summarizedAt: true
};
const isSummarizeLimited = createIpRateLimiter({ name: 'workspace-summarize', max: 20, windowMs: 60 * 60 * 1000 });

async function leadsBySession(tenantId, sessionIds) {
  if (!sessionIds.length) return new Map();
  const rows = await prisma.lead.findMany({
    where: { tenantId, sessionId: { in: sessionIds } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, sessionId: true, email: true, status: true, botType: true }
  });
  const map = new Map();
  for (const { sessionId, ...lead } of rows) map.set(sessionId, [...(map.get(sessionId) || []), lead]);
  return map;
}

router.get('/sessions', async (req, res) => {
  const botType = leadFilter(req.query.botType, LEAD_BOT_TYPES, (v) => v.toLowerCase());
  if (!botType.ok) return res.status(400).json({ error: `botType must be one of: all, ${LEAD_BOT_TYPES.join(', ')}` });
  const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : null;

  // Conversations with at least one turn; a cursor from another tenant matches nothing.
  const where = { tenantId: req.tenant.id, messageCount: { gt: 0 } };
  if (botType.value) where.botType = botType.value;
  const rows = await prisma.chatSession.findMany({
    where,
    orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    take: SESSIONS_PAGE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: SESSION_FIELDS
  });
  const page = rows.slice(0, SESSIONS_PAGE);
  const leads = await leadsBySession(req.tenant.id, page.map((s) => s.id));
  res.json({
    sessions: page.map((s) => ({ ...s, leads: leads.get(s.id) || [] })),
    nextCursor: rows.length > SESSIONS_PAGE ? page.at(-1).id : null
  });
});

// One conversation: its summary, leads and every message, oldest first.
// confidence is included: it's this tenant's own review data.
router.get('/sessions/:sessionId', async (req, res) => {
  const session = await prisma.chatSession.findFirst({
    where: { id: req.params.sessionId, tenantId: req.tenant.id }, select: SESSION_FIELDS
  });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const [messages, leads] = await Promise.all([
    prisma.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: CHRONOLOGICAL,
      take: 500,
      select: { id: true, role: true, content: true, botType: true, confidence: true, answered: true, createdAt: true }
    }),
    leadsBySession(req.tenant.id, [session.id])
  ]);
  res.json({ ...session, leads: leads.get(session.id) || [], messages });
});

// ── Improvements: conversations with genuine misses — each weak reply and
// the question that led to it, the gaps to fill in the documents. A reply is
// weak when it went through retrieval (confidence is set; greetings and
// handoff actions have none) and either
//   - its confidence is below IMPROVEMENT_CONFIDENCE_BELOW (25%), or
//   - the bot gave no knowledge-base answer (answered false): the gate's
//     fallback, a handoff, or "rephrase that" — whatever its score.
// Not a higher cut-off: engine/confidence.js scores ordinary, correct answers
// at 33-50%, so e.g. 60% would list nearly every good answer. Both bots
// unless botType is given; most recent weak reply first.
//
// GET /improvements?botType=all|sales|support&page=0 — 20 sessions per page.
const IMPROVEMENTS_PAGE = 20;
const MAX_WEAK_ANSWERS = 10; // per session, most recent kept
const improvementBelow = () => {
  const n = Number(process.env.IMPROVEMENT_CONFIDENCE_BELOW);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.25;
};
const isWeak = (m, below) => m.confidence != null && (m.confidence < below || !m.answered);
// createMany writes a turn's two rows with the same timestamp: on a tie the
// visitor's message ('user') goes before the reply ('assistant').
const CHRONOLOGICAL = [{ createdAt: 'asc' }, { role: 'desc' }];

router.get('/improvements', async (req, res) => {
  const botType = leadFilter(req.query.botType, LEAD_BOT_TYPES, (v) => v.toLowerCase());
  if (!botType.ok) return res.status(400).json({ error: `botType must be one of: all, ${LEAD_BOT_TYPES.join(', ')}` });
  const page = Math.min(500, Math.max(0, Number.parseInt(req.query.page, 10) || 0));
  const below = improvementBelow();

  const groups = await prisma.$queryRaw`
    WITH low AS (
      SELECT m."sessionId" AS id, MIN(m.confidence)::float AS lowest, COUNT(*)::int AS "weakAnswers",
             MAX(m."createdAt") AS "lastWeakAt"
      FROM "ChatMessage" m JOIN "ChatSession" s ON s.id = m."sessionId"
      WHERE s."tenantId" = ${req.tenant.id} AND m.role = 'assistant'
        AND m.confidence IS NOT NULL AND (m.confidence < ${below} OR NOT m.answered)
        ${botType.value ? Prisma.sql`AND m."botType" = ${botType.value}` : Prisma.empty}
      GROUP BY m."sessionId"
    )
    SELECT id, lowest, "weakAnswers", "lastWeakAt",
           COUNT(*) OVER ()::int AS "totalSessions", SUM("weakAnswers") OVER ()::int AS "totalWeakAnswers"
    FROM low ORDER BY "lastWeakAt" DESC, id
    LIMIT ${IMPROVEMENTS_PAGE} OFFSET ${page * IMPROVEMENTS_PAGE}`;

  const ids = groups.map((g) => g.id);
  const [sessions, messages, leads] = ids.length ? await Promise.all([
    prisma.chatSession.findMany({ where: { id: { in: ids }, tenantId: req.tenant.id }, select: SESSION_FIELDS }),
    prisma.chatMessage.findMany({
      where: { sessionId: { in: ids } }, orderBy: CHRONOLOGICAL,
      select: { id: true, sessionId: true, role: true, content: true, botType: true, confidence: true, answered: true, createdAt: true }
    }),
    leadsBySession(req.tenant.id, ids)
  ]) : [[], [], new Map()];

  // Each weak reply, paired with the visitor message just before it.
  const weakBySession = new Map();
  const lastQuestion = new Map();
  for (const m of messages) {
    if (m.role === 'user') { lastQuestion.set(m.sessionId, m.content); continue; }
    if (!isWeak(m, below)) continue;
    if (botType.value && m.botType !== botType.value) continue;
    const list = weakBySession.get(m.sessionId) || [];
    list.push({
      id: m.id, question: lastQuestion.get(m.sessionId) || null, answer: m.content, confidence: m.confidence,
      botType: m.botType, answered: m.answered, at: m.createdAt
    });
    weakBySession.set(m.sessionId, list.slice(-MAX_WEAK_ANSWERS));
  }

  const byId = new Map(sessions.map((s) => [s.id, s]));
  res.json({
    below,
    totalSessions: groups[0]?.totalSessions ?? 0,
    totalWeakAnswers: groups[0]?.totalWeakAnswers ?? 0,
    sessions: groups.filter((g) => byId.has(g.id)).map((g) => ({
      ...byId.get(g.id), lowest: g.lowest, weakAnswers: g.weakAnswers, lastWeakAt: g.lastWeakAt,
      leads: leads.get(g.id) || [], weak: weakBySession.get(g.id) || []
    })),
    nextPage: (page + 1) * IMPROVEMENTS_PAGE < (groups[0]?.totalSessions ?? 0) ? page + 1 : null
  });
});

// Write (or rewrite) the summary now. Each one is an LLM call billed to the tenant.
router.post('/sessions/:sessionId/summarize', async (req, res) => {
  const session = await prisma.chatSession.findFirst({ where: { id: req.params.sessionId, tenantId: req.tenant.id }, select: { id: true } });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (await isSummarizeLimited(req.tenant.id)) return res.status(429).json({ error: 'Too many summary requests. Try again later.' });
  // force: someone clicked "Rewrite" and is waiting for a new summary, so this
  // takes the claim even if a background sweep holds a live lease on it
  // (services/chatSessions.js).
  await claimSession(session.id, { force: true });
  runSessionSummary(session.id);
  res.status(202).json({ id: session.id, summaryStatus: 'pending' });
});

// ── Team alerts (services/teamAlerts.js): who gets "new lead" and "needs
// attention" emails. teamEmail null = the defaults; recipients is who
// actually gets them right now.
router.get('/notifications', async (req, res) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.tenant.id }, select: { id: true, teamEmail: true, signupEmail: true }
  });
  res.json({ teamEmail: tenant.teamEmail, recipients: await teamRecipients(tenant), lowConfidenceBelow: lowConfidenceBelow() });
});

// Body: { teamEmail: "a@x.com, b@x.com" | "" }
router.patch('/notifications', async (req, res) => {
  const parsed = parseTeamEmail(req.body?.teamEmail);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const tenant = await prisma.tenant.update({
    where: { id: req.tenant.id }, data: { teamEmail: parsed.value }, select: { id: true, teamEmail: true, signupEmail: true }
  });
  res.json({ teamEmail: tenant.teamEmail, recipients: await teamRecipients(tenant), lowConfidenceBelow: lowConfidenceBelow() });
});

// All-time totals plus the per-bot breakdown (services/usageStats.js):
// byBot.support / byBot.sales / byBot.other, each with questions, AI answers,
// cache hits, tokens, cost, cache savings and 7-day burn.
router.get('/usage', async (req, res) => {
  const [breakdownFor, conversations] = await Promise.all([
    usageBreakdowns([req.tenant.id]),
    prisma.chatSession.count({ where: { tenantId: req.tenant.id } })
  ]);
  const { totals, ...byBot } = breakdownFor(req.tenant.id);
  res.json({
    calls: totals.aiAnswers, // real LLM calls; cache hits are counted separately
    cacheHits: totals.cacheHits,
    cacheHitRate: totals.cacheHitRate,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    estimatedCostUsd: totals.costUsd,
    savedTokens: totals.savedTokens,
    savedCostUsd: totals.savedCostUsd,
    conversations,
    questions: totals.questions,
    byBot
  });
});

// GET /usage/daily?days=30 — one row per UTC day (7–90 days, oldest first),
// zero-filled so charts have no gaps: questions asked, conversations started,
// AI answers generated (real LLM calls), cache hits, tokens used, total
// cost (every bot plus platform work such as starter FAQs) and tickets
// filed — plus the answers, tokens and cost for each bot.
router.get('/usage/daily', async (req, res) => {
  const days = Math.min(90, Math.max(7, Number.parseInt(req.query.days, 10) || 30));
  const tenantId = req.tenant.id;
  const rows = await prisma.$queryRaw`
    WITH d AS (
      SELECT generate_series(date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => ${days - 1}::int),
                             date_trunc('day', now() AT TIME ZONE 'UTC'), interval '1 day')::date AS day
    ),
    q AS (SELECT (m."createdAt" AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS n
          FROM "ChatMessage" m JOIN "ChatSession" s ON s.id = m."sessionId"
          WHERE s."tenantId" = ${tenantId} AND m.role = 'user' GROUP BY 1),
    c AS (SELECT ("startedAt" AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS n
          FROM "ChatSession" WHERE "tenantId" = ${tenantId} GROUP BY 1),
    u AS (SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS day,
                 COUNT(*) FILTER (WHERE NOT "cacheHit")::int AS n,
                 COUNT(*) FILTER (WHERE "cacheHit")::int AS hits,
                 SUM("promptTokens" + "completionTokens")::int AS tokens,
                 COALESCE(SUM("estimatedCostUsd"), 0)::float AS cost,
                 COUNT(*) FILTER (WHERE NOT "cacheHit" AND "botType" = 'support')::int AS support_n,
                 COUNT(*) FILTER (WHERE NOT "cacheHit" AND "botType" = 'sales')::int AS sales_n,
                 COALESCE(SUM("promptTokens" + "completionTokens") FILTER (WHERE "botType" = 'support'), 0)::int AS support_tokens,
                 COALESCE(SUM("promptTokens" + "completionTokens") FILTER (WHERE "botType" = 'sales'), 0)::int AS sales_tokens,
                 COALESCE(SUM("estimatedCostUsd") FILTER (WHERE "botType" = 'support'), 0)::float AS support_cost,
                 COALESCE(SUM("estimatedCostUsd") FILTER (WHERE "botType" = 'sales'), 0)::float AS sales_cost
          FROM "UsageLog" WHERE "tenantId" = ${tenantId} GROUP BY 1),
    t AS (SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS n
          FROM "SupportTicket" WHERE "tenantId" = ${tenantId} GROUP BY 1)
    SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
           COALESCE(q.n, 0) AS questions, COALESCE(c.n, 0) AS conversations,
           COALESCE(u.n, 0) AS "aiAnswers", COALESCE(u.hits, 0) AS "cacheHits",
           COALESCE(u.tokens, 0) AS tokens, COALESCE(u.cost, 0) AS "costUsd", COALESCE(t.n, 0) AS tickets,
           COALESCE(u.support_n, 0) AS "supportAnswers", COALESCE(u.sales_n, 0) AS "salesAnswers",
           COALESCE(u.support_tokens, 0) AS "supportTokens", COALESCE(u.sales_tokens, 0) AS "salesTokens",
           COALESCE(u.support_cost, 0) AS "supportCostUsd", COALESCE(u.sales_cost, 0) AS "salesCostUsd"
    FROM d LEFT JOIN q USING (day) LEFT JOIN c USING (day) LEFT JOIN u USING (day) LEFT JOIN t USING (day)
    ORDER BY d.day`;
  res.json({ days, series: rows });
});

// Wrapped here, not in app.js: this router is mounted inside other routers,
// and wrapRouterAsync only reaches a router's own routes, not nested ones.
module.exports = wrapRouterAsync(router);
module.exports.API_KEY_PUBLIC_FIELDS = API_KEY_PUBLIC_FIELDS;
