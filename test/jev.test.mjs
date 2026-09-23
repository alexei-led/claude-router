import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { askJev, buildRequest, parseAnswers } from '../lib/jev.mjs';

const config = loadConfig({ env: { TYPESAFE_API_KEY: 'k' } });

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    return { ok: next.status === 200, status: next.status, json: async () => next.body };
  };
  return { fn, calls };
}

const GOOD = {
  answers: {
    route: {
      type: 'choice',
      choice: 'high',
      confidence: 0.8,
      probabilities: { high: 0.7, medium: 0.2, low: 0.05, micro: 0.02, uncertain: 0.03 },
    },
    continuation: { type: 'noul', noul: 0.1 },
  },
};

test('request carries every tier with its route, an uncertain option and a continuation question', () => {
  const body = buildRequest(config, 'do x', [{ role: 'user', text: 'hi' }]);
  assert.deepEqual(Object.keys(body.questions.route.criteria), ['micro', 'low', 'medium', 'high', 'uncertain']);
  assert.deepEqual(body.questions.route.criteria.high.route, { model: 'opus', effort: 'xhigh' });
  assert.equal(body.questions.continuation.type, 'noul');
  assert.equal(body.state.currentRequest.text, 'do x');
});

test('sends the bearer key and parses the answer', async () => {
  const { fn, calls } = fakeFetch([{ status: 200, body: GOOD }]);
  const advice = await askJev({ fetchFn: fn, config, apiKey: 'k', prompt: 'p', turns: [] });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.equal(advice.choice, 'high');
  assert.equal(advice.continuation, 0.1);
  assert.equal(advice.probabilities.high, 0.7);
});

test('retries once on a transient status, not on a client error', async () => {
  const transient = fakeFetch([
    { status: 429, body: {} },
    { status: 200, body: GOOD },
  ]);
  assert.equal((await askJev({ fetchFn: transient.fn, config, apiKey: 'k', prompt: 'p', turns: [] })).choice, 'high');
  assert.equal(transient.calls.length, 2);
  const client = fakeFetch([{ status: 401, body: {} }]);
  await assert.rejects(askJev({ fetchFn: client.fn, config, apiKey: 'k', prompt: 'p', turns: [] }), /401/);
  assert.equal(client.calls.length, 1);
});

test('gives up when the budget is spent', async () => {
  let t = 0;
  const now = () => (t += 2_000);
  const { fn } = fakeFetch([
    { status: 503, body: {} },
    { status: 200, body: GOOD },
  ]);
  await assert.rejects(askJev({ fetchFn: fn, config, apiKey: 'k', prompt: 'p', turns: [], now }), /timeout/);
});

for (const [name, body] of [
  ['missing route', { answers: {} }],
  ['wrong type', { answers: { route: { type: 'score', probabilities: {} } } }],
  ['unknown choice', { answers: { route: { type: 'choice', choice: 'opus', probabilities: {} } } }],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parseAnswers(body), /jev/);
  });
}

test('missing probabilities and continuation degrade to zero and null', () => {
  const advice = parseAnswers({
    answers: { route: { type: 'choice', choice: 'low', confidence: 2, probabilities: { low: 1 } } },
  });
  assert.equal(advice.probabilities.high, 0);
  assert.equal(advice.confidence, 1);
  assert.equal(advice.continuation, null);
});
