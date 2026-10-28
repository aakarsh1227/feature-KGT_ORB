const nodemailer = require('nodemailer');

// Transactional email: password-reset codes, the visitor's lead
// confirmation, and alerts to a tenant's own team (services/teamAlerts.js:
// new lead, low-confidence answer, handoff). Transports, first one
// configured wins:
//   1. SMTP via nodemailer, when SMTP_HOST is set (Microsoft 365);
//   2. Resend's HTTP API, when RESEND_API_KEY and a sender are set (kept so
//      existing deployments keep working until they move to SMTP);
//   3. neither — outside production the message is printed to the API log so
//      flows can be tested locally ("dev mail"); in production
//      (DEPLOY_ENV or NODE_ENV=production) nothing is printed — reset codes must never
//      land in production logs — and the send reports failure.
//
// SMTP settings (Microsoft 365), all from the environment (.env.docker):
//   SMTP_HOST    smtp.office365.com
//   SMTP_PORT    587 (STARTTLS, the default) or 465 (implicit TLS)
//   SMTP_SECURE  optional override: true = implicit TLS. Defaults to true on
//                port 465 only. Without it, STARTTLS is required, so the
//                password never crosses the wire unencrypted.
//   SMTP_USER    connect@kgt.solutions
//   SMTP_PASS    the mailbox's app password when MFA is on; the mailbox also
//                needs Authenticated SMTP enabled
//   SMTP_FROM    "KGT Solutions <connect@kgt.solutions>"; defaults to SMTP_USER.
//                Microsoft 365 rejects a From address the login can't send as
//                (550 5.7.60 SendAsDenied), so keep it the same mailbox.

const RESEND_URL = 'https://api.resend.com/emails';
const env = (name) => String(process.env[name] || '').trim();

// Sender address. MAIL_FROM / EMAIL_FROM are the names older .env files use.
function mailFrom() {
  return env('SMTP_FROM') || env('MAIL_FROM') || env('EMAIL_FROM') || (env('SMTP_HOST') ? env('SMTP_USER') : '');
}

