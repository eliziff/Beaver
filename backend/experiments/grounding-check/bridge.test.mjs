import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, segments } from './bridge.mjs';

test('segmentation covers original Unicode, abbreviations, blank lines and tables', () => {
  for (const text of ['  A.\n\nB!  \n', 'R. v. Smith, at para 5. Next point.',
    'The firm 🦫 must pay. But not yet.', '| A | B. |\n| C | D |']) {
    const result = segments(text);
    assert.equal(result.map(p => p.text).join(''), text);
    assert.equal(result[0].start, 0);
    assert.equal(result.at(-1).end, text.length);
    assert.ok(result.every(p => p.text.trim() && text.slice(p.start, p.end) === p.text));
  }
});

test('checker uses existing bounded provider API; retains malformed output and usage', async () => {
  let options;
  const load = async () => ({ streamChatWithTools: async input => {
    options = input; return { fullText: 'bad json', usage: { inputTokens: 23, outputTokens: 2 } };
  } });
  const request = { op: 'check', model: 'ollama:local', allow_live: true, packet: { claims: [] }, timeout_ms: 1000 };
  const result = await dispatch(request, load);
  assert.equal(options.maxIterations, 1);
  assert.equal(options.maxProviderAttempts, 1);
  assert.deepEqual(options.tools, []);
  assert.equal(result.verdicts, null);
  assert.equal(result.raw, 'bad json');
  assert.equal(result.usage.inputTokens, 23);
  await assert.rejects(() => dispatch({ ...request, allow_live: false }, load));
  await assert.rejects(() => dispatch({ ...request, model: 'paid:model' }, load));
});
