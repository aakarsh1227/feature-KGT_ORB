const prisma = require('../lib/prisma');
const { sendMail, maskAddress } = require('./mailer');
const { store, keys } = require('../lib/sharedStore');

// Alert emails to the TENANT'S OWN team, so someone can follow up while the
// visitor is still around:
//   - lead captured: a visitor left their email in a chat (services/leads.js);
//   - needs attention: a reply was below LOW_CONFIDENCE_ALERT_BELOW (25% by
//     default), or the bot handed the visitor off to a person
//     (services/tenantChat.js).
// Recipients: Tenant.teamEmail, else the signup email, else the tenant's
// dashboard users. Visitor-typed text goes only to these addresses, which the
// tenant controls — never to an address typed into the chat.
//
// The widget is public, so anyone can make the bot hand off over and over.
// Needs-attention alerts are throttled: one per conversation per
// ALERT_SESSION_COOLDOWN_MIN, and at most ALERT_TENANT_MAX_PER_HOUR per
// tenant (lead alerts count toward the same hourly cap). A throttled alert is
// logged, not lost: the conversation is in the dashboard's Sessions view and
// the handoff is a ticket. TEAM_ALERTS_ENABLED=false turns all of it off.
//
// Everything here is fire-and-forget and never throws into the chat reply.

