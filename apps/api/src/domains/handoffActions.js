const prisma = require('../lib/prisma');
const { registerAction } = require('../engine/actionRegistry');
const { fileSupportTicket, attachContact } = require('../engine/ticketing');

// Conversational handoffs for both tenant bots, answered before retrieval
// (engine/actionRegistry.js) so they never fall into a "can't find that"
// reply: a request for a person or a demo is an intent to act on, not a
// question for the knowledge base.
//
//   handoff.contact  the visitor leaves an email (after a bot reply): attach
//                    it to this conversation's open ticket, or open one
//   handoff.human    "can I talk to someone?": file a ticket, ask for an email
//   handoff.demo     "can I book a demo?": same, as a demo request
//
// Matching is deliberately narrow. These run before the knowledge base, so a
// false positive would hide a real answer — "how do residents chat with the
// society manager?" is a feature question, not a request for a person.
// Wording comes from the profile (profile.handoffCopy), so each bot keeps
// its own voice.

const MAX_MESSAGE_LEN = 200; // anything longer is a question, not a handoff request
const MAX_EMAIL_LEN = 254;
const EMAIL = '[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\\.[A-Z0-9-]+)*\\.[A-Z]{2,}';

// A message that is just an email address, with at most a short lead-in or
// sign-off ("sure, it's ana@x.com", "my email is ana@x.com thanks"). An
// email inside a real question ("ana@x.com isn't getting the code") is not a
// contact handoff and goes to the knowledge base as usual.
const LEAD_IN = "(?:(?:sure|yes|yeah|yep|ok(?:ay)?|great|perfect|thanks|thank you|here(?:'s| is| you go)?|"
  + "(?:my|our) (?:work |business )?e-?mail(?: address)? is|e-?mail(?: address)?|it'?s|"
  + "(?:you can )?(?:reach|contact|email) (?:me|us) (?:at|on))[\\s,:!.-]*)*";
const BARE_EMAIL = new RegExp(`^\\s*${LEAD_IN}(${EMAIL})[\\s.!]*(?:(?:thanks|thank you|cheers)[\\s.!]*)?$`, 'i');
const ANY_EMAIL = new RegExp(EMAIL, 'gi');
// The visitor says the address is theirs to be contacted on, whatever the
// wording around it ("it is my email- ana@x.com", "reach me at ana@x.com
// for a quote"). Without one of these, an email inside a sentence is more
// likely the subject of a question ("ana@x.com isn't getting the code",
// "my email ana@x.com isn't getting the OTP" — hence "my email" only with
// "is", ":" or "-" after it).
const CONTACT_INTENT = new RegExp('\\b(?:'
  + '(?:my|our)\\s+(?:work\\s+|business\\s+|personal\\s+)?e-?mail(?:\\s+(?:address|id))?\\s*(?:is\\b|[:=\\-\u2013\u2014])'
  + '|(?:it|this|that)\\s+is\\s+my\\s+e-?mail|here(?:\'s|\\s+is)\\s+my\\s+e-?mail'
  + '|e-?mail\\s+(?:me|us)\\b|(?:reach|contact|ping)\\s+(?:me|us)\\b|get\\s+back\\s+to\\s+(?:me|us)\\b|i\\s+can\\s+be\\s+reached\\b'
  + ')', 'i');

const HUMAN_PATTERNS = [
  // talk / speak / chat / connect + to/with + a person
  /\b(?:talk|speak|chat|connect(?: me)?|get in touch)\s+(?:to|with)\s+(?:a\s+|an\s+|your\s+|the\s+)?(?:real\s+|actual\s+|live\s+)?(?:human|person|agent|representative|rep|someone|somebody|support team|customer (?:support|service)|sales(?: team)?|your team|team member)\b/i,
  /\b(?:human|live|real)\s+(?:agent|person|support|being|representative)\b/i,
  /\b(?:call me(?: back)?|(?:request|need|want|get)\s+a\s+call\s*back)\b/i,
  /^\s*(?:human|agent|representative|operator|real person|live agent|talk to (?:a )?human)\s*[.!?]*\s*$/i
];

const DEMO_PATTERNS = [
  /\b(?:demo|demonstration|walk-?through|product tour)\b/i,
  /\b(?:book|schedule|set up|arrange)\s+(?:a\s+|an\s+)?(?:quick\s+|short\s+)?(?:call|meeting|consultation|sales call)\b/i
];