function smtpConfig() {
  const host = env('SMTP_HOST');
  if (!host) return null;
  const port = Number.parseInt(env('SMTP_PORT'), 10) || 587;
  const secure = env('SMTP_SECURE') ? env('SMTP_SECURE').toLowerCase() === 'true' : port === 465;
  const user = env('SMTP_USER');
  // SMTP_ALLOW_INSECURE=true: plaintext SMTP, for a local mail catcher
  // (Mailpit in the E2E stack) only. Production refuses it (utils/assertProdSafety.js).
  const insecure = env('SMTP_ALLOW_INSECURE').toLowerCase() === 'true';
  return {
    host,
    port,
    secure,
    requireTLS: !secure && !insecure, // STARTTLS or fail; never fall back to plaintext
    ...(insecure ? { ignoreTLS: true } : {}),
    auth: user ? { user, pass: process.env.SMTP_PASS || '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000
  };
}

function resendConfigured() {
  return !!(env('RESEND_API_KEY') && mailFrom());
}

/** @returns {'smtp'|'resend'|null} */
function activeTransport() {
  if (smtpConfig() && mailFrom()) return 'smtp';
  if (resendConfigured()) return 'resend';
  return null;
}

function mailConfigured() {
  return activeTransport() !== null;
}

// One pooled transport per configuration, built on first use.
let smtp = { key: null, transport: null };
function smtpTransport(config) {
  const key = JSON.stringify(config);
  if (smtp.key !== key) {
    smtp.transport?.close();
    smtp = { key, transport: nodemailer.createTransport({ ...config, pool: true, maxConnections: 3 }) };
  }
  return smtp.transport;
}

// Per-tenant SMTP transports (tenants that bring their own mail server —
// services/tenantSmtp.js), pooled and keyed by their config. Bounded so a
// large fleet can't grow this without limit; the least-recently-built one is
// closed and dropped past the cap.
const MAX_TENANT_TRANSPORTS = 50;
const tenantTransports = new Map();
function tenantTransport(config) {
  const key = JSON.stringify(config);
  let transport = tenantTransports.get(key);
  if (!transport) {
    if (tenantTransports.size >= MAX_TENANT_TRANSPORTS) {
      const oldest = tenantTransports.keys().next().value;
      tenantTransports.get(oldest)?.close?.();
      tenantTransports.delete(oldest);
    }
    transport = nodemailer.createTransport({ ...config, pool: true, maxConnections: 2 });
    tenantTransports.set(key, transport);
  }
  return transport;
}


// Production is either flag: Docker images set NODE_ENV=production, and a
// deployment that forgot DEPLOY_ENV must still never print mail (reset codes)
// to its logs or pretend a dev-log line was a delivered email.
function isProduction() {
  return env('DEPLOY_ENV') === 'production' || env('NODE_ENV') === 'production';
}

// Recipients in logs: enough to spot a typo'd domain, not the whole address.
function maskAddress(email) {
  const [local, domain] = String(email).split('@');
  return domain ? `${local.slice(0, 2)}***@${domain}` : '***';
}

const NOT_CONFIGURED_HINT = 'Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM in the env file the API ' +
  'process actually reads (.env.docker for Docker; apps/api/.env is excluded from the image), then recreate the ' +
  'container so it picks them up: docker compose --env-file .env.docker up -d api (a plain restart keeps the old env).';

/**
 * Sorts a send failure into something actionable.
 * reason: auth | timeout | connection | tls | rejected | temporary | unknown.
 * transient: worth retrying (the same message may go through in a minute).
 * @returns {{ reason: string, transient: boolean, hint: string, detail: string }}
 */
function classifyMailError(err) {
  const code = err?.code || '';
  const status = Number(err?.responseCode) || 0;
  const detail = `${code} ${err?.response || err?.message || ''}`.trim();
  const config = smtpConfig();
  const where = config ? `${config.host}:${config.port}` : 'the mail server';
  const result = (reason, transient, hint) => ({ reason, transient, hint, detail });

  if (code === 'EAUTH' || code === 'ENOAUTH' || [530, 534, 535].includes(status)) {
    return result('auth', false, 'SMTP login refused. Check SMTP_USER / SMTP_PASS. Microsoft 365: use an app password if the ' +
      'account has MFA, and make sure Authenticated SMTP is enabled for this mailbox (Microsoft 365 admin center > Users > ' +
      'Mail > Manage email apps). If it is enabled and the password is right, the tenant may have security defaults on, ' +
      'which block SMTP AUTH for every mailbox.');
  }
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(detail)) {
    return result('timeout', true, `No answer from ${where} in time. Check SMTP_HOST / SMTP_PORT, and that this host can ` +
      'make outbound connections on that port (some cloud providers block SMTP ports by default).');
  }
  if (code === 'ETLS' || /certificate|ssl|tls|wrong version number/i.test(detail)) {
    return result('tls', false, 'TLS handshake failed. Use port 587 with SMTP_SECURE unset (STARTTLS), or port 465 with ' +
      'SMTP_SECURE=true.');
  }
  if (['EDNS', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) ||
      /ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN/.test(detail)) {
    return result('connection', true, `Could not connect to ${where}. Check SMTP_HOST / SMTP_PORT and outbound network access.`);
  }
  if (status >= 400 && status < 500) {
    return result('temporary', true, 'The mail server deferred the message (4xx); it usually goes through on a retry.');
  }
  if (code === 'EENVELOPE' || status >= 500) {
    return result('rejected', false, 'The mail server refused the message. "SendAsDenied" / 5.7.60 means SMTP_FROM is not an ' +
      'address SMTP_USER may send as; otherwise check the recipient address.');
  }
  return result('unknown', false, 'See the detail above.');
}

function logFailure({ label, recipients, via, failure }) {
  console.error(
    `[mailer] ERROR: email NOT sent${label ? ` (${label})` : ''} to ${recipients.map(maskAddress).join(', ')} via ${via}: ` +
    `${failure.reason}${failure.detail ? ` - ${failure.detail}` : ''}\n[mailer]   fix: ${failure.hint}`
  );
}

/**
 * Never throws. Every failure is logged here, once, with its reason and a fix.
 * @param {{ to: string|string[], subject: string, text: string, html?: string,
 *           replyTo?: string, label?: string, devSummary?: string, tenantId?: string }} msg
 *   label: what this email is, for the logs ("visitor confirmation, lead 123")
 *   devSummary: what to print in dev mode instead of the whole body
 *   tenantId: when set, send from this tenant's own SMTP if they have an
 *     enabled one (services/tenantSmtp.js); otherwise the platform SMTP is used.
 * @returns {Promise<{ sent: boolean, via: 'smtp'|'resend'|'tenant-smtp'|'dev-log'|'none', simulated?: true,
 *   reason?: string, transient?: boolean, error?: string }>}
 *   simulated: printed to the log in development, not delivered to anyone.
 */
