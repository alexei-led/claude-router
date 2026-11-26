// The store calls a turn makes: Claude Code runs one plugin's store calls one at a time, each reading the whole store
// file, so a call a request does not need delays it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { answering, drain, harness, JEV_KEY, step } from './harness.mjs';
import { assistant, jevResponse, user } from './helpers.mjs';

const LOW = { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 };

class Recorded extends Map {
  calls = [];
  get(key) {
    this.calls.push(`get ${key}`);
    return super.get(key);
  }
  set(key, value) {
    this.calls.push(`set ${key}`);
    return super.set(key, value);
  }
}

test('a later turn writes no mode it already saved, and its requests read the account hold once', async () => {
  const preferences = new Recorded();
  const h = harness(JEV_KEY, preferences);
  answering(h, jevResponse('low', LOW));
  await h.event('session.start', { cwd: '/fixture' });
  for (const turnId of ['t1', 't2']) {
    preferences.calls.length = 0;
    await h.event('turn.start', { turnId, text: 'Next.' });
    h.messages(async () => [user('Next.'), assistant('working', ['Read'])]);
    for (const index of [0, 1, 2]) await drain(h.step({ ...step, turnId, index, model: 'claude-haiku-5-5' }));
    await h.event('turn.complete', { turnId });
  }
  assert.deepEqual(
    [
      preferences.calls.filter((call) => call === 'set mode:s1').length,
      preferences.calls.filter((call) => call === 'get holds/plan').length,
    ],
    [0, 1],
  );
});
