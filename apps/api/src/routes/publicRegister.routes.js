const express = require('express');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const multer = require('multer');
const { crawlSite, CrawlerError } = require('../services/shared/crawler');
const { pdfToDocuments, PdfIngestError } = require('../services/shared/pdfIngest');
const { parseCategory, suggestCategory } = require('../services/shared/documentCategory');
const { createIpRateLimiter } = require('../utils/ipRateLimit');
const { issueApiKey } = require('../utils/tenantApiKeys');
const { hashPassword } = require('../utils/password');
const { signClientToken } = require('../middleware/clientAuth');
const { crawlConsentRecord, hostOf } = require('../services/shared/crawlConsent');
const { scheduleFaqGeneration } = require('../services/tenantFaqs');
const { parseBotScope, parseBotPreference } = require('../services/shared/botScope');
const { parseBusinessCategory } = require('../services/shared/businessCategory');
const { claimVerification, ACCOUNT_EXISTS } = require('../services/verificationService');
const { maskAddress } = require('../services/mailer');
const { ingestUpload, FileIngestError, MAX_UPLOAD_BYTES } = require('../services/shared/fileIngest');

class UnverifiedEmail extends Error {}
const {
  auditKnowledge, rememberWizardAudit, takeWizardAudit, saveTenantReadiness, scheduleTenantAudit, contentHash
} = require('../services/botAuditor');

// Public self-serve registration wizard backend (apps/admin-web/pages/register.js).
// Deliberately unauthenticated — that's the entire point of self-serve — so
// everything here is IP-rate-limited and server-side capped instead of
// relying on a login. This is a materially different trust boundary from
// tenantAdmin.routes.js (operators only): anyone on the internet can call
// these two endpoints, so nothing here should assume good-faith input.
//
// Two-step split mirrors the wizard's own Step 2 (preview + edit) / Step 3
// (finalize) split: /analyze crawls (and /analyze-pdf parses an uploaded
// PDF) and returns pages WITHOUT creating
// anything (no tenant exists yet, so there's nothing to persist to or
// invalidate); /complete creates the Tenant + TenantDocument rows from
// whatever the visitor reviewed/edited in the browser — not a fresh crawl,
// so an edit made in Step 2 is exactly what gets trained on.
const router = express.Router();

const isAnalyzeRateLimited = createIpRateLimiter({ name: 'register-analyze', max: 8, windowMs: 10 * 60 * 1000 });
// Signups per IP per hour. Every attempt counts, including rejected ones, so
// the endpoint can't be used to probe which emails already have accounts.
const isCompleteRateLimited = createIpRateLimiter({ name: 'register-complete', max: Number(process.env.SIGNUP_RATE_LIMIT_MAX) || 3, windowMs: 60 * 60 * 1000 });
const isPdfRateLimited = createIpRateLimiter({ name: 'register-upload', max: 10, windowMs: 10 * 60 * 1000 });
// Each readiness check is an LLM call paid by us, on a public route. The wizard
// re-checks after every upload on its Training screen, hence room for a dozen.
const isAuditRateLimited = createIpRateLimiter({ name: 'register-audit', max: Number(process.env.PREFLIGHT_AUDIT_RATE_LIMIT_MAX) || 12, windowMs: 10 * 60 * 1000 });

// Room for a full crawl (crawler.js MAX_PAGES = 12) plus several uploaded
// documents: the wizard lets a company combine both sources.
const MAX_PAGES_ON_COMPLETE = 40;
const MAX_PDF_BYTES = 10 * 1024 * 1024;

// Memory storage, not disk: the PDF is parsed and discarded within the
// request — nothing is persisted until /complete, same as a crawl. The
// buffer is capped by MAX_PDF_BYTES, and the rate limiter runs BEFORE multer
// so a blocked caller can't make the server buffer 10MB first.
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 0 },
  fileFilter: (_req, file, cb) => {
    // Some browsers/OSes send application/octet-stream for a .pdf; the
    // %PDF- magic-byte check in pdfToDocuments is the real gate.
    const looksPdf = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname || '');
    if (looksPdf) cb(null, true);
    else cb(new PdfIngestError('Only PDF files are accepted', 400));
  }
});

