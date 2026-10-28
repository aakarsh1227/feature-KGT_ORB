const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

before(() => { process.env.ENCRYPTION_KEY = 'unit-test-master-secret-please-ignore'; });

const prisma = require('../../src/lib/prisma');
const { isEncrypted } = require('../../src/utils/encryption');
const { getMaskedConfig, upsertConfig, resolveTenantTransport, SmtpConfigError, MASK } = require('../../src/services/tenantSmtp');

// In-memory stand-in for the single TenantSmtpConfig row, so these tests need
// no database: the Prisma model delegate is swapped for a tiny fake that upsert
// writes and findUnique reads back, then restored.
let stored = null;
let realDelegate;
beforeEach(() => {
  stored = null;
  realDelegate = prisma.tenantSmtpConfig;
  prisma.tenantSmtpConfig = {
    findUnique: async () => stored,
    upsert: async ({ create, update }) => {
      stored = { tenantId: 't1', ...(stored ? update : create) };
      return stored;
    }
  };
});
afterEach(() => { prisma.tenantSmtpConfig = realDelegate; });

const VALID = { smtpHost: 'smtp.acme.com', smtpPort: 587, smtpUser: 'alerts@acme.com', smtpPass: 's3cret-pw', smtpFrom: 'Acme <alerts@acme.com>' };

describe('tenantSmtp: storage is encrypted and never leaked', () => {
  test('the password is stored as ciphertext, never plaintext', async () => {
    await upsertConfig('t1', VALID);
    assert.ok(stored.smtpPass, 'a password was stored');
    assert.ok(isEncrypted(stored.smtpPass), 'stored password is ciphertext');
    assert.ok(!stored.smtpPass.includes('s3cret-pw'), 'plaintext never appears in storage');
  });

  test('getMaskedConfig returns the mask, never the ciphertext or plaintext', async () => {
    await upsertConfig('t1', VALID);
    const view = await getMaskedConfig('t1');
    assert.equal(view.smtpPass, MASK);
    assert.equal(view.hasPassword, true);
    assert.equal(view.smtpHost, 'smtp.acme.com');
    assert.notEqual(view.smtpPass, stored.smtpPass);
    assert.ok(!JSON.stringify(view).includes('s3cret-pw'));
  });

  test('no config yet returns a blank, unconfigured view', async () => {
    const view = await getMaskedConfig('t1');
    assert.deepEqual(view, { configured: false, isEnabled: false, provider: null, smtpHost: '', smtpPort: 587, smtpUser: '', smtpFrom: '', hasPassword: false, smtpPass: '' });
  });

  test('the chosen provider is stored and returned; an unknown provider is stored as null (custom)', async () => {
    await upsertConfig('t1', { ...VALID, provider: 'gmail' });
    assert.equal(stored.provider, 'gmail');
    assert.equal((await getMaskedConfig('t1')).provider, 'gmail');
    await upsertConfig('t1', { ...VALID, provider: 'yahoo', smtpPass: MASK });
    assert.equal(stored.provider, null);
  });
});

describe('tenantSmtp: saving with the mask keeps the stored password', () => {
  test('re-saving with smtpPass="********" does not change the ciphertext', async () => {
    await upsertConfig('t1', VALID);
    const original = stored.smtpPass;
    await upsertConfig('t1', { ...VALID, smtpPass: MASK, smtpFrom: 'Acme Support <alerts@acme.com>' });
    assert.equal(stored.smtpPass, original, 'ciphertext unchanged');
    assert.equal(stored.smtpFrom, 'Acme Support <alerts@acme.com>', 'other fields still update');
  });

  test('a real new password replaces the ciphertext', async () => {
    await upsertConfig('t1', VALID);
    const original = stored.smtpPass;
    await upsertConfig('t1', { ...VALID, smtpPass: 'a-new-password' });
    assert.notEqual(stored.smtpPass, original);
    assert.ok(isEncrypted(stored.smtpPass));
  });
});

describe('tenantSmtp: input validation', () => {
  const bad = (patch, re) => assert.rejects(() => upsertConfig('t1', { ...VALID, ...patch }),
    (e) => e instanceof SmtpConfigError && re.test(e.message));

  test('rejects a missing host, bad port, and malformed from address', async () => {
    await bad({ smtpHost: '   ' }, /smtpHost is required/);
    await bad({ smtpPort: 70000 }, /smtpPort/);
    await bad({ smtpPort: 'abc' }, /smtpPort/);
    await bad({ smtpFrom: 'not-an-email' }, /smtpFrom/);
  });

  test('requires a password when none is stored and none is given', async () => {
    await bad({ smtpPass: '' }, /smtpPass is required/);
  });
});

describe('tenantSmtp: resolveTenantTransport (used by the mailer)', () => {
  test('returns a decrypted, ready transport for an enabled config', async () => {
    await upsertConfig('t1', { ...VALID, isEnabled: true });
    const t = await resolveTenantTransport('t1');
    assert.equal(t.from, 'Acme <alerts@acme.com>');
    assert.equal(t.config.host, 'smtp.acme.com');
    assert.equal(t.config.auth.user, 'alerts@acme.com');
    assert.equal(t.config.auth.pass, 's3cret-pw'); // decrypted in memory for sending
    assert.equal(t.config.requireTLS, true); // STARTTLS on 587
  });

  test('returns null when disabled, so the mailer falls back to the platform SMTP', async () => {
    await upsertConfig('t1', { ...VALID, isEnabled: false });
    assert.equal(await resolveTenantTransport('t1'), null);
  });

  test('returns null when there is no config at all', async () => {
    assert.equal(await resolveTenantTransport('t1'), null);
  });
});
