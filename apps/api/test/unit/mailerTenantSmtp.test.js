const { test, describe, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const mailer = require('../../src/services/mailer');
const tenantSmtp = require('../../src/services/tenantSmtp');
const nodemailer = require('nodemailer');

// These run with no SMTP_* env, so the platform transport is the dev-log
// (not production) — which is exactly the "fallback" path we assert.
describe('mailer: per-tenant SMTP override', () => {
  afterEach(() => mock.restoreAll());

  test('sends via the tenant transport and from their address when configured', async () => {
    let captured = null;
    mock.method(tenantSmtp, 'resolveTenantTransport', async () => ({ config: { host: 'smtp.acme.com', port: 587 }, from: 'Acme <alerts@acme.com>' }));
    mock.method(nodemailer, 'createTransport', () => ({ sendMail: async (opts) => { captured = opts; }, close() {} }));

    const r = await mailer.sendMail({ to: 'x@y.com', subject: 's', text: 't', tenantId: 't1' });
    assert.equal(r.sent, true);
    assert.equal(r.via, 'tenant-smtp');
    assert.equal(captured.from, 'Acme <alerts@acme.com>');
    assert.deepEqual(captured.to, ['x@y.com']);
  });

  test('falls back to the platform transport when the tenant has no config', async () => {
    mock.method(tenantSmtp, 'resolveTenantTransport', async () => null);
    const r = await mailer.sendMail({ to: 'x@y.com', subject: 's', text: 't', tenantId: 't1' });
    assert.notEqual(r.via, 'tenant-smtp'); // used the platform path (dev-log here)
  });

  test('without a tenantId, the tenant SMTP is never consulted', async () => {
    const spy = mock.method(tenantSmtp, 'resolveTenantTransport', async () => { throw new Error('should not be called'); });
    const r = await mailer.sendMail({ to: 'x@y.com', subject: 's', text: 't' });
    assert.equal(spy.mock.callCount(), 0);
    assert.notEqual(r.via, 'tenant-smtp');
  });

  test('a tenant-transport send failure is reported, not silently sent via the platform', async () => {
    mock.method(tenantSmtp, 'resolveTenantTransport', async () => ({ config: { host: 'smtp.acme.com' }, from: 'a@acme.com' }));
    mock.method(nodemailer, 'createTransport', () => ({ sendMail: async () => { const e = new Error('535 auth failed'); e.code = 'EAUTH'; throw e; }, close() {} }));
    const r = await mailer.sendMail({ to: 'x@y.com', subject: 's', text: 't', tenantId: 't1' });
    assert.equal(r.sent, false);
    assert.equal(r.via, 'tenant-smtp');
    assert.equal(r.reason, 'auth');
  });
});
