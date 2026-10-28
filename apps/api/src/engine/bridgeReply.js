const llmClient = require('./llmClient'); // called through the module, so a test's mock is always used
const { logUsage } = require('./usageTracking');

// The reply when the knowledge base can't answer: instead of one fixed
// sentence for every question, a short note that shows the bot understood
// what the person is trying to do, says what it's there for, and offers a
// follow-up from the team. Opt-in per profile (profile.bridgeSystemPrompt).
//
// The model gets NO excerpts here, so it has nothing to ground an answer
// in — the prompt forbids answering, and acceptBridge() enforces it: a reply
// with any number, link, list or step, the no-answer sentinel, or no offer
// of a follow-up is discarded, and the profile's fixed message is used
// instead. Any LLM failure falls back the same way. Better a plain fallback
// than a warm-sounding invented fact.

const MIN_LEN = 40;
const MAX_LEN = 480;
const MAX_SENTENCES = 4;
// English offer phrases, plus the Hindi equivalents a Hindi bridge reply uses
// (team / email / contact / note) — Devanagari has no \b word boundary, so
// those are matched directly. Without the Hindi side, a valid Hindi follow-up
// offer would be rejected and the fixed fallback shown instead.
const OFFERS_FOLLOW_UP = /\b(?:our team|the team|a note|e-?mail|follow up|reach out|get in touch)\b|(?:टीम|ईमेल|संपर्क|नोट)/i;
const LOOKS_LIKE_AN_ANSWER = /\d|https?:|www\.|@|^\s*(?:[-*•]|step\b)|\bstep \w+:/im;
// The bridge prompts ask the model to start a reply to an off-topic message
// ("what's the capital of France?") with this: such a reply redirects kindly
// instead of offering a follow-up, and the engine files no ticket for it.
const OFF_TOPIC_MARKER = 'OFF_TOPIC:';

/**
 * @param {string} text the model's reply
 * @param {{ sentinel?: string, query?: string }} opts query: the visitor's message — numbers it
 *   contains may be echoed back ("for a 200-flat society"), any other number may not
 * @returns {{ text: string, offTopic: boolean } | null} the reply if it's safe to send, else null
 */
function acceptBridge(text, { sentinel, query = '' } = {}) {
  let reply = String(text || '').trim();
  const offTopic = reply.startsWith(OFF_TOPIC_MARKER);
  if (offTopic) reply = reply.slice(OFF_TOPIC_MARKER.length).trim();
  if (reply.length < MIN_LEN || reply.length > MAX_LEN) return null;
  if (sentinel && reply.includes(sentinel)) return null;
  const echoed = new Set(String(query).match(/\d+/g) || []);
  if (LOOKS_LIKE_AN_ANSWER.test(reply.replace(/\d+/g, (n) => (echoed.has(n) ? '' : n)))) return null;
  if ((reply.match(/[.!?](\s|$)/g) || []).length > MAX_SENTENCES) return null;
  if (!offTopic && !OFFERS_FOLLOW_UP.test(reply)) return null;
  return { text: reply, offTopic };
}

/**
 * @returns {Promise<{ text: string, offTopic: boolean } | null>} a reply to use, or null for the
 *   profile's fixed fallback
 */
async function composeBridgeReply({ profile, query, ctx }) {
  if (!profile.bridgeSystemPrompt) return null;
  try {
    const answer = await llmClient.generateAnswer({
      systemPrompt: profile.bridgeSystemPrompt(ctx),
      userPrompt: `${profile.queryLabel || 'MESSAGE'}:\n${query}`
    });
    if (profile.usageTracking) {
      await logUsage({ ctx, provider: answer.provider, model: answer.model, usage: answer.usage, botType: profile.botType });
    }
    return acceptBridge(answer.text, { sentinel: profile.noAnswerSentinel, query });
  } catch {
    return null; // LLM down or misconfigured: the fixed fallback is fine here
  }
}

module.exports = { composeBridgeReply, acceptBridge, OFF_TOPIC_MARKER };