async function pdfUploadMiddleware(req, res, next) {
  if (await isPdfRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many uploads from this address. Please wait a few minutes and try again.' });
  }
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
const MAX_TITLE_LEN = 200;
const MAX_CONTENT_LEN = 20000; // per page — a hard ceiling regardless of what the client claims it sent

const MAX_SOURCE_URL_LEN = 2048;
const MIN_PASSWORD_LEN = 10;

function makeSlug(name) {
  const base = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  // A random suffix, not just the company name, because this endpoint has
  // no auth to fall back on for a friendly "slug taken, try another" retry
  // loop — collisions must not be a public-facing self-serve dead end.
  return `${base || 'company'}-${crypto.randomBytes(3).toString('hex')}`;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

/**
 * The submitted pages, capped and validated exactly as they'd be saved —
 * shared by /preflight-audit and /complete, so an audit's content hash
 * matches the pages /complete then creates.
 * @returns {{ ok: true, pages: object[] } | { ok: false, error: string }}
 */
function normalizePages(rawPages) {
  const pages = [];
  for (const p of (Array.isArray(rawPages) ? rawPages : []).slice(0, MAX_PAGES_ON_COMPLETE)) {
    // Omitted category -> CORE_OVERVIEW and omitted botScope -> AUTO (older
    // clients); an unknown value is rejected rather than silently re-filed.
    const category = parseCategory(p?.category);
    if (!category.ok) return { ok: false, error: category.error };
    const botScope = parseBotScope(p?.botScope);
    if (!botScope.ok) return { ok: false, error: botScope.error };
    const sourceUrl = typeof p?.sourceUrl === 'string' && hostOf(p.sourceUrl) ? p.sourceUrl.slice(0, MAX_SOURCE_URL_LEN) : null;
    const page = {
      title: String(p?.title || '').trim().slice(0, MAX_TITLE_LEN),
      content: String(p?.content || '').trim().slice(0, MAX_CONTENT_LEN),
      category: category.value,
      botScope: botScope.value,
      sourceUrl
    };
    if (page.title && page.content) pages.push(page);
  }
  return { ok: true, pages };
}

// Pre-flight readiness audit of the pages in the wizard, before anything is
// created (services/botAuditor.js). One LLM call per request on an
// unauthenticated route, so it's rate-limited per IP; the report is kept
// briefly by content hash so /complete can store it without auditing again.
router.post('/preflight-audit', async (req, res) => {
  if (await isAuditRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many readiness checks from this address. Please wait a few minutes and try again.' });
  }
  const normalized = normalizePages(req.body?.pages);
  if (!normalized.ok) return res.status(400).json({ error: normalized.error });
  if (!normalized.pages.length) return res.status(400).json({ error: 'Add at least one website page or document to audit' });

  const company = {
    name: String(req.body?.companyName || '').trim().slice(0, 120) || 'this company',
    industryLabel: String(req.body?.industryLabel || '').trim().slice(0, 120) || 'business'
  };
  // botPreference: which bots will be deployed (the wizard's "Choose your AI workforce" step).
  const botPreference = parseBotPreference(req.body?.botPreference);
  if (!botPreference.ok) return res.status(400).json({ error: botPreference.error });
  const report = await auditKnowledge({ company, documents: normalized.pages, botPreference: botPreference.value });
  await rememberWizardAudit(report);
  res.json(report);
});

router.post('/analyze', async (req, res) => {
  if (await isAnalyzeRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many analysis requests from this address. Please wait a few minutes and try again.' });
  }

  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url is required' });
  // Enforced here, not just by the wizard's checkbox: no crawl without it.
  // It's recorded permanently (TenantConsent) at /complete, once a tenant exists.
  if (req.body?.authorized !== true) {
    return res.status(400).json({ error: 'You must confirm you are authorized to let us crawl this domain' });
  }

  try {
    // Static-only on purpose: no browserFallback on this unauthenticated
    // route (see crawlerBrowser.js). A JS-only site's 422 here leads the
    // visitor to the PDF upload instead.
    const result = await crawlSite(url);
    res.json({
      baseHost: result.baseHost,
      crawled: result.crawled,
      skipped: result.skipped,
      // category is a suggestion for which wizard tab the page starts in;
      // the visitor can move it, and /complete saves whatever they chose.
      pages: result.pages.map((p) => ({
        title: p.title,
        content: p.markdown,
        url: p.url,
        category: suggestCategory({ title: p.title, url: p.url, markdown: p.markdown, source: 'crawl' })
      }))
    });
  } catch (e) {
    if (e instanceof CrawlerError) return res.status(e.statusCode).json({ error: e.message });
    throw e; // an unexpected failure — let the global error handler log and 500 it
  }
});

// Same response shape as /analyze (pages[].title/content/url), so the
// wizard merges uploaded-PDF pages into the same review list as crawled
// ones. url is null — a PDF has no page to link back to.
router.post('/analyze-pdf', pdfUploadMiddleware, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a PDF in a field named "file"' });

  try {
    const result = await pdfToDocuments(req.file.buffer, req.file.originalname);
    res.json({
      title: result.title,
      pdfPageCount: result.pdfPageCount,
      truncated: result.truncated,
      pages: result.pages.map((p) => ({
        title: p.title,
        content: p.markdown,
        url: null,
        category: suggestCategory({ title: p.title, markdown: p.markdown, source: 'pdf' })
      }))
    });
  } catch (e) {
    if (e instanceof PdfIngestError) return res.status(e.statusCode).json({ error: e.message });
    throw e;
  }
});

// Any supported file — PDF, Word (.docx), .txt, .md, or a .zip of them —
// parsed and returned as pages, like /analyze-pdf; nothing is saved.
// files[] says what happened to each file (inside a zip, some may be skipped).
const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 } });

