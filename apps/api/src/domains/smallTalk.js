const { registerAction } = require('../engine/actionRegistry');

// Greetings, "how are you", thanks and goodbyes, answered warmly before
// retrieval. Without this, "Hi" searched the knowledge base, matched
// nothing, and got a "let me connect you with our team" handoff and a ticket.
// No LLM call and no ticket. Wording comes from profile.smallTalkCopy, so
// each bot keeps its own voice.
//
// Only a message that is entirely small talk matches: "Hi, how do I pay my
// bill?" is a question and goes to the knowledge base as usual.

const MAX_LEN = 80;
const END = String.raw`[\s!.,?]*$`;
const HELLO = String.raw`(?:hi+|hello+|hey+|hiya|howdy|greetings|namaste|good (?:morning|afternoon|evening|day))(?:\s+(?:there|team|all|everyone|folks))?`;
const HOW_ARE_YOU = String.raw`(?:how are (?:you|u|things)(?: doing)?(?: today)?|how(?:'s| is) it going|how do you do|what'?s up|sup)`;

const ASKS_AFTER_US = new RegExp(String.raw`\b${HOW_ARE_YOU}\b`, 'i');

const PATTERNS = {
  greeting: new RegExp(String.raw`^\s*${HELLO}[\s!.,]*(?:${HOW_ARE_YOU})?${END}`, 'i'),
  howAreYou: new RegExp(String.raw`^\s*${HOW_ARE_YOU}${END}`, 'i'),
  thanks: new RegExp(String.raw`^\s*(?:(?:ok(?:ay)?|great|perfect|awesome|cool)[\s,!.]+)?(?:thanks|thank you|thx|ty|cheers|much appreciated)(?: (?:so|very) much| a lot| a ton)?(?: for (?:your|the|all the) help)?${END}`, 'i'),
  goodbye: new RegExp(String.raw`^\s*(?:bye|goodbye|good bye|see (?:you|ya)|take care|that'?s all|that is all|nothing else|i'?m done)${END}`, 'i'),
  acknowledge: new RegExp(String.raw`^\s*(?:ok(?:ay)?|k|great|perfect|awesome|cool|got it|alright|all right|nice|sounds good)${END}`, 'i')
};

/** @returns {'greeting'|'howAreYou'|'thanks'|'goodbye'|'acknowledge'|null} */
function smallTalkKind(query) {
  const text = String(query || '');
  if (!text.trim() || text.length > MAX_LEN) return null;
  const hit = Object.entries(PATTERNS).find(([, re]) => re.test(text));
  if (!hit) return null;
  // "Hi, how are you?" is a greeting that asks after us: answer both at once.
  return hit[0] === 'greeting' && ASKS_AFTER_US.test(text) ? 'howAreYou' : hit[0];
}

registerAction('smalltalk', {
  match: (query) => !!smallTalkKind(query),
  run: async (query, ctx, profile) => {
    const kind = smallTalkKind(query);
    // A first "Hi" gets the full welcome; later ones a lighter touch.
    const firstTurn = !(ctx.recentTurns || []).some((t) => t.role === 'assistant');
    const copy = profile.smallTalkCopy(ctx.language); // in the UI-selected language
    const answer = kind === 'greeting' && !firstTurn ? copy.greetingAgain : copy[kind];
    return answer ? { answer, smallTalk: true } : null;
  }
});

module.exports = { smallTalkKind };
