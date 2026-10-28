const { test, describe, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const { translateQueryForRetrieval } = require('../../src/engine/queryTranslation');
const llmClient = require('../../src/engine/llmClient');
const { store } = require('../../src/lib/sharedStore');

describe('queryTranslation: translateQueryForRetrieval', () => {
  afterEach(async () => { mock.restoreAll(); await store().reset(); });

  test('an English (or romanized) query is returned unchanged, with no LLM call', async () => {
    const spy = mock.method(llmClient, 'generateAnswer', async () => { throw new Error('should not be called'); });
    assert.equal(await translateQueryForRetrieval('how much does the Pro plan cost?'), 'how much does the Pro plan cost?');
    assert.equal(await translateQueryForRetrieval('kitna hai'), 'kitna hai');
    assert.equal(spy.mock.callCount(), 0);
  });

  test('a Devanagari query is translated to English for retrieval', async () => {
    mock.method(llmClient, 'generateAnswer', async ({ userPrompt }) => {
      assert.equal(userPrompt, 'प्रो प्लान की कीमत क्या है?');
      return { text: 'What does the Pro plan cost?' };
    });
    assert.equal(await translateQueryForRetrieval('प्रो प्लान की कीमत क्या है?'), 'What does the Pro plan cost?');
  });

  test('the translation is cached, so a repeat does not call the LLM again', async () => {
    const spy = mock.method(llmClient, 'generateAnswer', async () => ({ text: 'reset my router' }));
    const q = 'मेरा राउटर रीसेट कैसे करूँ?';
    assert.equal(await translateQueryForRetrieval(q), 'reset my router');
    assert.equal(await translateQueryForRetrieval(q), 'reset my router');
    assert.equal(spy.mock.callCount(), 1);
  });

  test('a failed translation degrades to the original query (never throws)', async () => {
    mock.method(llmClient, 'generateAnswer', async () => { throw new Error('LLM down'); });
    const q = 'मदद चाहिए';
    assert.equal(await translateQueryForRetrieval(q), q);
  });
});
