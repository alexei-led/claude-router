import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { buildRequest, parseAnswers } from '../lib/jev-contract.mjs';

const config = loadConfig({ env: { TYPESAFE_API_KEY: 'k' } });

test('request carries every tier with its route, an uncertain option and a continuation question', () => {
  const body = buildRequest(config, 'do x', [{ role: 'user', text: 'hi' }]);
  assert.deepEqual(Object.keys(body.questions.route.criteria), ['micro', 'low', 'medium', 'high', 'uncertain']);
  assert.deepEqual(body.questions.route.criteria.high.route, { model: 'opus', effort: 'xhigh' });
  assert.equal(body.questions.continuation.type, 'noul');
  assert.equal(body.state.currentRequest.text, 'do x');
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
