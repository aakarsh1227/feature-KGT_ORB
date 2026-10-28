// The one core chat controller every tenant's Support and Sales bot runs
// through. It knows nothing
// about pricing objections, return policies, or a specific tenant's
// business — everything domain-specific arrives via the DomainProfile
// passed in (see domainProfile.js) and the action registry.
//
// Confidence gating, HITL ticketing, and usage tracking (engine/confidence.js,
// ticketing.js, usageTracking.js) are opt-in per profile — a profile that
// doesn't set minConfidence/ticketing/usageTracking behaves exactly as
// before. The tenant profiles (domains/tenantProfile.js) opt in to all three.

const { loadKnowledgeBase } = require('./knowledgeLoader');
const { retrieve } = require('./retriever');
const { translateQueryForRetrieval } = require('./queryTranslation');
const { buildSystemPrompt, buildUserPrompt, parseCitedExcerpt, normalizeChatText } = require('./promptBuilder');
const { tryActions } = require('./actionRegistry');
const { computeConfidence } = require('./confidence');
const { fileSupportTicket } = require('./ticketing');
const { logUsage, logCacheHit } = require('./usageTracking');
const { answerCache } = require('./answerCache');
const { composeBridgeReply } = require('./bridgeReply');
const {
  generateAnswer,
  formatAttempts,
  ChatConfigError,
  ChatRateLimitError,
  ChatUpstreamError
} = require('./llmClient');

// Handoff threshold for profiles that set neither handoffBelow nor minConfidence.
const DEFAULT_HANDOFF_BELOW = 0.3;
const RESULT_FLAGS = ['handoff', 'awaitingContact', 'contactCaptured'];

/**
 * @param {{ profile: import('./domainProfile').DomainProfile, query: string, ctx?: object }} params
 * @returns {Promise<object>} whatever shape profile.format*() returns — the
 *   engine doesn't dictate the response contract, each domain does.
 */
