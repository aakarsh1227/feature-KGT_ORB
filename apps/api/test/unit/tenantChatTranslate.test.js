const { test, describe, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const { runTranslate, ChatRequestError, MAX_TRANSLATE_LEN } = require('../../src/services/tenantChat');
const llmClient = require('../../src/engine/llmClient');

// runTranslate is deliberately stateless — no prisma, no session — so it can
// be exercised with only the LLM call mocked. A unique tenant id per test
// keeps each one in its own (empty) rate-limit bucket.
const tenant = (suffix) => ({ id: `translate-test-${suffix}-${Math.random()}` });

describe('tenantChat: runTranslate', () => {
  afterEach(() => mock.restoreAll());

  test('translates text into the requested language and echoes the target', async () => {
    mock.method(llmClient, 'generateAnswer', async ({ systemPrompt, userPrompt }) => {
      assert.match(systemPrompt, /into Hindi/);
      assert.equal(userPrompt, 'The Pro plan is $20 per month.');
      return { text: '  प्रो प्लान $20 प्रति माह है।  ', provider: 'test', model: 'm', usage: {} };
    });

    const result = await runTranslate({
      tenant: tenant('ok'),
      body: { text: 'The Pro plan is $20 per month.', target: 'hi' }
    });
    assert.deepEqual(result, { text: 'प्रो प्लान $20 प्रति माह है।', target: 'hi' });
  });

  test('rejects empty text with 400', async () => {
    await assert.rejects(
      () => runTranslate({ tenant: tenant('empty'), body: { text: '   ', target: 'hi' } }),
      (err) => err instanceof ChatRequestError && err.statusCode === 400
    );
  });

  test('rejects text over the length cap with 400', async () => {
    await assert.rejects(
      () => runTranslate({ tenant: tenant('long'), body: { text: 'x'.repeat(MAX_TRANSLATE_LEN + 1), target: 'en' } }),
      (err) => err instanceof ChatRequestError && err.statusCode === 400
    );
  });

  test('rejects an unsupported target language with 400', async () => {
    await assert.rejects(
      () => runTranslate({ tenant: tenant('badlang'), body: { text: 'hello', target: 'fr' } }),
      (err) => err instanceof ChatRequestError && /en, hi/.test(err.message)
    );
  });

  test('a down LLM surfaces as a polite 503, not a raw upstream error', async () => {
    mock.method(llmClient, 'generateAnswer', async () => { throw new Error('all providers failed'); });
    await assert.rejects(
      () => runTranslate({ tenant: tenant('down'), body: { text: 'hello', target: 'hi' } }),
      (err) => err instanceof ChatRequestError && err.statusCode === 503 && /unavailable/i.test(err.message)
    );
  });
});