// A short yes / no to the bot's offer of a follow-up ("Would you like me to
// drop a quick note for our team?").
const YES = /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please|please do|yes please|sure thing|that would be (?:great|helpful|nice)|sounds good|go ahead|absolutely|of course|definitely)(?:[\s,!.]+(?:please|thanks|thank you))?[\s!.]*$/i;
const NO = /^\s*(?:no|nope|nah|no thanks|no thank you|not now|not right now|maybe later|i'?m good|all good|it'?s fine|that'?s ok(?:ay)?)[\s,!.]*(?:thanks|thank you)?[\s!.]*$/i;
// The bot's last reply offered a follow-up, so a bare "yes" answers it.
const OFFERED_FOLLOW_UP = /\b(?:e-?mail|note for (?:our|the) team|follow up|reach out)\b/i;

const isShort = (query) => String(query || '').length <= MAX_MESSAGE_LEN;
const lastBotTurn = (ctx) => [...(ctx.recentTurns || [])].reverse().find((t) => t.role === 'assistant')?.content || '';
const offerPending = (ctx) => OFFERED_FOLLOW_UP.test(lastBotTurn(ctx));
const hadBotTurn = (ctx) => (ctx.recentTurns || []).some((t) => t.role === 'assistant');
const lastUserTurn = (ctx) => [...(ctx.recentTurns || [])].reverse().find((t) => t.role === 'user')?.content;

function extractBareEmail(query) {
  if (!isShort(query)) return null;
  const m = BARE_EMAIL.exec(query);
  const email = m && m[1].toLowerCase();
  return email && email.length <= MAX_EMAIL_LEN ? email : null;
}

// The one email address in a message, or null for none or several (ambiguous).
function singleEmail(query) {
  const found = [...new Set((String(query || '').match(ANY_EMAIL) || []).map((e) => e.toLowerCase()))];
  return found.length === 1 && found[0].length <= MAX_EMAIL_LEN ? found[0] : null;
}

/**
 * An email the visitor left for the team to contact them on, in any wording,
 * when that is all the message does: a bare email, or a short message with
 * one email and no question when the bot just asked for one or the visitor
 * says it's theirs. A question that also carries an email goes to the
 * knowledge base; services/tenantChat.js saves the lead alongside the answer
 * (extractStatedEmail).
 */
function extractContactEmail(query, ctx = {}) {
  // A bare email as the very first message is more likely a question about that address.
  const bare = hadBotTurn(ctx) && extractBareEmail(query);
  if (bare) return bare;
  if (!isShort(query) || query.includes('?')) return null;
  const email = singleEmail(query);
  return email && (offerPending(ctx) || CONTACT_INTENT.test(query)) ? email : null;
}

/** An email the visitor says is theirs to be contacted on, anywhere in a message of any length (null otherwise). */
function extractStatedEmail(query) {
  return CONTACT_INTENT.test(String(query || '')) ? singleEmail(query) : null;
}

const isHumanRequest = (query) => isShort(query) && HUMAN_PATTERNS.some((re) => re.test(query));
const isDemoRequest = (query) => isShort(query) && DEMO_PATTERNS.some((re) => re.test(query));

// An email this visitor already left in this conversation, so they're not asked twice.
async function knownContact(ctx) {
  if (!ctx.tenantId || !ctx.sessionId) return null;
  const ticket = await prisma.supportTicket.findFirst({
    where: { tenantId: ctx.tenantId, sessionId: ctx.sessionId, contactEmail: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { contactEmail: true }
  });
  return ticket?.contactEmail || null;
}

// A request for a person or a demo: always a ticket, then ask for an email
// unless this conversation already has one.
async function handleRequest(kind, query, ctx, profile) {
  const copy = profile.handoffCopy(ctx.language); // in the UI-selected language
  const email = await knownContact(ctx);
  if (profile.ticketing) await fileSupportTicket({ profile, query, ctx, kind, contactEmail: email });
  if (email) return { answer: copy.passedOn(email), handoff: true };
  return { answer: kind === 'demo_request' ? copy.demo : copy.human, handoff: true, awaitingContact: true };
}

registerAction('handoff.contact', {
  match: (query, ctx) => !!extractContactEmail(query, ctx),
  run: async (query, ctx, profile) => {
    const email = extractContactEmail(query, ctx);
    const attached = await attachContact({ ctx, contactEmail: email });
    if (!attached && profile.ticketing) {
      // No open ticket yet (e.g. after a "could you tell me more?" reply):
      // open one for the question that prompted it.
      await fileSupportTicket({
        profile, ctx, kind: 'contact_request', contactEmail: email,
        query: lastUserTurn(ctx) || 'Left an email in the chat'
      });
    }
    // contactEmail: for the lead record (services/leads.js); never sent to the chat client.
    return { answer: profile.handoffCopy(ctx.language).thanks(email), handoff: true, contactCaptured: true, contactEmail: email };
  }
});

// "Yes" to a follow-up offer: ask for the email (an email reply is then
// handoff.contact). "No": a gracious reply that leaves the door open.
registerAction('handoff.reply', {
  match: (query, ctx) => isShort(query) && offerPending(ctx) && (YES.test(query) || NO.test(query)),
  run: async (query, ctx, profile) => {
    const copy = profile.handoffCopy(ctx.language); // in the UI-selected language
    if (NO.test(query)) return { answer: copy.declined };
    const email = await knownContact(ctx);
    if (email) return { answer: copy.passedOn(email), handoff: true };
    return { answer: copy.askEmail, awaitingContact: true };
  }
});

registerAction('handoff.human', {
  match: (query) => isHumanRequest(query),
  run: (query, ctx, profile) => handleRequest('human_request', query, ctx, profile)
});

registerAction('handoff.demo', {
  match: (query) => isDemoRequest(query),
  run: (query, ctx, profile) => handleRequest('demo_request', query, ctx, profile)
});

// Order matters: an email reply first, then a yes/no to an offer (so "ok"
// after an offer is a yes, not small talk), then greetings and thanks
// (domains/smallTalk.js), then a request for a person (more specific than
// "demo": "can I talk to someone about a demo?" is a person).
require('./smallTalk'); // registers 'smalltalk'
const HANDOFF_ACTIONS = ['handoff.contact', 'handoff.reply', 'smalltalk', 'handoff.human', 'handoff.demo'];

module.exports = { HANDOFF_ACTIONS, extractBareEmail, extractContactEmail, extractStatedEmail, isHumanRequest, isDemoRequest };
