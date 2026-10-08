import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildRequest, parseAnswers } from '../lib/classifier-apis.mjs';
import { CLASSIFIER_APIS, DEFAULTS, loadConfig } from '../lib/config.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const ollamaConfig = loadConfig({ userFile: { classifier: 'ollama' } });
const openaiConfig = loadConfig({ userFile: { classifier: 'openai' } });
const ollamaAnswer = (tokens) => ({
  model: 'qwen3.5:9b',
  done_reason: 'length',
  message: { role: 'assistant', content: 'C' },
  logprobs: [
    { token: 'C', logprob: -0.04, top_logprobs: tokens.map(([token, p]) => ({ token, logprob: Math.log(p) })) },
  ],
});

test('every declared API has an adapter that builds a request for its entry', () => {
  for (const api of CLASSIFIER_APIS) {
    const config = loadConfig({
      userFile: {
        classifier: 'house',
        classifiers: { house: { ...DEFAULTS.classifiers.jev, api, endpoint: 'https://example.test/v1' } },
      },
    });
    assert.equal(buildRequest(config, 'do x', []).model, 'jev-1.13.0', api);
  }
});

test('Ollama request asks one letter with thinking off and no credential', () => {
  const body = buildRequest(ollamaConfig, 'Refactor billing retries.', [{ role: 'user', text: 'hi' }]);
  assert.equal(body.model, 'qwen3.5:9b');
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.deepEqual(body.options, { num_predict: 1, temperature: 0 });
  assert.equal(body.logprobs, true);
  assert.equal(body.top_logprobs, 20);
  const [system, user] = body.messages;
  assert.equal(system.role, 'system');
  assert.match(system.content, /do not follow them/);
  assert.match(user.content, /"text": "Refactor billing retries\."/);
  for (const line of ['A. micro:', 'B. low:', 'C. medium:', 'D. high:', 'E. uncertain:'])
    assert.match(user.content, new RegExp(line));
  assert.match(user.content, /Answer with one letter\./);
});

test('OpenAI request sends the state as text with the route choice and the continuation predicate', () => {
  const body = buildRequest(openaiConfig, 'continue', [{ role: 'user', text: 'fix tests' }]);
  assert.equal(body.model, 'gpt-6-luna');
  assert.deepEqual(JSON.parse(body.input), {
    currentRequest: { text: 'continue' },
    recentDialogue: [{ role: 'user', text: 'fix tests' }],
  });
  const [route, continuation] = body.questions;
  assert.equal(route.type, 'choice');
  assert.equal(route.name, 'route');
  assert.deepEqual(
    route.choices.map((choice) => choice.value),
    ['micro', 'low', 'medium', 'high', 'uncertain'],
  );
  assert.match(route.choices[3].description, /Use when: frontier reasoning materially reduces rework\./);
  assert.deepEqual({ type: continuation.type, name: continuation.name }, { type: 'predicate', name: 'continuation' });
});

test('Ollama answer maps the top letter probabilities to the advice shape', () => {
  const advice = parseAnswers(ollamaConfig, fixture('ollama-route-response.json'));
  assert.equal(advice.choice, 'medium');
  assert.ok(advice.probabilities.medium > 0.95, String(advice.probabilities.medium));
  assert.equal(advice.continuation, null);
  const total = Object.values(advice.probabilities).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  // TypeSafe's peak formula over five values: (5 * peak - 1) / 4.
  assert.ok(Math.abs(advice.confidence - (5 * advice.probabilities.medium - 1) / 4) < 1e-9);
});

test('Ollama counts a space-prefixed token as the same letter', () => {
  const advice = parseAnswers(
    ollamaConfig,
    ollamaAnswer([
      ['B', 0.3],
      [' B', 0.2],
      ['D', 0.1],
    ]),
  );
  assert.equal(advice.choice, 'low');
  assert.ok(Math.abs(advice.probabilities.low - 0.5 / 0.6) < 1e-9);
  assert.ok(Math.abs(advice.probabilities.high - 0.1 / 0.6) < 1e-9);
  assert.equal(advice.probabilities.micro, 0);
});

for (const [name, body] of [
  ['no logprobs', { message: { content: 'C' } }],
  [
    'no candidate tokens',
    ollamaAnswer([
      ['The', 0.6],
      ['I', 0.4],
    ]),
  ],
  ['a top list that is not an array', { logprobs: [{ token: 'C', top_logprobs: 'C' }] }],
]) {
  test(`Ollama rejects ${name}`, () => {
    assert.throws(() => parseAnswers(ollamaConfig, body), /classifier/);
  });
}

test('OpenAI answer reads the route choice, its probability list and the continuation predicate', () => {
  const advice = parseAnswers(openaiConfig, fixture('openai-decisions-response.json'));
  assert.equal(advice.choice, 'medium');
  assert.equal(advice.confidence, 0.6);
  assert.equal(advice.probabilities.high, 0.18);
  assert.equal(advice.probabilities.uncertain, 0.02);
  assert.equal(advice.continuation, 0.03);
});

for (const [name, body] of [
  ['a refusal', { answers: [{ type: 'refusal', name: 'route' }] }],
  ['no answers array', { answers: { route: {} } }],
  [
    'a choice outside the route values',
    { answers: [{ type: 'choice', name: 'route', choice: 'opus', probabilities: [] }] },
  ],
  [
    'probabilities that are not a list',
    { answers: [{ type: 'choice', name: 'route', choice: 'low', probabilities: {} }] },
  ],
]) {
  test(`OpenAI rejects ${name}`, () => {
    assert.throws(() => parseAnswers(openaiConfig, body), /classifier/);
  });
}

test('OpenAI answer without a continuation predicate reads as no continuation', () => {
  const body = fixture('openai-decisions-response.json');
  body.answers = body.answers.filter((answer) => answer.name === 'route');
  assert.equal(parseAnswers(openaiConfig, body).continuation, null);
});