const env = (name) => String(process.env[name] || '').trim();
const numberEnv = (name, fallback) => {
  const n = Number(env(name));
  return env(name) !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

// 25%: engine/confidence.js puts one solid document match around 0.5 and
// ordinary, correct answers at 0.33-0.50, so a higher cut-off flags good
// answers. Below 0.25 the match is genuinely weak.
const lowConfidenceBelow = () => numberEnv('LOW_CONFIDENCE_ALERT_BELOW', 0.25);
const sessionCooldownMs = () => numberEnv('ALERT_SESSION_COOLDOWN_MIN', 30) * 60 * 1000;
const tenantMaxPerHour = () => numberEnv('ALERT_TENANT_MAX_PER_HOUR', 20);
const alertsEnabled = () => env('TEAM_ALERTS_ENABLED').toLowerCase() !== 'false';
const MAX_RECIPIENTS = 5;
const TRANSCRIPT_LINES = 6;
const LINE_CHARS = 500;
const HOUR_MS = 60 * 60 * 1000;

// Held in lib/sharedStore.js rather than in a Map here, so the throttle is one
// throttle however many API instances are running: with a Map per process, two
// containers meant two cooldowns and twice the hourly cap, and the tenant's
// team got the duplicate emails this is meant to prevent. A restart still
// forgets the throttle, which only means one extra alert.
//
// It also bounds the memory: the per-session cooldown now expires with the
// cooldown itself, where the Map held one entry per conversation for the life
// of the process and never evicted any of them.

/** Peek, deliberately: it must not consume an allowance that may not be used. */
async function underTenantCap(tenantId) {
  return (await store().countWindow(keys.alertTenant(tenantId), HOUR_MS)) < tenantMaxPerHour();
}
function recordSend(tenantId) {
  return store().incrWindow(keys.alertTenant(tenantId), HOUR_MS);
}
async function sessionOnCooldown(tenantId, sessionId) {
  return (await store().get(keys.alertSession(tenantId, sessionId))) !== null;
}
function markSessionAlerted(tenantId, sessionId) {
  return store().set(keys.alertSession(tenantId, sessionId), 1, sessionCooldownMs());
}

/** For tests: clears the whole shared store, throttles included. */
function resetAlertThrottle() {
  return store().reset();
}

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/** @returns {Promise<string[]>} who on the tenant's team gets alerts; may be empty */
async function teamRecipients(tenant) {
  const configured = String(tenant.teamEmail || '').split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(isEmail);
  if (configured.length) return configured.slice(0, MAX_RECIPIENTS);
  if (tenant.signupEmail && isEmail(tenant.signupEmail)) return [tenant.signupEmail.toLowerCase()];
  const users = await prisma.tenantUser.findMany({
    where: { tenantId: tenant.id }, orderBy: { createdAt: 'asc' }, take: MAX_RECIPIENTS, select: { email: true }
  });
  return users.map((u) => u.email).filter(isEmail);
}

/**
 * A comma-separated list of up to 5 addresses, or '' to clear (use the defaults).
 * @returns {{ ok: true, value: string|null } | { ok: false, error: string }}
 */
function parseTeamEmail(raw) {
  const parts = String(raw ?? '').split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return { ok: true, value: null };
  if (parts.length > MAX_RECIPIENTS) return { ok: false, error: `Up to ${MAX_RECIPIENTS} addresses` };
  const bad = parts.find((e) => !isEmail(e) || e.length > 254);
  if (bad) return { ok: false, error: `"${bad}" is not a valid email address` };
  return { ok: true, value: [...new Set(parts)].join(', ') };
}

// ── Email bodies

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BOT_LABEL = { sales: 'Sales', support: 'Support' };
const clip = (s, n = LINE_CHARS) => { const t = String(s || '').trim(); return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t; };

// Opens Leads & Summaries on that view, with the conversation's drawer open when sessionId is given.
function dashboardLink(view, sessionId) {
  const base = env('DASHBOARD_URL').replace(/\/+$/, '');
  if (!base) return null;
  const qs = new URLSearchParams({ ...(view ? { view } : {}), ...(sessionId ? { session: sessionId } : {}) }).toString();
  return `${base}/dashboard/leads${qs ? `?${qs}` : ''}`;
}

// Internal email: a plain, scannable layout. rows: [label, value]; transcript: [{ role, content }];
// summary: the AI conversation summary (plain text, one item per line), when there is one.
function alertEmail({ tenant, subject, heading, intro, rows, transcript, summary, view, sessionId }) {
  const link = dashboardLink(view, sessionId);
  const lines = transcript.map((m) => `${m.role === 'user' ? 'Visitor' : 'Bot'}: ${clip(m.content)}`);
  const text = [
    heading, '', intro, '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(summary ? ['', 'AI summary:', summary] : []),
    ...(lines.length ? ['', 'Latest messages:', ...lines] : []),
    ...(link ? ['', `Open in the dashboard: ${link}`] : []),
    '', `-- KGT AI Hub alert for ${tenant.name}`
  ].join('\n');

  const td = 'padding:4px 0;font-size:14px;line-height:1.5;vertical-align:top;';
  const html = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">
<tr><td style="padding:22px 28px 8px;"><h1 style="margin:0 0 8px;font-size:19px;color:#0f172a;">${escapeHtml(heading)}</h1>
<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#334155;">${escapeHtml(intro)}</p>
<table role="presentation" cellspacing="0" cellpadding="0">${rows.map(([k, v]) =>
    `<tr><td style="${td}color:#64748b;padding-right:14px;white-space:nowrap;">${escapeHtml(k)}</td><td style="${td}color:#0f172a;">${escapeHtml(v)}</td></tr>`).join('')}</table>
</td></tr>
${summary ? `<tr><td style="padding:8px 28px 4px;"><p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#64748b;">AI summary</p>
<p style="margin:0;padding:10px 14px;border-left:3px solid #22d3ee;border-radius:6px;background:#f8fafc;font-size:14px;line-height:1.6;color:#0f172a;">${escapeHtml(summary).replace(/\n/g, '<br>')}</p></td></tr>` : ''}
${lines.length ? `<tr><td style="padding:8px 28px 4px;"><p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#64748b;">Latest messages</p>
${transcript.map((m) => `<p style="margin:0 0 8px;padding:8px 12px;border-radius:8px;font-size:13px;line-height:1.5;white-space:pre-line;${m.role === 'user' ? 'background:#ecfeff;color:#0f172a;' : 'background:#f8fafc;color:#334155;'}"><strong>${m.role === 'user' ? 'Visitor' : 'Bot'}:</strong> ${escapeHtml(clip(m.content))}</p>`).join('')}</td></tr>` : ''}
${link ? `<tr><td style="padding:10px 28px 4px;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:9px 16px;border-radius:8px;background:#0f172a;color:#ffffff;font-size:14px;text-decoration:none;">Open in the dashboard</a></td></tr>` : ''}
<tr><td style="padding:16px 28px 20px;font-size:12px;color:#94a3b8;">KGT AI Hub alert for ${escapeHtml(tenant.name)}. Change who gets these on the Leads &amp; Summaries page.</td></tr>
</table></body></html>`;
  return { subject, text, html };
}

async function recentTranscript(tenantId, sessionId) {
  if (!sessionId) return [];
  const rows = await prisma.chatMessage.findMany({
    where: { sessionId, session: { tenantId } }, orderBy: [{ createdAt: 'desc' }, { role: 'asc' }], take: TRANSCRIPT_LINES,
    select: { role: true, content: true }
  });
  return rows.reverse();
}

async function send({ tenant, kind, mail, replyTo, now }) {
  const to = await teamRecipients(tenant);
  if (!to.length) {
    console.warn(`[alerts] ${kind} NOT sent (tenant ${tenant.slug || tenant.id}): no team email, signup email or dashboard user to send it to`);
    return { sent: false, reason: 'no-recipient' };
  }
  await recordSend(tenant.id);
  const result = await sendMail({ to, ...mail, replyTo, tenantId: tenant.id, label: `${kind}, tenant ${tenant.slug || tenant.id}` });
  if (result.sent) console.log(`[alerts] ${kind} sent via ${result.via} to ${to.map(maskAddress).join(', ')} (tenant ${tenant.slug || tenant.id})`);
  return result;
}

/**
 * A visitor left their email. The alert's Reply-To is the visitor, so the
 * team can answer straight from their inbox. Never throws.
 * @param {{ tenant: object, lead: { id, botType, email, sessionId }, summary?: string|null }} params
 *   summary: the AI conversation summary (services/leads.js waits for it, briefly)
 */
async function notifyLeadCaptured({ tenant, lead, summary = null }) {
  try {
    if (!alertsEnabled()) return { sent: false, reason: 'disabled' };
    const now = Date.now();
    if (!await underTenantCap(tenant.id)) {
      console.warn(`[alerts] lead alert THROTTLED (lead ${lead.id}, tenant ${tenant.slug || tenant.id}): hourly cap reached; the lead is in the dashboard`);
      return { sent: false, reason: 'throttled' };
    }
    const bot = BOT_LABEL[lead.botType] || 'Support';
    const transcript = await recentTranscript(tenant.id, lead.sessionId);
    const mail = alertEmail({
      tenant,
      // The visitor's address stays in the subject, so each lead is its own thread in the inbox.
      subject: `New Lead Captured from ${bot} Bot! ${lead.email}`,
      heading: `New Lead Captured from ${bot} Bot!`,
      intro: `A visitor shared their email with your ${bot} bot. Reply to this email to reach them directly.` +
        (summary ? '' : ' The AI summary of the conversation will be on the Leads & Summaries page shortly.'),
      rows: [['Email', lead.email], ['Bot', bot], ['Time', new Date(now).toUTCString()], ['Session', lead.sessionId || '—']],
      transcript,
      summary,
      view: 'leads'
    });
    return await send({ tenant, kind: 'lead alert', mail, replyTo: lead.email, now });
  } catch (err) {
    console.error(`[alerts] ERROR: lead alert FAILED (lead ${lead.id}, tenant ${tenant.id}): ${err.stack || err.message}`);
    return { sent: false, reason: 'exception' };
  }
}

/**
 * Whether a turn needs a person's attention: a handoff, or a reply whose
 * confidence is known and below LOW_CONFIDENCE_ALERT_BELOW. Off-topic
 * redirects ("what's the capital of France?") and the turn that captured an
 * email are not.
 */
function needsAttention(result) {
  if (!result || result.offTopic || result.contactCaptured) return null;
  if (result.handoff) return 'handoff';
  const c = result.confidence;
  if (typeof c === 'number' && c < lowConfidenceBelow()) return 'low_confidence';
  return null;
}

/**
 * Called after every chat turn; sends an alert only when needsAttention() says
 * so and the throttle allows. Never throws.
 * @param {{ tenant: object, botType: string, sessionId: string, query: string, result: object }} params
 */
async function notifyIfNeedsAttention({ tenant, botType, sessionId, query, result }) {
  try {
    const reason = needsAttention(result);
    if (!reason || !alertsEnabled()) return { sent: false, reason: reason ? 'disabled' : 'not-needed' };
    const now = Date.now();
    if (await sessionOnCooldown(tenant.id, sessionId)) return { sent: false, reason: 'session-cooldown' };
    if (!await underTenantCap(tenant.id)) {
      console.warn(`[alerts] needs-attention alert THROTTLED (session ${sessionId}, tenant ${tenant.slug || tenant.id}): hourly cap reached`);
      return { sent: false, reason: 'throttled' };
    }
    await markSessionAlerted(tenant.id, sessionId);

    const bot = BOT_LABEL[botType] || 'Support';
    const pct = typeof result.confidence === 'number' ? `${Math.round(result.confidence * 100)}%` : 'n/a';
    const handoff = reason === 'handoff';
    const mail = alertEmail({
      tenant,
      subject: handoff ? `${bot} bot handed a visitor to your team` : `${bot} bot gave a low-confidence answer (${pct})`,
      heading: handoff ? 'A visitor needs a person' : 'An answer may need checking',
      intro: handoff
        ? `Your ${bot} bot couldn't help with this and offered a follow-up from your team. It's also filed as a ticket.`
        : `Your ${bot} bot answered with ${pct} matching confidence. The visitor may not have got what they needed.`,
      rows: [['Question', clip(query, 300)], ['Bot', bot], ['Confidence', pct], ['Session', sessionId], ['Time', new Date(now).toUTCString()]],
      transcript: await recentTranscript(tenant.id, sessionId),
      view: handoff ? 'sessions' : 'improvements',
      sessionId
    });
    return await send({ tenant, kind: handoff ? 'handoff alert' : 'low-confidence alert', mail, now });
  } catch (err) {
    console.error(`[alerts] ERROR: needs-attention alert FAILED (session ${sessionId}, tenant ${tenant.id}): ${err.stack || err.message}`);
    return { sent: false, reason: 'exception' };
  }
}

module.exports = {
  notifyLeadCaptured,
  notifyIfNeedsAttention,
  needsAttention,
  teamRecipients,
  parseTeamEmail,
  resetAlertThrottle,
  lowConfidenceBelow
};
