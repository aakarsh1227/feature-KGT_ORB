const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectLanguage,
  normalizeLanguage,
  resolveLanguage,
  languageDirective
} = require('../../src/engine/language');
const { buildUserPrompt } = require('../../src/engine/promptBuilder');

describe('language: detectLanguage', () => {
  test('Devanagari text is Hindi', () => {
    assert.equal(detectLanguage('मुझे कीमत बताइए'), 'hi');
    assert.equal(detectLanguage('What is the price? कीमत?'), 'hi'); // any Devanagari wins
  });

  test('romanized Hindi (Hinglish) is Hindi', () => {
    assert.equal(detectLanguage('aapka plan kitna hai'), 'hi');
    assert.equal(detectLanguage('namaste, mujhe madad chahiye'), 'hi');
  });

  test('plain English is English', () => {
    assert.equal(detectLanguage('How much does the pro plan cost?'), 'en');
    assert.equal(detectLanguage('Can I get a refund?'), 'en');
  });

  test('text with no letters is ambiguous (null)', () => {
    assert.equal(detectLanguage(''), null);
    assert.equal(detectLanguage('12345'), null);
    assert.equal(detectLanguage('?!…'), null);
  });
});

describe('language: normalizeLanguage', () => {
  test('accepts en/hi case-insensitively, rejects the rest', () => {
    assert.equal(normalizeLanguage('en'), 'en');
    assert.equal(normalizeLanguage('HI'), 'hi');
    assert.equal(normalizeLanguage(' Hi '), 'hi');
    assert.equal(normalizeLanguage('fr'), null);
    assert.equal(normalizeLanguage(undefined), null);
    assert.equal(normalizeLanguage(''), null);
  });
});

describe('language: resolveLanguage — the UI selector is authoritative', () => {
  test('the selected language wins, whatever the message is written in', () => {
    // Hindi toggle -> Hindi reply even for an English question, and vice versa.
    assert.equal(resolveLanguage('hi', 'how does this work?'), 'hi');
    assert.equal(resolveLanguage('en', 'yeh kaise kaam karta hai'), 'en');
    assert.equal(resolveLanguage('en', 'यह कैसे काम करता है'), 'en');
  });

  test('without a selector, it falls back to detecting the message language', () => {
    assert.equal(resolveLanguage(undefined, 'kitna hai'), 'hi');
    assert.equal(resolveLanguage('', 'यह कैसे काम करता है'), 'hi');
    assert.equal(resolveLanguage(null, 'how does this work?'), 'en');
  });

  test('an unrecognised selector value is ignored, falling back to detection', () => {
    assert.equal(resolveLanguage('xx', 'kitna hai'), 'hi');
  });

  test('defaults to English when there is neither a selector nor a detectable message', () => {
    assert.equal(resolveLanguage(null, ''), 'en');
    assert.equal(resolveLanguage('xx', '!!!'), 'en');
  });
});

describe('language: languageDirective', () => {
  test('Hindi directive names Hindi/Devanagari and forbids English', () => {
    const d = languageDirective('hi');
    assert.match(d, /Hindi/);
    assert.match(d, /Devanagari/);
    assert.match(d, /English/); // "Do not ... restate ... in English"
  });

  test('English directive asks for English', () => {
    assert.match(languageDirective('en'), /English/);
  });
});

describe('language: buildUserPrompt injects the reply-language directive', () => {
  const profile = { excerptLabel: 'KNOWLEDGE BASE EXCERPTS', queryLabel: 'USER MESSAGE' };
  const ranked = [{ chunk: { title: 'Pricing', content: 'Pro is $20/mo.' } }];

  test('a Hindi turn carries the Hindi directive', () => {
    const prompt = buildUserPrompt(profile, 'kitna hai', ranked, { language: 'hi' });
    assert.match(prompt, /CRITICAL INSTRUCTION/);
    assert.match(prompt, /Hindi/);
  });

  test('an English turn carries the English directive', () => {
    const prompt = buildUserPrompt(profile, 'how much?', ranked, { language: 'en' });
    assert.match(prompt, /CRITICAL INSTRUCTION/);
    assert.match(prompt, /exclusively in\s+English|exclusively in English/);
  });

  test('no language on ctx leaves the prompt directive-free', () => {
    const prompt = buildUserPrompt(profile, 'how much?', ranked, {});
    assert.doesNotMatch(prompt, /CRITICAL INSTRUCTION/);
  });
});
