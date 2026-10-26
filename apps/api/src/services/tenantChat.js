const prisma = require('../lib/prisma');
const { getEngineAnswer } = require('../engine/chatEngine');
const llmClient = require('../engine/llmClient'); // called through the module so a test's mock is used
const { resolveLanguage, normalizeLanguage, translationSystemPrompt } = require('../engine/language');
const { createTenantSupportProfile, createTenantSalesProfile } = require('../domains/tenantProfile');
const { createIpRateLimiter } = require('../utils/ipRateLimit');
const { pickFollowUps } = require('./followUps');
const { trackLeadActivity } = require('./leads');
const { recordTurn } = require('./chatSessions');
const { notifyIfNeedsAttention } = require('./teamAlerts');
const { extractStatedEmail } = require('../domains/handoffActions');

// One chat turn for one tenant. Shared by every way a tenant's bots are
// reached — the embed widget (API key), the client dashboard (client JWT)
// and the staff console (operator JWT) — so all three get the same
// validation, rate limit, session scoping and engine. The caller has
// already authenticated and resolved `tenant`; everything below is scoped
// by tenant.id and never reads another tenant's rows.

const BOT_PROFILE_FACTORIES = { support: createTenantSupportProfile, sales: createTenantSalesProfile };
const MAX_QUERY_LEN = 1000;
// A bot answer can be several paragraphs, so the text sent to /translate is
// allowed to be longer than a visitor's query.
const MAX_TRANSLATE_LEN = 4000;

// Per tenant, not per IP: bounds each tenant's LLM spend however many
// visitors its widget has. The limiter keys by any string.
//
// This is abuse protection, not a capacity limit, and the default is sized
// that way: 30 per 10 minutes is 3 messages a minute for an ENTIRE company's
// website, shared by every visitor at once — and the dashboard's own test
// chat draws from the same bucket, so a tenant trying their bots could lock
// their visitors out. Retrieval costs well under a millisecond per turn
// (scripts/bench-retrieval.js), so the ceiling here is the LLM bill, not the
// server. Lower it per deployment if a provider quota needs protecting.
const isTenantRateLimited = createIpRateLimiter({ name: 'tenant-chat',
  max: Number(process.env.TENANT_CHAT_RATE_LIMIT_MAX || 300),
  windowMs: Number(process.env.TENANT_CHAT_RATE_LIMIT_WINDOW_MIN || 10) * 60 * 1000
});

const BOT_TYPES = Object.keys(BOT_PROFILE_FACTORIES);

/**
 * Which bot a request is for. Accepts botType, or bot (the widget's
 * data-bot attribute name), case-insensitively; omitted means support.
 * An unrecognised value is an error rather than a silent fallback, so a
 * pricing page with a typo in its snippet doesn't quietly get the support persona.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function parseBotType(body) {
  const raw = body?.botType ?? body?.bot;
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 'support' };
  const value = String(raw).trim().toLowerCase();
  return BOT_TYPES.includes(value)
    ? { ok: true, value }
    : { ok: false, error: `botType must be one of: ${BOT_TYPES.join(', ')}` };
}

class ChatRequestError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * @param {{ tenant: object, body: object, sandbox?: boolean }} args  body: { query, botType? (or bot), sessionId?, externalUserId? }
 *   sandbox: the dashboard's test chat (client or staff), not a website visitor
 * @returns {Promise<object>} the bot's result (without its confidence score) plus followUps
 *   (0-3 suggested next questions), sessionId and the botType that answered
 * @throws {ChatRequestError} for invalid input (400) or rate limiting (429)
 */
