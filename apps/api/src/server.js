const app = require('./app');
const { assertProdSafety, ProdSafetyError } = require('./utils/assertProdSafety');
const { describeLlmConfig, verifyLlmModels } = require('./engine/llmClient');
const { verifyMailer, mailFrom } = require('./services/mailer');
const { confirmationCooldownMs } = require('./services/leads');
const { startSessionSummaryWorker } = require('./services/chatSessions');
const { describeSharedStore } = require('./lib/sharedStore');

// A config problem gets a readable list of what to fix, not a stack trace.
try {
  assertProdSafety();
} catch (err) {
  if (!(err instanceof ProdSafetyError)) throw err;
  console.error(`[startup] FATAL: ${err.message}`);
  process.exit(1);
}

// Which shared-store driver is in use, and what that means. The failure this
// guards against is silent: run several API containers with the in-process
// driver and every rate limit is N times looser, a document edited on one
// container never invalidates the others' caches, and two of them pay for the
// same background audit. None of it errors — it just quietly misbehaves.
const sharedStore = describeSharedStore();
if (sharedStore.driver === 'memory') {
  console.log(
    '[sharedStore] in-process driver: rate limits, knowledge invalidation, alert throttles and job locks ' +
    'are local to THIS process. Correct for a single API container; if you run more than one, set ' +
    'SHARED_STORE=redis and REDIS_URL or they will not agree with each other.'
  );
} else {
  console.log(`[sharedStore] shared via ${sharedStore.driver} — safe to run several API containers`);
}

// Not fatal (the rest of the API works without an LLM), but loud: with no
// working provider, every chat answer is a "try again later" fallback.
const llm = describeLlmConfig();
if (!llm.configured.length) {
  console.warn(
    `[llm] WARNING: no API key set for any provider in the chain (${llm.chain.join(' -> ')}). ` +
    `Set ${llm.missingKeys.join(' / ')} — the bots can't answer until then.`
  );
} else if (llm.missingKeys.length) {
  console.warn(`[llm] chain ${llm.chain.join(' -> ')}: no key for ${llm.missingKeys.join(', ')} (skipped at request time)`);
}

// Catch a retired or inaccessible model at boot rather than on the first chat.
verifyLlmModels().then((results) => {
  for (const r of results) {
    if (r.status === 'ok') console.log(`[llm] ${r.provider}: model "${r.model}" is available`);
    else if (r.status === 'missing') {
      console.warn(
        `[llm] WARNING: ${r.provider} model "${r.model}" is not available for this key — chats will skip ${r.provider}. ` +
        `Set ${r.provider.toUpperCase()}_MODEL to one of: ${r.suggestions.join(', ') || '(none listed)'}`
      );
    } else console.warn(`[llm] could not verify ${r.provider} model "${r.model}": ${r.reason}`);
  }
});

// Same idea for email: a wrong SMTP password otherwise only shows up as
// visitors quietly not getting mail.
verifyMailer().then((m) => {
  if (!m.transport) {
    const log = m.production ? console.error : console.warn;
    log(`[mailer] ${m.production ? 'ERROR' : 'WARNING'}: no mail transport configured — ` +
      `${m.production ? 'every email (lead confirmations, password resets) will FAIL' : 'emails are printed to this log, not sent'}\n` +
      `[mailer]   fix: ${m.hint}`);
  } else if (m.ok === false) {
    console.error(`[mailer] ERROR: SMTP check failed (${m.reason}): ${m.error} — emails will fail until this is fixed\n[mailer]   fix: ${m.hint}`);
  } else {
    console.log(`[mailer] sending via ${m.transport}${m.ok ? ' (SMTP login OK)' : ''} as ${mailFrom()}`);
  }
  if (m.production && confirmationCooldownMs() === 0) {
    console.warn('[leads] WARNING: LEAD_CONFIRMATION_COOLDOWN_HOURS=0 in production — every email typed into a chat gets a ' +
      'confirmation, with no anti-spam limit. Remove it once testing is done.');
  }
});

// Last-resort net: wrapRouterAsync (app.js) already forwards every route
// handler's rejections into Express's own error middleware, so this should
// only ever catch something outside the request/response cycle (e.g. a
// fire-and-forget promise). Without it, Node terminates the whole process on
// an uncaught rejection.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

// CORS is configured in app.js via utils/corsPolicy.js (per-path: open for the
// widget, web-app-origins-only for the dashboard, with preflight handled
// there). It is NOT set up here: app.js has already mounted every route, the
// /api JSON 404 and the error handler by the time this file runs, so any
// app.use() added now sits after them and never runs. Change the allowlist in
// corsPolicy.js (and CORS_ORIGINS), not here.

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`KGT AI Hub API running at http://localhost:${port}`);
  // Summarizes idle conversations for the Sessions view (services/chatSessions.js).
  // Here, not in app.js, so tests that load the app don't start it.
  startSessionSummaryWorker();
});