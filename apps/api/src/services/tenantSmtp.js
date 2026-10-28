const nodemailer = require('nodemailer');
const prisma = require('../lib/prisma');
const { encrypt, decrypt, encryptionConfigured } = require('../utils/encryption');

// A tenant's own outbound SMTP. The password is encrypted at rest
// (utils/encryption.js) and is NEVER returned to the client — reads mask it.
// mailer.js asks resolveTenantTransport() at send time and falls back to the
// platform SMTP when a tenant has no enabled, usable config.

const MASK = '********'; // what the UI shows/sends instead of the real password
const PROVIDERS = ['gmail', 'outlook']; // known providers; anything else is treated as a custom server (null)
const CONNECT_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

class SmtpConfigError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'SmtpConfigError';
    this.statusCode = statusCode;
  }
}

function requiredString(value, field, max = 255) {
  const s = String(value ?? '').trim();
  if (!s) throw new SmtpConfigError(`${field} is required`);
  if (s.length > max) throw new SmtpConfigError(`${field} must be ${max} characters or fewer`);
  return s;
}

function validatePort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new SmtpConfigError('smtpPort must be a whole number between 1 and 65535');
  return n;
}

// A known provider key, or null for a custom server. Invalid strings are not
// an error — they just mean "custom" — so the UI is free to send anything.
function normalizeProvider(value) {
  const p = String(value ?? '').trim().toLowerCase();
  return PROVIDERS.includes(p) ? p : null;
}

// Accepts "user@host" or "Display Name <user@host>".
function validateFrom(value) {
  const s = requiredString(value, 'smtpFrom', 320);
  const addr = /<([^>]+)>/.test(s) ? s.match(/<([^>]+)>/)[1] : s;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr.trim())) {
    throw new SmtpConfigError('smtpFrom must be a valid email address (optionally in "Name <email@domain>" form)');
  }
  return s;
}

// nodemailer options from plain credentials. STARTTLS is required on non-465
// ports so the password never crosses the wire in plaintext.
function buildTransportConfig({ host, port, user, pass, secure }) {
  const sec = typeof secure === 'boolean' ? secure : port === 465;
  return {
    host,
    port,
    secure: sec,
    requireTLS: !sec,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS
  };
}

function row(tenantId) {
  return prisma.tenantSmtpConfig.findUnique({ where: { tenantId } });
}

/**
 * The tenant's config for the UI, with the password masked — never the
 * ciphertext and never the plaintext.
 */
async function getMaskedConfig(tenantId) {
  const r = await row(tenantId);
  if (!r) {
    return { configured: false, isEnabled: false, provider: null, smtpHost: '', smtpPort: 587, smtpUser: '', smtpFrom: '', hasPassword: false, smtpPass: '' };
  }
  return {
    configured: true,
    isEnabled: r.isEnabled,
    provider: r.provider || null,
    smtpHost: r.smtpHost,
    smtpPort: r.smtpPort,
    smtpUser: r.smtpUser,
    smtpFrom: r.smtpFrom,
    hasPassword: !!r.smtpPass,
    smtpPass: r.smtpPass ? MASK : '' // placeholder only; the real value never leaves the server
  };
}

/**
 * Creates or updates the tenant's SMTP config. The password is encrypted
 * before it touches the database; sending the mask (or nothing) keeps the
 * stored password so the form can be saved without re-typing it.
 * @throws {SmtpConfigError} on invalid input (400) or missing ENCRYPTION_KEY (503)
 */
async function upsertConfig(tenantId, body) {
  if (!encryptionConfigured()) {
    throw new SmtpConfigError('Secure storage is not configured on the server (ENCRYPTION_KEY is unset). Contact your administrator.', 503);
  }
  const smtpHost = requiredString(body?.smtpHost, 'smtpHost');
  const smtpPort = validatePort(body?.smtpPort);
  const smtpUser = requiredString(body?.smtpUser, 'smtpUser');
  const smtpFrom = validateFrom(body?.smtpFrom);
  const isEnabled = body?.isEnabled === undefined ? true : !!body.isEnabled;

  const existing = await row(tenantId);
  const rawPass = typeof body?.smtpPass === 'string' ? body.smtpPass : '';
  let smtpPass;
  if (rawPass && rawPass !== MASK) {
    smtpPass = encrypt(rawPass); // a real new password
  } else if (existing?.smtpPass) {
    smtpPass = existing.smtpPass; // unchanged — keep the stored ciphertext
  } else {
    throw new SmtpConfigError('smtpPass is required');
  }

  const data = { provider: normalizeProvider(body?.provider), smtpHost, smtpPort, smtpUser, smtpFrom, smtpPass, isEnabled };
  await prisma.tenantSmtpConfig.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
  return getMaskedConfig(tenantId);
}

/**
 * Verifies SMTP credentials without saving anything: logs in to the server
 * and reports success/failure. The mask (or empty password) tests against the
 * stored password, so a saved config can be re-tested without re-typing it.
 * @returns {Promise<{ ok: boolean, reason?: string, error?: string, hint?: string }>}
 */
async function testConfig(tenantId, body) {
  const { classifyMailError } = require('./mailer'); // lazy: avoids any load-order cycle
  let cfg;
  try {
    const rawPass = typeof body?.smtpPass === 'string' ? body.smtpPass : '';
    let pass = rawPass;
    if (!pass || pass === MASK) {
      const r = await row(tenantId);
      pass = r?.smtpPass ? decrypt(r.smtpPass) : '';
    }
    if (!pass) throw new SmtpConfigError('Enter a password to test with');
    cfg = buildTransportConfig({
      host: requiredString(body?.smtpHost, 'smtpHost'),
      port: validatePort(body?.smtpPort),
      user: requiredString(body?.smtpUser, 'smtpUser'),
      pass,
      secure: typeof body?.smtpSecure === 'boolean' ? body.smtpSecure : undefined
    });
  } catch (err) {
    if (err instanceof SmtpConfigError) return { ok: false, reason: 'invalid', error: err.message };
    return { ok: false, reason: 'unknown', error: 'Could not read the stored credentials to test.' };
  }

  const transport = nodemailer.createTransport(cfg);
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    const f = classifyMailError(err);
    return { ok: false, reason: f.reason, error: f.detail, hint: f.hint };
  } finally {
    transport.close();
  }
}

/**
 * For mailer.js: a ready-to-send override for this tenant, or null when there
 * is no enabled/usable config (the caller then uses the platform SMTP). Never
 * throws — a decryption failure (e.g. ENCRYPTION_KEY rotated) logs once and
 * returns null so email still goes out via the platform rather than failing.
 * @returns {Promise<{ config: object, from: string } | null>}
 */
async function resolveTenantTransport(tenantId) {
  if (!tenantId || !encryptionConfigured()) return null;
  const r = await row(tenantId);
  if (!r || !r.isEnabled || !r.smtpHost || !r.smtpPass) return null;
  let pass;
  try {
    pass = decrypt(r.smtpPass);
  } catch (err) {
    console.error(`[tenantSmtp] tenant ${tenantId}: could not decrypt SMTP password (has ENCRYPTION_KEY changed?) — using platform SMTP. ${err.message}`);
    return null;
  }
  return {
    config: buildTransportConfig({ host: r.smtpHost, port: r.smtpPort, user: r.smtpUser, pass, secure: r.smtpPort === 465 }),
    from: r.smtpFrom
  };
}

module.exports = { getMaskedConfig, upsertConfig, testConfig, resolveTenantTransport, SmtpConfigError, MASK };