async function getEngineAnswer({ profile, query, ctx = {} }) {
  // 1. Domain actions get first refusal — a live data lookup or side effect
  //    that can answer directly, no RAG/LLM involved.
  const actionResult = await tryActions(profile, query, ctx);
  if (actionResult) {
    const result = profile.formatSuccess(actionResult.answer, [], { ...ctx, actionId: actionResult.actionId });
    // Conversation-state flags an action can set (domains/handoffActions.js):
    // handoff (a person will follow up), awaitingContact (the reply asks for
    // an email), contactCaptured (one was just left).
    for (const flag of RESULT_FLAGS) if (actionResult[flag]) result[flag] = true;
    // The email itself, alongside contactCaptured, for the caller to record as a lead.
    if (actionResult.contactCaptured && actionResult.contactEmail) result.contactEmail = actionResult.contactEmail;
    await profile.onResult?.(result, query, ctx);
    return result;
  }

  // Taken BEFORE the knowledge is read: if a document changes while this
  // request is in flight, the answer below may come from the old documents,
  // and answerCache.set() must refuse it. (The generation returned by
  // answerCache.get() further down is too late — it would already be the
  // post-change one.)
  const cacheable = !!(profile.answerCache && profile.botType && ctx.tenantId);
  const knowledgeGeneration = cacheable ? await answerCache.generation(ctx.tenantId) : null;

  // 2. Retrieval, scoped to this domain's own knowledge base. A profile
  //    supplies either a static knowledgeBasePath (a directory of .md
  //    files) or a resolveKnowledge(ctx) function (DB-backed, per-tenant
  //    documents) — the engine doesn't care which.
  const allChunks = profile.resolveKnowledge
    ? await profile.resolveKnowledge(ctx)
    : loadKnowledgeBase(profile.knowledgeBasePath);
  const chunks = profile.filterChunks ? profile.filterChunks(allChunks, ctx) : allChunks;
  // Cross-lingual retrieval: a Hindi (Devanagari) question is translated to
  // English for the lexical layer, which only knows the English documents
  // (engine/queryTranslation.js). The prompt below still gets the original
  // `query`, so the model answers the real question in the selected language.
  // A no-op for English/romanized queries and if translation is unavailable.
  const retrievalQuery = await translateQueryForRetrieval(query);
  const ranked = retrieve(retrievalQuery, chunks, {
    topK: profile.topK,
    minScore: profile.minScore,
    boostTags: profile.boostTags?.(ctx, retrievalQuery),
    chunkWeight: profile.chunkWeight ? (chunk) => profile.chunkWeight(chunk, ctx, retrievalQuery) : undefined,
    relativeMinScore: profile.relativeMinScore
  });

  // Normalized 0-1 confidence, independent of the raw lexical score above —
  // only enforced as a gate for profiles that set minConfidence, so
  // existing behavior (gate on "zero relevant chunks") is unchanged for
  // profiles that don't opt in. Computed from the best UNWEIGHTED score:
  // chunkWeight decides which excerpts the model sees first, but must never
  // be able to lift a weak match over the anti-hallucination gate (or sink
  // a strong one under it).
  const topRawScore = ranked.length ? Math.max(...ranked.map((r) => r.rawScore ?? r.score)) : 0;
  const confidence = ranked.length ? computeConfidence(retrievalQuery, topRawScore) : 0;
  // At or above the threshold is a pass: 0.30 exactly goes to the model.
  const gateFailed = !ranked.length || (profile.minConfidence != null && confidence < profile.minConfidence);
  // A handoff (fallback reply + ticket) happens only below this threshold.
  const handoffBelow = profile.handoffBelow ?? profile.minConfidence ?? DEFAULT_HANDOFF_BELOW;
  const lowConfidence = confidence < handoffBelow;

  if (gateFailed) {
    const result = profile.formatFallback(ctx, confidence);
    const bridge = await composeBridgeReply({ profile, query, ctx }); // contextual, or null for the fixed message
    if (bridge) result.answer = bridge.text;
    if (bridge?.offTopic) {
      // Off-topic ("what's the capital of France?"): a kind redirect, not a
      // knowledge gap — no handoff, no ticket, no team alert (offTopic).
      result.offTopic = true;
      await profile.onResult?.(result, query, ctx);
      return result;
    }
    result.handoff = true;
    if (profile.ticketing) result.awaitingContact = true; // an email left next attaches to this ticket
    await profile.onResult?.(result, query, ctx);
    if (profile.ticketing) await fileSupportTicket({ profile, query, confidence, ctx });
    return result;
  }

  // 3. LLM call, guarded by the domain's own persona/rules — unless this
  //    tenant's same bot answered the same question recently (answerCache.js).
  //    Only reached after the gate, so a cached answer is re-used exactly
  //    where a fresh one would have been generated; the formatting, ticketing
  //    and onResult steps below run the same either way.
  const cached = cacheable ? answerCache.get(ctx.tenantId, profile.botType, query, knowledgeGeneration, ctx.language) : null;
  try {
    let text;
    if (cached?.value) {
      ({ text } = cached.value);
      if (profile.usageTracking) {
        await logCacheHit({ ctx, botType: profile.botType, model: cached.value.model, usage: cached.value.usage });
      }
    } else {
      const answer = await generateAnswer({
        systemPrompt: buildSystemPrompt(profile, ctx),
        userPrompt: buildUserPrompt(profile, query, ranked, ctx)
      });
      text = answer.text;
      if (profile.usageTracking) {
        await logUsage({ ctx, provider: answer.provider, model: answer.model, usage: answer.usage, botType: profile.botType });
      }
      if (cacheable) {
        await answerCache.set(ctx.tenantId, profile.botType, query,
          { text, model: answer.model, usage: answer.usage }, knowledgeGeneration, ctx.language);
      }
    }

    // The model self-reports which excerpt it actually grounded its answer
    // in (see promptBuilder.citationInstruction) — trust that over rank[0]
    // when it's present and valid, since a near-tie in lexical scoring can
    // rank the wrong section first even though the model correctly drew from
    // a lower-ranked one.
    const { answerText, citedIndex } = parseCitedExcerpt(text.trim(), ranked.length);
    const noAnswer = answerText === profile.noAnswerSentinel;
    const effectiveRanked =
      citedIndex != null ? [ranked[citedIndex], ...ranked.filter((_, i) => i !== citedIndex)] : ranked;
    // The model found no answer in the excerpts. Below the threshold that's a
    // handoff, as at the gate. At or above it, retrieval did find relevant
    // documents (usually a wording mismatch rather than a real knowledge gap),
    // so the bot asks for a rephrase instead of promising a person and filing
    // a ticket. That reply still carries the confidence, which tenantChat.js
    // stores on the ChatMessage for review.
    // Instead of a fixed message, a contextual one when it passes the checks
    // (engine/bridgeReply.js); an off-topic message is redirected, never a handoff.
    const bridge = noAnswer ? await composeBridgeReply({ profile, query, ctx }) : null;
    const handoff = noAnswer && lowConfidence && !bridge?.offTopic;
    let result;
    if (!noAnswer) {
      result = profile.formatSuccess(normalizeChatText(answerText), effectiveRanked, ctx);
      result.answered = true; // a real knowledge-base answer, not a handoff or fallback
    }
    else if (handoff || !profile.formatNoAnswer) result = profile.formatFallback(ctx, confidence);
    else result = profile.formatNoAnswer(ctx, confidence);
    if (bridge) result.answer = bridge.text;
    if (bridge?.offTopic) result.offTopic = true;
    if (handoff) {
      result.handoff = true;
      if (profile.ticketing) result.awaitingContact = true;
    }
    if (cached?.value) result.cached = true; // served without an LLM call
    await profile.onResult?.(result, query, ctx);

    if (handoff && profile.ticketing) {
      await fileSupportTicket({ profile, query, confidence, ctx });
    }
    return result;
  } catch (err) {
    // Graceful degradation when every LLM provider failed (missing key,
    // retired model, rate limit, outage): the profile's formatDegraded()
    // returns a polite "try again" reply rather than an error or a raw
    // excerpt, and the question is filed as a ticket so it isn't lost.
    if (
      err instanceof ChatConfigError ||
      err instanceof ChatRateLimitError ||
      err instanceof ChatUpstreamError
    ) {
      // Previously silent — a missing/invalid key looked identical to a
      // working bot with a bad knowledge base. One line per degraded answer,
      // naming every provider tried (never key values).
      console.error(
        `[chatEngine] ${profile.id}: LLM unavailable, served degraded answer — ` +
        (err.attempts?.length ? formatAttempts(err.attempts) : `${err.name}: ${err.message}`)
      );
      const result = profile.formatDegraded(ranked, ctx);
      // An outage, not a confidence call: the question is filed whatever the
      // confidence, since nothing else would capture it.
      if (profile.ticketing) result.handoff = true;
      await profile.onResult?.(result, query, ctx);
      if (profile.ticketing) await fileSupportTicket({ profile, query, confidence, ctx, kind: 'outage' });
      return result;
    }
    throw err;
  }
}

module.exports = { getEngineAnswer };
