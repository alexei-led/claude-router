// The replay trace hook keeps a session within its caps: whole turns only, sequenced, never a half-turn.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TRACE_PREFIX, traceBytes, usableTrace } from '../lib/replay-trace.mjs';
import { drain, shadowHarness, step } from './harness.mjs';
import { user } from './helpers.mjs';

const record = (h, id = 's1') => h.preferences.get(TRACE_PREFIX + id);

const setup = shadowHarness;

async function begin(h) {
  await h.event('session.start', { cwd: '/fixture' });
}

async function turn(h, id = 't1', messages = [user('Synthetic task.')]) {
  await h.event('turn.start', { turnId: id, text: 'Synthetic task.' });
  h.messages(async () => messages);
  await drain(h.step({ ...step, turnId: id, messageCount: messages.length }));
  await h.event('turn.complete', { turnId: id });
}

test('over 60 actual decisions remain sequenced; per-session cap preserves only whole-turn usable prefixes', async () => {
  const h = setup();
  await begin(h);
  for (let i = 0; i < 65; i++) await turn(h, `t${i}`);
  const trace = record(h);
  assert.ok(traceBytes(trace) < 128 * 1024);
  const requests = trace.events.filter((e) => e.type === 'request');
  assert.ok(requests.length > 60, `retained ${requests.length} decisions`);
  assert.equal(usableTrace(trace), true);
  for (let i = 65; i < 130; i++) await turn(h, `t${i}`);
  assert.ok(record(h).capped.turns > 0);
  assert.equal(record(h).capped.events % 3, 0);
  assert.equal(usableTrace(record(h)), true);
  assert.equal(record(h).events.at(-1).type, 'end');
});

test('a long single tool turn discards its entire batch and retains capped coverage, not a half-turn', async () => {
  const h = setup();
  await begin(h);
  await turn(h, 'first');
  const before = structuredClone(record(h).events);
  await h.event('turn.start', { turnId: 'long', text: 'Synthetic task.' });
  for (let i = 0; i < 400; i++) await drain(h.step({ ...step, turnId: 'long', index: i, messageCount: 2 }));
  await h.event('turn.complete', { turnId: 'long' });
  assert.deepEqual(record(h).events, before);
  assert.equal(record(h).capped.turns, 1);
  assert.ok(record(h).capped.events >= 801);
  assert.equal(usableTrace(record(h)), true);
  assert.equal(JSON.stringify(record(h)).includes('Synthetic task'), false);
});