async function runTenantChat({ tenant, body, sandbox = false }) {
  const query = String(body?.query || '').trim();
  if (!query) throw new ChatRequestError('query is required', 400);
  if (query.length > MAX_QUERY_LEN) throw new ChatRequestError(`query must be ${MAX_QUERY_LEN} characters or fewer`, 400);

  // Same tenant, same knowledge base, different persona/gating per bot —
  // see domains/tenantProfile.js. Defaults to support.
  const bot = parseBotType(body);
  if (!bot.ok) throw new ChatRequestError(bot.error, 400);
  const botType = bot.value;

  // Which language the bot must answer in. The message itself decides — a
  // Hindi question gets a Hindi answer, an English one an English answer —
  // and the widget's selected language (body.language) is only a fallback for
  // a message too short to tell (engine/language.js). Echoed back in the
  // response so the widget knows which language this turn came out in.
  const language = resolveLanguage(body?.language, query);

  if (await isTenantRateLimited(tenant.id)) {
    throw new ChatRequestError('Too many chat requests. Please wait a few minutes and try again.', 429);
  }

  // A sessionId from another tenant simply isn't found, and a new session starts.
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : null;
  let session = sessionId
    ? await prisma.chatSession.findFirst({ where: { id: sessionId, tenantId: tenant.id } })
    : null;
  if (!session) {
    const externalUserId = typeof body?.externalUserId === 'string' ? body.externalUserId.slice(0, 200) : null;
    session = await prisma.chatSession.create({ data: { tenantId: tenant.id, externalUserId } });
  }

  const recentTurns = await prisma.chatMessage.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
    take: 6
  });

  const result = await getEngineAnswer({
    profile: BOT_PROFILE_FACTORIES[botType](tenant),
    query,
    ctx: {
      tenantId: tenant.id,
      sessionId: session.id, // tickets and an email left later are tied to this conversation
      recentTurns: recentTurns.reverse().map((m) => ({ role: m.role, content: m.content })),
      language // pins the reply language (engine/promptBuilder.js)
    }
  });

  // Earlier questions in this conversation (so chips don't repeat them) and
  // this bot's FAQs, read before this turn's messages are written.
  const [askedRows, faqRow] = await Promise.all([
    prisma.chatMessage.findMany({
      where: { sessionId: session.id, role: 'user' }, orderBy: { createdAt: 'desc' }, take: 50, select: { content: true }
    }),
    prisma.tenantFaq.findUnique({ where: { tenantId: tenant.id }, select: { supportFaqs: true, salesFaqs: true } })
  ]);

  // The confidence score is stored here (and on tickets) for staff and
  // tenant review, never sent to the chat client; neither is the email just
  // captured, which goes to the lead record, nor the answered flag.
  // offTopic only steers the team alert below.
  const { confidence, contactEmail, answered, offTopic, ...reply } = result;
  await prisma.chatMessage.createMany({
    data: [
      { sessionId: session.id, role: 'user', content: query, botType },
      { sessionId: session.id, role: 'assistant', content: reply.answer, confidence: confidence ?? null, botType, answered: !!answered }
    ]
  });
  // After the messages are written, so the lead's transcript and the alert include this turn.
  await recordTurn({ session, botType });
  // Team alerts are for real visitors, not the team testing its own bots.
  const alertTeam = !sandbox;
  // The email the handoff action took, or one stated in a message that went
  // to the knowledge base ("my email is ana@x.com — what's the price for 40
  // seats?"): the question is answered and the lead saved either way.
  const leadEmail = reply.contactCaptured ? contactEmail : extractStatedEmail(query);
  await trackLeadActivity({ tenant, botType, sessionId: session.id, contactEmail: leadEmail, alertTeam });
  // A handoff or an answer below 25% confidence: tell the team now (throttled; not awaited).
  if (alertTeam) notifyIfNeedsAttention({ tenant, botType, sessionId: session.id, query, result });

  // No suggested questions while the bot is waiting for an email: the reply
  // just asked for one, and chips would pull the visitor away from answering.
  const followUps = reply.awaitingContact ? [] : pickFollowUps({
    botType,
    faqs: faqRow?.[botType === 'sales' ? 'salesFaqs' : 'supportFaqs'] || [],
    asked: askedRows.map((m) => m.content),
    query,
    answer: reply.answer
  });
  return { ...reply, followUps, sessionId: session.id, botType, language };
}

/**
 * Translate one already-written message into English or Hindi, for the
 * per-message "Translate" button in the widget. Deliberately stateless: it
 * runs no retrieval, loads no persona, writes no ChatMessage and touches no
 * session — so translating a reply never disturbs the ongoing conversation.
 * Shares the chat rate limiter so it can't be used to bypass the LLM budget.
 * @param {{ tenant: object, body: object }} args  body: { text, target: "en" | "hi" }
 * @returns {Promise<{ text: string, target: string }>}
 * @throws {ChatRequestError} invalid input (400), rate limiting (429) or LLM unavailable (503)
 */
async function runTranslate({ tenant, body }) {
  const text = String(body?.text || '').trim();
  if (!text) throw new ChatRequestError('text is required', 400);
  if (text.length > MAX_TRANSLATE_LEN) {
    throw new ChatRequestError(`text must be ${MAX_TRANSLATE_LEN} characters or fewer`, 400);
  }
  const target = normalizeLanguage(body?.target);
  if (!target) throw new ChatRequestError('target must be one of: en, hi', 400);

  if (await isTenantRateLimited(tenant.id)) {
    throw new ChatRequestError('Too many requests. Please wait a few minutes and try again.', 429);
  }

  try {
    const answer = await llmClient.generateAnswer({ systemPrompt: translationSystemPrompt(target), userPrompt: text });
    return { text: answer.text.trim(), target };
  } catch (err) {
    // Same provider-chain failures the chat engine degrades on — surface a
    // polite, retryable message rather than a raw upstream error.
    throw new ChatRequestError('Translation is unavailable right now. Please try again in a few minutes.', 503);
  }
}

// Express helper: run a turn and map input errors to their status codes.
async function handleChat(req, res, next) {
  try {
    // req.actor is set only behind the dashboard's gatekeepers; the widget route has none.
    res.json(await runTenantChat({ tenant: req.tenant, body: req.body, sandbox: !!req.actor }));
  } catch (err) {
    if (err instanceof ChatRequestError) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
}

// Express helper: translate one message, mapping input errors to status codes.
async function handleTranslate(req, res, next) {
  try {
    res.json(await runTranslate({ tenant: req.tenant, body: req.body }));
  } catch (err) {
    if (err instanceof ChatRequestError) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
}

module.exports = {
  runTenantChat,
  handleChat,
  runTranslate,
  handleTranslate,
  parseBotType,
  ChatRequestError,
  MAX_QUERY_LEN,
  MAX_TRANSLATE_LEN,
  BOT_TYPES
};
