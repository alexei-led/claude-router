import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../lib/config.mjs';
import { parseAnswers, RETRY_DELAY_MS } from '../lib/jev-contract.mjs';
import { NativeJev } from '../lib/native-jev.mjs';

const answer = {
  answers: {
    route: {
      type: 'choice',
      choice: 'medium',
      confidence: 0.9,
      probabilities: { micro: 0, low: 0, medium: 0.9, high: 0.1, uncertain: 0 },
    },
  },
};
const ok = () => ({ ok: true, status: 200, text: JSON.stringify(answer), headers: {} });
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

function clock() {
  let now = 0;
  const timers = new Set();
  const sleep = (ms, { signal } = {}) =>
    new Promise((resolve, reject) => {
      const timer = {
        at: now + ms,
        resolve: () => {
          timers.delete(timer);
          resolve();
        },
      };
      const abort = () => {
        timers.delete(timer);
        reject(new Error('aborted'));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      timers.add(timer);
    });
  return {
    now: () => now,
    sleep,
    advance: async (ms) => {
      now += ms;
      for (const timer of [...timers]) if (timer.at <= now) timer.resolve();
      await flush();
    },
  };
}

function input(timing, request) {
  return {
    request,
    sleep: timing.sleep,
    config: DEFAULTS,
    apiKey: 'synthetic-test-key',
    prompt: 'One small edit.',
    turns: [],
  };
}

test('native Jev sends the shared contract and reads text and plain headers', async () => {
  const timing = clock();
  const jev = new NativeJev({ now: timing.now });
  const result = await jev.ask(
    input(timing, async (url, init) => {
      assert.equal(url, DEFAULTS.jev.endpoint);
      assert.equal(init.headers.authorization, 'Bearer synthetic-test-key');
      assert.equal(JSON.parse(init.body).state.currentRequest.text, 'One small edit.');
      assert.equal(Object.hasOwn(init, 'signal'), false);
      return ok();
    }),
  );
  assert.equal(result.error, null);
  assert.equal(result.advice.choice, 'medium');
});

test('a timed-out request occupies the slot until settlement, and its late success changes no health', async () => {
  const timing = clock();
  const jev = new NativeJev({ now: timing.now });
  let finish;
  let requests = 0;
  const request = () => {
    requests += 1;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const pending = jev.ask(input(timing, request));
  await flush();
  await timing.advance(1500);
  assert.equal((await pending).error, 'timeout');
  for (let i = 0; i < 20; i += 1) assert.equal((await jev.ask(input(timing, request))).error, 'busy');
  assert.equal(requests, 1);
  assert.equal(jev.snapshot().failures, 1);
  finish(ok());
  await flush();
  assert.equal(jev.snapshot().failures, 1);
  assert.equal((await jev.ask(input(timing, async () => ok()))).error, null);
  assert.equal(jev.snapshot().failures, 0);
});

test('native retry uses Retry-After inside the same total deadline', async () => {
  const timing = clock();
  const jev = new NativeJev({ now: timing.now });
  let requests = 0;
  const pending = jev.ask(
    input(timing, async () =>
      ++requests === 1 ? { ok: false, status: 503, text: '', headers: { 'retry-after': '0.2' } } : ok(),
    ),
  );
  await flush();
  await timing.advance(199);
  assert.equal(requests, 1);
  await timing.advance(1);
  assert.equal((await pending).error, null);
  assert.equal(requests, 2);
});

test('the admission slot stays occupied during retry backoff', async () => {
  const timing = clock();
  const jev = new NativeJev({ now: timing.now });
  let requests = 0;
  const args = input(timing, async () => (++requests === 1 ? { ok: false, status: 503, headers: {} } : ok()));
  const pending = jev.ask(args);
  await flush();
  assert.equal((await jev.ask(args)).error, 'busy');
  assert.equal(requests, 1);
  await timing.advance(100);
  assert.equal((await pending).error, null);
  assert.equal(requests, 2);
});

test('retry beyond the remaining budget is not sent', async () => {
  const timing = clock();
  const jev = new NativeJev({ now: timing.now });
  let requests = 0;
  const result = await jev.ask(
    input(timing, async () => {
      requests += 1;
      return { ok: false, status: 503, headers: { 'retry-after': '10' } };
    }),
  );
  assert.equal(result.error, 'timeout');
  assert.equal(requests, 1);
});

test('abort does not count as an outage or allow an overlapping request', async () => {
  const timing = clock();
  const jev = new NativeJev({ now: timing.now });
  let finish;
  const args = input(
    timing,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = jev.ask({ ...args, signal: controller.signal });
  await flush();
  controller.abort();
  assert.equal((await pending).error, 'cancelled');
  assert.equal(jev.snapshot().failures, 0);
  assert.equal((await jev.ask(args)).error, 'busy');
  finish(ok());
  await flush();
});

test('three failed attempts pause Jev, then one success resumes it', async () => {
  const timing = clock();
  const jev = new NativeJev({ now: timing.now });
  let requests = 0;
  const failed = input(timing, async () => {
    requests += 1;
    return { ok: false, status: 401 };
  });
  for (let i = 0; i < 3; i += 1) assert.equal((await jev.ask(failed)).error, 'auth');
  assert.equal((await jev.ask(failed)).error, 'paused');
  assert.equal(requests, 3);
  await timing.advance(60_000);
  assert.equal((await jev.ask(input(timing, async () => ok()))).error, null);
  assert.deepEqual(jev.snapshot(), { failures: 0, pausedUntil: 0 });
});

test('missing credentials and policy refusal do not retry or count as provider outages', async () => {
  const timing = clock();
  const jev = new NativeJev({ now: timing.now });
  let calls = 0;
  const args = input(timing, async () => {
    calls += 1;
    throw new Error('Network access from plugins denied');
  });
  assert.equal((await jev.ask({ ...args, apiKey: null })).error, 'missing-key');
  assert.equal((await jev.ask(args)).error, 'policy');
  assert.equal(calls, 1);
  assert.equal(jev.snapshot().failures, 0);
});

test('a refused connection is a transport failure: it retries and counts toward the breaker', async () => {
  const timing = clock();
  const jev = new NativeJev({ now: timing.now });
  let calls = 0;
  const pending = jev.ask(
    input(timing, async () => {
      calls += 1;
      throw new Error('connect ECONNREFUSED 127.0.0.1:443');
    }),
  );
  await flush();
  await timing.advance(RETRY_DELAY_MS);
  assert.equal((await pending).error, 'unreachable');
  assert.equal(calls, 2);
  assert.equal(jev.snapshot().failures, 1);
});

test('malformed responses reveal no provider text and invalid probability shapes fail at the contract boundary', async () => {
  const timing = clock();
  const jev = new NativeJev({ now: timing.now });
  for (const text of [
    'PRIVATE_PROMPT',
    JSON.stringify({ answers: { route: { type: 'choice', choice: 'PRIVATE_PROMPT', probabilities: {} } } }),
  ]) {
    const result = await jev.ask(input(timing, async () => ({ ...ok(), text })));
    assert.deepEqual(result, { advice: null, error: 'malformed' });
  }
  for (const probabilities of [null, []])
    assert.throws(
      () => parseAnswers({ answers: { route: { type: 'choice', choice: 'medium', probabilities } } }),
      /malformed/,
    );
});