async function sendMail({ to, subject, text, html, replyTo, label, devSummary, tenantId }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { sent: false, via: 'none', reason: 'no-recipient', transient: false, error: 'No recipient' };

  // A tenant's own SMTP takes precedence when configured and enabled. If it
  // isn't (no row, disabled, or its password can't be decrypted), override is
  // null and we fall through to the platform transport below — the graceful
  // fallback. A failure of a configured tenant transport is reported as-is and
  // NOT silently retried via the platform, so a tenant's mail never goes out
  // from the platform identity behind their back.
  if (tenantId) {
    let override = null;
    try { override = await require('./tenantSmtp').resolveTenantTransport(tenantId); } catch { override = null; }
    if (override) {
      try {
        await tenantTransport(override.config).sendMail({
          from: override.from, to: recipients, subject, text, ...(html ? { html } : {}), ...(replyTo ? { replyTo } : {})
        });
        return { sent: true, via: 'tenant-smtp' };
      } catch (err) {
        const failure = classifyMailError(err);
        logFailure({ label, recipients, via: 'tenant-smtp', failure });
        return { sent: false, via: 'tenant-smtp', reason: failure.reason, transient: failure.transient, error: failure.detail };
      }
    }
  }

  const transport = activeTransport();

  if (transport === 'smtp') {
    try {
      await smtpTransport(smtpConfig()).sendMail({
        from: mailFrom(), to: recipients, subject, text, ...(html ? { html } : {}), ...(replyTo ? { replyTo } : {})
      });
      return { sent: true, via: 'smtp' };
    } catch (err) {
      // err.response is the server's reply ("535 5.7.3 Authentication unsuccessful"), never the password.
      const failure = classifyMailError(err);
      logFailure({ label, recipients, via: 'smtp', failure });
      return { sent: false, via: 'smtp', reason: failure.reason, transient: failure.transient, error: failure.detail };
    }
  }

  if (transport === 'resend') {
    let failure;
    try {
      const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${env('RESEND_API_KEY')}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: mailFrom(),
          to: recipients, subject, text, ...(html ? { html } : {}), ...(replyTo ? { reply_to: replyTo } : {})
        })
      });
      if (res.ok) return { sent: true, via: 'resend' };
      const detail = `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim();
      const retryable = res.status >= 500 || res.status === 429;
      failure = res.status === 401 || res.status === 403
        ? { reason: 'auth', transient: false, hint: 'Check RESEND_API_KEY, or switch to SMTP.', detail }
        : { reason: retryable ? 'temporary' : 'rejected', transient: retryable, hint: 'Resend refused the message; see the detail.', detail };
    } catch (err) {
      failure = { reason: 'connection', transient: true, hint: 'Could not reach api.resend.com.', detail: err.message };
    }
    logFailure({ label, recipients, via: 'resend', failure });
    return { sent: false, via: 'resend', reason: failure.reason, transient: failure.transient, error: failure.detail };
  }

  if (isProduction()) {
    logFailure({ label, recipients, via: 'none', failure: { reason: 'not-configured', detail: 'no mail transport is configured', hint: NOT_CONFIGURED_HINT } });
    return { sent: false, via: 'none', reason: 'not-configured', transient: false, error: 'Email is not configured' };
  }
  console.warn(`[mailer:dev] NOT delivered (no mail transport, printed instead) to=${recipients.join(',')} subject="${subject}" ${devSummary || text}`);
  return { sent: true, via: 'dev-log', simulated: true };
}

/**
 * Startup check: logs in to the SMTP server without sending anything, so bad
 * credentials show up in the boot log rather than as silently missing mail.
 * Never throws.
 * @returns {Promise<{ transport: string|null, production: boolean, ok?: boolean, error?: string,
 *   reason?: string, hint?: string }>}
 */
async function verifyMailer() {
  const transport = activeTransport();
  const base = { transport, production: isProduction() };
  if (!transport) return { ...base, hint: NOT_CONFIGURED_HINT };
  if (transport !== 'smtp') return base;
  try {
    await smtpTransport(smtpConfig()).verify();
    return { ...base, ok: true };
  } catch (err) {
    const failure = classifyMailError(err);
    return { ...base, ok: false, error: failure.detail, reason: failure.reason, hint: failure.hint };
  }
}

module.exports = {
  sendMail, mailConfigured, mailFrom, verifyMailer, smtpConfig, classifyMailError, isProduction, maskAddress
};