async function fileUploadMiddleware(req, res, next) {
  if (await isPdfRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many uploads from this address. Please wait a few minutes and try again.' });
  }
  fileUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Uploads are limited to ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB` });
      return res.status(400).json({ error: 'Upload exactly one file in a field named "file"' });
    }
    next(err);
  });
}

router.post('/analyze-file', fileUploadMiddleware, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a file in a field named "file"' });
  try {
    const { pages, files } = await ingestUpload(req.file.buffer, req.file.originalname);
    res.json({
      files,
      pages: pages.map((p) => ({
        title: p.title,
        content: p.markdown,
        url: null,
        sourceFile: p.sourceFile,
        category: suggestCategory({ title: p.title, markdown: p.markdown, source: 'pdf' })
      }))
    });
  } catch (e) {
    if (e instanceof FileIngestError || e instanceof PdfIngestError) return res.status(e.statusCode).json({ error: e.message });
    throw e;
  }
});

router.post('/complete', async (req, res) => {
  // Every refusal is logged with its reason: a signup that silently never
  // completes otherwise looks, later, like a login bug ("Invalid email or password").
  const refuse = (status, body) => {
    console.warn(`[register] signup refused (${status}) for ${maskAddress(String(req.body?.email || '').trim().toLowerCase())}: ${body.code || body.error}`);
    return res.status(status).json(body);
  };
  if (await isCompleteRateLimited(req.ip)) {
    return refuse(429, {
      error: 'Too many signup attempts from this address. Please try again later, or reach out to us directly.'
    });
  }

  const companyName = String(req.body?.companyName || '').trim().slice(0, 120);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const contactName = String(req.body?.contactName || '').trim().slice(0, 120) || null;
  const industryLabel = String(req.body?.industryLabel || '').trim().slice(0, 120);
  const rawPages = Array.isArray(req.body?.pages) ? req.body.pages : [];
  const botPreference = parseBotPreference(req.body?.botPreference); // support | sales | both (default)
  if (!botPreference.ok) return refuse(400, { error: botPreference.error });
  const businessCategory = parseBusinessCategory(req.body?.businessCategory); // ecommerce | saas | ... | null
  if (!businessCategory.ok) return refuse(400, { error: businessCategory.error });

  if (!companyName) return refuse(400, { error: 'companyName is required' });
  if (!isValidEmail(email)) return refuse(400, { error: 'A valid business email is required' });
  if (password.length < MIN_PASSWORD_LEN) {
    return refuse(400, { error: `Choose a password of at least ${MIN_PASSWORD_LEN} characters` });
  }
  if (!industryLabel) return refuse(400, { error: 'industryLabel is required' });
  if (!rawPages.length) return refuse(400, { error: 'Add at least one website page or document to train on' });
  if (await prisma.tenantUser.findUnique({ where: { email }, select: { id: true } })) {
    return refuse(409, { error: ACCOUNT_EXISTS });
  }

  const normalized = normalizePages(rawPages);
  if (!normalized.ok) return refuse(400, { error: normalized.error });
  const { pages } = normalized;
  if (!pages.length) return refuse(400, { error: 'None of the submitted pages had both a title and content' });

  // Crawled content (pages carrying a sourceUrl) can only be saved alongside
  // the crawl authorization, which is recorded as a TenantConsent row.
  const consent = req.body?.websiteConsent;
  const consentHost = consent?.authorized === true ? hostOf(String(consent.url || '')) : null;
  if (pages.some((p) => p.sourceUrl) && !consentHost) {
    return refuse(400, { error: 'Crawled pages require websiteConsent: { authorized: true, url }' });
  }

  // Tenant, its first API key, documents, crawl consent and the client's
  // login are created together or not at all.
  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      // The email must have been verified by OTP (POST /api/v1/public/auth/verify-otp).
      // Claimed here, inside the transaction: consumed only if the account is
      // created, and one verification creates one account.
      if (!(await claimVerification(tx, email, req.body?.emailVerificationToken))) throw new UnverifiedEmail();
      const tenant = await tx.tenant.create({
        data: { name: companyName, slug: makeSlug(companyName), industryLabel, signupEmail: email, botPreference: botPreference.value, businessCategory: businessCategory.value }
      });
      const { key } = await issueApiKey(tx, tenant.id, 'Website widget');
      await tx.tenantDocument.createMany({ data: pages.map((p) => ({ tenantId: tenant.id, ...p })) });
      if (consentHost) {
        await tx.tenantConsent.create({
          data: { tenantId: tenant.id, ...crawlConsentRecord({ url: String(consent.url), email, req }) }
        });
      }
      const user = await tx.tenantUser.create({
        data: { tenantId: tenant.id, email, name: contactName, passwordHash: hashPassword(password), lastLoginAt: new Date() }
      });
      return { tenant, apiKey: key, user };
    });
  } catch (e) {
    if (e instanceof UnverifiedEmail) {
      return refuse(403, { error: 'Verify your email address first — request a code and enter it in the wizard.', code: 'EMAIL_NOT_VERIFIED' });
    }
    // Two signups racing on the same email: the unique index wins.
    if (e.code === 'P2002') return refuse(409, { error: ACCOUNT_EXISTS });
    throw e;
  }
  console.log(`[register] account created for ${maskAddress(email)} (tenant ${created.tenant.slug})`);
  // No invalidateTenantKnowledge call needed — this tenant's knowledge
  // cache has never been populated, so there's nothing stale to clear.
  // Starter questions are written in the background, usually before the
  // new client reaches the Test Bots page.
  scheduleFaqGeneration(created.tenant.id);
  // The readiness report the visitor reviewed in the wizard, if it was for
  // exactly these pages; otherwise (skipped, edited after, or a restart in
  // between) a fresh audit runs in the background.
  const reviewed = await takeWizardAudit(contentHash(pages, botPreference.value));
  let readiness = null;
  if (reviewed) {
    readiness = { score: reviewed.readinessScore, level: reviewed.readinessLevel };
    await saveTenantReadiness(created.tenant.id, reviewed).catch((err) => {
      console.warn(`[register] tenant ${created.tenant.id}: could not save the readiness report: ${err.message}`);
      scheduleTenantAudit(created.tenant.id);
    });
  } else {
    scheduleTenantAudit(created.tenant.id);
  }

  res.status(201).json({
    tenantId: created.tenant.id,
    slug: created.tenant.slug,
    name: created.tenant.name,
    apiKey: created.apiKey, // shown once, on the dashboard's welcome banner
    documentsCreated: pages.length,
    readiness, // { score, level } when the reviewed audit was kept; null while a fresh one runs
    botPreference: botPreference.value,
    // Signed straight in: the wizard lands the new client on /dashboard.
    token: signClientToken(created.user)
  });
});

module.exports = router;
