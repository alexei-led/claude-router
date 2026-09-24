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
    if (next instanceof Error) throw next;
    return {
      ok: next.status === 200,
      status: next.status,
      headers: new Headers(next.headers ?? {}),
      json: async () => next.body,
    };
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

test('retries once after a network error', async () => {
  const noWait = async () => {};
  const flaky = fakeFetch([new TypeError('fetch failed'), { status: 200, body: GOOD }]);
  const advice = await askJev({ fetchFn: flaky.fn, config, apiKey: 'k', prompt: 'p', turns: [], sleep: noWait });
  assert.equal(advice.choice, 'high');
  assert.equal(flaky.calls.length, 2);
  const down = fakeFetch([new TypeError('fetch failed'), new TypeError('fetch failed')]);
  await assert.rejects(
    askJev({ fetchFn: down.fn, config, apiKey: 'k', prompt: 'p', turns: [], sleep: noWait }),
    /jev unreachable: fetch failed/,
  );
});

test('waits for Retry-After when it fits the budget and gives up at once when it does not', async () => {
  let t = 0;
  const now = () => t;
  const sleep = async (ms) => {
    t += ms;
  };
  const soon = fakeFetch([
    { status: 429, headers: { 'retry-after': '0.5' } },
    { status: 200, body: GOOD },
  ]);
  assert.equal(
    (await askJev({ fetchFn: soon.fn, config, apiKey: 'k', prompt: 'p', turns: [], now, sleep })).choice,
    'high',
  );
  assert.equal(t, 500);
  const late = fakeFetch([{ status: 429, headers: { 'retry-after': '30' } }]);
  await assert.rejects(
    askJev({ fetchFn: late.fn, config, apiKey: 'k', prompt: 'p', turns: [], now, sleep }),
    /retry-after beyond the budget/,
  );
  assert.equal(late.calls.length, 1);
});

// Retry-After is delay-seconds or an HTTP-date. A date is relative to the injected clock; a past date retries at once.
test('Retry-After as an HTTP-date waits until that time when it fits the budget', async () => {
  const T = Date.parse('2026-09-24T10:00:00Z');
  const cases = [
    ['Thu, 24 Sep 2026 10:00:01 GMT', 1000, 'high'],
    ['Thu, 24 Sep 2026 09:59:00 GMT', 0, 'high'],
    ['Thu, 24 Sep 2026 10:00:30 GMT', 0, /retry-after beyond the budget/],
    ['1', 1000, 'high'], // delay-seconds first: Date.parse('1') would read it as the year 2001
    ['soon', 100, 'high'], // unreadable: the default retry delay
  ];
  for (const [header, waited, outcome] of cases) {
    let t = T;
    const now = () => t;
    const sleep = async (ms) => {
      t += ms;
    };
    const fake = fakeFetch([
      { status: 503, headers: { 'retry-after': header } },
      { status: 200, body: GOOD },
    ]);
    const call = askJev({ fetchFn: fake.fn, config, apiKey: 'k', prompt: 'p', turns: [], now, sleep });
    if (outcome instanceof RegExp) await assert.rejects(call, outcome, header);
    else assert.equal((await call).choice, outcome, header);
    assert.equal(t - T, waited, header);
  }
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
